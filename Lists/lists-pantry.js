// Pantry panel: simple list with per-item quantity steppers and
// an "Add to groceries" shortcut. No manual reordering or priority/date fields.
// Writes go through the offline sync queue, same as the Groceries/custom-tab panel.

import {
    state, sb, insertListItemWithRetry, saveToLocalCache, requestRender,
    addIngredientsToGroceries, updateItemLocally, removeItemLocally
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../dom.js';
import { writeOrQueue, nowStamp } from '../sync.js';

async function deleteItem(id){
    removeItemLocally(id);
    requestRender();
    await writeOrQueue(sb, { table: 'household_list_items', type: 'delete', id });
}

async function setQuantity(id, qty){
    const patch = { quantity: qty, updated_at: nowStamp() };
    const updated = updateItemLocally(id, patch);
    requestRender();
    if(updated){
        await writeOrQueue(sb, { table: 'household_list_items', type: 'update', id, payload: patch });
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

        const id = crypto.randomUUID();
        const updated_at = nowStamp();
        const basePayload = { section_id: sec.id, text, quantity: newQty, checked: false };
        const localItem = { id, ...basePayload, updated_at, created_at: updated_at };

        (state.itemsBySection[sec.id] ||= []).push(localItem);
        saveToLocalCache();
        requestRender();
        const next = document.querySelector('#lst-panel [data-ref="newText"]');
        if(next) next.focus();

        await writeOrQueue(sb, {
            table: 'household_list_items', type: 'insert', id,
            payload: { id, ...basePayload, updated_at }
        });
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