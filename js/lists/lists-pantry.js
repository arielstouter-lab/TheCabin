// Pantry panel: simple list with per-item quantity steppers and
// an "Add to groceries" shortcut. No manual reordering or priority/date fields.
// Mutations route through unified state action helpers with offline sync.

import {
    state, createListItem, updateListItem, deleteListItem,
    requestRender, addIngredientsToGroceries
} from './lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from '../shared/dom.js';
import { fillSlots, bindStepper, manageHref } from './lists-ui.js';
import { openAisleIds, groupByAisle, buildAisleGroup } from './lists-aisles.js';

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
    fillSlots(row);                       // stepper must be in place before refs()
    const r = refs(row);
    row.dataset.itemRow = item.id;

    r.text.textContent = item.text;
    bindStepper(r, () => item.quantity ?? 1, qty => setQuantity(item.id, qty));

    r.addToGroceries.addEventListener('click', () => addIngredientsToGroceries([item.text]));
    r.del.addEventListener('click', () => deleteItem(item.id));

    return row;
}

export function renderPantryPanel(sec){
    const open = openAisleIds();          // remember open aisles across re-renders

    const frag = cloneFragment('tpl-pantry-panel');
    fillSlots(frag);                      // new-item stepper
    const r = refs(frag);

    r.title.textContent = sec.name;
    r.manageLink.href = manageHref(sec);

    const items = state.itemsBySection[sec.id] || [];

    if(!items.length){
        r.items.append(emptyState(r.items.dataset.empty));
    } else {
        r.items.append(...groupByAisle(items).map(({ aisleId, name, items: groupItems }) => {
            const sorted = [...groupItems].sort((a, b) =>
                String(a.text || '').localeCompare(String(b.text || ''))
            );
            return buildAisleGroup(
                aisleId,
                `${name} (${sorted.length})`,
                sorted.map(buildPantryItem),
                open.has(aisleId)
            );
        }));
    }

    // The "new item" stepper is local UI state, not saved until Add is clicked.
    let newQty = 1;
    bindStepper(r, () => newQty, qty => {
        newQty = qty;
        r.stepVal.textContent = String(newQty);
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