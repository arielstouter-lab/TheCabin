(function () {
    const sb = window.supabaseClient;
    const CATEGORIES_TABLE = 'household_spending_categories';
    const REWARDS_TABLE = 'card_rewards';

    let spendRows = [];    // {id, category, monthly_spend}
    let rewardRows = [];   // {id, card, category, rate, fee}

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
        return '$' + (Math.round(val * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function isDefaultRow(row) {
        return !row.category || !row.category.trim();
    }

    function render() {
        renderSpendGrid();
        renderRewardsGrid();
        renderCardOptions();
        renderComparison();
    }

    // -------------------------------------------------------------------
    // Grid 1: Household Spending
    // -------------------------------------------------------------------
    function renderSpendGrid() {
        const body = document.getElementById('spendGridBody');
        const empty = document.getElementById('spendGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        if (empty) empty.style.display = spendRows.length ? 'none' : 'block';

        spendRows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.category)}" data-field="category" style="width: 100%; min-width: 140px;"></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.monthly_spend ?? 0}" data-field="monthly_spend" style="width: 100%; min-width: 90px;"></div></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete category">✕</button></td>
            `;
            tr.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'monthly_spend') val = parseFloat(val) || 0;
                    updateCategoryRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteCategoryRow(row.id));
            body.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------
    // Grid 2: Card Rewards
    // -------------------------------------------------------------------
    function renderRewardsGrid() {
        const body = document.getElementById('rewardsGridBody');
        const empty = document.getElementById('rewardsGridEmpty');
        if (!body) return;

        body.innerHTML = '';
        if (empty) empty.style.display = rewardRows.length ? 'none' : 'block';

        rewardRows.forEach(row => {
            const tr = document.createElement('tr');
            const catDisplay = isDefaultRow(row) ? '' : escapeHtml(row.category);
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.card)}" data-field="card" style="width: 100%; min-width: 120px;"></td>
              <td>
                <input type="text" class="text-input" value="${catDisplay}" data-field="category" placeholder="Everything else" style="width: 100%; min-width: 120px;">
              </td>
              <td class="col-num"><div class="num-wrap pct"><input type="number" class="text-input" min="0" step="0.1" value="${row.rate ?? 0}" data-field="rate" style="width: 100%; min-width: 70px;"></div></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.special_refund ?? 0}" data-field="special_refund" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.fee ?? 0}" data-field="fee" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete row">✕</button></td>
            `;
            tr.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'rate' || field === 'fee' || field === 'special_refund') val = parseFloat(val) || 0;
                    updateRewardRow(row.id, { [field]: val });
                });
            });
            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) delBtn.addEventListener('click', () => deleteRewardRow(row.id));
            body.appendChild(tr);
        });
    }

    function renderCardOptions() {
        const cards = [...new Set(rewardRows.map(r => r.card).filter(Boolean))].sort();
        const aSel = document.getElementById('cardASelect');
        const bSel = document.getElementById('cardBSelect');
        if (!aSel || !bSel) return;

        [aSel, bSel].forEach(sel => {
            const current = sel.value;
            sel.innerHTML = '<option value="">Choose a card…</option>' + cards.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
            if (cards.includes(current)) sel.value = current;
        });
    }

    // Effective rate (+ any special refund) for a card in a given category:
    // exact match first, then the card's blank/default row, else nothing.
    function getEffectiveRate(cardName, category) {
        const cardRows = rewardRows.filter(r => r.card === cardName);
        const exact = cardRows.find(r => !isDefaultRow(r) && r.category.trim().toLowerCase() === category.trim().toLowerCase());
        if (exact) return { rate: exact.rate || 0, refund: exact.special_refund || 0, isDefault: false };
        const def = cardRows.find(isDefaultRow);
        if (def) return { rate: def.rate || 0, refund: def.special_refund || 0, isDefault: true };
        return { rate: 0, refund: 0, isDefault: false, none: true };
    }

    function getAnnualFee(cardName) {
        const cardRows = rewardRows.filter(r => r.card === cardName);
        const withFee = cardRows.find(r => r.fee);
        return withFee ? withFee.fee : (cardRows[0] ? (cardRows[0].fee || 0) : 0);
    }

    // -------------------------------------------------------------------
    // Comparison
    // -------------------------------------------------------------------
    function renderComparison() {
        const aSel = document.getElementById('cardASelect');
        const bSel = document.getElementById('cardBSelect');
        if (!aSel || !bSel) return;

        const aName = aSel.value;
        const bName = bSel.value;
        const compareTable = document.getElementById('compareTable');
        const compareTableWrap = document.getElementById('compareTableWrap');
        const compareEmpty = document.getElementById('compareEmpty');
        const summaryGrid = document.getElementById('summaryGrid');

        if (!aName || !bName || aName === bName || !spendRows.length) {
            if (compareTableWrap) compareTableWrap.style.display = 'none';
            else if (compareTable) compareTable.style.display = 'none';
            if (summaryGrid) summaryGrid.style.display = 'none';
            if (compareEmpty) {
                compareEmpty.style.display = 'block';
                compareEmpty.textContent = !spendRows.length
                    ? 'Add at least one spending category above to compare.'
                    : (!aName || !bName)
                        ? 'Pick two different cards above to compare.'
                        : 'Pick two different cards to compare.';
            }
            return;
        }

        if (compareEmpty) compareEmpty.style.display = 'none';
        if (compareTableWrap) compareTableWrap.style.display = 'block';
        if (compareTable) compareTable.style.display = 'table';
        if (summaryGrid) summaryGrid.style.display = 'grid';

        const headA = document.getElementById('headA');
        const headB = document.getElementById('headB');
        if (headA) headA.textContent = aName;
        if (headB) headB.textContent = bName;

        const aFee = getAnnualFee(aName);
        const bFee = getAnnualFee(bName);

        let aTotal = 0, bTotal = 0, bestTotal = 0;
        const tbody = document.getElementById('compareBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const categoryResults = spendRows.map(catRow => {
            const cat = catRow.category;
            const spend = catRow.monthly_spend || 0;
            const a = getEffectiveRate(aName, cat);
            const b = getEffectiveRate(bName, cat);
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

            const aCell = a.none ? '<span class="empty-state">no rate</span>' : `${a.rate.toFixed(1)}%${a.isDefault ? ' <span class="empty-state">(default)</span>' : ''} &rarr; ${fmt$(aReward)}${a.refund ? ' <span class="empty-state">(incl. ' + fmt$(a.refund) + ' refund)</span>' : ''}`;
            const bCell = b.none ? '<span class="empty-state">no rate</span>' : `${b.rate.toFixed(1)}%${b.isDefault ? ' <span class="empty-state">(default)</span>' : ''} &rarr; ${fmt$(bReward)}${b.refund ? ' <span class="empty-state">(incl. ' + fmt$(b.refund) + ' refund)</span>' : ''}`;

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
    // Supabase CRUD — categories
    // -------------------------------------------------------------------
    async function loadCategories() {
        if (!sb) return;
        try {
            const { data, error } = await sb.from(CATEGORIES_TABLE).select('*').order('created_at', { ascending: true });
            if (error) throw error;
            spendRows = data || [];
        } catch (err) {
            console.error('Error loading categories:', err);
            if (window.setStatus) window.setStatus('Could not load spending categories.');
            spendRows = [];
        }
    }

    async function addCategoryRow(data) {
        if (!sb) return;
        try {
            const { data: inserted, error } = await sb.from(CATEGORIES_TABLE).insert([data]).select().single();
            if (error) throw error;
            if (inserted) { spendRows.push(inserted); render(); }
            if (window.setStatus) window.setStatus('Added category.');
        } catch (err) {
            console.error('Could not add category:', err);
            if (window.setStatus) window.setStatus('Could not add category: ' + (err.message || err));
        }
    }

    async function updateCategoryRow(id, patch) {
        if (!sb) return;
        try {
            const row = spendRows.find(r => r.id === id);
            if (row) Object.assign(row, patch);
            render();
            const { error } = await sb.from(CATEGORIES_TABLE).update(patch).eq('id', id);
            if (error) throw error;
        } catch (err) {
            console.error('Could not update category:', err);
            if (window.setStatus) window.setStatus('Could not update category.');
        }
    }

    async function deleteCategoryRow(id) {
        if (!sb) return;
        try {
            const { error } = await sb.from(CATEGORIES_TABLE).delete().eq('id', id);
            if (error) throw error;
            spendRows = spendRows.filter(r => r.id !== id);
            render();
            if (window.setStatus) window.setStatus('Deleted category.');
        } catch (err) {
            console.error('Could not delete category:', err);
            if (window.setStatus) window.setStatus('Could not delete category.');
        }
    }

    // -------------------------------------------------------------------
    // Supabase CRUD — card rewards
    // -------------------------------------------------------------------
    async function loadRewards() {
        if (!sb) return;
        try {
            const { data, error } = await sb.from(REWARDS_TABLE).select('*').order('created_at', { ascending: true });
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
            if (window.setStatus) window.setStatus('Added card reward.');
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
            const { error } = await sb.from(REWARDS_TABLE).update(patch).eq('id', id);
            if (error) throw error;
        } catch (err) {
            console.error('Could not update row:', err);
            if (window.setStatus) window.setStatus('Could not update row.');
        }
    }

    async function deleteRewardRow(id) {
        if (!sb) return;
        try {
            const { error } = await sb.from(REWARDS_TABLE).delete().eq('id', id);
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
    // Realtime sync (both tables)
    // -------------------------------------------------------------------
    function setupRealtime() {
        if (realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('credit_cards_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: CATEGORIES_TABLE }, () => debounceReload())
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
            await Promise.all([loadCategories(), loadRewards()]);
            render();
        }, 400);
    }

    window.addEventListener('beforeunload', () => {
        if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    async function loadAll() {
        await Promise.all([loadCategories(), loadRewards()]);
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
            const spendInput = document.getElementById('newCategorySpend');
            const category = catInput.value.trim();
            const monthly_spend = parseFloat(spendInput.value) || 0;
            if (!category) {
                if (window.setStatus) window.setStatus('Category name is required.');
                return;
            }
            addCategoryRow({ category, monthly_spend });
            catInput.value = '';
            spendInput.value = '';
            catInput.focus();
        });
    }

    const addRewardBtn = document.getElementById('addRewardBtn');
    if (addRewardBtn) {
        addRewardBtn.addEventListener('click', () => {
            const cardInput = document.getElementById('newCard');
            const catInput = document.getElementById('newRewardCategory');
            const rateInput = document.getElementById('newRate');
            const refundInput = document.getElementById('newSpecialRefund');
            const feeInput = document.getElementById('newFee');

            const card = cardInput.value.trim();
            const category = catInput.value.trim(); // blank = "everything else"
            const rate = parseFloat(rateInput.value) || 0;
            const special_refund = parseFloat(refundInput.value) || 0;
            const fee = parseFloat(feeInput.value) || 0;

            if (!card) {
                if (window.setStatus) window.setStatus('Card name is required.');
                return;
            }

            addRewardRow({ card, category, rate, special_refund, fee });
            cardInput.value = '';
            catInput.value = '';
            rateInput.value = '';
            refundInput.value = '';
            feeInput.value = '';
            cardInput.focus();
        });
    }

    const cardASelect = document.getElementById('cardASelect');
    const cardBSelect = document.getElementById('cardBSelect');
    if (cardASelect) cardASelect.addEventListener('change', renderComparison);
    if (cardBSelect) cardBSelect.addEventListener('change', renderComparison);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const targetId = e.target.id;
            if (['newCategory', 'newCategorySpend'].includes(targetId)) {
                if (addCategoryBtn) addCategoryBtn.click();
            } else if (['newCard', 'newRewardCategory', 'newRate', 'newSpecialRefund', 'newFee'].includes(targetId)) {
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