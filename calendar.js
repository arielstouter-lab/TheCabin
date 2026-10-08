import { writeOrQueue, nowStamp, getPendingOp, initSync } from './SharedJS/sync.js';

(function(){
    const sb = window.supabaseClient;
    const TABLES = window.TABLES;
    const todayStr = window.todayStr;
    const updateSeason = window.updateSeason || function(){};

    // ---------- constants ----------
    const MS_PER_DAY = 86400000;
    const PROJECTION_CYCLES = 12;
    const FLOW_KEYS = ['spotting', 'light', 'medium', 'heavy']; // match your moon event titles
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const LAYER_PANELS = { moon: 'moon-panel', o: 'o-panel' };  // layer -> stats panel id
    const CACHE_KEY = 'thecabin_cached_calendar';
    const LISTS_CACHE_KEY = 'thecabin_cached_lists';

// Keeps the Lists page's offline cache in step when an item is checked here,
// so Lists doesn't briefly show it unchecked while the write is still queued.
    function patchListsCache(id, patch){
        try{
            const raw = localStorage.getItem(LISTS_CACHE_KEY);
            if(!raw) return;
            const data = JSON.parse(raw);
            Object.values(data.itemsBySection || {}).forEach(items => {
                const item = items.find(i => i.id === id);
                if(item) Object.assign(item, patch);
            });
            localStorage.setItem(LISTS_CACHE_KEY, JSON.stringify(data));
        } catch(e){}
    }

    // ---------- state ----------
    const histories = { o: [], moon: [] };        // every event_date per layer, ascending
    const visibleLayers = new Set(['default', 'list']);
    let viewYear, viewMonth;                      // month is 0-indexed
    let selectedDate;                             // 'YYYY-MM-DD'
    let eventsByDate = {};                        // 'YYYY-MM-DD' -> [event rows]
    let projectedMoonDays = new Set();            // 'YYYY-MM-DD' strings

    // ---------- helpers ----------
    const $ = id => document.getElementById(id);
    const setText = (id, text) => { const el = $(id); if(el) el.textContent = text; };
    const pad = n => String(n).padStart(2, '0');
    const toDateStr = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const parseDate = str => new Date(str + 'T00:00:00');
    const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
    const daysBetween = (a, b) => Math.round((b - a) / MS_PER_DAY);   // round: DST days aren't 24h
    const average = list => list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : 0;

    const layerOf = ev => ev.layer || 'default';   // null layer = default
    const isDefault = ev => layerOf(ev) === 'default';
    const isVisible = ev => visibleLayers.has(layerOf(ev));

    function render(){
        renderGrid();
        renderEventsPanel();
    }

    // ---------- local cache -----------------------------------------------
    // Lets the currently-viewed month render instantly offline, before (or
    // instead of) the network fetch. Only used if it matches the month
    // we're about to show, so switching months doesn't flash stale data.

    function saveToLocalCache(){
        try{
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                eventsByDate, histories, viewYear, viewMonth, timestamp: Date.now()
            }));
        } catch(e){}
    }

    function loadFromLocalCache(){
        try{
            const raw = localStorage.getItem(CACHE_KEY);
            if(!raw) return false;
            const data = JSON.parse(raw);
            if(!data || data.viewYear !== viewYear || data.viewMonth !== viewMonth) return false;
            eventsByDate = data.eventsByDate || {};
            if(data.histories){
                histories.o = data.histories.o || [];
                histories.moon = data.histories.moon || [];
            }
            return true;
        } catch(e){
            return false;
        }
    }

    // Merges freshly-loaded server events with anything still pending in the
    // offline write queue, so a reload can't silently discard a not-yet-synced
    // local add/edit/delete. Same approach as the Lists page.
    function mergeEventsWithPendingWrites(serverEvents){
        const previousById = {};
        Object.values(eventsByDate).flat().forEach(ev => { previousById[ev.id] = ev; });

        const next = {};
        serverEvents.forEach(ev => {
            const op = getPendingOp(TABLES.EVENTS, ev.id);
            if(op && op.type === 'delete') return; // deleted locally, not yet synced
            const finalEv = (op && op.type === 'update' && previousById[ev.id]) ? previousById[ev.id] : ev;
            (next[finalEv.event_date] ||= []).push(finalEv);
        });

        const serverIds = new Set(serverEvents.map(ev => ev.id));
        Object.values(previousById).forEach(ev => {
            const op = getPendingOp(TABLES.EVENTS, ev.id);
            if(op && op.type === 'insert' && !serverIds.has(ev.id)){
                (next[ev.event_date] ||= []).push(ev);
            }
        });

        return next;
    }

    // ---------- data loading ----------
// Dated list items show up as a read-only 'list' layer. They're derived at
// load time and never copied into the events table. Checked or deleted items
// (including ones whose write is still queued) are left out.
    function addListItems(rows){
        rows.forEach(row => {
            const op = getPendingOp(TABLES.LIST_ITEMS, row.id);
            if(op && op.type === 'delete') return;
            const item = (op && op.type === 'update') ? { ...row, ...op.payload } : row;
            if(item.checked || !item.due_date) return;
            (eventsByDate[item.due_date] ||= []).push({
                id: item.id, title: item.text, event_date: item.due_date,
                layer: 'list', source: 'list', sort_order: 0
            });
        });
    }

    async function loadMonth(){
        const first = toDateStr(new Date(viewYear, viewMonth, 1));
        const last = toDateStr(new Date(viewYear, viewMonth + 1, 0));

        if(loadFromLocalCache()){
            render();
        }

        try{
            const [events, items] = await Promise.all([
                sb.from(TABLES.EVENTS)
                    .select('*')
                    .gte('event_date', first)
                    .lte('event_date', last)
                    .order('sort_order', { ascending: true }),
                sb.from(TABLES.LIST_ITEMS)
                    .select('id, text, due_date, checked')
                    .gte('due_date', first)
                    .lte('due_date', last)
            ]);
            if(events.error) throw events.error;
            if(items.error) throw items.error;

            eventsByDate = mergeEventsWithPendingWrites(events.data || []);
            addListItems(items.data || []);
            saveToLocalCache();
        } catch(err){
            console.error('Failed to load events:', err);
            if(!Object.keys(eventsByDate).length){
                setStatus('Could not load events.');
            }
        }
        render();
    }

    async function loadLayerOptions(){
        const select = $('cal-event-layer');
        if(!select) return;
        try{
            const { data, error } = await sb.from(TABLES.EVENTS).select('layer');
            if(error) throw error;

            const layers = [...new Set((data || []).map(row => row.layer).filter(Boolean))].sort();
            const current = select.value;

            select.replaceChildren(new Option('Default', ''), ...layers.map(layer => new Option(layer, layer)));
            if(layers.includes(current)) select.value = current;
        } catch(err){
            console.error('Failed to load layer options', err);
        }
    }

    async function loadHistory(layer){
        try{
            const { data, error } = await sb.from(TABLES.EVENTS)
                .select('event_date')
                .eq('layer', layer)
                .order('event_date', { ascending: true });
            if(error) throw error;
            histories[layer] = data || [];
        } catch(err){
            console.error(`Failed to load ${layer} history`, err);
        }
    }

    async function refreshStats(){
        await Promise.all([loadHistory('o'), loadHistory('moon')]);
        updateOPanel();
        updateMoonPanel();
        renderGrid();   // projection may have changed
    }

    function refreshAll(){
        loadMonth();
        loadLayerOptions();
        refreshStats();
    }

    // ---------- calendar grid ----------
    function renderGrid(){
        updateSeason(new Date(viewYear, viewMonth, 1));   // month has no day, so use the 1st
        setText('cal-month-label', `${MONTH_NAMES[viewMonth]} ${viewYear}`);

        // always 6 weeks, starting on the Sunday on or before the 1st
        const startOffset = 1 - new Date(viewYear, viewMonth, 1).getDay();
        const today = todayStr();
        $('cal-days').innerHTML = Array.from({ length: 42 }, (_, i) =>
            renderDay(new Date(viewYear, viewMonth, startOffset + i), today)
        ).join('');
    }

    function renderDay(date, today){
        const dateStr = toDateStr(date);
        const events = (eventsByDate[dateStr] || []).filter(isVisible);
        const inLayer = layer => events.filter(ev => layerOf(ev) === layer);

        const defaultCount = inLayer('default').length;
        const moonEvents = inLayer('moon');

        const classes = ['cal-day'];
        if(date.getMonth() !== viewMonth) classes.push('other-month');
        if(dateStr === today) classes.push('today');
        if(dateStr === selectedDate) classes.push('selected');

        const dotCount = defaultCount + inLayer('list').length;
        const dots = dotCount
            ? `<div class="cal-day-dot-row">${'<span class="cal-day-dot"></span>'.repeat(Math.min(dotCount, 4))}</div>`
            : '';

        // os: single icon
        const os = inLayer('o').length ? '<span class="cal-day-o">💥</span>' : '';

        // flows: tint chosen by event title; logged days beat projected ones
        const flowKey = moonEvents
            .map(ev => (ev.title || '').trim().toLowerCase())
            .find(title => FLOW_KEYS.includes(title));
        const isProjected = visibleLayers.has('moon') && !moonEvents.length && projectedMoonDays.has(dateStr);
        const flowClass = flowKey ? `flow-${flowKey}` : isProjected ? 'flow-projected' : '';
        const flows = flowClass ? `<div class="cal-day-flow ${flowClass}"></div>` : '';

        return `<div class="${classes.join(' ')}" data-date="${dateStr}">
            ${flows}
            <span class="cal-day-num">${date.getDate()}</span>
            ${dots}${os}
        </div>`;
    }

    // ---------- events panel ----------
    function renderEventsPanel(){
        const list    = $('cal-events');
        const pinned  = $('cal-events-pinned');
        const divider = $('cal-events-divider');
        const empty   = $('cal-events-empty');
        const tpl     = $('cal-event-template');

        setText('cal-selected-label', parseDate(selectedDate)
            .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));

        // index === null means pinned (not draggable)
        const addRow = (parent, ev, index) => {
            const row = tpl.content.firstElementChild.cloneNode(true);
            row.dataset.eventRow = ev.id;
            row.querySelector('.cal-event-title').textContent =
                (ev.layer === 'moon' ? 'Flow: ' : '') + ev.title;

            if(ev.source === 'list'){
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.className = 'cal-event-check';
                box.dataset.checkItem = ev.id;
                row.querySelector('.icon-delete').remove();
                row.prepend(box);
            } else {
                row.querySelector('.icon-delete').dataset.delEvent = ev.id;
            }

            if(index === null){
                row.querySelector('.drag-handle').remove();
            } else {
                row.classList.add('draggable-item');
                row.draggable = true;
                row.dataset.index = index;
            }
            parent.appendChild(row);
        };

        const evs = (eventsByDate[selectedDate] || []).filter(isVisible);
        const defaults = evs.filter(isDefault);
        const others = evs.filter(ev => !isDefault(ev));

        list.replaceChildren();
        pinned.replaceChildren();
        defaults.forEach((ev, i) => addRow(list, ev, i));
        others.forEach(ev => addRow(pinned, ev, null));

        divider.classList.toggle('hidden', !(defaults.length && others.length));
        empty.classList.toggle('hidden', evs.length > 0);
    }

    // Each row's sort_order update is queued independently (last-write-wins
    // per row), rather than one bulk call — local order is trusted and
    // never reverted; if offline, it just sits queued until it syncs.
    async function reorderEvents(fromIndex, toIndex){
        if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

        const defaults = (eventsByDate[selectedDate] || []).filter(isDefault);
        if(!defaults[fromIndex]) return;

        // reuse the sort_order values already in use, just in the new order
        const slots = defaults.map(ev => ev.sort_order);
        const [moved] = defaults.splice(fromIndex, 1);
        defaults.splice(toIndex, 0, moved);

        const updated_at = nowStamp();
        defaults.forEach((ev, i) => { ev.sort_order = slots[i]; ev.updated_at = updated_at; });

        eventsByDate[selectedDate].sort((a, b) => a.sort_order - b.sort_order);
        saveToLocalCache();
        renderEventsPanel();

        await Promise.all(defaults.map(ev =>
            writeOrQueue(sb, {
                table: TABLES.EVENTS, type: 'update', id: ev.id,
                payload: { sort_order: ev.sort_order, updated_at }
            })
        ));
    }

    function selectDate(dateStr){
        selectedDate = dateStr;
        const date = parseDate(dateStr);
        if(date.getFullYear() !== viewYear || date.getMonth() !== viewMonth){
            viewYear = date.getFullYear();
            viewMonth = date.getMonth();
            loadMonth();
        } else {
            render();
        }
    }

    function changeMonth(delta){
        if(viewYear === undefined) return;
        const date = new Date(viewYear, viewMonth + delta, 1);
        viewYear = date.getFullYear();
        viewMonth = date.getMonth();
        loadMonth();
    }

    // ---------- moon stats + projection ----------
    // rows: [{event_date}] ascending -> array of cycles, each an array of consecutive Dates
    function buildMoonCycles(rows){
        const dates = [...new Set(rows.map(row => row.event_date))].map(parseDate);   // dedupe same-day events
        const cycles = [];
        dates.forEach((date, i) => {
            if(i > 0 && daysBetween(dates[i - 1], date) === 1){
                cycles[cycles.length - 1].push(date);
            } else {
                cycles.push([date]);
            }
        });
        return cycles;
    }

    function getMoonStats(){
        const lookback = $('moon-lookback');
        if(!lookback) return null;

        const months = Number(lookback.value);
        const cutoff = new Date();
        if(months !== 999) cutoff.setMonth(cutoff.getMonth() - months);

        const rows = histories.moon.filter(row =>
            months === 999 || parseDate(row.event_date) >= cutoff
        );

        // ignore 1-day "cycles"
        const cycles = buildMoonCycles(rows).filter(cycle => cycle.length > 1);
        if(!cycles.length) return null;

        const gaps = cycles.slice(1).map((cycle, i) => daysBetween(cycles[i][0], cycle[0]));

        return {
            avgLength: average(cycles.map(cycle => cycle.length)),
            avgGap: average(gaps),   // 0 when there's only one cycle
            lastStart: cycles[cycles.length - 1][0]
        };
    }

    const projectedStart = (stats, k) => addDays(stats.lastStart, Math.round(stats.avgGap) * k);

    function buildProjection(stats){
        const days = new Set();
        const length = Math.max(1, Math.round(stats.avgLength));
        const today = todayStr();

        for(let k = 1; k <= PROJECTION_CYCLES; k++){
            const start = projectedStart(stats, k);
            for(let i = 0; i < length; i++){
                const str = toDateStr(addDays(start, i));
                if(str >= today) days.add(str);   // only future days
            }
        }
        return days;
    }

    function updateMoonPanel(){
        const stats = getMoonStats();
        const canProject = !!stats && stats.avgGap >= 1;   // need 2+ cycles to know the gap

        projectedMoonDays = canProject ? buildProjection(stats) : new Set();

        setText('moon-avg-length', stats ? stats.avgLength.toFixed(1) : '--');
        setText('moon-avg-between', canProject ? stats.avgGap.toFixed(1) : '--');
        setText('moon-next-1', canProject ? projectedStart(stats, 1).toLocaleDateString() : '--');
        setText('moon-next-2', canProject ? projectedStart(stats, 2).toLocaleDateString() : '--');
    }

    // ---------- "o" stats ----------
    function updateOPanel(){
        const dates = histories.o.map(row => parseDate(row.event_date));
        if(!dates.length){
            setText('o-days-since', '--');
            setText('o-longest-gap', '--');
            return;
        }

        const daysSince = daysBetween(dates[dates.length - 1], parseDate(todayStr()));
        const gaps = dates.slice(1).map((date, i) => daysBetween(dates[i], date));

        setText('o-days-since', String(daysSince));
        setText('o-longest-gap', String(Math.max(daysSince, ...gaps)));   // the current streak counts too
    }

    // ---------- realtime ----------
    let realtimeChannel = null;

    function setupRealtime(){
        if(realtimeChannel || !sb) return;
        const timers = {};
        const handlers = [
            [TABLES.EVENTS, refreshAll],
            [TABLES.LIST_ITEMS, loadMonth]   // list changes only need the month reloaded
        ];
        let channel = sb.channel('calendar-realtime-channel');
        handlers.forEach(([table, handler]) => {
            channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
                clearTimeout(timers[table]);
                timers[table] = setTimeout(handler, 300);
            });
        });
        realtimeChannel = channel.subscribe();
    }

    // ---------- event listeners ----------
    $('cal-prev').addEventListener('click', () => changeMonth(-1));
    $('cal-next').addEventListener('click', () => changeMonth(1));

    $('cal-days').addEventListener('click', e => {
        const cell = e.target.closest('.cal-day');
        if(cell) selectDate(cell.dataset.date);
    });

    $('moon-lookback')?.addEventListener('change', () => {
        updateMoonPanel();
        renderGrid();
    });

    // overlay buttons: toggle the layer and its stats panel
    document.addEventListener('click', e => {
        const btn = e.target.closest('.cal-overlay-btn');
        if(!btn) return;

        const layer = btn.dataset.layer;
        const nowVisible = !visibleLayers.has(layer);
        if(nowVisible) visibleLayers.add(layer); else visibleLayers.delete(layer);

        btn.classList.toggle('active', nowVisible);
        $(LAYER_PANELS[layer])?.classList.toggle('hidden', !nowVisible);
        render();
    });

    initDragAndDrop($('cal-events'), { onReorder: reorderEvents });

    $('cal-add-event').addEventListener('click', async () => {
        const input = $('cal-new-event');
        const title = input.value.trim();
        if(!title) return;

        const layer = $('cal-event-layer').value || null;
        const events = eventsByDate[selectedDate] || [];
        const sort_order = Math.max(0, events.length, ...events.map(ev => Number(ev.sort_order) || 0)) + 1;

        // Client-generated id so the event shows up immediately even offline;
        // the same id ships with the queued insert, so the eventual server
        // row lines up with this one instead of creating a duplicate.
        const id = crypto.randomUUID();
        const updated_at = nowStamp();
        const basePayload = { event_date: selectedDate, title, sort_order, layer };
        const localEvent = { id, ...basePayload, updated_at };

        (eventsByDate[selectedDate] ||= []).push(localEvent);
        saveToLocalCache();
        input.value = '';
        render();

        await writeOrQueue(sb, {
            table: TABLES.EVENTS, type: 'insert', id,
            payload: { id, ...basePayload, updated_at }
        });
    });

    $('cal-new-event').addEventListener('keydown', e => {
        if(e.key === 'Enter') $('cal-add-event').click();
    });

    $('cal-events-wrap').addEventListener('click', async e => {
        const btn = e.target.closest('[data-del-event]');
        if(!btn) return;

        const id = btn.dataset.delEvent;
        eventsByDate[selectedDate] = (eventsByDate[selectedDate] || [])
            .filter(ev => String(ev.id) !== id);
        saveToLocalCache();
        render();

        await writeOrQueue(sb, { table: TABLES.EVENTS, type: 'delete', id });
    });

    $('cal-events-wrap').addEventListener('change', async e => {
        const box = e.target.closest('.cal-event-check');
        if(!box) return;

        const id = box.dataset.checkItem;
        const updated_at = nowStamp();

        eventsByDate[selectedDate] = (eventsByDate[selectedDate] || [])
            .filter(ev => String(ev.id) !== id);
        patchListsCache(id, { checked: true, updated_at });
        saveToLocalCache();
        render();

        await writeOrQueue(sb, {
            table: TABLES.LIST_ITEMS, type: 'update', id,
            payload: { checked: true, updated_at }
        });
    });

    window.addEventListener('beforeunload', () => {
        if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    // Event writes that fail (or happen while offline) are queued and
    // retried automatically on reconnect.
    initSync(sb, {
        onChange: n => setStatus(n ? `${n} change${n === 1 ? '' : 's'} pending sync…` : '')
    });

    // ---------- init ----------
    function init(){
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        selectedDate = todayStr();

        refreshAll();
        setupRealtime();
    }

    if(window.initAppPage){
        window.initAppPage(init);
    } else {
        document.addEventListener('app:ready', init, { once: true });
    }
})();