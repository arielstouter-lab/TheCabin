import { cloneEl, refs } from './dom.js';
import { buildCategoryRow } from './category-row.js';
import { renderSummaryCards } from './summary-card.js';

const sb = window.supabaseClient;
const CATEGORIES_TABLE = 'income_expense_categories';
const CARDS_TABLE = 'credit_cards';
const REWARDS_TABLE = 'card_rewards';
const TAX_TABLE = 'income_tax';

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
// distinguished by account_type/type/property. Replaces four parallel arrays.
let categoryRows = [];
let cardsRows = [];
let rewardRows = [];
let taxRows = [];

let realtimeChannel = null;
let realtimeDebounceTimer = null;

function fmt$(n) {
    const val = typeof n === 'number' && !isNaN(n) ? n : 0;
    const sign = val < 0 ? '-' : '';
    const absVal = Math.abs(val);
    return sign + '$' + (Math.round(absVal * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
    return { ...r, category: r[COL_CAT_CATEGORY] || '', frequency, amount, notes, monthly_spend, account_type: 'credit_cards', type: 'spending' };
}

const spendRows = () => categoryRows.filter(r => r.account_type === 'credit_cards');
const bankSpendRows = () => categoryRows.filter(r => r.account_type === 'bank');
const incomeRows = () => categoryRows.filter(r => r.account_type === 'income');
const getRentalIncomeRow = property => categoryRows.find(r => r.account_type === 'rental' && r.property === property && r.type === 'income');
const getRentalExpenseRows = property => categoryRows.filter(r => r.account_type === 'rental' && r.property === property && r.type === 'spending');

// -------------------------------------------------------------------
// Generic category-row CRUD — one add/update/delete for spend, bank
// spend, income, and rental rows (previously four near-identical sets).
// -------------------------------------------------------------------
async function addCategoryRow(fields, tag) {
    if (!sb) return false;
    const frequency = fields.frequency || 'monthly';
    const amount = fields.amount || 0;
    const monthly_spend = computeMonthlySpend(amount, frequency);
    const payload = {
        [COL_CAT_CATEGORY]: fields.category,
        [COL_CAT_FREQUENCY]: frequency,
        [COL_CAT_AMOUNT]: amount,
        [COL_CAT_NOTES]: fields.notes || '',
        [COL_CAT_MONTHLY_SPEND]: monthly_spend,
        [COL_CAT_ACCOUNT_TYPE]: tag.account_type,
        [COL_CAT_TYPE]: tag.type,
        ...(tag.property ? { [COL_CAT_PROPERTY]: tag.property } : {})
    };
    try {
        const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
        if (error) throw error;
        if (inserted) {
            categoryRows.push(normalizeCategoryRow(inserted));
            render();
        }
        if (window.setStatus) window.setStatus(tag.addedMessage || 'Added.');
        return true;
    } catch (err) {
        console.error('Could not add row:', err);
        if (window.setStatus) window.setStatus('Could not add: ' + (err.message || err));
        return false;
    }
}

async function updateCategoryRow(id, patch) {
    if (!sb) return false;
    try {
        const row = categoryRows.find(r => r.id === id);
        if (row) {
            Object.assign(row, patch);
            row.monthly_spend = computeMonthlySpend(row.amount, row.frequency);
        }
        render();
        const payload = { ...patch };
        if (row) {
            payload[COL_CAT_FREQUENCY] = row.frequency;
            payload[COL_CAT_AMOUNT] = row.amount;
            payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
            if (row.notes !== undefined) payload[COL_CAT_NOTES] = row.notes;
        }
        const { error } = await sb.from(CATEGORIES_TABLE).update(payload).eq(COL_CAT_ID, id);
        if (error) throw error;
        return true;
    } catch (err) {
        console.error('Could not update row:', err);
        if (window.setStatus) window.setStatus('Could not update.');
        return false;
    }
}

async function deleteCategoryRow(id, message) {
    if (!sb) return false;
    try {
        const { error } = await sb.from(CATEGORIES_TABLE).delete().eq(COL_CAT_ID, id);
        if (error) throw error;
        categoryRows = categoryRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus(message || 'Deleted.');
        return true;
    } catch (err) {
        console.error('Could not delete row:', err);
        if (window.setStatus) window.setStatus('Could not delete.');
        return false;
    }
}

async function setRentalRent(propertyName, rentAmount) {
    const val = parseFloat(rentAmount) || 0;
    const existing = getRentalIncomeRow(propertyName);
    const ok = existing
        ? await updateCategoryRow(existing.id, { amount: val })
        : await addCategoryRow({ category: 'Rent', frequency: 'monthly', amount: val, notes: '' }, { account_type: 'rental', type: 'income', property: propertyName });
    if (ok) { if (window.setStatus) window.setStatus(`Updated rent for ${propertyName}.`); }
}

// -------------------------------------------------------------------
// Add-form wiring — one helper for the five "name, frequency, amount,
// notes" forms (credit card / bank / income / two rental expense forms),
// replacing five near-identical click handlers.
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
            if (window.setStatus) window.setStatus(requiredMessage);
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
    r.profit1.textContent = fmt$(profit);
    r.profit2.textContent = fmt$(profit);
    if (!isProfit) {
        r.profit1.classList.add('loss-val');
        r.profit2.classList.add('loss-val');
    }

    return tr;
}

function buildCompareCell(eff, reward) {
    const cell = cloneEl('tpl-compare-cell');
    const r = refs(cell);

    if (eff.none) {
        cell.replaceChildren();
        cell.textContent = 'no rate';
        cell.classList.add('empty-state');
        return cell;
    }

    r.rate.textContent = `${eff.rate.toFixed(1)}%${eff.isDefault ? ' (base)' : ''}`;
    r.reward.textContent = fmt$(reward);
    if (eff.refund) {
        r.note.hidden = false;
        r.note.textContent = `(incl. ${fmt$(eff.refund)} refund)`;
    } else {
        r.note.remove();
    }

    return cell;
}

function buildWinnerCell(aReward, bReward, aName, bName, bothNone) {
    const cell = cloneEl('tpl-winner-cell');
    const r = refs(cell);

    if (bothNone) {
        r.name.textContent = 'No rate set';
        r.name.className = 'tie';
        r.badge.remove();
        return cell;
    }
    if (aReward === bReward) {
        r.name.textContent = 'Tie';
        r.name.className = 'tie';
        r.badge.remove();
        return cell;
    }

    const aWins = aReward > bReward;
    r.name.textContent = aWins ? aName : bName;
    r.name.className = aWins ? 'win-a' : 'win-b';
    r.badge.hidden = false;
    r.badge.classList.add(aWins ? 'a' : 'b');
    r.badge.textContent = `+${fmt$(Math.abs(aReward - bReward))}`;

    return cell;
}

function buildCompareRow(result) {
    const tr = cloneEl('tpl-compare-row');
    const r = refs(tr);
    const { cat, spend, a, b, aReward, bReward, aName, bName } = result;

    r.category.textContent = cat;
    r.spend.textContent = fmt$(spend);
    r.cellA.append(buildCompareCell(a, aReward));
    r.cellB.append(buildCompareCell(b, bReward));
    r.winner.append(buildWinnerCell(aReward, bReward, aName, bName, a.none && b.none));

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

function render() {
    renderSpendGrid();
    renderBankSpendGrid();
    renderIncomeGrid();
    renderBalanceSummary();
    renderCardsGrid();
    renderRewardsGrid();
    renderCardOptions();
    renderBestCombo();
    renderComparison();
    renderRentals();
}

// -------------------------------------------------------------------
// Grid 1: Credit Card Spending
// -------------------------------------------------------------------
function renderSpendGrid() {
    const body = document.getElementById('spendGridBody');
    const empty = document.getElementById('spendGridEmpty');
    if (!body) return;

    const rows = spendRows();
    body.replaceChildren();
    if (empty) empty.hidden = rows.length > 0;

    rows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateCategoryRow,
            onDelete: id => deleteCategoryRow(id, 'Deleted category.'),
            deleteTitle: 'Delete category',
            fmt$
        }));
    });
}

// -------------------------------------------------------------------
// Grid 1b: Bank Account Spending
// -------------------------------------------------------------------
function renderBankSpendGrid() {
    const body = document.getElementById('bankSpendGridBody');
    const empty = document.getElementById('bankSpendGridEmpty');
    if (!body) return;

    const rows = bankSpendRows();
    body.replaceChildren();
    if (empty) empty.hidden = rows.length > 0;

    rows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateCategoryRow,
            onDelete: id => deleteCategoryRow(id, 'Deleted bank expense.'),
            deleteTitle: 'Delete expense',
            fmt$
        }));
    });
}

// -------------------------------------------------------------------
// Grid 1c: Income (with non-editable monthly rental profit lines)
// -------------------------------------------------------------------
function renderIncomeGrid() {
    const body = document.getElementById('incomeGridBody');
    const empty = document.getElementById('incomeGridEmpty');
    if (!body) return;

    const rows = incomeRows();
    body.replaceChildren();
    if (empty) empty.hidden = (rows.length + RENTAL_PROPERTIES.length) > 0;

    rows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateCategoryRow,
            onDelete: id => deleteCategoryRow(id, 'Deleted income source.'),
            deleteTitle: 'Delete income source',
            fmt$
        }));
    });

    RENTAL_PROPERTIES.forEach(property => {
        body.append(buildRentalIncomeRow(property, getRentalProfit(property)));
    });
}

// -------------------------------------------------------------------
// Grid 1d: Budget Balance (Total Income - Total Spending = Balance)
// -------------------------------------------------------------------
function renderBalanceSummary() {
    const container = document.getElementById('balanceSummaryGrid');
    if (!container) return;

    const spend = spendRows(), bank = bankSpendRows(), income = incomeRows();
    const totalCcSpend = spend.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalBankSpend = bank.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalSpending = totalCcSpend + totalBankSpend;

    const regularIncome = income.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const rentalProfits = RENTAL_PROPERTIES.reduce((sum, prop) => sum + getRentalProfit(prop), 0);
    const totalIncome = regularIncome + rentalProfits;
    const netBalance = totalIncome - totalSpending;

    const isSurplus = netBalance >= 0;
    const statusClass = isSurplus ? 'surplus' : 'deficit';
    const statusText = isSurplus ? 'Surplus' : 'Deficit';

    renderSummaryCards(container, [
        {
            label: 'Total Income',
            value: fmt$(totalIncome),
            foot: `${fmt$(totalIncome * 12)}/yr &middot; across ${income.length} source${income.length === 1 ? '' : 's'} + ${RENTAL_PROPERTIES.length} rental${RENTAL_PROPERTIES.length === 1 ? '' : 's'}`
        },
        {
            label: 'Total Spending',
            value: fmt$(totalSpending),
            foot: `CC: ${fmt$(totalCcSpend)}/mo &middot; Bank: ${fmt$(totalBankSpend)}/mo &middot; ${fmt$(totalSpending * 12)}/yr`
        },
        {
            label: `Net Balance (${statusText})`,
            value: fmt$(netBalance),
            statusClass,
            foot: `Income (${fmt$(totalIncome)}) &minus; Spending (${fmt$(totalSpending)}) = ${fmt$(netBalance)}/mo (${fmt$(netBalance * 12)}/yr)`
        }
    ]);
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
                deleteTitle: 'Delete expense',
                fmt$
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

        renderSummaryCards(summary, [
            { label: 'Monthly Rent (Income)', value: fmt$(rent), foot: `${fmt$(rent * 12)}/yr` },
            { label: 'Total Expenses', value: fmt$(totalExpenses), foot: `${fmt$(operatingExpenses)}/mo expenses + ${fmt$(monthlyTax)}/mo tax &middot; ${fmt$(totalExpenses * 12)}/yr` },
            { label: statusText, value: fmt$(profit), statusClass, foot: `Rent (${fmt$(rent)}) &minus; Expenses (${fmt$(totalExpenses)}) = ${fmt$(profit)}/mo (${fmt$(profit * 12)}/yr)` }
        ]);
    }
}

// -------------------------------------------------------------------
// Grid 2: Credit Cards
// -------------------------------------------------------------------
function renderCardsGrid() {
    const body = document.getElementById('cardsGridBody');
    const empty = document.getElementById('cardsGridEmpty');
    if (!body) return;
    body.replaceChildren();
    if (empty) empty.hidden = cardsRows.length > 0;
    cardsRows.forEach(row => body.append(buildCardRow(row, { onUpdate: updateCardRow, onDelete: deleteCardRow })));
}

// -------------------------------------------------------------------
// Grid 3: Card Rewards
// -------------------------------------------------------------------
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
// Best Two-Card Combination
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// Comparison
// -------------------------------------------------------------------
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
        renderSummaryCards(summaryGrid, [
            { label: aName, value: fmt$(aNet), unit: '/mo net', foot: `Rewards ${fmt$(aTotal)}/mo &middot; Annual fee ${fmt$(aFee)} (${fmt$(aFee / 12)}/mo) &middot; Net ${fmt$(aNet)}/mo` },
            { label: bName, value: fmt$(bNet), unit: '/mo net', foot: `Rewards ${fmt$(bTotal)}/mo &middot; Annual fee ${fmt$(bFee)} (${fmt$(bFee / 12)}/mo) &middot; Net ${fmt$(bNet)}/mo` },
            { label: 'Best of Both (optimal routing)', value: fmt$(bestNet), unit: '/mo net', statusClass: 'best', foot: `Rewards ${fmt$(bestTotal)}/mo if you used whichever card wins each category &middot; minus ${fmt$((aFee + bFee) / 12)}/mo combined fees = ${fmt$(bestNet)}/mo` }
        ]);
    }
}

// -------------------------------------------------------------------
// Supabase load — categories, cards, rewards, tax
// -------------------------------------------------------------------
async function loadSpendingCategories() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CATEGORIES_TABLE).select('*').order(COL_CAT_CREATED_AT, { ascending: true });
        if (error) throw error;
        categoryRows = (data || []).map(normalizeCategoryRow);
    } catch (err) {
        console.error('Error loading spending categories:', err);
        if (window.setStatus) window.setStatus('Could not load spending categories.');
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
        if (window.setStatus) window.setStatus('Could not load cards.');
        cardsRows = [];
    }
}

async function addCardRow(data) {
    if (!sb) return;
    try {
        const { data: inserted, error } = await sb.from(CARDS_TABLE).insert([data]).select().single();
        if (error) throw error;
        if (inserted) { cardsRows.push(inserted); render(); }
        if (window.setStatus) window.setStatus('Added card.');
    } catch (err) {
        console.error('Could not add card:', err);
        if (window.setStatus) window.setStatus('Could not add card: ' + (err.message || err));
    }
}

async function updateCardRow(id, patch) {
    if (!sb) return;
    try {
        const row = cardsRows.find(r => r.id === id);
        if (row) Object.assign(row, patch);
        render();
        const { error } = await sb.from(CARDS_TABLE).update(patch).eq(COL_CARD_ID, id);
        if (error) throw error;
    } catch (err) {
        console.error('Could not update card:', err);
        if (window.setStatus) window.setStatus('Could not update card.');
    }
}

async function deleteCardRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(CARDS_TABLE).delete().eq(COL_CARD_ID, id);
        if (error) throw error;
        cardsRows = cardsRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted card.');
    } catch (err) {
        console.error('Could not delete card:', err);
        if (window.setStatus) window.setStatus('Could not delete card.');
    }
}

async function loadRewards() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(REWARDS_TABLE).select('*').order(COL_REWARD_CREATED_AT, { ascending: true });
        if (error) throw error;
        rewardRows = data || [];
    } catch (err) {
        console.error('Error loading card rewards:', err);
        if (window.setStatus) window.setStatus('Could not load card rewards.');
        rewardRows = [];
    }
}

async function addRewardRow(data) {
    if (!sb) return;
    try {
        const { data: inserted, error } = await sb.from(REWARDS_TABLE).insert([data]).select().single();
        if (error) throw error;
        if (inserted) { rewardRows.push(inserted); render(); }
        if (window.setStatus) window.setStatus('Added reward rate.');
    } catch (err) {
        console.error('Could not add row:', err);
        if (window.setStatus) window.setStatus('Could not add row: ' + (err.message || err));
    }
}

async function updateRewardRow(id, patch) {
    if (!sb) return;
    try {
        const row = rewardRows.find(r => r.id === id);
        if (row) Object.assign(row, patch);
        render();
        const { error } = await sb.from(REWARDS_TABLE).update(patch).eq(COL_REWARD_ID, id);
        if (error) throw error;
    } catch (err) {
        console.error('Could not update row:', err);
        if (window.setStatus) window.setStatus('Could not update row.');
    }
}

async function deleteRewardRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(REWARDS_TABLE).delete().eq(COL_REWARD_ID, id);
        if (error) throw error;
        rewardRows = rewardRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted row.');
    } catch (err) {
        console.error('Could not delete row:', err);
        if (window.setStatus) window.setStatus('Could not delete row.');
    }
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

async function updateTaxRow(streamName, patch) {
    let row = taxRows.find(r => (r[COL_TAX_STREAM] || r.income_stream) === streamName);
    if (!row) {
        row = { [COL_TAX_STREAM]: streamName, [COL_TAX_RATE]: 0, [COL_TAX_DEPRECIATION]: 0, [COL_TAX_MORTGAGE_INTEREST]: 0 };
        taxRows.push(row);
    }
    Object.assign(row, patch);
    render();

    if (!sb) return;
    try {
        const payload = {
            [COL_TAX_STREAM]: streamName,
            [COL_TAX_RATE]: parseFloat(row[COL_TAX_RATE] ?? row.tax_rate) || 0,
            [COL_TAX_DEPRECIATION]: parseFloat(row[COL_TAX_DEPRECIATION] ?? row.depreciation) || 0,
            [COL_TAX_MORTGAGE_INTEREST]: parseFloat(row[COL_TAX_MORTGAGE_INTEREST] ?? row.mortgage_interest) || 0
        };
        if (row[COL_TAX_ID] || row.id) {
            const { error } = await sb.from(TAX_TABLE).update(payload).eq(COL_TAX_ID, row[COL_TAX_ID] || row.id);
            if (error) throw error;
        } else {
            const { data: upserted, error } = await sb.from(TAX_TABLE).upsert([payload], { onConflict: COL_TAX_STREAM }).select().single();
            if (error) throw error;
            if (upserted) Object.assign(row, upserted);
        }
    } catch (err) {
        console.error('Could not save tax settings:', err);
    }
}

// -------------------------------------------------------------------
// Realtime + init
// -------------------------------------------------------------------
function setupRealtime() {
    if (realtimeChannel || !sb) return;
    realtimeChannel = sb.channel('credit_cards_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: CATEGORIES_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: CARDS_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: REWARDS_TABLE }, () => debounceReload())
        .on('postgres_changes', { event: '*', schema: 'public', table: TAX_TABLE }, () => debounceReload())
        .subscribe();
}

function debounceReload() {
    clearTimeout(realtimeDebounceTimer);
    realtimeDebounceTimer = setTimeout(async () => {
        const activeEl = document.activeElement;
        if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) return;
        await Promise.all([loadSpendingCategories(), loadCards(), loadRewards(), loadIncomeTax()]);
        render();
    }, 400);
}

window.addEventListener('beforeunload', () => {
    if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
});

async function loadAll() {
    await Promise.all([loadSpendingCategories(), loadCards(), loadRewards(), loadIncomeTax()]);
    render();
    setupRealtime();
}

// -------------------------------------------------------------------
// Wire up UI
// -------------------------------------------------------------------
wireAddForm({
    buttonId: 'addCategoryBtn',
    fieldIds: { category: 'newCategory', frequency: 'newCategoryFrequency', amount: 'newCategoryAmount', notes: 'newCategoryNotes' },
    requiredMessage: 'Category name is required.',
    onAdd: v => addCategoryRow(v, { account_type: 'credit_cards', type: 'spending', addedMessage: 'Added credit card category.' })
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

// Rent inputs commit on change, and Enter blurs (rather than submitting a form)
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
        if (!name) { if (window.setStatus) window.setStatus('Card name is required.'); return; }
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
        if (!card) { if (window.setStatus) window.setStatus("Choose a card first — add one above if it's not listed yet."); return; }
        if (!category) { if (window.setStatus) window.setStatus('Category is required for a reward override.'); return; }
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

// -------------------------------------------------------------------
// Tabs — hash-routed
// -------------------------------------------------------------------
const TAB_KEYS = ['budget', 'comparison', 'rental'];
const tabFromHash = () => (TAB_KEYS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TAB_KEYS[0]);

function switchTab(tabKey) {
    document.querySelectorAll('#cc-tabs .tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabKey));
    ['budget', 'comparison', 'rental'].forEach(key => {
        const pane = document.getElementById(`tab-${key}`);
        if (pane) pane.hidden = key !== tabKey;
    });
}

const tabsContainer = document.getElementById('cc-tabs');
if (tabsContainer) {
    tabsContainer.addEventListener('click', e => {
        const btn = e.target.closest('.tab');
        if (btn && btn.dataset.tab) location.hash = btn.dataset.tab;
    });
    window.addEventListener('hashchange', () => switchTab(tabFromHash()));
    switchTab(tabFromHash());
}

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------
if (window.initAppPage) {
    window.initAppPage(loadAll);
} else {
    document.addEventListener('app:ready', loadAll, { once: true });
}
