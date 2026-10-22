import { writeOrQueue, nowStamp, getPendingOp, initSync } from '../shared/sync.js';
import { bindEvents, cloneEl, refs } from '../shared/dom.js';
import { makeChip, setStatus, syncStatusHandler } from '../shared/ui.js';

// This file is a module, so everything below is already module-scoped.
const sb = window.supabaseClient;
const TABLES = window.TABLES || {};
const todayStr = window.todayStr;

// ---------- constants ----------
// Fallbacks keep it working if NOTES isn't in TABLES yet.
const NOTES_TABLE = TABLES.NOTES || 'household_notes';
const PEOPLE_TABLE = TABLES.PEOPLE || 'household_people';
const CACHE_KEY = 'thecabin_cached_notes';
const KIND_LABELS = { note: 'Note', discussion: 'Discussion', action: 'Action' };

// ---------- state ----------
let notes = [];            // every row: notes, discussion items, action items
let people = [];           // household_people names, alphabetical
let editingId = null;      // id of the row loaded into the form, or null
let filterPerson = '';     // '' = everyone

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const sameId = (a, b) => String(a) === String(b);
const kindOf = n => n.kind || 'note';          // rows from before the kind column count as notes
const isDone = n => n.status === 'done';
const parseDate = str => new Date(str + 'T00:00:00');
const formatDate = str => parseDate(str)
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = str => parseDate(str)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const oldestFirst = (a, b) =>
    a.note_date.localeCompare(b.note_date) ||
    String(a.created_at || '').localeCompare(String(b.created_at || ''));
const newestFirst = (a, b) => oldestFirst(b, a);

// ---------- local cache ----------
function saveToLocalCache(){
    try{
        localStorage.setItem(CACHE_KEY, JSON.stringify({ notes, people, timestamp: Date.now() }));
    } catch(e){}
}

function loadFromLocalCache(){
    try{
        const raw = localStorage.getItem(CACHE_KEY);
        if(!raw) return false;
        const data = JSON.parse(raw);
        notes = data.notes || [];
        people = data.people || [];
        return true;
    } catch(e){
        return false;
    }
}

// Merges server rows with anything still in the offline write queue, so a
// reload can't discard a not-yet-synced add/edit/delete.
function mergeWithPendingWrites(serverRows){
    const serverIds = new Set(serverRows.map(r => r.id));
    const merged = [];

    serverRows.forEach(row => {
        const op = getPendingOp(NOTES_TABLE, row.id);
        if(op && op.type === 'delete') return;
        merged.push(op && op.type === 'update' ? { ...row, ...op.payload } : row);
    });

    // locally-added rows whose insert hasn't synced yet
    notes.forEach(note => {
        const op = getPendingOp(NOTES_TABLE, note.id);
        if(op && op.type === 'insert' && !serverIds.has(note.id)) merged.push(note);
    });

    return merged;
}

// ---------- data loading ----------
async function loadNotes(){
    try{
        const { data, error } = await sb.from(NOTES_TABLE)
            .select('*')
            .order('note_date', { ascending: false });
        if(error) throw error;
        notes = mergeWithPendingWrites(data || []);
        saveToLocalCache();
    } catch(err){
        console.error('Failed to load notes:', err);
        if(!notes.length) setStatus('Could not load notes.');
    }
    render();
}

async function loadPeople(){
    try{
        const { data, error } = await sb.from(PEOPLE_TABLE)
            .select('name')
            .order('name');
        if(error) throw error;
        people = (data || []).map(r => r.name).filter(Boolean);
        saveToLocalCache();
    } catch(err){
        console.error('Failed to load household people:', err);
    }
    renderPeopleOptions();
}

function refreshAll(){
    loadNotes().catch(console.error);
    loadPeople().catch(console.error);
}

// ---------- rendering ----------
// Fills the assignee select (form) and the filter select, keeping current choices.
function renderPeopleOptions(extraName){
    const assignee = $('notes-assignee');
    const filter = $('notes-filter');
    const names = [...people];
    // keep a name that's no longer in household_people so editing an old row doesn't drop it
    if(extraName && !names.includes(extraName)) names.push(extraName);

    const assigneeValue = extraName !== undefined ? (extraName || '') : assignee.value;
    assignee.replaceChildren(new Option('Unassigned', ''), ...names.map(n => new Option(n, n)));
    assignee.value = names.includes(assigneeValue) ? assigneeValue : '';

    const filterValue = filter.value;
    const filterNames = [...new Set([...people, ...notes.map(n => n.assigned_to).filter(Boolean)])].sort();
    filter.replaceChildren(new Option('Everyone', ''), ...filterNames.map(n => new Option(n, n)));
    filter.value = filterNames.includes(filterValue) ? filterValue : '';
    filterPerson = filter.value;
}

// opts.date: show the date chip, opts.kind: show the kind chip
function buildNoteRow(note, opts = {}){
    const row = cloneEl('tpl-note');
    const r = refs(row);
    const kind = kindOf(note);
    const done = kind !== 'note' && isDone(note);

    row.dataset.noteRow = note.id;
    r.text.textContent = note.text;
    r.edit.dataset.editNote = note.id;
    r.del.dataset.delNote = note.id;

    r.check.hidden = kind === 'note';
    r.check.checked = done;
    r.check.dataset.checkNote = note.id;

    if(done){
        r.text.style.textDecoration = 'line-through';
        row.style.opacity = '0.55';
    }

    const chips = [];
    if(opts.kind) chips.push(makeChip(KIND_LABELS[kind], 'default'));
    if(opts.date) chips.push(makeChip(formatDate(note.note_date), 'default'));
    if(note.assigned_to) chips.push(makeChip(note.assigned_to, 'default'));
    if(done && note.resolved_on) chips.push(makeChip(`Done ${shortDate(note.resolved_on)}`, 'default'));
    if(chips.length){
        r.chips.hidden = false;
        r.chips.append(...chips);
    }
    return row;
}

function render(){
    renderPeopleOptions();

    // the person filter narrows assigned items; discussion items belong to both of you, so they always show
    const visible = notes.filter(n =>
        kindOf(n) === 'discussion' || !filterPerson || n.assigned_to === filterPerson);

    // stickies: open action items, oldest first
    const stickies = visible
        .filter(n => kindOf(n) === 'action' && !isDone(n)).sort(oldestFirst);
    $('notes-stickies').replaceChildren(...stickies.map(n => buildNoteRow(n, { date: true })));
    $('notes-stickies-card').hidden = !stickies.length;

    // open discussion items carry over until they're checked off
    const discussion = visible
        .filter(n => kindOf(n) === 'discussion' && !isDone(n)).sort(oldestFirst);
    $('notes-discussion').replaceChildren(...discussion.map(n => buildNoteRow(n, { date: true })));
    $('notes-discussion-empty').hidden = discussion.length > 0;

    // history: everything, done items included, grouped by date, newest first
    const groups = {};
    [...visible].sort(newestFirst)
        .forEach(n => (groups[n.note_date] ||= []).push(n));

    $('notes-list').replaceChildren(...Object.keys(groups).sort().reverse().map(date => {
        const group = cloneEl('tpl-note-group');
        const r = refs(group);
        r.heading.textContent = formatDate(date);
        r.items.append(...groups[date].map(n => buildNoteRow(n, { kind: true })));
        return group;
    }));

    $('notes-empty').hidden = visible.length > 0;
}

// ---------- form ----------
function updateAssigneeVisibility(){
    // discussion items are shared topics, so no assignee
    $('notes-assignee-wrap').hidden = $('notes-kind').value === 'discussion';
}

function resetForm(){
    editingId = null;
    $('notes-text').value = '';
    $('notes-kind').value = 'discussion';
    $('notes-date').value = todayStr();
    $('notes-form-title').textContent = 'Add';
    $('notes-save').textContent = 'Add';
    $('notes-cancel').hidden = true;
    renderPeopleOptions('');
    updateAssigneeVisibility();
}

function startEditing(id){
    const note = notes.find(n => sameId(n.id, id));
    if(!note) return;

    editingId = note.id;
    $('notes-text').value = note.text;
    $('notes-kind').value = kindOf(note);
    $('notes-date').value = note.note_date;
    $('notes-form-title').textContent = 'Edit';
    $('notes-save').textContent = 'Save';
    $('notes-cancel').hidden = false;
    renderPeopleOptions(note.assigned_to || '');
    updateAssigneeVisibility();

    $('notes-text').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('notes-text').focus();
}

// ---------- writes ----------
async function saveNote(){
    const text = $('notes-text').value.trim();
    if(!text) return;

    const kind = $('notes-kind').value;
    const fields = {
        text,
        kind,
        note_date: $('notes-date').value || todayStr(),
        assigned_to: kind === 'discussion' ? null : ($('notes-assignee').value || null)
    };
    const updated_at = nowStamp();

    if(editingId){
        const id = editingId;
        const note = notes.find(n => sameId(n.id, id));
        if(note) Object.assign(note, fields, { updated_at });
        resetForm();
        saveToLocalCache();
        render();

        try{
            await writeOrQueue(sb, {
                table: NOTES_TABLE, type: 'update', id,
                payload: { ...fields, updated_at }
            });
        } catch(err){
            console.error('Failed to update note:', err);
        }
        return;
    }

    const id = crypto.randomUUID();
    const note = { id, ...fields, status: 'open', resolved_on: null, created_at: updated_at, updated_at };
    notes.push(note);
    resetForm();
    saveToLocalCache();
    render();

    try{
        await writeOrQueue(sb, { table: NOTES_TABLE, type: 'insert', id, payload: note });
    } catch(err){
        console.error('Failed to add note:', err);
    }
}

// Checking an action item drops it from the stickies; checking a discussion item
// drops it from the open list. Either way it stays in history, and unchecking reopens it.
async function toggleDone(id, done){
    const note = notes.find(n => sameId(n.id, id));
    if(!note) return;

    const updated_at = nowStamp();
    note.status = done ? 'done' : 'open';
    note.resolved_on = done ? todayStr() : null;
    note.updated_at = updated_at;
    saveToLocalCache();
    render();

    try{
        await writeOrQueue(sb, {
            table: NOTES_TABLE, type: 'update', id: note.id,
            payload: { status: note.status, resolved_on: note.resolved_on, updated_at }
        });
    } catch(err){
        console.error('Failed to update status:', err);
    }
}

async function deleteNote(id){
    notes = notes.filter(n => !sameId(n.id, id));
    if(editingId && sameId(editingId, id)) resetForm();
    saveToLocalCache();
    render();

    try{
        await writeOrQueue(sb, { table: NOTES_TABLE, type: 'delete', id });
    } catch(err){
        console.error('Failed to delete note:', err);
    }
}

// ---------- realtime ----------
let realtimeChannel = null;

function setupRealtime(){
    if(realtimeChannel || !sb) return;
    let timer;
    realtimeChannel = sb.channel('notes-realtime-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: NOTES_TABLE }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => loadNotes().catch(console.error), 300);
        })
        .subscribe();
}

// ---------- event listeners ----------
bindEvents(document, {
    'click #notes-save': saveNote,
    'click #notes-cancel': resetForm,
    'change #notes-kind': updateAssigneeVisibility,
    'change #notes-filter': (e) => {
        filterPerson = e.target.value;
        render();
    },
    'change [data-check-note]': (e, box) => toggleDone(box.dataset.checkNote, box.checked),
    'click [data-edit-note]': (e, btn) => startEditing(btn.dataset.editNote),
    'click [data-del-note]': (e, btn) => deleteNote(btn.dataset.delNote)
});

window.addEventListener('beforeunload', () => {
    if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
});

// Writes that fail (or happen while offline) are queued and retried on reconnect.
initSync(sb, { onChange: syncStatusHandler() });

// ---------- init ----------
function init(){
    if(loadFromLocalCache()) render();
    resetForm();
    refreshAll();
    setupRealtime();
}

if(window.initAppPage){
    window.initAppPage(init);
} else {
    document.addEventListener('app:ready', init, { once: true });
}