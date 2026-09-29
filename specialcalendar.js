(function(){
    const sb = window.supabaseClient;
    const getSeason = window.getSeason;
    const todayStr = window.todayStr;
    const updateSeason = window.updateSeason || function(){};
    const histories = {};
    let viewYear, viewMonth; // 0-indexed month
    let selectedDate; // 'YYYY-MM-DD'
    let eventsByDate = {}; // {'YYYY-MM-DD': [{id, title}]}
    const visibleLayers = new Set([
        'default'
    ]);
    const layerOf = ev => ev.layer || 'default';   // null layer = default

    visibleLayers.has(layerOf(ev)); // null layer -> 'default' -> true

    const FLOW_KEYS = ['spotting', 'light', 'medium', 'heavy']; // placeholder names, match your titles

    function pad(n){ return String(n).padStart(2,'0'); }
    function toDateStr(y,m,d){ return `${y}-${pad(m+1)}-${pad(d)}`; }

    async function loadMonth(){
        const first = toDateStr(viewYear, viewMonth, 1);
        const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
        const last = toDateStr(viewYear, viewMonth, lastDay);
        try{
            const {data, error} = await sb.from('household_events')
                .select('*')
                .gte('event_date', first)
                .lte('event_date', last)
                .order('sort_order', { ascending: true });
            if(error) throw error;
            eventsByDate = {};
            (data || []).forEach(ev => {
                eventsByDate[ev.event_date] = eventsByDate[ev.event_date] || [];
                eventsByDate[ev.event_date].push({
                    id: ev.id,
                    title: ev.title,
                    sort_order: ev.sort_order,
                    layer: ev.layer
                });
            });
        } catch(err){
            console.error('Failed to load events:', err);
            setStatus('Could not load events.');
            eventsByDate = {};
        }
        renderGrid();
        renderEventsPanel();
        updateOPanel();
    }

    async function loadLayerOptions() {

        try {

            const { data, error } = await sb
                .from('household_events')
                .select('layer');

            if (error) throw error;

            const select =
                document.getElementById('cal-event-layer');

            if (!select) return;

            // Remember current selection
            const currentValue = select.value;

            // Get unique non-null layers
            const layers = [...new Set(
                (data || [])
                    .map(row => row.layer)
                    .filter(layer => layer)
            )].sort();

            // Rebuild dropdown
            select.innerHTML =
                '<option value="">Default</option>';

            layers.forEach(layer => {

                const option =
                    document.createElement('option');

                option.value = layer;
                option.textContent = layer;

                select.appendChild(option);

            });

            // Restore previous selection if it still exists
            if (
                [...select.options]
                    .some(option => option.value === currentValue)
            ) {
                select.value = currentValue;
            }

        } catch (err) {

            console.error(
                'Failed to load layer options',
                err
            );

        }
    }

    async function loadAllHistory(layer, callback) {

        try {

            const { data, error } = await sb
                .from('household_events')
                .select('event_date')
                .eq('layer', layer)
                .order('event_date', { ascending: true });

            if (error) throw error;

            histories[layer] = data || [];

            if (callback) {
                callback();
            }

        } catch (err) {

            console.error(`Failed to load ${layer} history`, err);

        }
    }

    function renderGrid(){
        // viewMonth has no day — use the 1st of that month as a stand-in
        updateSeason(new Date(viewYear, viewMonth, 1));
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        document.getElementById('cal-month-label').textContent = `${monthNames[viewMonth]} ${viewYear}`;

        const firstOfMonth = new Date(viewYear, viewMonth, 1);
        const startDow = firstOfMonth.getDay(); // 0=Sun
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
        const today = todayStr();

        const cells = [];
        for(let i = startDow - 1; i >= 0; i--){
            const d = daysInPrevMonth - i;
            const m = viewMonth === 0 ? 11 : viewMonth - 1;
            const y = viewMonth === 0 ? viewYear - 1 : viewYear;
            cells.push({dateStr: toDateStr(y,m,d), label: d, otherMonth: true});
        }
        for(let d = 1; d <= daysInMonth; d++){
            cells.push({dateStr: toDateStr(viewYear, viewMonth, d), label: d, otherMonth: false});
        }
        while(cells.length % 7 !== 0 || cells.length < 42){
            const last = cells[cells.length - 1];
            const [y,m,d] = last.dateStr.split('-').map(Number);
            const next = new Date(y, m - 1, d + 1);
            cells.push({dateStr: toDateStr(next.getFullYear(), next.getMonth(), next.getDate()), label: next.getDate(), otherMonth: true});
            if(cells.length >= 42) break;
        }

        document.getElementById('cal-days').innerHTML = cells.map(c => {
            const events = eventsByDate[c.dateStr] || [];
            const forLayer = layer =>
                visibleLayers.has(layer) ? events.filter(ev => layerOf(ev) === layer) : [];

            const defaultEvents = forLayer('default');
            const oEvents       = forLayer('o');
            const moonEvents    = forLayer('moon');

            const classes = ['cal-day'];
            if (c.otherMonth) classes.push('other-month');
            if (c.dateStr === today) classes.push('today');
            if (c.dateStr === selectedDate) classes.push('selected');

            // dots: default layer only
            const dots = defaultEvents.length
                ? `<div class="cal-day-dot-row">${'<span class="cal-day-dot"></span>'.repeat(Math.min(defaultEvents.length, 4))}</div>`
                : '';

            // os: single icon if any o-layer event exists
            const os = oEvents.length ? `<span class="cal-day-o">💥</span>` : '';

            // flows: translucent overlay, color chosen by the event title
            const flowKey = moonEvents
                .map(ev => (ev.title || '').trim().toLowerCase())
                .find(t => FLOW_KEYS.includes(t));
            const flows = flowKey ? `<div class="cal-day-flow flow-${flowKey}"></div>` : '';

            return `<div class="${classes.join(' ')}" data-date="${c.dateStr}">
        ${flows}
        <span class="cal-day-num">${c.label}</span>
        ${dots}${os}
    </div>`;
        }).join('');
    }

    function renderEventsPanel(){
        const label = document.getElementById('cal-selected-label');
        const list = document.getElementById('cal-events');
        if(!selectedDate){
            label.textContent = '';
            list.innerHTML = '<p class="empty-state">Select a day to see events.</p>';
            return;
        }
        const d = new Date(selectedDate + 'T00:00:00');
        label.textContent = d.toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric'});

        const evs = (eventsByDate[selectedDate] || [])
            .filter(ev => visibleLayers.has(layerOf(ev)));
        list.innerHTML = evs.length
            ? evs.map((ev, index) => `
          <div class="cal-event draggable-item" draggable="true" data-index="${index}" data-event-row="${ev.id}">
            <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
            <span class="cal-event-title">${escapeHtml(ev.title)}</span>
            <button class="icon-delete" data-del-event="${ev.id}" title="Remove">✕</button>
          </div>`).join('')
            : '<p class="empty-state">No events yet.</p>';
    }

    function selectDate(dateStr){
        selectedDate = dateStr;
        const [y,m] = dateStr.split('-').map(Number);
        if(y !== viewYear || (m - 1) !== viewMonth){
            viewYear = y; viewMonth = m - 1;
            loadMonth();
        } else {
            renderGrid();
            renderEventsPanel();
        }
    }

    function buildMoonCycles(dates) {

        const cycles = [];

        if (!dates.length) return cycles;

        let current = [
            new Date(dates[0].event_date + 'T00:00:00')
        ];

        for (let i = 1; i < dates.length; i++) {

            const prev =
                new Date(dates[i - 1].event_date + 'T00:00:00');

            const curr =
                new Date(dates[i].event_date + 'T00:00:00');

            const diff =
                (curr - prev) / (1000 * 60 * 60 * 24);

            if (diff === 1) {

                current.push(curr);

            } else {

                cycles.push(current);
                current = [curr];

            }
        }

        cycles.push(current);

        return cycles;
    }

    function updateMoonPanel() {

        const moonHistory = histories.moon || [];

        const lookback = document.getElementById('moon-lookback');

        if (!lookback) return;

        const months = Number(lookback.value);

        const cutoff = new Date();

        if (months !== 999) {
            cutoff.setMonth(cutoff.getMonth() - months);
        }

        const filtered = moonHistory.filter(row =>
            months === 999 ||
            new Date(row.event_date) >= cutoff
        );

        const cycles = buildMoonCycles(filtered);

        // Filter out 1-day cycles
        const validCycles = cycles.filter(cycle => cycle.length > 1);

        if (!validCycles.length) {

            document.getElementById('moon-avg-length').textContent = '--';
            document.getElementById('moon-avg-between').textContent = '--';
            document.getElementById('moon-next-1').textContent = '--';
            document.getElementById('moon-next-2').textContent = '--';

            return;
        }

        const avgLength =
            cycles.reduce(
                (sum, cycle) => sum + cycle.length,
                0
            ) / cycles.length;

        let totalGap = 0;

        for (let i = 1; i < cycles.length; i++) {

            const previousStart = cycles[i - 1][0];
            const currentStart = cycles[i][0];

            totalGap +=
                (currentStart - previousStart) /
                (1000 * 60 * 60 * 24);
        }

        const avgGap =
            cycles.length > 1
                ? totalGap / (cycles.length - 1)
                : 0;

        const lastStart =
            cycles[cycles.length - 1][0];

        const nextStart =
            new Date(
                lastStart.getTime() +
                avgGap * 86400000
            );

        const nextSecond =
            new Date(
                nextStart.getTime() +
                avgGap * 86400000
            );

        document.getElementById('moon-avg-length')
            .textContent = avgLength.toFixed(1);

        document.getElementById('moon-avg-between')
            .textContent = avgGap.toFixed(1);

        document.getElementById('moon-next-1')
            .textContent = nextStart.toLocaleDateString();

        document.getElementById('moon-next-2')
            .textContent = nextSecond.toLocaleDateString();
    }

    function updateOPanel() {
        const oHistory = histories.o || [];

        if (!oHistory.length) {

            document.getElementById('o-days-since').textContent = '--';
            document.getElementById('o-longest-gap').textContent = '--';

            return;
        }

        const msPerDay = 1000 * 60 * 60 * 24;

        const today = new Date();

        const lastDate = new Date(
            oHistory[oHistory.length - 1].event_date + 'T00:00:00'
        );

        const daysSince =
            Math.floor((today - lastDate) / msPerDay);

        let longestGap = 0;

        for (let i = 1; i < oHistory.length; i++) {

            const prev = new Date(
                oHistory[i - 1].event_date + 'T00:00:00'
            );

            const curr = new Date(
                oHistory[i].event_date + 'T00:00:00'
            );

            const gap =
                Math.floor((curr - prev) / msPerDay);

            longestGap = Math.max(longestGap, gap);
        }

        const currentGap =
            Math.floor((today - lastDate) / msPerDay);

        longestGap =
            Math.max(longestGap, currentGap);

        document.getElementById('o-days-since').textContent =
            String(daysSince);

        document.getElementById('o-longest-gap').textContent =
            String(longestGap);
    }

    const lookback = document.getElementById('moon-lookback');

    if (lookback) {
        lookback.addEventListener('change', updateMoonPanel);
    }

    document.getElementById('cal-prev').addEventListener('click', () => {
        if(viewYear === undefined) return;
        viewMonth--;
        if(viewMonth < 0){ viewMonth = 11; viewYear--; }
        loadMonth();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
        if(viewYear === undefined) return;
        viewMonth++;
        if(viewMonth > 11){ viewMonth = 0; viewYear++; }
        loadMonth();
    });

    document.getElementById('cal-days').addEventListener('click', (e) => {
        const cell = e.target.closest('.cal-day');
        if(!cell) return;
        selectDate(cell.dataset.date);
    });

    const eventsContainer = document.getElementById('cal-events');

    async function reorderEvents(fromIndex, toIndex){
        if (isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

        const list = eventsByDate[selectedDate];
        if (!list || !list[fromIndex]) return;

        const [moved] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, moved);

        list.forEach((ev, idx) => {
            ev.sort_order = idx + 1;
        });

        renderEventsPanel();

        try {
            const updates = list.map((ev, idx) =>
                sb.from('household_events')
                    .update({ sort_order: idx + 1 })
                    .eq('id', ev.id)
            );
            const results = await Promise.all(updates);
            const failed = results.find(r => r.error);
            if (failed && failed.error) throw failed.error;
        } catch (err) {
            console.error('Failed to save event order:', err);
            setStatus('Could not save event order.');
        }
    }

    initDragAndDrop(eventsContainer, {
        onReorder: (fromIndex, toIndex) => reorderEvents(fromIndex, toIndex)
    });

    document.getElementById('cal-add-event').addEventListener('click', async () => {
        if(!selectedDate){ setStatus('Select a day first.'); return; }
        const input = document.getElementById('cal-new-event');
        const title = input.value.trim();
        const layer =
            document.getElementById('cal-event-layer').value || null;
        if(!title) return;

        const currentEvents = eventsByDate[selectedDate] || [];
        const sort_order = currentEvents.length > 0
            ? Math.max(...currentEvents.map(ev => Number(ev.sort_order) || 0), currentEvents.length) + 1
            : 1;

        try{
            const {data, error} = await sb.from('household_events')
                .insert({
                    event_date: selectedDate,
                    title,
                    sort_order,
                    layer
                })
                .select()
                .single();
            if(error || !data){ setStatus('Could not add event.'); return; }
            eventsByDate[selectedDate] = eventsByDate[selectedDate] || [];
            eventsByDate[selectedDate].push({
                id: data.id,
                title: data.title,
                sort_order: data.sort_order,
                layer: data.layer
            });
            input.value = '';
            renderGrid();
            renderEventsPanel();
        } catch(e){
            setStatus('Could not add event.');
        }
    });

    document.getElementById('cal-events').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-del-event]');
        if(!btn) return;
        const id = btn.getAttribute('data-del-event');
        try{
            await sb.from('household_events').delete().eq('id', id);
            eventsByDate[selectedDate] =
                (eventsByDate[selectedDate] || [])
                    .filter(ev => ev.id !== id);
            renderGrid();
            renderEventsPanel();
        } catch(err){
            setStatus('Could not remove event.');
        }
    });

    document.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && e.target.id === 'cal-new-event'){
            document.getElementById('cal-add-event').click();
        }
    });

    let realtimeChannel = null;
    let realtimeDebounceTimer = null;

    function setupRealtime(){
        if(realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('calendar-realtime-channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_events' }, () => {
                clearTimeout(realtimeDebounceTimer);
                realtimeDebounceTimer = setTimeout(() => {
                    loadMonth();

                    loadLayerOptions();

                    loadAllHistory('o', updateOPanel);
                    loadAllHistory('moon', updateMoonPanel);
                }, 300);
            })
            .subscribe();
    }

    function init(){
        const now = new Date();

        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        selectedDate = todayStr();

        loadMonth();

        loadLayerOptions();

        loadAllHistory('o', updateOPanel);
        loadAllHistory('moon', updateMoonPanel);

        setupRealtime();
    }

    document.addEventListener('click', e => {

        const btn = e.target.closest('.cal-overlay-btn');
        if (!btn) return;

        const layer = btn.dataset.layer;

        if (visibleLayers.has(layer)) {
            visibleLayers.delete(layer);
            btn.classList.remove('active');
        } else {
            visibleLayers.add(layer);
            btn.classList.add('active');
        }

        // show/hide moon panel
        const moonPanel = document.getElementById('moon-panel');
        if (moonPanel) {
            moonPanel.classList.toggle(
                'hidden',
                !visibleLayers.has('moon')
            );
            if (visibleLayers.has('moon')) {
                updateMoonPanel();
            }
        }

        // show/hide o panel
        const oPanel = document.getElementById('o-panel');
        if (oPanel) {
            oPanel.classList.toggle(
                'hidden',
                !visibleLayers.has('o')
            );
        }

        renderGrid();
        renderEventsPanel();

    });

    window.addEventListener('beforeunload', () => {
        if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    if(window.initAppPage){
        window.initAppPage(init);
    } else {
        document.addEventListener('app:ready', init, { once: true });
    }
})();