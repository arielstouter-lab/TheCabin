import {
    state, sb, loadAll, createSection, createListItem,
    updateListItem, deleteListItem, onStateChange, stopRealtime,
    isStateTrusted
} from './Lists/lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState } from './SharedJS/dom.js';
import { initSync } from './SharedJS/sync.js';

const SECTION_NAME = 'Moving';

let movingSection = null;
let sectionPromise = null;

function findMovingSection() {
    return state.sections.find(s => s.name.toLowerCase() === SECTION_NAME.toLowerCase()) || null;
}

// Finds the Moving section, creating it only when we're sure it doesn't exist.
// Until state has loaded (from the server or the local cache) an empty section
// list means "unknown", and creating a section then would duplicate the real one.
// The shared promise stops concurrent renders from creating it twice.
function ensureMovingSection() {
    if (movingSection) return Promise.resolve(movingSection);

    const found = findMovingSection();
    if (found) return Promise.resolve((movingSection = found));

    if (!isStateTrusted()) return Promise.resolve(null);

    sectionPromise ||= createSection(SECTION_NAME)
        .then(sec => (movingSection = sec))
        .finally(() => { sectionPromise = null; });
    return sectionPromise;
}

function buildChecklistItem(item) {
    const row = cloneEl('tpl-list-item');
    const r = refs(row);

    row.dataset.itemRow = item.id;
    row.classList.toggle('checked', !!item.checked);

    r.text.textContent = item.text;
    r.checkbox.checked = !!item.checked;

    // Local state changes synchronously inside updateListItem/deleteListItem,
    // so render right away instead of waiting on the network.
    r.checkbox.addEventListener('change', () => {
        updateListItem(item.id, { checked: r.checkbox.checked }).catch(console.error);
        render();
    });

    r.del.addEventListener('click', () => {
        deleteListItem(item.id).catch(console.error);
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

        // The item is in local state the moment this call starts; the network
        // write happens in the background (and is queued if there's no signal).
        createListItem({
            section_id: sec.id,
            text,
            checked: false
        }).catch(console.error);

        await render();

        // Keep the keyboard open so several items can be added in a row.
        const input = document.querySelector('#lst-panel [data-ref="newText"]');
        if (input) input.focus();
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

async function render() {
    const panelEl = document.getElementById('lst-panel');
    if (!panelEl) return;

    const sec = await ensureMovingSection();
    if (!sec) {
        // First-ever load with no signal and nothing cached yet.
        panelEl.replaceChildren(emptyState('Connect once to download your list — after that it works offline.'));
        return;
    }

    panelEl.replaceChildren(renderGroupedListPanel(sec));
}

onStateChange(render);
window.addEventListener('beforeunload', stopRealtime);

initSync(sb, {
    onChange: n => {
        if (window.setStatus) {
            window.setStatus(n ? `${n} change${n === 1 ? '' : 's'} pending sync…` : '');
        }
    }
    // After offline edits sync, lists-state re-pulls automatically ('sync:flushed').
});

async function init() {
    await loadAll();   // renders cached data first, then the fresh copy
    render();
}

if (window.initAppPage) {
    window.initAppPage(init);
} else {
    document.addEventListener('app:ready', init, { once: true });
}