// Groceries and user-created tabs share this panel. The only differences:
//  - Groceries sorts by aisle, remembers aisles per item, and links to "Manage groceries"
//  - Custom tabs use manual sort order and can be deleted

import {
    state, sb, isGroceries, isPermanent,
    sortItems, sortGroceryItems, aisleIdForItemText, insertListItemWithRetry,
    personName, dueClass, removeItemLocally, updateItemLocally,
    saveToLocalCache, requestRender
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from './lists-dom.js';

function makeChip(text, extraClass){
    const chip = cloneEl('tpl-chip');
    chip.textContent = text;
    if(extraClass) chip.classList.add(extraClass);
    return chip;
}

// ---- Row actions ---------------------------------------------------------

async function toggleChecked(id, checked){
    updateItemLocally(id, { checked });
    requestRender();
    try{
        const { error } = await sb.from('household_list_items').update({ checked }).eq('id', id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not update item.');
    }
}

async function deleteItem(id){
    removeItemLocally(id);
    requestRender();
    try{
        const { error } = await sb.from('household_list_items').delete().eq('id', id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not delete item.');
    }
}

async function deleteSection(sec){
    if(!confirm('Remove this tab and its items?')) return;

    state.sections = state.sections.filter(s => s.id !== sec.id);
    delete state.itemsBySection[sec.id];
    saveToLocalCache();
    location.hash = 'groceries';
    requestRender();

    try{
        const { error } = await sb.from('household_list_sections').delete().eq('id', sec.id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not delete tab.');
    }
}

// ---- Row + panel builders ------------------------------------------------

function buildItem(item, index, grocery){
    const row = cloneEl('tpl-list-item');
    const r = refs(row);

    row.dataset.index = String(index);      // used by drag-and-drop
    row.dataset.itemRow = item.id;
    row.classList.toggle('priority', !!item.priority);
    row.classList.toggle('checked', !!item.checked);
    if(item.checked){
        row.removeAttribute('draggable');
        r.handle.remove();
    }

    r.text.textContent = item.text;
    r.checkbox.checked = !!item.checked;

    const chips = [];
    if(item.priority) chips.push(makeChip('High priority', 'priority-chip'));
    if(item.assigned_to && personName(item.assigned_to)) chips.push(makeChip(personName(item.assigned_to)));
    if(item.due_date) chips.push(makeChip(item.due_date, dueClass(item.due_date)));
    if(grocery && item.aisle_id){
        const aisle = state.groceryAisles.find(a => a.id === item.aisle_id);
        if(aisle) chips.push(makeChip(aisle.name, 'aisle-chip'));
    }
    if(chips.length) r.meta.append(...chips);
    else r.meta.remove();

    r.checkbox.addEventListener('change', () => toggleChecked(item.id, r.checkbox.checked));
    r.del.addEventListener('click', () => deleteItem(item.id));
    return row;
}

async function addItem(sec, r, grocery){
    const text = r.newText.value.trim();
    if(!text) return;

    const existing = state.itemsBySection[sec.id] || [];
    const maxSort = existing.reduce((max, i) => Math.max(max, i.sort_order || 0), 0);

    const payload = {
        section_id: sec.id,
        text,
        assigned_to: r.newPerson.value || null,
        due_date: r.newDue.value || null,
        priority: r.newPriority.checked,
        checked: false,
        sort_order: grocery ? null : maxSort + 1,
        aisle_id: grocery ? aisleIdForItemText(text) : null
    };

    try{
        const data = await insertListItemWithRetry(payload);
        (state.itemsBySection[sec.id] ||= []).push(data);
        saveToLocalCache();
        requestRender();
        const next = document.querySelector('#lst-panel [data-ref="newText"]');
        if(next) next.focus();
    } catch(e){
        setStatus('Could not add item.');
    }
}

// Returns a DocumentFragment; main.js puts it in the panel.
export function renderListPanel(sec){
    const grocery = isGroceries(sec);
    const frag = cloneFragment('tpl-list-panel');
    const r = refs(frag);

    r.title.textContent = sec.name;

    if(grocery){
        r.head.append(cloneEl('tpl-manage-link'));
    } else if(!isPermanent(sec)){
        const delBtn = cloneEl('tpl-delete-tab');
        delBtn.addEventListener('click', () => deleteSection(sec));
        r.head.append(delBtn);
    }

    const source = state.itemsBySection[sec.id] || [];
    const items = grocery ? sortGroceryItems(source) : sortItems(source);
    if(items.length){
        r.items.append(...items.map((item, index) => buildItem(item, index, grocery)));
    } else {
        r.items.append(emptyState('Nothing here yet.'));
    }

    state.people.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        r.newPerson.append(opt);
    });

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
        const { error } = await sb.rpc('update_list_item_order', {
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