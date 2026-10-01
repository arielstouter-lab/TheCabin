// Debt tab — snapshots of outstanding debts, mortgage + PMI goal, monthly
// money (defaults to Budget Net Balance), and payoff scenarios.
//
// creditcards.js wires this in:
//   initDebts({ getNetBalance, getBankRows })   once, at module load
//   await loadDebtData()                        inside loadAll / debounceReload
//   renderDebts()                               at the end of render()
//
// Math lives in debt-engine.js; this file is UI + Supabase only.

import { cloneEl, refs } from './dom.js';
import { renderSummaryCards } from './summary-card.js';
import {
    amortizedPayment, minimumPayment, amortizationSchedule, scheduledBalanceAt,
    simulate, effectiveApr, addMonths, isYm, MAX_MONTHS
} from './debt-engine.js';

const sb = window.supabaseClient;
const DEBTS_TABLE = 'debts';
const SNAP_TABLE = 'debt_snapshots';
const MONEY_TABLE = 'debt_month_money';
const SETTINGS_TABLE = 'debt_settings';

// ------------------------------------------------------------------ state
let deps = { getNetBalance: () => 0, getBankRows: () => [] };
let debtRows = [];
let snapRows = [];
let moneyRows = [];
let settings = { strategy: 'avalanche' };
let selectedMonth = null;
let planKey = 'pmi';
let channel = null;
let reloadTimer = null;
let renderQueued = false;

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const status = msg => { if (window.setStatus) window.setStatus(msg); };
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = v => {
    const s = String(v ?? '').trim();
    if (s === '') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
};
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function fmt$(n) {
    const val = typeof n === 'number' && !isNaN(n) ? n : 0;
    const sign = val < 0 ? '-' : '';
    return sign + '$' + (Math.round(Math.abs(val) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtYm(ym) {
    if (!isYm(ym)) return '—';
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' (or null) -> 'YYYY-MM' (or null)
const dateToYm = v => {
    const ym = v ? String(v).slice(0, 7) : '';
    return isYm(ym) ? ym : null;
};

function thisYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
}

const strategyLabel = s => (s === 'snowball' ? 'Snowball (smallest balance first)' : 'Avalanche (highest APR first)');

// ------------------------------------------------------------- data access
async function fetchAll(table, orderCol) {
    const q = sb.from(table).select('*');
    const { data, error } = await (orderCol ? q.order(orderCol, { ascending: true }) : q);
    if (error) throw error;
    return data || [];
}

async function fetchDebtData() {
    [debtRows, snapRows, moneyRows] = await Promise.all([
        fetchAll(DEBTS_TABLE, 'created_at'),
        fetchAll(SNAP_TABLE, 'created_at'),
        fetchAll(MONEY_TABLE, 'month')
    ]);
    const { data, error } = await sb.from(SETTINGS_TABLE).select('*').eq('id', 1).maybeSingle();
    if (!error && data) settings = { ...settings, ...data };
}

export async function loadDebtData() {
    if (!sb) return;
    try {
        await fetchDebtData();
    } catch (err) {
        console.error('Error loading debts:', err);
        status('Could not load debts — have you run debts.sql?');
        debtRows = []; snapRows = []; moneyRows = [];
    }
    setupDebtRealtime();
}

function setupDebtRealtime() {
    if (channel || !sb) return;
    channel = sb.channel('debts_changes');
    [DEBTS_TABLE, SNAP_TABLE, MONEY_TABLE, SETTINGS_TABLE].forEach(table => {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, debounceReload);
    });
    channel.subscribe();
}

function debounceReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
        const a = document.activeElement;
        if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
        try { await fetchDebtData(); renderDebts(); } catch (err) { console.warn('Debt reload failed:', err); }
    }, 400);
}

window.addEventListener('beforeunload', () => {
    if (channel && sb) sb.removeChannel(channel);
});

// Change handlers fire on blur, before focus lands on the next field. Rendering
// on the next tick lets renderDebts() see where focus went and restore it.
function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; renderDebts(); }, 0);
}

async function persist(table, id, patch, failMsg) {
    if (!sb) return false;
    try {
        const { error } = await sb.from(table).update(patch).eq('id', id);
        if (error) throw error;
        return true;
    } catch (err) {
        console.error(failMsg, err);
        status(failMsg);
        return false;
    }
}

function updateDebt(id, patch) {
    const row = debtRows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
    queueRender();
    return persist(DEBTS_TABLE, id, patch, 'Could not update debt.');
}

function updateSnap(id, patch) {
    const row = snapRows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
    queueRender();
    return persist(SNAP_TABLE, id, patch, 'Could not update snapshot.');
}

// ---------------------------------------------------- snapshots / months
const snapshotMonths = () => [...new Set(snapRows.map(s => s.month))].sort().reverse();

function resolveMonth() {
    const months = snapshotMonths();
    if (selectedMonth && months.includes(selectedMonth)) return selectedMonth;
    selectedMonth = months[0] || null;
    return selectedMonth;
}

// ---------------------------------------------------- money available
// Money available is saved per snapshot month in debt_month_money. A saved
// amount (or null = Budget Net Balance) applies to every month after that
// snapshot until a later snapshot saves a different setting.
function moneyFor(ym) {
    let hit = null;
    for (const r of moneyRows) {
        if (r.month < ym && (!hit || r.month > hit.month)) hit = r;
    }
    return hit && hit.amount != null ? num(hit.amount) : null;
}

async function saveMoney(month, amount) {
    if (!sb || !month) return;
    const i = moneyRows.findIndex(r => r.month === month);
    if (i >= 0) moneyRows[i] = { ...moneyRows[i], amount };
    else moneyRows.push({ month, amount });
    renderDebts();
    try {
        const { data, error } = await sb.from(MONEY_TABLE).upsert([{ month, amount }], { onConflict: 'month' }).select().single();
        if (error) throw error;
        const j = moneyRows.findIndex(r => r.month === month);
        if (j >= 0) moneyRows[j] = data;
    } catch (err) {
        console.error('Could not save money available:', err);
        status('Could not save money available: ' + (err.message || err));
    }
}

// First payment month: explicit, else two months after origination (the usual
// "closed in March, first payment in May" convention).
function firstPaymentYm(d) {
    if (isYm(d.first_payment_month)) return d.first_payment_month;
    if (d.origination_date) {
        const ym = String(d.origination_date).slice(0, 7);
        if (isYm(ym)) return addMonths(ym, 2);
    }
    return null;
}

function loanInfo(d, aprPct) {
    const principal = num(d.original_principal);
    const term = Math.round(num(d.term_months));
    const first = firstPaymentYm(d);
    const pi = principal > 0 && term > 0 ? amortizedPayment(principal, aprPct, term) : 0;
    const rows = pi > 0 && first
        ? amortizationSchedule({ principal, aprPct, termMonths: term, firstPaymentYm: first, payment: pi })
        : null;
    return { principal, term, first, pi, rows };
}

async function createSnapshot(month) {
    if (!isYm(month)) { status('Pick a month for the new snapshot.'); return; }
    if (snapshotMonths().includes(month)) { selectedMonth = month; renderDebts(); return; }
    if (!sb) return;

    const inserts = [];
    debtRows.forEach(d => {
        const mine = snapRows.filter(s => s.debt_id === d.id).sort((a, b) => b.month.localeCompare(a.month));
        const prior = mine.find(s => s.month < month) || mine[0];
        if (!prior) return;
        let balance = num(prior.balance);
        if (d.kind === 'mortgage' || d.kind === 'loan') {
            // Carry the balance forward by the scheduled principal for the months that passed
            const info = loanInfo(d, num(prior.apr));
            if (info.rows) {
                const drop = scheduledBalanceAt(info.rows, info.principal, prior.month) - scheduledBalanceAt(info.rows, info.principal, month);
                balance = Math.max(0, balance - Math.max(0, drop));
            }
        }
        inserts.push({ debt_id: d.id, month, balance, apr: num(prior.apr), payment_override: prior.payment_override ?? null });
    });
    if (!inserts.length) { status('Add a debt first.'); return; }

    try {
        const { data, error } = await sb.from(SNAP_TABLE).insert(inserts).select();
        if (error) throw error;
        snapRows.push(...(data || []));
// Carry the money-available setting forward; it keeps applying until reset
        try {
            const carried = moneyFor(addMonths(month, 1));
            const { data: m, error: mErr } = await sb.from(MONEY_TABLE).upsert([{ month, amount: carried }], { onConflict: 'month' }).select().single();
            if (!mErr && m) moneyRows = [...moneyRows.filter(r => r.month !== month), m];
        } catch (err) {
            console.warn('Could not carry the money setting forward:', err);
        }        
        selectedMonth = month;
        const input = $('debtNewMonth');
        if (input) input.value = '';
        renderDebts();
        status(`Started ${fmtYm(month)} snapshot — update the balances.`);
    } catch (err) {
        console.error('Could not create snapshot:', err);
        status('Could not create snapshot: ' + (err.message || err));
    }
}

async function deleteMonth(month) {
    if (!month || !sb) return;
    if (!confirm(`Delete the ${fmtYm(month)} snapshot for every debt?`)) return;
    try {
        const { error } = await sb.from(SNAP_TABLE).delete().eq('month', month);
        if (error) throw error;
        snapRows = snapRows.filter(s => s.month !== month);
        
await sb.from(MONEY_TABLE).delete().eq('month', month);
        moneyRows = moneyRows.filter(r => r.month !== month);
        
        if (selectedMonth === month) selectedMonth = null;
        renderDebts();
        status('Deleted snapshot.');
    } catch (err) {
        console.error('Could not delete snapshot:', err);
        status('Could not delete snapshot.');
    }
}

async function addDebt({ name, kind, balance, apr }) {
    if (!sb) return;
    try {
        const month = resolveMonth() || thisYm();
        const { data: debt, error } = await sb.from(DEBTS_TABLE).insert([{ name, kind, in_budget: kind === 'mortgage' }]).select().single();
        if (error) throw error;
        const { data: snap, error: e2 } = await sb.from(SNAP_TABLE).insert([{ debt_id: debt.id, month, balance, apr }]).select().single();
        if (e2) throw e2;
        debtRows.push(debt);
        snapRows.push(snap);
        selectedMonth = month;
        renderDebts();
        status(kind === 'mortgage' ? 'Added mortgage — fill in its loan details below.' : 'Added debt.');
    } catch (err) {
        console.error('Could not add debt:', err);
        status('Could not add debt: ' + (err.message || err));
    }
}

async function deleteDebt(id, name) {
    if (!sb) return;
    if (!confirm(`Delete "${name}" and all of its monthly snapshots?`)) return;
    try {
        const { error } = await sb.from(DEBTS_TABLE).delete().eq('id', id);
        if (error) throw error;
        debtRows = debtRows.filter(d => d.id !== id);
        snapRows = snapRows.filter(s => s.debt_id !== id);
        renderDebts();
        status('Deleted debt.');
    } catch (err) {
        console.error('Could not delete debt:', err);
        status('Could not delete debt.');
    }
}

// ---------------------------------------------------- overrides + settings
async function saveStrategy(strategy) {
    settings.strategy = strategy;
    renderDebts();
    if (!sb) return;
    try {
        const { error } = await sb.from(SETTINGS_TABLE).upsert([{ id: 1, strategy }], { onConflict: 'id' });
        if (error) throw error;
    } catch (err) {
        console.error('Could not save strategy:', err);
    }
}

// ------------------------------------------------------------------ model
// Everything derived from the current snapshot + Budget, computed once per render.
function buildModel() {
    const month = resolveMonth();
    if (!month) return null;

    const bankRows = deps.getBankRows() || [];
    const rowAmt = id => {
        const r = bankRows.find(b => sameId(b.id, id));
        return r ? num(r.monthly_spend) : 0;
    };
    const netBalance = num(deps.getNetBalance());
    const warnings = [];

    const items = snapRows
        .filter(s => s.month === month)
        .map(s => ({ s, d: debtRows.find(x => x.id === s.debt_id) }))
        .filter(x => x.d)
        .sort((a, b) => String(a.d.created_at).localeCompare(String(b.d.created_at)))
        .map(({ s, d }) => {
            const balance = num(s.balance);
            const apr = num(s.apr);
            const override = num(s.payment_override) > 0 ? num(s.payment_override) : null;
            const isMortgage = d.kind === 'mortgage';
            const isTermLoan =
                d.kind === 'mortgage' ||
                d.kind === 'loan';
            const minPct = 1;
            const minFloor = 35;
            const addsInterest = d.min_adds_interest !== false;
            const promoApr = !isMortgage ? numOrNull(d.promo_apr) : null;
            const promoStartYm = dateToYm(d.promo_start);
            const promoEndYm = dateToYm(d.promo_end);
            // Rate charged in the first projected month (the month after the snapshot)
            const rateNow = effectiveApr({ apr, promoApr, promoStartYm, promoEndYm }, addMonths(month, 1));
            const interest = (balance * rateNow) / 1200;

            if (promoApr != null) {
                if (!promoEndYm) warnings.push(`${d.name}: the promo rate has no expiration date, so it is treated as permanent.`);
                else if (promoStartYm && promoEndYm <= promoStartYm) warnings.push(`${d.name}: the promo expires before it starts.`);
            }

            const mort = isTermLoan
                ? loanInfo(d, apr)
                : null;
            const cardMin = minimumPayment({ balance, apr: rateNow, minPct, minFloor, addsInterest });
            const autoMin = mort && mort.pi > 0 ? mort.pi : cardMin;
            const scheduled = balance > 0 ? Math.min(balance + interest, override ?? autoMin) : 0;

            if (balance > 0 && scheduled > 0 && scheduled <= interest + 0.005) {
                warnings.push(`${d.name}: the payment (${fmt$(scheduled)}) doesn't cover the monthly interest (${fmt$(interest)}).`);
            }

            // PMI modelling (mortgage only)
            const homeValue = num(d.home_value);
            const ltv = d.target_ltv == null ? 79 : num(d.target_ltv);
            const pmiRowAmount = isMortgage ? rowAmt(d.pmi_row_id) : 0;
            const targetBalance = isMortgage && homeValue > 0 ? (homeValue * ltv) / 100 : 0;
            const pmiAmount = targetBalance > 0 ? pmiRowAmount : 0;

            if (isMortgage) {
                if (!(mort.pi > 0)) warnings.push(`${d.name}: add the original principal and term so the payment and schedule can be calculated.`);
                if (pmiRowAmount > 0 && !(homeValue > 0)) warnings.push(`${d.name}: enter the home value to model when PMI drops.`);
                const payRowAmt = rowAmt(d.payment_row_id);
                if (payRowAmt > 0 && mort.pi > 0 && payRowAmt < mort.pi - 1) {
                    warnings.push(`${d.name}: the Budget row (${fmt$(payRowAmt)}) is below the calculated P&I (${fmt$(mort.pi)}). Check the rate, term and principal.`);
                }
            }

            return {
                s, d, isMortgage: isMortgage, balance, apr, rateNow, override, interest, autoMin, scheduled, mort,
                homeValue, ltv, targetBalance, pmiAmount, pmiRowAmount,
                pmiNow: pmiAmount > 0 && balance > targetBalance + 0.005 ? pmiAmount : 0,
                engine: {
                    id: d.id, name: d.name, kind: d.kind, balance, apr, promoApr, promoStartYm, promoEndYm,
                    minPct, minFloor, addsInterest,
                    paymentOverride: override || 0, inBudget: !!d.in_budget,
                    piPayment: mort ? mort.pi : 0, pmiAmount, targetBalance
                }
            };
        });

// Expand the per-snapshot money setting into the month-by-month map the engine uses
    // (months with no fixed amount fall back to the Budget Net Balance).
    const overrideMap = {};
    for (let i = 1; i <= MAX_MONTHS; i++) {
        const ym = addMonths(month, i);
        const amt = moneyFor(ym);
        if (amt != null) overrideMap[ym] = amt;
    }
    
    const engineDebts = items.map(i => i.engine);
    const base = { debts: engineDebts, monthlyMoney: Math.max(0, netBalance), overrides: overrideMap, startYm: month, strategy: settings.strategy };

    const scenarios = [
        { key: 'min', label: 'Minimums only (no extra)', result: simulate({ ...base, mode: 'minimums' }) },
        { key: 'plan', label: strategyLabel(settings.strategy), result: simulate(base) }
    ];
    const pmiPossible = engineDebts.some(d => d.pmiAmount > 0 && d.balance > d.targetBalance);
    if (pmiPossible) {
        scenarios.push({
            key: 'pmi',
            label: `PMI target first, then ${settings.strategy === 'snowball' ? 'snowball' : 'avalanche'}`,
            result: simulate({ ...base, pmiFirst: true })
        });
    }

if (netBalance <= 0 && items.length && moneyFor(addMonths(month, 1)) == null) warnings.push('The Budget Net Balance is zero or negative, so there is no extra money to apply. Set a fixed amount under Money Available to test a plan.');    const plan = scenarios.find(s => s.key === 'plan').result;
    if (plan.totalShortfall > 0) warnings.push(`In some months the money available doesn't cover the minimums that aren't already in the Budget (short by ${fmt$(plan.totalShortfall)} in total).`);

    if (!scenarios.some(s => s.key === planKey)) planKey = pmiPossible ? 'pmi' : 'plan';

    return { month, items, netBalance, scenarios, warnings, engineDebts };
}

// -------------------------------------------------------------- rendering
export function renderDebts() {
    const pane = $('tab-debt');
    if (!pane) return;
    const active = document.activeElement;
    const fk = active && pane.contains(active) ? active.dataset.fk : null;

    const model = buildModel();
    renderToolbar(model);
    renderDebtGrid(model);
    renderDebtSummary(model);
    renderLoanCards(model);
    renderMoney(model);
    renderResults(model);

    if (fk) {
        const target = pane.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
        if (target) {
            target.focus();
            if ((target.type === 'text' || target.type === 'number') && target.select) target.select();
        }
    }
}

function renderToolbar(model) {
    const select = $('debtMonthSelect');
    if (!select) return;
    const months = snapshotMonths();
    select.replaceChildren();
    if (!months.length) {
        const o = el('option', 'No snapshots yet');
        o.value = '';
        select.append(o);
    }
    months.forEach(m => {
        const o = el('option', fmtYm(m));
        o.value = m;
        select.append(o);
    });
    select.value = model ? model.month : '';
    $('debtDeleteMonthBtn').disabled = !model;

    const input = $('debtNewMonth');
    if (input && !input.value && document.activeElement !== input) {
        input.value = months.length ? addMonths(months[0], 1) : thisYm();
    }
}

function buildDebtRow(it) {
    const { d, s, isMortgage } = it;
    const tr = cloneEl('tpl-debt-row');
    const r = refs(tr);
    ['name', 'kind', 'balance', 'apr', 'promoApr', 'promoStart', 'promoEnd', 'override', 'inBudget'].forEach(k => { r[k].dataset.fk = `${s.id}:${k}`; });

    r.name.value = d.name || '';
    r.kind.value = d.kind || 'card';
    r.balance.value = s.balance ?? 0;
    r.apr.value = s.apr ?? 0;
    r.override.value = s.payment_override ?? '';
    r.override.placeholder = 'auto';
    r.inBudget.checked = !!d.in_budget;
    // Promo rate (cards/loans). The start date shows today until one is saved.
    r.promoApr.value = d.promo_apr ?? '';
    r.promoStart.value = d.promo_start ? String(d.promo_start).slice(0, 10) : todayIso();
    r.promoEnd.value = d.promo_end ? String(d.promo_end).slice(0, 10) : '';
    r.promoWrap.hidden = isMortgage;
    r.promoNA.hidden = !isMortgage;
    r.minPay.textContent = fmt$(it.scheduled);
    r.minPay.title = it.override ? 'Using your override' : 'Calculated minimum';
    r.interest.textContent = fmt$(it.interest + it.pmiNow);
    r.interest.title = it.pmiNow > 0
        ? `Interest ${fmt$(it.interest)} + PMI ${fmt$(it.pmiNow)}`
        : (it.rateNow !== it.apr ? `Promo rate ${it.rateNow}% applies next month` : '');
    
    r.name.addEventListener('change', () => updateDebt(d.id, { name: r.name.value.trim() || d.name }));
    r.kind.addEventListener('change', () => updateDebt(d.id, { kind: r.kind.value }));
    r.inBudget.addEventListener('change', () => updateDebt(d.id, { in_budget: r.inBudget.checked }));
    r.promoApr.addEventListener('change', () => {
        const rate = numOrNull(r.promoApr.value);
        // Clearing the rate removes the promo; entering one starts it today unless a start date is saved
        if (rate == null) updateDebt(d.id, { promo_apr: null, promo_start: null, promo_end: null });
        else updateDebt(d.id, { promo_apr: rate, promo_start: d.promo_start || r.promoStart.value || todayIso() });
    });
    r.promoStart.addEventListener('change', () => updateDebt(d.id, { promo_start: r.promoStart.value || null }));
    r.promoEnd.addEventListener('change', () => updateDebt(d.id, { promo_end: r.promoEnd.value || null }));
    r.balance.addEventListener('change', () => updateSnap(s.id, { balance: num(r.balance.value) }));
    r.apr.addEventListener('change', () => updateSnap(s.id, { apr: num(r.apr.value) }));
    r.override.addEventListener('change', () => updateSnap(s.id, { payment_override: numOrNull(r.override.value) }));
    r.delBtn.addEventListener('click', () => deleteDebt(d.id, d.name));
    return tr;
}

function renderDebtGrid(model) {
    const body = $('debtGridBody');
    const empty = $('debtGridEmpty');
    if (!body) return;
    body.replaceChildren();
    const items = model ? model.items : [];
    if (empty) empty.hidden = items.length > 0;
    items.forEach(it => body.append(buildDebtRow(it)));
}

function renderDebtSummary(model) {
    const box = $('debtSummaryGrid');
    if (!box) return;
    if (!model || !model.items.length) { box.replaceChildren(); return; }
    const items = model.items;
    const total = items.reduce((t, i) => t + i.balance, 0);
    const interest = items
        .filter(i => !i.isMortgage)
        .reduce((t, i) => t + i.interest, 0);
    const scheduled = items.reduce((t, i) => t + i.scheduled, 0);
    const budgeted = items.filter(i => i.d.in_budget).reduce((t, i) => t + i.scheduled, 0);
    const nonMortgage = items.filter(i => !i.isMortgage);

    const nonMortgageTotal =
        nonMortgage.reduce((t, i) => t + i.balance, 0);

    const wApr =
        nonMortgageTotal > 0
            ? nonMortgage.reduce(
            (t, i) => t + i.rateNow * i.balance,
            0
        ) / nonMortgageTotal
            : 0;

    renderSummaryCards(box, [
        { label: 'Total Debt', value: fmt$(total), unit: '', foot: `${items.length} debt${items.length === 1 ? '' : 's'} &middot; snapshot ${fmtYm(model.month)}` },
        { label: 'Consumer Debt Interest This Month', value: fmt$(interest), foot: `${fmt$(interest * 12)}/yr · weighted APR ${wApr.toFixed(2)}%` },
        { label: 'Scheduled Payments', value: fmt$(scheduled), foot: `${fmt$(scheduled - budgeted)}/mo not in the Budget &middot; ${fmt$(budgeted)}/mo already in the Budget` }
    ]);
}

// ------------------------------------------------------- mortgage section
function fillRowSelect(select, selectedId) {
    select.replaceChildren();
    const blank = el('option', '— none —');
    blank.value = '';
    select.append(blank);
    (deps.getBankRows() || []).forEach(row => {
        const o = el('option', `${row.category || 'Untitled'} (${fmt$(num(row.monthly_spend))}/mo)`);
        o.value = row.id;
        select.append(o);
    });
    const match = (deps.getBankRows() || []).find(row => sameId(row.id, selectedId));
    select.value = match ? String(match.id) : '';
}

function buildLoanCard(it) {
    const { d, s, mort } = it;
    const card = cloneEl('tpl-mortgage-card');
    const r = refs(card);
    const isMortgage = d.kind === 'mortgage';
    ['principal', 'term', 'origin', 'firstPay', 'payRow', 'pmiRow', 'homeValue', 'ltv'].forEach(k => { r[k].dataset.fk = `${d.id}:m:${k}`; });

    r.title.textContent = d.name;
    r.principal.value = d.original_principal ?? '';
    r.term.value = d.term_months ?? '';
    r.origin.value = d.origination_date ? String(d.origination_date).slice(0, 10) : '';
    r.firstPay.value = isYm(d.first_payment_month) ? d.first_payment_month : '';
    r.firstPay.placeholder = mort.first || '';
    r.homeValue.value = d.home_value ?? '';
    r.ltv.value = d.target_ltv ?? 79;
    fillRowSelect(r.payRow, d.payment_row_id);

    r.principal.addEventListener('change', () => updateDebt(d.id, { original_principal: numOrNull(r.principal.value) }));
    r.term.addEventListener('change', () => updateDebt(d.id, { term_months: r.term.value ? Math.round(num(r.term.value)) : null }));
    r.origin.addEventListener('change', () => updateDebt(d.id, { origination_date: r.origin.value || null }));
    r.firstPay.addEventListener('change', () => updateDebt(d.id, { first_payment_month: isYm(r.firstPay.value) ? r.firstPay.value : null }));
    r.payRow.addEventListener('change', () => updateDebt(d.id, { payment_row_id: r.payRow.value || null }));

    r.pmiRowWrap.hidden = !isMortgage;
    r.homeValueWrap.hidden = !isMortgage;
    r.ltvWrap.hidden = !isMortgage;

    if (isMortgage) {
        fillRowSelect(r.pmiRow, d.pmi_row_id);

        r.pmiRow.addEventListener('change', () =>
            updateDebt(d.id, { pmi_row_id: r.pmiRow.value || null }));

        r.homeValue.addEventListener('change', () =>
            updateDebt(d.id, { home_value: numOrNull(r.homeValue.value) }));

        r.ltv.addEventListener('change', () =>
            updateDebt(d.id, { target_ltv: num(r.ltv.value) || 79 }));
    }

    // --- read-outs
    const payRowAmt = (deps.getBankRows() || []).filter(b => sameId(b.id, d.payment_row_id)).reduce((t, b) => t + num(b.monthly_spend), 0);
    const escrow = payRowAmt > 0 && mort.pi > 0 ? Math.max(0, payRowAmt - mort.pi) : 0;
    const sched = mort.rows ? scheduledBalanceAt(mort.rows, mort.principal, it.s.month) : null;
    const need = it.targetBalance > 0 ? Math.max(0, it.balance - it.targetBalance) : 0;
    const targetRow = it.targetBalance > 0 && mort.rows ? mort.rows.find(row => row.balance <= it.targetBalance + 0.005) : null;

    const cards = [
        {
            label: 'Principal & Interest',
            value: fmt$(mort.pi),
            foot: payRowAmt > 0
                ? `Budget row ${fmt$(payRowAmt)} → about ${fmt$(escrow)}/mo escrow or other`
                : 'Pick the Budget row to compare against'
        },
        {
            label: 'Balance vs. Schedule',
            value: fmt$(it.balance),
            unit: '',
            foot: sched == null
                ? 'Add the loan details to see the schedule'
                : `Scheduled ${fmt$(sched)} · ${
                    it.balance > sched + 1
                        ? fmt$(it.balance - sched) + ' behind'
                        : it.balance < sched - 1
                            ? fmt$(sched - it.balance) + ' ahead'
                            : 'on schedule'
                }`
        }
    ];

    if (isMortgage) {
        cards.push(
            {
                label: `PMI Target (${it.ltv}% of value)`,
                unit: '',
                value: it.targetBalance > 0
                    ? fmt$(it.targetBalance)
                    : '—',
                statusClass:
                    it.targetBalance > 0 && need === 0
                        ? 'surplus'
                        : '',
                foot: it.targetBalance > 0
                    ? (
                        need > 0
                            ? `${fmt$(need)} more principal needed · LTV now ${((it.balance / it.homeValue) * 100).toFixed(1)}%`
                            : 'Target reached'
                    )
                    : 'Enter the home value'
            },
            {
                label: 'PMI',
                value: fmt$(it.pmiRowAmount),
                foot: targetRow
                    ? `Target reached on the normal schedule by ${fmtYm(targetRow.ym)}`
                    : (
                        it.pmiRowAmount > 0
                            ? 'Pick the Budget row and loan details'
                            : 'Pick the Budget row that holds PMI'
                    )
            }
        );
    }

    renderSummaryCards(r.summary, cards);

    // --- amortization schedule (original terms, no extra payments)
    if (mort.rows) {
        const frag = document.createDocumentFragment();
        mort.rows.forEach(row => {
            const tr = document.createElement('tr');
            if (row.ym === it.s.month) tr.className = 'debt-row-hl';
            tr.append(el('td', String(row.n)), el('td', fmtYm(row.ym)));
            ['payment', 'interest', 'principal', 'balance'].forEach(k => tr.append(el('td', fmt$(row[k]), 'col-num')));
            if (targetRow && row.n === targetRow.n) {
                tr.className = 'debt-row-hl';
                tr.children[1].textContent += ' — PMI target';
            }
            frag.append(tr);
        });
        r.scheduleBody.replaceChildren(frag);
    } else {
        r.scheduleWrap.hidden = true;
        r.scheduleEmpty.hidden = false;
    }
    return card;
}

function renderLoanCards(model) {
    const box = $('mortgageCards');
    if (!box) return;
    box.replaceChildren(...(model ? model.items
        .filter(i =>
            i.d.kind === 'mortgage' ||
            i.d.kind === 'loan'
        )
        .map(buildLoanCard) : []));
}

// ------------------------------------------------------ money available
function renderMoney(model) {
    const net = num(deps.getNetBalance());
    const netEl = $('debtNetBalance');
    if (netEl) netEl.textContent = `${fmt$(net)}/mo`;
    const strat = $('debtStrategySelect');
    if (strat) strat.value = settings.strategy;

    const mode = $('debtMoneyMode');
    const amt = $('debtMoneyAmount');
    const label = $('debtMoneyLabel');
    const note = $('debtMoneyNote');
    if (!mode || !amt) return;

    if (!model) {
        mode.disabled = true;
        amt.disabled = true;
        if (label) label.textContent = 'Add a debt to set the money available';
        if (note) note.textContent = '';
        return;
    }

    const own = moneyRows.find(r => r.month === model.month);
    const eff = moneyFor(addMonths(model.month, 1));
    mode.disabled = false;
    amt.disabled = false;
    mode.value = eff == null ? 'default' : 'fixed';
    const picker = amt.closest('.picker');
    if (picker) picker.hidden = eff == null;
    if (document.activeElement !== amt) amt.value = eff == null ? '' : eff;
    if (label) label.textContent = `From the ${fmtYm(model.month)} snapshot forward`;
    if (note) {
        note.textContent = own
            ? 'Saved on this snapshot. It applies to every later month until a later snapshot changes it.'
            : eff == null
                ? 'Nothing is set yet, so the Budget Net Balance is used.'
                : 'Inherited from an earlier snapshot. Change it here to reset it from this month on.';
    }
}

// ---------------------------------------------------------------- results
function datesText(result, kind) {
    if (kind === 'pmi') {
        if (!result.hasPmi) return '—';
        if (result.pmiAlreadyMet) return 'Already met';
        return result.pmiFreeYm ? fmtYm(result.pmiFreeYm) : 'Not reached';
    }
    if (kind === 'consumer') {
        if (!result.consumerCount) return '—';
        return result.consumerFreeYm ? fmtYm(result.consumerFreeYm) : `Not within ${MAX_MONTHS / 12} yrs`;
    }
    return result.debtFreeYm ? fmtYm(result.debtFreeYm) : `Not within ${MAX_MONTHS / 12} yrs`;
}

function renderResults(model) {
    const scenBody = $('debtScenarioBody');
    const dates = $('debtDatesGrid');
    const warn = $('debtWarnings');
    const planSel = $('debtPlanSelect');
    const resultsEmpty = $('debtResultsEmpty');
    const resultsWrap = $('debtResultsWrap');
    if (!scenBody) return;

    const hasData = !!(model && model.items.some(i => i.balance > 0));
    if (resultsEmpty) resultsEmpty.hidden = hasData;
    if (resultsWrap) resultsWrap.hidden = !hasData;
    scenBody.replaceChildren();
    warn.replaceChildren();
    if (!hasData) { dates.replaceChildren(); $('debtPlanHead').replaceChildren(); $('debtPlanBody').replaceChildren(); return; }

    model.warnings.forEach(w => warn.append(el('p', w, 'form-error')));

    // scenario comparison
    const minCost = model.scenarios[0].result.totalCost;
    model.scenarios.forEach(sc => {
        const res = sc.result;
        const tr = document.createElement('tr');
        tr.append(
            el('td', sc.label),
            el('td', datesText(res, 'pmi')),
            el('td', datesText(res, 'consumer')),
            el('td', datesText(res, 'debt')),
            el('td', fmt$(res.totalInterest), 'col-num'),
            el('td', res.hasPmi ? fmt$(res.totalPmi) : '—', 'col-num'),
            el('td', fmt$(res.totalCost), 'col-num'),
            el('td', sc.key === 'min' ? '—' : fmt$(minCost - res.totalCost), 'col-num')
        );
        scenBody.append(tr);
    });

    // plan picker
    planSel.replaceChildren();
    model.scenarios.forEach(sc => {
        const o = el('option', sc.label);
        o.value = sc.key;
        planSel.append(o);
    });
    planSel.value = planKey;

    const sc = model.scenarios.find(x => x.key === planKey) || model.scenarios[1];
    const res = sc.result;
    const first = res.rows[0];
    const extraNow = first ? Object.values(first.pay).reduce((t, p) => t + p.extra, 0) : 0;

    renderSummaryCards(dates, [
        { label: 'PMI Drops', value: datesText(res, 'pmi'), unit: '', foot: res.hasPmi ? 'First month without PMI' : 'No PMI modelled' },
        { label: 'Consumer Debt-Free', value: datesText(res, 'consumer'), unit: '', foot: 'Cards and loans, excluding the mortgage' },
        { label: 'Fully Debt-Free', value: datesText(res, 'debt'), unit: '', statusClass: res.debtFreeYm ? 'best' : '', foot: res.completed ? `${res.months} months from the snapshot` : 'Increase the money available or payments' },
        {
            label: 'Extra Next Month', value: sc.key === 'min' ? '—' : fmt$(extraNow),
            foot: sc.key === 'min' ? 'Minimums only applies no extra money' : `${fmt$(first?.available ?? 0)} available &minus; regular payments not in the Budget`
        }
    ]);

    renderPlanTable(model, res, sc.key === 'min');
}

function renderPlanTable(model, res, isMinOnly) {
    const head = $('debtPlanHead');
    const body = $('debtPlanBody');
    head.replaceChildren();
    body.replaceChildren();

    const debts = model.engineDebts.filter(d => res.debts.some(x => x.id === d.id));
    const cols = ['Month', 'Money Available', 'Extra Applied To', 'Interest', 'Total Balance', ...debts.map(d => d.name), 'Notes'];
    const tr = document.createElement('tr');
    cols.forEach((c, i) => tr.append(el('th', c, i === 0 || i === 2 || i === cols.length - 1 ? '' : 'col-num')));
    head.append(tr);

    const nameOf = Object.fromEntries(debts.map(d => [d.id, d.name]));
    const frag = document.createDocumentFragment();
    res.rows.forEach(row => {
        const extras = Object.entries(row.pay).filter(([, p]) => p.extra > 0.005).map(([id, p]) => `${nameOf[id]} ${fmt$(p.extra)}`);
        const notes = [...row.events];
        if (row.shortfall > 0.005) notes.push(`short ${fmt$(row.shortfall)}`);
        const line = document.createElement('tr');
        line.append(
            el('td', fmtYm(row.ym)),
            el('td', row.available == null ? '—' : fmt$(row.available), 'col-num'),
            el('td', isMinOnly ? '—' : (extras.join(' · ') || '—')),
            el('td', fmt$(row.interest), 'col-num'),
            el('td', fmt$(row.totalBalance), 'col-num')
        );
        debts.forEach(d => line.append(el('td', row.balances[d.id] > 0.005 ? fmt$(row.balances[d.id]) : '✓', 'col-num')));
        line.append(el('td', notes.join(' · '), 'form-note'));
        if (row.events.length) line.className = 'debt-row-hl';
        frag.append(line);
    });
    body.append(frag);
}

// ------------------------------------------------------------------- init
export function initDebts(d) {
    deps = { ...deps, ...d };

    $('debtMonthSelect')?.addEventListener('change', e => { selectedMonth = e.target.value || null; renderDebts(); });
    $('debtNewSnapshotBtn')?.addEventListener('click', () => createSnapshot($('debtNewMonth').value));
    $('debtDeleteMonthBtn')?.addEventListener('click', () => deleteMonth(resolveMonth()));
    $('debtStrategySelect')?.addEventListener('change', e => saveStrategy(e.target.value));
    $('debtPlanSelect')?.addEventListener('change', e => { planKey = e.target.value; renderDebts(); });

    const addBtn = $('addDebtBtn');
    if (addBtn) {
        const submit = () => {
            const name = $('newDebtName').value.trim();
            if (!name) { status('Debt name is required.'); return; }
            addDebt({ name, kind: $('newDebtKind').value, balance: num($('newDebtBalance').value), apr: num($('newDebtApr').value) });
            ['newDebtName', 'newDebtBalance', 'newDebtApr'].forEach(id => { $(id).value = ''; });
            $('newDebtKind').value = 'card';
            $('newDebtName').focus();
        };
        addBtn.addEventListener('click', submit);
        ['newDebtName', 'newDebtBalance', 'newDebtApr'].forEach(id => {
            $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        });
    }

    const moneyMode = $('debtMoneyMode');
    const moneyAmount = $('debtMoneyAmount');
    if (moneyMode && moneyAmount) {
        moneyMode.addEventListener('change', () => {
            const month = resolveMonth();
            if (!month) return;
            if (moneyMode.value === 'default') saveMoney(month, null);
            else saveMoney(month, numOrNull(moneyAmount.value) ?? Math.max(0, Math.round(num(deps.getNetBalance()))));
        });
        moneyAmount.addEventListener('change', () => {
            const month = resolveMonth();
            const amount = numOrNull(moneyAmount.value);
            if (month && amount != null) saveMoney(month, Math.max(0, amount));
        });
        moneyAmount.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); moneyAmount.blur(); } });
    }
}
