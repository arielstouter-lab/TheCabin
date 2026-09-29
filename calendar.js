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
    const isDefault = ev => layerOf(ev) === 'default';
    let projectedMoonDays = new Set();   // 'YYYY-MM-DD' strings, put near visibleLayers
    const PROJECTION_CYCLES = 12;
    const FLOW_KEYS = ['spotting', 'light', 'medium', 'heavy']; // placeholder names, match your titles
    const addDays = (date, n) =>
        new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

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

            let flows = '';
            if(flowKey){
                flows = `<div class="cal-day-flow flow-${flowKey}"></div>`;
            } else if(visibleLayers.has('moon') && !moonEvents.length && projectedMoonDays.has(c.dateStr)){
                flows = `<div class="cal-day-flow flow-projected"></div>`;
            }

            return `<div class="${classes.join(' ')}" data-date="${c.dateStr}">
        ${flows}
        <span class="cal-day-num">${c.label}</span>
        ${dots}${os}
    </div>`;
        }).join('');
    }

    function renderEventsPanel(){
        const list    = document.getElementById('cal-events');
        const pinned  = document.getElementById('cal-events-pinned');
        const divider = document.getElementById('cal-events-divider');
        const empty   = document.getElementById('cal-events-empty');
        const tpl     = document.getElementById('cal-event-template');

        const d = new Date(selectedDate + 'T00:00:00');
        document.getElementById('cal-selected-label').textContent =
            d.toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric'});

        const addRow = (parent, ev, index) => {
            const row = tpl.content.firstElementChild.cloneNode(true);
            row.dataset.eventRow = ev.id;
            row.querySelector('.cal-event-title').textContent = ev.title;
            row.querySelector('.icon-delete').dataset.delEvent = ev.id;
            if(index === null){
                row.querySelector('.drag-handle').remove();
            } else {
                row.classList.add('draggable-item');
                row.draggable = true;
                row.dataset.index = index;
            }
            parent.appendChild(row);
        };

        const evs = (eventsByDate[selectedDate] || [])
            .filter(ev => visibleLayers.has(layerOf(ev)));
        const defaults = evs.filter(isDefault);
        const others   = evs.filter(ev => !isDefault(ev));

        list.replaceChildren();
        pinned.replaceChildren();
        defaults.forEach((ev, i) => addRow(list, ev, i));
        others.forEach(ev => addRow(pinned, ev, null));

        divider.classList.toggle('hidden', !(defaults.length && others.length));
        empty.classList.toggle('hidden', evs.length > 0);
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


    function getMoonStats(){
        const lookback = document.getElementById('moon-lookback');
        if(!lookback) return null;

        const months = Number(lookback.value);
        const cutoff = new Date();
        if(months !== 999) cutoff.setMonth(cutoff.getMonth() - months);

        const filtered = (histories.moon || []).filter(row =>
            months === 999 || new Date(row.event_date + 'T00:00:00') >= cutoff
        );

        // ignore 1-day "cycles"
        const cycles = buildMoonCycles(filtered).filter(c => c.length > 1);
        if(!cycles.length) return null;

        const avgLength = cycles.reduce((s, c) => s + c.length, 0) / cycles.length;

        let totalGap = 0;
        for(let i = 1; i < cycles.length; i++){
            totalGap += (cycles[i][0] - cycles[i - 1][0]) / 86400000;
        }
        const avgGap = cycles.length > 1 ? totalGap / (cycles.length - 1) : 0;

        return { avgLength, avgGap, lastStart: cycles[cycles.length - 1][0] };
    }

    function buildProjection(stats){
        const days = new Set();
        if(!stats || stats.avgGap < 1) return days;   // need 2+ cycles to know the gap

        const gap = Math.round(stats.avgGap);
        const len = Math.max(1, Math.round(stats.avgLength));
        const today = todayStr();

        for(let k = 1; k <= PROJECTION_CYCLES; k++){
            for(let i = 0; i < len; i++){
                const dt = addDays(stats.lastStart, gap * k + i);
                const str = toDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
                if(str >= today) days.add(str);   // only future days
            }
        }
        return days;
    }

    function updateMoonPanel(){
        const stats = getMoonStats();
        projectedMoonDays = buildProjection(stats);

        const set = (id, text) => {
            const el = document.getElementById(id);
            if(el) el.textContent = text;
        };

        if(!stats || stats.avgGap < 1){
            set('moon-avg-length', stats ? stats.avgLength.toFixed(1) : '--');
            set('moon-avg-between', '--');
            set('moon-next-1', '--');
            set('moon-next-2', '--');
        } else {
            const gap = Math.round(stats.avgGap);
            set('moon-avg-length', stats.avgLength.toFixed(1));
            set('moon-avg-between', stats.avgGap.toFixed(1));
            set('moon-next-1', addDays(stats.lastStart, gap).toLocaleDateString());
            set('moon-next-2', addDays(stats.lastStart, gap * 2).toLocaleDateString());
        }

        renderGrid();   // projection changed, so redraw
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

        const defaults = (eventsByDate[selectedDate] || []).filter(isDefault);
        if (!defaults[fromIndex]) return;

        const slots = defaults.map(ev => ev.sort_order);
        const [moved] = defaults.splice(fromIndex, 1);
        defaults.splice(toIndex, 0, moved);
        defaults.forEach((ev, i) => { ev.sort_order = slots[i]; });

        eventsByDate[selectedDate].sort((a, b) => a.sort_order - b.sort_order);
        renderEventsPanel();

        try {
            const results = await Promise.all(defaults.map(ev =>
                sb.from('household_events')
                    .update({ sort_order: ev.sort_order })
                    .eq('id', ev.id)
            ));
            const failed = results.find(r => r.error);
            if (failed) throw failed.error;
        } catch (err) {
            console.error('Failed to save event order:', err);
            setStatus('Could not save event order.');
            loadMonth();
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

    document.getElementById('cal-events-wrap').addEventListener('click', async (e) => {
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