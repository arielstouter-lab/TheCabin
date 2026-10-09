// Recipes panel: searchable card list. Each card has an editable notes field
// and an editable URL field with a small "open link" anchor kept in sync.
// Field edits route through unified state action helpers with offline sync.

import { state, addIngredientsToGroceries, saveRecipeField } from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../SharedJS/dom.js';

let recipeSearchQuery = '';

// Blocks javascript: URLs and turns "example.com" into a real external link
// instead of a link relative to this page.
function normalizeUrl(raw){
    const v = (raw || '').trim();
    if(!v) return '';
    return /^https?:\/\//i.test(v) ? v : 'https://' + v;
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

    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    if(ingredients.length){
        r.ingredients.append(...ingredients.map(buildIngredientRow));
    } else {
        r.ingredients.append(emptyState('No ingredients listed.'));
    }

    return card;
}

function renderRecipeList(listEl, query){
    listEl.replaceChildren();
    const q = (query || '').trim().toLowerCase();
    const filtered = state.recipes.filter(recipe => {
        if(!q) return true;
        const nameMatch = (recipe.name || '').toLowerCase().includes(q);
        const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
        return nameMatch || ingredients.some(ing => ing.toLowerCase().includes(q));
    });

    if(filtered.length){
        listEl.append(...filtered.map(buildRecipeCard));
    } else {
        listEl.append(emptyState(q ? 'No recipes match your search.' : 'No recipes found.'));
    }
}

export function renderRecipesPanel(sec){
    const frag = cloneFragment('tpl-recipes-panel');
    const r = refs(frag);
    r.title.textContent = sec.name;
    r.search.value = recipeSearchQuery;

    renderRecipeList(r.list, recipeSearchQuery);

    r.search.addEventListener('input', () => {
        recipeSearchQuery = r.search.value;
        renderRecipeList(r.list, recipeSearchQuery);
    });

    return frag;
}