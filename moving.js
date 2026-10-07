import {
    state, sb, loadAll, createSection, createListItem,
    updateListItem, deleteListItem, onStateChange, stopRealtime
} from './Lists/lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from './SharedJS/dom.js';
import { initSync } from './SharedJS/sync.js';

const SECTION_NAME = 'Moving';

async function getOrCreateMovingSection() {
    let sec = state.sections.find(s => s.name.toLowerCase() === SECTION_NAME.toLowerCase());
    if (!sec) {
        sec = await createSection(SECTION_NAME);
    }
    return sec;
}

function buildChecklistItem(item) {
    const row = cloneEl('tpl-list-item');
    const r = refs(row);

    row.dataset.itemRow = item.id;
    row.classList.toggle('checked', !!item.checked);

    r.text.textContent = item.text;
    r.checkbox.checked = !!item.checked;

    r.checkbox.addEventListener('change', async () => {
        await updateListItem(item.id, { checked: r.checkbox.checked });
        render();
    });

    r.del.addEventListener('click', async () => {
        await deleteListItem(item.id);
        render();
    });

    return row;
}

function renderGroupedListPanel(sec) {
    const frag = cloneFragment('tpl-list-panel');
    const r = refs(frag);
    r.title.textContent = sec.name;

    const manageBtn = cloneEl('tpl-manage-link');
    manageBtn.href = `managegroceries.html?section=${encodeURIComponent(sec.id)}`;
    r.head.append(manageBtn);

    const items = [...(state.itemsBySection[sec.id] || [])];

    if (!items.length) {
        r.items.append(emptyState('No moving items yet.'));
    } else {
        // Group items by tag/aisle
        const grouped = new Map();
        items.forEach(item => {
            const aisleId = item.aisle_id || 'unassigned';
            if (!grouped.has(aisleId)) grouped.set(aisleId, []);
            grouped.get(aisleId).push(item);
        });

        // Sort groups matching aisle sort order
        const sortedGroups = Array.from(grouped.entries()).sort(([idA], [idB]) => {
            const aisleA = idA === 'unassigned' ? null : state.groceryAisles.find(a => a.id === idA);
            const aisleB = idB === 'unassigned' ? null : state.groceryAisles.find(a => a.id === idB);
            const sortA = aisleA ? (aisleA.sort_order ?? 9999) : 9999;
            const sortB = aisleB ? (aisleB.sort_order ?? 9999) : 9999;
            if (sortA !== sortB) return sortA - sortB;
            const nameA = aisleA ? aisleA.name : 'Unassigned';
            const nameB = aisleB ? aisleB.name : 'Unassigned';
            return nameA.localeCompare(nameB);
        });

        // Render each collapsible section with checkbox items
        sortedGroups.forEach(([aisleId, groupItems]) => {
            const details = document.createElement('details');

            const summary = document.createElement('summary');
            let tagName = 'Unassigned';
            if (aisleId !== 'unassigned') {
                const aisle = state.groceryAisles.find(a => a.id === aisleId);
                if (aisle) tagName = aisle.name;
            }

            const uncheckedCount = groupItems.filter(i => !i.checked).length;
            summary.textContent = `${tagName} (${uncheckedCount}/${groupItems.length})`;

            details.append(summary);

            groupItems.forEach(item => {
                details.append(buildChecklistItem(item));
            });

            r.items.append(details);
        });
    }

    // Add item handler
    async function addNewItem() {
        const text = r.newText.value.trim();
        if (!text) return;
        await createListItem({
            section_id: sec.id,
            text,
            checked: false
        });
        render();
    }

    r.addBtn.addEventListener('click', addNewItem);
    r.newText.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addNewItem();
        }
    });

    return frag;
}

let movingSection = null;

async function render() {
    const panelEl = document.getElementById('lst-panel');
    if (!panelEl) return;
    if (!movingSection) movingSection = await getOrCreateMovingSection();
    if (!movingSection) return;

    panelEl.replaceChildren(renderGroupedListPanel(movingSection));
}

onStateChange(render);
window.addEventListener('beforeunload', stopRealtime);

initSync(sb, {
    onChange: n => {
        if (window.setStatus) {
            window.setStatus(n ? `${n} change${n === 1 ? '' : 's'} pending sync…` : '');
        }
    }
});

async function init() {
    await loadAll();
    movingSection = await getOrCreateMovingSection();
    render();
}

if (window.initAppPage) {
    window.initAppPage(init);
} else {
    document.addEventListener('app:ready', init, { once: true });
}