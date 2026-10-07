// State, persistence, realtime and helpers shared by every panel.
// Nothing in here touches the DOM except through setStatus / the render callback.

import { writeOrQueue, getPendingOp, nowStamp } from '../SharedJS/sync.js';

export const TABLES = window.TABLES;
export const RPC = window.RPC;
export const sb = window.supabaseClient;
export const PERMANENT_TABS = ['Groceries', 'Pantry', 'Recipes'];

const CACHE_KEY = 'thecabin_cached_lists';
const INSERT_RETRY_DELAY_MS = 800;
const REALTIME_TABLES = [
    TABLES.LIST_ITEMS,
    TABLES.LIST_SECTIONS,
    TABLES.RECIPES,
    TABLES.GROCERY_AISLES,
    TABLES.GROCERY_ITEM_MEMORY
];

export const state = {
    sections: [],
    itemsBySection: {},
    people: [],
    recipes: [],
    groceryAisles: [],
    groceryItemMemory: [],
    memoryLookup: new Map()
};

export function rebuildMemoryLookup(){
    state.memoryLookup = new Map(
        (state.groceryItemMemory || []).map(m => [window.groceryKey(m.item_key), m.aisle_id])
    );
}

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
        rebuildMemoryLookup();
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
            const {data, error} = await sb.from(TABLES.LIST_SECTIONS).insert({name}).select().single();
            if(!error && data){
                state.sections.push(data);
                state.itemsBySection[data.id] = [];
            }
        } catch(e){
            // if this fails, the tab just won't appear until the next load
        }
    }
}

// Merges freshly-loaded server items with anything still pending in the
// offline write queue, so a reload (or a realtime nudge from someone
// else's change) can never silently discard a not-yet-synced local edit.
// Only items with a queued op are special-cased — everything else just
// takes the server's value, same as before.
function mergeItemsWithPendingWrites(serverItems){
    const previousById = {};
    Object.values(state.itemsBySection).flat().forEach(item => {
        previousById[item.id] = item;
    });

    const next = {};
    serverItems.forEach(item => {
        const op = getPendingOp(TABLES.LIST_ITEMS, item.id);
        if(op && op.type === 'delete') return; // deleted locally, not yet synced — don't resurrect
        const finalItem = (op && op.type === 'update' && previousById[item.id]) ? previousById[item.id] : item;
        (next[finalItem.section_id] ||= []).push(finalItem);
    });

    // Items added while offline (pending insert) won't be in server data yet.
    const serverIds = new Set(serverItems.map(i => i.id));
    Object.values(previousById).forEach(item => {
        const op = getPendingOp(TABLES.LIST_ITEMS, item.id);
        if(op && op.type === 'insert' && !serverIds.has(item.id)){
            (next[item.section_id] ||= []).push(item);
        }
    });

    return next;
}

// Same idea as mergeItemsWithPendingWrites, for the flat recipes array.
// Recipes are only ever edited in place here (notes/url), never inserted
// or deleted from this app, so there's no pending-insert case to handle.
function mergeRecipesWithPendingWrites(serverRecipes){
    const previousById = {};
    state.recipes.forEach(r => { previousById[r.id] = r; });

    return serverRecipes.map(r => {
        const op = getPendingOp(TABLES.RECIPES, r.id);
        return (op && op.type === 'update' && previousById[r.id]) ? previousById[r.id] : r;
    });
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
            sb.from(TABLES.PEOPLE).select('*').order('created_at'),
            sb.from(TABLES.LIST_SECTIONS).select('*').order('created_at'),
            sb.from(TABLES.LIST_ITEMS).select('*').order('created_at'),
            sb.from(TABLES.RECIPES).select('*').order('name'),
            sb.from(TABLES.GROCERY_AISLES).select('*').order('sort_order'),
            sb.from(TABLES.GROCERY_ITEM_MEMORY).select('*')
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
        state.recipes = mergeRecipesWithPendingWrites(recipeResult.data || []);
        state.groceryAisles = aisleResult.data || [];
        state.groceryItemMemory = memoryResult.data || [];
        rebuildMemoryLookup();

        state.itemsBySection = mergeItemsWithPendingWrites(itemResult.data || []);
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

// ---- Local state mutations ------------------------------------------------

export function findItemById(id){
    for(const secId of Object.keys(state.itemsBySection)){
        const item = (state.itemsBySection[secId] || []).find(i => i.id === id);
        if(item) return item;
    }
    return null;
}

export function addItemLocally(item){
    (state.itemsBySection[item.section_id] ||= []).push(item);
    saveToLocalCache();
}

export function updateItemLocally(id, patch){
    let updated = null;
    Object.keys(state.itemsBySection).forEach(secId => {
        state.itemsBySection[secId] = (state.itemsBySection[secId] || []).map(item => {
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
        state.itemsBySection[secId] = (state.itemsBySection[secId] || []).filter(i => i.id !== id);
    });
    saveToLocalCache();
}

export function removeItemsLocally(ids){
    if(!ids || !ids.length) return;
    const idSet = new Set(ids);
    Object.keys(state.itemsBySection).forEach(secId => {
        state.itemsBySection[secId] = (state.itemsBySection[secId] || []).filter(i => !idSet.has(i.id));
    });
    saveToLocalCache();
}

export function addSectionLocally(sec){
    state.sections.push(sec);
    state.itemsBySection[sec.id] = [];
    saveToLocalCache();
}

export function updateSectionLocally(secId, patch){
    const sec = state.sections.find(s => s.id === secId);
    if(sec) Object.assign(sec, patch);
    saveToLocalCache();
}

export function removeSectionLocally(secId){
    state.sections = state.sections.filter(s => s.id !== secId);
    delete state.itemsBySection[secId];
    saveToLocalCache();
}

// ---- Data mutations & offline sync actions -------------------------------

export async function createListItem(basePayload){
    const id = basePayload.id || crypto.randomUUID();
    const updated_at = nowStamp();
    const item = {
        id,
        ...basePayload,
        created_at: basePayload.created_at || updated_at,
        updated_at
    };
    addItemLocally(item);
    await writeOrQueue(sb, {
        table: TABLES.LIST_ITEMS,
        type: 'insert',
        id,
        payload: item
    });
    return item;
}

export async function updateListItem(id, patch){
    const updated_at = nowStamp();
    const payload = { ...patch, updated_at };
    const updated = updateItemLocally(id, payload);
    if(updated){
        await writeOrQueue(sb, {
            table: TABLES.LIST_ITEMS,
            type: 'update',
            id,
            payload
        });
    }
    return updated;
}

export async function deleteListItem(id){
    removeItemLocally(id);
    await writeOrQueue(sb, {
        table: TABLES.LIST_ITEMS,
        type: 'delete',
        id
    });
}

export async function deleteListItems(ids){
    if(!ids || !ids.length) return;
    removeItemsLocally(ids);
    await Promise.all(ids.map(id => writeOrQueue(sb, {
        table: TABLES.LIST_ITEMS,
        type: 'delete',
        id
    })));
}

export async function createSection(name){
    if(PERMANENT_TABS.includes(name)){
        throw new Error(`"${name}" already exists.`);
    }
    const { data, error } = await sb.from(TABLES.LIST_SECTIONS).insert({ name }).select().single();
    if(error || !data) throw error || new Error('Could not add tab.');
    addSectionLocally(data);
    return data;
}

export async function deleteSection(secId){
    removeSectionLocally(secId);
    const { error } = await sb.from(TABLES.LIST_SECTIONS).delete().eq('id', secId);
    if(error) throw error;
}

export async function updateSectionTagsEnabled(secId, enabled){
    updateSectionLocally(secId, { tags_enabled: enabled });
    const { error } = await sb
        .from(TABLES.LIST_SECTIONS)
        .update({ tags_enabled: enabled })
        .eq('id', secId);
    if(error) throw error;
}

export async function saveRecipeField(recipe, field, value){
    if((recipe[field] || '') === value) return;
    const updated_at = nowStamp();
    recipe[field] = value;
    recipe.updated_at = updated_at;
    saveToLocalCache();
    await writeOrQueue(sb, {
        table: TABLES.RECIPES,
        type: 'update',
        id: recipe.id,
        payload: { [field]: value, updated_at }
    });
}

export async function assignItemTag(rawText, aisleId, sectionId = null){
    const text = String(rawText || '').trim();
    if(!text) return;
    const key = window.groceryKey(text);
    if(!key) return;

    const nowIso = nowStamp();
    const existingIndex = state.groceryItemMemory.findIndex(m => m.item_key === key);
    if(existingIndex >= 0){
        state.groceryItemMemory[existingIndex] = {
            ...state.groceryItemMemory[existingIndex],
            aisle_id: aisleId || null,
            updated_at: nowIso
        };
    } else {
        state.groceryItemMemory.push({
            item_key: key,
            aisle_id: aisleId || null,
            updated_at: nowIso
        });
    }
    rebuildMemoryLookup();

    const targetSectionIds = sectionId ? [sectionId] : Object.keys(state.itemsBySection);
    const updatedItemIds = [];
    targetSectionIds.forEach(secId => {
        state.itemsBySection[secId] = (state.itemsBySection[secId] || []).map(item => {
            if(window.groceryKey(item.text) === key){
                updatedItemIds.push(item.id);
                return { ...item, aisle_id: aisleId || null, updated_at: nowIso };
            }
            return item;
        });
    });

    saveToLocalCache();

    await writeOrQueue(sb, {
        table: TABLES.GROCERY_ITEM_MEMORY,
        type: 'upsert',
        id: key,
        idColumn: 'item_key',
        payload: { item_key: key, aisle_id: aisleId || null, updated_at: nowIso },
        options: { onConflict: 'item_key' }
    });

    await Promise.all(updatedItemIds.map(id => writeOrQueue(sb, {
        table: TABLES.LIST_ITEMS,
        type: 'update',
        id,
        payload: { aisle_id: aisleId || null, updated_at: nowIso }
    })));
}

export async function deleteItemTagMapping(itemKey){
    const key = window.groceryKey(itemKey) || itemKey;
    state.groceryItemMemory = state.groceryItemMemory.filter(m => m.item_key !== key && m.item_key !== itemKey);
    rebuildMemoryLookup();
    saveToLocalCache();

    await writeOrQueue(sb, {
        table: TABLES.GROCERY_ITEM_MEMORY,
        type: 'delete',
        id: itemKey,
        idColumn: 'item_key'
    });
}

export async function deleteTag(aisleId){
    state.groceryAisles = state.groceryAisles.filter(a => a.id !== aisleId);
    state.groceryItemMemory = state.groceryItemMemory.map(m => m.aisle_id === aisleId ? { ...m, aisle_id: null } : m);
    rebuildMemoryLookup();

    Object.keys(state.itemsBySection).forEach(secId => {
        state.itemsBySection[secId] = (state.itemsBySection[secId] || []).map(item =>
            item.aisle_id === aisleId ? { ...item, aisle_id: null } : item
        );
    });
    saveToLocalCache();

    await writeOrQueue(sb, {
        table: TABLES.GROCERY_AISLES,
        type: 'delete',
        id: aisleId
    });
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

    if(state.memoryLookup && state.memoryLookup.has(key)){
        return state.memoryLookup.get(key);
    }

    const phraseMatch = state.groceryItemMemory
        .filter(m => {
            const memKey = window.groceryKey(m.item_key);
            return memKey && (key.includes(memKey) || memKey.includes(key));
        })
        .sort((a, b) => window.groceryKey(b.item_key).length - window.groceryKey(a.item_key).length)[0];

    if(phraseMatch) return phraseMatch.aisle_id;

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
        .map(i => (i.text || '').trim().toLowerCase());

    const toInsert = ingredientList
        .map(ing => (ing || '').trim())
        .filter(ing => ing && !existingGroceryTexts.includes(ing.toLowerCase()));

    if(toInsert.length === 0){
        setStatus(ingredientList.length === 1 ? 'Already on the grocery list.' : 'All ingredients already on grocery list.');
        return;
    }

    try{
        await Promise.all(toInsert.map(text => createListItem({
            section_id: groceries.id,
            text,
            checked: false,
            aisle_id: aisleIdForItemText(text),
            sort_order: null
        })));
        setStatus(toInsert.length === 1 ? 'Added to groceries.' : `Added ${toInsert.length} item(s) to groceries.`);
        requestRender();
    } catch(e){
        setStatus('Could not add to groceries.');
    }
}