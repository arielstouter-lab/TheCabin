import { bindEvents } from '../shared/dom.js';
import { renderPredictions } from './diet-predictions.js';
import { renderAttention } from './diet-coverage.js';
import { exportTimelineCsv } from './diet-export.js';
import { tpl, fill, slot, setOptions, renderList } from './diet-tpl.js';

// Same globals lists.js uses (supabaseClient, groceryKey, groceryKeysMatch) - elimination-diet.html must load the
// same shared scripts that lists.html does before this module.
const sb = window.supabaseClient;

// ---------- allergen / trigger tagging ----------
// kind: 'allergen' (top allergens) or 'trigger' (common GI triggers)
const TAGS = {
    // dairy = anything made from milk (milk proteins). lactose = milk sugar, so lactose-free milk is dairy but not lactose.
    dairy:        { kind: 'allergen', words: ['milk','cheese','butter','cream','yogurt','yoghurt','whey','casein','ghee','ice cream','sour cream','half and half','buttermilk','kefir','paneer','custard','cheddar','parmesan','mozzarella','feta','brie','gouda','ricotta','mascarpone'],
        not: ['dairy[- ]free','non[- ]dairy','\\b(almond|oat|soy|coconut|rice|cashew|hemp|pea|plant)[- ]?(based )?(milk|cream|yogurt|yoghurt|cheese|butter)','\\b(peanut|almond|cashew|nut|cocoa|shea|apple|sunflower) butter','cream of tartar'] },
    lactose:      { kind: 'allergen', words: ['milk','cream','ice cream','sour cream','half and half','yogurt','yoghurt','kefir','ricotta','mascarpone','cottage cheese','cream cheese','condensed milk','custard','buttermilk','whey'],
        not: ['lactose[- ]free','dairy[- ]free','non[- ]dairy','\\b(almond|oat|soy|coconut|rice|cashew|hemp|pea|plant)[- ]?(based )?(milk|cream|yogurt|yoghurt)','cream of tartar'] },
    gluten:       { kind: 'allergen', words: ['wheat','flour','bread','pasta','barley','rye','couscous','semolina','tortilla','noodle','breadcrumb','soy sauce','cracker','cake','cookie','muffin','pastry','pie','biscuit','scone','brownie','donut','doughnut','pancake','waffle','pizza','bagel','pretzel','bun','croissant','dumpling','cereal','granola','crust','dough','batter','macaroni','mac and cheese','spaghetti','lasagna','ravioli','pita','sandwich','burger','biscotti'] },
    egg:          { kind: 'allergen', words: ['egg','mayo','mayonnaise','meringue'] },
    soy:          { kind: 'allergen', words: ['soy','tofu','tempeh','edamame','miso'] },
    peanut:       { kind: 'allergen', words: ['peanut'] },
    'tree nut':   { kind: 'allergen', words: ['almond','walnut','pecan','cashew','pistachio','hazelnut','macadamia','pine nut'] },
    fish:         { kind: 'allergen', words: ['salmon','tuna','cod','tilapia','anchovy','sardine','fish sauce','trout'] },
    shellfish:    { kind: 'allergen', words: ['shrimp','crab','lobster','prawn','scallop','clam','oyster','mussel'] },
    sesame:       { kind: 'allergen', words: ['sesame','tahini'] },
    'onion/garlic': { kind: 'trigger', words: ['onion','garlic','shallot','leek','scallion'] },
    'high-FODMAP':  { kind: 'trigger', words: ['apple','pear','mango','watermelon','beans','lentil','chickpea','cauliflower','mushroom','honey','agave','asparagus','artichoke','cabbage','broccoli'] },
    spicy:        { kind: 'trigger', words: ['chili','chile','jalapeno','habanero','cayenne','hot sauce','sriracha','red pepper flake','salsa','curry'] },
    caffeine:     { kind: 'trigger', words: ['coffee','espresso','tea','chocolate','cocoa','cola','energy drink'] },
    alcohol:      { kind: 'trigger', words: ['wine','beer','vodka','whiskey','rum','tequila','liquor','bourbon'] },
    'fatty/fried':{ kind: 'trigger', words: ['fried','bacon','sausage','lard','deep-fried','fries'] },
    sweetener:    { kind: 'trigger', words: ['sorbitol','xylitol','mannitol','erythritol','aspartame','sucralose','stevia'] },
    carbonated:   { kind: 'trigger', words: ['soda','sparkling','seltzer','carbonated','tonic'] },
    acidic:       { kind: 'trigger', words: ['tomato','citrus','lemon','lime','orange','vinegar'] },
};
const ALL_TAGS = Object.keys(TAGS);
// Whole-word matching (optional plural), so "steak" doesn't hit "tea" and "eggplant" doesn't hit "egg".
const WORD_RES = Object.fromEntries(ALL_TAGS.map(t => [t,
    new RegExp('\\b(?:' + TAGS[t].words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:e?s)?\\b', 'i')]));
const NOT_RES = Object.fromEntries(ALL_TAGS.filter(t => TAGS[t].not).map(t => [t, new RegExp(TAGS[t].not.join('|'), 'i')]));
const autoTag = name => ALL_TAGS.filter(t => WORD_RES[t].test(name) && !(NOT_RES[t] && NOT_RES[t].test(name)));
// Learned tags: same matching as groceries' aisleIdForItemText (exact -> phrase -> partial),
// reading diet_item_memory (item_key -> tags) instead of aisles.
const gk = t => window.groceryKey(t);
const rebuildMemoryLookup = () => { state.memoryLookup = new Map(state.memory.map(m => [gk(m.item_key), m.tags])); };
function tagsFor(name) {
    const key = gk(name);
    if (!key) return autoTag(name);
    if (state.memoryLookup.has(key)) return state.memoryLookup.get(key);       // exact: your saved tags only
    const longest = (a, b) => gk(b.item_key).length - gk(a.item_key).length;
    const hit =
        state.memory.filter(m => { const k = gk(m.item_key); return k && (key.includes(k) || k.includes(key)); }).sort(longest)[0] ||
        state.memory.filter(m => window.groceryKeysMatch(name, m.item_key)).sort(longest)[0];
    // Fuzzy hit: union with keyword guess so "garlic chicken" keeps garlic even if only "chicken" was saved.
    return hit ? [...new Set([...hit.tags, ...autoTag(name)])] : autoTag(name);
}
async function rememberTags(name, tags) {
    const key = gk(name); if (!key) return;
    const row = { item_key: key, tags, updated_at: new Date().toISOString() };
    const i = state.memory.findIndex(m => m.item_key === key);
    i >= 0 ? (state.memory[i] = row) : state.memory.push(row);
    rebuildMemoryLookup();
    const { error } = await sb.from('diet_item_memory').upsert(row, { onConflict: 'item_key' });
    if (error) console.error(error);
}

// ---------- chips ----------
// Suspected triggers get the site's priority chip style; everything else is a plain chip.
const PRIORITY_TAGS = new Set(['gluten', 'dairy', 'lactose', 'high-FODMAP', 'sweetener', 'fatty/fried']);

const setOn = (el, on = true) => { on ? delete el.dataset.state : (el.dataset.state = 'off'); return el; };
const setKind = (el, t) => { PRIORITY_TAGS.has(t) ? (el.dataset.kind = 'priority') : delete el.dataset.kind; return el; };

const chip = (label, attrs = {}) => {                         // plain chip; attrs become data-* attributes
    const el = tpl('tpl-chip');
    el.textContent = label;
    Object.assign(el.dataset, attrs);
    return el;
};
// Tag chip: priority styling from the tag, data-state="off" when unselected, data-tag only when clickable.
const tagChip = (t, { on = true, pick = false } = {}) => {
    const el = setKind(chip(t), t);
    if (pick) el.dataset.tag = t;
    return setOn(el, on);
};

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const cap = s => s[0].toUpperCase() + s.slice(1);
const state = { memory: [], memoryLookup: new Map(), ingredients: [], meals: [], symptoms: [], recipes: [], supplements: [], picked: new Set() };
const recipeOptions = () => state.recipes.map(r => [r.id, r.name || r.title]);

// ---------- load ----------
async function loadAll() {
    try {
        const [ing, meals, sym, rec, mem, sup] = await Promise.all([
            sb.from('diet_ingredients').select('*').order('name'),
            sb.from('diet_meals').select('*, diet_meal_ingredients(ingredient_id)').order('eaten_at', { ascending: false }).limit(200),
            sb.from('diet_symptoms').select('*').order('occurred_at', { ascending: false }).limit(200),
            sb.from('list_recipes').select('*').order('name'),   // read-only; GI tables never write here
            sb.from('diet_item_memory').select('*'),
            sb.from('diet_supplements').select('*').order('taken_at', { ascending: false }).limit(200),
        ]);
        state.memory = mem.data || [];
        rebuildMemoryLookup();
        state.ingredients = ing.data || [];
        state.meals = meals.data || [];
        state.symptoms = sym.data || [];
        state.recipes = rec.data || [];
        state.supplements = sup.data || [];
        renderAll();
    } catch (err) {
        console.error('Failed to load diet data:', err);
    }
}

// ---------- ingredients ----------
async function addIngredient(name, extra = {}) {
    try {
        name = name.trim();
        if (!name) return null;
        const existing = state.ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
        const { data, error } = await sb.from('diet_ingredients')
            .insert({ name, tags: tagsFor(name), ...extra }).select().single();
        if (error) { console.error(error); return null; }
        state.ingredients.push(data);
        state.ingredients.sort((a, b) => a.name.localeCompare(b.name));
        return data;
    } catch (err) {
        console.error('Failed to add ingredient:', err);
        return null;
    }
}

async function updateIngredient(id, patch) {
    try {
        const { error } = await sb.from('diet_ingredients').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) return console.error(error);
        const ing = state.ingredients.find(i => i.id === id);
        if (ing) {
            Object.assign(ing, patch);
            if (patch.tags) await rememberTags(ing.name, patch.tags);   // tag edits are remembered by exact name
            renderAll();
        }
    } catch (err) {
        console.error('Failed to update ingredient:', err);
    }
}

// Recipe ingredient formats vary; handles array, JSON-ish array, or newline/comma text.
function parseRecipeIngredients(r) {
    const raw = r.ingredients ?? r.ingredient_list ?? '';
    const list = Array.isArray(raw) ? raw : String(raw).split(/[\n,]/);
    return list
        .map(s => (typeof s === 'string' ? s : s?.name || ''))
        .map(s => s.replace(/^[\s\-•*\d./]+/, '')                                   // leading qty/bullet
            .replace(/^(cups?|tbsp|tsp|oz|lb|lbs|g|kg|ml|cloves?|cans?)\b\s*(of\s+)?/i, '')
            .replace(/\(.*?\)/g, '').trim())
        .filter(Boolean);
}

async function importRecipe(recipeId) {
    try {
        const r = state.recipes.find(x => String(x.id) === String(recipeId));
        if (!r) return;
        for (const name of parseRecipeIngredients(r)) await addIngredient(name, { source_recipe_id: r.id });
        renderAll();
    } catch (err) {
        console.error('Failed to import recipe:', err);
    }
}

const STAR_ON = 'Starred: always shown when logging a meal. Tap to unstar.';
const STAR_OFF = 'Tap to star: always show when logging a meal';
function ingRow(i, used) {
    const row = tpl('tpl-ingredient-row');
    fill(row, { name: i.name, used, unused: !used, usedText: `${used}\u00d7 logged` });
    row.dataset.id = i.id;
    const star = row.querySelector('[data-star]');
    star.classList.toggle('on', !!i.is_frequent);
    star.textContent = i.is_frequent ? '★' : '☆';
    star.title = i.is_frequent ? STAR_ON : STAR_OFF;
    const link = row.querySelector('[data-filter-ingredient]');
    if (link) link.dataset.filterIngredient = i.id;
    slot(row, 'tags').append(...ALL_TAGS.map(t => tagChip(t, { on: i.tags.includes(t), pick: true })));
    return row;
}
function renderIngredients() {
    const uses = usageCounts();
    setOptions($('recipeSelect'), recipeOptions(), true);
    renderList($('ingList'), state.ingredients.map(i => ingRow(i, uses.get(i.id) || 0)));
}

// ---------- meals ----------
// How many logged meals each ingredient appears in.
function usageCounts() {
    const counts = new Map();
    state.meals.forEach(m => (m.diet_meal_ingredients || []).forEach(x => counts.set(x.ingredient_id, (counts.get(x.ingredient_id) || 0) + 1)));
    return counts;
}
const TOP_USED = 6;       // most-used ingredients shown as chips automatically, besides starred ones
const MIN_USES = 2;       // ...once they have appeared in at least this many meals
function renderMealPicker() {
    const uses = usageCounts();
    const starred = state.ingredients.filter(i => i.is_frequent);
    const common = state.ingredients.filter(i => !i.is_frequent && (uses.get(i.id) || 0) >= MIN_USES)
        .sort((a, b) => uses.get(b.id) - uses.get(a.id)).slice(0, TOP_USED);
    const shown = new Set([...starred, ...common].map(i => i.id));
    const picked = state.ingredients.filter(i => state.picked.has(i.id) && !shown.has(i.id));
    $('mealChips').replaceChildren(...[...starred, ...common, ...picked].map(i =>
        setOn(chip(i.name, { id: i.id }), state.picked.has(i.id))));
    setOptions($('ingOptions'), state.ingredients.map(i => [i.name]));
    setOptions($('mealRecipe'), recipeOptions(), true);
}
// ---------- edit state: click a meal or symptom row to load it into its form ----------
let editMealId = null, editSymId = null;
let mealFilterId = null;      // ingredient id the Meals list is filtered to, or null for all meals
const toLocalInput = v => { const d = new Date(v); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function applySkippedUI() { $('mealPicker').hidden = $('mealSkipped').checked; }
function setMealMode() {
    const editing = !!editMealId;
    $('mealFormTitle').textContent = editing ? 'Edit Meal' : 'Log a Meal';
    $('mealSubmit').textContent = editing ? 'Update meal' : 'Add meal';
    $('mealCancel').hidden = !editing;
    applySkippedUI();
}
function resetMealForm() {
    editMealId = null; state.picked.clear();
    $('mealWhen').value = nowLocal(); $('mealLabel').value = ''; $('mealNotes').value = ''; $('mealSkipped').checked = false; $('mealSize').value = '';
    setMealMode();
}
function startEditMeal(id) {
    const m = state.meals.find(x => x.id === id); if (!m) return;
    editMealId = id;                                           // overwrites whatever was in the form
    $('mealWhen').value = toLocalInput(m.eaten_at); $('mealLabel').value = m.label || ''; $('mealNotes').value = m.notes || '';
    $('mealSkipped').checked = !!m.skipped; $('mealSize').value = m.meal_size || '';
    state.picked = new Set(m.diet_meal_ingredients.map(x => x.ingredient_id));
    setMealMode(); renderAll();
    location.hash = 'meals';
    $('mealForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Symptom form: "Symptom" entries are problems; "Positive" entries mean digestion felt good.
// Bristol type decides whether an entry is a symptom or a positive: 1-2 and 6-7 are negative, 3-5 positive.
const NEGATIVE_BRISTOL = [1, 2, 6, 7];
const BM_RE = /\bbm\b|bowel movement/i;        // a plain BM entry defaults to Bristol 5
function applyBristolPolarity() {
    const b = +$('symBristol').value;
    if (!b) return;
    $('symType').value = NEGATIVE_BRISTOL.includes(b) ? 'negative' : 'positive';
    setSymType();
}
const BRISTOL_RE = /diarrh|loose|stool|bowel|constip|\bbm\b|poop|toilet/i;
function setBristolVisibility() {
    const show = BRISTOL_RE.test($('symName').value) || !!$('symBristol').value;
    $('symBristol').hidden = !show;
    $('bristolHelp').hidden = !show;
}
function setSymType() {
    const positive = $('symType').value === 'positive';
    $('symName').setAttribute('list', positive ? 'symOptionsPositive' : 'symOptions');
    $('symName').placeholder = positive ? 'Positive (e.g. Felt fine)' : 'Symptom';
    $('symSev').placeholder = positive ? 'How good (1-10)' : 'Severity';
    setBristolVisibility();
}
function setSymMode() {
    const editing = !!editSymId;
    $('symFormTitle').textContent = editing ? 'Edit Entry' : 'Log a Symptom';
    $('symSubmit').textContent = editing ? 'Update entry' : 'Add entry';
    $('symCancel').hidden = !editing;
    setSymType();
}
function resetSymForm() {
    editSymId = null;
    $('symType').value = 'negative';
    $('symWhen').value = nowLocal(); $('symName').value = ''; $('symSev').value = 3; $('symNotes').value = ''; $('symBristol').value = '';
    setSymMode();
}
function startEditSym(id) {
    const s = state.symptoms.find(x => x.id === id); if (!s) return;
    editSymId = id;
    $('symType').value = s.positive ? 'positive' : 'negative';
    $('symWhen').value = toLocalInput(s.occurred_at); $('symName').value = s.symptom || '';
    $('symSev').value = s.severity ?? ''; $('symNotes').value = s.notes || ''; $('symBristol').value = s.bristol ?? '';
    setSymMode(); renderAll();
    location.hash = 'symptoms';
    $('symForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const mealTags = m => {
    const ids = m.diet_meal_ingredients.map(x => x.ingredient_id);
    const ings = ids.map(id => state.ingredients.find(i => i.id === id)).filter(Boolean);
    return { ings, tags: [...new Set(ings.flatMap(i => i.tags))] };
};
function mealRow(m) {
    const { ings, tags } = mealTags(m);
    const row = tpl('tpl-meal-row');
    fill(row, {
        label: m.label || 'Meal', skipped: m.skipped, size: m.meal_size ? cap(m.meal_size) : '',
        when: fmt(m.eaten_at), hasBody: !m.skipped, ingredients: ings.map(i => i.name).join(', '), notes: m.notes,
    });
    row.dataset.mealId = m.id;
    row.classList.toggle('editing', editMealId === m.id);
    row.querySelector('[data-del-meal]').dataset.delMeal = m.id;
    slot(row, 'tags')?.append(...tags.map(t => tagChip(t)));
    return row;
}

// hintTags: tags from meals in the prior 6h (timeline only)
function symRow(s, hintTags = []) {
    const row = tpl('tpl-symptom-row');
    fill(row, {
        symptom: s.symptom, positive: s.positive, bristol: s.bristol, bristolText: `Bristol ${s.bristol}`,
        severity: s.severity, severityText: `${s.severity}/10`, when: fmt(s.occurred_at), notes: s.notes, hint: hintTags.length,
    });
    row.dataset.symId = s.id;
    row.classList.toggle('editing', editSymId === s.id);
    row.querySelector('[data-del-sym]').dataset.delSym = s.id;
    slot(row, 'hintTags')?.append(...hintTags.map(t => tagChip(t)));
    return row;
}

// ---------- supplements (pills) ----------
let editSuppId = null;
function setSuppMode() {
    const editing = !!editSuppId;
    $('suppFormTitle').textContent = editing ? 'Edit Supplement' : 'Log a Supplement';
    $('suppSubmit').textContent = editing ? 'Update supplement' : 'Add supplement';
    $('suppCancel').hidden = !editing;
}
function resetSuppForm() {
    editSuppId = null;
    $('suppWhen').value = nowLocal(); $('suppName').value = ''; $('suppDose').value = ''; $('suppNotes').value = '';
    setSuppMode();
}
function startEditSupp(id) {
    const s = state.supplements.find(x => x.id === id); if (!s) return;
    editSuppId = id;
    $('suppWhen').value = toLocalInput(s.taken_at); $('suppName').value = s.name || '';
    $('suppDose').value = s.dose || ''; $('suppNotes').value = s.notes || '';
    setSuppMode(); renderAll();
    location.hash = 'supplements';
    $('suppForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function suppRow(s, showTag = false) {
    const row = tpl('tpl-supp-row');
    fill(row, { name: s.name, showTag, dose: s.dose, when: fmt(s.taken_at), notes: s.notes });
    row.dataset.suppId = s.id;
    row.classList.toggle('editing', editSuppId === s.id);
    row.querySelector('[data-del-supp]').dataset.delSupp = s.id;
    return row;
}
function renderSupplements() {
    // One-tap chips for the supplements you log most, with the dose from the latest entry (list is newest first).
    const seen = new Map();
    state.supplements.forEach(s => {
        const key = (s.name || '').trim().toLowerCase(); if (!key) return;
        const c = seen.get(key) || { name: s.name, dose: s.dose || '', n: 0 };
        c.n++; seen.set(key, c);
    });
    const names = [...seen.values()];
    $('suppQuick').replaceChildren(...names.sort((a, b) => b.n - a.n).slice(0, 8)
        .map(c => chip(c.name, { suppQuick: c.name, dose: c.dose })));
    setOptions($('suppOptions'), names.map(c => [c.name]));
    renderList($('suppList'), state.supplements.map(s => suppRow(s)));
}

// ---------- timeline: meals + symptoms interleaved, with "meals in prior 6h" per symptom ----------
function renderTimeline() {
    const WINDOW = 6 * 3600e3;
    const items = [
        ...state.meals.map(m => ({ t: new Date(m.eaten_at), node: mealRow(m) })),
        ...state.supplements.map(s => ({ t: new Date(s.taken_at), node: suppRow(s, true) })),
        ...state.symptoms.map(s => {
            const t = new Date(s.occurred_at);
            let tags = [];
            if (!s.positive) {
                const prior = state.meals.filter(m => { const d = t - new Date(m.eaten_at); return d >= 0 && d <= WINDOW; });
                tags = [...new Set(prior.flatMap(m => mealTags(m).tags))];
            }
            return { t, node: symRow(s, tags) };
        }),
    ].sort((a, b) => b.t - a.t);
    renderList($('timelineList'), items.map(i => i.node));
}

// ---------- tabs (hash-routed, same pattern as creditcards.js) ----------
const TAB_KEYS = ['timeline', 'meals', 'symptoms', 'supplements', 'ingredients', 'predictions'];
const tabFromHash = () => (TAB_KEYS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TAB_KEYS[0]);

function switchTab(tabKey) {
    document.querySelectorAll('#elimination-tabs .tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabKey));
    TAB_KEYS.forEach(key => {
        const pane = document.getElementById(`tab-${key}`);
        if (pane) pane.hidden = key !== tabKey;
    });
}

// ---------- declarative event map ----------
bindEvents(document, {
    'click #ingList [data-tag]': async (e, tagEl) => {
        const row = tagEl.closest('.diet-row'); if (!row) return;
        const ing = state.ingredients.find(i => i.id === row.dataset.id);
        if (!ing) return;
        const t = tagEl.dataset.tag;
        await updateIngredient(ing.id, { tags: ing.tags.includes(t) ? ing.tags.filter(x => x !== t) : [...ing.tags, t] });
    },
    'click #ingList .del': async (e, delBtn) => {
        const row = delBtn.closest('.diet-row'); if (!row) return;
        const ing = state.ingredients.find(i => i.id === row.dataset.id);
        if (!ing) return;
        if (!confirm(`Delete ${ing.name}? It will be removed from logged meals too.`)) return;
        try {
            await sb.from('diet_ingredients').delete().eq('id', ing.id);
            state.ingredients = state.ingredients.filter(i => i.id !== ing.id);
            await loadAll();
        } catch (err) {
            console.error('Failed to delete ingredient:', err);
        }
    },
    'click #ingList [data-star]': async (e, star) => {
        const row = star.closest('.diet-row'); if (!row) return;
        const ing = state.ingredients.find(i => i.id === row.dataset.id);
        if (ing) await updateIngredient(ing.id, { is_frequent: !ing.is_frequent });
    },
    'submit #ingForm': async (e) => {
        e.preventDefault();
        await addIngredient($('ingName').value, { is_frequent: false });
        $('ingName').value = '';
        renderAll();
    },
    'submit #recipeImportForm': async (e) => {
        e.preventDefault();
        await importRecipe($('recipeSelect').value);
    },
    'click #mealPicker [data-id]': (e, chipEl) => {
        const id = chipEl.dataset.id; if (!id) return;
        state.picked.has(id) ? state.picked.delete(id) : state.picked.add(id);
        renderMealPicker();
    },
    'change #mealAdd': async (e, input) => {
        if (input.value.trim()) {
            const ing = await addIngredient(input.value);
            if (ing) state.picked.add(ing.id);
            input.value = '';                       // the input now persists across renders, so clear it here
            renderAll();
        }
    },
    'change #mealRecipe': async (e, select) => {
        if (select.value) {
            const r = state.recipes.find(x => String(x.id) === select.value);
            if (r) {
                for (const n of parseRecipeIngredients(r)) {
                    const ing = await addIngredient(n, { source_recipe_id: r.id });
                    if (ing) state.picked.add(ing.id);
                }
                if (!$('mealLabel').value) $('mealLabel').value = r.name || r.title || '';
                select.value = '';
                renderAll();
            }
        }
    },
    'change #mealSkipped': () => applySkippedUI(),
    'change #symType': () => setSymType(),
    'input #symName': () => {
        if (BM_RE.test($('symName').value) && !$('symBristol').value) { $('symBristol').value = '5'; applyBristolPolarity(); }
        setBristolVisibility();
    },
    'change #symBristol': () => applyBristolPolarity(),
    'click #mealCancel': () => { resetMealForm(); renderAll(); },
    'click #symCancel': () => { resetSymForm(); renderAll(); },
    'click [data-del-meal], [data-del-sym], [data-del-supp]': async (e, del) => {
        const kind = del.dataset.delMeal ? 'meal' : del.dataset.delSym ? 'sym' : 'supp';
        const id = del.dataset.delMeal || del.dataset.delSym || del.dataset.delSupp;
        const table = { meal: 'diet_meals', sym: 'diet_symptoms', supp: 'diet_supplements' }[kind];
        if (!confirm({ meal: 'Delete this meal?', sym: 'Delete this entry?', supp: 'Delete this supplement entry?' }[kind])) return;
        try {
            const { error } = await sb.from(table).delete().eq('id', id);
            if (error) return console.error(error);
            if (kind === 'meal' && editMealId === id) resetMealForm();
            if (kind === 'sym' && editSymId === id) resetSymForm();
            if (kind === 'supp' && editSuppId === id) resetSuppForm();
            await loadAll();
        } catch (err) {
            console.error('Failed to delete item:', err);
        }
    },
    'click .diet-row[data-meal-id], .diet-row[data-sym-id], .diet-row[data-supp-id]': (e, row) => {
        if (e.target.closest('button, a, input, select, label, textarea')) return;
        if (row.dataset.mealId) startEditMeal(row.dataset.mealId);
        else if (row.dataset.symId) startEditSym(row.dataset.symId);
        else startEditSupp(row.dataset.suppId);
    },

    // ---- Supplements ----
    'click #suppQuick [data-supp-quick]': (e, chipEl) => {
        $('suppName').value = chipEl.dataset.suppQuick; $('suppDose').value = chipEl.dataset.dose || '';
    },
    'click #suppCancel': () => { resetSuppForm(); renderAll(); },
    'submit #suppForm': async (e) => {
        e.preventDefault();
        try {
            const fields = { taken_at: new Date($('suppWhen').value).toISOString(), name: $('suppName').value.trim(),
                dose: $('suppDose').value.trim() || null, notes: $('suppNotes').value || null };
            if (!fields.name) return;
            const { error } = editSuppId
                ? await sb.from('diet_supplements').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', editSuppId)
                : await sb.from('diet_supplements').insert(fields);
            if (error) return console.error(error);
            resetSuppForm();
            await loadAll();
        } catch (err) {
            console.error('Failed to save supplement:', err);
        }
    },

    // ---- Meal list filter (from the "N× logged" links on the Ingredients tab) ----
    'click #ingList [data-filter-ingredient]': (e, link) => {
        e.preventDefault();
        mealFilterId = link.dataset.filterIngredient;
        renderAll();
        location.hash = 'meals';
        switchTab('meals');                                   // the pane must be visible before scrolling to it
        $('mealFilterBar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    'click [data-clear-meal-filter]': () => { mealFilterId = null; renderAll(); },

    // ---- Needs attention card ----
    'click #attentionList [data-skip-meal]': async (e, btn) => {
        try {
            const { error } = await sb.from('diet_meals').insert({
                eaten_at: new Date(+btn.dataset.skipMeal).toISOString(), label: btn.dataset.slotName, skipped: true });
            if (error) return console.error(error);
            await loadAll();
        } catch (err) {
            console.error('Failed to mark meal not eaten:', err);
        }
    },
    'click #attentionList [data-log-meal]': (e, btn) => {
        resetMealForm();
        $('mealWhen').value = toLocalInput(+btn.dataset.logMeal);
        $('mealLabel').value = btn.dataset.slotName || '';
        renderAll();
        location.hash = 'meals';
    },
    'click #attentionList [data-fine]': async (e, btn) => {
        try {
            const { error } = await sb.from('diet_symptoms').insert({
                occurred_at: new Date(+btn.dataset.fine).toISOString(), symptom: 'Felt fine', positive: true, severity: null });
            if (error) return console.error(error);
            await loadAll();
        } catch (err) {
            console.error('Failed to log positive entry:', err);
        }
    },
    'click #attentionList [data-log-sym]': (e, btn) => {
        resetSymForm();
        $('symWhen').value = toLocalInput(+btn.dataset.logSym);
        renderAll();
        location.hash = 'symptoms';
    },

    // ---- Predictions controls ----
    'change #predGroup, #predWindow, #predSymptom, #predSeverity': () => renderPredictions(state, tagChip),

    'submit #mealForm': async (e) => {
        e.preventDefault();
        try {
            const skipped = $('mealSkipped').checked;
            const picked = skipped ? new Set() : state.picked;          // a meal not eaten has no ingredients
            const fields = { eaten_at: new Date($('mealWhen').value).toISOString(), label: $('mealLabel').value || null,
                notes: $('mealNotes').value || null, skipped,
                meal_size: skipped ? null : ($('mealSize').value || null) };
            if (editMealId) {
                const { error } = await sb.from('diet_meals').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', editMealId);
                if (error) return console.error(error);
                const m = state.meals.find(m => m.id === editMealId);
                const current = new Set(m ? m.diet_meal_ingredients.map(x => x.ingredient_id) : []);
                const removed = [...current].filter(i => !picked.has(i));
                const added = [...picked].filter(i => !current.has(i));
                if (removed.length) await sb.from('diet_meal_ingredients').delete().eq('meal_id', editMealId).in('ingredient_id', removed);
                if (added.length) await sb.from('diet_meal_ingredients').insert(added.map(ingredient_id => ({ meal_id: editMealId, ingredient_id })));
            } else {
                const { data: meal, error } = await sb.from('diet_meals').insert(fields).select().single();
                if (error) return console.error(error);
                if (picked.size)
                    await sb.from('diet_meal_ingredients').insert([...picked].map(ingredient_id => ({ meal_id: meal.id, ingredient_id })));
            }
            resetMealForm();
            mealFilterId = null;
            await loadAll();
        } catch (err) {
            console.error('Failed to save meal:', err);
        }
    },
    'submit #symForm': async (e) => {
        e.preventDefault();
        try {
            const bristol = +$('symBristol').value || null;
            const fields = { occurred_at: new Date($('symWhen').value).toISOString(), symptom: $('symName').value.trim(),
                positive: bristol ? !NEGATIVE_BRISTOL.includes(bristol) : $('symType').value === 'positive', severity: +$('symSev').value || null, bristol, notes: $('symNotes').value || null };
            const { error } = editSymId
                ? await sb.from('diet_symptoms').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', editSymId)
                : await sb.from('diet_symptoms').insert(fields);
            if (error) return console.error(error);
            resetSymForm();
            await loadAll();
        } catch (err) {
            console.error('Failed to save symptom:', err);
        }
    },
    'click #exportTimelineBtn, #copyTimelineBtn': async (e, btn) => {
        const status = $('exportStatus');
        const say = msg => { if (status) status.textContent = msg; if (window.setStatus) window.setStatus(msg); };
        say('Preparing export…');
        try {
            say(await exportTimelineCsv(sb, state.ingredients, btn.id === 'copyTimelineBtn' ? 'copy' : 'download'));
        } catch (err) {
            console.error('Export failed:', err);
            say('Could not export: ' + (err.message || err));
        }
    },
    'click #elimination-tabs .tab': (e, btn) => {
        if (btn.dataset.tab) location.hash = btn.dataset.tab;
    }
});

window.addEventListener('hashchange', () => switchTab(tabFromHash()));
if (document.getElementById('elimination-tabs')) {
    switchTab(tabFromHash());
}

function renderAll() {
    renderIngredients(); renderMealPicker();
    if (mealFilterId && !state.ingredients.some(i => i.id === mealFilterId)) mealFilterId = null;   // ingredient was deleted
    const shownMeals = mealFilterId
        ? state.meals.filter(m => (m.diet_meal_ingredients || []).some(x => x.ingredient_id === mealFilterId))
        : state.meals;
    renderList($('mealList'), shownMeals.map(mealRow), mealFilterId ? 'emptyFiltered' : 'empty');
    $('mealFilterBar').hidden = !mealFilterId;
    if (mealFilterId) {
        const ing = state.ingredients.find(i => i.id === mealFilterId);
        $('mealFilterCount').textContent = `Showing ${shownMeals.length} meal${shownMeals.length === 1 ? '' : 's'} with`;
        $('mealFilterName').textContent = ing.name;
    }
    renderList($('symList'), state.symptoms.map(s => symRow(s)));
    renderSupplements();
    renderTimeline();
    renderAttention(state);
    renderPredictions(state, tagChip);
}

$('mealWhen').value = nowLocal(); $('symWhen').value = nowLocal(); $('suppWhen').value = nowLocal(); setSymType();

if (window.initAppPage) {
    window.initAppPage(loadAll);
} else {
    document.addEventListener('app:ready', loadAll, { once: true });
}