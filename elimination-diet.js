import { bindEvents } from './SharedJS/dom.js';
import { renderPredictions } from './diet-predictions.js';

// Same globals lists.js uses (supabaseClient, groceryKey, groceryKeysMatch) - elimination-diet.html must load the
// same shared scripts that lists.html does before this module.
const sb = window.supabaseClient;

// ---------- tabs (hash-routed, same pattern as creditcards.js) ----------
const TAB_KEYS = ['timeline', 'meals', 'symptoms', 'ingredients','predictions'];
const tabFromHash = () => (TAB_KEYS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TAB_KEYS[0]);

function switchTab(tabKey) {
    document.querySelectorAll('#elimination-tabs .tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabKey));
    TAB_KEYS.forEach(key => {
        const pane = document.getElementById(`tab-${key}`);
        if (pane) pane.hidden = key !== tabKey;
    });
}


// ---------- allergen / trigger tagging ----------
// kind: 'allergen' (top allergens) or 'trigger' (common GI triggers)
const TAGS = {
    dairy:        { kind: 'allergen', words: ['milk','cheese','butter','cream','yogurt','yoghurt','whey','casein','ghee','ice cream','sour cream','half and half'] },
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
    sweetener:    { kind: 'trigger', words: ['sorbitol','xylitol','mannitol','erythritol','aspartame','sucralose','mio'] },
    carbonated:   { kind: 'trigger', words: ['soda','sparkling','seltzer','carbonated','tonic'] },
    acidic:       { kind: 'trigger', words: ['tomato','citrus','lemon','lime','orange','vinegar'] },
};
const ALL_TAGS = Object.keys(TAGS);
// Whole-word matching (optional plural), so "steak" doesn't hit "tea" and "eggplant" doesn't hit "egg".
const WORD_RES = Object.fromEntries(ALL_TAGS.map(t => [t,
    new RegExp('\\b(?:' + TAGS[t].words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:e?s)?\\b', 'i')]));
const autoTag = name => ALL_TAGS.filter(t => WORD_RES[t].test(name));
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
// Suspected triggers get the site's priority chip style; everything else is a plain chip.
const PRIORITY_TAGS = new Set(['gluten', 'dairy', 'high-FODMAP', 'sweetener', 'fatty/fried']);
const chipClass = t => 'chip' + (PRIORITY_TAGS.has(t) ? ' priority-chip' : '');

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const state = { memory: [], memoryLookup: new Map(), ingredients: [], meals: [], symptoms: [], recipes: [], picked: new Set() };

// ---------- load ----------
async function loadAll() {
    try {
        const [ing, meals, sym, rec, mem] = await Promise.all([
            sb.from('diet_ingredients').select('*').order('name'),
            sb.from('diet_meals').select('*, diet_meal_ingredients(ingredient_id)').order('eaten_at', { ascending: false }).limit(200),
            sb.from('diet_symptoms').select('*').order('occurred_at', { ascending: false }).limit(200),
            sb.from('list_recipes').select('*').order('name'),   // read-only; GI tables never write here
            sb.from('diet_item_memory').select('*'),
        ]);
        state.memory = mem.data || [];
        rebuildMemoryLookup();
        state.ingredients = ing.data || [];
        state.meals = meals.data || [];
        state.symptoms = sym.data || [];
        state.recipes = rec.data || [];
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

function renderIngredients() {
    $('recipeSelect').innerHTML = '<option value="">Import from recipe…</option>' +
        state.recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.title)}</option>`).join('');
    $('ingList').innerHTML = state.ingredients.map(i => `
    <div class="diet-row" data-id="${i.id}">
      <label><input type="checkbox" class="freq" ${i.is_frequent ? 'checked' : ''}> ★</label>
      <strong>${esc(i.name)}</strong>
      <div>${ALL_TAGS.map(t => `<span class="${chipClass(t)} ${i.tags.includes(t) ? '' : 'off'}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
      <button type="button" class="icon-delete del" title="Delete ingredient">✕</button>
    </div>`).join('') || '<p>No ingredients yet.</p>';
}

// ---------- meals ----------
function renderMealPicker() {
    const frequent = state.ingredients.filter(i => i.is_frequent);
    const picked = state.ingredients.filter(i => state.picked.has(i.id) && !i.is_frequent);
    $('mealPicker').innerHTML =
        `<div><small>Frequent / selected (tap to toggle):</small><br>` +
        [...frequent, ...picked].map(i => `<span class="chip ${state.picked.has(i.id) ? '' : 'off'}" data-id="${i.id}">${esc(i.name)}</span>`).join('') +
        `</div><input id="mealAdd" class="text-input" list="ingOptions" placeholder="Add any ingredient (new ones are created)" style="width:100%">
     <datalist id="ingOptions">${state.ingredients.map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>
     <select id="mealRecipe" class="text-input"><option value="">Add all from recipe…</option>${state.recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.title)}</option>`).join('')}</select>`;
}
// ---------- edit state: click a meal or symptom row to load it into its form ----------
let editMealId = null, editSymId = null;
const toLocalInput = iso => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function setMealMode() {
    const editing = !!editMealId;
    $('mealFormTitle').textContent = editing ? 'Edit Meal' : 'Log a Meal';
    $('mealSubmit').textContent = editing ? 'Update meal' : 'Add meal';
    $('mealCancel').hidden = !editing;
}
function resetMealForm() {
    editMealId = null; state.picked.clear();
    $('mealWhen').value = nowLocal(); $('mealLabel').value = ''; $('mealNotes').value = '';
    setMealMode();
}
function startEditMeal(id) {
    const m = state.meals.find(x => x.id === id); if (!m) return;
    editMealId = id;                                           // overwrites whatever was in the form
    $('mealWhen').value = toLocalInput(m.eaten_at); $('mealLabel').value = m.label || ''; $('mealNotes').value = m.notes || '';
    state.picked = new Set(m.diet_meal_ingredients.map(x => x.ingredient_id));
    setMealMode(); renderAll();
    location.hash = 'meals';
    $('mealForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setSymMode() {
    const editing = !!editSymId;
    $('symFormTitle').textContent = editing ? 'Edit Symptom' : 'Log a Symptom';
    $('symSubmit').textContent = editing ? 'Update symptom' : 'Add symptom';
    $('symCancel').hidden = !editing;
}
function resetSymForm() {
    editSymId = null;
    $('symWhen').value = nowLocal(); $('symName').value = ''; $('symSev').value = 3; $('symNotes').value = '';
    setSymMode();
}
function startEditSym(id) {
    const s = state.symptoms.find(x => x.id === id); if (!s) return;
    editSymId = id;
    $('symWhen').value = toLocalInput(s.occurred_at); $('symName').value = s.symptom || '';
    $('symSev').value = s.severity ?? ''; $('symNotes').value = s.notes || '';
    setSymMode(); renderAll();
    location.hash = 'symptoms';
    $('symForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const mealTags = m => {
    const ids = m.diet_meal_ingredients.map(x => x.ingredient_id);
    const ings = ids.map(id => state.ingredients.find(i => i.id === id)).filter(Boolean);
    return { ings, tags: [...new Set(ings.flatMap(i => i.tags))] };
};
const mealHtml = m => {
    const { ings, tags } = mealTags(m);
    return `<div class="diet-row${editMealId === m.id ? ' editing' : ''}" data-meal-id="${m.id}">
    <div class="diet-row-top"><span><strong>${esc(m.label || 'Meal')}</strong> <small>${fmt(m.eaten_at)}</small></span>
      <button type="button" class="icon-delete" title="Delete meal" data-del-meal="${m.id}">✕</button></div>
    <div>${ings.map(i => esc(i.name)).join(', ')}</div>
    <div>${tags.map(t => `<span class="${chipClass(t)}">${esc(t)}</span>`).join('')}</div>
    ${m.notes ? `<small>${esc(m.notes)}</small>` : ''}</div>`;
};

const symHtml = (s, hint = '') => `<div class="diet-row${editSymId === s.id ? ' editing' : ''}" data-sym-id="${s.id}">
  <div class="diet-row-top"><span><strong>${esc(s.symptom)}</strong>
    ${s.severity ? `<span class="sev">${s.severity}/10</span>` : ''} <small>${fmt(s.occurred_at)}</small></span>
    <button type="button" class="icon-delete" title="Delete symptom" data-del-sym="${s.id}">✕</button></div>
  ${s.notes ? `<div><small>${esc(s.notes)}</small></div>` : ''}${hint}</div>`;

// ---------- timeline: meals + symptoms interleaved, with "meals in prior 6h" per symptom ----------
function renderTimeline() {
    const WINDOW = 6 * 3600e3;
    const items = [
        ...state.meals.map(m => ({ t: new Date(m.eaten_at), html: mealHtml(m) })),
        ...state.symptoms.map(s => {
            const t = new Date(s.occurred_at);
            const prior = state.meals.filter(m => { const d = t - new Date(m.eaten_at); return d >= 0 && d <= WINDOW; });
            const tags = [...new Set(prior.flatMap(m => mealTags(m).tags))];
            const hint = tags.length ? `<div><small>Eaten in prior 6h:</small> ${tags.map(x => `<span class="${chipClass(x)}">${esc(x)}</span>`).join('')}</div>` : '';
            return { t, html: symHtml(s, hint) };
        }),
    ].sort((a, b) => b.t - a.t);
    $('timelineList').innerHTML = items.map(i => i.html).join('') || '<p>Nothing logged yet.</p>';
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
    'change #ingList .freq': async (e, checkEl) => {
        const row = checkEl.closest('.diet-row');
        if (row) {
            await updateIngredient(row.dataset.id, { is_frequent: checkEl.checked });
        }
    },

    'change #predGroup, #predWindow, #predSymptom, #predSeverity': () => renderPredictions(state, chipClass),

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
    'click #mealPicker [data-id]': (e, chip) => {
        const id = chip.dataset.id; if (!id) return;
        state.picked.has(id) ? state.picked.delete(id) : state.picked.add(id);
        renderMealPicker();
    },
    'change #mealAdd': async (e, input) => {
        if (input.value.trim()) {
            const ing = await addIngredient(input.value);
            if (ing) state.picked.add(ing.id);
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
                renderAll();
            }
        }
    },
    'click #mealCancel': () => { resetMealForm(); renderAll(); },
    'click #symCancel': () => { resetSymForm(); renderAll(); },
    'click [data-del-meal], [data-del-sym]': async (e, del) => {
        const isMeal = !!del.dataset.delMeal, id = del.dataset.delMeal || del.dataset.delSym;
        if (!confirm(isMeal ? 'Delete this meal?' : 'Delete this symptom?')) return;
        try {
            const { error } = await sb.from(isMeal ? 'diet_meals' : 'diet_symptoms').delete().eq('id', id);
            if (error) return console.error(error);
            if (isMeal && editMealId === id) resetMealForm();
            if (!isMeal && editSymId === id) resetSymForm();
            await loadAll();
        } catch (err) {
            console.error('Failed to delete item:', err);
        }
    },
    'click .diet-row[data-meal-id], .diet-row[data-sym-id]': (e, row) => {
        if (e.target.closest('button, a, input, select, label, textarea')) return;
        row.dataset.mealId ? startEditMeal(row.dataset.mealId) : startEditSym(row.dataset.symId);
    },
    'submit #mealForm': async (e) => {
        e.preventDefault();
        try {
            const fields = { eaten_at: new Date($('mealWhen').value).toISOString(), label: $('mealLabel').value || null, notes: $('mealNotes').value || null };
            if (editMealId) {
                const { error } = await sb.from('diet_meals').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', editMealId);
                if (error) return console.error(error);
                const m = state.meals.find(m => m.id === editMealId);
                const current = new Set(m ? m.diet_meal_ingredients.map(x => x.ingredient_id) : []);
                const removed = [...current].filter(i => !state.picked.has(i));
                const added = [...state.picked].filter(i => !current.has(i));
                if (removed.length) await sb.from('diet_meal_ingredients').delete().eq('meal_id', editMealId).in('ingredient_id', removed);
                if (added.length) await sb.from('diet_meal_ingredients').insert(added.map(ingredient_id => ({ meal_id: editMealId, ingredient_id })));
            } else {
                const { data: meal, error } = await sb.from('diet_meals').insert(fields).select().single();
                if (error) return console.error(error);
                if (state.picked.size)
                    await sb.from('diet_meal_ingredients').insert([...state.picked].map(ingredient_id => ({ meal_id: meal.id, ingredient_id })));
            }
            resetMealForm();
            await loadAll();
        } catch (err) {
            console.error('Failed to save meal:', err);
        }
    },
    'submit #symForm': async (e) => {
        e.preventDefault();
        try {
            const fields = { occurred_at: new Date($('symWhen').value).toISOString(), symptom: $('symName').value.trim(),
                severity: +$('symSev').value || null, notes: $('symNotes').value || null };
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
    $('mealList').innerHTML = state.meals.map(mealHtml).join('') || '<p>No meals yet.</p>';
    $('symList').innerHTML = state.symptoms.map(symHtml).join('') || '<p>No symptoms yet.</p>';
    renderTimeline();
    renderPredictions(state, chipClass);
}

$('mealWhen').value = nowLocal(); $('symWhen').value = nowLocal();

if (window.initAppPage) {
    window.initAppPage(loadAll);
} else {
    document.addEventListener('app:ready', loadAll, { once: true });
}