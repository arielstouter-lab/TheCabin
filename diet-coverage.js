// Coverage helpers for elimination-diet: which meals / symptom check-ins are missing, and how much
// that should lower confidence in predictions. Used by the "Needs attention" card and diet-predictions.js.

export const HOUR = 3600e3, DAY = 24 * HOUR;
export const MIN_MEALS_PER_DAY = 3;
export const LOOKBACK_DAYS = 7;

// A day needs a record (eaten or "not eaten") in each slot to reach 3 meals; slots only decide
// which buttons to offer.
export const SLOTS = [
    { name: 'Breakfast', from: 4, to: 11, at: 8 },
    { name: 'Lunch', from: 11, to: 16, at: 12 },
    { name: 'Dinner', from: 16, to: 24, at: 18 },
];
// Symptom check-in blocks: a finished block with no symptom AND no positive entry is "missing".
export const BLOCKS = [
    { name: 'Morning', from: 6, to: 12 },
    { name: 'Afternoon', from: 12, to: 18 },
    { name: 'Evening', from: 18, to: 24 },
];

// Confidence multipliers (1 = fully trusted)
const UNCONFIRMED = 0.4;      // no symptom/positive entry nearby, so "no symptom" is a guess
const SKIPPED = 0.5;          // within 24h after a meal marked not eaten
const UNRESOLVED = 0.25;      // day with < 3 meals and nothing marked not eaten, plus the next 24h
const UNRESOLVED_CASE = 0.5;  // symptom during an unresolved day: what was eaten is partly unknown

export const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const atHour = (day, h) => { const d = new Date(day); d.setHours(h, 0, 0, 0); return d.getTime(); };
const nextDay = day => { const d = new Date(day); d.setDate(d.getDate() + 1); return d.getTime(); };
const t0 = x => +new Date(x);

function firstLogDay(state) {
    const all = [...state.meals.map(m => t0(m.eaten_at)), ...state.symptoms.map(s => t0(s.occurred_at))];
    return all.length ? dayStart(Math.min(...all)) : null;
}
// The first day of use is usually partial, so checking starts the day after.
function firstCheckedDay(state, now, lookbackDays) {
    const first = firstLogDay(state);
    if (first === null) return null;
    const start = nextDay(first);
    return lookbackDays === Infinity ? start : Math.max(start, dayStart(dayStart(now) - lookbackDays * DAY + 12 * HOUR));
}

// Previous days (not today) with fewer than 3 meal records, newest first.
export function mealGapDays(state, now = Date.now(), lookbackDays = LOOKBACK_DAYS) {
    const from = firstCheckedDay(state, now, lookbackDays);
    if (from === null) return [];
    const today = dayStart(now), gaps = [];
    for (let d = from; d < today; d = nextDay(d)) {
        const end = nextDay(d);
        const recs = state.meals.filter(m => { const t = t0(m.eaten_at); return t >= d && t < end; });
        if (recs.length >= MIN_MEALS_PER_DAY) continue;
        const missingSlots = SLOTS.filter(s => !recs.some(m => { const h = new Date(m.eaten_at).getHours(); return h >= s.from && h < s.to; }));
        gaps.push({ day: d, count: recs.length, missingSlots });
    }
    return gaps.reverse();
}

// Finished check-in blocks with no symptom or positive entry, newest first.
export function symptomGaps(state, now = Date.now(), lookbackDays = LOOKBACK_DAYS) {
    const from = firstCheckedDay(state, now, lookbackDays);
    if (from === null) return [];
    const entries = state.symptoms.map(s => t0(s.occurred_at));
    const out = [];
    for (let d = from; d <= dayStart(now); d = nextDay(d)) {
        for (const b of BLOCKS) {
            const start = atHour(d, b.from), end = atHour(d, b.to);
            if (end > now) continue;
            if (!entries.some(t => t >= start && t < end)) out.push({ day: d, block: b.name, start, end });
        }
    }
    return out.reverse();
}

// Weights used by the predictions. Windows are [a, b]; for a single point pass b = a and a pad.
export function buildConfidence(state, now = Date.now()) {
    const skipped = state.meals.filter(m => m.skipped).map(m => t0(m.eaten_at));
    const unresolved = mealGapDays(state, now, Infinity).map(g => g.day);
    const entries = state.symptoms.map(s => t0(s.occurred_at));

    const inSkip = (a, b) => skipped.some(g => g <= b && g + DAY > a);
    const inUnresolved = (a, b) => unresolved.some(d => d <= b && nextDay(nextDay(d)) > a);
    const isCovered = (a, b, pad) => entries.some(t => t >= a - pad && t <= b + pad);

    return {
        skippedCount: skipped.length,
        unresolvedDays: unresolved.length,
        isCovered,
        // weight of a symptom event (evidence that something DID happen)
        caseWeight: t => (inUnresolved(t, t) ? UNRESOLVED_CASE : 1),
        // weight of "nothing happened" evidence: comparison times and foods with no symptom after them
        noProblemWeight: (a, b = a, pad = 6 * HOUR) =>
            (isCovered(a, b, pad) ? 1 : UNCONFIRMED) * (inSkip(a, b) ? SKIPPED : 1) * (inUnresolved(a, b) ? UNRESOLVED : 1),
    };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayLabel = t => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

// "Needs attention" card on the Timeline tab. Buttons carry data-* attributes handled in elimination-diet.js.
export function renderAttention(state) {
    const card = document.getElementById('attentionCard'), list = document.getElementById('attentionList');
    if (!card || !list) return;
    const mealGaps = mealGapDays(state), symGaps = symptomGaps(state);
    card.hidden = !mealGaps.length && !symGaps.length;

    const mealRows = mealGaps.map(g => `<div class="diet-row"><strong>${dayLabel(g.day)}</strong>
    <small>${g.count} of ${MIN_MEALS_PER_DAY} meals logged</small>
    <div>${g.missingSlots.map(s => `${s.name}:
      <button type="button" class="button-inline" data-skip-meal="${atHour(g.day, s.at)}" data-slot="${s.name}">Not eaten</button>
      <button type="button" class="button-inline button-ghost" data-log-meal="${atHour(g.day, s.at)}" data-slot="${s.name}">Log it</button>`).join(' &nbsp; ')}</div></div>`);

    const SHOW = 8;
    const symRows = symGaps.slice(0, SHOW).map(g => { const mid = (g.start + g.end) / 2;
        return `<div class="diet-row"><strong>${dayLabel(g.day)} ${g.block.toLowerCase()}</strong>
      <small>no symptom or positive entry</small>
      <div><button type="button" class="button-inline" data-fine="${mid}">Felt fine</button>
      <button type="button" class="button-inline button-ghost" data-log-sym="${mid}">Log symptom</button></div></div>`; });
    if (symGaps.length > SHOW) symRows.push(`<small>…and ${symGaps.length - SHOW} earlier blocks</small>`);

    list.innerHTML =
        (mealRows.length ? `<div class="eyebrow">Days with fewer than ${MIN_MEALS_PER_DAY} meals</div>${mealRows.join('')}` : '') +
        (symRows.length ? `<div class="eyebrow">Symptom check-ins missing</div>${symRows.join('')}` : '');
}