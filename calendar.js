(function(){
    const sb = window.supabaseClient;
    const getSeason = window.getSeason;
    const todayStr = window.todayStr;
    const updateSeason = window.updateSeason || function(){};
    let viewYear, viewMonth; // 0-indexed month
    let selectedDate; // 'YYYY-MM-DD'
    let eventsByDate = {}; // {'YYYY-MM-DD': [{id, title}]}

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
                eventsByDate[ev.event_date].push({id: ev.id, title: ev.title, sort_order: ev.sort_order});
            });
        } catch(err){
            console.error('Failed to load events:', err);
            setStatus('Could not load events.');
            eventsByDate = {};
        }
        renderGrid();
        renderEventsPanel();
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
            const count = (eventsByDate[c.dateStr] || []).length;
            const classes = ['cal-day'];
            if(c.otherMonth) classes.push('other-month');
            if(c.dateStr === today) classes.push('today');
            if(c.dateStr === selectedDate) classes.push('selected');
            const dots = count ? `<div class="cal-day-dot-row">${'<span class="cal-day-dot"></span>'.repeat(Math.min(count,4))}</div>` : '';
            return `<div class="${classes.join(' ')}" data-date="${c.dateStr}">
        <span class="cal-day-num">${c.label}</span>
        ${dots}
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

        const evs = eventsByDate[selectedDate] || [];
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
        if(!title) return;

        const currentEvents = eventsByDate[selectedDate] || [];
        const sort_order = currentEvents.length > 0
            ? Math.max(...currentEvents.map(ev => Number(ev.sort_order) || 0), currentEvents.length) + 1
            : 1;

        try{
            const {data, error} = await sb.from('household_events')
                .insert({event_date: selectedDate, title, sort_order})
                .select()
                .single();
            if(error || !data){ setStatus('Could not add event.'); return; }
            eventsByDate[selectedDate] = eventsByDate[selectedDate] || [];
            eventsByDate[selectedDate].push({id: data.id, title: data.title, sort_order: data.sort_order});
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
            eventsByDate[selectedDate] = (eventsByDate[selectedDate] || []).filter(ev => ev.id !== id);
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
        setupRealtime();
    }

    window.addEventListener('beforeunload', () => {
        if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    if(window.initAppPage){
        window.initAppPage(init);
    } else {
        document.addEventListener('app:ready', init, { once: true });
    }
})();