// Predictions tab for diet-main.js.
//
// Triggers (case-crossover comparison): for every symptom, look at what was eaten in the preceding N
// hours, then at the same clock time on the 7 days before and after (days with no symptom around that
// time). Foods that show up far more often before symptoms than at those times get a high ratio.
//
// Confidence: evidence is weighted by how trustworthy the log is at that moment (see diet-coverage.js):
// "no symptom" with no check-in nearby, the 24h after a meal marked not eaten, and days with fewer than
// 3 meals and nothing marked not eaten all count for less. Positive entries ("felt fine") confirm that
// a stretch of time really was symptom-free.
//
// Safe foods: foods eaten several times where no symptom followed within the same window.

import { HOUR, DAY, buildConfidence, mealGapDays, symptomGaps } from './diet-coverage.js';
import { cloneEl, refs } from '../shared/dom.js';
import { el } from '../shared/ui.js';

const CLUSTER_GAP = 3 * HOUR;     // symptoms logged within 3h of each other count as one event
const EXCLUDE_NEAR = 3 * HOUR;    // comparison times this close to a symptom aren't clean "no symptom" times
const MAX_SHIFT_DAYS = 7;
const MIN_EVENTS = 5;             // effective (weighted) events needed before results are more than "early"

export function analyze(state, { windowHours = 24, minSeverity = 1, symptom = '', group = 'tags', now = Date.now() } = {}) {
    const W = windowHours * HOUR;
    const model = buildConfidence(state, now);
    const ingById = new Map(state.ingredients.map(i => [i.id, i]));

    const records = state.meals.map(m => {
        const ings = (m.diet_meal_ingredients || []).map(x => ingById.get(x.ingredient_id)).filter(Boolean);
        return { t: +new Date(m.eaten_at), skipped: !!m.skipped, n: ings.length,
            factors: new Set(group === 'tags' ? ings.flatMap(i => i.tags || []) : ings.map(i => i.name)) };
    }).sort((a, b) => a.t - b.t);
    const eaten = records.filter(m => !m.skipped && m.n > 0);
    const skippedMeals = records.filter(m => m.skipped);

    const wanted = symptom.trim().toLowerCase();
    const neg = state.symptoms.filter(s => !s.positive)
        .filter(s => (s.severity ?? minSeverity) >= minSeverity)
        .filter(s => !wanted || (s.symptom || '').trim().toLowerCase() === wanted)
        .map(s => +new Date(s.occurred_at)).sort((a, b) => a - b);
    const positives = state.symptoms.filter(s => s.positive).map(s => +new Date(s.occurred_at));

    const events = [];
    for (const t of neg) {
        const last = events[events.length - 1];
        if (last && t - last.last <= CLUSTER_GAP) last.last = t; else events.push({ t, last: t });
    }

    // Factors eaten in (t - W, t]. null = nothing logged at all (unknown); an empty set = only
    // "not eaten" records, so we know nothing was eaten.
    const exposure = t => {
        const set = new Set(); let n = 0;
        for (const m of eaten) { if (m.t > t) break; if (m.t > t - W) { n++; m.factors.forEach(f => set.add(f)); } }
        if (n) return set;
        return skippedMeals.some(m => m.t <= t && m.t > t - W) ? set : null;
    };

    const lastLogged = Math.min(now, Math.max(
        records.length ? records[records.length - 1].t : 0,
        state.symptoms.reduce((mx, s) => Math.max(mx, +new Date(s.occurred_at)), 0)));

    const cases = [], controls = [];
    let skipped = 0;
    for (const ev of events) {
        const ex = exposure(ev.t);
        if (!ex) { skipped++; continue; }
        cases.push({ set: ex, w: model.caseWeight(ev.t) });
        for (let k = -MAX_SHIFT_DAYS; k <= MAX_SHIFT_DAYS; k++) {
            if (!k) continue;
            const r = ev.t + k * DAY;
            if (r > lastLogged || neg.some(t => Math.abs(t - r) <= EXCLUDE_NEAR)) continue;
            const rex = exposure(r);
            if (rex) controls.push({ set: rex, w: model.noProblemWeight(r) });
        }
    }

    const sum = (arr, pick = () => true) => arr.reduce((s, x) => s + (pick(x) ? x.w : 0), 0);
    const Nc = sum(cases), Nk = sum(controls);
    const enough = Nc >= MIN_EVENTS && Nk > 0;
    // Pseudo-count smoothing scaled to each group's average weight, so down-weighted evidence
    // doesn't make ratios look more extreme.
    const sc = cases.length ? .5 * Nc / cases.length : .5, sk = controls.length ? .5 * Nk / controls.length : .5;
    const rawTotal = cases.length + controls.length;
    const confidence = rawTotal ? (Nc + Nk) / rawTotal : 1;

    const universe = new Set(eaten.flatMap(m => [...m.factors]));
    const rows = [...universe].map(factor => {
        const a = sum(cases, x => x.set.has(factor)), c = sum(controls, x => x.set.has(factor));
        const ratio = ((a + sc) / (Nc + 2 * sc)) / ((c + sk) / (Nk + 2 * sk));
        let signal = 'none';
        if (!enough) signal = 'early';
        else if (ratio >= 2 && a >= 4) signal = 'strong';
        else if (ratio >= 1.5 && a >= 3) signal = 'possible';
        else if (ratio <= 0.6 && c >= 4) signal = 'lower';
        return { factor, a, c, ratio, signal };
    }).filter(r => r.a + r.c > 0).sort((x, y) => ((y.a >= 2) - (x.a >= 2)) || (y.ratio - x.ratio));

    // Foods that don't seem to trigger anything: each time it was eaten, was a symptom logged within the window?
    const stats = new Map();
    for (const m of eaten) {
        const end = m.t + W;
        if (end > now || !m.factors.size) continue;                 // window not finished yet
        const followed = events.some(e => e.t > m.t && e.t <= end);
        const good = positives.some(t => t > m.t && t <= end);
        const covered = model.isCovered(m.t, end, 0);
        const w = followed ? model.caseWeight(m.t) : model.noProblemWeight(m.t, end, 0);
        for (const f of m.factors) {
            const s = stats.get(f) || { n: 0, followed: 0, good: 0, cov: 0, clean: 0, fol: 0 };
            s.n++;
            if (followed) { s.followed++; s.fol += w; }
            else { s.clean += w; if (good) s.good++; if (covered) s.cov++; }
            stats.set(f, s);
        }
    }
    const signalOf = new Map(rows.map(r => [r.factor, r.signal]));
    const safe = [...stats].map(([factor, s]) => ({ factor, ...s, conf: (s.clean + s.fol) / s.n }))
        .filter(s => s.cov >= 2 && s.clean >= 3 && s.fol / (s.clean + s.fol) <= 0.15 &&
            !['strong', 'possible'].includes(signalOf.get(s.factor)))
        .sort((x, y) => y.clean - x.clean);

    return {
        rows, safe, enough, skipped,
        events: cases.length, eventsEff: Nc, comparisons: controls.length, comparisonsEff: Nk,
        confidence,
        skippedMeals: model.skippedCount, unresolvedDays: model.unresolvedDays,
    };
}

const SIGNAL_LABEL = {
    strong: 'Strong signal', possible: 'Possible signal', none: 'No clear signal',
    lower: 'Eaten less before symptoms', early: 'Too early to say',
};

const n1 = n => +n.toFixed(1);                       // 3 -> 3, 2.5 -> 2.5
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0) + '%';
const level = c => (c >= 0.8 ? 'High' : c >= 0.5 ? 'Medium' : 'Low');

export function renderPredictions(state, tagChip){
    const $ = id => document.getElementById(id);
    if(!$('predBody')) return;

    // Symptom filter lists logged (non-positive) symptom names, case-insensitive, keeping the selection.
    const seen = new Map();
    state.symptoms.filter(s => !s.positive).forEach(s => {
        const n = (s.symptom || '').trim(); if(n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    });
    const sel = $('predSymptom'), cur = sel.value, names = [...seen.values()].sort();
    sel.replaceChildren(sel.firstElementChild, ...names.map(n => new Option(n, n)));   // "All symptoms" stays in the HTML
    sel.value = names.includes(cur) ? cur : '';

    const group = $('predGroup').value;
    const res = analyze(state, {
        windowHours: +$('predWindow').value || 24,
        minSeverity: +$('predSeverity').value || 1,
        symptom: sel.value, group,
    });
    const label = f => (group === 'tags' ? tagChip(f) : f);      // append() takes a node or a string

    // ---- summary + confidence ----
    const lines = [];
    if(res.events){
        lines.push(`Based on ${res.events} symptom event${res.events === 1 ? '' : 's'}` +
            (res.skipped ? ` (${res.skipped} skipped: no meals logged in that window)` : '') +
            ` compared with ${res.comparisons} matching times on other days.` +
            (res.enough ? '' : ` Results are too early to rely on until the weighted event count reaches 5 (now ${n1(res.eventsEff)}).`));
        lines.push(`Data confidence: ${pct(res.confidence, 1)}.`);
    }
    const why = [];
    if(res.skippedMeals) why.push(`${res.skippedMeals} meal${res.skippedMeals === 1 ? '' : 's'} marked not eaten (lowers confidence for the next 24 hours)`);
    if(res.unresolvedDays) why.push(`${res.unresolvedDays} day${res.unresolvedDays === 1 ? '' : 's'} with fewer than 3 meals and nothing marked not eaten`);
    const symGapCount = symptomGaps(state).length, mealGapCount = mealGapDays(state).length;
    if(symGapCount) why.push(`${symGapCount} symptom check-in block${symGapCount === 1 ? '' : 's'} with no entry in the last 7 days`);
    if(why.length) lines.push(`Lowering confidence: ${why.join('; ')}. See Needs attention on the Timeline tab` + (mealGapCount ? ' to mark skipped meals.' : '.'));
    $('predSummary').replaceChildren(...lines.map(text => el('div', text)));

    // ---- triggers ----
    $('predEmpty').hidden = res.rows.length > 0;
    $('predTableWrap').hidden = res.rows.length === 0;
    $('predBody').replaceChildren(...res.rows.map(x => {
        const row = cloneEl('tpl-pred-row');
        const r = refs(row);
        r.factor.append(label(x.factor));
        r.signal.textContent = SIGNAL_LABEL[x.signal];
        r.lowConf.hidden = !(res.confidence < 0.6 && ['strong', 'possible'].includes(x.signal));
        r.before.textContent = `${n1(x.a)} of ${n1(res.eventsEff)} (${pct(x.a, res.eventsEff)})`;
        r.other.textContent = `${n1(x.c)} of ${n1(res.comparisonsEff)} (${pct(x.c, res.comparisonsEff)})`;
        r.ratio.textContent = `${x.ratio.toFixed(1)}\u00d7`;
        return row;
    }));

    // ---- safe foods ----
    $('predSafeEmpty').hidden = res.safe.length > 0;
    $('predSafeWrap').hidden = res.safe.length === 0;
    $('predSafeBody').replaceChildren(...res.safe.map(s => {
        const row = cloneEl('tpl-safe-row');
        const r = refs(row);
        r.factor.append(label(s.factor));
        r.n.textContent = s.n;
        r.followed.textContent = s.followed;
        r.good.textContent = s.good;
        r.level.textContent = level(s.conf);
        return row;
    }));
}