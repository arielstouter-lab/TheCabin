// "Convert old entries" card on the Symptoms tab.
//
// Symptoms used to have one 1-10 severity. They now have pain (negative symptoms) and urgency (bowel movements).
// The SQL update moves stomach pain entries to pain automatically. Everything else that still has an old severity
// shows up here so you can decide, entry by entry, whether that number was pain, urgency, or should be discarded.
// Markup lives in elimination-diet.html (#convertCard and <template id="tpl-convert-item">).

import { bindEvents, cloneEl, refs } from '../shared/dom.js';

// Keep in sync with BRISTOL_RE in diet-main.js: this is what counts as a bowel movement entry.
const BM_RE = /diarrh|loose|stool|bowel|constip|\bbm\b|poop|toilet/i;
export const isBowelMovement = s => s.bristol != null || BM_RE.test(s.symptom || '');

// Still carries the old severity and hasn't been given a pain or urgency yet. Positive entries that aren't bowel
// movements have nowhere to put a number, so they are left alone (the old value just stays unused in the database).
export const needsConversion = s =>
    s.severity != null && s.pain == null && s.urgency == null && (!s.positive || isBowelMovement(s));

let current = new Map();            // id -> entry, for the entries shown right now
const say = msg => { if (window.setStatus) window.setStatus(msg); };

function buildRow(s) {
    const row = cloneEl('tpl-convert-item');
    const r = refs(row);
    row.dataset.id = s.id;
    r.name.textContent = s.symptom;
    r.when.textContent = new Date(s.occurred_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    r.old.textContent = `old severity ${s.severity}/10`;
    if (s.bristol != null) r.bristol.textContent = `Bristol ${s.bristol}`; else r.bristol.remove();
    if (!isBowelMovement(s)) r.urgency.remove();     // urgency only applies to bowel movements
    if (s.positive) r.pain.remove();                  // pain only applies to negative symptoms
    return row;
}

export function renderConversion(state) {
    const card = document.getElementById('convertCard'), list = document.getElementById('convertList');
    if (!card || !list) return;
    const todo = state.symptoms.filter(needsConversion);
    current = new Map(todo.map(s => [s.id, s]));
    card.hidden = !todo.length;
    document.getElementById('convertNote').textContent =
        `${todo.length} left. For each one, choose what the old severity number meant, or discard it.`;
    list.replaceChildren(...todo.map(buildRow));
}

// reload: async function that reloads the page's data (and so re-renders this card)
export function initConversion(sb, reload) {
    bindEvents(document, {
        'click #convertList [data-convert]': async (e, btn) => {
            const row = btn.closest('[data-id]');
            const entry = row && current.get(row.dataset.id);
            if (!entry) return;
            const action = btn.dataset.convert;
            const patch = { severity: null, updated_at: new Date().toISOString() };
            if (action === 'urgency') patch.urgency = entry.severity;
            if (action === 'pain') patch.pain = entry.severity;
            btn.disabled = true;
            try {
                const { error } = await sb.from('diet_symptoms').update(patch).eq('id', entry.id);
                if (error) throw error;
                await reload();
            } catch (err) {
                console.error('Could not convert entry:', err);
                say('Could not convert: ' + (err.message || err));
                btn.disabled = false;
            }
        },
    });
}
