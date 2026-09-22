(function(){
    const sb = window.supabaseClient;

    let groceries = null;
    let groceryItems = [];
    let aisles = [];
    let itemMemory = [];
    let mappingSearchQuery = '';
    let reorderSaveToken = 0;

    function sortedAisles(){
        return [...aisles].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }

    function aisleName(id){
        const a = aisles.find(a => a.id === id);
        return a ? a.name : null;
    }

    function aisleOptionsHtml(selectedId){
        const blank = `<option value="">Unassigned</option>`;
        const opts = sortedAisles().map(a =>
            `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
        ).join('');
        return blank + opts;
    }

    async function loadAll(){
        try{
            const [sectionResult, aisleResult, memoryResult] = await Promise.all([
                sb.from('household_list_sections').select('*'),
                sb.from('household_grocery_aisles').select('*').order('sort_order'),
                sb.from('household_grocery_item_memory').select('*')
            ]);

            const loadErrors = [sectionResult.error, aisleResult.error, memoryResult.error].filter(Boolean);
            if(loadErrors.length){
                console.error('Manage groceries load errors:', loadErrors);
                throw loadErrors[0];
            }

            const sections = sectionResult.data || [];
            groceries = sections.find(s => s.name === 'Groceries') || null;
            aisles = aisleResult.data || [];
            itemMemory = memoryResult.data || [];

            if(groceries){
                const itemResult = await sb.from('household_list_items')
                    .select('*')
                    .eq('section_id', groceries.id);
                if(itemResult.error){
                    console.error('Could not load grocery items:', itemResult.error);
                    groceryItems = [];
                } else {
                    groceryItems = itemResult.data || [];
                }
            } else {
                groceryItems = [];
            }
        } catch(e){
            console.error('Could not load manage-groceries data:', e);
            setStatus('Could not load groceries data.');
            aisles = [];
            itemMemory = [];
            groceryItems = [];
        }
        render();
    }

    // ---- Aisles ---------------------------------------------------

    function renderAisles(){
        const listEl = document.getElementById('mg-aisle-list');
        const list = sortedAisles();
        listEl.innerHTML = list.length ? list.map((aisle, index) => `
          <div class="lst-item draggable-item" draggable="true" data-index="${index}" data-item-row="${aisle.id}">
            <div class="lst-item-top">
              <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
              <input type="text" class="text-input aisle-name-input" data-aisle-name="${aisle.id}" value="${escapeHtml(aisle.name)}" />
              <button class="icon-delete" data-del-aisle="${aisle.id}" title="Remove aisle">✕</button>
            </div>
          </div>`).join('') : '<p class="empty-state">No aisles yet — add one below.</p>';
    }

    async function addAisle(name){
        const trimmed = name.trim();
        if(!trimmed) return;
        const maxSort = aisles.reduce((max, a) => Math.max(max, a.sort_order || 0), 0);
        try{
            const {data, error} = await sb.from('household_grocery_aisles')
                .insert({ name: trimmed, sort_order: maxSort + 1 })
                .select()
                .single();
            if(error || !data){ setStatus('Could not add aisle.'); return; }
            aisles.push(data);
            render();
        } catch(e){
            console.error('Could not add aisle:', e);
            setStatus('Could not add aisle.');
        }
    }

    async function renameAisle(id, name){
        const trimmed = name.trim();
        if(!trimmed) return;
        const aisle = aisles.find(a => a.id === id);
        if(!aisle || aisle.name === trimmed) return;
        aisle.name = trimmed;
        try{
            const {error} = await sb.from('household_grocery_aisles').update({name: trimmed}).eq('id', id);
            if(error) throw error;
            render();
        } catch(e){
            console.error('Could not rename aisle:', e);
            setStatus('Could not rename aisle.');
        }
    }

    async function deleteAisle(id){
        if(!confirm('Remove this aisle? Items assigned to it will become unassigned.')) return;

        const previousAisles = aisles.map(a => ({...a}));
        const previousItems = groceryItems.map(i => ({...i}));
        const previousMemory = itemMemory.map(m => ({...m}));

        aisles = aisles.filter(a => a.id !== id);
        groceryItems = groceryItems.map(i => i.aisle_id === id ? {...i, aisle_id: null} : i);
        itemMemory = itemMemory.map(m => m.aisle_id === id ? {...m, aisle_id: null} : m);
        render();

        try{
            await Promise.all([
                sb.from('household_list_items').update({aisle_id: null}).eq('aisle_id', id),
                sb.from('household_grocery_item_memory').update({aisle_id: null}).eq('aisle_id', id)
            ]);
            const {error} = await sb.from('household_grocery_aisles').delete().eq('id', id);
            if(error) throw error;
        } catch(e){
            console.error('Could not delete aisle:', e);
            aisles = previousAisles;
            groceryItems = previousItems;
            itemMemory = previousMemory;
            render();
            setStatus('Could not delete aisle.');
        }
    }

    async function reorderAisles(fromIndex, toIndex){
        if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

        const previousAisles = aisles.map(a => ({...a}));
        const ordered = sortedAisles();
        const [moved] = ordered.splice(fromIndex, 1);
        if(!moved) return;
        const targetIndex = Math.min(toIndex, ordered.length);
        ordered.splice(targetIndex, 0, moved);
        ordered.forEach((aisle, idx) => { aisle.sort_order = idx + 1; });

        aisles = ordered;
        render();

        const saveToken = ++reorderSaveToken;
        try{
            await Promise.all(ordered.map(aisle =>
                sb.from('household_grocery_aisles').update({sort_order: aisle.sort_order}).eq('id', aisle.id)
            ));
        } catch(e){
            console.error('Could not save aisle order:', e);
            if(saveToken === reorderSaveToken){
                aisles = previousAisles;
                render();
                setStatus('Could not save aisle order.');
            }
        }
    }

    // ---- Item -> aisle assignment ----------------------------------

    // Updates (or creates) the remembered aisle for an item's normalized
    // text, and pushes the same aisle onto any matching items currently
    // sitting in the live Groceries list so the change shows up there
    // immediately, without waiting for the item to be re-added.
    async function setItemAisle(rawText, aisleId){
        const text = rawText.trim();
        if(!text) return;
        const key = window.groceryKey(text);
        const existingMemory = itemMemory.find(m => m.item_key === key);

        const previousMemory = itemMemory.map(m => ({...m}));
        const previousItems = groceryItems.map(i => ({...i}));

        if(existingMemory){
            itemMemory = itemMemory.map(m => m.item_key === key ? {...m, aisle_id: aisleId || null} : m);
        } else {
            itemMemory = [...itemMemory, {item_key: key, aisle_id: aisleId || null, id: `pending-${key}`}];
        }
        groceryItems = groceryItems.map(i =>
            window.groceryKey(i.text) === key ? {...i, aisle_id: aisleId || null} : i
        );
        render();

        const nowIso = new Date().toISOString();
        try{
            if(existingMemory){
                const {error} = await sb.from('household_grocery_item_memory')
                    .update({aisle_id: aisleId || null, updated_at: nowIso})
                    .eq('item_key', key);
                if(error) throw error;
            } else {
                const {data, error} = await sb.from('household_grocery_item_memory')
                    .insert({item_key: key, aisle_id: aisleId || null, updated_at: nowIso})
                    .select()
                    .single();
                if(error) throw error;
                itemMemory = itemMemory.map(m => m.id === `pending-${key}` ? data : m);
            }

            const matchingIds = groceryItems.filter(i => window.groceryKey(i.text) === key).map(i => i.id);
            if(matchingIds.length){
                const {error: itemsErr} = await sb.from('household_list_items')
                    .update({aisle_id: aisleId || null})
                    .in('id', matchingIds);
                if(itemsErr) throw itemsErr;
            }
            setStatus('Aisle updated.');
        } catch(e){
            console.error('Could not save item aisle assignment:', e);
            itemMemory = previousMemory;
            groceryItems = previousItems;
            render();
            setStatus('Could not save aisle assignment.');
        }
    }

    async function deleteMapping(itemKey){
        const previousMemory = itemMemory.map(m => ({...m}));
        itemMemory = itemMemory.filter(m => m.item_key !== itemKey);
        render();
        try{
            const {error} = await sb.from('household_grocery_item_memory').delete().eq('item_key', itemKey);
            if(error) throw error;
        } catch(e){
            console.error('Could not remove item mapping:', e);
            itemMemory = previousMemory;
            render();
            setStatus('Could not remove mapping.');
        }
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
        const q = window.groceryKey(mappingSearchQuery);

        const currentItems = groceryItems
            .filter(item => !item.checked)
            .filter(item => !q || window.groceryKey(item.text).includes(q) || window.groceryKeysMatch(item.text, q))
            .sort((a, b) => window.groceryKey(a.text).localeCompare(window.groceryKey(b.text)));

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
        renderAisles();
        renderUnassigned();
        renderMappings();
        renderMappingAisleSelect();
    }

    // ---- Event wiring ------------------------------------------------

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

    document.addEventListener('app:ready', loadAll, { once: true });
})();