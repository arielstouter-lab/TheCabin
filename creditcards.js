(function () {
    const sb = window.supabaseClient;
    const CATEGORIES_TABLE = 'income_expense_categories';
    const CARDS_TABLE = 'credit_cards';
    const REWARDS_TABLE = 'card_rewards';

    // Categories Table Columns
    const COL_CAT_ID = 'id';
    const COL_CAT_CATEGORY = 'category';
    const COL_CAT_FREQUENCY = 'frequency';
    const COL_CAT_AMOUNT = 'amount';
    const COL_CAT_MONTHLY_SPEND = 'monthly_spend';
    const COL_CAT_ACCOUNT_TYPE = 'account_type';
    const COL_CAT_TYPE = 'type';
    const COL_CAT_PROPERTY = 'property';
    const COL_CAT_CREATED_AT = 'created_at';

    // Credit Cards Table Columns
    const COL_CARD_ID = 'id';
    const COL_CARD_CREATED_AT = 'created_at';

    // Card Rewards Table Columns
    const COL_REWARD_ID = 'id';
    const COL_REWARD_CREATED_AT = 'created_at';

    const RENTAL_PROPERTIES = ['San Jacinto', 'County Line'];

    let spendRows = [];       // {id, category, frequency, amount, monthly_spend, account_type: 'credit_cards', type: 'spending'}
    let bankSpendRows = [];   // {id, category, frequency, amount, monthly_spend, account_type: 'bank', type: 'spending'}
    let incomeRows = [];      // {id, category, frequency, amount, monthly_spend, account_type: 'income', type: 'income'}
    let rentalRows = [];      // {id, property, category, frequency, amount, monthly_spend, account_type: 'rental', type: 'income'|'spending'}
    let cardsRows = [];       // {id, name, annual_fee, base_rate}
    let rewardRows = [];      // {id, card_id, category, rate, special_refund}

    let realtimeChannel = null;
    let realtimeDebounceTimer = null;

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function fmt$(n) {
        const val = typeof n === 'number' && !isNaN(n) ? n : 0;
        const sign = val < 0 ? '-' : '';
        const absVal = Math.abs(val);
        return sign + '$' + (Math.round(absVal * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function calcMonthlyAmount(amount, frequency) {
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

    function frequencyOptionsHtml(selectedFreq) {
        const freq = String(selectedFreq || 'monthly').toLowerCase();
        const options = [
            { value: 'monthly', label: 'Monthly' },
            { value: 'semimonthly', label: 'Semimonthly (twice a month)' },
            { value: 'biweekly', label: 'Biweekly (every other week)' },
            { value: 'annual', label: 'Annual' }
        ];
        return options.map(opt =>
            `<option value="${opt.value}"${opt.value === freq ? ' selected' : ''}>${opt.label}</option>`
        ).join('');
    }

    // -------------------------------------------------------------------
    // Rental Helpers
    // -------------------------------------------------------------------
    function getRentalRent(propertyName) {
        const rentRow = rentalRows.find(r => r.property === propertyName && r.type === 'income');
        if (!rentRow) return 0;
        const amt = rentRow.amount !== undefined && rentRow.amount !== null ? rentRow.amount : (rentRow.monthly_spend || 0);
        return calcMonthlyAmount(amt, rentRow.frequency);
    }

    function getRentalExpenses(propertyName) {
        return rentalRows.filter(r => r.property === propertyName && r.type === 'spending');
    }

    function getRentalTotalExpenses(propertyName) {
        const expenses = getRentalExpenses(propertyName);
        return expenses.reduce((sum, r) => {
            const amt = r.amount !== undefined && r.amount !== null ? r.amount : (r.monthly_spend || 0);
            return sum + calcMonthlyAmount(amt, r.frequency);
        }, 0);
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

        body.innerHTML = '';
        if (empty) empty.style.display = spendRows.length ? 'none' : 'block';

        spendRows.forEach(row => {
            const tr = document.createElement('tr');
            const freq = row.frequency || 'monthly';
            const amt = row.amount !== undefined && row.amount !== null ? row.amount : (row.monthly_spend ?? 0);
            const monthly = calcMonthlyAmount(amt, freq);
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.category || row.name || '')}" data-field="category" style="width: 100%; min-width: 130px;"></td>
              <td><select class="text-input" data-field="frequency" style="width: 100%; min-width: 140px;">${frequencyOptionsHtml(freq)}</select></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="any" value="${amt}" data-field="amount" style="width: 100%; min-width: 90px;"></div></td>
              <td class="col-num"><span style="font-weight: 600; color: var(--ink); white-space: nowrap;">${fmt$(monthly)}</span></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete category">✕</button></td>
            `;
            tr.querySelectorAll('input, select').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'amount') val = parseFloat(val) || 0;
                    updateCategoryRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteCategoryRow(row.id));
            body.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------
    // Grid 1b: Bank Account Spending
    // -------------------------------------------------------------------
    function renderBankSpendGrid() {
        const body = document.getElementById('bankSpendGridBody');
        const empty = document.getElementById('bankSpendGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        if (empty) empty.style.display = bankSpendRows.length ? 'none' : 'block';

        bankSpendRows.forEach(row => {
            const tr = document.createElement('tr');
            const freq = row.frequency || 'monthly';
            const amt = row.amount !== undefined && row.amount !== null ? row.amount : (row.monthly_spend ?? 0);
            const monthly = calcMonthlyAmount(amt, freq);
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.category || row.name || '')}" data-field="category" style="width: 100%; min-width: 130px;"></td>
              <td><select class="text-input" data-field="frequency" style="width: 100%; min-width: 140px;">${frequencyOptionsHtml(freq)}</select></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="any" value="${amt}" data-field="amount" style="width: 100%; min-width: 90px;"></div></td>
              <td class="col-num"><span style="font-weight: 600; color: var(--ink); white-space: nowrap;">${fmt$(monthly)}</span></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete expense">✕</button></td>
            `;
            tr.querySelectorAll('input, select').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'amount') val = parseFloat(val) || 0;
                    updateBankSpendRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteBankSpendRow(row.id));
            body.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------
    // Grid 1c: Income (with non-editable monthly rental profit lines)
    // -------------------------------------------------------------------
    function renderIncomeGrid() {
        const body = document.getElementById('incomeGridBody');
        const empty = document.getElementById('incomeGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        const totalSources = incomeRows.length + RENTAL_PROPERTIES.length;
        if (empty) empty.style.display = totalSources ? 'none' : 'block';

        // 1. Regular household income rows (editable)
        incomeRows.forEach(row => {
            const tr = document.createElement('tr');
            const freq = row.frequency || 'monthly';
            const amt = row.amount !== undefined && row.amount !== null ? row.amount : (row.monthly_spend ?? 0);
            const monthly = calcMonthlyAmount(amt, freq);
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.category || '')}" data-field="category" style="width: 100%; min-width: 130px;"></td>
              <td><select class="text-input" data-field="frequency" style="width: 100%; min-width: 140px;">${frequencyOptionsHtml(freq)}</select></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="any" value="${amt}" data-field="amount" style="width: 100%; min-width: 90px;"></div></td>
              <td class="col-num"><span style="font-weight: 600; color: var(--ink); white-space: nowrap;">${fmt$(monthly)}</span></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete income source">✕</button></td>
            `;
            tr.querySelectorAll('input, select').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'amount') val = parseFloat(val) || 0;
                    updateIncomeRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteIncomeRow(row.id));
            body.appendChild(tr);
        });

        // 2. Non-editable rental property profit/loss lines
        RENTAL_PROPERTIES.forEach(property => {
            const profit = getRentalProfit(property);
            const isProfit = profit >= 0;
            const tr = document.createElement('tr');
            tr.className = 'rental-income-row';
            tr.style.background = 'rgba(0, 0, 0, 0.015)';
            tr.innerHTML = `
              <td>
                <span style="font-weight: 600; color: var(--ink); display: inline-flex; align-items: center; gap: 6px;">
                  ${escapeHtml(property)}
                  <span style="font-size: 10.5px; font-weight: normal; color: var(--ink-soft); background: var(--paper); border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px;">Rental ${isProfit ? 'Profit' : 'Loss'}</span>
                </span>
              </td>
              <td><span style="font-size: 13px; color: var(--ink-soft);">Monthly</span></td>
              <td class="col-num"><span style="font-weight: 600; color: ${isProfit ? 'var(--ink)' : 'var(--danger, #c0392b)'};">${fmt$(profit)}</span></td>
              <td class="col-num"><span style="font-weight: 600; color: ${isProfit ? 'var(--ink)' : 'var(--danger, #c0392b)'}; white-space: nowrap;">${fmt$(profit)}</span></td>
              <td class="col-action"><span style="font-size: 11px; color: var(--ink-soft); cursor: default;" title="Calculated from Rentals tab — non-editable">🔒</span></td>
            `;
            body.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------
    // Grid 1d: Budget Balance (Total Income - Total Spending = Balance)
    // -------------------------------------------------------------------
    function renderBalanceSummary() {
        const container = document.getElementById('balanceSummaryGrid');
        if (!container) return;

        const totalCcSpend = spendRows.reduce((sum, r) => {
            const amt = r.amount !== undefined && r.amount !== null ? r.amount : (r.monthly_spend || 0);
            return sum + calcMonthlyAmount(amt, r.frequency);
        }, 0);
        const totalBankSpend = bankSpendRows.reduce((sum, r) => {
            const amt = r.amount !== undefined && r.amount !== null ? r.amount : (r.monthly_spend || 0);
            return sum + calcMonthlyAmount(amt, r.frequency);
        }, 0);
        const totalSpending = totalCcSpend + totalBankSpend;

        const regularIncome = incomeRows.reduce((sum, r) => {
            const amt = r.amount !== undefined && r.amount !== null ? r.amount : (r.monthly_spend || 0);
            return sum + calcMonthlyAmount(amt, r.frequency);
        }, 0);
        const rentalProfits = RENTAL_PROPERTIES.reduce((sum, prop) => sum + getRentalProfit(prop), 0);
        const totalIncome = regularIncome + rentalProfits;

        const netBalance = totalIncome - totalSpending;

        const annualIncome = totalIncome * 12;
        const annualSpending = totalSpending * 12;
        const annualBalance = netBalance * 12;

        const isSurplus = netBalance >= 0;
        const statusClass = isSurplus ? 'surplus' : 'deficit';
        const statusText = isSurplus ? 'Surplus' : 'Deficit';

        container.innerHTML = `
          <div class="summary-card">
            <div class="label">Total Income</div>
            <div class="value">${fmt$(totalIncome)}<span class="combo-unit">/mo</span></div>
            <div class="foot">${fmt$(annualIncome)}/yr &middot; across ${incomeRows.length} source${incomeRows.length === 1 ? '' : 's'} + ${RENTAL_PROPERTIES.length} rental${RENTAL_PROPERTIES.length === 1 ? '' : 's'}</div>
          </div>
          <div class="summary-card">
            <div class="label">Total Spending</div>
            <div class="value">${fmt$(totalSpending)}<span class="combo-unit">/mo</span></div>
            <div class="foot">CC: ${fmt$(totalCcSpend)}/mo &middot; Bank: ${fmt$(totalBankSpend)}/mo &middot; ${fmt$(annualSpending)}/yr</div>
          </div>
          <div class="summary-card ${statusClass}">
            <div class="label">Net Balance (${statusText})</div>
            <div class="value">${fmt$(netBalance)}<span class="combo-unit">/mo</span></div>
            <div class="foot">Income (${fmt$(totalIncome)}) &minus; Spending (${fmt$(totalSpending)}) = ${fmt$(netBalance)}/mo (${fmt$(annualBalance)}/yr)</div>
          </div>
        `;
    }

    // -------------------------------------------------------------------
    // Tab 3: Rentals (San Jacinto & County Line)
    // -------------------------------------------------------------------
    function renderRentals() {
        renderPropertySection('San Jacinto', {
            rentInputId: 'sanJacintoRentInput',
            spendGridBodyId: 'sanJacintoSpendGridBody',
            spendGridEmptyId: 'sanJacintoSpendGridEmpty',
            profitSummaryId: 'sanJacintoProfitSummary'
        });

        renderPropertySection('County Line', {
            rentInputId: 'countyLineRentInput',
            spendGridBodyId: 'countyLineSpendGridBody',
            spendGridEmptyId: 'countyLineSpendGridEmpty',
            profitSummaryId: 'countyLineProfitSummary'
        });
    }

    function renderPropertySection(propertyName, elements) {
        // 1. Rent input at top
        const rentInput = document.getElementById(elements.rentInputId);
        const rentRow = rentalRows.find(r => r.property === propertyName && r.type === 'income');
        const rentVal = rentRow ? (rentRow.amount !== undefined && rentRow.amount !== null ? rentRow.amount : (rentRow.monthly_spend || 0)) : 0;
        if (rentInput && document.activeElement !== rentInput) {
            rentInput.value = rentVal ? rentVal : '';
        }

        // 2. Expenses Grid
        const body = document.getElementById(elements.spendGridBodyId);
        const empty = document.getElementById(elements.spendGridEmptyId);
        const expenses = getRentalExpenses(propertyName);

        if (body) {
            body.innerHTML = '';
            if (empty) empty.style.display = expenses.length ? 'none' : 'block';

            expenses.forEach(row => {
                const tr = document.createElement('tr');
                const freq = row.frequency || 'monthly';
                const amt = row.amount !== undefined && row.amount !== null ? row.amount : (row.monthly_spend ?? 0);
                const monthly = calcMonthlyAmount(amt, freq);
                tr.innerHTML = `
                  <td><input type="text" class="text-input" value="${escapeHtml(row.category || row.name || '')}" data-field="category" style="width: 100%; min-width: 130px;"></td>
                  <td><select class="text-input" data-field="frequency" style="width: 100%; min-width: 140px;">${frequencyOptionsHtml(freq)}</select></td>
                  <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="any" value="${amt}" data-field="amount" style="width: 100%; min-width: 90px;"></div></td>
                  <td class="col-num"><span style="font-weight: 600; color: var(--ink); white-space: nowrap;">${fmt$(monthly)}</span></td>
                  <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete expense">✕</button></td>
                `;
                tr.querySelectorAll('input, select').forEach(input => {
                    input.addEventListener('change', () => {
                        const field = input.dataset.field;
                        let val = input.value;
                        if (field === 'amount') val = parseFloat(val) || 0;
                        updateRentalExpenseRow(row.id, { [field]: val });
                    });
                });
                const delBtn = tr.querySelector('.icon-delete');
                if (delBtn) delBtn.addEventListener('click', () => deleteRentalRow(row.id));
                body.appendChild(tr);
            });
        }

        // 3. Profit Total at the bottom
        const summary = document.getElementById(elements.profitSummaryId);
        if (summary) {
            const rent = getRentalRent(propertyName);
            const totalExpenses = getRentalTotalExpenses(propertyName);
            const profit = rent - totalExpenses;
            const annualProfit = profit * 12;
            const isProfit = profit >= 0;
            const statusClass = isProfit ? 'surplus' : 'deficit';
            const statusText = isProfit ? 'Net Profit' : 'Net Loss';

            summary.innerHTML = `
              <div class="summary-card">
                <div class="label">Monthly Rent (Income)</div>
                <div class="value">${fmt$(rent)}<span class="combo-unit">/mo</span></div>
                <div class="foot">${fmt$(rent * 12)}/yr</div>
              </div>
              <div class="summary-card">
                <div class="label">Total Expenses</div>
                <div class="value">${fmt$(totalExpenses)}<span class="combo-unit">/mo</span></div>
                <div class="foot">${fmt$(totalExpenses * 12)}/yr across ${expenses.length} expense${expenses.length === 1 ? '' : 's'}</div>
              </div>
              <div class="summary-card ${statusClass}">
                <div class="label">${statusText}</div>
                <div class="value">${fmt$(profit)}<span class="combo-unit">/mo</span></div>
                <div class="foot">Rent (${fmt$(rent)}) &minus; Expenses (${fmt$(totalExpenses)}) = ${fmt$(profit)}/mo (${fmt$(annualProfit)}/yr)</div>
              </div>
            `;
        }
    }

    // -------------------------------------------------------------------
    // Grid 2: Credit Cards (name, annual fee, base rate)
    // -------------------------------------------------------------------
    function renderCardsGrid() {
        const body = document.getElementById('cardsGridBody');
        const empty = document.getElementById('cardsGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        if (empty) empty.style.display = cardsRows.length ? 'none' : 'block';

        cardsRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.name)}" data-field="name" style="width: 100%; min-width: 140px;"></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.annual_fee ?? 0}" data-field="annual_fee" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-num"><div class="num-wrap pct"><input type="number" class="text-input" min="0" step="0.1" value="${row.base_rate ?? 0}" data-field="base_rate" style="width: 100%; min-width: 70px;"></div></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete card">✕</button></td>
            `;
            tr.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'annual_fee' || field === 'base_rate') val = parseFloat(val) || 0;
                    updateCardRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteCardRow(row.id));
            body.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------
    // Grid 3: Card Rewards (category-specific overrides)
    // -------------------------------------------------------------------
    function cardOptionsHtml(selectedId) {
        return '<option value="">Choose a card…</option>' + cardsRows.map(c =>
            `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
        ).join('');
    }

    function renderRewardsGrid() {
        const body = document.getElementById('rewardsGridBody');
        const empty = document.getElementById('rewardsGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        if (empty) empty.style.display = rewardRows.length ? 'none' : 'block';

        rewardRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><select class="text-input" data-field="card_id" style="width: 100%; min-width: 130px;">${cardOptionsHtml(row.card_id)}</select></td>
              <td><input type="text" class="text-input" value="${escapeHtml(row.category)}" data-field="category" style="width: 100%; min-width: 120px;"></td>
              <td class="col-num"><div class="num-wrap pct"><input type="number" class="text-input" min="0" step="0.1" value="${row.rate ?? 0}" data-field="rate" style="width: 100%; min-width: 70px;"></div></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.special_refund ?? 0}" data-field="special_refund" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete row">✕</button></td>
            `;
            tr.querySelectorAll('input, select').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'rate' || field === 'special_refund') val = parseFloat(val) || 0;
                    updateRewardRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteRewardRow(row.id));
            body.appendChild(tr);
        });
    }

    function renderCardOptions() {
        const newRewardCard = document.getElementById('newRewardCard');
        if (newRewardCard) {
            const current = newRewardCard.value;
            newRewardCard.innerHTML = cardOptionsHtml('');
            const ids = cardsRows.map(c => c.id);
            if (ids.includes(current)) newRewardCard.value = current;
        }

        const sortedCards = [...cardsRows].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const aSel = document.getElementById('cardASelect');
        const bSel = document.getElementById('cardBSelect');
        if (!aSel || !bSel) return;

        [aSel, bSel].forEach(sel => {
            const current = sel.value;
            sel.innerHTML = '<option value="">Choose a card…</option>' + sortedCards.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
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
                    const amt = catRow.amount !== undefined && catRow.amount !== null ? catRow.amount : (catRow.monthly_spend || 0);
                    const spend = calcMonthlyAmount(amt, catRow.frequency);
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
                    bestCombo = {
                        cardA,
                        cardB,
                        grossTotal,
                        aFee,
                        bFee,
                        combinedMonthlyFee,
                        netMonthly,
                        netAnnual
                    };
                }
            }
        }

        return bestCombo;
    }

    function renderBestCombo() {
        const container = document.getElementById('bestComboContainer');
        if (!container) return;

        if (cardsRows.length < 2 || !spendRows.length) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        const combo = findBestTwoCardCombo();
        if (!combo) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        container.innerHTML = `
          <div class="best-combo-card">
            <div class="combo-info">
              <span class="combo-tag">Top 2-Card Combination</span>
              <div class="combo-title">${escapeHtml(combo.cardA.name)} + ${escapeHtml(combo.cardB.name)}</div>
              <div class="combo-sub">
                Gross rewards ${fmt$(combo.grossTotal)}/mo &middot; Combined fees ${fmt$(combo.aFee + combo.bFee)}/yr (${fmt$(combo.combinedMonthlyFee)}/mo)
              </div>
            </div>
            <div class="combo-value-wrap">
              <div class="combo-value">${fmt$(combo.netMonthly)}<span class="combo-unit">/mo net</span></div>
              <div class="combo-value-sub">${fmt$(combo.netAnnual)}/yr net</div>
              <button type="button" class="button-inline" id="loadBestComboBtn" style="margin-top: 6px; font-size: 12px; padding: 4px 10px;">Compare this pair</button>
            </div>
          </div>
        `;

        const loadBtn = document.getElementById('loadBestComboBtn');
        if (loadBtn) {
            loadBtn.addEventListener('click', () => {
                const aSel = document.getElementById('cardASelect');
                const bSel = document.getElementById('cardBSelect');
                if (aSel && bSel) {
                    aSel.value = combo.cardA.id;
                    bSel.value = combo.cardB.id;
                    renderComparison();
                }
            });
        }
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
        const compareTable = document.getElementById('compareTable');
        const compareTableWrap = document.getElementById('compareTableWrap');
        const compareEmpty = document.getElementById('compareEmpty');
        const summaryGrid = document.getElementById('summaryGrid');

        if (!aId || !bId || aId === bId || !spendRows.length) {
            if (compareTableWrap) compareTableWrap.style.display = 'none';
            else if (compareTable) compareTable.style.display = 'none';
            if (summaryGrid) summaryGrid.style.display = 'none';
            if (compareEmpty) {
                compareEmpty.style.display = 'block';
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

        if (compareEmpty) compareEmpty.style.display = 'none';
        if (compareTableWrap) compareTableWrap.style.display = 'block';
        if (compareTable) compareTable.style.display = 'table';
        if (summaryGrid) summaryGrid.style.display = 'grid';

        const headA = document.getElementById('headA');
        const headB = document.getElementById('headB');
        if (headA) headA.textContent = aName;
        if (headB) headB.textContent = bName;

        const aFee = getAnnualFee(aId);
        const bFee = getAnnualFee(bId);

        let aTotal = 0, bTotal = 0, bestTotal = 0;
        const tbody = document.getElementById('compareBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const categoryResults = spendRows.map(catRow => {
            const cat = catRow.category;
            const amt = catRow.amount !== undefined && catRow.amount !== null ? catRow.amount : (catRow.monthly_spend || 0);
            const spend = calcMonthlyAmount(amt, catRow.frequency);
            const a = getEffectiveRate(aId, cat);
            const b = getEffectiveRate(bId, cat);
            const aReward = (spend * a.rate / 100) + a.refund;
            const bReward = (spend * b.rate / 100) + b.refund;
            return { cat, spend, a, b, aReward, bReward, best: Math.max(aReward, bReward) };
        });

        categoryResults.sort((x, y) => y.best - x.best);

        categoryResults.forEach(({ cat, spend, a, b, aReward, bReward }) => {
            aTotal += aReward;
            bTotal += bReward;
            bestTotal += Math.max(aReward, bReward);

            let winnerHtml;
            if (a.none && b.none) winnerHtml = `<span class="tie">No rate set</span>`;
            else if (aReward > bReward) winnerHtml = `<span class="win-a">${escapeHtml(aName)}</span><span class="badge a">+${fmt$(aReward - bReward)}</span>`;
            else if (bReward > aReward) winnerHtml = `<span class="win-b">${escapeHtml(bName)}</span><span class="badge b">+${fmt$(bReward - aReward)}</span>`;
            else winnerHtml = `<span class="tie">Tie</span>`;

            const aCell = a.none ? '<span class="empty-state">no rate</span>' : `${a.rate.toFixed(1)}%${a.isDefault ? ' <span class="empty-state">(base)</span>' : ''} &rarr; ${fmt$(aReward)}${a.refund ? ' <span class="empty-state">(incl. ' + fmt$(a.refund) + ' refund)</span>' : ''}`;
            const bCell = b.none ? '<span class="empty-state">no rate</span>' : `${b.rate.toFixed(1)}%${b.isDefault ? ' <span class="empty-state">(base)</span>' : ''} &rarr; ${fmt$(bReward)}${b.refund ? ' <span class="empty-state">(incl. ' + fmt$(b.refund) + ' refund)</span>' : ''}`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${escapeHtml(cat)}</td>
              <td class="col-num">${fmt$(spend)}</td>
              <td class="col-num">${aCell}</td>
              <td class="col-num">${bCell}</td>
              <td>${winnerHtml}</td>
            `;
            tbody.appendChild(tr);
        });

        if (summaryGrid) {
            const aNet = aTotal - aFee / 12;
            const bNet = bTotal - bFee / 12;
            const bestNet = bestTotal - (aFee + bFee) / 12;
            summaryGrid.innerHTML = `
            <div class="summary-card">
              <div class="label">${escapeHtml(aName)}</div>
              <div class="value">${fmt$(aNet)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo net</span></div>
              <div class="foot">Rewards ${fmt$(aTotal)}/mo &middot; Annual fee ${fmt$(aFee)} (${fmt$(aFee / 12)}/mo) &middot; Net ${fmt$(aNet)}/mo</div>
            </div>
            <div class="summary-card">
              <div class="label">${escapeHtml(bName)}</div>
              <div class="value">${fmt$(bNet)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo net</span></div>
              <div class="foot">Rewards ${fmt$(bTotal)}/mo &middot; Annual fee ${fmt$(bFee)} (${fmt$(bFee / 12)}/mo) &middot; Net ${fmt$(bNet)}/mo</div>
            </div>
            <div class="summary-card best">
              <div class="label">Best of Both (optimal routing)</div>
              <div class="value">${fmt$(bestNet)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo net</span></div>
              <div class="foot">Rewards ${fmt$(bestTotal)}/mo if you used whichever card wins each category &middot; minus ${fmt$((aFee + bFee) / 12)}/mo combined fees = ${fmt$(bestNet)}/mo</div>
            </div>
          `;
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
                const monthly = calcMonthlyAmount(amt, freq);

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
                        monthly_spend: monthly,
                        account_type: 'bank',
                        type: 'spending'
                    });
                } else {
                    // Default to credit card category
                    spendRows.push({
                        ...r,
                        category: r[COL_CAT_CATEGORY] || '',
                        frequency: freq,
                        amount: amt,
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
            const monthly = calcMonthlyAmount(amt, freq);
            const payload = {
                [COL_CAT_CATEGORY]: data.category,
                [COL_CAT_FREQUENCY]: freq,
                [COL_CAT_AMOUNT]: amt,
                [COL_CAT_MONTHLY_SPEND]: monthly,
                [COL_CAT_ACCOUNT_TYPE]: 'credit_cards',
                [COL_CAT_TYPE]: 'spending'
            };
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
            if (error) throw error;
            if (inserted) {
                spendRows.push({
                    ...inserted,
                    frequency: freq,
                    amount: amt,
                    monthly_spend: monthly,
                    account_type: 'credit_cards',
                    type: 'spending'
                });
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
                row.monthly_spend = calcMonthlyAmount(row.amount, row.frequency);
            }
            render();
            const payload = { ...patch };
            if (row) {
                payload[COL_CAT_FREQUENCY] = row.frequency;
                payload[COL_CAT_AMOUNT] = row.amount;
                payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
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
            const monthly = calcMonthlyAmount(amt, freq);
            const payload = {
                [COL_CAT_CATEGORY]: data.category,
                [COL_CAT_FREQUENCY]: freq,
                [COL_CAT_AMOUNT]: amt,
                [COL_CAT_MONTHLY_SPEND]: monthly,
                [COL_CAT_ACCOUNT_TYPE]: 'bank',
                [COL_CAT_TYPE]: 'spending'
            };
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
            if (error) throw error;
            if (inserted) {
                bankSpendRows.push({
                    ...inserted,
                    frequency: freq,
                    amount: amt,
                    monthly_spend: monthly,
                    account_type: 'bank',
                    type: 'spending'
                });
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
                row.monthly_spend = calcMonthlyAmount(row.amount, row.frequency);
            }
            render();
            const payload = { ...patch };
            if (row) {
                payload[COL_CAT_FREQUENCY] = row.frequency;
                payload[COL_CAT_AMOUNT] = row.amount;
                payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
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
            const monthly = calcMonthlyAmount(amt, freq);
            const cat = data.category || data.source || '';
            const payload = {
                [COL_CAT_CATEGORY]: cat,
                [COL_CAT_FREQUENCY]: freq,
                [COL_CAT_AMOUNT]: amt,
                [COL_CAT_MONTHLY_SPEND]: monthly,
                [COL_CAT_ACCOUNT_TYPE]: 'income',
                [COL_CAT_TYPE]: 'income'
            };
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
            if (error) throw error;
            if (inserted) {
                incomeRows.push({
                    ...inserted,
                    category: cat,
                    frequency: freq,
                    amount: amt,
                    monthly_spend: monthly,
                    account_type: 'income',
                    type: 'income'
                });
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
                row.monthly_spend = calcMonthlyAmount(row.amount, row.frequency);
            }
            render();
            const payload = { ...patch };
            if (row) {
                payload[COL_CAT_FREQUENCY] = row.frequency;
                payload[COL_CAT_AMOUNT] = row.amount;
                payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
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
                    rentalRows.push({
                        ...inserted,
                        property: propertyName,
                        category: 'Rent',
                        frequency: 'monthly',
                        amount: val,
                        monthly_spend: val,
                        account_type: 'rental',
                        type: 'income'
                    });
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
            const monthly = calcMonthlyAmount(amt, freq);
            const payload = {
                [COL_CAT_CATEGORY]: data.category,
                [COL_CAT_PROPERTY]: propertyName,
                [COL_CAT_FREQUENCY]: freq,
                [COL_CAT_AMOUNT]: amt,
                [COL_CAT_MONTHLY_SPEND]: monthly,
                [COL_CAT_ACCOUNT_TYPE]: 'rental',
                [COL_CAT_TYPE]: 'spending'
            };
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([payload]).select().single();
            if (error) throw error;
            if (inserted) {
                rentalRows.push({
                    ...inserted,
                    property: propertyName,
                    category: data.category,
                    frequency: freq,
                    amount: amt,
                    monthly_spend: monthly,
                    account_type: 'rental',
                    type: 'spending'
                });
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
                row.monthly_spend = calcMonthlyAmount(row.amount, row.frequency);
            }
            render();
            const payload = { ...patch };
            if (row) {
                payload[COL_CAT_FREQUENCY] = row.frequency;
                payload[COL_CAT_AMOUNT] = row.amount;
                payload[COL_CAT_MONTHLY_SPEND] = row.monthly_spend;
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
    // Realtime sync (Consolidated table + cards + rewards)
    // -------------------------------------------------------------------
    function setupRealtime() {
        if (realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('credit_cards_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: CATEGORIES_TABLE }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: CARDS_TABLE }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: REWARDS_TABLE }, () => debounceReload())
            .subscribe();
    }

    function debounceReload() {
        clearTimeout(realtimeDebounceTimer);
        realtimeDebounceTimer = setTimeout(async () => {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
                return;
            }
            await Promise.all([loadSpendingCategories(), loadCards(), loadRewards()]);
            render();
        }, 400);
    }

    window.addEventListener('beforeunload', () => {
        if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    async function loadAll() {
        await Promise.all([loadSpendingCategories(), loadCards(), loadRewards()]);
        render();
        setupRealtime();
    }

    // -------------------------------------------------------------------
    // Wire up UI
    // -------------------------------------------------------------------
    // 1. Credit Card Spending
    const addCategoryBtn = document.getElementById('addCategoryBtn');
    if (addCategoryBtn) {
        addCategoryBtn.addEventListener('click', () => {
            const catInput = document.getElementById('newCategory');
            const freqSelect = document.getElementById('newCategoryFrequency');
            const amountInput = document.getElementById('newCategoryAmount');
            const category = catInput.value.trim();
            const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
            const amount = parseFloat(amountInput.value) || 0;
            if (!category) {
                if (window.setStatus) window.setStatus('Category name is required.');
                return;
            }
            addCategoryRow({ category, frequency, amount });
            catInput.value = '';
            amountInput.value = '';
            if (freqSelect) freqSelect.value = 'monthly';
            catInput.focus();
        });
    }

    // 2. Bank Account Spending
    const addBankCategoryBtn = document.getElementById('addBankCategoryBtn');
    if (addBankCategoryBtn) {
        addBankCategoryBtn.addEventListener('click', () => {
            const catInput = document.getElementById('newBankCategory');
            const freqSelect = document.getElementById('newBankCategoryFrequency');
            const amountInput = document.getElementById('newBankCategoryAmount');
            const category = catInput.value.trim();
            const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
            const amount = parseFloat(amountInput.value) || 0;
            if (!category) {
                if (window.setStatus) window.setStatus('Expense name is required.');
                return;
            }
            addBankSpendRow({ category, frequency, amount });
            catInput.value = '';
            amountInput.value = '';
            if (freqSelect) freqSelect.value = 'monthly';
            catInput.focus();
        });
    }

    // 3. Household Income
    const addIncomeBtn = document.getElementById('addIncomeBtn');
    if (addIncomeBtn) {
        addIncomeBtn.addEventListener('click', () => {
            const sourceInput = document.getElementById('newIncomeSource');
            const freqSelect = document.getElementById('newIncomeFrequency');
            const amountInput = document.getElementById('newIncomeAmount');
            const source = sourceInput.value.trim();
            const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
            const amount = parseFloat(amountInput.value) || 0;
            if (!source) {
                if (window.setStatus) window.setStatus('Income source is required.');
                return;
            }
            addIncomeRow({ category: source, frequency, amount });
            sourceInput.value = '';
            amountInput.value = '';
            if (freqSelect) freqSelect.value = 'monthly';
            sourceInput.focus();
        });
    }

    // 4. San Jacinto Rental UI
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
            const category = catInput.value.trim();
            const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
            const amount = parseFloat(amountInput.value) || 0;
            if (!category) {
                if (window.setStatus) window.setStatus('Expense category is required.');
                return;
            }
            addRentalExpenseRow('San Jacinto', { category, frequency, amount });
            catInput.value = '';
            amountInput.value = '';
            if (freqSelect) freqSelect.value = 'monthly';
            catInput.focus();
        });
    }

    // 5. County Line Rental UI
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
            const category = catInput.value.trim();
            const frequency = freqSelect ? (freqSelect.value || 'monthly') : 'monthly';
            const amount = parseFloat(amountInput.value) || 0;
            if (!category) {
                if (window.setStatus) window.setStatus('Expense category is required.');
                return;
            }
            addRentalExpenseRow('County Line', { category, frequency, amount });
            catInput.value = '';
            amountInput.value = '';
            if (freqSelect) freqSelect.value = 'monthly';
            catInput.focus();
        });
    }

    // 6. Credit Cards & Rewards
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
                if (window.setStatus) window.setStatus('Choose a card first — add one above if it\'s not listed yet.');
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
    // Tabs Navigation
    // -------------------------------------------------------------------
    let activeTab = 'budget';

    function switchTab(tabKey) {
        if (!tabKey) return;
        activeTab = tabKey;
        const tabBtns = document.querySelectorAll('#cc-tabs .tab');
        tabBtns.forEach(btn => {
            if (btn.dataset.tab === tabKey) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        const budgetPane = document.getElementById('tab-budget');
        const comparisonPane = document.getElementById('tab-comparison');
        const rentalPane = document.getElementById('tab-rental');
        if (budgetPane) budgetPane.style.display = tabKey === 'budget' ? 'block' : 'none';
        if (comparisonPane) comparisonPane.style.display = tabKey === 'comparison' ? 'block' : 'none';
        if (rentalPane) rentalPane.style.display = tabKey === 'rental' ? 'block' : 'none';
    }

    function setupTabs() {
        const tabsContainer = document.getElementById('cc-tabs');
        if (!tabsContainer) return;
        tabsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab');
            if (btn && btn.dataset.tab) {
                switchTab(btn.dataset.tab);
            }
        });
    }

    setupTabs();

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const targetId = e.target.id;
            if (['newCategory', 'newCategoryAmount'].includes(targetId)) {
                if (addCategoryBtn) addCategoryBtn.click();
            } else if (['newBankCategory', 'newBankCategoryAmount'].includes(targetId)) {
                if (addBankCategoryBtn) addBankCategoryBtn.click();
            } else if (['newIncomeSource', 'newIncomeAmount'].includes(targetId)) {
                if (addIncomeBtn) addIncomeBtn.click();
            } else if (['sanJacintoRentInput'].includes(targetId)) {
                if (sanJacintoRentInput) sanJacintoRentInput.blur();
            } else if (['sanJacintoNewCategory', 'sanJacintoNewCategoryAmount'].includes(targetId)) {
                if (sanJacintoAddCategoryBtn) sanJacintoAddCategoryBtn.click();
            } else if (['countyLineRentInput'].includes(targetId)) {
                if (countyLineRentInput) countyLineRentInput.blur();
            } else if (['countyLineNewCategory', 'countyLineNewCategoryAmount'].includes(targetId)) {
                if (countyLineAddCategoryBtn) countyLineAddCategoryBtn.click();
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
})();
