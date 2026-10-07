import {
    state, sb, loadAll, createSection, onStateChange, stopRealtime
} from './Lists/lists-state.js';
import { renderPantryPanel } from './Lists/lists-pantry.js';
import { initSync } from './SharedJS/sync.js';

const SECTION_NAME = 'Moving';

async function getOrCreateMovingSection() {
    let sec = state.sections.find(s => s.name.toLowerCase() === SECTION_NAME.toLowerCase());
    if (!sec) {
        sec = await createSection(SECTION_NAME);
    }
    return sec;
}

async function render() {
    const panelEl = document.getElementById('lst-panel');
    if (!panelEl) return;

    const sec = await getOrCreateMovingSection();
    if (!sec) return;

    panelEl.replaceChildren(renderPantryPanel(sec));
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

if (window.initAppPage) {
    window.initAppPage(async () => {
        await loadAll();
        await render();
    });
} else {
    document.addEventListener('app:ready', async () => {
        await loadAll();
        await render();
    }, { once: true });
}