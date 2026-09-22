(function(){
    const sb = window.supabaseClient;
    const PERMANENT_TABS = ['Groceries', 'Pantry', 'Recipes'];
    const INSERT_RETRY_DELAY_MS = 800;

    let sections = [];
    let itemsBySection = {};
    let people = [];
    let activeSectionId = null;
    let recipes = [];
    let recipeSearchQuery = '';
    let reorderSaveToken = 0;
    let groceryAisles = [];
    let groceryItemMemory = [];

    const todayStr = window.todayStr;

    function isPermanent(sec){
        return sec && PERMANENT_TABS.includes(sec.name);
    }

    function isPantry(sec){
        return sec && sec.name === 'Pantry';
    }

    function isRecipes(sec){
        return sec && sec.name === 'Recipes';
    }

    function isGroceries(sec){
        return sec && sec.name === 'Groceries';
    }

    function aisleSortValue(aisleId){
        const aisle = groceryAisles.find(a => a.id === aisleId);
        return aisle ? aisle.sort_order : 9999;
    }

    function aisleIdForItemText(text){
        const key = window.groceryKey(text);
        if(!key) return null;

        const exactMatch = groceryItemMemory.find(m => window.groceryKey(m.item_key) === key);
        if(exactMatch) return exactMatch.aisle_id;

        const partialMatch = groceryItemMemory
            .filter(m => window.groceryKeysMatch(text, m.item_key))
            .sort((a, b) => window.groceryKey(b.item_key).length - window.groceryKey(a.item_key).length)[0];

        return partialMatch ? partialMatch.aisle_id : null;
    }

    function panelDeleteSectionButton(sec){
        if(isPermanent(sec)) return '';
        return `<button type="button" class="icon-delete" data-del-section="${sec.id}" title="Remove tab">✕</button>`;
    }

    // ---- Shared local-state helpers -----------------------------------
    // These replace the three copy-pasted "walk every section looking
    // for an item by id" blocks that used to live inline in the event
    // handlers (delete, quantity +/-, checkbox toggle, add-to-groceries).

    const CACHE_KEY = 'thecabin_cached_lists';
    let realtimeChannel = null;
    let realtimeDebounceTimer = null;

    function saveToLocalCache(){
        try{
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                sections,
                itemsBySection,
                people,
                recipes,
                groceryAisles,
                groceryItemMemory,
                activeSectionId,
                timestamp: Date.now()
            }));
        } catch(e){}
    }

    function loadFromLocalCache(){
        try{
            const raw = localStorage.getItem(CACHE_KEY);
            if(!raw) return false;
            const data = JSON.parse(raw);
            if(!data || !Array.isArray(data.sections) || data.sections.length === 0) return false;
            sections = data.sections || [];
            itemsBySection = data.itemsBySection || {};
            people = data.people || [];
            recipes = data.recipes || [];
            groceryAisles = data.groceryAisles || [];
            groceryItemMemory = data.groceryItemMemory || [];
            if(data.activeSectionId && sections.some(s => s.id === data.activeSectionId)){
                activeSectionId = data.activeSectionId;
            } else {
                const groceries = sections.find(s => s.name === 'Groceries');
                activeSectionId = groceries ? groceries.id : (sections[0] && sections[0].id) || null;
            }
            return true;
        } catch(e){
            return false;
        }
    }

    function setupRealtime(){
        if(realtimeChannel || !sb) return;
        realtimeChannel = sb.channel('lists-realtime-channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_list_items' }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_list_sections' }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_recipes' }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_grocery_aisles' }, () => debounceReload())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'household_grocery_item_memory' }, () => debounceReload())
            .subscribe();
    }

    function debounceReload(){
        clearTimeout(realtimeDebounceTimer);
        realtimeDebounceTimer = setTimeout(() => {
            loadAll({ silent: true });
        }, 300);
    }

    function findItemById(id){
        for(const secId of Object.keys(itemsBySection)){
            const item = (itemsBySection[secId] || []).find(i => i.id === id);
            if(item) return item;
        }
        return null;
    }

    function updateItemLocally(id, patch){
        let updated = null;
        Object.keys(itemsBySection).forEach(secId => {
            itemsBySection[secId] = itemsBySection[secId].map(item => {
                if(item.id !== id) return item;
                updated = { ...item, ...patch };
                return updated;
            });
        });
        saveToLocalCache();
        return updated;
    }

    function removeItemLocally(id){
        Object.keys(itemsBySection).forEach(secId => {
            itemsBySection[secId] = itemsBySection[secId].filter(i => i.id !== id);
        });
        saveToLocalCache();
    }

    function sleep(ms){
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Inserts a single list item, retrying once after a short delay if
    // the first attempt fails (e.g. a transient network blip). If the
    // retry also fails, logs a meaningful error to the console and
    // rethrows so the caller can show a status message.
    async function insertListItemWithRetry(payload){
        try{
            const {data, error} = await sb.from('household_list_items').insert(payload).select().single();
            if(error) throw error;
            return data;
        } catch(firstErr){
            console.warn('Insert failed, retrying in', INSERT_RETRY_DELAY_MS, 'ms:', firstErr, payload);
            await sleep(INSERT_RETRY_DELAY_MS);
            try{
                const {data, error} = await sb.from('household_list_items').insert(payload).select().single();
                if(error) throw error;
                return data;
            } catch(secondErr){
                console.error('Insert failed after retry. Payload:', payload, 'Error:', secondErr);
                throw secondErr;
            }
        }
    }

    // Groceries + Pantry + Recipes always come first, in that order; user tabs follow
    // in the order they were created.
    function orderedSections(){
        const groceries = sections.find(s => s.name === 'Groceries');
        const pantry = sections.find(s => s.name === 'Pantry');
        const recipes = sections.find(s => s.name === 'Recipes');
        const rest = sections.filter(s => s !== groceries && s !== pantry && s !== recipes);
        return [groceries, pantry, recipes, ...rest].filter(Boolean);
    }

    function sortItems(items){
        const cmp = (a,b) => {
            if(a.sort_order != null && b.sort_order != null){
                if(a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
            } else if(a.sort_order != null){
                return -1;
            } else if(b.sort_order != null){
                return 1;
            }
            if(a.priority !== b.priority) return a.priority ? -1 : 1;
            if(a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : (a.due_date > b.due_date ? 1 : 0);
            if(a.due_date && !b.due_date) return -1;
            if(!a.due_date && b.due_date) return 1;
            return a.created_at < b.created_at ? -1 : 1;
        };
        const unchecked = items.filter(i => !i.checked).sort(cmp);
        const checked = items.filter(i => i.checked).sort(cmp);
        return [...unchecked, ...checked];
    }

    function sortGroceryItems(items){
        const cmp = (a,b) => {
            if(a.sort_order != null && b.sort_order != null){
                if(a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
            } else if(a.sort_order != null){
                return -1;
            } else if(b.sort_order != null){
                return 1;
            }

            const aisleDiff = aisleSortValue(a.aisle_id) - aisleSortValue(b.aisle_id);
            if(aisleDiff !== 0) return aisleDiff;

            return String(a.text || '').localeCompare(String(b.text || ''));
        };

        const unchecked = items.filter(i => !i.checked).sort(cmp);
        const checked = items.filter(i => i.checked).sort(cmp);
        return [...unchecked, ...checked];
    }

    async function ensurePermanentSections(){
        const existingNames = sections.map(s => s.name);
        for(const name of PERMANENT_TABS){
            if(existingNames.includes(name)) continue;
            try{
                const {data, error} = await sb.from('household_list_sections').insert({name}).select().single();
                if(!error && data){
                    sections.push(data);
                    itemsBySection[data.id] = [];
                }
            } catch(e){
                // if this fails, the tab just won't appear until the next load
            }
        }
    }

    async function loadAll(options = {}){
        const isSilent = options && options.silent;
        if(!isSilent && sections.length === 0){
            if(loadFromLocalCache()){
                render();
            }
        }
        try{
            const [
                peopleResult,
                sectionResult,
                itemResult,
                recipeResult,
                aisleResult,
                memoryResult
            ] = await Promise.all([
                sb.from('household_people').select('*').order('created_at'),
                sb.from('household_list_sections').select('*').order('created_at'),
                sb.from('household_list_items').select('*').order('created_at'),
                sb.from('household_recipes').select('*').order('name'),
                sb.from('household_grocery_aisles').select('*').order('sort_order'),
                sb.from('household_grocery_item_memory').select('*')
            ]);

            const loadErrors = [
                peopleResult.error,
                sectionResult.error,
                itemResult.error,
                recipeResult.error,
                aisleResult.error,
                memoryResult.error
            ].filter(Boolean);

            if(loadErrors.length){
                console.error('List load errors:', loadErrors);
                throw loadErrors[0];
            }

            people = peopleResult.data || [];
            sections = sectionResult.data || [];
            recipes = recipeResult.data || [];
            groceryAisles = aisleResult.data || [];
            groceryItemMemory = memoryResult.data || [];

            itemsBySection = {};
            (itemResult.data || []).forEach(item => {
                itemsBySection[item.section_id] = itemsBySection[item.section_id] || [];
                itemsBySection[item.section_id].push(item);
            });
            await ensurePermanentSections();
            saveToLocalCache();
        } catch(e){
            console.error('Could not load lists:', e);
            if(!isSilent && sections.length === 0){
                setStatus('Could not load lists.');
            }
        }

        if(!activeSectionId || !sections.find(s => s.id === activeSectionId)){
            const groceries = sections.find(s => s.name === 'Groceries');
            activeSectionId = groceries ? groceries.id : (sections[0] && sections[0].id) || null;
        }

        render();
        setupRealtime();
    }

    function personName(id){
        const p = people.find(p => p.id === id);
        return p ? p.name : null;
    }

    function dueClass(dateStr){
        if(!dateStr) return '';
        const today = todayStr();
        if(dateStr < today) return 'overdue';
        if(dateStr === today) return 'due-soon';
        return '';
    }

    function renderTabs(){
        const tabsEl = document.getElementById('lst-tabs');
        tabsEl.innerHTML = orderedSections().map(sec => {
            const active = sec.id === activeSectionId ? 'active' : '';
            return `
  <button type="button" class="tab ${active}" data-select-tab="${sec.id}">
    <span>${escapeHtml(sec.name)}</span>
  </button>`;
        }).join('');
    }

    function renderPantryPanel(sec){
        const items = [...(itemsBySection[sec.id] || [])].sort((a,b) => a.created_at < b.created_at ? -1 : 1);
        const itemsHtml = items.length ? items.map(item => `
          <div class="lst-item lst-item-row" data-item-row="${item.id}">
            <span class="lst-item-text">${escapeHtml(item.text)}</span>
            <div class="lst-actions">
              <div class="stepper">
                <button type="button" class="stepper-btn" data-qty-down="${item.id}" title="Decrease quantity">−</button>
                <span class="stepper-val">${item.quantity ?? 1}</span>
                <button type="button" class="stepper-btn" data-qty-up="${item.id}" title="Increase quantity">+</button>
              </div>
              <button type="button" class="button-inline" data-add-to-groceries="${item.id}">Add to groceries</button>
              <button type="button" class="icon-delete" data-del-item="${item.id}" title="Remove">✕</button>
            </div>
          </div>`).join('') : '<p class="empty-state">Nothing in the pantry yet.</p>';
        return `
        <div class="panel-head">
          <h2 class="panel-title">${escapeHtml(sec.name)}</h2>
        </div>
        <div class="lst-items">${itemsHtml}</div>
        <div class="lst-add-item">
          <input type="text" class="text-input" placeholder="Add a pantry item" id="lst-pantry-new-text" />
          <div class="lst-add-row2">
            <div class="stepper">
              <button type="button" class="stepper-btn" data-qty-down="new" title="Decrease quantity">−</button>
              <span class="stepper-val" id="lst-pantry-new-qty">1</span>
              <button type="button" class="stepper-btn" data-qty-up="new" title="Increase quantity">+</button>
            </div>
            <button class="button-inline" data-add-pantry-item="${sec.id}">Add</button>
          </div>
        </div>`;
    }

    async function addIngredientsToGroceries(ingredientList){
        const groceries = sections.find(s => s.name === 'Groceries');
        if(!groceries){
            setStatus('Groceries tab not found.');
            return;
        }

        const existingGroceryTexts = (itemsBySection[groceries.id] || [])
            .filter(i => !i.checked)
            .map(i => i.text.trim().toLowerCase());

        const toInsert = ingredientList
            .map(ing => ing.trim())
            .filter(ing => ing && !existingGroceryTexts.includes(ing.toLowerCase()));

        if(toInsert.length === 0){
            setStatus(ingredientList.length === 1 ? 'Already on the grocery list.' : 'All ingredients already on grocery list.');
            return;
        }

        try{
            const rows = toInsert.map(text => ({
                section_id: groceries.id,
                text,
                checked: false,
                aisle_id: aisleIdForItemText(text),
                sort_order: null
            }));
            const {data, error} = await sb.from('household_list_items').insert(rows).select();
            if(error || !data){ setStatus('Could not add to groceries.'); return; }
            itemsBySection[groceries.id] = itemsBySection[groceries.id] || [];
            itemsBySection[groceries.id].push(...data);
            setStatus(toInsert.length === 1 ? 'Added to groceries.' : `Added ${toInsert.length} item(s) to groceries.`);
            render();
        } catch(e){
            setStatus('Could not add to groceries.');
        }
    }

    function renderRecipesPanel(sec){
        const q = recipeSearchQuery.trim().toLowerCase();
        const filtered = recipes.filter(r => {
            if(!q) return true;
            const nameMatch = (r.name || '').toLowerCase().includes(q);
            const ingredients = Array.isArray(r.ingredients) ? r.ingredients : [];
            const ingredientMatch = ingredients.some(ing => ing.toLowerCase().includes(q));
            return nameMatch || ingredientMatch;
        });

        const recipesHtml = filtered.length ? filtered.map(recipe => {
            const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
            const ingredientsHtml = ingredients.length ? ingredients.map(ingredients => `
              <div class="lst-item-row" style="padding: 4px 0; border-top: 1px solid var(--line);">
                <span class="lst-item-text">${escapeHtml(ingredients)}</span>
                <button type="button" class="button-inline" data-add-recipe-ingredient="${escapeHtml(ingredients)}">Add to groceries</button>
              </div>
    `).join('') : '<p class="empty-state" style="padding: 4px 0; font-size: 12px;">No ingredients listed.</p>';

            return `
              <div class="lst-item" style="padding: 12px; margin-bottom: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
                  <h3 style="margin: 0; font-size: 15px; font-weight: 600; color: var(--primary); font-family: 'Fraunces', serif;">${escapeHtml(recipe.name)}</h3>
                  <button type="button" class="button-inline" data-add-recipe-all="${recipe.id}">Add full recipe</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${ingredientsHtml}
                </div>
              </div>`;
        }).join('') : `<p class="empty-state">${recipeSearchQuery ? 'No recipes match your search.' : 'No recipes found.'}</p>`;

        return `
            <div class="panel-head">
              <h2 class="panel-title">${escapeHtml(sec.name)}</h2>
            </div>
            <div style="padding: 10px 14px 4px;">
              <input type="text" class="text-input" placeholder="Search recipes or ingredients..." id="lst-recipe-search" value="${escapeHtml(recipeSearchQuery)}" style="width: 100%;" />
            </div>
            <div class="lst-items" id="lst-recipe-list">${recipesHtml}</div>`;
    }


    function renderGroceriesPanel(sec){
        const peopleOptions = people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        const items = sortGroceryItems(itemsBySection[sec.id] || []);

        const itemsHtml = items.length ? items.map((item, index) => {
            const chips = [];

            if(item.priority) chips.push(`<span class="lst-chip priority-chip">High priority</span>`);
            if(item.assigned_to && personName(item.assigned_to)) chips.push(`<span class="lst-chip">${escapeHtml(personName(item.assigned_to))}</span>`);
            if(item.due_date) chips.push(`<span class="lst-chip ${dueClass(item.due_date)}">${item.due_date}</span>`);

            if(item.aisle_id){
                const aisle = groceryAisles.find(a => a.id === item.aisle_id);
                if(aisle) chips.push(`<span class="lst-chip aisle-chip">${escapeHtml(aisle.name)}</span>`);
            }

            return `
      <div class="lst-item draggable-item ${item.priority ? 'priority' : ''} ${item.checked ? 'checked' : ''}" ${!item.checked ? 'draggable="true"' : ''} data-index="${index}" data-item-row="${item.id}">
        <div class="lst-item-top">
          ${!item.checked ? '<span class="drag-handle" title="Drag to reorder">⋮⋮</span>' : ''}
          <label class="lst-check-label">
            <input type="checkbox" data-toggle-check="${item.id}" ${item.checked ? 'checked' : ''} />
            <span class="lst-item-text">${escapeHtml(item.text)}</span>
          </label>
          <button class="icon-delete" data-del-item="${item.id}" title="Remove">✕</button>
        </div>
        ${chips.length ? `<div class="lst-item-meta">${chips.join('')}</div>` : ''}
      </div>`;
        }).join('') : '<p class="empty-state">Nothing here yet.</p>';

        return `
    <div class="panel-head">
      <h2 class="panel-title">${escapeHtml(sec.name)}</h2>
      <a href="managegroceries.html" class="button-inline">Manage groceries</a>
    </div>
    <div class="lst-items">${itemsHtml}</div>
    <div class="lst-add-item">
      <input type="text" class="text-input" placeholder="Add an item" data-new-item-text="${sec.id}" />
      <div class="lst-add-row2">
        <select data-new-item-person="${sec.id}">
          <option value="">Unassigned</option>
          ${peopleOptions}
        </select>
        <input type="date" placeholder="Date" data-new-item-due="${sec.id}" />
        <label class="lst-priority-toggle">
          <input type="checkbox" data-new-item-priority="${sec.id}" /> High priority
        </label>
        <button class="button-inline" data-add-item="${sec.id}">Add</button>
      </div>
    </div>`;
    }

    function renderStandardPanel(sec){
        const peopleOptions = people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        const items = sortItems(itemsBySection[sec.id] || []);

        const itemsHtml = items.length ? items.map((item, index) => {
            const chips = [];

            if(item.priority) chips.push(`<span class="lst-chip priority-chip">High priority</span>`);
            if(item.assigned_to && personName(item.assigned_to)) chips.push(`<span class="lst-chip">${escapeHtml(personName(item.assigned_to))}</span>`);
            if(item.due_date) chips.push(`<span class="lst-chip ${dueClass(item.due_date)}">${item.due_date}</span>`);

            return `
      <div class="lst-item draggable-item ${item.priority ? 'priority' : ''} ${item.checked ? 'checked' : ''}" ${!item.checked ? 'draggable="true"' : ''} data-index="${index}" data-item-row="${item.id}">
        <div class="lst-item-top">
          ${!item.checked ? '<span class="drag-handle" title="Drag to reorder">⋮⋮</span>' : ''}
          <label class="lst-check-label">
            <input type="checkbox" data-toggle-check="${item.id}" ${item.checked ? 'checked' : ''} />
            <span class="lst-item-text">${escapeHtml(item.text)}</span>
          </label>
          <button class="icon-delete" data-del-item="${item.id}" title="Remove">✕</button>
        </div>
        ${chips.length ? `<div class="lst-item-meta">${chips.join('')}</div>` : ''}
      </div>`;
        }).join('') : '<p class="empty-state">Nothing here yet.</p>';

        return `
    <div class="panel-head">
      <h2 class="panel-title">${escapeHtml(sec.name)}</h2>
      ${panelDeleteSectionButton(sec)}
    </div>
    <div class="lst-items">${itemsHtml}</div>
    <div class="lst-add-item">
      <input type="text" class="text-input" placeholder="Add an item" data-new-item-text="${sec.id}" />
      <div class="lst-add-row2">
        <select data-new-item-person="${sec.id}">
          <option value="">Unassigned</option>
          ${peopleOptions}
        </select>
        <input type="date" placeholder="Date" data-new-item-due="${sec.id}" />
        <label class="lst-priority-toggle">
          <input type="checkbox" data-new-item-priority="${sec.id}" /> High priority
        </label>
        <button class="button-inline" data-add-item="${sec.id}">Add</button>
      </div>
    </div>`;
    }

    async function reorderItems(sectionId, fromIndex, toIndex){
        if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

        const previousItems = (itemsBySection[sectionId] || []).map(item => ({ ...item }));
        const sec = sections.find(s => s.id === sectionId);
        const allItems = isGroceries(sec)
            ? sortGroceryItems(itemsBySection[sectionId] || [])
            : sortItems(itemsBySection[sectionId] || []);
        const unchecked = allItems.filter(i => !i.checked);
        const checked = allItems.filter(i => i.checked);

        if(fromIndex >= unchecked.length) return;
        const [moved] = unchecked.splice(fromIndex, 1);
        if(!moved) return;

        const targetIndex = Math.min(toIndex, unchecked.length);
        unchecked.splice(targetIndex, 0, moved);

        unchecked.forEach((item, idx) => {
            item.sort_order = idx + 1;
        });
        checked.forEach((item, idx) => {
            item.sort_order = unchecked.length + idx + 1;
        });

        const orderedItems = [...unchecked, ...checked];

        itemsBySection[sectionId] = orderedItems;
        render();

        const saveToken = ++reorderSaveToken;
        const itemOrders = orderedItems.map(item => ({
            id: item.id,
            sort_order: item.sort_order
        }));

        try {
            const { error } = await sb.rpc('update_list_item_order', {
                item_orders: itemOrders
            });

            if(error) throw error;
        } catch (err) {
            console.error('Failed to save item order:', err);

            if(saveToken === reorderSaveToken){
                itemsBySection[sectionId] = previousItems;
                render();
                setStatus('Could not save item order.');
            }
        }
    }


    function render(){
        renderTabs();
        const panelEl = document.getElementById('lst-panel');
        const sec = sections.find(s => s.id === activeSectionId);
        if(!sec){
            panelEl.innerHTML = '<p class="empty-state">No tabs yet — add one above.</p>';
            return;
        }
        panelEl.innerHTML = isPantry(sec)
            ? renderPantryPanel(sec)
            : isRecipes(sec)
                ? renderRecipesPanel(sec)
                :isGroceries(sec)
                    ? renderGroceriesPanel(sec)
                    : renderStandardPanel(sec);
    }

    document.getElementById('lst-add-section').addEventListener('click', async () => {
        const input = document.getElementById('lst-new-section-name');
        const name = input.value.trim();
        if(!name) return;
        if(PERMANENT_TABS.includes(name)){
            setStatus(`"${name}" already exists.`);
            return;
        }
        try{
            const {data, error} = await sb.from('household_list_sections').insert({name}).select().single();
            if(error || !data){ setStatus('Could not add tab.'); return; }
            sections.push(data);
            itemsBySection[data.id] = [];
            input.value = '';
            activeSectionId = data.id;
            render();
        } catch(e){
            setStatus('Could not add tab.');
        }
    });

    document.getElementById('lst-tabs').addEventListener('click', async (e) => {
        const tabBtn = e.target.closest('[data-select-tab]');
        if(tabBtn){
            activeSectionId = tabBtn.getAttribute('data-select-tab');
            render();
        }
    });

    document.getElementById('lst-panel').addEventListener('click', async (e) => {
        const t = e.target;

        if(t.matches('[data-add-recipe-ingredient]')){
            const ing = t.getAttribute('data-add-recipe-ingredient');
            if(ing) await addIngredientsToGroceries([ing]);
            return;
        }

        if(t.matches('[data-add-recipe-all]')){
            const recipeId = t.getAttribute('data-add-recipe-all');
            const recipe = recipes.find(r => String(r.id) === String(recipeId));
            if(recipe && recipe.ingredients){
                const list = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
                await addIngredientsToGroceries(list);
            }
            return;
        }

        if(t.closest('[data-del-section]')){
            const delBtn = t.closest('[data-del-section]');
            const id = delBtn.getAttribute('data-del-section');

            if(!confirm('Remove this tab and its items?')) return;

            sections = sections.filter(s => s.id !== id);
            delete itemsBySection[id];
            if(activeSectionId === id){
                const groceries = sections.find(s => s.name === 'Groceries');
                activeSectionId = groceries ? groceries.id : (sections[0] && sections[0].id) || null;
            }
            render();
            try{
                await sb.from('household_list_sections').delete().eq('id', id);
            } catch(err){ setStatus('Could not delete tab.'); }
            return;
        }

        if(t.matches('[data-del-item]')){
            const id = t.getAttribute('data-del-item');
            removeItemLocally(id);
            render();
            try{
                await sb.from('household_list_items').delete().eq('id', id);
            } catch(err){ setStatus('Could not delete item.'); }
            return;
        }

        if(t.matches('[data-add-item]')){
            const sectionId = t.getAttribute('data-add-item');
            const textInput = document.querySelector(`[data-new-item-text="${sectionId}"]`);
            const personSelect = document.querySelector(`[data-new-item-person="${sectionId}"]`);
            const dueInput = document.querySelector(`[data-new-item-due="${sectionId}"]`);
            const priorityInput = document.querySelector(`[data-new-item-priority="${sectionId}"]`);

            const text = textInput.value.trim();
            if(!text) return;
            const assigned_to = personSelect.value || null;
            const due_date = dueInput.value || null;
            const priority = priorityInput.checked;

            const existing = itemsBySection[sectionId] || [];
            const maxSort = existing.reduce((max, i) => Math.max(max, i.sort_order || 0), 0);
            const section = sections.find(s => s.id === sectionId);
            const isGroceryItem = isGroceries(section);
            const aisle_id = isGroceryItem ? aisleIdForItemText(text) : null;
            const sort_order = isGroceryItem ? null : maxSort + 1;

            const payload = {
                section_id: sectionId,
                text,
                assigned_to,
                due_date,
                priority,
                checked: false,
                sort_order,
                aisle_id
            };

            try{
                const data = await insertListItemWithRetry(payload);
                itemsBySection[sectionId] = itemsBySection[sectionId] || [];
                itemsBySection[sectionId].push(data);
                render();
                const nextInput = document.querySelector(`[data-new-item-text="${sectionId}"]`);
                if(nextInput) nextInput.focus();
            } catch(e){
                setStatus('Could not add item.');
            }
            return;
        }

        if(t.matches('[data-add-pantry-item]')){
            const sectionId = t.getAttribute('data-add-pantry-item');
            const textInput = document.getElementById('lst-pantry-new-text');
            const qtyInput = document.getElementById('lst-pantry-new-qty');
            const text = textInput.value.trim();
            if(!text) return;
            const quantity = Math.max(1, parseInt(qtyInput ? (qtyInput.textContent || qtyInput.value) : 1, 10) || 1);

            const payload = {
                section_id: sectionId,
                text,
                quantity,
                checked: false
            };

            try{
                const data = await insertListItemWithRetry(payload);
                itemsBySection[sectionId] = itemsBySection[sectionId] || [];
                itemsBySection[sectionId].push(data);
                render();
                const nextInput = document.getElementById('lst-pantry-new-text');
                if(nextInput) nextInput.focus();
            } catch(e){
                setStatus('Could not add pantry item.');
            }
            return;
        }

        if(t.matches('[data-qty-up]') || t.matches('[data-qty-down]')){
            const id = t.getAttribute('data-qty-up') || t.getAttribute('data-qty-down');
            const delta = t.matches('[data-qty-up]') ? 1 : -1;
            if(id === 'new'){
                const qtyEl = document.getElementById('lst-pantry-new-qty');
                if(qtyEl){
                    const current = parseInt(qtyEl.textContent, 10) || 1;
                    qtyEl.textContent = String(Math.max(1, current + delta));
                }
                return;
            }
            const existingItem = findItemById(id);
            if(!existingItem) return;
            const nextQty = Math.max(1, (existingItem.quantity ?? 1) + delta);
            const updated = updateItemLocally(id, { quantity: nextQty });
            render();
            if(updated){
                try{
                    await sb.from('household_list_items').update({quantity: updated.quantity}).eq('id', id);
                } catch(err){ setStatus('Could not update quantity.'); }
            }
            return;
        }

        if(t.matches('[data-add-to-groceries]')){
            const id = t.getAttribute('data-add-to-groceries');
            const sourceItem = findItemById(id);
            if(!sourceItem) return;
            await addIngredientsToGroceries([sourceItem.text]);
            return;
        }
    });

    document.getElementById('lst-panel').addEventListener('input', (e) => {
        if(e.target.id === 'lst-recipe-search'){
            recipeSearchQuery = e.target.value;
            render();
            // Restore focus and cursor position after re-render
            const searchInput = document.getElementById('lst-recipe-search');
            if(searchInput){
                searchInput.focus();
                searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
            }
        }
    });

    document.getElementById('lst-panel').addEventListener('change', async (e) => {
        if(e.target.matches('[data-toggle-check]')){
            const id = e.target.getAttribute('data-toggle-check');
            const checked = e.target.checked;
            const updated = updateItemLocally(id, { checked });
            render();
            if(updated){
                try{
                    await sb.from('household_list_items').update({checked}).eq('id', id);
                } catch(err){ setStatus('Could not update item.'); }
            }
        }
    });

    document.getElementById('lst-panel').addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && e.target.matches('[data-new-item-text]')){
            e.preventDefault();
            const sectionId = e.target.getAttribute('data-new-item-text');
            const btn = document.querySelector(`[data-add-item="${sectionId}"]`);
            if(btn) btn.click();
        }
        if(e.key === 'Enter' && e.target.id === 'lst-pantry-new-text'){
            e.preventDefault();
            const btn = document.querySelector('[data-add-pantry-item]');
            if(btn) btn.click();
        }
    });

    const panelEl = document.getElementById('lst-panel');

    initDragAndDrop(panelEl, {
        canDrag: (el) => !el.classList.contains('checked'),
        onReorder: (fromIndex, toIndex) => {
            const sec = sections.find(s => s.id === activeSectionId);
            if(sec && !isPantry(sec) && !isRecipes(sec)){
                reorderItems(sec.id, fromIndex, toIndex);
            }
        }
    });

    window.addEventListener('beforeunload', () => {
        if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
    });

    if(window.initAppPage){
        window.initAppPage(loadAll);
    } else {
        document.addEventListener('app:ready', loadAll, { once: true });
    }
})();