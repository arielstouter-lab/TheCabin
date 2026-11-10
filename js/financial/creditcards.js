import { cloneEl, refs } from '../shared/dom.js';
import { buildCategoryRow } from './category-row.js';
import { initDebts, loadDebtData, renderDebts } from './debts.js';
import { addMonths, isYm } from './debt-engine-v2.js';
import { initTracker, loadTrackerData, renderTracker, TRACKER_TABLE } from './tracker.js';
import { fmt$, setStatus, captureDetailsState, restoreDetailsState } from '../shared/ui.js';
import { initCardUsage, loadCardUsageData, renderCardUsage, CARD_USAGE_TABLE } from './card-usage.js';
import { supabase as sb } from '../shared/supabase.js';
import { TABLES } from '../shared/database-config.js';
import { writeOrQueue, nowStamp, initSync, withTimeout } from '../shared/sync.js';
import { initAppPage } from '../shared/auth.js';

const CATEGORIES_TABLE = TABLES.CATEGORIES;
const CARDS_TABLE = TABLES.CREDIT_CARDS;
const REWARDS_TABLE = TABLES.CARD_REWARDS;
const TAX_TABLE = TABLES.INCOME_TAX;
const BUDGET_SNAPSHOT_TABLE = TABLES.BUDGET_SNAPSHOTS;
const CACHE_KEY = 'thecabin_financial_cache';
const LOAD_TIMEOUT_MS = 6000;

const REWARD_OVERRIDES_KEY = 'thecabin_card_reward_overrides';

// The two cards the Budget tab is split across. Rows are tagged with the slot's
// account_type (Card 1 keeps the original 'credit_cards' rows). `match` is tested
// against the card names on the Credit Card Comparison tab to find each card's
// reward rates; change these to switch cards.
const CARD_SLOTS = [
    { key: 'card1', accountType: 'credit_cards', label: 'Amex BCP', match: /bcp|blue cash/i },
    { key: 'card2', accountType: 'credit_cards_2', label: 'Capital One Quicksilver', match: /quicksilver/i }
];
const isCardRow = r => CARD_SLOTS.some(slot => slot.accountType === r.account_type);

const COL_CAT_ID = 'id';
const COL_CAT_CATEGORY = 'category';
const COL_CAT_FREQUENCY = 'frequency';
const COL_CAT_AMOUNT = 'amount';
const COL_CAT_MONTHLY_SPEND = 'monthly_spend';
const COL_CAT_ACCOUNT_TYPE = 'account_type';
const COL_CAT_TYPE = 'type';
const COL_CAT_PROPERTY = 'property';
const COL_CAT_NOTES = 'notes';
const COL_CAT_CREATED_AT = 'created_at';

const COL_CARD_ID = 'id';
const COL_CARD_CREATED_AT = 'created_at';
const COL_REWARD_ID = 'id';
const COL_REWARD_CREATED_AT = 'created_at';

const COL_TAX_ID = 'id';
const COL_TAX_STREAM = 'income_stream';
const COL_TAX_RATE = 'tax_rate';
const COL_TAX_DEPRECIATION = 'depreciation';
const COL_TAX_MORTGAGE_INTEREST = 'mortgage_interest';

const RENTAL_PROPERTIES = ['San Jacinto', 'County Line'];

// Unified store for every row in income_expense_categories — credit card
// spend, bank spend, income, and rental (income + spending) all live here,
// distinguished by account_type/type/property.
let categoryRows = [];
let cardsRows = [];
let rewardRows = [];
let taxRows = [];
let budgetSnapshotRows = [];
let selectedProjectionMonth = null;

// Manual monthly rewards per card slot ('card1' / 'card2'). A slot with no entry
// uses the auto-calculated rewards. Stored on this device only.
let rewardOverrides = loadRewardOverrides();

function loadRewardOverrides() {
    try {
        const o = JSON.parse(localStorage.getItem(REWARD_OVERRIDES_KEY));
        return o && typeof o === 'object' ? o : {};
    } catch (e) {
        return {};
    }
}

function saveRewardOverrides() {
    try { localStorage.setItem(REWARD_OVERRIDES_KEY, JSON.stringify(rewardOverrides)); } catch (e) {}
}

let realtimeChannel = null;
let realtimeDebounceTimer = null;

// -------------------------------------------------------------------
// Calculation Helpers
// -------------------------------------------------------------------
function computeMonthlySpend(amount, frequency) {
    const val = parseFloat(amount) || 0;
    switch (String(frequency || 'monthly').toLowerCase()) {
        case 'semimonthly': return val * 2;
        case 'biweekly': return (val * 26) / 12;
        case 'annual': return val / 12;
        default: return val;
    }
}

// -------------------------------------------------------------------
// Unified category-row normalization + derived views
// -------------------------------------------------------------------
function normalizeCategoryRow(r) {
    const frequency = r[COL_CAT_FREQUENCY] || 'monthly';
    const amount = r[COL_CAT_AMOUNT] !== undefined && r[COL_CAT_AMOUNT] !== null ? r[COL_CAT_AMOUNT] : (r[COL_CAT_MONTHLY_SPEND] ?? 0);
    const monthly_spend = parseFloat(r[COL_CAT_MONTHLY_SPEND] ?? r.monthly_spend ?? amount) || 0;
    const notes = r[COL_CAT_NOTES] || '';

    const acc = String(r[COL_CAT_ACCOUNT_TYPE] || '').toLowerCase();
    const flow = String(r[COL_CAT_TYPE] || '').toLowerCase();
    const isRental = acc === 'rental' || acc === 'rentals' || Boolean(r[COL_CAT_PROPERTY]);

    if (isRental) {
        const property = r[COL_CAT_PROPERTY] || 'San Jacinto';
        const isIncome = flow === 'income' || (r[COL_CAT_CATEGORY] && r[COL_CAT_CATEGORY].trim().toLowerCase() === 'rent');
        return { ...r, property, category: r[COL_CAT_CATEGORY] || (isIncome ? 'Rent' : 'Expense'), frequency, amount, notes, monthly_spend, account_type: 'rental', type: isIncome ? 'income' : 'spending' };
    }
    if (acc === 'income' || flow === 'income') {
        return { ...r, category: r[COL_CAT_CATEGORY] || '', frequency, amount, notes, monthly_spend, account_type: 'income', type: 'income' };
    }
    if (acc === 'bank') {
        return { ...r, category: r[COL_CAT_CATEGORY] || '', frequency, amount, notes, monthly_spend, account_type: 'bank', type: 'spending' };
    }
    if (acc === 'credit_cards_2') {
        return { ...r, category: r[COL_CAT_CATEGORY] || '', frequency, amount, notes, monthly_spend, account_type: 'credit_cards_2', type: 'spending' };
    }
    return { ...r, category: r[COL_CAT_CATEGORY] || '', frequency, amount, notes, monthly_spend, account_type: 'credit_cards', type: 'spending' };
}

const spendRows = () => categoryRows.filter(isCardRow); // both cards' rows
const bankSpendRows = () => categoryRows.filter(r => r.account_type === 'bank');
const incomeRows = () => categoryRows.filter(r => r.account_type === 'income');
const getRentalIncomeRow = property => categoryRows.find(r => r.account_type === 'rental' && r.property === property && r.type === 'income');
const getRentalExpenseRows = property => categoryRows.filter(r => r.account_type === 'rental' && r.property === property && r.type === 'spending');

// -------------------------------------------------------------------
// Budget Totals Calculations
// -------------------------------------------------------------------
// rentalNets (optional): { [property]: netMonthly } overrides the live
// rental profit calculation (used by the Budget Projection tab).
// cardRewards (optional): total monthly card rewards, subtracted from spending.
function computeBudgetTotals(rows, rentalNets = null, cardRewards = 0) {
    const cc = rows.filter(isCardRow);
    const bank = rows.filter(r => r.account_type === 'bank');
    const inc = rows.filter(r => r.account_type === 'income');

    const totalCcSpend = cc.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalBankSpend = bank.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalSpendingGross = totalCcSpend + totalBankSpend;
    const totalSpending = totalSpendingGross - cardRewards;
    const regularIncome = inc.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const rentalProfits = RENTAL_PROPERTIES.reduce(
        (sum, prop) => sum + (rentalNets ? (rentalNets[prop] || 0) : getRentalProfit(prop)),
        0
    );
    const totalIncome = regularIncome + rentalProfits;
    const netBalance = totalIncome - totalSpending;

    return {
        income: inc,
        totalCcSpend,
        totalBankSpend,
        totalSpendingGross,
        cardRewards,
        totalSpending,
        regularIncome,
        rentalProfits,
        totalIncome,
        netBalance
    };
}

function getBudgetTotals() {
    const split = computeCardSplit();
    return { ...computeBudgetTotals(categoryRows, null, split.rewards), split };
}

// -------------------------------------------------------------------
// Generic category-row CRUD
// -------------------------------------------------------------------
async function addCategoryRow(fields, tag) {
    const frequency = fields.frequency || 'monthly';
    const amount = fields.amount || 0;
    const monthly_spend = computeMonthlySpend(amount, frequency);
    const id = crypto.randomUUID();
    const payload = {
        [COL_CAT_ID]: id,
        [COL_CAT_CATEGORY]: fields.category,
        [COL_CAT_FREQUENCY]: frequency,
        [COL_CAT_AMOUNT]: amount,
        [COL_CAT_NOTES]: fields.notes || '',
        [COL_CAT_MONTHLY_SPEND]: monthly_spend,
        [COL_CAT_ACCOUNT_TYPE]: tag.account_type,
        [COL_CAT_TYPE]: tag.type,
        ...(tag.property ? { [COL_CAT_PROPERTY]: tag.property } : {}),
        created_at: nowStamp()
    };
    categoryRows.push(normalizeCategoryRow(payload));
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: CATEGORIES_TABLE,
        type: 'insert',
        id,
        payload
    });
    setStatus(tag.addedMessage || 'Added.');
    return true;
}

async function updateCategoryRow(id, patch) {
    const row = categoryRows.find(r => r.id === id);
    if (row) {
        Object.assign(row, patch);
        row.monthly_spend = computeMonthlySpend(row.amount, row.frequency);
    }
    render();
    saveToLocalCache();
    const payload = { ...patch };
    if (row) {
        payload[COL_CAT_FREQUENCY] = row.frequency;
        payload[COL_CAT_AMOUNT] = row.amount;
        payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
        if (row.notes !== undefined) payload[COL_CAT_NOTES] = row.notes;
    }
    writeOrQueue(sb, {
        table: CATEGORIES_TABLE,
        type: 'update',
        id,
        idColumn: COL_CAT_ID,
        payload: { ...payload, updated_at: nowStamp() }
    });
    return true;
}

async function deleteCategoryRow(id, message) {
    categoryRows = categoryRows.filter(r => r.id !== id);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: CATEGORIES_TABLE,
        type: 'delete',
        id,
        idColumn: COL_CAT_ID
    });
    setStatus(message || 'Deleted.');
    return true;
}

async function setRentalRent(propertyName, rentAmount) {
    const val = parseFloat(rentAmount) || 0;
    const existing = getRentalIncomeRow(propertyName);
    const ok = existing
        ? await updateCategoryRow(existing.id, { amount: val })
        : await addCategoryRow({ category: 'Rent', frequency: 'monthly', amount: val, notes: '' }, { account_type: 'rental', type: 'income', property: propertyName });
    if (ok) { setStatus(`Updated rent for ${propertyName}.`); }
}

// -------------------------------------------------------------------
// Budget Projections (Snapshots)
// -------------------------------------------------------------------
function thisYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeYm(ym) {
    return String(ym || '').trim().replace('/', '-');
}

function fmtYm(ym) {
    if (!ym) return '—';
    const cleanYm = normalizeYm(ym);
    if (!isYm(cleanYm)) return ym;
    const [y, m] = cleanYm.split('-').map(Number);
    const date = new Date(y, m - 1, 1);
    return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function projectionMonths() {
    const rawMonths = budgetSnapshotRows.map(x => normalizeYm(x.month)).filter(Boolean);
    const set = new Set(rawMonths);
    set.add(thisYm());
    return [...set].sort().reverse();
}

function resolveProjectionMonth() {
    const months = projectionMonths();
    if (selectedProjectionMonth && months.includes(selectedProjectionMonth)) {
        return selectedProjectionMonth;
    }
    selectedProjectionMonth = months.includes(thisYm()) ? thisYm() : (months[0] || thisYm());
    return selectedProjectionMonth;
}

function monthHasSnapshots(month) {
    const m = normalizeYm(month);
    return budgetSnapshotRows.some(x => normalizeYm(x.month) === m);
}

// A month with no snapshot yet shows the live Budget rows. Once a month has a
// snapshot, it contains exactly the rows that have a snapshot entry, so a row
// deleted from the projection stays gone (and stays gone when copied forward).
function getProjectedRows(month) {
    const targetMonth = normalizeYm(month || resolveProjectionMonth());
    const hasSnapshots = monthHasSnapshots(targetMonth);
    const out = [];

    categoryRows.forEach(row => {
        const snapshot = budgetSnapshotRows.find(x =>
            String(x.category_id) === String(row.id) && normalizeYm(x.month) === targetMonth
        );
        if (!snapshot) {
            if (!hasSnapshots) out.push(row);
            return;
        }
        out.push({
            ...row,
            amount: snapshot.amount,
            monthly_spend: computeMonthlySpend(snapshot.amount, row.frequency)
        });
    });

    return out;
}

// Projected rental net per property. The net is stored in the snapshot row
// belonging to the property's Rent row (so in projections, that row's
// `amount` means "net", not rent). A month with no snapshot falls back to
// the live calculated profit from the Rentals tab.
function getProjectedRentalNet(property, month) {
    const rent = getRentalIncomeRow(property);
    if (!rent) return 0;
    const targetMonth = normalizeYm(month);
    const snap = budgetSnapshotRows.find(x =>
        String(x.category_id) === String(rent.id) && normalizeYm(x.month) === targetMonth
    );
    if (!snap && monthHasSnapshots(targetMonth)) return null; // deleted from this projection
    const net = snap ? (parseFloat(snap.amount) || 0) : getRentalProfit(property);
    return Math.round(net * 100) / 100;
}

function getProjectedRentalNets(month) {
    return Object.fromEntries(RENTAL_PROPERTIES.map(p => [p, getProjectedRentalNet(p, month)]));
}

// Rows to store for targetMonth, copied from srcMonth. Rental expense rows are
// not part of projections; the rental Rent row carries the property's projected
// net instead. Rows deleted from srcMonth are not copied.
function buildSnapshotPayload(srcMonth, targetMonth) {
    const nets = getProjectedRentalNets(srcMonth);
    return getProjectedRows(srcMonth)
        .filter(row => !(row.account_type === 'rental' && row.type === 'spending'))
        .filter(row => !(row.account_type === 'rental' && row.type === 'income' && nets[row.property] == null))
        .map(row => ({
            category_id: row.id,
            month: targetMonth,
            amount: (row.account_type === 'rental' && row.type === 'income')
                ? nets[row.property]
                : row.amount
        }));
}

// Turns a month that is still showing live Budget rows into a real snapshot,
// so that editing or deleting one row doesn't make the rest disappear.
async function materializeSnapshot(month) {
    const norm = normalizeYm(month);
    const rows = buildSnapshotPayload(norm, norm);
    if (!rows.length) return true;
    const items = rows.map(r => ({
        id: crypto.randomUUID(),
        ...r,
        created_at: nowStamp()
    }));
    budgetSnapshotRows = budgetSnapshotRows.filter(r => normalizeYm(r.month) !== norm);
    budgetSnapshotRows.push(...items);
    renderProjection();
    saveToLocalCache();

    items.forEach(item => {
        writeOrQueue(sb, {
            table: BUDGET_SNAPSHOT_TABLE,
            type: 'upsert',
            id: `${item.category_id}_${norm}`,
            payload: item,
            options: { onConflict: 'category_id,month' }
        });
    });
    return true;
}

async function createBudgetSnapshot(month) {
    if (!month) return;
    const normMonth = normalizeYm(month);
    if (!isYm(normMonth)) {
        setStatus('Pick a valid month (YYYY-MM).');
        return;
    }

    const rows = buildSnapshotPayload(resolveProjectionMonth(), normMonth);
    const items = rows.map(r => ({
        id: crypto.randomUUID(),
        ...r,
        created_at: nowStamp()
    }));
    budgetSnapshotRows = budgetSnapshotRows.filter(r => normalizeYm(r.month) !== normMonth);
    budgetSnapshotRows.push(...items);
    selectedProjectionMonth = normMonth;
    renderProjection();
    saveToLocalCache();

    items.forEach(item => {
        writeOrQueue(sb, {
            table: BUDGET_SNAPSHOT_TABLE,
            type: 'upsert',
            id: `${item.category_id}_${normMonth}`,
            payload: item,
            options: { onConflict: 'category_id,month' }
        });
    });
    setStatus(`Created projection for ${fmtYm(normMonth)}.`);
}

async function updateBudgetSnapshotRow(categoryId, rawPatch) {
    // The snapshot table only stores an amount per category + month.
    if (!rawPatch || !('amount' in rawPatch)) return false;
    const patch = { amount: rawPatch.amount };

    const month = resolveProjectionMonth();
    if (!month) return false;

    if (!monthHasSnapshots(month)) await materializeSnapshot(month);

    let row = budgetSnapshotRows.find(x => String(x.category_id) === String(categoryId) && normalizeYm(x.month) === month);

    if (!row) {
        const sourceRow = categoryRows.find(r => String(r.id) === String(categoryId));
        const id = crypto.randomUUID();
        row = {
            id,
            category_id: categoryId,
            month: month,
            amount: patch.amount ?? sourceRow?.amount ?? 0,
            created_at: nowStamp()
        };
        budgetSnapshotRows.push(row);
    }

    Object.assign(row, patch);
    renderProjection();
    saveToLocalCache();

    writeOrQueue(sb, {
        table: BUDGET_SNAPSHOT_TABLE,
        type: 'upsert',
        id: `${row.category_id}_${month}`,
        payload: { ...row, updated_at: nowStamp() },
        options: { onConflict: 'category_id,month' }
    });
    return true;
}

// Removes one row (a category, or a property's rental net) from the selected
// month's projection. The live Budget row is not touched.
async function deleteBudgetSnapshotRow(categoryId) {
    const month = resolveProjectionMonth();
    if (!month) return false;

    if (!monthHasSnapshots(month)) await materializeSnapshot(month);

    const row = budgetSnapshotRows.find(x =>
        String(x.category_id) === String(categoryId) && normalizeYm(x.month) === month
    );
    if (!row) return false;

    budgetSnapshotRows = budgetSnapshotRows.filter(x => x !== row);
    renderProjection();
    saveToLocalCache();

    writeOrQueue(sb, {
        table: BUDGET_SNAPSHOT_TABLE,
        type: 'delete',
        id: row.id
    });
    setStatus('Removed row from projection.');
    return true;
}

async function deleteBudgetSnapshot(month) {
    if (!month) return;
    if (!confirm(`Delete the budget projection for ${fmtYm(month)}?`)) return;

    const normMonth = normalizeYm(month);
    const slashMonth = normMonth.replace('-', '/');
    const rowsToDelete = budgetSnapshotRows.filter(r => normalizeYm(r.month) === normMonth || r.month === slashMonth);

    budgetSnapshotRows = budgetSnapshotRows.filter(r => normalizeYm(r.month) !== normMonth && r.month !== slashMonth);
    selectedProjectionMonth = null;
    renderProjection();
    saveToLocalCache();

    rowsToDelete.forEach(r => {
        writeOrQueue(sb, {
            table: BUDGET_SNAPSHOT_TABLE,
            type: 'delete',
            id: r.id
        });
    });
    setStatus('Deleted projection snapshot.');
}


// -------------------------------------------------------------------
// Category Grid Renderer (declarative by [data-account-type])
// -------------------------------------------------------------------
function renderTabGrids(containerEl, rows, { onUpdate, onDelete, isProjection = false, rentalNets = null } = {}) {
    if (!containerEl) return;
    containerEl.querySelectorAll('[data-account-type]').forEach(card => {
        const type = card.dataset.accountType;
        const body = card.querySelector('[data-ref="gridBody"]') || card.querySelector('tbody');
        const empty = card.querySelector('[data-ref="gridEmpty"]') || card.querySelector('.empty-state');
        if (!body) return;

        const sectionRows = rows.filter(r => r.account_type === type);
        const extraRows = (type === 'income')
            ? RENTAL_PROPERTIES.map(p => {
                if (!isProjection || !rentalNets) return buildRentalIncomeRow(p, getRentalProfit(p));

                // Projection: one editable "rental net" row per property. It is
                // backed by the snapshot row of the property's Rent row.
                const rent = getRentalIncomeRow(p);
                if (!rent) return buildRentalIncomeRow(p, 0);
                const net = rentalNets[p];
                if (net == null) return null; // removed from this projection
                return buildCategoryRow(
                    { ...rent, category: `${p} rental net`, frequency: 'monthly', amount: net, monthly_spend: net, notes: '' },
                    { onUpdate, onDelete: onDelete ? () => onDelete(rent.id) : () => {}, deleteTitle: 'Remove from projection' }
                );
            }).filter(Boolean)
            : [];

        body.replaceChildren();
        if (empty) empty.hidden = (sectionRows.length + extraRows.length) > 0;

        const deleteTitle = isProjection ? 'Remove from projection' : (type === 'income' ? 'Delete income source' : (type === 'bank' ? 'Delete expense' : 'Delete category'));
        const deleteMsg = type === 'income' ? 'Deleted income source.' : (type === 'bank' ? 'Deleted bank expense.' : 'Deleted category.');

        sectionRows.forEach(row => {
            body.append(buildCategoryRow(row, {
                onUpdate,
                onDelete: onDelete ? () => onDelete(row.id, deleteMsg) : () => {},
                deleteTitle
            }));
        });

        extraRows.forEach(el => body.append(el));
    });
}

// -------------------------------------------------------------------
// Add-form wiring helper
// -------------------------------------------------------------------
function wireAddForm({ buttonId, fieldIds, requiredMessage, onAdd }) {
    const btn = document.getElementById(buttonId);
    if (!btn) return null;
    const els = {
        category: document.getElementById(fieldIds.category),
        frequency: document.getElementById(fieldIds.frequency),
        amount: document.getElementById(fieldIds.amount),
        notes: document.getElementById(fieldIds.notes)
    };

    function submit() {
        const value = {
            category: els.category ? els.category.value.trim() : '',
            frequency: els.frequency ? (els.frequency.value || 'monthly') : 'monthly',
            amount: els.amount ? (parseFloat(els.amount.value) || 0) : 0,
            notes: els.notes ? els.notes.value.trim() : ''
        };
        if (!value.category) {
            setStatus(requiredMessage);
            return;
        }
        onAdd(value);
        if (els.category) els.category.value = '';
        if (els.amount) els.amount.value = '';
        if (els.notes) els.notes.value = '';
        if (els.frequency) els.frequency.value = 'monthly';
        if (els.category) els.category.focus();
    }

    btn.addEventListener('click', submit);
    [els.category, els.amount, els.notes].forEach(el => {
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    });

    return btn;
}

// -------------------------------------------------------------------
// Row builders (page-specific — cards, rewards, rental income, compare)
// -------------------------------------------------------------------
function buildCardRow(row, { onUpdate, onDelete }) {
    const tr = cloneEl('tpl-card-row');
    const r = refs(tr);

    r.name.value = row.name || '';
    r.fee.value = row.annual_fee ?? 0;
    r.rate.value = row.base_rate ?? 0;

    r.name.addEventListener('change', () => onUpdate(row.id, { name: r.name.value }));
    r.fee.addEventListener('change', () => onUpdate(row.id, { annual_fee: parseFloat(r.fee.value) || 0 }));
    r.rate.addEventListener('change', () => onUpdate(row.id, { base_rate: parseFloat(r.rate.value) || 0 }));
    r.delBtn.addEventListener('click', () => onDelete(row.id));

    return tr;
}

function populateCardSelect(select, selectedId, placeholder = 'Choose a card…') {
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.append(blank);

    cardsRows.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.append(opt);
    });
    select.value = selectedId || '';
}

function buildRewardRow(row, { onUpdate, onDelete }) {
    const tr = cloneEl('tpl-reward-row');
    const r = refs(tr);

    populateCardSelect(r.card, row.card_id);
    r.category.value = row.category || '';
    r.rate.value = row.rate ?? 0;
    r.refund.value = row.special_refund ?? 0;

    r.card.addEventListener('change', () => onUpdate(row.id, { card_id: r.card.value }));
    r.category.addEventListener('change', () => onUpdate(row.id, { category: r.category.value }));
    r.rate.addEventListener('change', () => onUpdate(row.id, { rate: parseFloat(r.rate.value) || 0 }));
    r.refund.addEventListener('change', () => onUpdate(row.id, { special_refund: parseFloat(r.refund.value) || 0 }));
    r.delBtn.addEventListener('click', () => onDelete(row.id));

    return tr;
}

function buildRentalIncomeRow(property, profit) {
    const tr = cloneEl('tpl-rental-income-row');
    const r = refs(tr);
    const isProfit = profit >= 0;

    r.propName.textContent = property;
    r.chip.textContent = `Rental ${isProfit ? 'Profit' : 'Loss'}`;
    r.chip.dataset.kind = isProfit ? 'profit' : 'loss';
    r.profit1.textContent = fmt$(profit);
    r.profit2.textContent = fmt$(profit);
    if (!isProfit) {
        r.profit1.classList.add('loss-val');
        r.profit2.classList.add('loss-val');
    }

    return tr;
}

function buildCompareRow(result) {
    const tr = cloneEl('tpl-compare-row');
    const r = refs(tr);
    const { cat, spend, a, b, aReward, bReward, aName, bName } = result;

    r.category.textContent = cat;
    r.spend.textContent = fmt$(spend);

    // Card A cell
    if (a.none) {
        r.cellA.hidden = true;
        r.noneA.hidden = false;
    } else {
        r.cellA.hidden = false;
        r.noneA.hidden = true;
        r.rateA.textContent = `${a.rate.toFixed(1)}%${a.isDefault ? ' (base)' : ''}`;
        r.rewardA.textContent = fmt$(aReward);
        if (a.refund) {
            r.noteA.hidden = false;
            r.noteA.textContent = ` (incl. ${fmt$(a.refund)} refund)`;
        } else {
            r.noteA.hidden = true;
        }
    }

    // Card B cell
    if (b.none) {
        r.cellB.hidden = true;
        r.noneB.hidden = false;
    } else {
        r.cellB.hidden = false;
        r.noneB.hidden = true;
        r.rateB.textContent = `${b.rate.toFixed(1)}%${b.isDefault ? ' (base)' : ''}`;
        r.rewardB.textContent = fmt$(bReward);
        if (b.refund) {
            r.noteB.hidden = false;
            r.noteB.textContent = ` (incl. ${fmt$(b.refund)} refund)`;
        } else {
            r.noteB.hidden = true;
        }
    }

    // Winner cell
    const bothNone = a.none && b.none;
    if (bothNone) {
        r.winnerName.textContent = 'No rate set';
        r.winnerName.className = 'tie';
        r.winnerBadge.hidden = true;
    } else if (aReward === bReward) {
        r.winnerName.textContent = 'Tie';
        r.winnerName.className = 'tie';
        r.winnerBadge.hidden = true;
    } else {
        const aWins = aReward > bReward;
        r.winnerName.textContent = aWins ? aName : bName;
        r.winnerName.className = aWins ? 'win-a' : 'win-b';
        r.winnerBadge.hidden = false;
        r.winnerBadge.className = `badge ${aWins ? 'a' : 'b'}`;
        r.winnerBadge.textContent = `+${fmt$(Math.abs(aReward - bReward))}`;
    }

    return tr;
}

function buildBestComboCard(combo, onLoad) {
    const card = cloneEl('tpl-best-combo-card');
    const r = refs(card);

    r.title.textContent = `${combo.cardA.name} + ${combo.cardB.name}`;
    r.sub.textContent = `Gross rewards ${fmt$(combo.grossTotal)}/mo · Combined fees ${fmt$(combo.aFee + combo.bFee)}/yr (${fmt$(combo.combinedMonthlyFee)}/mo)`;
    r.value.textContent = fmt$(combo.netMonthly);
    r.valueSub.textContent = `${fmt$(combo.netAnnual)}/yr net`;
    r.loadBtn.addEventListener('click', onLoad);

    return card;
}

// -------------------------------------------------------------------
// Rental Helpers
// -------------------------------------------------------------------
function getRentalRent(propertyName) {
    const row = getRentalIncomeRow(propertyName);
    return row ? (row.monthly_spend || 0) : 0;
}

function getRentalOperatingExpenses(propertyName) {
    return getRentalExpenseRows(propertyName).reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
}

function getRentalMortgage(propertyName) {
    return getRentalExpenseRows(propertyName)
        .filter(r => (r.category || '').trim().toLowerCase() === 'mortgage')
        .reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
}

function getRentalTaxSettings(propertyName) {
    const row = taxRows.find(t => (t[COL_TAX_STREAM] || t.income_stream) === propertyName);
    return {
        depreciation: row ? (parseFloat(row[COL_TAX_DEPRECIATION] ?? row.depreciation) || 0) : 0,
        mortgage_interest: row ? (parseFloat(row[COL_TAX_MORTGAGE_INTEREST] ?? row.mortgage_interest) || 0) : 0,
        tax_rate: row ? (parseFloat(row[COL_TAX_RATE] ?? row.tax_rate) || 0) : 0
    };
}

function getRentalTax(propertyName) {
    const rent = getRentalRent(propertyName);
    const expenses = getRentalOperatingExpenses(propertyName);
    const mortgage = getRentalMortgage(propertyName);
    const settings = getRentalTaxSettings(propertyName);
    const monthlyDep = settings.depreciation / 12;
    const monthlyInt = settings.mortgage_interest / 12;
    const taxableIncome = rent - (expenses - mortgage) - monthlyDep - monthlyInt;
    const rate = settings.tax_rate / 100;
    return taxableIncome > 0 ? (taxableIncome * rate) : 0;
}

function getRentalTotalExpenses(propertyName) {
    return getRentalOperatingExpenses(propertyName) + getRentalTax(propertyName);
}

function getRentalProfit(propertyName) {
    return getRentalRent(propertyName) - getRentalTotalExpenses(propertyName);
}

// -------------------------------------------------------------------
// Tab 1: Budget Rendering
// -------------------------------------------------------------------
function renderBudgetTab() {
    renderTabGrids(document.getElementById('tab-budget'), categoryRows, {
        onUpdate: updateCategoryRow,
        onDelete: (id, msg) => deleteCategoryRow(id, msg)
    });
    renderCardTotals();
    renderBalanceSummary();
}

function renderBalanceSummary() {
    const container = document.getElementById('balanceSummaryGrid');
    if (!container) return;

    const { income, totalBankSpend, split, totalSpending, totalIncome, netBalance } = getBudgetTotals();

    const isSurplus = netBalance >= 0;
    const statusClass = isSurplus ? 'surplus' : 'deficit';
    const statusText = isSurplus ? 'Surplus' : 'Deficit';

    const r = refs(container);
    if (!r.incomeVal) return;

    r.incomeVal.textContent = fmt$(totalIncome);
    r.incomeFoot.textContent = `${fmt$(totalIncome * 12)}/yr · across ${income.length} source${income.length === 1 ? '' : 's'} + ${RENTAL_PROPERTIES.length} rental${RENTAL_PROPERTIES.length === 1 ? '' : 's'}`;

    r.spendVal.textContent = fmt$(totalSpending);
    r.spendFoot.textContent = `${split.blocks[0].label} ${fmt$(split.blocks[0].total)} + ${split.blocks[1].label} ${fmt$(split.blocks[1].total)} + Bank ${fmt$(totalBankSpend)} = ${fmt$(totalSpending)}/mo · ${fmt$(totalSpending * 12)}/yr`;

    r.netLabel.textContent = `Net Balance (${statusText})`;
    r.netVal.textContent = fmt$(netBalance);
    r.netFoot.textContent = `Income (${fmt$(totalIncome)}) − Spending (${fmt$(totalSpending)}) = ${fmt$(netBalance)}/mo (${fmt$(netBalance * 12)}/yr)`;
    r.netCard.className = `summary-card ${statusClass}`;
}

// -------------------------------------------------------------------
// Tab 2: Comparison Rendering
// -------------------------------------------------------------------
function renderCardsGrid() {
    const body = document.getElementById('cardsGridBody');
    const empty = document.getElementById('cardsGridEmpty');
    if (!body) return;
    body.replaceChildren();
    if (empty) empty.hidden = cardsRows.length > 0;
    cardsRows.forEach(row => body.append(buildCardRow(row, { onUpdate: updateCardRow, onDelete: deleteCardRow })));
}

function renderRewardsGrid() {
    const body = document.getElementById('rewardsGridBody');
    const empty = document.getElementById('rewardsGridEmpty');
    if (!body) return;
    body.replaceChildren();
    if (empty) empty.hidden = rewardRows.length > 0;
    rewardRows.forEach(row => body.append(buildRewardRow(row, { onUpdate: updateRewardRow, onDelete: deleteRewardRow })));
}

function renderCardOptions() {
    const newRewardCard = document.getElementById('newRewardCard');
    const sortedCards = [...cardsRows].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (newRewardCard) {
        const current = newRewardCard.value;
        populateCardSelect(newRewardCard, cardsRows.some(c => c.id === current) ? current : '');
    }

    const aSel = document.getElementById('cardASelect');
    const bSel = document.getElementById('cardBSelect');
    if (!aSel || !bSel) return;

    [aSel, bSel].forEach(sel => {
        const current = sel.value;
        sel.replaceChildren();
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = 'Choose a card…';
        sel.append(blank);
        sortedCards.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id; opt.textContent = c.name;
            sel.append(opt);
        });
        if (sortedCards.some(c => c.id === current)) sel.value = current;
    });
}

function getEffectiveRate(cardId, category) {
    const exact = rewardRows.find(r => r.card_id === cardId && r.category && r.category.trim().toLowerCase() === category.trim().toLowerCase());
    if (exact) return { rate: exact.rate || 0, refund: exact.special_refund || 0, isDefault: false };
    const card = cardsRows.find(c => c.id === cardId);
    if (card) return { rate: card.base_rate || 0, refund: 0, isDefault: true };
    return { rate: 0, refund: 0, isDefault: false, none: true };
}

function getAnnualFee(cardId) {
    const card = cardsRows.find(c => c.id === cardId);
    return card ? (card.annual_fee || 0) : 0;
}

// -------------------------------------------------------------------
// Budget tab: per-card totals (Card 1 / Card 2), rewards subtracted per card
// -------------------------------------------------------------------
// Auto rewards for one card: each category's spend × the card's rate for that
// category (or its base rate), plus any special refund once per category.
function autoRewardsForRows(cardId, rows) {
    const spendByCategory = new Map();
    rows.forEach(r => {
        const key = (r.category || '').trim().toLowerCase();
        spendByCategory.set(key, (spendByCategory.get(key) || 0) + (r.monthly_spend || 0));
    });
    let total = 0;
    spendByCategory.forEach((spend, key) => {
        const eff = getEffectiveRate(cardId, key);
        total += (spend * eff.rate / 100) + eff.refund;
    });
    return total;
}

// rows defaults to the live Budget rows; the projection passes its own.
// Rewards are the manual override if one is set, otherwise the auto value.
function computeCardSplit(rows = categoryRows) {
    const blocks = CARD_SLOTS.map(slot => {
        const slotRows = rows.filter(r => r.account_type === slot.accountType);
        const card = cardsRows.find(c => slot.match.test(c.name || '')) || null;
        const spend = slotRows.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
        const autoRewards = card ? autoRewardsForRows(card.id, slotRows) : 0;
        const manual = rewardOverrides[slot.key];
        const overridden = typeof manual === 'number';
        const rewards = overridden ? manual : autoRewards;
        return { key: slot.key, label: slot.label, card, spend, autoRewards, overridden, rewards, total: spend - rewards };
    });

    return {
        blocks,
        spend: blocks[0].spend + blocks[1].spend,
        rewards: blocks[0].rewards + blocks[1].rewards,
        total: blocks[0].total + blocks[1].total
    };
}

function setRewardOverride(slotKey, value) {
    if (value == null) delete rewardOverrides[slotKey];
    else rewardOverrides[slotKey] = value;
    saveRewardOverrides();
    render();
}

function renderCardTotals() {
    const round2 = n => Math.round(n * 100) / 100;

    computeCardSplit().blocks.forEach(b => {
        const subtotal = document.getElementById(`${b.key}Subtotal`);
        const input = document.getElementById(`${b.key}RewardInput`);
        const note = document.getElementById(`${b.key}RewardNote`);
        const reset = document.getElementById(`${b.key}RewardReset`);
        const total = document.getElementById(`${b.key}Total`);

        if (subtotal) subtotal.textContent = fmt$(b.spend);
        if (input && document.activeElement !== input) input.value = round2(b.rewards);
        if (note) {
            note.textContent = b.overridden
                ? `manual (auto would be ${fmt$(b.autoRewards)})`
                : (b.card
                    ? 'auto, from Credit Card Comparison rates'
                    : `no card matching "${b.label}" on the Credit Card Comparison tab, so no auto rewards`);
        }
        if (reset) reset.style.display = b.overridden ? '' : 'none';
        if (total) total.textContent = fmt$(b.total);
    });
}

function findBestTwoCardCombo() {
    const spend = spendRows();
    if (cardsRows.length < 2 || !spend.length) return null;
    let bestCombo = null;

    for (let i = 0; i < cardsRows.length; i++) {
        for (let j = i + 1; j < cardsRows.length; j++) {
            const cardA = cardsRows[i], cardB = cardsRows[j];
            const aFee = getAnnualFee(cardA.id), bFee = getAnnualFee(cardB.id);

            let grossTotal = 0;
            spend.forEach(catRow => {
                const s = catRow.monthly_spend || 0;
                const a = getEffectiveRate(cardA.id, catRow.category);
                const b = getEffectiveRate(cardB.id, catRow.category);
                grossTotal += Math.max((s * a.rate / 100) + a.refund, (s * b.rate / 100) + b.refund);
            });

            const combinedMonthlyFee = (aFee + bFee) / 12;
            const netMonthly = grossTotal - combinedMonthlyFee;

            if (!bestCombo || netMonthly > bestCombo.netMonthly) {
                bestCombo = { cardA, cardB, grossTotal, aFee, bFee, combinedMonthlyFee, netMonthly, netAnnual: netMonthly * 12 };
            }
        }
    }
    return bestCombo;
}

function renderBestCombo() {
    const container = document.getElementById('bestComboContainer');
    if (!container) return;

    const combo = (cardsRows.length >= 2 && spendRows().length) ? findBestTwoCardCombo() : null;
    if (!combo) {
        container.replaceChildren();
        container.hidden = true;
        return;
    }

    container.hidden = false;
    container.replaceChildren(buildBestComboCard(combo, () => {
        const aSel = document.getElementById('cardASelect');
        const bSel = document.getElementById('cardBSelect');
        if (aSel && bSel) {
            aSel.value = combo.cardA.id;
            bSel.value = combo.cardB.id;
            renderComparison();
        }
    }));
}

function renderComparison() {
    const aSel = document.getElementById('cardASelect');
    const bSel = document.getElementById('cardBSelect');
    if (!aSel || !bSel) return;

    const aId = aSel.value, bId = bSel.value;
    const compareTableWrap = document.getElementById('compareTableWrap');
    const compareEmpty = document.getElementById('compareEmpty');
    const summaryGrid = document.getElementById('summaryGrid');
    const spend = spendRows();

    if (!aId || !bId || aId === bId || !spend.length) {
        if (compareTableWrap) compareTableWrap.hidden = true;
        if (summaryGrid) summaryGrid.hidden = true;
        if (compareEmpty) {
            compareEmpty.hidden = false;
            compareEmpty.textContent = !spend.length
                ? 'Add spending categories in the Budget tab and at least two cards to compare.'
                : (!aId || !bId) ? 'Pick two different cards above to compare.' : 'Pick two different cards to compare.';
        }
        return;
    }

    const aName = (cardsRows.find(c => c.id === aId) || {}).name || '';
    const bName = (cardsRows.find(c => c.id === bId) || {}).name || '';

    if (compareEmpty) compareEmpty.hidden = true;
    if (compareTableWrap) compareTableWrap.hidden = false;
    if (summaryGrid) summaryGrid.hidden = false;

    const headA = document.getElementById('headA'), headB = document.getElementById('headB');
    if (headA) headA.textContent = aName;
    if (headB) headB.textContent = bName;

    const aFee = getAnnualFee(aId), bFee = getAnnualFee(bId);
    let aTotal = 0, bTotal = 0, bestTotal = 0;
    const tbody = document.getElementById('compareBody');
    if (!tbody) return;
    tbody.replaceChildren();

    const categoryResults = spend.map(catRow => {
        const s = catRow.monthly_spend || 0;
        const a = getEffectiveRate(aId, catRow.category), b = getEffectiveRate(bId, catRow.category);
        const aReward = (s * a.rate / 100) + a.refund, bReward = (s * b.rate / 100) + b.refund;
        return { cat: catRow.category, spend: s, a, b, aReward, bReward, aName, bName, best: Math.max(aReward, bReward) };
    }).sort((x, y) => y.best - x.best);

    categoryResults.forEach(result => {
        aTotal += result.aReward;
        bTotal += result.bReward;
        bestTotal += Math.max(result.aReward, result.bReward);
        tbody.append(buildCompareRow(result));
    });

    if (summaryGrid) {
        const aNet = aTotal - aFee / 12, bNet = bTotal - bFee / 12, bestNet = bestTotal - (aFee + bFee) / 12;
        const r = refs(summaryGrid);
        if (r.cardALabel) {
            r.cardALabel.textContent = aName;
            r.cardAVal.textContent = fmt$(aNet);
            r.cardAFoot.textContent = `Rewards ${fmt$(aTotal)}/mo · Annual fee ${fmt$(aFee)} (${fmt$(aFee / 12)}/mo) · Net ${fmt$(aNet)}/mo`;

            r.cardBLabel.textContent = bName;
            r.cardBVal.textContent = fmt$(bNet);
            r.cardBFoot.textContent = `Rewards ${fmt$(bTotal)}/mo · Annual fee ${fmt$(bFee)} (${fmt$(bFee / 12)}/mo) · Net ${fmt$(bNet)}/mo`;

            r.bestVal.textContent = fmt$(bestNet);
            r.bestFoot.textContent = `Rewards ${fmt$(bestTotal)}/mo if you used whichever card wins each category · minus ${fmt$((aFee + bFee) / 12)}/mo combined fees = ${fmt$(bestNet)}/mo`;
        }
    }
}

// -------------------------------------------------------------------
// Tab 3: Rentals (San Jacinto & County Line)
// -------------------------------------------------------------------
function renderRentals() {
    renderPropertySection('San Jacinto', {
        rentInputId: 'sanJacintoRentInput', spendGridBodyId: 'sanJacintoSpendGridBody', spendGridEmptyId: 'sanJacintoSpendGridEmpty',
        profitSummaryId: 'sanJacintoProfitSummary', taxRentId: 'sanJacintoTaxRent', taxExpensesId: 'sanJacintoTaxExpenses',
        depreciationInputId: 'sanJacintoDepreciation', mortgageInterestInputId: 'sanJacintoMortgageInterest', taxRateInputId: 'sanJacintoTaxRate', taxSumId: 'sanJacintoTaxSum'
    });
    renderPropertySection('County Line', {
        rentInputId: 'countyLineRentInput', spendGridBodyId: 'countyLineSpendGridBody', spendGridEmptyId: 'countyLineSpendGridEmpty',
        profitSummaryId: 'countyLineProfitSummary', taxRentId: 'countyLineTaxRent', taxExpensesId: 'countyLineTaxExpenses',
        depreciationInputId: 'countyLineDepreciation', mortgageInterestInputId: 'countyLineMortgageInterest', taxRateInputId: 'countyLineTaxRate', taxSumId: 'countyLineTaxSum'
    });
}

function renderPropertySection(propertyName, elements) {
    const rentInput = document.getElementById(elements.rentInputId);
    const rentRow = getRentalIncomeRow(propertyName);
    const rentVal = rentRow ? (rentRow.amount ?? rentRow.monthly_spend ?? 0) : 0;
    if (rentInput && document.activeElement !== rentInput) rentInput.value = rentVal ? rentVal : '';

    const body = document.getElementById(elements.spendGridBodyId);
    const empty = document.getElementById(elements.spendGridEmptyId);
    const expenses = getRentalExpenseRows(propertyName);

    if (body) {
        body.replaceChildren();
        if (empty) empty.hidden = expenses.length > 0;
        expenses.forEach(row => {
            body.append(buildCategoryRow(row, {
                onUpdate: updateCategoryRow,
                onDelete: id => deleteCategoryRow(id, 'Deleted rental entry.'),
                deleteTitle: 'Delete expense'
            }));
        });
    }

    const rent = getRentalRent(propertyName);
    const operatingExpenses = getRentalOperatingExpenses(propertyName);
    const taxSettings = getRentalTaxSettings(propertyName);
    const monthlyTax = getRentalTax(propertyName);

    const taxRentEl = document.getElementById(elements.taxRentId);
    if (taxRentEl) taxRentEl.textContent = fmt$(rent);
    const taxExpensesEl = document.getElementById(elements.taxExpensesId);
    if (taxExpensesEl) taxExpensesEl.textContent = fmt$(operatingExpenses);

    const depInput = document.getElementById(elements.depreciationInputId);
    if (depInput && document.activeElement !== depInput) depInput.value = taxSettings.depreciation ? taxSettings.depreciation : '';
    const mortgageInput = document.getElementById(elements.mortgageInterestInputId);
    if (mortgageInput && document.activeElement !== mortgageInput) mortgageInput.value = taxSettings.mortgage_interest ? taxSettings.mortgage_interest : '';
    const taxRateInput = document.getElementById(elements.taxRateInputId);
    if (taxRateInput && document.activeElement !== taxRateInput) taxRateInput.value = taxSettings.tax_rate ? taxSettings.tax_rate : '';

    const taxSumEl = document.getElementById(elements.taxSumId);
    if (taxSumEl) taxSumEl.textContent = `${fmt$(monthlyTax)}/mo`;

    const summary = document.getElementById(elements.profitSummaryId);
    if (summary) {
        const totalExpenses = getRentalTotalExpenses(propertyName);
        const profit = rent - totalExpenses;
        const isProfit = profit >= 0;
        const statusClass = isProfit ? 'surplus' : 'deficit';
        const statusText = isProfit ? 'Net Profit' : 'Net Loss';

        const r = refs(summary);
        if (r.rentVal) {
            r.rentVal.textContent = fmt$(rent);
            r.rentFoot.textContent = `${fmt$(rent * 12)}/yr`;

            r.expensesVal.textContent = fmt$(totalExpenses);
            r.expensesFoot.textContent = `${fmt$(operatingExpenses)}/mo expenses + ${fmt$(monthlyTax)}/mo tax · ${fmt$(totalExpenses * 12)}/yr`;

            r.profitLabel.textContent = statusText;
            r.profitVal.textContent = fmt$(profit);
            r.profitFoot.textContent = `Rent (${fmt$(rent)}) − Expenses (${fmt$(totalExpenses)}) = ${fmt$(profit)}/mo (${fmt$(profit * 12)}/yr)`;
            r.profitCard.className = `summary-card ${statusClass}`;
        }
    }
}

// -------------------------------------------------------------------
// Tab 5: Budget Projection Rendering
// -------------------------------------------------------------------
function renderProjectionSummary(totals) {
    const summaryGrid = document.getElementById('projectionSummaryGrid');
    if (!summaryGrid) return;

    if (!totals) {
        summaryGrid.hidden = true;
        return;
    }
    summaryGrid.hidden = false;

    const isSurplus = totals.netBalance >= 0;
    const statusClass = isSurplus ? 'surplus' : 'deficit';
    const statusText = isSurplus ? 'Projected Surplus' : 'Projected Deficit';

    const r = refs(summaryGrid);
    if (!r.incomeVal) return;

    r.incomeVal.textContent = fmt$(totals.totalIncome);
    r.incomeFoot.textContent = `${fmt$(totals.totalIncome * 12)}/yr`;

    r.spendVal.textContent = fmt$(totals.totalSpending);
    r.spendFoot.textContent = `Credit Cards ${fmt$(totals.totalCcSpend)}/mo · Bank ${fmt$(totals.totalBankSpend)}/mo` +
        (totals.cardRewards ? ` · Rewards −${fmt$(totals.cardRewards)}/mo` : '');

    r.rentalVal.textContent = fmt$(totals.rentalProfits);
    r.rentalFoot.textContent = `${fmt$(totals.rentalProfits * 12)}/yr`;

    r.netLabel.textContent = statusText;
    r.netVal.textContent = fmt$(totals.netBalance);
    r.netFoot.textContent = `Income (${fmt$(totals.totalIncome)}) − Spending (${fmt$(totals.totalSpending)}) = ${fmt$(totals.netBalance)}/mo`;
    r.netCard.className = `summary-card ${statusClass}`;
}

function renderProjection() {
    const monthSelect = document.getElementById('projectionMonthSelect');
    const tabEl = document.getElementById('tab-projection');

    if (!monthSelect || !tabEl) return;

    const months = projectionMonths();
    monthSelect.replaceChildren();

    months.forEach(month => {
        const option = document.createElement('option');
        option.value = month;
        option.textContent = fmtYm(month);
        monthSelect.append(option);
    });

    const currentMonth = resolveProjectionMonth();
    monthSelect.value = currentMonth;

    const deleteBtn = document.getElementById('projectionDeleteMonthBtn');
    if (deleteBtn) {
        const hasSnapshots = budgetSnapshotRows.some(r => normalizeYm(r.month) === currentMonth);
        deleteBtn.disabled = !hasSnapshots;
    }

    const input = document.getElementById('projectionNewMonth');
    if (input && !input.value && document.activeElement !== input) {
        input.value = months.length ? addMonths(months[0], 1) : thisYm();
    }

    const projectedRows = getProjectedRows(currentMonth);
    const rentalNets = getProjectedRentalNets(currentMonth);

    renderTabGrids(tabEl, projectedRows, {
        onUpdate: updateBudgetSnapshotRow,
        onDelete: deleteBudgetSnapshotRow,
        isProjection: true,
        rentalNets
    });

    const split = computeCardSplit(projectedRows);
    const totals = computeBudgetTotals(projectedRows, rentalNets, split.rewards);
    renderProjectionSummary(totals);
}

// -------------------------------------------------------------------
// Master Render
// -------------------------------------------------------------------
function saveToLocalCache() {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            categoryRows,
            cardsRows,
            rewardRows,
            taxRows,
            budgetSnapshotRows,
            timestamp: Date.now()
        }));
    } catch (e) {}
}

function loadFromLocalCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.categoryRows)) return false;
        categoryRows = (data.categoryRows || []).map(normalizeCategoryRow);
        cardsRows = data.cardsRows || [];
        rewardRows = data.rewardRows || [];
        taxRows = data.taxRows || [];
        budgetSnapshotRows = data.budgetSnapshotRows || [];
        return true;
    } catch (e) {
        return false;
    }
}

function render() {
    const open = captureDetailsState(document);
    renderBudgetTab();
    renderCardsGrid();
    renderRewardsGrid();
    renderCardOptions();
    renderBestCombo();
    renderComparison();
    renderRentals();
    renderDebts();
    renderProjection();
    renderTracker();
    renderCardUsage();
    restoreDetailsState(open, document);
    saveToLocalCache();
}

// -------------------------------------------------------------------
// Supabase Data Loaders & Mutations
// -------------------------------------------------------------------
async function loadSpendingCategories() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CATEGORIES_TABLE).select('*').order(COL_CAT_CREATED_AT, { ascending: true });
        if (error) throw error;
        categoryRows = (data || []).map(normalizeCategoryRow);
    } catch (err) {
        console.error('Error loading spending categories:', err);
        setStatus('Could not load spending categories.');
        categoryRows = [];
    }
}

async function loadCards() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CARDS_TABLE).select('*').order(COL_CARD_CREATED_AT, { ascending: true });
        if (error) throw error;
        cardsRows = data || [];
    } catch (err) {
        console.error('Error loading cards:', err);
        setStatus('Could not load cards.');
        cardsRows = [];
    }
}

async function addCardRow(data) {
    const id = crypto.randomUUID();
    const row = { id, ...data, created_at: nowStamp() };
    cardsRows.push(row);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: CARDS_TABLE,
        type: 'insert',
        id,
        payload: row
    });
    setStatus('Added card.');
}

async function updateCardRow(id, patch) {
    const row = cardsRows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: CARDS_TABLE,
        type: 'update',
        id,
        idColumn: COL_CARD_ID,
        payload: { ...patch, updated_at: nowStamp() }
    });
}

async function deleteCardRow(id) {
    cardsRows = cardsRows.filter(r => r.id !== id);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: CARDS_TABLE,
        type: 'delete',
        id,
        idColumn: COL_CARD_ID
    });
    setStatus('Deleted card.');
}

async function loadRewards() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(REWARDS_TABLE).select('*').order(COL_REWARD_CREATED_AT, { ascending: true });
        if (error) throw error;
        rewardRows = data || [];
    } catch (err) {
        console.error('Error loading card rewards:', err);
        setStatus('Could not load card rewards.');
        rewardRows = [];
    }
}

async function addRewardRow(data) {
    const id = crypto.randomUUID();
    const row = { id, ...data, created_at: nowStamp() };
    rewardRows.push(row);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: REWARDS_TABLE,
        type: 'insert',
        id,
        payload: row
    });
    setStatus('Added reward rate.');
}

async function updateRewardRow(id, patch) {
    const row = rewardRows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: REWARDS_TABLE,
        type: 'update',
        id,
        idColumn: COL_REWARD_ID,
        payload: { ...patch, updated_at: nowStamp() }
    });
}

async function deleteRewardRow(id) {
    rewardRows = rewardRows.filter(r => r.id !== id);
    render();
    saveToLocalCache();
    writeOrQueue(sb, {
        table: REWARDS_TABLE,
        type: 'delete',
        id,
        idColumn: COL_REWARD_ID
    });
    setStatus('Deleted row.');
}

async function loadIncomeTax() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(TAX_TABLE).select('*');
        if (error) throw error;
        taxRows = data || [];
    } catch (err) {
        console.warn('Could not load income_tax table:', err);
        taxRows = [];
    }
}

async function loadBudgetSnapshots() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(BUDGET_SNAPSHOT_TABLE).select('*').order('month');
        if (error) throw error;
        budgetSnapshotRows = data || [];
    } catch (err) {
        console.error('Could not load budget snapshots:', err);
        budgetSnapshotRows = [];
    }
}

async function updateTaxRow(streamName, patch) {
    let row = taxRows.find(r => (r[COL_TAX_STREAM] || r.income_stream) === streamName);
    if (!row) {
        row = { [COL_TAX_STREAM]: streamName, [COL_TAX_RATE]: 0, [COL_TAX_DEPRECIATION]: 0, [COL_TAX_MORTGAGE_INTEREST]: 0 };
        taxRows.push(row);
    }
    Object.assign(row, patch);
    render();
    saveToLocalCache();

    const payload = {
        [COL_TAX_STREAM]: streamName,
        [COL_TAX_RATE]: parseFloat(row[COL_TAX_RATE] ?? row.tax_rate) || 0,
        [COL_TAX_DEPRECIATION]: parseFloat(row[COL_TAX_DEPRECIATION] ?? row.depreciation) || 0,
        [COL_TAX_MORTGAGE_INTEREST]: parseFloat(row[COL_TAX_MORTGAGE_INTEREST] ?? row.mortgage_interest) || 0,
        updated_at: nowStamp()
    };

    writeOrQueue(sb, {
        table: TAX_TABLE,
        type: 'upsert',
        id: streamName,
        idColumn: COL_TAX_STREAM,
        payload,
        options: { onConflict: COL_TAX_STREAM }
    });
}

// -------------------------------------------------------------------
// Realtime + Lifecycle
// -------------------------------------------------------------------
function setupRealtime() {
    if (realtimeChannel || !sb) return;
    realtimeChannel = sb.channel('credit_cards_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: CATEGORIES_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: CARDS_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: REWARDS_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: TAX_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: BUDGET_SNAPSHOT_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: TRACKER_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: CARD_USAGE_TABLE }, () => debounceReload())
        .subscribe();
}

function debounceReload() {
    clearTimeout(realtimeDebounceTimer);
    realtimeDebounceTimer = setTimeout(async () => {
        const activeEl = document.activeElement;
        if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) return;
        await Promise.all([
            loadSpendingCategories(),
            loadCards(),
            loadRewards(),
            loadIncomeTax(),
            loadDebtData(),
            loadBudgetSnapshots(),
            loadTrackerData(),
            loadCardUsageData()
        ]);
        render();
    }, 400);
}

window.addEventListener('beforeunload', () => {
    if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
});

async function loadAll() {
    const hadCached = loadFromLocalCache();
    if (hadCached) {
        render();
    }
    try {
        await withTimeout(Promise.all([
            loadSpendingCategories(),
            loadCards(),
            loadRewards(),
            loadIncomeTax(),
            loadDebtData(),
            loadBudgetSnapshots(),
            loadTrackerData(),
            loadCardUsageData()
        ]), LOAD_TIMEOUT_MS, 'Loading financial data');
        render();
    } catch (err) {
        console.error('Failed to load financial data:', err);
    }
    setupRealtime();
}

initDebts({
    getNetBalance: () => getBudgetTotals().netBalance,
    getBankRows: () => bankSpendRows()
});

initTracker({
    getSpendRows: () => spendRows()
});

initCardUsage();

// -------------------------------------------------------------------
// UI Event Handlers & Initialization
// -------------------------------------------------------------------
wireAddForm({
    buttonId: 'addCategoryBtn',
    fieldIds: { category: 'newCategory', frequency: 'newCategoryFrequency', amount: 'newCategoryAmount', notes: 'newCategoryNotes' },
    requiredMessage: 'Category name is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'credit_cards', type: 'spending', addedMessage: 'Added Card 1 category.' })
});

wireAddForm({
    buttonId: 'addCard2CategoryBtn',
    fieldIds: { category: 'newCard2Category', frequency: 'newCard2CategoryFrequency', amount: 'newCard2CategoryAmount', notes: 'newCard2CategoryNotes' },
    requiredMessage: 'Category name is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'credit_cards_2', type: 'spending', addedMessage: 'Added Card 2 category.' })
});

// Rewards rows under each card: typing sets a manual amount, clearing it (or
// "Use auto") goes back to the amount calculated from the comparison rates.
CARD_SLOTS.forEach(slot => {
    const input = document.getElementById(`${slot.key}RewardInput`);
    if (input) {
        input.addEventListener('change', () => {
            const raw = input.value.trim();
            setRewardOverride(slot.key, raw === '' ? null : Math.max(0, parseFloat(raw) || 0));
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        });
    }
    const resetBtn = document.getElementById(`${slot.key}RewardReset`);
    if (resetBtn) resetBtn.addEventListener('click', () => setRewardOverride(slot.key, null));
});

wireAddForm({
    buttonId: 'addBankCategoryBtn',
    fieldIds: { category: 'newBankCategory', frequency: 'newBankCategoryFrequency', amount: 'newBankCategoryAmount', notes: 'newBankCategoryNotes' },
    requiredMessage: 'Expense name is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'bank', type: 'spending', addedMessage: 'Added bank expense.' })
});

wireAddForm({
    buttonId: 'addIncomeBtn',
    fieldIds: { category: 'newIncomeSource', frequency: 'newIncomeFrequency', amount: 'newIncomeAmount', notes: 'newIncomeNotes' },
    requiredMessage: 'Income source is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'income', type: 'income', addedMessage: 'Added income source.' })
});

wireAddForm({
    buttonId: 'sanJacintoAddCategoryBtn',
    fieldIds: { category: 'sanJacintoNewCategory', frequency: 'sanJacintoNewCategoryFrequency', amount: 'sanJacintoNewCategoryAmount', notes: 'sanJacintoNewCategoryNotes' },
    requiredMessage: 'Expense category is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'rental', type: 'spending', property: 'San Jacinto', addedMessage: 'Added expense for San Jacinto.' })
});

wireAddForm({
    buttonId: 'countyLineAddCategoryBtn',
    fieldIds: { category: 'countyLineNewCategory', frequency: 'countyLineNewCategoryFrequency', amount: 'countyLineNewCategoryAmount', notes: 'countyLineNewCategoryNotes' },
    requiredMessage: 'Expense category is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'rental', type: 'spending', property: 'County Line', addedMessage: 'Added expense for County Line.' })
});

// Rent inputs commit on change
const sanJacintoRentInput = document.getElementById('sanJacintoRentInput');
if (sanJacintoRentInput) sanJacintoRentInput.addEventListener('change', () => setRentalRent('San Jacinto', sanJacintoRentInput.value));
const countyLineRentInput = document.getElementById('countyLineRentInput');
if (countyLineRentInput) countyLineRentInput.addEventListener('change', () => setRentalRent('County Line', countyLineRentInput.value));

['sanJacintoDepreciation', 'sanJacintoMortgageInterest', 'sanJacintoTaxRate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('change', () => updateTaxRow('San Jacinto', {
        [COL_TAX_DEPRECIATION]: parseFloat(document.getElementById('sanJacintoDepreciation')?.value) || 0,
        [COL_TAX_MORTGAGE_INTEREST]: parseFloat(document.getElementById('sanJacintoMortgageInterest')?.value) || 0,
        [COL_TAX_RATE]: parseFloat(document.getElementById('sanJacintoTaxRate')?.value) || 0
    }));
});

['countyLineDepreciation', 'countyLineMortgageInterest', 'countyLineTaxRate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('change', () => updateTaxRow('County Line', {
        [COL_TAX_DEPRECIATION]: parseFloat(document.getElementById('countyLineDepreciation')?.value) || 0,
        [COL_TAX_MORTGAGE_INTEREST]: parseFloat(document.getElementById('countyLineMortgageInterest')?.value) || 0,
        [COL_TAX_RATE]: parseFloat(document.getElementById('countyLineTaxRate')?.value) || 0
    }));
});

[sanJacintoRentInput, countyLineRentInput,
    'sanJacintoDepreciation', 'sanJacintoMortgageInterest', 'sanJacintoTaxRate',
    'countyLineDepreciation', 'countyLineMortgageInterest', 'countyLineTaxRate']
    .map(el => (typeof el === 'string' ? document.getElementById(el) : el))
    .filter(Boolean)
    .forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }));

const addCardBtn = document.getElementById('addCardBtn');
if (addCardBtn) {
    addCardBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('newCardName');
        const feeInput = document.getElementById('newCardFee');
        const baseRateInput = document.getElementById('newCardBaseRate');
        const name = nameInput.value.trim();
        if (!name) { setStatus('Card name is required.'); return; }
        addCardRow({ name, annual_fee: parseFloat(feeInput.value) || 0, base_rate: parseFloat(baseRateInput.value) || 0 });
        nameInput.value = ''; feeInput.value = ''; baseRateInput.value = ''; nameInput.focus();
    });
    ['newCardName', 'newCardFee', 'newCardBaseRate'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCardBtn.click(); } });
    });
}

const addRewardBtn = document.getElementById('addRewardBtn');
if (addRewardBtn) {
    addRewardBtn.addEventListener('click', () => {
        const cardSelect = document.getElementById('newRewardCard');
        const catInput = document.getElementById('newRewardCategory');
        const rateInput = document.getElementById('newRate');
        const refundInput = document.getElementById('newSpecialRefund');
        const card = cardSelect.value;
        const category = catInput.value.trim();
        if (!card) { setStatus("Choose a card first — add one above if it's not listed yet."); return; }
        if (!category) { setStatus('Category is required for a reward override.'); return; }
        addRewardRow({ card_id: card, category, rate: parseFloat(rateInput.value) || 0, special_refund: parseFloat(refundInput.value) || 0 });
        catInput.value = ''; rateInput.value = ''; refundInput.value = ''; catInput.focus();
    });
    ['newRewardCategory', 'newRate', 'newSpecialRefund'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRewardBtn.click(); } });
    });
}

const cardASelect = document.getElementById('cardASelect');
const cardBSelect = document.getElementById('cardBSelect');
if (cardASelect) cardASelect.addEventListener('change', renderComparison);
if (cardBSelect) cardBSelect.addEventListener('change', renderComparison);

const projectionMonthSelect = document.getElementById('projectionMonthSelect');
if (projectionMonthSelect) {
    projectionMonthSelect.addEventListener('change', () => {
        selectedProjectionMonth = projectionMonthSelect.value;
        renderProjection();
    });
}

const projectionNewSnapshotBtn = document.getElementById('projectionNewSnapshotBtn');
if (projectionNewSnapshotBtn) {
    projectionNewSnapshotBtn.addEventListener('click', () => {
        const month = document.getElementById('projectionNewMonth')?.value;
        if (!month) {
            setStatus('Choose a projection month.');
            return;
        }
        createBudgetSnapshot(month);
    });
}

const projectionDeleteMonthBtn = document.getElementById('projectionDeleteMonthBtn');
if (projectionDeleteMonthBtn) {
    projectionDeleteMonthBtn.addEventListener('click', () => {
        const month = resolveProjectionMonth();
        if (!month) {
            setStatus('No projection month selected.');
            return;
        }
        deleteBudgetSnapshot(month);
    });
}

// -------------------------------------------------------------------
// Tabs — hash-routed
// -------------------------------------------------------------------
const TAB_KEYS = ['budget', 'comparison', 'rental', 'debt', 'projection', 'tracker', 'cardusage'];
const tabFromHash = () => (TAB_KEYS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TAB_KEYS[0]);

function switchTab(tabKey) {
    document.querySelectorAll('#cc-tabs .tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabKey));
    TAB_KEYS.forEach(key => {
        const pane = document.getElementById(`tab-${key}`);
        if (pane) pane.hidden = key !== tabKey;
    });
}

const tabsContainer = document.getElementById('cc-tabs');
if (tabsContainer) {
    tabsContainer.addEventListener('click', e => {
        const btn = e.target.closest('.tab');
        if (!btn || !btn.dataset.tab) return;
        location.hash = btn.dataset.tab;
    });
}

window.addEventListener('hashchange', () => switchTab(tabFromHash()));

window.addEventListener('sync:flushed', () => {
    debounceReload();
});

// Initial tab & start
switchTab(tabFromHash());
initAppPage(() => {
    if (sb) initSync(sb);
    loadAll();
});