// Pantry panel: simple list with per-item quantity steppers and
// an "Add to groceries" shortcut. No manual reordering or priority/date fields.

import {
    state, sb, insertListItemWithRetry, saveToLocalCache, requestRender,
    addIngredientsToGroceries, updateItemLocally, removeItemLocally
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../dom.js';

async function deleteItem(id){
    removeItemLocally(id);
    requestRender();
    try{
        const { error } = await sb.from('household_list_items').delete().eq('id', id);
        if(error) throw error;
    } catch(err){
        console.error(err);
        setStatus('Could not remove item.');
    }
}

async function setQuantity(id, qty){
    const updated = updateItemLocally(id, { quantity: qty });
    requestRender();
    if(updated){
        try{
            const { error } = await sb.from('household_list_items').update({ quantity: updated.quantity }).eq('id', id);
            if(error) throw error;
        } catch(err){
            console.error(err);
            setStatus('Could not update quantity.');
        }
    }
}

function buildPantryItem(item){
    const row = cloneEl('tpl-pantry-item');
    const r = refs(row);
    row.dataset.itemRow = item.id;

    r.text.textContent = item.text;
    r.qtyVal.textContent = String(item.quantity ?? 1);

    r.qtyDown.addEventListener('click', () => setQuantity(item.id, Math.max(1, (item.quantity ?? 1) - 1)));
    r.qtyUp.addEventListener('click', () => setQuantity(item.id, Math.max(1, (item.quantity ?? 1) + 1)));
    r.addToGroceries.addEventListener('click', () => addIngredientsToGroceries([item.text]));
    r.del.addEventListener('click', () => deleteItem(item.id));

    return row;
}

export function renderPantryPanel(sec){
    const frag = cloneFragment('tpl-pantry-panel');
    const r = refs(frag);
    r.title.textContent = sec.name;

    const manageBtn = cloneEl('tpl-manage-link');

    manageBtn.href =
        `managegroceries.html?section=${encodeURIComponent(sec.id)}`;

    manageBtn.textContent = 'Manage Tags';

    r.head.append(manageBtn);

    const items = [...(state.itemsBySection[sec.id] || [])];

    const grouped = new Map();

    items.forEach(item => {
        const aisleId = item.aisle_id || 'unassigned';

        if(!grouped.has(aisleId)){
            grouped.set(aisleId, []);
        }

        grouped.get(aisleId).push(item);
    });

    if(!items.length){
        r.items.append(emptyState('Nothing in the pantry yet.'));
    } else {
        grouped.forEach((groupItems, aisleId) => {

            const details = document.createElement('details');
            details.open = true;

            const summary = document.createElement('summary');

            let sectionName = 'Unassigned';

            if(aisleId !== 'unassigned'){
                const aisle = state.groceryAisles.find(
                    a => a.id === aisleId
                );

                if(aisle){
                    sectionName = aisle.name;
                }
            }

            summary.textContent =
                `${sectionName} (${groupItems.length})`;

            details.append(summary);

            groupItems
                .sort((a,b) =>
                    a.created_at < b.created_at ? -1 : 1
                )
                .forEach(item => {
                    details.append(buildPantryItem(item));
                });

            r.items.append(details);
        });
    }


    // The "new item" quantity stepper is local UI state, not saved until Add is clicked.
    let newQty = 1;
    r.newQtyVal.textContent = String(newQty);
    r.newQtyDown.addEventListener('click', () => {
        newQty = Math.max(1, newQty - 1);
        r.newQtyVal.textContent = String(newQty);
    });
    r.newQtyUp.addEventListener('click', () => {
        newQty = Math.max(1, newQty + 1);
        r.newQtyVal.textContent = String(newQty);
    });

    async function addNewItem(){
        const text = r.newText.value.trim();
        if(!text) return;
        const payload = { section_id: sec.id, text, quantity: newQty, checked: false };
        try{
            const data = await insertListItemWithRetry(payload);
            (state.itemsBySection[sec.id] ||= []).push(data);
            saveToLocalCache();
            requestRender();
            const next = document.querySelector('#lst-panel [data-ref="newText"]');
            if(next) next.focus();
        } catch(e){
            setStatus('Could not add pantry item.');
        }
    }

    r.addBtn.addEventListener('click', addNewItem);
    r.newText.addEventListener('keydown', e => {
        if(e.key === 'Enter'){
            e.preventDefault();
            addNewItem();
        }
    });

    return frag;
}