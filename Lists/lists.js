// Entry point. Owns tabs and hash-based routing; delegates each panel's
// markup and behavior to lists-panel.js / lists-pantry.js / lists-recipes.js.

import {
    state, sb, loadAll, orderedSections, sectionSlug, findSectionBySlug,
    isPantry, isRecipes, isGroceries, createSection, onStateChange, stopRealtime
} from './lists-state.js';
import { cloneEl, refs, emptyState } from '../dom.js';
import { renderListPanel, reorderItems } from './lists-panel.js';
import { renderPantryPanel } from './lists-pantry.js';
import { renderRecipesPanel } from './lists-recipes.js';
import { initSync } from '../sync.js';

let activeSlug = null;

function currentSection(){
    const fromHash = location.hash.slice(1);
    if(fromHash){
        const sec = findSectionBySlug(decodeURIComponent(fromHash));
        if(sec) return sec;
    }
    return state.sections.find(isGroceries) || state.sections[0] || null;
}

function renderTabs(){
    const tabsEl = document.getElementById('lst-tabs');
    tabsEl.replaceChildren();
    orderedSections().forEach(sec => {
        const btn = cloneEl('tpl-tab');
        const r = refs(btn);
        r.label.textContent = sec.name;
        const slug = sectionSlug(sec);
        btn.classList.toggle('active', slug === activeSlug);
        btn.addEventListener('click', () => { location.hash = slug; });
        tabsEl.append(btn);
    });
}

function renderPanel(){
    const panelEl = document.getElementById('lst-panel');
    const sec = currentSection();
    panelEl.replaceChildren();

    if(!sec){
        activeSlug = null;
        panelEl.append(emptyState('No tabs yet — add one above.'));
        renderTabs();
        return;
    }

    activeSlug = sectionSlug(sec);

    const frag = isPantry(sec) ? renderPantryPanel(sec)
        : isRecipes(sec) ? renderRecipesPanel(sec)
            : renderListPanel(sec); // handles both Groceries and custom tabs

    panelEl.append(frag);
    renderTabs();
}

onStateChange(renderPanel);
window.addEventListener('hashchange', renderPanel);

document.getElementById('lst-add-section').addEventListener('click', async () => {
    const input = document.getElementById('lst-new-section-name');
    const name = input.value.trim();
    if(!name) return;
    try{
        const data = await createSection(name);
        input.value = '';
        location.hash = sectionSlug(data); // custom tabs are keyed by id, not name
    } catch(e){
        setStatus(e.message || 'Could not add tab.');
    }
});

const panelEl = document.getElementById('lst-panel');
window.initDragAndDrop(panelEl, {
    canDrag: el => !el.classList.contains('checked'),
    onReorder: (fromIndex, toIndex) => {
        const sec = currentSection();
        if(sec && !isPantry(sec) && !isRecipes(sec)){
            reorderItems(sec.id, fromIndex, toIndex);
        }
    }
});

window.addEventListener('beforeunload', stopRealtime);

// Grocery writes that fail (or happen while offline) are queued and retried
// automatically on reconnect; this surfaces how many are still waiting.
initSync(sb, {
    onChange: n => setStatus(n ? `${n} change${n === 1 ? '' : 's'} pending sync…` : '')
});

if(window.initAppPage){
    window.initAppPage(loadAll);
} else {
    document.addEventListener('app:ready', loadAll, { once: true });
}
