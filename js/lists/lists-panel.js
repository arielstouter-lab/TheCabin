// Groceries and user-created tabs. Each has its own template in lists.html:
//  - tpl-groceries-panel: sorts by aisle, remembers aisles per item, always links to "Manage tags"
//  - tpl-custom-panel:    manual sort order unless tags are on, tags toggle, deletable
// Both share the row template (tpl-list-item) and the logic below.
// All mutations route through unified state action helpers with offline sync.

import {
    state, sb, RPC, isGroceries, isPermanent,
    sortItems, sortGroceryItems, aisleIdForItemText,
    createListItem, updateListItem, deleteListItem, deleteListItems,
    deleteSection, updateSectionTagsEnabled,
    personName, dueClass, saveToLocalCache, requestRender
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../shared/dom.js';
import { makeChip, manageHref, fillPersonOptions, setStatus } from './lists-ui.js';

// ---- Row actions ---------------------------------------------------------

async function toggleChecked(sec, id, checked){
    await updateListItem(id, { checked });
    requestRender();
}

async function deleteItem(sec, id){
    await deleteListItem(id);
    requestRender();
}

async function handleDeleteSection(sec){
    if(!confirm('Remove this tab and its items?')) return;

    location.hash = 'groceries';
    try{
        await deleteSection(sec.id);
        requestRender();
    } catch(err){
        console.error(err);
        setStatus('Could not delete tab.');
    }
}

// ---- Row + panel builders ------------------------------------------------

function buildItem(item, index, sec){
    const tagged = isGroceries(sec) || sec.tags_enabled;
    const row = cloneEl('tpl-list-item');
    const r = refs(row);

    row.dataset.index = String(index);      // used by drag-and-drop
    row.dataset.itemRow = item.id;
    row.classList.toggle('priority', !!item.priority);
    row.classList.toggle('checked', !!item.checked);
    if(item.checked || tagged){
        row.removeAttribute('draggable');
        r.handle.remove();
    }

    r.text.textContent = item.text;
    r.checkbox.checked = !!item.checked;

    const chips = [];
    if(item.priority) chips.push(makeChip('High priority', 'priority'));
    if(item.assigned_to && personName(item.assigned_to)) chips.push(makeChip(personName(item.assigned_to), 'assigned'));
    if(item.due_date) chips.push(makeChip(item.due_date, 'due', dueClass(item.due_date)));
    if(tagged && item.aisle_id){
        const aisle = state.groceryAisles.find(a => a.id === item.aisle_id);
        if(aisle) chips.push(makeChip(aisle.name, 'aisle'));
    }
    if(chips.length) r.meta.append(...chips);
    else r.meta.remove();

    r.checkbox.addEventListener('change', () => toggleChecked(sec, item.id, r.checkbox.checked));
    r.del.addEventListener('click', () => deleteItem(sec, item.id));
    return row;
}

async function addItem(sec, r, grocery){
    const text = r.newText.value.trim();
    if(!text) return;

    const existing = state.itemsBySection[sec.id] || [];
    const maxSort = existing.reduce((max, i) => Math.max(max, i.sort_order || 0), 0);

    const basePayload = {
        section_id: sec.id,
        text,
        assigned_to: r.newPerson.value || null,
        due_date: r.newDue.value || null,
        priority: r.newPriority.checked,
        checked: false,
        sort_order: grocery ? null : maxSort + 1,
        aisle_id: (grocery || sec.tags_enabled)
            ? aisleIdForItemText(text)
            : null
    };

    await createListItem(basePayload);
    requestRender();
    const next = document.querySelector('#lst-panel [data-ref="newText"]');
    if(next) next.focus();
}

async function clearCheckedItems(sec){
    const checked = (state.itemsBySection[sec.id] || []).filter(i => i.checked);
    if(!checked.length) return;
    if(!confirm(`Remove ${checked.length} checked item${checked.length === 1 ? '' : 's'}?`)) return;

    const ids = checked.map(i => i.id);
    await deleteListItems(ids);
    requestRender();
}

// Header controls live in the template; this only sets visibility, href and listeners.
// Refs missing from a template (e.g. tagsToggle on the groceries panel) are simply undefined.
function wireHeader(sec, r){
    const grocery = isGroceries(sec);
    const tagged = grocery || sec.tags_enabled;
    const hasChecked = (state.itemsBySection[sec.id] || []).some(i => i.checked);

    r.title.textContent = sec.name;

    r.clearBtn.hidden = !hasChecked;
    r.clearBtn.addEventListener('click', () => clearCheckedItems(sec));

    r.manageLink.hidden = !tagged;
    r.manageLink.href = manageHref(sec);

    if(r.tagsToggle){
        r.tagsToggle.checked = !!sec.tags_enabled;
        r.tagsToggle.addEventListener('change', async () => {
            try{
                await updateSectionTagsEnabled(sec.id, r.tagsToggle.checked);
                requestRender();
            } catch(err){
                console.error(err);
                setStatus('Could not save tags setting.');
            }
        });
    }

    if(r.deleteTab){
        r.deleteTab.hidden = isPermanent(sec);
        r.deleteTab.addEventListener('click', () => handleDeleteSection(sec));
    }
}

// Returns a DocumentFragment; lists.js puts it in the panel.
export function renderListPanel(sec){
    const grocery = isGroceries(sec);
    const tagged = grocery || sec.tags_enabled;
    const frag = cloneFragment(grocery ? 'tpl-groceries-panel' : 'tpl-custom-panel');
    const r = refs(frag);

    wireHeader(sec, r);

    const source = state.itemsBySection[sec.id] || [];
    const items = tagged
        ? sortGroceryItems(source)
        : sortItems(source);
    if(items.length){
        r.items.append(...items.map((item, index) => buildItem(item, index, sec)));
    } else {
        r.items.append(emptyState(r.items.dataset.empty));
    }

    fillPersonOptions(r.newPerson, state.people);

    r.addBtn.addEventListener('click', () => addItem(sec, r, grocery));
    r.newText.addEventListener('keydown', e => {
        if(e.key === 'Enter'){
            e.preventDefault();
            r.addBtn.click();
        }
    });

    return frag;
}

// ---- Drag-and-drop reordering -------------------------------------------
// Not yet routed through the offline queue (it's a single bulk RPC call,
// not a per-row write) — reordering while offline will revert, same as
// any other network failure, same as before this pass.

export async function reorderItems(sectionId, fromIndex, toIndex){
    if(isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

    const previousItems = (state.itemsBySection[sectionId] || []).map(item => ({ ...item }));
    const sec = state.sections.find(s => s.id === sectionId);
    const allItems = isGroceries(sec)
        ? sortGroceryItems(state.itemsBySection[sectionId] || [])
        : sortItems(state.itemsBySection[sectionId] || []);
    const unchecked = allItems.filter(i => !i.checked);
    const checked = allItems.filter(i => i.checked);

    if(fromIndex >= unchecked.length) return;
    const [moved] = unchecked.splice(fromIndex, 1);
    if(!moved) return;

    unchecked.splice(Math.min(toIndex, unchecked.length), 0, moved);
    unchecked.forEach((item, idx) => { item.sort_order = idx + 1; });
    checked.forEach((item, idx) => { item.sort_order = unchecked.length + idx + 1; });

    const orderedItems = [...unchecked, ...checked];
    state.itemsBySection[sectionId] = orderedItems;
    requestRender();

    const token = ++reorderSaveToken;
    try{
        const { error } = await sb.rpc(RPC.UPDATE_LIST_ITEM_ORDER, {
            item_orders: orderedItems.map(item => ({ id: item.id, sort_order: item.sort_order }))
        });
        if(error) throw error;
        saveToLocalCache();
    } catch(err){
        console.error('Failed to save item order:', err);
        if(token === reorderSaveToken){
            state.itemsBySection[sectionId] = previousItems;
            requestRender();
            setStatus('Could not save item order.');
        }
    }
}

let reorderSaveToken = 0;