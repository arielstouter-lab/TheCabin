import { cloneEl, refs } from '../shared/dom.js';
import { setStatus } from '../shared/ui.js';

const sb = window.supabaseClient;
export const CARD_USAGE_TABLE = window.TABLES.CARD_USAGE;

let usageRows = [];

export async function loadCardUsageData() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CARD_USAGE_TABLE).select('*').order('created_at', { ascending: true });
        if (error) throw error;
        usageRows = data || [];
    } catch (err) {
        console.error('Could not load card usage:', err);
        setStatus('Could not load card usage.');
        usageRows = [];
    }
}

async function addUsage({ card_name, last_four, used_for, notes }) {
    if (!sb) return false;
    try {
        const { data, error } = await sb.from(CARD_USAGE_TABLE)
            .insert([{ card_name, last_four: last_four || null, used_for, notes }])
            .select().single();
        if (error) throw error;
        if (data) usageRows.push(data);
        renderCardUsage();
        setStatus('Added.', 'success');
        return true;
    } catch (err) {
        console.error('Could not add card usage:', err);
        setStatus('Could not add: ' + (err.message || err));
        return false;
    }
}

async function deleteUsage(id) {
    if (!sb) return false;
    try {
        const { error } = await sb.from(CARD_USAGE_TABLE).delete().eq('id', id);
        if (error) throw error;
        usageRows = usageRows.filter(r => r.id !== id);
        renderCardUsage();
        return true;
    } catch (err) {
        console.error('Could not delete card usage:', err);
        setStatus('Could not delete.');
        return false;
    }
}

function buildRow(row) {
    const el = cloneEl('tpl-card-usage-row');
    const r = refs(el);

    r.usedFor.textContent = row.used_for;
    r.card.textContent = row.last_four ? `${row.card_name} ···· ${row.last_four}` : row.card_name;
    if (row.notes) r.notes.textContent = ' — ' + row.notes;
    else r.notes.remove();
    r.del.addEventListener('click', () => deleteUsage(row.id));

    return el;
}

export function renderCardUsage() {
    const list = document.getElementById('cardUsageList');
    if (!list) return;
    const empty = document.getElementById('cardUsageEmpty');

    list.replaceChildren(...usageRows.map(buildRow));
    if (empty) empty.hidden = usageRows.length > 0;
}

export function initCardUsage() {
    const els = {
        card: document.getElementById('newUsageCard'),
        last4: document.getElementById('newUsageLast4'),
        usedFor: document.getElementById('newUsageFor'),
        notes: document.getElementById('newUsageNotes'),
        btn: document.getElementById('addUsageBtn')
    };
    if (!els.btn) return;

    els.last4.addEventListener('input', () => {
        els.last4.value = els.last4.value.replace(/\D/g, '').slice(0, 4);
    });

    async function submit() {
        const card_name = els.card.value.trim();
        const used_for = els.usedFor.value.trim();
        if (!card_name || !used_for) {
            setStatus('Card and "used for" are required.');
            return;
        }
        const ok = await addUsage({
            card_name,
            last_four: els.last4.value.trim(),
            used_for,
            notes: els.notes.value.trim()
        });
        if (ok) {
            els.card.value = els.last4.value = els.usedFor.value = els.notes.value = '';
            els.card.focus();
        }
    }

    els.btn.addEventListener('click', submit);
    [els.card, els.last4, els.usedFor, els.notes].forEach(el =>
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));
}
