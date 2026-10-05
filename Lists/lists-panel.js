// Groceries and user-created tabs share this panel. The only differences:
//  - Groceries sorts by aisle, remembers aisles per item, and links to "Manage groceries"
//  - Custom tabs use manual sort order and can be deleted
//  - Groceries writes go through the offline sync queue (writeOrQueue); custom
//    tabs still write directly, since offline support is scoped to Groceries for now.

import {
    state, sb, TABLES, RPC, isGroceries, isPermanent,
    sortItems, sortGroceryItems, aisleIdForItemText, insertListItemWithRetry,
    personName, dueClass, removeItemLocally, updateItemLocally,
    saveToLocalCache, requestRender
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../dom.js';
import { writeOrQueue, nowStamp } from '../sync.js';

function makeChip(text, extraClass){
    const chip = cloneEl('tpl-chip');
    chip.textContent = text;
    if(extraClass) chip.classList.add(extraClass);
    return chip;
}

// ---- Row actions ---------------------------------------------------------

async function toggleChecked(sec, id, checked){
    const grocery = isGroceries(sec);
    const patch = grocery ? { checked, updated_at: nowStamp() } : { checked };
    updateItemLocally(id, patch);
    requestRender();

    if(grocery){
        await writeOrQueue(sb, { table: TABLES.LIST_ITEMS, type: 'update', id, payload: patch });
        return;
    }

    try{
        const { error } = await sb.from(TABLES.LIST_ITEMS).update(patch).eq('id', id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not update item.');
    }
}

async function deleteItem(sec, id){
    removeItemLocally(id);
    requestRender();

    if(isGroceries(sec)){
        await writeOrQueue(sb, { table: TABLES.LIST_ITEMS, type: 'delete', id });
        return;
    }

    try{
        const { error } = await sb.from(TABLES.LIST_ITEMS).delete().eq('id', id);
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
        const { error } = await sb.from(TABLES.LIST_SECTIONS).delete().eq('id', sec.id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not delete tab.');
    }
}

// ---- Row + panel builders ------------------------------------------------

function buildItem(item, index, sec){
    const grocery = isGroceries(sec);
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
    if((grocery || sec.tags_enabled) && item.aisle_id){
        const aisle = state.groceryAisles.find(a => a.id === item.aisle_id);
        if(aisle) chips.push(makeChip(aisle.name, 'aisle-chip'));
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

    if(grocery){
        // Create the row locally with a client-generated id so it shows up
        // immediately even offline; the same id is sent with the queued
        // insert, so the eventual server row lines up with this one rather
        // than creating a duplicate when the queue flushes.
        const id = crypto.randomUUID();
        const updated_at = nowStamp();
        const localItem = { id, ...basePayload, updated_at, created_at: updated_at };

        (state.itemsBySection[sec.id] ||= []).push(localItem);
        saveToLocalCache();
        requestRender();
        const next = document.querySelector('#lst-panel [data-ref="newText"]');
        if(next) next.focus();

        await writeOrQueue(sb, {
            table: TABLES.LIST_ITEMS, type: 'insert', id,
            payload: { id, ...basePayload, updated_at }
        });
        return;
    }

    try{
        const data = await insertListItemWithRetry(basePayload);
        (state.itemsBySection[sec.id] ||= []).push(data);
        saveToLocalCache();
        requestRender();
        const next = document.querySelector('#lst-panel [data-ref="newText"]');
        if(next) next.focus();
    } catch(e){
        setStatus('Could not add item.');
    }
}

async function clearCheckedItems(sec){
    const checked = (state.itemsBySection[sec.id] || []).filter(i => i.checked);
    if(!checked.length) return;
    if(!confirm(`Remove ${checked.length} checked item${checked.length === 1 ? '' : 's'}?`)) return;

    const ids = checked.map(i => i.id);
    state.itemsBySection[sec.id] = (state.itemsBySection[sec.id] || []).filter(i => !i.checked);
    saveToLocalCache();
    requestRender();

    if(isGroceries(sec)){
        await Promise.all(ids.map(id => writeOrQueue(sb, { table: TABLES.LIST_ITEMS, type: 'delete', id })));
        return;
    }

    try{
        const { error } = await sb.from(TABLES.LIST_ITEMS).delete().in('id', ids);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not clear checked items.');
    }
}

// Returns a DocumentFragment; main.js puts it in the panel.
export function renderListPanel(sec){
    const grocery = isGroceries(sec);
    const tagged = grocery || sec.tags_enabled;
    const frag = cloneFragment('tpl-list-panel');
    const r = refs(frag);

    r.title.textContent = sec.name;

    const hasChecked = (state.itemsBySection[sec.id] || []).some(i => i.checked);
    if(hasChecked){
        const clearBtn = cloneEl('tpl-clear-checked');
        clearBtn.addEventListener('click', () => clearCheckedItems(sec));
        r.head.append(clearBtn);
    }

    buildTagsControls(r.head, sec);

    if(!isPermanent(sec)){
        const delBtn = cloneEl('tpl-delete-tab');
        delBtn.addEventListener('click', () => deleteSection(sec));
        r.head.append(delBtn);
    }

    const source = state.itemsBySection[sec.id] || [];
    const items = tagged
        ? sortGroceryItems(source)
        : sortItems(source);
    if(items.length){
        r.items.append(...items.map((item, index) => buildItem(item, index, sec)));
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

//Manage toggle function
export function buildTagsControls(container, sec){
    if(!sec && container){
        sec = container;
        container = null;
    }
    const wrap = container || document.createDocumentFragment();

    if(isGroceries(sec)){
        const manageBtn = cloneEl('tpl-manage-link');
        manageBtn.href = `managegroceries.html?section=${encodeURIComponent(sec.id)}`;
        wrap.append(manageBtn);
        return wrap;
    }

    const toggleWrap = cloneEl('tpl-tags-toggle');
    const toggle = refs(toggleWrap).toggle;

    toggle.checked = !!sec.tags_enabled;

    toggle.addEventListener('change', async () => {
        try{
            const enabled = toggle.checked;

            const { error } = await sb
                .from(TABLES.LIST_SECTIONS)
                .update({ tags_enabled: enabled })
                .eq('id', sec.id);

            if(error) throw error;

            sec.tags_enabled = enabled;
            requestRender();
        }catch(err){
            console.error(err);
            setStatus('Could not save tags setting.');
        }
    });

    wrap.append(toggleWrap);

    if(sec.tags_enabled){
        const manageBtn = cloneEl('tpl-manage-link');
        manageBtn.href = `managegroceries.html?section=${encodeURIComponent(sec.id)}`;
        wrap.append(manageBtn);
    }

    return wrap;
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
