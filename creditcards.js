import { cloneEl, refs, focusAtEnd } from './dom.js';
import { buildCategoryRow } from './category-row.js';
import { renderSummaryCards } from './summary-card.js';

const sb = window.supabaseClient;
const CATEGORIES_TABLE = 'income_expense_categories';
const CARDS_TABLE = 'credit_cards';
const REWARDS_TABLE = 'card_rewards';
const TAX_TABLE = 'income_tax';

// Categories Table Columns
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

// Credit Cards Table Columns
const COL_CARD_ID = 'id';
const COL_CARD_CREATED_AT = 'created_at';

// Card Rewards Table Columns
const COL_REWARD_ID = 'id';
const COL_REWARD_CREATED_AT = 'created_at';

// Income Tax Table Columns
const COL_TAX_ID = 'id';
const COL_TAX_STREAM = 'income_stream';
const COL_TAX_RATE = 'tax_rate';
const COL_TAX_DEPRECIATION = 'depreciation';
const COL_TAX_MORTGAGE_INTEREST = 'mortgage_interest';

const RENTAL_PROPERTIES = ['San Jacinto', 'County Line'];

let spendRows = [];       // {id, category, frequency, amount, monthly_spend, account_type: 'credit_cards', type: 'spending'}
let bankSpendRows = [];   // {id, category, frequency, amount, monthly_spend, account_type: 'bank', type: 'spending'}
let incomeRows = [];      // {id, category, frequency, amount, monthly_spend, account_type: 'income', type: 'income'}
let rentalRows = [];      // {id, property, category, frequency, amount, monthly_spend, account_type: 'rental', type: 'income'|'spending'}
let cardsRows = [];       // {id, name, annual_fee, base_rate}
let rewardRows = [];      // {id, card_id, category, rate, special_refund}
let taxRows = [];         // {id, income_stream, tax_rate, depreciation, mortgage_interest}

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
    const freq = String(frequency || 'monthly').toLowerCase();
    switch (freq) {
        case 'semimonthly':
            return val * 2;
        case 'biweekly':
            return (val * 26) / 12;
        case 'annual':
            return val / 12;
        case 'monthly':
        default:
            return val;
    }
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

// eff: { rate, refund, isDefault, none }
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
    const rentRow = rentalRows.find(r => r.property === propertyName && r.type === 'income');
    return rentRow ? (rentRow.monthly_spend || 0) : 0;
}

function getRentalExpenses(propertyName) {
    return rentalRows.filter(r => r.property === propertyName && r.type === 'spending');
}

function getRentalOperatingExpenses(propertyName) {
    return getRentalExpenses(propertyName).reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
}

function getRentalMortgage(propertyName) {
    return getRentalExpenses(propertyName)
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

    body.replaceChildren();
    if (empty) empty.hidden = spendRows.length > 0;

    spendRows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateCategoryRow,
            onDelete: deleteCategoryRow,
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

    body.replaceChildren();
    if (empty) empty.hidden = bankSpendRows.length > 0;

    bankSpendRows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateBankSpendRow,
            onDelete: deleteBankSpendRow,
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

    body.replaceChildren();
    const totalSources = incomeRows.length + RENTAL_PROPERTIES.length;
    if (empty) empty.hidden = totalSources > 0;

    incomeRows.forEach(row => {
        body.append(buildCategoryRow(row, {
            onUpdate: updateIncomeRow,
            onDelete: deleteIncomeRow,
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

    const totalCcSpend = spendRows.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalBankSpend = bankSpendRows.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const totalSpending = totalCcSpend + totalBankSpend;

    const regularIncome = incomeRows.reduce((sum, r) => sum + (r.monthly_spend || 0), 0);
    const rentalProfits = RENTAL_PROPERTIES.reduce((sum, prop) => sum + getRentalProfit(prop), 0);
    const totalIncome = regularIncome + rentalProfits;

    const netBalance = totalIncome - totalSpending;

    const annualIncome = totalIncome * 12;
    const annualSpending = totalSpending * 12;
    const annualBalance = netBalance * 12;

    const isSurplus = netBalance >= 0;
    const statusClass = isSurplus ? 'surplus' : 'deficit';
    const statusText = isSurplus ? 'Surplus' : 'Deficit';

    renderSummaryCards(container, [
        {
            label: 'Total Income',
            value: fmt$(totalIncome),
            foot: `${fmt$(annualIncome)}/yr &middot; across ${incomeRows.length} source${incomeRows.length === 1 ? '' : 's'} + ${RENTAL_PROPERTIES.length} rental${RENTAL_PROPERTIES.length === 1 ? '' : 's'}`
        },
        {
            label: 'Total Spending',
            value: fmt$(totalSpending),
            foot: `CC: ${fmt$(totalCcSpend)}/mo &middot; Bank: ${fmt$(totalBankSpend)}/mo &middot; ${fmt$(annualSpending)}/yr`
        },
        {
            label: `Net Balance (${statusText})`,
            value: fmt$(netBalance),
            statusClass,
            foot: `Income (${fmt$(totalIncome)}) &minus; Spending (${fmt$(totalSpending)}) = ${fmt$(netBalance)}/mo (${fmt$(annualBalance)}/yr)`
        }
    ]);
}

// -------------------------------------------------------------------
// Tab 3: Rentals (San Jacinto & County Line)
// -------------------------------------------------------------------
function renderRentals() {
    renderPropertySection('San Jacinto', {
        rentInputId: 'sanJacintoRentInput',
        spendGridBodyId: 'sanJacintoSpendGridBody',
        spendGridEmptyId: 'sanJacintoSpendGridEmpty',
        profitSummaryId: 'sanJacintoProfitSummary',
        taxRentId: 'sanJacintoTaxRent',
        taxExpensesId: 'sanJacintoTaxExpenses',
        depreciationInputId: 'sanJacintoDepreciation',
        mortgageInterestInputId: 'sanJacintoMortgageInterest',
        taxRateInputId: 'sanJacintoTaxRate',
        taxSumId: 'sanJacintoTaxSum'
    });

    renderPropertySection('County Line', {
        rentInputId: 'countyLineRentInput',
        spendGridBodyId: 'countyLineSpendGridBody',
        spendGridEmptyId: 'countyLineSpendGridEmpty',
        profitSummaryId: 'countyLineProfitSummary',
        taxRentId: 'countyLineTaxRent',
        taxExpensesId: 'countyLineTaxExpenses',
        depreciationInputId: 'countyLineDepreciation',
        mortgageInterestInputId: 'countyLineMortgageInterest',
        taxRateInputId: 'countyLineTaxRate',
        taxSumId: 'countyLineTaxSum'
    });
}

function renderPropertySection(propertyName, elements) {
    const rentInput = document.getElementById(elements.rentInputId);
    const rentRow = rentalRows.find(r => r.property === propertyName && r.type === 'income');
    const rentVal = rentRow ? (rentRow.amount !== undefined && rentRow.amount !== null ? rentRow.amount : (rentRow.monthly_spend || 0)) : 0;
    if (rentInput && document.activeElement !== rentInput) {
        rentInput.value = rentVal ? rentVal : '';
    }

    const body = document.getElementById(elements.spendGridBodyId);
    const empty = document.getElementById(elements.spendGridEmptyId);
    const expenses = getRentalExpenses(propertyName);

    if (body) {
        body.replaceChildren();
        if (empty) empty.hidden = expenses.length > 0;

        expenses.forEach(row => {
            body.append(buildCategoryRow(row, {
                onUpdate: updateRentalExpenseRow,
                onDelete: deleteRentalRow,
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
    if (depInput && document.activeElement !== depInput) {
        depInput.value = taxSettings.depreciation ? taxSettings.depreciation : '';
    }

    const mortgageInput = document.getElementById(elements.mortgageInterestInputId);
    if (mortgageInput && document.activeElement !== mortgageInput) {
        mortgageInput.value = taxSettings.mortgage_interest ? taxSettings.mortgage_interest : '';
    }

    const taxRateInput = document.getElementById(elements.taxRateInputId);
    if (taxRateInput && document.activeElement !== taxRateInput) {
        taxRateInput.value = taxSettings.tax_rate ? taxSettings.tax_rate : '';
    }

    const taxSumEl = document.getElementById(elements.taxSumId);
    if (taxSumEl) taxSumEl.textContent = `${fmt$(monthlyTax)}/mo`;

    const summary = document.getElementById(elements.profitSummaryId);
    if (summary) {
        const totalExpenses = getRentalTotalExpenses(propertyName);
        const profit = rent - totalExpenses;
        const annualProfit = profit * 12;
        const isProfit = profit >= 0;
        const statusClass = isProfit ? 'surplus' : 'deficit';
        const statusText = isProfit ? 'Net Profit' : 'Net Loss';

        renderSummaryCards(summary, [
            {
                label: 'Monthly Rent (Income)',
                value: fmt$(rent),
                foot: `${fmt$(rent * 12)}/yr`
            },
            {
                label: 'Total Expenses',
                value: fmt$(totalExpenses),
                foot: `${fmt$(operatingExpenses)}/mo expenses + ${fmt$(monthlyTax)}/mo tax &middot; ${fmt$(totalExpenses * 12)}/yr`
            },
            {
                label: statusText,
                value: fmt$(profit),
                statusClass,
                foot: `Rent (${fmt$(rent)}) &minus; Expenses (${fmt$(totalExpenses)}) = ${fmt$(profit)}/mo (${fmt$(annualProfit)}/yr)`
            }
        ]);
    }
}

// -------------------------------------------------------------------
// Grid 2: Credit Cards (name, annual fee, base rate)
// -------------------------------------------------------------------
function renderCardsGrid() {
    const body = document.getElementById('cardsGridBody');
    const empty = document.getElementById('cardsGridEmpty');
    if (!body) return;

    body.replaceChildren();
    if (empty) empty.hidden = cardsRows.length > 0;

    cardsRows.forEach(row => {
        body.append(buildCardRow(row, { onUpdate: updateCardRow, onDelete: deleteCardRow }));
    });
}

// -------------------------------------------------------------------
// Grid 3: Card Rewards (category-specific overrides)
// -------------------------------------------------------------------
function renderRewardsGrid() {
    const body = document.getElementById('rewardsGridBody');
    const empty = document.getElementById('rewardsGridEmpty');
    if (!body) return;

    body.replaceChildren();
    if (empty) empty.hidden = rewardRows.length > 0;

    rewardRows.forEach(row => {
        body.append(buildRewardRow(row, { onUpdate: updateRewardRow, onDelete: deleteRewardRow }));
    });
}

function renderCardOptions() {
    const newRewardCard = document.getElementById('newRewardCard');
    if (newRewardCard) {
        const current = newRewardCard.value;
        populateCardSelect(newRewardCard, cardsRows.some(c => c.id === current) ? current : '');
    }

    const sortedCards = [...cardsRows].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const aSel = document.getElementById('cardASelect');
    const bSel = document.getElementById('cardBSelect');
    if (!aSel || !bSel) return;

    [aSel, bSel].forEach(sel => {
        const current = sel.value;
        sel.replaceChildren();
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Choose a card…';
        sel.append(blank);
        sortedCards.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
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
    if (cardsRows.length < 2 || !spendRows.length) return null;

    let bestCombo = null;

    for (let i = 0; i < cardsRows.length; i++) {
        for (let j = i + 1; j < cardsRows.length; j++) {
            const cardA = cardsRows[i];
            const cardB = cardsRows[j];
            const aFee = getAnnualFee(cardA.id);
            const bFee = getAnnualFee(cardB.id);

            let grossTotal = 0;
            spendRows.forEach(catRow => {
                const cat = catRow.category;
                const spend = catRow.monthly_spend || 0;
                const a = getEffectiveRate(cardA.id, cat);
                const b = getEffectiveRate(cardB.id, cat);
                const aReward = (spend * a.rate / 100) + a.refund;
                const bReward = (spend * b.rate / 100) + b.refund;
                grossTotal += Math.max(aReward, bReward);
            });

            const combinedMonthlyFee = (aFee + bFee) / 12;
            const netMonthly = grossTotal - combinedMonthlyFee;
            const netAnnual = netMonthly * 12;

            if (!bestCombo || netMonthly > bestCombo.netMonthly) {
                bestCombo = { cardA, cardB, grossTotal, aFee, bFee, combinedMonthlyFee, netMonthly, netAnnual };
            }
        }
    }

    return bestCombo;
}

function renderBestCombo() {
    const container = document.getElementById('bestComboContainer');
    if (!container) return;

    if (cardsRows.length < 2 || !spendRows.length) {
        container.replaceChildren();
        container.hidden = true;
        return;
    }

    const combo = findBestTwoCardCombo();
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

    const aId = aSel.value;
    const bId = bSel.value;
    const compareTableWrap = document.getElementById('compareTableWrap');
    const compareEmpty = document.getElementById('compareEmpty');
    const summaryGrid = document.getElementById('summaryGrid');

    if (!aId || !bId || aId === bId || !spendRows.length) {
        if (compareTableWrap) compareTableWrap.hidden = true;
        if (summaryGrid) summaryGrid.hidden = true;
        if (compareEmpty) {
            compareEmpty.hidden = false;
            compareEmpty.textContent = !spendRows.length
                ? 'Add spending categories in the Budget tab and at least two cards to compare.'
                : (!aId || !bId)
                    ? 'Pick two different cards above to compare.'
                    : 'Pick two different cards to compare.';
        }
        return;
    }

    const aName = (cardsRows.find(c => c.id === aId) || {}).name || '';
    const bName = (cardsRows.find(c => c.id === bId) || {}).name || '';

    if (compareEmpty) compareEmpty.hidden = true;
    if (compareTableWrap) compareTableWrap.hidden = false;
    if (summaryGrid) summaryGrid.hidden = false;

    const headA = document.getElementById('headA');
    const headB = document.getElementById('headB');
    if (headA) headA.textContent = aName;
    if (headB) headB.textContent = bName;

    const aFee = getAnnualFee(aId);
    const bFee = getAnnualFee(bId);

    let aTotal = 0, bTotal = 0, bestTotal = 0;
    const tbody = document.getElementById('compareBody');
    if (!tbody) return;
    tbody.replaceChildren();

    const categoryResults = spendRows.map(catRow => {
        const cat = catRow.category;
        const spend = catRow.monthly_spend || 0;
        const a = getEffectiveRate(aId, cat);
        const b = getEffectiveRate(bId, cat);
        const aReward = (spend * a.rate / 100) + a.refund;
        const bReward = (spend * b.rate / 100) + b.refund;
        return { cat, spend, a, b, aReward, bReward, aName, bName, best: Math.max(aReward, bReward) };
    });

    categoryResults.sort((x, y) => y.best - x.best);

    categoryResults.forEach(result => {
        aTotal += result.aReward;
        bTotal += result.bReward;
        bestTotal += Math.max(result.aReward, result.bReward);
        tbody.append(buildCompareRow(result));
    });

    if (summaryGrid) {
        const aNet = aTotal - aFee / 12;
        const bNet = bTotal - bFee / 12;
        const bestNet = bestTotal - (aFee + bFee) / 12;
        renderSummaryCards(summaryGrid, [
            {
                label: aName,
                value: fmt$(aNet),
                unit: '/mo net',
                foot: `Rewards ${fmt$(aTotal)}/mo &middot; Annual fee ${fmt$(aFee)} (${fmt$(aFee / 12)}/mo) &middot; Net ${fmt$(aNet)}/mo`
            },
            {
                label: bName,
                value: fmt$(bNet),
                unit: '/mo net',
                foot: `Rewards ${fmt$(bTotal)}/mo &middot; Annual fee ${fmt$(bFee)} (${fmt$(bFee / 12)}/mo) &middot; Net ${fmt$(bNet)}/mo`
            },
            {
                label: 'Best of Both (optimal routing)',
                value: fmt$(bestNet),
                unit: '/mo net',
                statusClass: 'best',
                foot: `Rewards ${fmt$(bestTotal)}/mo if you used whichever card wins each category &middot; minus ${fmt$((aFee + bFee) / 12)}/mo combined fees = ${fmt$(bestNet)}/mo`
            }
        ]);
    }
}

// -------------------------------------------------------------------
// Supabase CRUD — Consolidated Spending Categories
// -------------------------------------------------------------------
async function loadSpendingCategories() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(CATEGORIES_TABLE).select('*').order(COL_CAT_CREATED_AT, { ascending: true });
        if (error) throw error;

        spendRows = [];
        bankSpendRows = [];
        incomeRows = [];
        rentalRows = [];

        (data || []).forEach(r => {
            const freq = r[COL_CAT_FREQUENCY] || 'monthly';
            const amt = r[COL_CAT_AMOUNT] !== undefined && r[COL_CAT_AMOUNT] !== null ? r[COL_CAT_AMOUNT] : (r[COL_CAT_MONTHLY_SPEND] ?? 0);
            const monthly = parseFloat(r[COL_CAT_MONTHLY_SPEND] ?? r.monthly_spend ?? amt) || 0;

            const acc = String(r[COL_CAT_ACCOUNT_TYPE] || '').toLowerCase();
            const flow = String(r[COL_CAT_TYPE] || '').toLowerCase();
            const isRental = acc === 'rental' || acc === 'rentals' || Boolean(r[COL_CAT_PROPERTY]);

            if (isRental) {
                const prop = r[COL_CAT_PROPERTY] || 'San Jacinto';
                const isIncome = flow === 'income' || (r[COL_CAT_CATEGORY] && r[COL_CAT_CATEGORY].trim().toLowerCase() === 'rent');
                rentalRows.push({
                    ...r,
                    property: prop,
                    category: r[COL_CAT_CATEGORY] || (isIncome ? 'Rent' : 'Expense'),
                    frequency: freq,
                    amount: amt,
                    notes: r[COL_CAT_NOTES] || '',
                    monthly_spend: monthly,
                    account_type: 'rental',
                    type: isIncome ? 'income' : 'spending'
                });
            } else if (acc === 'income' || flow === 'income') {
                incomeRows.push({
                    ...r,
                    category: r[COL_CAT_CATEGORY] || '',
                    frequency: freq,
                    amount: amt,
                    notes: r[COL_CAT_NOTES] || '',
                    monthly_spend: monthly,
                    account_type: 'income',
                    type: 'income'
                });
            } else if (acc === 'bank') {
                bankSpendRows.push({
                    ...r,
                    category: r[COL_CAT_CATEGORY] || '',
                    frequency: freq,
                    amount: amt,
                    notes: r[COL_CAT_NOTES] || '',
                    monthly_spend: monthly,
                    account_type: 'bank',
                    type: 'spending'
                });
            } else {
                spendRows.push({
                    ...r,
                    category: r[COL_CAT_CATEGORY] || '',
                    frequency: freq,
                    amount: amt,
                    notes: r[COL_CAT_NOTES] || '',
                    monthly_spend: monthly,
                    account_type: 'credit_cards',
                    type: 'spending'
                });
            }
        });
    } catch (err) {
        console.error('Error loading spending categories:', err);
        if (window.setStatus) window.setStatus('Could not load spending categories.');
        spendRows = [];
        bankSpendRows = [];
        incomeRows = [];
        rentalRows = [];
    }
}

// --- Credit Card Spending ---
async function addCategoryRow(data) {
    if (!sb) return;
    try {
        const freq = data.frequency || 'monthly';
        const amt = data.amount || 0;
        const monthly = computeMonthlySpend(amt, freq);
        const notes = data.notes || '';
        const payload = {
            [COL_CAT_CATEGORY]: data.category,
            [COL_CAT_FREQUENCY]: freq,
            [COL_CAT_AMOUNT]: amt,
            [COL_CAT_NOTES]: notes,
            [COL_CAT_MONTHLY_SPEND]: monthly,
            [COL_CAT_ACCOUNT_TYPE]: 'credit_cards',
            [COL_CAT_TYPE]: 'spending'
        };
        const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
        if (error) throw error;
        if (inserted) {
            spendRows.push({ ...inserted, frequency: freq, amount: amt, notes, monthly_spend: monthly, account_type: 'credit_cards', type: 'spending' });
            render();
        }
        if (window.setStatus) window.setStatus('Added credit card category.');
    } catch (err) {
        console.error('Could not add category:', err);
        if (window.setStatus) window.setStatus('Could not add category: ' + (err.message || err));
    }
}

async function updateCategoryRow(id, patch) {
    if (!sb) return;
    try {
        const row = spendRows.find(r => r.id === id);
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
    } catch (err) {
        console.error('Could not update category:', err);
        if (window.setStatus) window.setStatus('Could not update category.');
    }
}

async function deleteCategoryRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(CATEGORIES_TABLE).delete().eq(COL_CAT_ID, id);
        if (error) throw error;
        spendRows = spendRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted category.');
    } catch (err) {
        console.error('Could not delete category:', err);
        if (window.setStatus) window.setStatus('Could not delete category.');
    }
}

// --- Bank Account Spending ---
async function addBankSpendRow(data) {
    if (!sb) return;
    try {
        const freq = data.frequency || 'monthly';
        const amt = data.amount || 0;
        const monthly = computeMonthlySpend(amt, freq);
        const notes = data.notes || '';
        const payload = {
            [COL_CAT_CATEGORY]: data.category,
            [COL_CAT_FREQUENCY]: freq,
            [COL_CAT_AMOUNT]: amt,
            [COL_CAT_NOTES]: notes,
            [COL_CAT_MONTHLY_SPEND]: monthly,
            [COL_CAT_ACCOUNT_TYPE]: 'bank',
            [COL_CAT_TYPE]: 'spending'
        };
        const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
        if (error) throw error;
        if (inserted) {
            bankSpendRows.push({ ...inserted, frequency: freq, amount: amt, notes, monthly_spend: monthly, account_type: 'bank', type: 'spending' });
            render();
        }
        if (window.setStatus) window.setStatus('Added bank expense.');
    } catch (err) {
        console.error('Could not add bank expense:', err);
        if (window.setStatus) window.setStatus('Could not add bank expense: ' + (err.message || err));
    }
}

async function updateBankSpendRow(id, patch) {
    if (!sb) return;
    try {
        const row = bankSpendRows.find(r => r.id === id);
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
    } catch (err) {
        console.error('Could not update bank expense:', err);
        if (window.setStatus) window.setStatus('Could not update bank expense.');
    }
}

async function deleteBankSpendRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(CATEGORIES_TABLE).delete().eq(COL_CAT_ID, id);
        if (error) throw error;
        bankSpendRows = bankSpendRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted bank expense.');
    } catch (err) {
        console.error('Could not delete bank expense:', err);
        if (window.setStatus) window.setStatus('Could not delete bank expense.');
    }
}

// --- Income ---
async function addIncomeRow(data) {
    if (!sb) return;
    try {
        const freq = data.frequency || 'monthly';
        const amt = data.amount || 0;
        const monthly = computeMonthlySpend(amt, freq);
        const cat = data.category || data.source || '';
        const notes = data.notes || '';
        const payload = {
            [COL_CAT_CATEGORY]: cat,
            [COL_CAT_FREQUENCY]: freq,
            [COL_CAT_AMOUNT]: amt,
            [COL_CAT_NOTES]: notes,
            [COL_CAT_MONTHLY_SPEND]: monthly,
            [COL_CAT_ACCOUNT_TYPE]: 'income',
            [COL_CAT_TYPE]: 'income'
        };
        const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
        if (error) throw error;
        if (inserted) {
            incomeRows.push({ ...inserted, category: cat, frequency: freq, amount: amt, notes, monthly_spend: monthly, account_type: 'income', type: 'income' });
            render();
        }
        if (window.setStatus) window.setStatus('Added income source.');
    } catch (err) {
        console.error('Could not add income source:', err);
        if (window.setStatus) window.setStatus('Could not add income source: ' + (err.message || err));
    }
}

async function updateIncomeRow(id, patch) {
    if (!sb) return;
    try {
        const row = incomeRows.find(r => r.id === id);
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
    } catch (err) {
        console.error('Could not update income source:', err);
        if (window.setStatus) window.setStatus('Could not update income source.');
    }
}

async function deleteIncomeRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(CATEGORIES_TABLE).delete().eq(COL_CAT_ID, id);
        if (error) throw error;
        incomeRows = incomeRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted income source.');
    } catch (err) {
        console.error('Could not delete income source:', err);
        if (window.setStatus) window.setStatus('Could not delete income source.');
    }
}

// --- Rentals ---
async function setRentalRent(propertyName, rentAmount) {
    if (!sb) return;
    const val = parseFloat(rentAmount) || 0;
    let existing = rentalRows.find(r => r.property === propertyName && r.type === 'income');
    try {
        if (existing) {
            existing.amount = val;
            existing.monthly_spend = val;
            render();
            const { error } = await sb.from(CATEGORIES_TABLE).update({
                [COL_CAT_AMOUNT]: val,
                [COL_CAT_MONTHLY_SPEND]: val
            }).eq(COL_CAT_ID, existing.id);
            if (error) throw error;
        } else {
            const payload = {
                [COL_CAT_CATEGORY]: 'Rent',
                [COL_CAT_PROPERTY]: propertyName,
                [COL_CAT_FREQUENCY]: 'monthly',
                [COL_CAT_AMOUNT]: val,
                [COL_CAT_MONTHLY_SPEND]: val,
                [COL_CAT_ACCOUNT_TYPE]: 'rental',
                [COL_CAT_TYPE]: 'income'
            };
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
            if (error) throw error;
            if (inserted) {
                rentalRows.push({ ...inserted, property: propertyName, category: 'Rent', frequency: 'monthly', amount: val, monthly_spend: val, account_type: 'rental', type: 'income' });
                render();
            }
        }
        if (window.setStatus) window.setStatus(`Updated rent for ${propertyName}.`);
    } catch (err) {
        console.error('Could not save rental income:', err);
        if (window.setStatus) window.setStatus('Could not save rental income.');
    }
}

async function addRentalExpenseRow(propertyName, data) {
    if (!sb) return;
    try {
        const freq = data.frequency || 'monthly';
        const amt = data.amount || 0;
        const monthly = computeMonthlySpend(amt, freq);
        const notes = data.notes || '';
        const payload = {
            [COL_CAT_CATEGORY]: data.category,
            [COL_CAT_PROPERTY]: propertyName,
            [COL_CAT_FREQUENCY]: freq,
            [COL_CAT_AMOUNT]: amt,
            [COL_CAT_NOTES]: notes,
            [COL_CAT_MONTHLY_SPEND]: monthly,
            [COL_CAT_ACCOUNT_TYPE]: 'rental',
            [COL_CAT_TYPE]: 'spending'
        };
        const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
        if (error) throw error;
        if (inserted) {
            rentalRows.push({ ...inserted, property: propertyName, category: data.category, frequency: freq, amount: amt, notes, monthly_spend: monthly, account_type: 'rental', type: 'spending' });
            render();
        }
        if (window.setStatus) window.setStatus(`Added expense for ${propertyName}.`);
    } catch (err) {
        console.error('Could not add rental expense:', err);
        if (window.setStatus) window.setStatus('Could not add rental expense: ' + (err.message || err));
    }
}

async function updateRentalExpenseRow(id, patch) {
    if (!sb) return;
    try {
        const row = rentalRows.find(r => r.id === id);
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
    } catch (err) {
        console.error('Could not update rental expense:', err);
        if (window.setStatus) window.setStatus('Could not update rental expense.');
    }
}

async function deleteRentalRow(id) {
    if (!sb) return;
    try {
        const { error } = await sb.from(CATEGORIES_TABLE).delete().eq(COL_CAT_ID, id);
        if (error) throw error;
        rentalRows = rentalRows.filter(r => r.id !== id);
        render();
        if (window.setStatus) window.setStatus('Deleted rental entry.');
    } catch (err) {
        console.error('Could not delete rental entry:', err);
        if (window.setStatus) window.setStatus('Could not delete rental entry.');
    }
}

// -------------------------------------------------------------------
// Supabase CRUD — cards
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// Supabase CRUD — card rewards (category overrides)
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// Supabase CRUD — income tax
// -------------------------------------------------------------------
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
        row = {
            [COL_TAX_STREAM]: streamName,
            [COL_TAX_RATE]: 0,
            [COL_TAX_DEPRECIATION]: 0,
            [COL_TAX_MORTGAGE_INTEREST]: 0
        };
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
// Realtime sync (Consolidated table + cards + rewards + tax)
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
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
            return;
        }
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
const addCategoryBtn = document.getElementById('addCategoryBtn');
if (addCategoryBtn) {
    addCategoryBtn.addEventListener('click', () => {
        const catInput = document.getElementById('newCategory');
        const freqSelect = document.getElementById('newCategoryFrequency');
        const amountInput = document.getElementById('newCategoryAmount');
        const notesInput = document.getElementById('newCategoryNotes');
        const category = catInput.value.trim();
        const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
        const amount = parseFloat(amountInput.value) || 0;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!category) {
            if (window.setStatus) window.setStatus('Category name is required.');
            return;
        }
        addCategoryRow({ category, frequency, amount, notes });
        catInput.value = '';
        amountInput.value = '';
        if (notesInput) notesInput.value = '';
        if (freqSelect) freqSelect.value = 'monthly';
        catInput.focus();
    });
}

const addBankCategoryBtn = document.getElementById('addBankCategoryBtn');
if (addBankCategoryBtn) {
    addBankCategoryBtn.addEventListener('click', () => {
        const catInput = document.getElementById('newBankCategory');
        const freqSelect = document.getElementById('newBankCategoryFrequency');
        const amountInput = document.getElementById('newBankCategoryAmount');
        const notesInput = document.getElementById('newBankCategoryNotes');
        const category = catInput.value.trim();
        const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
        const amount = parseFloat(amountInput.value) || 0;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!category) {
            if (window.setStatus) window.setStatus('Expense name is required.');
            return;
        }
        addBankSpendRow({ category, frequency, amount, notes });
        catInput.value = '';
        amountInput.value = '';
        if (notesInput) notesInput.value = '';
        if (freqSelect) freqSelect.value = 'monthly';
        catInput.focus();
    });
}

const addIncomeBtn = document.getElementById('addIncomeBtn');
if (addIncomeBtn) {
    addIncomeBtn.addEventListener('click', () => {
        const sourceInput = document.getElementById('newIncomeSource');
        const freqSelect = document.getElementById('newIncomeFrequency');
        const amountInput = document.getElementById('newIncomeAmount');
        const notesInput = document.getElementById('newIncomeNotes');
        const source = sourceInput.value.trim();
        const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
        const amount = parseFloat(amountInput.value) || 0;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!source) {
            if (window.setStatus) window.setStatus('Income source is required.');
            return;
        }
        addIncomeRow({ category: source, frequency, amount, notes });
        sourceInput.value = '';
        amountInput.value = '';
        if (notesInput) notesInput.value = '';
        if (freqSelect) freqSelect.value = 'monthly';
        sourceInput.focus();
    });
}

const sanJacintoRentInput = document.getElementById('sanJacintoRentInput');
if (sanJacintoRentInput) {
    sanJacintoRentInput.addEventListener('change', () => {
        setRentalRent('San Jacinto', sanJacintoRentInput.value);
    });
}

const sanJacintoAddCategoryBtn = document.getElementById('sanJacintoAddCategoryBtn');
if (sanJacintoAddCategoryBtn) {
    sanJacintoAddCategoryBtn.addEventListener('click', () => {
        const catInput = document.getElementById('sanJacintoNewCategory');
        const freqSelect = document.getElementById('sanJacintoNewCategoryFrequency');
        const amountInput = document.getElementById('sanJacintoNewCategoryAmount');
        const notesInput = document.getElementById('sanJacintoNewCategoryNotes');
        const category = catInput.value.trim();
        const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
        const amount = parseFloat(amountInput.value) || 0;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!category) {
            if (window.setStatus) window.setStatus('Expense category is required.');
            return;
        }
        addRentalExpenseRow('San Jacinto', { category, frequency, amount, notes });
        catInput.value = '';
        amountInput.value = '';
        if (notesInput) notesInput.value = '';
        if (freqSelect) freqSelect.value = 'monthly';
        catInput.focus();
    });
}

['sanJacintoDepreciation', 'sanJacintoMortgageInterest', 'sanJacintoTaxRate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
        input.addEventListener('change', () => {
            const dep = parseFloat(document.getElementById('sanJacintoDepreciation')?.value) || 0;
            const mortgage = parseFloat(document.getElementById('sanJacintoMortgageInterest')?.value) || 0;
            const rate = parseFloat(document.getElementById('sanJacintoTaxRate')?.value) || 0;
            updateTaxRow('San Jacinto', {
                [COL_TAX_DEPRECIATION]: dep,
                [COL_TAX_MORTGAGE_INTEREST]: mortgage,
                [COL_TAX_RATE]: rate
            });
        });
    }
});

const countyLineRentInput = document.getElementById('countyLineRentInput');
if (countyLineRentInput) {
    countyLineRentInput.addEventListener('change', () => {
        setRentalRent('County Line', countyLineRentInput.value);
    });
}

const countyLineAddCategoryBtn = document.getElementById('countyLineAddCategoryBtn');
if (countyLineAddCategoryBtn) {
    countyLineAddCategoryBtn.addEventListener('click', () => {
        const catInput = document.getElementById('countyLineNewCategory');
        const freqSelect = document.getElementById('countyLineNewCategoryFrequency');
        const amountInput = document.getElementById('countyLineNewCategoryAmount');
        const notesInput = document.getElementById('countyLineNewCategoryNotes');
        const category = catInput.value.trim();
        const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
        const amount = parseFloat(amountInput.value) || 0;
        const notes = notesInput ? notesInput.value.trim() : '';
        if (!category) {
            if (window.setStatus) window.setStatus('Expense category is required.');
            return;
        }
        addRentalExpenseRow('County Line', { category, frequency, amount, notes });
        catInput.value = '';
        amountInput.value = '';
        if (notesInput) notesInput.value = '';
        if (freqSelect) freqSelect.value = 'monthly';
        catInput.focus();
    });
}

['countyLineDepreciation', 'countyLineMortgageInterest', 'countyLineTaxRate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
        input.addEventListener('change', () => {
            const dep = parseFloat(document.getElementById('countyLineDepreciation')?.value) || 0;
            const mortgage = parseFloat(document.getElementById('countyLineMortgageInterest')?.value) || 0;
            const rate = parseFloat(document.getElementById('countyLineTaxRate')?.value) || 0;
            updateTaxRow('County Line', {
                [COL_TAX_DEPRECIATION]: dep,
                [COL_TAX_MORTGAGE_INTEREST]: mortgage,
                [COL_TAX_RATE]: rate
            });
        });
    }
});

const addCardBtn = document.getElementById('addCardBtn');
if (addCardBtn) {
    addCardBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('newCardName');
        const feeInput = document.getElementById('newCardFee');
        const baseRateInput = document.getElementById('newCardBaseRate');

        const name = nameInput.value.trim();
        const annual_fee = parseFloat(feeInput.value) || 0;
        const base_rate = parseFloat(baseRateInput.value) || 0;

        if (!name) {
            if (window.setStatus) window.setStatus('Card name is required.');
            return;
        }

        addCardRow({ name, annual_fee, base_rate });
        nameInput.value = '';
        feeInput.value = '';
        baseRateInput.value = '';
        nameInput.focus();
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
        const rate = parseFloat(rateInput.value) || 0;
        const special_refund = parseFloat(refundInput.value) || 0;

        if (!card) {
            if (window.setStatus) window.setStatus("Choose a card first — add one above if it's not listed yet.");
            return;
        }
        if (!category) {
            if (window.setStatus) window.setStatus('Category is required for a reward override.');
            return;
        }

        addRewardRow({ card_id: card, category, rate, special_refund });
        catInput.value = '';
        rateInput.value = '';
        refundInput.value = '';
        catInput.focus();
    });
}

const cardASelect = document.getElementById('cardASelect');
const cardBSelect = document.getElementById('cardBSelect');
if (cardASelect) cardASelect.addEventListener('change', renderComparison);
if (cardBSelect) cardBSelect.addEventListener('change', renderComparison);

// -------------------------------------------------------------------
// Tabs Navigation — hash-routed to match the Lists page's pattern
// -------------------------------------------------------------------
const TAB_KEYS = ['budget', 'comparison', 'rental'];

function tabFromHash() {
    const key = location.hash.slice(1);
    return TAB_KEYS.includes(key) ? key : TAB_KEYS[0];
}

function switchTab(tabKey) {
    const tabBtns = document.querySelectorAll('#cc-tabs .tab');
    tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabKey);
    });

    const budgetPane = document.getElementById('tab-budget');
    const comparisonPane = document.getElementById('tab-comparison');
    const rentalPane = document.getElementById('tab-rental');
    if (budgetPane) budgetPane.hidden = tabKey !== 'budget';
    if (comparisonPane) comparisonPane.hidden = tabKey !== 'comparison';
    if (rentalPane) rentalPane.hidden = tabKey !== 'rental';
}

function setupTabs() {
    const tabsContainer = document.getElementById('cc-tabs');
    if (!tabsContainer) return;
    tabsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (btn && btn.dataset.tab) {
            location.hash = btn.dataset.tab;
        }
    });
    window.addEventListener('hashchange', () => switchTab(tabFromHash()));
    switchTab(tabFromHash());
}

setupTabs();

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const targetId = e.target.id;
        if (['newCategory', 'newCategoryAmount', 'newCategoryNotes'].includes(targetId)) {
            if (addCategoryBtn) addCategoryBtn.click();
        } else if (['newBankCategory', 'newBankCategoryAmount', 'newBankCategoryNotes'].includes(targetId)) {
            if (addBankCategoryBtn) addBankCategoryBtn.click();
        } else if (['newIncomeSource', 'newIncomeAmount', 'newIncomeNotes'].includes(targetId)) {
            if (addIncomeBtn) addIncomeBtn.click();
        } else if (['sanJacintoRentInput'].includes(targetId)) {
            if (sanJacintoRentInput) sanJacintoRentInput.blur();
        } else if (['sanJacintoNewCategory', 'sanJacintoNewCategoryAmount', 'sanJacintoNewCategoryNotes'].includes(targetId)) {
            if (sanJacintoAddCategoryBtn) sanJacintoAddCategoryBtn.click();
        } else if (['countyLineRentInput'].includes(targetId)) {
            if (countyLineRentInput) countyLineRentInput.blur();
        } else if (['countyLineNewCategory', 'countyLineNewCategoryAmount', 'countyLineNewCategoryNotes'].includes(targetId)) {
            if (countyLineAddCategoryBtn) countyLineAddCategoryBtn.click();
        } else if (['sanJacintoDepreciation', 'sanJacintoMortgageInterest', 'sanJacintoTaxRate', 'countyLineDepreciation', 'countyLineMortgageInterest', 'countyLineTaxRate'].includes(targetId)) {
            if (e.target && typeof e.target.blur === 'function') e.target.blur();
        } else if (['newCardName', 'newCardFee', 'newCardBaseRate'].includes(targetId)) {
            if (addCardBtn) addCardBtn.click();
        } else if (['newRewardCategory', 'newRate', 'newSpecialRefund'].includes(targetId)) {
            if (addRewardBtn) addRewardBtn.click();
        }
    }
});

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------
if (window.initAppPage) {
    window.initAppPage(loadAll);
} else {
    document.addEventListener('app:ready', loadAll, { once: true });
}
