// Aisle/tag grouping shared by the Pantry and Moving pages:
// items are grouped by aisle_id, groups follow the aisle sort order, and each
// group is a collapsible <details> built from <template id="tpl-aisle-group">.

import { state } from './lists-state.js';
import { cloneEl, refs } from '../shared/dom.js';

// Aisle ids of the groups that are currently open, so a re-render can restore them.
export function openAisleIds(){
    const open = new Set();
    document.querySelectorAll('#lst-panel details[data-aisle-id]').forEach(d => {
        if(d.open) open.add(d.dataset.aisleId);
    });
    return open;
}

// -> [{ aisleId, name, items }] sorted by aisle sort_order, then name; 'unassigned' last.
export function groupByAisle(items){
    const grouped = new Map();
    items.forEach(item => {
        const aisleId = item.aisle_id || 'unassigned';
        if(!grouped.has(aisleId)) grouped.set(aisleId, []);
        grouped.get(aisleId).push(item);
    });

    return Array.from(grouped, ([aisleId, groupItems]) => {
        const aisle = aisleId === 'unassigned' ? null : state.groceryAisles.find(a => a.id === aisleId);
        return {
            aisleId,
            name: aisle ? aisle.name : 'Unassigned',
            order: aisle ? (aisle.sort_order ?? 9999) : 9999,
            items: groupItems
        };
    }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function buildAisleGroup(aisleId, summaryText, rows, isOpen){
    const group = cloneEl('tpl-aisle-group');
    const g = refs(group);

    group.dataset.aisleId = aisleId;
    group.open = isOpen;
    g.summary.textContent = summaryText;
    group.append(...rows);
    return group;
}