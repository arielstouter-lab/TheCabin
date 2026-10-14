import {
    state, sb, loadAll, createSection, createListItem,
    updateListItem, deleteListItem, onStateChange, stopRealtime,
    isStateTrusted
} from './Lists/lists-state.js';
import { cloneFragment, cloneEl, refs, emptyState, bindEvents } from './SharedJS/dom.js';
import { initSync } from './SharedJS/sync.js';
import { syncStatusHandler } from './SharedJS/ui.js';
import { manageHref } from './Lists/lists-ui.js';
import { openAisleIds, groupByAisle, buildAisleGroup } from './Lists/lists-aisles.js';

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

// ---- Row + panel builders ------------------------------------------------

const byText = (a, b) => String(a.text || '').localeCompare(String(b.text || ''));

function buildChecklistItem(item) {
    const row = cloneEl('tpl-list-item');
    const r = refs(row);

    row.dataset.itemRow = item.id;
    row.classList.toggle('checked', !!item.checked);

    r.text.textContent = item.text;
    r.checkbox.checked = !!item.checked;

    return row;
}

function renderMovingPanel(sec) {
    const open = openAisleIds();          // remember open groups across re-renders

    const frag = cloneFragment('tpl-moving-panel');
    const r = refs(frag);

    r.title.textContent = sec.name;
    r.manageLink.href = manageHref(sec, 'moving.html');

    const items = state.itemsBySection[sec.id] || [];

    if (!items.length) {
        r.items.append(emptyState(r.items.dataset.empty));
        return frag;
    }

    // One collapsible group per tag; unchecked items first, then checked, each A-Z.
    r.items.append(...groupByAisle(items).map(({ aisleId, name, items: groupItems }) => {
        const sorted = [
            ...groupItems.filter(i => !i.checked).sort(byText),
            ...groupItems.filter(i => i.checked).sort(byText)
        ];
        const unchecked = sorted.filter(i => !i.checked).length;
        return buildAisleGroup(
            aisleId,
            `${name} (${unchecked}/${sorted.length})`,
            sorted.map(buildChecklistItem),
            open.has(aisleId)
        );
    }));

    return frag;
}

// Add item handler
async function addNewItem() {
    const sec = await ensureMovingSection();
    if (!sec) return;
    const input = document.querySelector('#lst-panel [data-ref="newText"]');
    if (!input) return;
    const text = input.value.trim();
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
    const nextInput = document.querySelector('#lst-panel [data-ref="newText"]');
    if (nextInput) nextInput.focus();
}

bindEvents(document, {
    'change #lst-panel [data-ref="checkbox"]': (e, checkbox) => {
        const row = checkbox.closest('[data-item-row]');
        if (!row) return;
        updateListItem(row.dataset.itemRow, { checked: checkbox.checked }).catch(console.error);
        render();
    },
    'click #lst-panel [data-ref="del"]': (e, btn) => {
        const row = btn.closest('[data-item-row]');
        if (!row) return;
        deleteListItem(row.dataset.itemRow).catch(console.error);
        render();
    },
    'click #lst-panel [data-ref="addBtn"]': () => addNewItem(),
    'keydown #lst-panel [data-ref="newText"]': (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addNewItem();
        }
    }
});

async function render() {
    const panelEl = document.getElementById('lst-panel');
    if (!panelEl) return;

    const sec = await ensureMovingSection();
    if (!sec) {
        // First-ever load with no signal and nothing cached yet.
        panelEl.replaceChildren(emptyState(panelEl.dataset.offlineEmpty));
        return;
    }

    panelEl.replaceChildren(renderMovingPanel(sec));
}

onStateChange(render);
window.addEventListener('beforeunload', stopRealtime);

window.addEventListener('pageshow', () => {
    if (sessionStorage.getItem('reloadOnReturn')) {
        sessionStorage.removeItem('reloadOnReturn');
        location.reload();
    }
});

// After offline edits sync, lists-state re-pulls automatically ('sync:flushed').
initSync(sb, { onChange: syncStatusHandler() });

async function init() {
    await loadAll();   // renders cached data first, then the fresh copy
    render();
}

if (window.initAppPage) {
    window.initAppPage(init);
} else {
    document.addEventListener('app:ready', init, { once: true });
}