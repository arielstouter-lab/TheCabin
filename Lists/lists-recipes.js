// Recipes panel: searchable card list. Each card has an editable notes field
// and an editable URL field with a small "open link" anchor kept in sync.

import { state, sb, saveToLocalCache, requestRender, addIngredientsToGroceries } from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState, focusAtEnd } from '../dom.js';

let recipeSearchQuery = '';

// Blocks javascript: URLs and turns "example.com" into a real external link
// instead of a link relative to this page.
function normalizeUrl(raw){
    const v = (raw || '').trim();
    if(!v) return '';
    return /^https?:\/\//i.test(v) ? v : 'https://' + v;
}

async function saveRecipeField(recipe, field, value){
    if((recipe[field] || '') === value) return;
    recipe[field] = value;
    saveToLocalCache();
    try{
        const { error } = await sb.from('household_recipes').update({ [field]: value }).eq('id', recipe.id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus(`Could not update ${field}.`);
    }
}

function buildIngredientRow(text){
    const row = cloneEl('tpl-recipe-ingredient');
    const r = refs(row);
    r.text.textContent = text;
    r.addBtn.addEventListener('click', () => addIngredientsToGroceries([text]));
    return row;
}

function buildRecipeCard(recipe){
    const card = cloneEl('tpl-recipe-card');
    const r = refs(card);

    r.name.textContent = recipe.name;
    r.addAll.addEventListener('click', () => {
        const list = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
        if(list.length) addIngredientsToGroceries(list);
    });

    // Notes: plain editable text, saved on blur.
    r.notes.textContent = recipe.notes || '';
    r.notes.addEventListener('focusout', () => saveRecipeField(recipe, 'notes', r.notes.textContent.trim()));
    r.notes.addEventListener('keydown', e => {
        if(e.key === 'Enter'){ e.preventDefault(); r.notes.blur(); }
    });
    r.editNotes.addEventListener('click', () => focusAtEnd(r.notes));

    // URL: editable text plus a small link that always reflects the current value.
    r.url.textContent = recipe.url || '';
    const refreshLink = () => {
        const value = r.url.textContent.trim();
        r.urlLink.href = normalizeUrl(value);
        r.urlLink.hidden = !value;
    };
    refreshLink();
    r.url.addEventListener('focusout', () => {
        saveRecipeField(recipe, 'url', r.url.textContent.trim());
        refreshLink();
    });
    r.url.addEventListener('keydown', e => {
        if(e.key === 'Enter'){ e.preventDefault(); r.url.blur(); }
    });
    r.editUrl.addEventListener('click', () => focusAtEnd(r.url));

    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    if(ingredients.length){
        r.ingredients.append(...ingredients.map(buildIngredientRow));
    } else {
        r.ingredients.append(emptyState('No ingredients listed.'));
    }

    return card;
}

export function renderRecipesPanel(sec){
    const frag = cloneFragment('tpl-recipes-panel');
    const r = refs(frag);
    r.title.textContent = sec.name;
    r.search.value = recipeSearchQuery;

    const q = recipeSearchQuery.trim().toLowerCase();
    const filtered = state.recipes.filter(recipe => {
        if(!q) return true;
        const nameMatch = (recipe.name || '').toLowerCase().includes(q);
        const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
        return nameMatch || ingredients.some(ing => ing.toLowerCase().includes(q));
    });

    if(filtered.length){
        r.list.append(...filtered.map(buildRecipeCard));
    } else {
        r.list.append(emptyState(recipeSearchQuery ? 'No recipes match your search.' : 'No recipes found.'));
    }

    r.search.addEventListener('input', () => {
        recipeSearchQuery = r.search.value;
        requestRender();
        // Panel was rebuilt by requestRender — restore focus and cursor position
        // on the new search input.
        const el = document.querySelector('#lst-panel [data-ref="search"]');
        if(el){
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
        }
    });

    return frag;
}