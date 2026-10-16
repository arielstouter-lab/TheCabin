import { cloneEl, refs } from '../SharedJS/dom.js';
import { fmt$, setStatus } from '../SharedJS/ui.js';

const sb = window.supabaseClient;
const TABLES = window.TABLES;
export const TRACKER_TABLE = TABLES.SPENDING_TALLY || 'spending_tally';

const TRACKER_START_KEY = 'ccTrackerPeriodStart';

// Provided by creditcards.js via initTracker()
let getSpendRows = () => [];

let tallyRows = [];
let trackerStart = loadTrackerStart();
let trackerEnd = todayStr();
let pendingFocusId = null;

// -------------------------------------------------------------------
// Date helpers
// -------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function defaultTrackerStart() {
    const now = new Date();
    let y = now.getFullYear();
    if (new Date(y, 8, 28) > now) y -= 1; // most recent Sep 28
    return `${y}-09-28`;
}

function loadTrackerStart() {
    try { return localStorage.getItem(TRACKER_START_KEY) || defaultTrackerStart(); }
    catch (err) { return defaultTrackerStart(); }
}

function parseLocalDate(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
}

// Inclusive number of days in the selected period
function trackerDays() {
    if (!trackerStart || !trackerEnd) return 0;
    const diff = Math.round((parseLocalDate(trackerEnd) - parseLocalDate(trackerStart)) / 86400000) + 1;
    return diff > 0 ? diff : 0;
}

const monthlyToPeriod = monthly => (monthly * 12 / 365) * trackerDays();

const entriesFor = categoryId => tallyRows.filter(r =>
    r.period_start === trackerStart && String(r.category_id) === String(categoryId));

// -------------------------------------------------------------------
// Supabase
// -------------------------------------------------------------------
export async function loadTrackerData() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(TRACKER_TABLE).select('*').order('created_at', { ascending: true });
        if (error) throw error;
        tallyRows = data || [];
    } catch (err) {
        console.error('Could not load spending tracker entries:', err);
        tallyRows = [];
    }
}

async function addEntry(categoryId, rawAmount) {
    if (!sb) return false;
    const amount = parseFloat(rawAmount);
    if (!Number.isFinite(amount) || amount === 0) {
        setStatus('Enter an amount to add.');
        return false;
    }
    try {
        const { data, error } = await sb.from(TRACKER_TABLE)
            .insert([{ period_start: trackerStart, period_end: trackerEnd, category_id: categoryId, amount }])
            .select().single();
        if (error) throw error;
        if (data) tallyRows.push(data);
        pendingFocusId = categoryId;
        renderTracker();
        return true;
    } catch (err) {
        console.error('Could not add entry:', err);
        setStatus('Could not add entry: ' + (err.message || err));
        return false;
    }
}

async function deleteEntry(id) {
    if (!sb) return false;
    try {
        const { error } = await sb.from(TRACKER_TABLE).delete().eq('id', id);
        if (error) throw error;
        tallyRows = tallyRows.filter(r => r.id !== id);
        renderTracker();
        setStatus('Deleted entry.');
        return true;
    } catch (err) {
        console.error('Could not delete entry:', err);
        setStatus('Could not delete entry.');
        return false;
    }
}

// -------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------
function buildTrackerRow(cat, typedValue) {
    const tr = cloneEl('tpl-tracker-row');
    const r = refs(tr);

    const entries = entriesFor(cat.id);
    const monthly = cat.monthly_spend || 0;
    const estimate = monthlyToPeriod(monthly);
    const spent = entries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    const remaining = estimate - spent;
    const pct = estimate > 0 ? (spent / estimate) * 100 : (spent > 0 ? 100 : 0);

    tr.dataset.categoryId = cat.id;
    r.category.textContent = cat.category;
    r.monthly.textContent = fmt$(monthly);
    r.estimate.textContent = fmt$(estimate);
    r.spent.textContent = fmt$(spent);
    r.remaining.textContent = remaining >= 0 ? `${fmt$(remaining)} left` : `${fmt$(-remaining)} over`;
    r.remaining.classList.toggle('loss-val', remaining < 0);
    r.bar.value = Math.min(pct, 100);
    r.bar.title = `${pct.toFixed(0)}% of estimate`;

    r.entriesSummary.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
    r.entriesList.replaceChildren();
    entries.forEach(e => {
        const li = document.createElement('li');
        const when = e.created_at ? new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
        li.textContent = `${fmt$(parseFloat(e.amount) || 0)}${when ? ' · ' + when : ''} `;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-delete';
        del.title = 'Delete entry';
        del.textContent = '✕';
        del.addEventListener('click', () => deleteEntry(e.id));
        li.append(del);
        r.entriesList.append(li);
    });

    if (typedValue) r.amount.value = typedValue;
    const submit = () => addEntry(cat.id, r.amount.value);
    r.addBtn.addEventListener('click', submit);
    r.amount.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });

    return { tr, estimate, spent };
}

export function renderTracker() {
    const body = document.getElementById('trackerGridBody');
    if (!body) return;

    const startInput = document.getElementById('trackerStart');
    const endInput = document.getElementById('trackerEnd');
    if (startInput && document.activeElement !== startInput) startInput.value = trackerStart;
    if (endInput && document.activeElement !== endInput) endInput.value = trackerEnd;

    const days = trackerDays();
    const daysEl = document.getElementById('trackerDays');
    if (daysEl) daysEl.textContent = days
        ? `${days} day${days === 1 ? '' : 's'} · estimates are the Budget's monthly amounts × 12 ÷ 365 × ${days}`
        : 'Pick a valid period (end date on or after start date).';

    // Keep numbers typed but not yet added across re-renders
    const typed = {};
    body.querySelectorAll('tr[data-category-id]').forEach(tr => {
        const input = tr.querySelector('input[type="number"]');
        if (input && input.value) typed[tr.dataset.categoryId] = input.value;
    });

    const cats = getSpendRows();
    const empty = document.getElementById('trackerGridEmpty');
    if (empty) empty.hidden = cats.length > 0;

    body.replaceChildren();
    let totalEstimate = 0, totalSpent = 0;
    cats.forEach(cat => {
        const { tr, estimate, spent } = buildTrackerRow(cat, typed[cat.id]);
        totalEstimate += estimate;
        totalSpent += spent;
        body.append(tr);
    });

    const summary = document.getElementById('trackerSummaryGrid');
    if (summary) {
        const r = refs(summary);
        const remaining = totalEstimate - totalSpent;
        const isUnder = remaining >= 0;
        r.estVal.textContent = fmt$(totalEstimate);
        r.estFoot.textContent = `${fmt$(cats.reduce((s, c) => s + (c.monthly_spend || 0), 0))}/mo budgeted`;
        r.spentVal.textContent = fmt$(totalSpent);
        r.spentFoot.textContent = totalEstimate > 0 ? `${((totalSpent / totalEstimate) * 100).toFixed(0)}% of estimate` : '';
        r.netLabel.textContent = isUnder ? 'Remaining (Under Budget)' : 'Over Budget';
        r.netVal.textContent = fmt$(Math.abs(remaining));
        r.netFoot.textContent = `Estimate (${fmt$(totalEstimate)}) − Spent (${fmt$(totalSpent)})`;
        r.netCard.className = `summary-card ${isUnder ? 'surplus' : 'deficit'}`;
    }

    if (pendingFocusId !== null) {
        const row = body.querySelector(`tr[data-category-id="${pendingFocusId}"]`);
        const input = row && row.querySelector('input[type="number"]');
        if (input) input.focus();
        pendingFocusId = null;
    }
}

// -------------------------------------------------------------------
// Init (period inputs)
// -------------------------------------------------------------------
export function initTracker({ getSpendRows: spendRowsFn } = {}) {
    if (spendRowsFn) getSpendRows = spendRowsFn;

    const startInput = document.getElementById('trackerStart');
    if (startInput) {
        startInput.addEventListener('change', () => {
            if (!startInput.value) return;
            trackerStart = startInput.value;
            try { localStorage.setItem(TRACKER_START_KEY, trackerStart); } catch (err) { /* ignore */ }
            renderTracker();
        });
    }

    const endInput = document.getElementById('trackerEnd');
    if (endInput) {
        endInput.addEventListener('change', () => {
            if (!endInput.value) return;
            trackerEnd = endInput.value;
            renderTracker();
        });
    }

    const todayBtn = document.getElementById('trackerTodayBtn');
    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            trackerEnd = todayStr();
            renderTracker();
        });
    }
}