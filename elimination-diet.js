import { sb } from './Lists/lists-state.js';

// ---------- allergen / trigger tagging ----------
// kind: 'allergen' (top allergens) or 'trigger' (common GI triggers)
const TAGS = {
    dairy:        { kind: 'allergen', words: ['milk','cheese','butter','cream','yogurt','yoghurt','whey','casein','ghee','ice cream','sour cream','half and half'] },
    gluten:       { kind: 'allergen', words: ['wheat','flour','bread','pasta','barley','rye','couscous','semolina','tortilla','noodle','breadcrumb','soy sauce','cracker'] },
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
const autoTag = name => {
    const n = name.toLowerCase();
    return ALL_TAGS.filter(t => TAGS[t].words.some(w => n.includes(w)));
};
const chipClass = t => 'chip ' + (TAGS[t]?.kind || '');

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const state = { ingredients: [], meals: [], symptoms: [], recipes: [], picked: new Set() };

// ---------- load ----------
async function loadAll() {
    const [ing, meals, sym, rec] = await Promise.all([
        sb.from('diet_ingredients').select('*').order('name'),
        sb.from('diet_meals').select('*, diet_meal_ingredients(ingredient_id)').order('eaten_at', { ascending: false }).limit(200),
        sb.from('diet_symptoms').select('*').order('occurred_at', { ascending: false }).limit(200),
        sb.from('household_recipes').select('*').order('name'),   // read-only; GI tables never write here
    ]);
    state.ingredients = ing.data || [];
    state.meals = meals.data || [];
    state.symptoms = sym.data || [];
    state.recipes = rec.data || [];
    renderAll();
}

// ---------- ingredients ----------
async function addIngredient(name, extra = {}) {
    name = name.trim();
    if (!name) return null;
    const existing = state.ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const { data, error } = await sb.from('diet_ingredients')
        .insert({ name, tags: autoTag(name), ...extra }).select().single();
    if (error) { console.error(error); return null; }
    state.ingredients.push(data);
    state.ingredients.sort((a, b) => a.name.localeCompare(b.name));
    return data;
}

async function updateIngredient(id, patch) {
    const { error } = await sb.from('diet_ingredients').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return console.error(error);
    Object.assign(state.ingredients.find(i => i.id === id), patch);
    renderAll();
}

// Recipe ingredient formats vary; handles array, JSON-ish array, or newline/comma text.
function parseRecipeIngredients(r) {
    const raw = r.ingredients ?? r.ingredient_list ?? '';
    const list = Array.isArray(raw) ? raw : String(raw).split(/\n|,/);
    return list
        .map(s => (typeof s === 'string' ? s : s?.name || ''))
        .map(s => s.replace(/^[\s\-•*\d./]+/, '')                                   // leading qty/bullet
            .replace(/^(cups?|tbsp|tsp|oz|lb|lbs|g|kg|ml|cloves?|cans?)\b\s*(of\s+)?/i, '')
            .replace(/\(.*?\)/g, '').trim())
        .filter(Boolean);
}

async function importRecipe(recipeId) {
    const r = state.recipes.find(x => String(x.id) === String(recipeId));
    if (!r) return;
    for (const name of parseRecipeIngredients(r)) await addIngredient(name, { source_recipe_id: r.id });
    renderAll();
}

function renderIngredients() {
    $('recipeSelect').innerHTML = '<option value="">Import from recipe…</option>' +
        state.recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.title)}</option>`).join('');
    $('ingList').innerHTML = state.ingredients.map(i => `
    <div class="row" data-id="${i.id}">
      <label><input type="checkbox" class="freq" ${i.is_frequent ? 'checked' : ''}> ★</label>
      <strong>${esc(i.name)}</strong>
      <div>${ALL_TAGS.map(t => `<span class="${chipClass(t)} ${i.tags.includes(t) ? 'sel' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
      <button class="del">Delete</button>
    </div>`).join('') || '<p>No ingredients yet.</p>';
}

$('ingList').addEventListener('click', async e => {
    const row = e.target.closest('.row'); if (!row) return;
    const ing = state.ingredients.find(i => i.id === row.dataset.id);
    if (e.target.dataset.tag) {
        const t = e.target.dataset.tag;
        updateIngredient(ing.id, { tags: ing.tags.includes(t) ? ing.tags.filter(x => x !== t) : [...ing.tags, t] });
    } else if (e.target.classList.contains('del')) {
        if (!confirm(`Delete ${ing.name}? It will be removed from logged meals too.`)) return;
        await sb.from('diet_ingredients').delete().eq('id', ing.id);
        state.ingredients = state.ingredients.filter(i => i.id !== ing.id);
        await loadAll();
    }
});
$('ingList').addEventListener('change', e => {
    if (!e.target.classList.contains('freq')) return;
    updateIngredient(e.target.closest('.row').dataset.id, { is_frequent: e.target.checked });
});
$('ingForm').addEventListener('submit', async e => {
    e.preventDefault();
    await addIngredient($('ingName').value, { is_frequent: false });
    $('ingName').value = ''; renderAll();
});
$('recipeImportForm').addEventListener('submit', e => { e.preventDefault(); importRecipe($('recipeSelect').value); });

// ---------- meals ----------
function renderMealPicker() {
    const frequent = state.ingredients.filter(i => i.is_frequent);
    const picked = state.ingredients.filter(i => state.picked.has(i.id) && !i.is_frequent);
    $('mealPicker').innerHTML =
        `<div><small>Frequent / selected (tap to toggle):</small><br>` +
        [...frequent, ...picked].map(i => `<span class="chip ${state.picked.has(i.id) ? 'sel' : ''}" data-id="${i.id}">${esc(i.name)}</span>`).join('') +
        `</div><input id="mealAdd" list="ingOptions" placeholder="Add any ingredient (new ones are created)" style="width:100%">
     <datalist id="ingOptions">${state.ingredients.map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>
     <select id="mealRecipe"><option value="">Add all from recipe…</option>${state.recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.title)}</option>`).join('')}</select>`;
}
$('mealPicker').addEventListener('click', e => {
    const id = e.target.dataset.id; if (!id) return;
    state.picked.has(id) ? state.picked.delete(id) : state.picked.add(id);
    renderMealPicker();
});
$('mealPicker').addEventListener('change', async e => {
    if (e.target.id === 'mealAdd' && e.target.value.trim()) {
        const ing = await addIngredient(e.target.value);
        if (ing) state.picked.add(ing.id);
        renderAll();
    }
    if (e.target.id === 'mealRecipe' && e.target.value) {
        const r = state.recipes.find(x => String(x.id) === e.target.value);
        for (const n of parseRecipeIngredients(r)) { const ing = await addIngredient(n, { source_recipe_id: r.id }); if (ing) state.picked.add(ing.id); }
        if (!$('mealLabel').value) $('mealLabel').value = r.name || r.title || '';
        renderAll();
    }
});
$('mealForm').addEventListener('submit', async e => {
    e.preventDefault();
    const { data: meal, error } = await sb.from('diet_meals').insert({
        eaten_at: new Date($('mealWhen').value).toISOString(),
        label: $('mealLabel').value || null, notes: $('mealNotes').value || null,
    }).select().single();
    if (error) return console.error(error);
    if (state.picked.size)
        await sb.from('diet_meal_ingredients').insert([...state.picked].map(ingredient_id => ({ meal_id: meal.id, ingredient_id })));
    state.picked.clear(); $('mealLabel').value = ''; $('mealNotes').value = '';
    await loadAll();
});
const mealTags = m => {
    const ids = m.diet_meal_ingredients.map(x => x.ingredient_id);
    const ings = ids.map(id => state.ingredients.find(i => i.id === id)).filter(Boolean);
    return { ings, tags: [...new Set(ings.flatMap(i => i.tags))] };
};
const mealHtml = m => {
    const { ings, tags } = mealTags(m);
    return `<div class="row"><strong>${esc(m.label || 'Meal')}</strong> <small>${fmt(m.eaten_at)}</small>
    <div>${ings.map(i => esc(i.name)).join(', ')}</div>
    <div>${tags.map(t => `<span class="${chipClass(t)}">${esc(t)}</span>`).join('')}</div>
    ${m.notes ? `<small>${esc(m.notes)}</small>` : ''}
    <button data-del-meal="${m.id}">Delete</button></div>`;
};
$('mealList').addEventListener('click', async e => {
    const id = e.target.dataset.delMeal; if (!id || !confirm('Delete this meal?')) return;
    await sb.from('diet_meals').delete().eq('id', id); loadAll();
});

// ---------- symptoms ----------
$('symForm').addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await sb.from('diet_symptoms').insert({
        occurred_at: new Date($('symWhen').value).toISOString(),
        symptom: $('symName').value.trim(), severity: +$('symSev').value || null, notes: $('symNotes').value || null,
    });
    if (error) return console.error(error);
    $('symName').value = ''; $('symNotes').value = ''; loadAll();
});
const symHtml = s => `<div class="row"><strong>${esc(s.symptom)}</strong>
  ${s.severity ? `<span class="sev">${s.severity}/10</span>` : ''} <small>${fmt(s.occurred_at)}</small>
  ${s.notes ? `<div><small>${esc(s.notes)}</small></div>` : ''}
  <button data-del-sym="${s.id}">Delete</button></div>`;
$('symList').addEventListener('click', async e => {
    const id = e.target.dataset.delSym; if (!id || !confirm('Delete this symptom?')) return;
    await sb.from('diet_symptoms').delete().eq('id', id); loadAll();
});

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
            return { t, html: symHtml(s).replace(/<button/, hint + '<button') };
        }),
    ].sort((a, b) => b.t - a.t);
    $('timelineList').innerHTML = items.map(i => i.html).join('') || '<p>Nothing logged yet.</p>';
}

// ---------- tabs (hash routed, matching lists.html pattern) ----------
function showTab() {
    const tab = (location.hash || '#timeline').slice(1);
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.hash === '#' + tab));
}
window.addEventListener('hashchange', showTab);

function renderAll() {
    renderIngredients(); renderMealPicker();
    $('mealList').innerHTML = state.meals.map(mealHtml).join('') || '<p>No meals yet.</p>';
    $('symList').innerHTML = state.symptoms.map(symHtml).join('') || '<p>No symptoms yet.</p>';
    renderTimeline();
}

$('mealWhen').value = nowLocal(); $('symWhen').value = nowLocal();
showTab();
loadAll();