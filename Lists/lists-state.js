// State, persistence, realtime and helpers shared by every panel.
// Nothing in here touches the DOM except through setStatus / the render callback.

export const sb = window.supabaseClient;
export const PERMANENT_TABS = ['Groceries', 'Pantry', 'Recipes'];

const CACHE_KEY = 'thecabin_cached_lists';
const INSERT_RETRY_DELAY_MS = 800;
const REALTIME_TABLES = [
    'household_list_items',
    'household_list_sections',
    'household_recipes',
    'household_grocery_aisles',
    'household_grocery_item_memory'
];

export const state = {
    sections: [],
    itemsBySection: {},
    people: [],
    recipes: [],
    groceryAisles: [],
    groceryItemMemory: []
};

let realtimeChannel = null;
let realtimeDebounceTimer = null;

// ---- Render hook ---------------------------------------------------------
// main.js registers its render function here; panels call requestRender()
// after they change state locally.

let renderListener = () => {};

export function onStateChange(fn){
    renderListener = fn;
}

export function requestRender(opts = {}){
    renderListener({ silent: !!opts.silent });
}

// ---- Section helpers -----------------------------------------------------

export const isPermanent = sec => !!sec && PERMANENT_TABS.includes(sec.name);
export const isPantry = sec => !!sec && sec.name === 'Pantry';
export const isRecipes = sec => !!sec && sec.name === 'Recipes';
export const isGroceries = sec => !!sec && sec.name === 'Groceries';

// Hash slug for a tab: "groceries", "pantry", "recipes", or the section id
// for user-created tabs (their names can be renamed/duplicated).
function slugify(text){
    return String(text || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'tab';
}

export function sectionSlug(sec){
    if(isPermanent(sec)) return sec.name.toLowerCase();

    const base = slugify(sec.name);
    const dupes = state.sections.filter(s => !isPermanent(s) && slugify(s.name) === base);
    if(dupes.length <= 1) return base;

    // Two custom tabs share a name — keep the slug stable per tab by
    // only disambiguating the later ones (creation order via created_at).
    const idx = dupes.findIndex(s => s.id === sec.id);
    return idx === 0 ? base : `${base}-${sec.id.slice(0, 6)}`;
}

export function findSectionBySlug(slug){
    return state.sections.find(s => sectionSlug(s) === slug) || null;
}

// Groceries + Pantry + Recipes always come first, in that order; user tabs follow.
export function orderedSections(){
    const groceries = state.sections.find(isGroceries);
    const pantry = state.sections.find(isPantry);
    const recipes = state.sections.find(isRecipes);
    const rest = state.sections.filter(s => s !== groceries && s !== pantry && s !== recipes);
    return [groceries, pantry, recipes, ...rest].filter(Boolean);
}

// ---- Local cache ---------------------------------------------------------

export function saveToLocalCache(){
    try{
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            ...state,
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
        state.sections = data.sections || [];
        state.itemsBySection = data.itemsBySection || {};
        state.people = data.people || [];
        state.recipes = data.recipes || [];
        state.groceryAisles = data.groceryAisles || [];
        state.groceryItemMemory = data.groceryItemMemory || [];
        return true;
    } catch(e){
        return false;
    }
}

// ---- Realtime ------------------------------------------------------------

function debounceReload(){
    clearTimeout(realtimeDebounceTimer);
    realtimeDebounceTimer = setTimeout(() => {
        loadAll({ silent: true });
    }, 300);
}

function setupRealtime(){
    if(realtimeChannel || !sb) return;
    let channel = sb.channel('lists-realtime-channel');
    REALTIME_TABLES.forEach(table => {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => debounceReload());
    });
    realtimeChannel = channel.subscribe();
}

export function stopRealtime(){
    if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
}

// ---- Loading -------------------------------------------------------------

async function ensurePermanentSections(){
    const existingNames = state.sections.map(s => s.name);
    for(const name of PERMANENT_TABS){
        if(existingNames.includes(name)) continue;
        try{
            const {data, error} = await sb.from('household_list_sections').insert({name}).select().single();
            if(!error && data){
                state.sections.push(data);
                state.itemsBySection[data.id] = [];
            }
        } catch(e){
            // if this fails, the tab just won't appear until the next load
        }
    }
}

export async function loadAll(options = {}){
    const silent = !!(options && options.silent);

    if(!silent && state.sections.length === 0 && loadFromLocalCache()){
        requestRender();
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

        state.people = peopleResult.data || [];
        state.sections = sectionResult.data || [];
        state.recipes = recipeResult.data || [];
        state.groceryAisles = aisleResult.data || [];
        state.groceryItemMemory = memoryResult.data || [];

        state.itemsBySection = {};
        (itemResult.data || []).forEach(item => {
            (state.itemsBySection[item.section_id] ||= []).push(item);
        });
        await ensurePermanentSections();
        saveToLocalCache();
    } catch(e){
        console.error('Could not load lists:', e);
        if(!silent && state.sections.length === 0){
            setStatus('Could not load lists.');
        }
    }

    requestRender({ silent });
    setupRealtime();
}

// ---- Local item helpers --------------------------------------------------

export function findItemById(id){
    for(const secId of Object.keys(state.itemsBySection)){
        const item = (state.itemsBySection[secId] || []).find(i => i.id === id);
        if(item) return item;
    }
    return null;
}

export function updateItemLocally(id, patch){
    let updated = null;
    Object.keys(state.itemsBySection).forEach(secId => {
        state.itemsBySection[secId] = state.itemsBySection[secId].map(item => {
            if(item.id !== id) return item;
            updated = { ...item, ...patch };
            return updated;
        });
    });
    saveToLocalCache();
    return updated;
}

export function removeItemLocally(id){
    Object.keys(state.itemsBySection).forEach(secId => {
        state.itemsBySection[secId] = state.itemsBySection[secId].filter(i => i.id !== id);
    });
    saveToLocalCache();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Inserts one list item, retrying once after a short delay (transient network
// blips). Rethrows if the retry fails so the caller can show a status message.
export async function insertListItemWithRetry(payload){
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

// ---- Sorting -------------------------------------------------------------

function aisleSortValue(aisleId){
    const aisle = state.groceryAisles.find(a => a.id === aisleId);
    return aisle ? aisle.sort_order : 9999;
}

function compareBySortOrder(a, b){
    if(a.sort_order != null && b.sort_order != null){
        if(a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    } else if(a.sort_order != null){
        return -1;
    } else if(b.sort_order != null){
        return 1;
    }
    return 0;
}

function uncheckedThenChecked(items, cmp){
    return [
        ...items.filter(i => !i.checked).sort(cmp),
        ...items.filter(i => i.checked).sort(cmp)
    ];
}

export function sortItems(items){
    return uncheckedThenChecked(items, (a, b) => {
        const byOrder = compareBySortOrder(a, b);
        if(byOrder !== 0) return byOrder;
        if(a.priority !== b.priority) return a.priority ? -1 : 1;
        if(a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : (a.due_date > b.due_date ? 1 : 0);
        if(a.due_date && !b.due_date) return -1;
        if(!a.due_date && b.due_date) return 1;
        return a.created_at < b.created_at ? -1 : 1;
    });
}

export function sortGroceryItems(items){
    return uncheckedThenChecked(items, (a, b) => {
        const byOrder = compareBySortOrder(a, b);
        if(byOrder !== 0) return byOrder;
        const aisleDiff = aisleSortValue(a.aisle_id) - aisleSortValue(b.aisle_id);
        if(aisleDiff !== 0) return aisleDiff;
        return String(a.text || '').localeCompare(String(b.text || ''));
    });
}

// ---- Misc lookups --------------------------------------------------------

export function personName(id){
    const p = state.people.find(p => p.id === id);
    return p ? p.name : null;
}

export function dueClass(dateStr){
    if(!dateStr) return '';
    const today = window.todayStr();
    if(dateStr < today) return 'overdue';
    if(dateStr === today) return 'due-soon';
    return '';
}

export function aisleIdForItemText(text){
    const key = window.groceryKey(text);
    if(!key) return null;

    const exactMatch = state.groceryItemMemory.find(m => window.groceryKey(m.item_key) === key);
    if(exactMatch) return exactMatch.aisle_id;

    const partialMatch = state.groceryItemMemory
        .filter(m => window.groceryKeysMatch(text, m.item_key))
        .sort((a, b) => window.groceryKey(b.item_key).length - window.groceryKey(a.item_key).length)[0];

    return partialMatch ? partialMatch.aisle_id : null;
}

// ---- Shared action: used by Pantry and Recipes ---------------------------

export async function addIngredientsToGroceries(ingredientList){
    const groceries = state.sections.find(isGroceries);
    if(!groceries){
        setStatus('Groceries tab not found.');
        return;
    }

    const existingGroceryTexts = (state.itemsBySection[groceries.id] || [])
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
        (state.itemsBySection[groceries.id] ||= []).push(...data);
        saveToLocalCache();
        setStatus(toInsert.length === 1 ? 'Added to groceries.' : `Added ${toInsert.length} item(s) to groceries.`);
        requestRender();
    } catch(e){
        setStatus('Could not add to groceries.');
    }
}