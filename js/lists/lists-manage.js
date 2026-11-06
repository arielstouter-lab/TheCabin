import { writeOrQueue, nowStamp, initSync, withTimeout } from '../shared/sync.js';
import { TABLES, RPC } from '../shared/database-config.js';
import { supabase as sb } from '../shared/supabase.js';
import { groceryKey, groceryKeysMatch, escapeHtml, setStatus, initDragAndDrop } from '../app.js';
import { initAppPage } from '../shared/auth.js';

const CACHE_KEY = 'thecabin_cached_lists_manage';
const LOAD_TIMEOUT_MS = 6000;

let groceries = null;
let groceryItems = [];
let aisles = [];
let itemMemory = [];
let mappingSearchQuery = '';
let reorderSaveToken = 0;

    function saveToLocalCache(){
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                groceries,
                groceryItems,
                aisles,
                itemMemory,
                timestamp: Date.now()
            }));
        } catch(e){}
    }

    function loadFromLocalCache(){
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if(!raw) return false;
            const data = JSON.parse(raw);
            if(!data || !Array.isArray(data.aisles)) return false;
            groceries = data.groceries || null;
            groceryItems = data.groceryItems || [];
            aisles = data.aisles || [];
            itemMemory = data.itemMemory || [];
            return true;
        } catch(e){
            return false;
        }
    }

    function sortedAisles(){
        return [...aisles].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }

    function aisleOptionsHtml(selectedId){
        const blank = `<option value="">Unassigned</option>`;
        const opts = sortedAisles().map(a =>
            `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
        ).join('');
        return blank + opts;
    }

    async function loadAll(){
        const hadCached = loadFromLocalCache();
        if(hadCached){
            render();
        }

        try{
            const [sectionResult, aisleResult, memoryResult] = await withTimeout(Promise.all([
                sb.from(TABLES.LIST_SECTIONS).select('*'),
                sb.from(TABLES.GROCERY_AISLES).select('*').order('sort_order'),
                sb.from(TABLES.GROCERY_ITEM_MEMORY).select('*')
            ]), LOAD_TIMEOUT_MS, 'Loading manage groceries');

            const loadErrors = [sectionResult.error, aisleResult.error, memoryResult.error].filter(Boolean);
            if(loadErrors.length){
                console.error('Manage groceries load errors:', loadErrors);
                throw loadErrors[0];
            }

            const sections = sectionResult.data || [];
            const params = new URLSearchParams(location.search);
            const sectionId = params.get('section');

            const activeSection =
                sections.find(s => s.id === sectionId)
                || sections.find(s => s.name === 'Groceries')
                || null;
            groceries = activeSection;
            aisles = aisleResult.data || [];
            itemMemory = memoryResult.data || [];

            if(groceries){
                const itemResult = await sb.from(TABLES.LIST_ITEMS)
                    .select('*')
                    .eq('section_id', groceries.id);
                if(itemResult.error){
                    console.error('Could not load grocery items:', itemResult.error);
                } else {
                    groceryItems = itemResult.data || [];
                }
            } else {
                groceryItems = [];
            }
            render();
            saveToLocalCache();
        } catch(e){
            console.error('Could not load manage-groceries data:', e);
            if(!hadCached){
                setStatus('Could not load groceries data.');
                aisles = [];
                itemMemory = [];
                groceryItems = [];
                render();
            }
        }
        setupRealtime();
    }

    // ---- Aisles ---------------------------------------------------

    function renderAisles(){
        const listEl = document.getElementById('mg-aisle-list');
        const list = sortedAisles();
        listEl.innerHTML = list.length ? list.map((aisle, index) => `
          <div class="lst-item draggable-item" draggable="true" data-index="${index}" data-item-row="${aisle.id}">
            <div class="lst-item-top">
              <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
              <input type="text" class="text-input" data-aisle-name="${aisle.id}" value="${escapeHtml(aisle.name)}" />
              <button class="icon-delete" data-del-aisle="${aisle.id}" title="Remove aisle">✕</button>
            </div>
          </div>`).join('') : '<p class="empty-state">No aisles yet — add one below.</p>';
    }

    async function addAisle(name){
        const trimmed = name.trim();
        if(!trimmed) return;
        const maxSort = aisles.reduce((max, a) => Math.max(max, a.sort_order || 0), 0);
        const newAisle = {
            id: crypto.randomUUID(),
            name: trimmed,
            sort_order: maxSort + 1,
            created_at: nowStamp()
        };
        aisles.push(newAisle);
        render();
        saveToLocalCache();

        writeOrQueue(sb, {
            table: TABLES.GROCERY_AISLES,
            type: 'insert',
            id: newAisle.id,
            payload: newAisle
        });
        setStatus('Aisle added.');
    }

    async function renameAisle(id, name){
        const trimmed = name.trim();
        if(!trimmed) return;
        const aisle = aisles.find(a => a.id === id);
        if(!aisle || aisle.name === trimmed) return;
        aisle.name = trimmed;
        render();
        saveToLocalCache();

        writeOrQueue(sb, {
            table: TABLES.GROCERY_AISLES,
            type: 'update',
            id: id,
            payload: { name: trimmed, updated_at: nowStamp() }
        });
    }

    async function deleteAisle(id){
        if(!confirm('Remove this aisle? Items assigned to it will become unassigned.')) return;

        aisles = aisles.filter(a => a.id !== id);
        const affectedItemIds = [];
        groceryItems = groceryItems.map(i => {
            if (i.aisle_id === id) {
                affectedItemIds.push(i.id);
                return { ...i, aisle_id: null };
            }
            return i;
        });
        const affectedMemoryKeys = [];
        itemMemory = itemMemory.map(m => {
            if (m.aisle_id === id) {
                affectedMemoryKeys.push(m.item_key);
                return { ...m, aisle_id: null };
            }
            return m;
        });
        render();
        saveToLocalCache();

        affectedItemIds.forEach(itemId => {
            writeOrQueue(sb, {
                table: TABLES.LIST_ITEMS,
                type: 'update',
                id: itemId,
                payload: { aisle_id: null, updated_at: nowStamp() }
            });
        });
        affectedMemoryKeys.forEach(key => {
            writeOrQueue(sb, {
                table: TABLES.GROCERY_ITEM_MEMORY,
                type: 'update',
                id: key,
                idColumn: 'item_key',
                payload: { aisle_id: null, updated_at: nowStamp() }
            });
        });
        writeOrQueue(sb, {
            table: TABLES.GROCERY_AISLES,
            type: 'delete',
            id: id
        });
        setStatus('Aisle removed.');
    }

    async function reorderAisles(fromIndex, toIndex){
        if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

        const ordered = sortedAisles();
        const [moved] = ordered.splice(fromIndex, 1);
        if(!moved) return;
        const targetIndex = Math.min(toIndex, ordered.length);
        ordered.splice(targetIndex, 0, moved);
        ordered.forEach((aisle, idx) => { aisle.sort_order = idx + 1; });

        aisles = ordered;
        render();
        saveToLocalCache();

        ordered.forEach(aisle => {
            writeOrQueue(sb, {
                table: TABLES.GROCERY_AISLES,
                type: 'update',
                id: aisle.id,
                payload: { sort_order: aisle.sort_order, updated_at: nowStamp() }
            });
        });
    }

    // ---- Item -> aisle assignment ----------------------------------

    // Updates (or creates) the remembered aisle for an item's normalized
    // text, and pushes the same aisle onto any matching items currently
    // sitting in the live Groceries list so the change shows up there
    // immediately, without waiting for the item to be re-added.
    async function setItemAisle(rawText, aisleId){
        const text = rawText.trim();
        if(!text) return;
        const key = groceryKey(text);
        if(!key) return;
        const existingMemory = itemMemory.find(m => m.item_key === key);

        if(existingMemory){
            itemMemory = itemMemory.map(m => m.item_key === key ? {...m, aisle_id: aisleId || null} : m);
        } else {
            itemMemory = [...itemMemory, {item_key: key, aisle_id: aisleId || null, id: `pending-${key}`}];
        }
        const matchingIds = [];
        groceryItems = groceryItems.map(i => {
            if (groceryKey(i.text) === key) {
                matchingIds.push(i.id);
                return {...i, aisle_id: aisleId || null};
            }
            return i;
        });
        render();
        saveToLocalCache();

        const nowIso = nowStamp();
        writeOrQueue(sb, {
            table: TABLES.GROCERY_ITEM_MEMORY,
            type: 'upsert',
            id: key,
            idColumn: 'item_key',
            payload: { item_key: key, aisle_id: aisleId || null, updated_at: nowIso },
            options: { onConflict: 'item_key' }
        });

        matchingIds.forEach(id => {
            writeOrQueue(sb, {
                table: TABLES.LIST_ITEMS,
                type: 'update',
                id: id,
                payload: { aisle_id: aisleId || null, updated_at: nowIso }
            });
        });
        setStatus('Aisle updated.');
    }

    async function deleteMapping(itemKey){
        itemMemory = itemMemory.filter(m => m.item_key !== itemKey);
        render();
        saveToLocalCache();

        writeOrQueue(sb, {
            table: TABLES.GROCERY_ITEM_MEMORY,
            type: 'delete',
            id: itemKey,
            idColumn: 'item_key'
        });
        setStatus('Mapping removed.');
    }

    // ---- Rendering: unassigned + mappings --------------------------

    function renderUnassigned(){
        const panelEl = document.getElementById('mg-unassigned-panel');
        const listEl = document.getElementById('mg-unassigned-list');
        const unassigned = groceryItems.filter(i => !i.checked && !i.aisle_id);

        if(!unassigned.length){
            panelEl.style.display = 'none';
            listEl.innerHTML = '';
            return;
        }
        panelEl.style.display = '';
        listEl.innerHTML = unassigned.map(item => `
          <div class="lst-item lst-item-row" data-item-row="${item.id}">
            <span class="lst-item-text">${escapeHtml(item.text)}</span>
            <select data-assign-item-text="${escapeHtml(item.text)}">
              ${aisleOptionsHtml(item.aisle_id)}
            </select>
          </div>`).join('');
    }

    function renderMappings(){
        const listEl = document.getElementById('mg-mapping-list');
        const q = groceryKey(mappingSearchQuery);

        const currentItems = groceryItems
            .filter(item => !item.checked)
            .filter(item => !q || groceryKey(item.text).includes(q) || groceryKeysMatch(item.text, q))
            .sort((a, b) => groceryKey(a.text).localeCompare(groceryKey(b.text)));

        listEl.innerHTML = currentItems.length ? currentItems.map(item => `
          <div class="lst-item lst-item-row" data-item-row="${item.id}">
            <span class="lst-item-text">${escapeHtml(item.text)}</span>
            <div class="lst-actions">
              <select data-assign-item-text="${escapeHtml(item.text)}">
                ${aisleOptionsHtml(item.aisle_id)}
              </select>
            </div>
          </div>`).join('') : `<p class="empty-state">${mappingSearchQuery ? 'No current grocery items match your search.' : 'No current grocery items.'}</p>`;
    }

    function renderMappingAisleSelect(){
        const selectEl = document.getElementById('mg-new-mapping-aisle');
        const current = selectEl.value;
        selectEl.innerHTML = aisleOptionsHtml(current || null);
    }

    function render(){
        renderUnassigned();
        renderMappings();
        renderAisles();
        renderMappingAisleSelect();
    }

    // ---- Event wiring ------------------------------------------------

    document.getElementById('done-btn').addEventListener('click', () => {
        sessionStorage.setItem('reloadOnReturn', 'true');
        const params = new URLSearchParams(location.search);
        const returnUrl = params.get('return');
        if (returnUrl) {
            location.href = returnUrl;
            return;
        }
        if (groceries && groceries.name && groceries.name.toLowerCase() === 'moving') {
            location.href = 'moving.html';
            return;
        }
        if (document.referrer) {
            try {
                const ref = new URL(document.referrer);
                if (ref.origin === location.origin && (ref.pathname.includes('moving.html') || ref.pathname.includes('lists.html'))) {
                    location.href = ref.pathname + ref.search + ref.hash;
                    return;
                }
            } catch (e) {}
        }
        if (window.history.length > 1) {
            history.back();
            return;
        }
        location.href = 'lists.html';
    });

    document.getElementById('mg-add-aisle').addEventListener('click', async () => {
        const input = document.getElementById('mg-new-aisle-name');
        await addAisle(input.value);
        input.value = '';
    });

    document.getElementById('mg-new-aisle-name').addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){
            e.preventDefault();
            document.getElementById('mg-add-aisle').click();
        }
    });

    document.getElementById('mg-aisle-list').addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-del-aisle]');
        if(delBtn){
            await deleteAisle(delBtn.getAttribute('data-del-aisle'));
        }
    });

    document.getElementById('mg-aisle-list').addEventListener('change', async (e) => {
        if(e.target.matches('[data-aisle-name]')){
            await renameAisle(e.target.getAttribute('data-aisle-name'), e.target.value);
        }
    });

    document.getElementById('mg-aisle-list').addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && e.target.matches('[data-aisle-name]')){
            e.preventDefault();
            e.target.blur();
        }
    });

    document.getElementById('mg-unassigned-list').addEventListener('change', async (e) => {
        if(e.target.matches('[data-assign-item-text]')){
            const text = e.target.getAttribute('data-assign-item-text');
            await setItemAisle(text, e.target.value || null);
        }
    });

    document.getElementById('mg-mapping-list').addEventListener('change', async (e) => {
        if(e.target.matches('[data-assign-item-text]')){
            const text = e.target.getAttribute('data-assign-item-text');
            await setItemAisle(text, e.target.value || null);
            return;
        }

        if(e.target.matches('[data-assign-mapping-key]')){
            const key = e.target.getAttribute('data-assign-mapping-key');
            await setItemAisle(key, e.target.value || null);
        }
    });

    document.getElementById('mg-mapping-list').addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-del-mapping]');
        if(delBtn){
            await deleteMapping(delBtn.getAttribute('data-del-mapping'));
        }
    });

    document.getElementById('mg-mapping-search').addEventListener('input', (e) => {
        mappingSearchQuery = e.target.value;
        renderMappings();
    });

    document.getElementById('mg-add-mapping').addEventListener('click', async () => {
        const textInput = document.getElementById('mg-new-mapping-text');
        const aisleSelect = document.getElementById('mg-new-mapping-aisle');
        const text = textInput.value.trim();
        if(!text) return;
        await setItemAisle(text, aisleSelect.value || null);
        textInput.value = '';
    });

    document.getElementById('mg-new-mapping-text').addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){
            e.preventDefault();
            document.getElementById('mg-add-mapping').click();
        }
    });

    const aisleListEl = document.getElementById('mg-aisle-list');
    initDragAndDrop(aisleListEl, {
        canDrag: () => true,
        onReorder: (fromIndex, toIndex) => reorderAisles(fromIndex, toIndex)
    });

    let realtimeChannel = null;
    let realtimeDebounceTimer = null;

    function setupRealtime(){
        if(realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('manage-groceries-realtime-channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.GROCERY_AISLES }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.GROCERY_ITEM_MEMORY }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.LIST_ITEMS }, () => debounceReload())
            .subscribe();
    }

    function debounceReload(){
        clearTimeout(realtimeDebounceTimer);
        realtimeDebounceTimer = setTimeout(() => {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT')) {
                return;
            }
            loadAll();
        }, 400);
    }

    window.addEventListener('beforeunload', () => {
        if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    window.addEventListener('sync:flushed', () => {
        debounceReload();
    });

    initAppPage(() => {
        if(sb) initSync(sb);
        loadAll();
    });