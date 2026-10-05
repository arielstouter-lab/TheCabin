// Pantry panel: simple list with per-item quantity steppers and
// an "Add to groceries" shortcut. No manual reordering or priority/date fields.
// Mutations route through unified state action helpers with offline sync.

import {
    state, createListItem, updateListItem, deleteListItem,
    requestRender, addIngredientsToGroceries
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../dom.js';

async function deleteItem(id){
    await deleteListItem(id);
    requestRender();
}

async function setQuantity(id, qty){
    await updateListItem(id, { quantity: qty });
    requestRender();
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
        const sortedGroups = Array.from(grouped.entries()).sort(([aisleIdA], [aisleIdB]) => {
            const aisleA = aisleIdA === 'unassigned' ? null : state.groceryAisles.find(a => a.id === aisleIdA);
            const aisleB = aisleIdB === 'unassigned' ? null : state.groceryAisles.find(a => a.id === aisleIdB);
            const sortA = aisleA ? (aisleA.sort_order ?? 9999) : 9999;
            const sortB = aisleB ? (aisleB.sort_order ?? 9999) : 9999;
            if(sortA !== sortB) return sortA - sortB;
            const nameA = aisleA ? aisleA.name : 'Unassigned';
            const nameB = aisleB ? aisleB.name : 'Unassigned';
            return nameA.localeCompare(nameB);
        });

        sortedGroups.forEach(([aisleId, groupItems]) => {
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

        await createListItem({
            section_id: sec.id,
            text,
            quantity: newQty,
            checked: false
        });
        requestRender();
        const next = document.querySelector('#lst-panel [data-ref="newText"]');
        if(next) next.focus();
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