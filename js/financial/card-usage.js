import { cloneEl, refs } from '../shared/dom.js';
import { setStatus } from '../shared/ui.js';
import { supabase as sb } from '../shared/supabase.js';
import { TABLES } from '../shared/database-config.js';
import { writeOrQueue, nowStamp } from '../shared/sync.js';

export const CARD_USAGE_TABLE = TABLES.CARD_USAGE;

const CACHE_KEY = 'thecabin_card_usage_cache';

let usageRows = [];

export function saveToLocalCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ usageRows, timestamp: Date.now() }));
    } catch (e) {}
}

export function loadFromLocalCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.usageRows)) return false;
        usageRows = data.usageRows;
        return true;
    } catch (e) {
        return false;
    }
}

export async function loadCardUsageData() {
    const hadCached = loadFromLocalCache();
    if (hadCached) renderCardUsage();
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CARD_USAGE_TABLE).select('*').order('created_at', { ascending: true });
        if (error) throw error;
        usageRows = data || [];
        saveToLocalCache();
    } catch (err) {
        console.error('Could not load card usage:', err);
        if (!hadCached) {
            setStatus('Could not load card usage.');
            usageRows = [];
        }
    }
    renderCardUsage();
}

async function addUsage({ card_name, last_four, used_for, notes }) {
    try {
        const id = crypto.randomUUID();
        const row = { id, card_name, last_four: last_four || null, used_for, notes: notes || null, created_at: nowStamp() };
        usageRows.push(row);
        renderCardUsage();
        saveToLocalCache();
        writeOrQueue(sb, {
            table: CARD_USAGE_TABLE,
            type: 'insert',
            id,
            payload: row
        });
        setStatus('Added.', 'success');
        return true;
    } catch (err) {
        console.error('Could not add card usage:', err);
        setStatus('Could not add: ' + (err.message || err));
        return false;
    }
}

async function deleteUsage(id) {
    try {
        usageRows = usageRows.filter(r => r.id !== id);
        renderCardUsage();
        saveToLocalCache();
        writeOrQueue(sb, {
            table: CARD_USAGE_TABLE,
            type: 'delete',
            id
        });
        setStatus('Deleted.', 'success');
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
    saveToLocalCache();
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
