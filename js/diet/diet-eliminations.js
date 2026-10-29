// Eliminations tab for the elimination-diet page.
//
// Suggested eliminations live in SUGGESTIONS below (name, typical length, what to avoid). Only what you do with
// them is stored: a row in diet_eliminations keyed by seed_key, created the first time you start, check off or
// add notes to a suggestion. Your own entries are ordinary rows in the same table with no seed_key.
// All markup lives in elimination-diet.html (<template id="tpl-elim-item">); this file only fills it in.

import { bindEvents, cloneEl, refs } from '../shared/dom.js';

// Typical lengths used in elimination diets. `days` is the longest end of the range and drives the countdown.
export const SUGGESTIONS = [
    { key: 'low-fodmap', name: 'Low-FODMAP diet (elimination phase)', label: '2-6 weeks', days: 42, tag: 'high-FODMAP',
      details: 'Garlic, onion, wheat, many beans, some fruits, honey, sweeteners and more. Works best with a dietitian, with groups reintroduced one at a time afterwards.' },
    { key: 'gluten', name: 'Gluten', label: '4-6 weeks', days: 42, tag: 'gluten',
      details: 'Wheat, barley, rye and foods made from them. If celiac disease is possible, get tested before cutting gluten out, because eliminating first can hide the result.' },
    { key: 'dairy', name: 'Dairy (milk proteins)', label: '2-4 weeks', days: 28, tag: 'dairy',
      details: 'Milk, cheese, yogurt, butter, whey, casein and foods made from them. Lactose-free dairy still counts as dairy here.' },
    { key: 'lactose', name: 'Lactose', label: '2 weeks', days: 14, tag: 'lactose',
      details: 'Milk sugar. Compare with the dairy trial to tell lactose apart from milk proteins.' },
    { key: 'onion-garlic', name: 'Onion and garlic', label: '2-4 weeks', days: 28, tag: 'onion/garlic',
      details: 'Onion, garlic, shallots, leeks and scallions, including in sauces, stocks and seasoning mixes.' },
    { key: 'egg', name: 'Egg', label: '2-4 weeks', days: 28, tag: 'egg',
      details: 'Eggs and foods that contain them, such as mayonnaise, baked goods and some pastas.' },
    { key: 'soy', name: 'Soy', label: '2-4 weeks', days: 28, tag: 'soy',
      details: 'Soy sauce, tofu, tempeh, edamame, soy milk and many packaged foods.' },
    { key: 'caffeine', name: 'Caffeine', label: '1-2 weeks', days: 14, tag: 'caffeine',
      details: 'Coffee, tea, chocolate, cola and energy drinks. Cut down gradually to avoid withdrawal headaches.' },
    { key: 'alcohol', name: 'Alcohol', label: '2-4 weeks', days: 28, tag: 'alcohol',
      details: 'Beer, wine and spirits, including in cooking.' },
    { key: 'sweeteners', name: 'Sugar alcohols and artificial sweeteners', label: '2 weeks', days: 14, tag: 'sweetener',
      details: 'Sorbitol, xylitol, mannitol, erythritol, sucralose and aspartame, common in sugar-free gum, candy and drinks.' },
    { key: 'fatty-fried', name: 'Fatty and fried foods', label: '2 weeks', days: 14, tag: 'fatty/fried',
      details: 'Deep-fried foods, bacon, sausage and other greasy or very rich foods.' },
    { key: 'spicy', name: 'Spicy foods', label: '2 weeks', days: 14, tag: 'spicy',
      details: 'Chili, hot sauce, curry and spicy seasonings.' },
    { key: 'carbonated', name: 'Carbonated drinks', label: '2 weeks', days: 14, tag: 'carbonated',
      details: 'Soda, sparkling water, seltzer and tonic.' },
    { key: 'acidic', name: 'Acidic foods', label: '2 weeks', days: 14, tag: 'acidic',
      details: 'Tomato, citrus, vinegar and foods made with them. Mostly relevant for reflux.' },
    { key: 'top-allergens', name: 'Peanut, tree nuts, fish, shellfish, sesame', label: '2-4 weeks', days: 28, tag: null,
      details: 'If you have ever had hives, swelling or trouble breathing after any of these, do not re-test at home. Ask an allergist.' },
];

const PRIORITY_TAGS = new Set(['gluten', 'dairy', 'lactose', 'high-FODMAP', 'sweetener', 'fatty/fried']);
const TABLE = 'diet_eliminations';

let sb = null;
let rows = [];                       // saved rows from diet_eliminations

export const fmtLength = days => !days ? '' : days % 7 === 0 ? `${days / 7} week${days === 7 ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'}`;
const fmtDate = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
const localToday = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const say = msg => { if (window.setStatus) window.setStatus(msg); };

// Suggestions first (in list order), then your own, with anything already tried moved to the bottom.
export function mergeItems(saved) {
    const bySeed = new Map(saved.filter(r => r.seed_key).map(r => [r.seed_key, r]));
    const common = r => ({ id: r.id, started_on: r.started_on || null, tried: !!r.tried, tried_at: r.tried_at || null, notes: r.notes || '' });
    const items = [
        ...SUGGESTIONS.map(s => ({ ...s, ...common(bySeed.get(s.key) || {}), seed: true, id: (bySeed.get(s.key) || {}).id })),
        ...saved.filter(r => !r.seed_key).map(r => ({ key: r.id, seed: false, name: r.name, label: fmtLength(r.length_days),
            days: r.length_days, tag: r.tag || null, details: r.details || '', ...common(r) })),
    ];
    return items.sort((a, b) => a.tried - b.tried);
}

// Short status line under an item: countdown while running, or when it was tried.
export function progressText(it, now = new Date()) {
    if (it.tried) return it.tried_at ? `Tried ${new Date(it.tried_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Tried';
    if (!it.started_on) return '';
    const [y, m, d] = it.started_on.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const day = Math.round((today - start) / 864e5) + 1;
    if (day < 1) return `Starts ${fmtDate(start)}`;
    if (!it.days) return `Started ${fmtDate(start)} (day ${day})`;
    const end = new Date(start); end.setDate(end.getDate() + it.days - 1);
    if (day > it.days) return `Length complete (ended ${fmtDate(end)}). Ready to reintroduce and note what happens.`;
    return `Day ${day} of ${/-/.test(it.label || '') ? 'up to ' : ''}${it.days} \u00b7 ends ${fmtDate(end)}`;
}

function buildRow(it) {
    const row = cloneEl('tpl-elim-item');
    const r = refs(row);
    row.dataset.key = it.key;
    row.dataset.state = it.tried ? 'done' : it.started_on ? 'active' : 'idle';

    r.name.textContent = it.name;
    r.tried.checked = it.tried;
    r.length.textContent = it.label;
    r.length.hidden = !it.label;
    if (it.tag) {
        r.tag.textContent = it.tag;
        if (PRIORITY_TAGS.has(it.tag)) r.tag.dataset.kind = 'priority';
    } else r.tag.remove();
    r.details.textContent = it.details;
    r.details.hidden = !it.details;
    r.progress.textContent = progressText(it);
    r.progress.hidden = !r.progress.textContent;
    if (it.tried) r.start.remove();
    else r.start.textContent = it.started_on ? 'Clear start' : 'Start today';
    if (it.seed) r.del.remove();
    r.notes.textContent = it.notes;
    return row;
}

export function renderEliminations() {
    const list = document.getElementById('elimList');
    if (list) list.replaceChildren(...mergeItems(rows).map(buildRow));
}

export async function loadEliminations() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from(TABLE).select('*').order('created_at');
        if (error) throw error;
        rows = data || [];
    } catch (err) {
        console.error('Could not load eliminations (suggestions still show):', err);
    }
    renderEliminations();
}

// Save a change to one item. Suggestions are upserted by seed_key on first use; your own rows are updated by id.
async function save(it, patch) {
    try {
        const stamped = { ...patch, updated_at: new Date().toISOString() };
        const { data, error } = it.seed
            ? await sb.from(TABLE).upsert({ seed_key: it.key, name: it.name, length_days: it.days, tag: it.tag || null, ...stamped },
                { onConflict: 'seed_key' }).select().single()
            : await sb.from(TABLE).update(stamped).eq('id', it.id).select().single();
        if (error) throw error;
        const i = rows.findIndex(r => r.id === data.id);
        i >= 0 ? (rows[i] = data) : rows.push(data);
        renderEliminations();
    } catch (err) {
        console.error('Could not save elimination:', err);
        say('Could not save: ' + (err.message || err));
        renderEliminations();           // put the checkbox/notes back to what is actually saved
    }
}

const itemFor = el => { const row = el.closest('[data-key]'); return row && mergeItems(rows).find(i => String(i.key) === row.dataset.key); };

export function initEliminations(client) {
    sb = client;
    bindEvents(document, {
        'change #elimList [data-elim-tried]': async (e, box) => {
            const it = itemFor(box); if (!it) return;
            await save(it, { tried: box.checked, tried_at: box.checked ? new Date().toISOString() : null });
        },
        'click #elimList [data-elim-start]': async (e, btn) => {
            const it = itemFor(btn); if (!it) return;
            await save(it, { started_on: it.started_on ? null : localToday() });
        },
        'focusout #elimList [data-elim-notes]': async (e, box) => {
            const it = itemFor(box); if (!it) return;
            const text = box.textContent.trim();
            if (text !== it.notes) await save(it, { notes: text || null });
        },
        'click #elimList [data-elim-del]': async (e, btn) => {
            const it = itemFor(btn); if (!it || it.seed) return;
            if (!confirm(`Delete "${it.name}"?`)) return;
            const { error } = await sb.from(TABLE).delete().eq('id', it.id);
            if (error) { console.error(error); say('Could not delete: ' + error.message); return; }
            rows = rows.filter(r => r.id !== it.id);
            renderEliminations();
        },
        'submit #elimForm': async (e) => {
            e.preventDefault();
            const name = document.getElementById('elimName').value.trim();
            if (!name) return;
            const length = Math.round(+document.getElementById('elimLength').value) || null;
            const { data, error } = await sb.from(TABLE).insert({ name, length_days: length > 0 ? length : null,
                details: document.getElementById('elimDetails').value.trim() || null }).select().single();
            if (error) { console.error(error); say('Could not add: ' + error.message); return; }
            rows.push(data);
            e.target.reset();
            renderEliminations();
        },
    });
}
