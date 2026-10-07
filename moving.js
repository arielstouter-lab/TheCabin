import {
    state, sb, loadAll, createSection, onStateChange, stopRealtime
} from './Lists/lists-state.js';
import { renderListPanel } from './Lists/lists-panel.js';
import { initSync } from './SharedJS/sync.js';

const SECTION_NAME = 'Moving';

async function getOrCreateMovingSection() {
    let sec = state.sections.find(s => s.name.toLowerCase() === SECTION_NAME.toLowerCase());
    if (!sec) {
        sec = await createSection(SECTION_NAME);
    }
    return sec;
}

let movingSection = null;

async function render() {
    const panelEl = document.getElementById('lst-panel');
    if (!panelEl || !movingSection) return;
    panelEl.replaceChildren(renderPantryPanel(movingSection));
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