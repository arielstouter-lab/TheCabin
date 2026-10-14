import { writeOrQueue, nowStamp, getPendingOp, initSync } from './SharedJS/sync.js';
import { bindEvents, cloneEl, refs } from './SharedJS/dom.js';
import { makeChip, setStatus, syncStatusHandler } from './SharedJS/ui.js';

// This file is a module, so everything below is already module-scoped.
const sb = window.supabaseClient;
const TABLES = window.TABLES;
const todayStr = window.todayStr;
const updateSeason = window.updateSeason || function(){};

// ---------- constants ----------
const MS_PER_DAY = 86400000;
const PROJECTION_CYCLES = 12;
const FLOW_KEYS = ['spotting', 'light', 'medium', 'heavy']; // match your moon event titles
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const LAYER_PANELS = { moon: 'moon-panel', o: 'o-panel' };  // layer -> stats panel id
const CACHE_KEY = 'thecabin_cached_calendar';
const LISTS_CACHE_KEY = 'thecabin_cached_lists';

// ---------- Lists page offline cache ----------
// Keeps the Lists page's cache in step with changes made here, so Lists doesn't
// briefly show stale items while a write is still queued.
function updateListsCache(fn){
    try{
        const raw = localStorage.getItem(LISTS_CACHE_KEY);
        if(!raw) return;
        const data = JSON.parse(raw);
        data.itemsBySection ||= {};
        fn(data);
        localStorage.setItem(LISTS_CACHE_KEY, JSON.stringify(data));
    } catch(e){}
}

function patchListsCache(id, patch){
    updateListsCache(data => {
        Object.values(data.itemsBySection).forEach(items => {
            const item = items.find(i => i.id === id);
            if(item) Object.assign(item, patch);
        });
    });
}

function addToListsCache(sectionId, item){
    updateListsCache(data => {
        (data.itemsBySection[sectionId] ||= []).push(item);
    });
}

// ---------- state ----------
const histories = { o: [], moon: [] };        // every event_date per layer, ascending
const visibleLayers = new Set(['default', 'list']);
let viewYear, viewMonth;                      // month is 0-indexed
let selectedDate;                             // 'YYYY-MM-DD'
let eventsByDate = {};                        // 'YYYY-MM-DD' -> [event rows]
let projectedMoonDays = new Set();            // 'YYYY-MM-DD' strings
const pendingListInserts = {};

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if(el) el.textContent = text; };
const pad = n => String(n).padStart(2, '0');
const toDateStr = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDate = str => new Date(str + 'T00:00:00');
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const daysBetween = (a, b) => Math.round((b - a) / MS_PER_DAY);   // round: DST days aren't 24h
const average = list => list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : 0;

const layerOf = ev => ev.layer || 'default';   // null layer = default
const isDefault = ev => layerOf(ev) === 'default';
const isVisible = ev => visibleLayers.has(layerOf(ev));

function render(){
    renderGrid();
    renderEventsPanel();
}

// ---------- local cache -----------------------------------------------
// Lets the currently-viewed month render instantly offline, before (or
// instead of) the network fetch. Only used if it matches the month
// we're about to show, so switching months doesn't flash stale data.

function saveToLocalCache(){
    try{
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            eventsByDate, histories, viewYear, viewMonth, timestamp: Date.now()
        }));
    } catch(e){}
}

function loadFromLocalCache(){
    try{
        const raw = localStorage.getItem(CACHE_KEY);
        if(!raw) return false;
        const data = JSON.parse(raw);
        if(!data || data.viewYear !== viewYear || data.viewMonth !== viewMonth) return false;
        eventsByDate = data.eventsByDate || {};
        if(data.histories){
            histories.o = data.histories.o || [];
            histories.moon = data.histories.moon || [];
        }
        return true;
    } catch(e){
        return false;
    }
}

// Merges freshly-loaded server events with anything still pending in the
// offline write queue, so a reload can't silently discard a not-yet-synced
// local add/edit/delete. Same approach as the Lists page.
function mergeEventsWithPendingWrites(serverEvents){
    const previousById = {};
    Object.values(eventsByDate).flat().forEach(ev => { previousById[ev.id] = ev; });

    const next = {};
    serverEvents.forEach(ev => {
        const op = getPendingOp(TABLES.EVENTS, ev.id);
        if(op && op.type === 'delete') return; // deleted locally, not yet synced
        const finalEv = (op && op.type === 'update' && previousById[ev.id]) ? previousById[ev.id] : ev;
        (next[finalEv.event_date] ||= []).push(finalEv);
    });

    const serverIds = new Set(serverEvents.map(ev => ev.id));
    Object.values(previousById).forEach(ev => {
        const op = getPendingOp(TABLES.EVENTS, ev.id);
        if(op && op.type === 'insert' && !serverIds.has(ev.id)){
            (next[ev.event_date] ||= []).push(ev);
        }
    });

    return next;
}

// ---------- data loading ----------

// Dated list items show up as a read-only 'list' layer. They're derived at
// load time and never copied into the events table. Checked or deleted items
// (including ones whose write is still queued) are left out.
function addListItems(rows){
    const serverIds = new Set(rows.map(r => r.id));
    const push = item => {
        (eventsByDate[item.due_date] ||= []).push({
            id: item.id, title: item.text, event_date: item.due_date,
            layer: 'list', source: 'list', sort_order: 0,
            priority: !!item.priority
        });
    };

    rows.forEach(row => {
        const op = getPendingOp(TABLES.LIST_ITEMS, row.id);
        if(op && op.type === 'delete') return;
        const item = (op && op.type === 'update') ? { ...row, ...op.payload } : row;
        if(item.checked || !item.due_date) return;
        push(item);
    });

    // locally-added items whose insert hasn't synced yet
    Object.values(pendingListInserts).forEach(item => {
        const op = getPendingOp(TABLES.LIST_ITEMS, item.id);
        if(serverIds.has(item.id) || !op){ delete pendingListInserts[item.id]; return; }
        const d = parseDate(item.due_date);
        if(d.getFullYear() === viewYear && d.getMonth() === viewMonth) push(item);
    });
}

async function loadMonth(){
    const first = toDateStr(new Date(viewYear, viewMonth, 1));
    const last = toDateStr(new Date(viewYear, viewMonth + 1, 0));

    if(loadFromLocalCache()){
        render();
    }

    try{
        const [events, items] = await Promise.all([
            sb.from(TABLES.EVENTS)
                .select('*')
                .gte('event_date', first)
                .lte('event_date', last)
                .order('sort_order', { ascending: true }),
            sb.from(TABLES.LIST_ITEMS)
                .select('id, text, due_date, checked, priority')
                .gte('due_date', first)
                .lte('due_date', last)
        ]);
        if(events.error) throw events.error;
        if(items.error) throw items.error;

        eventsByDate = mergeEventsWithPendingWrites(events.data || []);
        addListItems(items.data || []);
        saveToLocalCache();
    } catch(err){
        console.error('Failed to load events:', err);
        if(!Object.keys(eventsByDate).length){
            setStatus('Could not load events.');
        }
    }
    render();
}

// The two <optgroup>s live in calendar.html; this only fills them.
async function loadLayerOptions(){
    const select = $('cal-event-layer');
    if(!select) return;
    try{
        const [events, sections] = await Promise.all([
            sb.from(TABLES.EVENTS).select('layer'),
            sb.from(TABLES.LIST_SECTIONS).select('id, name').order('name')
        ]);
        if(events.error) throw events.error;
        if(sections.error) throw sections.error;

        const layers = [...new Set((events.data || []).map(r => r.layer).filter(Boolean))].sort();
        const current = select.value;

        $('cal-layer-group').replaceChildren(
            ...layers.map(l => new Option(l, `layer:${l}`))
        );
        $('cal-list-group').replaceChildren(
            ...(sections.data || [])
                .filter(s => (s.name || '').toLowerCase() !== 'pantry')   // pantry items can't have dates
                .map(s => new Option(s.name, `list:${s.id}`))
        );

        if([...select.options].some(o => o.value === current)) select.value = current;
    } catch(err){
        console.error('Failed to load add targets', err);
    }
}

async function loadHistory(layer){
    try{
        const { data, error } = await sb.from(TABLES.EVENTS)
            .select('event_date')
            .eq('layer', layer)
            .order('event_date', { ascending: true });
        if(error) throw error;
        histories[layer] = data || [];
    } catch(err){
        console.error(`Failed to load ${layer} history`, err);
    }
}

async function refreshStats(){
    await Promise.all([loadHistory('o'), loadHistory('moon')]);
    updateOPanel();
    updateMoonPanel();
    renderGrid();   // projection may have changed
}

function refreshAll(){
    loadMonth().catch(console.error);
    loadLayerOptions().catch(console.error);
    refreshStats().catch(console.error);
}

// ---------- calendar grid ----------
function renderGrid(){
    updateSeason(new Date(viewYear, viewMonth, 1));   // month has no day, so use the 1st
    setText('cal-month-label', `${MONTH_NAMES[viewMonth]} ${viewYear}`);

    // always 6 weeks, starting on the Sunday on or before the 1st
    const startOffset = 1 - new Date(viewYear, viewMonth, 1).getDay();
    const today = todayStr();
    $('cal-days').replaceChildren(...Array.from({ length: 42 }, (_, i) =>
        buildDay(new Date(viewYear, viewMonth, startOffset + i), today)
    ));
}

// Dot state: overdue list items first, then priority, then the rest.
function dotState(ev, dateStr, today){
    if(ev.source === 'list' && dateStr < today) return 'overdue';
    return ev.priority ? 'priority' : '';
}

function buildDay(date, today){
    const dateStr = toDateStr(date);
    const events = (eventsByDate[dateStr] || []).filter(isVisible);
    const inLayer = layer => events.filter(ev => layerOf(ev) === layer);
    const moonEvents = inLayer('moon');

    const cell = cloneEl('tpl-cal-day');
    const r = refs(cell);

    cell.dataset.date = dateStr;
    cell.classList.toggle('other-month', date.getMonth() !== viewMonth);
    cell.classList.toggle('today', dateStr === today);
    cell.classList.toggle('selected', dateStr === selectedDate);
    r.num.textContent = String(date.getDate());

    // dots: default + list items, overdue first, then priority
    const dotItems = [...inLayer('default'), ...inLayer('list')].sort((a, b) =>
        Number(dotState(b, dateStr, today) === 'overdue') - Number(dotState(a, dateStr, today) === 'overdue') ||
        Number(!!b.priority) - Number(!!a.priority)
    );
    if(dotItems.length){
        r.dots.hidden = false;
        r.dots.append(...dotItems.slice(0, 4).map(ev => {
            const dot = cloneEl('tpl-cal-dot');
            const state = dotState(ev, dateStr, today);
            if(state) dot.dataset.state = state;
            return dot;
        }));
    }

    // os: single icon
    r.o.hidden = !inLayer('o').length;

    // flows: tint chosen by event title; logged days beat projected ones
    const flowKey = moonEvents
        .map(ev => (ev.title || '').trim().toLowerCase())
        .find(title => FLOW_KEYS.includes(title));
    const isProjected = visibleLayers.has('moon') && !moonEvents.length && projectedMoonDays.has(dateStr);
    const flow = flowKey || (isProjected ? 'projected' : '');
    if(flow){
        r.flow.dataset.flow = flow;
        r.flow.hidden = false;
    }

    return cell;
}

// ---------- events panel ----------

// index === null means pinned (not draggable)
function buildEventRow(ev, index){
    const row = cloneEl('tpl-cal-event');
    const r = refs(row);

    row.dataset.eventRow = ev.id;
    r.prefix.hidden = ev.layer !== 'moon';
    r.text.textContent = ev.title;

    if(ev.source === 'list'){
        r.check.hidden = false;
        r.check.dataset.checkItem = ev.id;
        if(ev.priority){
            r.chips.hidden = false;
            r.chips.append(makeChip('High priority', 'priority'));
        }
    } else {
        r.del.hidden = false;
        r.del.dataset.delEvent = ev.id;
    }

    if(index !== null){
        r.handle.hidden = false;
        row.classList.add('draggable-item');
        row.draggable = true;
        row.dataset.index = index;
    }
    return row;
}

function renderEventsPanel(){
    setText('cal-selected-label', parseDate(selectedDate)
        .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));

    const evs = (eventsByDate[selectedDate] || []).filter(isVisible);
    const defaults = evs.filter(isDefault);
    const others = evs.filter(ev => !isDefault(ev));
    others.sort((a, b) => !!b.priority - !!a.priority);   // stable, so only list items reorder

    $('cal-events').replaceChildren(...defaults.map((ev, i) => buildEventRow(ev, i)));
    $('cal-events-pinned').replaceChildren(...others.map(ev => buildEventRow(ev, null)));

    $('cal-events-divider').hidden = !(defaults.length && others.length);
    $('cal-events-empty').hidden = evs.length > 0;
}

// Each row's sort_order update is queued independently (last-write-wins
// per row), rather than one bulk call — local order is trusted and
// never reverted; if offline, it just sits queued until it syncs.
async function reorderEvents(fromIndex, toIndex){
    if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

    const defaults = (eventsByDate[selectedDate] || []).filter(isDefault);
    if(!defaults[fromIndex]) return;

    // reuse the sort_order values already in use, just in the new order
    const slots = defaults.map(ev => ev.sort_order);
    const [moved] = defaults.splice(fromIndex, 1);
    defaults.splice(toIndex, 0, moved);

    const updated_at = nowStamp();
    defaults.forEach((ev, i) => { ev.sort_order = slots[i]; ev.updated_at = updated_at; });

    eventsByDate[selectedDate].sort((a, b) => a.sort_order - b.sort_order);
    saveToLocalCache();
    renderEventsPanel();

    try {
        await Promise.all(defaults.map(ev =>
            writeOrQueue(sb, {
                table: TABLES.EVENTS, type: 'update', id: ev.id,
                payload: { sort_order: ev.sort_order, updated_at }
            })
        ));
    } catch (err) {
        console.error('Failed to save reordered events:', err);
    }
}

function selectDate(dateStr){
    selectedDate = dateStr;
    const date = parseDate(dateStr);
    if(date.getFullYear() !== viewYear || date.getMonth() !== viewMonth){
        viewYear = date.getFullYear();
        viewMonth = date.getMonth();
        loadMonth().catch(console.error);
    } else {
        render();
    }
}

function changeMonth(delta){
    if(viewYear === undefined) return;
    const date = new Date(viewYear, viewMonth + delta, 1);
    viewYear = date.getFullYear();
    viewMonth = date.getMonth();
    loadMonth().catch(console.error);
}

// ---------- moon stats + projection ----------
// rows: [{event_date}] ascending -> array of cycles, each an array of consecutive Dates
function buildMoonCycles(rows){
    const dates = [...new Set(rows.map(row => row.event_date))].map(parseDate);   // dedupe same-day events
    const cycles = [];
    dates.forEach((date, i) => {
        if(i > 0 && daysBetween(dates[i - 1], date) === 1){
            cycles[cycles.length - 1].push(date);
        } else {
            cycles.push([date]);
        }
    });
    return cycles;
}

function getMoonStats(){
    const lookback = $('moon-lookback');
    if(!lookback) return null;

    const months = Number(lookback.value);
    const cutoff = new Date();
    if(months !== 999) cutoff.setMonth(cutoff.getMonth() - months);

    const rows = histories.moon.filter(row =>
        months === 999 || parseDate(row.event_date) >= cutoff
    );

    // ignore 1-day "cycles"
    const cycles = buildMoonCycles(rows).filter(cycle => cycle.length > 1);
    if(!cycles.length) return null;

    const gaps = cycles.slice(1).map((cycle, i) => daysBetween(cycles[i][0], cycle[0]));

    return {
        avgLength: average(cycles.map(cycle => cycle.length)),
        avgGap: average(gaps),   // 0 when there's only one cycle
        lastStart: cycles[cycles.length - 1][0]
    };
}

const projectedStart = (stats, k) => addDays(stats.lastStart, Math.round(stats.avgGap) * k);

function buildProjection(stats){
    const days = new Set();
    const length = Math.max(1, Math.round(stats.avgLength));
    const today = todayStr();

    for(let k = 1; k <= PROJECTION_CYCLES; k++){
        const start = projectedStart(stats, k);
        for(let i = 0; i < length; i++){
            const str = toDateStr(addDays(start, i));
            if(str >= today) days.add(str);   // only future days
        }
    }
    return days;
}

function updateMoonPanel(){
    const stats = getMoonStats();
    const canProject = !!stats && stats.avgGap >= 1;   // need 2+ cycles to know the gap

    projectedMoonDays = canProject ? buildProjection(stats) : new Set();

    setText('moon-avg-length', stats ? stats.avgLength.toFixed(1) : '--');
    setText('moon-avg-between', canProject ? stats.avgGap.toFixed(1) : '--');
    setText('moon-next-1', canProject ? projectedStart(stats, 1).toLocaleDateString() : '--');
    setText('moon-next-2', canProject ? projectedStart(stats, 2).toLocaleDateString() : '--');
}

// ---------- "o" stats ----------
function updateOPanel(){
    const dates = histories.o.map(row => parseDate(row.event_date));
    if(!dates.length){
        setText('o-days-since', '--');
        setText('o-longest-gap', '--');
        return;
    }

    const daysSince = daysBetween(dates[dates.length - 1], parseDate(todayStr()));
    const gaps = dates.slice(1).map((date, i) => daysBetween(dates[i], date));

    setText('o-days-since', String(daysSince));
    setText('o-longest-gap', String(Math.max(daysSince, ...gaps)));   // the current streak counts too
}

// ---------- realtime ----------
let realtimeChannel = null;

function setupRealtime(){
    if(realtimeChannel || !sb) return;
    const timers = {};
    const handlers = [
        [TABLES.EVENTS, refreshAll],
        [TABLES.LIST_ITEMS, loadMonth]   // list changes only need the month reloaded
    ];
    let channel = sb.channel('calendar-realtime-channel');
    handlers.forEach(([table, handler]) => {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
            clearTimeout(timers[table]);
            timers[table] = setTimeout(handler, 300);
        });
    });
    realtimeChannel = channel.subscribe();
}

// ---------- adding events ----------
async function addListItem(title, sectionId){
    const id = crypto.randomUUID();
    const item = { id, text: title, due_date: selectedDate, section_id: sectionId,
        checked: false, priority: false, updated_at: nowStamp() };
    pendingListInserts[id] = item;

    (eventsByDate[selectedDate] ||= []).push({
        id, title, event_date: selectedDate, layer: 'list',
        source: 'list', sort_order: 0, priority: false
    });

    addToListsCache(sectionId, item);
    saveToLocalCache();
    render();

    try {
        await writeOrQueue(sb, { table: TABLES.LIST_ITEMS, type: 'insert', id, payload: item });
    } catch (err) {
        console.error('Failed to add list item:', err);
    }
}

async function addCalendarEvent(title, layer){
    const id = crypto.randomUUID();
    const updated_at = nowStamp();
    const events = eventsByDate[selectedDate] || [];
    const sort_order = Math.max(0, events.length, ...events.map(ev => Number(ev.sort_order) || 0)) + 1;
    const basePayload = { event_date: selectedDate, title, sort_order, layer: layer || null };

    (eventsByDate[selectedDate] ||= []).push({ id, ...basePayload, updated_at });
    saveToLocalCache();
    render();

    try {
        await writeOrQueue(sb, {
            table: TABLES.EVENTS, type: 'insert', id,
            payload: { id, ...basePayload, updated_at }
        });
    } catch (err) {
        console.error('Failed to add event:', err);
    }
}

// ---------- event listeners ----------
initDragAndDrop($('cal-events'), { onReorder: reorderEvents });

bindEvents(document, {
    'click #cal-prev': () => changeMonth(-1),
    'click #cal-next': () => changeMonth(1),
    'click .cal-day': (e, cell) => selectDate(cell.dataset.date),
    'change #moon-lookback': () => {
        updateMoonPanel();
        renderGrid();
    },
    'click .cal-overlay-btn': (e, btn) => {
        const layer = btn.dataset.layer;
        const nowVisible = !visibleLayers.has(layer);
        if(nowVisible) visibleLayers.add(layer); else visibleLayers.delete(layer);

        btn.classList.toggle('active', nowVisible);
        const panel = $(LAYER_PANELS[layer]);
        if(panel) panel.hidden = !nowVisible;
        render();
    },
    'keydown #cal-new-event': (e) => {
        if(e.key === 'Enter') $('cal-add-event').click();
    },
    'click #cal-add-event': async () => {
        const input = $('cal-new-event');
        const title = input.value.trim();
        const target = $('cal-event-layer').value;
        if(!title || !target) return;

        const [kind, ...rest] = target.split(':');
        const key = rest.join(':');
        input.value = '';

        // list section: checkable item due on the selected day
        // otherwise: regular calendar event, no checkbox
        if(kind === 'list') await addListItem(title, key);
        else await addCalendarEvent(title, key);
    },
    'click [data-del-event]': async (e, btn) => {
        const id = btn.dataset.delEvent;
        eventsByDate[selectedDate] = (eventsByDate[selectedDate] || [])
            .filter(ev => String(ev.id) !== id);
        saveToLocalCache();
        render();

        try {
            await writeOrQueue(sb, { table: TABLES.EVENTS, type: 'delete', id });
        } catch (err) {
            console.error('Failed to delete event:', err);
        }
    },
    'change .cal-event-check': async (e, box) => {
        const id = box.dataset.checkItem;
        const updated_at = nowStamp();

        eventsByDate[selectedDate] = (eventsByDate[selectedDate] || [])
            .filter(ev => String(ev.id) !== id);
        patchListsCache(id, { checked: true, updated_at });
        saveToLocalCache();
        render();

        try {
            await writeOrQueue(sb, {
                table: TABLES.LIST_ITEMS, type: 'update', id,
                payload: { checked: true, updated_at }
            });
        } catch (err) {
            console.error('Failed to update check item:', err);
        }
    }
});

window.addEventListener('beforeunload', () => {
    if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
});

// Event writes that fail (or happen while offline) are queued and
// retried automatically on reconnect. A persistent toast shows the queue size.
initSync(sb, { onChange: syncStatusHandler() });

// ---------- init ----------
function init(){
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
    selectedDate = todayStr();

    refreshAll();
    setupRealtime();
}

if(window.initAppPage){
    window.initAppPage(init);
} else {
    document.addEventListener('app:ready', init, { once: true });
}