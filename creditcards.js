(function () {
    const sb = window.supabaseClient;
    const TABLE = 'card_rewards';

    let rows = []; // {id, card, category, spend, rate, fee}
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

    function render() {
        renderGrid();
        renderCardOptions();
        renderComparison();
    }

    function renderGrid() {
        const gridBody = document.getElementById('gridBody');
        const gridEmpty = document.getElementById('gridEmpty');
        if (!gridBody) return;

        gridBody.innerHTML = '';
        if (gridEmpty) gridEmpty.style.display = rows.length ? 'none' : 'block';

        rows.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><input type="text" class="text-input" value="${escapeHtml(row.card)}" data-field="card" style="width: 100%; min-width: 120px;"></td>
              <td><input type="text" class="text-input" value="${escapeHtml(row.category)}" data-field="category" style="width: 100%; min-width: 100px;"></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.spend ?? 0}" data-field="spend" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-num"><div class="num-wrap pct"><input type="number" class="text-input" min="0" step="0.1" value="${row.rate ?? 0}" data-field="rate" style="width: 100%; min-width: 70px;"></div></td>
              <td class="col-num"><div class="num-wrap money"><input type="number" class="text-input" min="0" step="1" value="${row.fee ?? 0}" data-field="fee" style="width: 100%; min-width: 80px;"></div></td>
              <td class="col-action"><button class="icon-delete" data-del-id="${row.id}" title="Delete row">✕</button></td>
            `;

            tr.querySelectorAll('input').forEach(input => {
                input.addEventListener('change', () => {
                    const field = input.dataset.field;
                    let val = input.value;
                    if (field === 'spend' || field === 'rate' || field === 'fee') val = parseFloat(val) || 0;
                    updateRow(row.id, { [field]: val });
                });
            });

            const delBtn = tr.querySelector('.icon-delete');
            if (delBtn) {
                delBtn.addEventListener('click', () => deleteRow(row.id));
            }

            gridBody.appendChild(tr);
        });
    }

    function renderCardOptions() {
        const cards = [...new Set(rows.map(r => r.card).filter(Boolean))].sort();
        const aSel = document.getElementById('cardASelect');
        const bSel = document.getElementById('cardBSelect');
        if (!aSel || !bSel) return;

        [aSel, bSel].forEach(sel => {
            const current = sel.value;
            sel.innerHTML = '<option value="">Choose a card…</option>' + cards.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
            if (cards.includes(current)) sel.value = current;
        });
    }

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

        if (!aName || !bName || aName === bName) {
            if (compareTableWrap) compareTableWrap.style.display = 'none';
            else if (compareTable) compareTable.style.display = 'none';
            if (summaryGrid) summaryGrid.style.display = 'none';
            if (compareEmpty) {
                compareEmpty.style.display = 'block';
                compareEmpty.textContent = (!aName || !bName)
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

        const aRows = rows.filter(r => r.card === aName);
        const bRows = rows.filter(r => r.card === bName);
        const aFee = aRows.length ? (aRows.find(r => r.fee) ? aRows.find(r => r.fee).fee : aRows[0].fee || 0) : 0;
        const bFee = bRows.length ? (bRows.find(r => r.fee) ? bRows.find(r => r.fee).fee : bRows[0].fee || 0) : 0;

        const categories = [...new Set([...aRows.map(r => r.category), ...bRows.map(r => r.category)].filter(Boolean))];

        let aTotal = 0, bTotal = 0, bestTotal = 0;
        const tbody = document.getElementById('compareBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        categories.forEach(cat => {
            const aRow = aRows.find(r => r.category === cat);
            const bRow = bRows.find(r => r.category === cat);
            const spends = [aRow?.spend, bRow?.spend].filter(v => v !== undefined && v !== null);
            const spend = spends.length ? spends.reduce((s, v) => s + v, 0) / spends.length : 0;
            const aRate = aRow ? (aRow.rate || 0) : 0;
            const bRate = bRow ? (bRow.rate || 0) : 0;
            const aReward = spend * aRate / 100;
            const bReward = spend * bRate / 100;
            aTotal += aReward;
            bTotal += bReward;
            bestTotal += Math.max(aReward, bReward);

            let winnerHtml;
            if (!aRow) winnerHtml = `<span class="win-b">${escapeHtml(bName)}</span><span class="badge b">only B</span>`;
            else if (!bRow) winnerHtml = `<span class="win-a">${escapeHtml(aName)}</span><span class="badge a">only A</span>`;
            else if (aReward > bReward) winnerHtml = `<span class="win-a">${escapeHtml(aName)}</span><span class="badge a">+${fmt$(aReward - bReward)}</span>`;
            else if (bReward > aReward) winnerHtml = `<span class="win-b">${escapeHtml(bName)}</span><span class="badge b">+${fmt$(bReward - aReward)}</span>`;
            else winnerHtml = `<span class="tie">Tie</span>`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${escapeHtml(cat)}</td>
              <td class="col-num">${fmt$(spend)}</td>
              <td class="col-num">${aRow ? aRate.toFixed(1) + '% &rarr; ' + fmt$(aReward) : '<span class="empty-state">no data</span>'}</td>
              <td class="col-num">${bRow ? bRate.toFixed(1) + '% &rarr; ' + fmt$(bReward) : '<span class="empty-state">no data</span>'}</td>
              <td>${winnerHtml}</td>
            `;
            tbody.appendChild(tr);
        });

        if (summaryGrid) {
            summaryGrid.innerHTML = `
            <div class="summary-card">
              <div class="label">${escapeHtml(aName)}</div>
              <div class="value">${fmt$(aTotal)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo</span></div>
              <div class="foot">Annual fee ${fmt$(aFee)} (${fmt$(aFee / 12)}/mo) &middot; Net ${fmt$(aTotal - aFee / 12)}/mo</div>
            </div>
            <div class="summary-card">
              <div class="label">${escapeHtml(bName)}</div>
              <div class="value">${fmt$(bTotal)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo</span></div>
              <div class="foot">Annual fee ${fmt$(bFee)} (${fmt$(bFee / 12)}/mo) &middot; Net ${fmt$(bTotal - bFee / 12)}/mo</div>
            </div>
            <div class="summary-card best">
              <div class="label">Best of Both (optimal routing)</div>
              <div class="value">${fmt$(bestTotal)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;">/mo</span></div>
              <div class="foot">If you used whichever card wins each category &middot; minus ${fmt$((aFee + bFee) / 12)}/mo combined fees = ${fmt$(bestTotal - (aFee + bFee) / 12)}/mo</div>
            </div>
          `;
        }
    }

    // ---------------------------------------------------------------------------
    // Supabase CRUD
    // ---------------------------------------------------------------------------
    async function loadRows() {
        if (!sb) {
            console.error('Supabase client not initialized.');
            return;
        }
        try {
            const { data, error } = await sb.from(TABLE).select('*').order('created_at', { ascending: true });
            if (error) throw error;
            rows = data || [];
            render();
            setupRealtime();
        } catch (err) {
            console.error('Error loading card rewards:', err);
            if (window.setStatus) window.setStatus('Could not load card rewards.');
            rows = [];
            render();
        }
    }

    async function addRow(data) {
        if (!sb) return;
        try {
            const { data: inserted, error } = await sb.from(TABLE).insert([data]).select().single();
            if (error) throw error;
            if (inserted) {
                rows.push(inserted);
                render();
            }
            if (window.setStatus) window.setStatus('Added card reward.');
        } catch (err) {
            console.error('Could not add row:', err);
            if (window.setStatus) window.setStatus('Could not add row: ' + (err.message || err));
        }
    }

    async function updateRow(id, patch) {
        if (!sb) return;
        try {
            const row = rows.find(r => r.id === id);
            if (row) Object.assign(row, patch);
            renderCardOptions();
            renderComparison();

            const { error } = await sb.from(TABLE).update(patch).eq('id', id);
            if (error) throw error;
        } catch (err) {
            console.error('Could not update row:', err);
            if (window.setStatus) window.setStatus('Could not update row.');
        }
    }

    async function deleteRow(id) {
        if (!sb) return;
        try {
            const { error } = await sb.from(TABLE).delete().eq('id', id);
            if (error) throw error;
            rows = rows.filter(r => r.id !== id);
            render();
            if (window.setStatus) window.setStatus('Deleted row.');
        } catch (err) {
            console.error('Could not delete row:', err);
            if (window.setStatus) window.setStatus('Could not delete row.');
        }
    }

    // ---------------------------------------------------------------------------
    // Realtime Sync
    // ---------------------------------------------------------------------------
    function setupRealtime() {
        if (realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('card_rewards_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, () => {
                debounceReload();
            })
            .subscribe();
    }

    function debounceReload() {
        clearTimeout(realtimeDebounceTimer);
        realtimeDebounceTimer = setTimeout(() => {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
                return;
            }
            loadRows();
        }, 400);
    }

    window.addEventListener('beforeunload', () => {
        if (realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    // ---------------------------------------------------------------------------
    // Wire up UI
    // ---------------------------------------------------------------------------
    const addRowBtn = document.getElementById('addRowBtn');
    if (addRowBtn) {
        addRowBtn.addEventListener('click', () => {
            const cardInput = document.getElementById('newCard');
            const catInput = document.getElementById('newCategory');
            const spendInput = document.getElementById('newSpend');
            const rateInput = document.getElementById('newRate');
            const feeInput = document.getElementById('newFee');

            const card = cardInput.value.trim();
            const category = catInput.value.trim();
            const spend = parseFloat(spendInput.value) || 0;
            const rate = parseFloat(rateInput.value) || 0;
            const fee = parseFloat(feeInput.value) || 0;

            if (!card || !category) {
                if (window.setStatus) window.setStatus('Card and category are required.');
                return;
            }

            addRow({ card, category, spend, rate, fee });
            cardInput.value = '';
            catInput.value = '';
            spendInput.value = '';
            rateInput.value = '';
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
            if (['newCard', 'newCategory', 'newSpend', 'newRate', 'newFee'].includes(targetId)) {
                if (addRowBtn) addRowBtn.click();
            }
        }
    });

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    if (window.initAppPage) {
        window.initAppPage(loadRows);
    } else {
        document.addEventListener('app:ready', loadRows, { once: true });
    }
})();
