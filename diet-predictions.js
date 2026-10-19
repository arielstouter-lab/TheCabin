// Predictions tab for elimination-diet.js.
//
// Method (a "case-crossover" comparison): for every symptom event, look at what was eaten in the
// preceding N hours. Then look at the SAME clock time on the 7 days before and after (days with no
// symptom around that time) and ask the same question. A tag or ingredient that shows up far more
// often before symptoms than at those comparison times gets a high ratio.
//
// Because each symptom is compared with the same time of day on other days, "I always eat X at
// breakfast" doesn't make X look guilty by itself. It is still an association, not proof.

const HOUR = 3600e3, DAY = 24 * HOUR;
const CLUSTER_GAP = 3 * HOUR;     // symptoms logged within 3h of each other count as one event
const EXCLUDE_NEAR = 3 * HOUR;    // comparison times this close to a symptom aren't clean "no symptom" times
const MAX_SHIFT_DAYS = 7;         // compare against the same time on +/- 1..7 days
const MIN_EVENTS = 5;             // below this, results are shown as "too early to say"

export function analyze(state, { windowHours = 24, minSeverity = 1, symptom = '', group = 'tags' } = {}) {
    const W = windowHours * HOUR;
    const ingById = new Map(state.ingredients.map(i => [i.id, i]));

    // Only meals that have ingredients logged can say anything about exposure.
    const meals = state.meals
        .map(m => {
            const ings = (m.diet_meal_ingredients || []).map(x => ingById.get(x.ingredient_id)).filter(Boolean);
            return { t: +new Date(m.eaten_at), n: ings.length,
                factors: new Set(group === 'tags' ? ings.flatMap(i => i.tags || []) : ings.map(i => i.name)) };
        })
        .filter(m => m.n > 0)
        .sort((a, b) => a.t - b.t);

    const wanted = symptom.trim().toLowerCase();
    const sym = state.symptoms
        .filter(s => (s.severity ?? minSeverity) >= minSeverity)
        .filter(s => !wanted || (s.symptom || '').trim().toLowerCase() === wanted)
        .map(s => ({ t: +new Date(s.occurred_at) }))
        .sort((a, b) => a.t - b.t);

    // Merge symptoms that are close together into single events (event time = first one).
    const events = [];
    for (const s of sym) {
        const last = events[events.length - 1];
        if (last && s.t - last.last <= CLUSTER_GAP) last.last = s.t;
        else events.push({ t: s.t, last: s.t });
    }

    // Factors eaten in (t - W, t]; null when no meal with ingredients was logged in that window, since
    // "nothing logged" can't be told apart from "ate none of it".
    const exposure = t => {
        const set = new Set(); let n = 0;
        for (const m of meals) {
            if (m.t > t) break;
            if (m.t > t - W) { n++; m.factors.forEach(f => set.add(f)); }
        }
        return n ? set : null;
    };

    const lastLogged = Math.min(Date.now(), Math.max(
        meals.length ? meals[meals.length - 1].t : 0,
        state.symptoms.reduce((mx, s) => Math.max(mx, +new Date(s.occurred_at)), 0)));

    const cases = [], controls = [];
    let skipped = 0;
    for (const ev of events) {
        const ex = exposure(ev.t);
        if (!ex) { skipped++; continue; }
        cases.push(ex);
        for (let k = -MAX_SHIFT_DAYS; k <= MAX_SHIFT_DAYS; k++) {
            if (!k) continue;
            const r = ev.t + k * DAY;
            if (r > lastLogged) continue;
            if (sym.some(s => Math.abs(s.t - r) <= EXCLUDE_NEAR)) continue;
            const rex = exposure(r);
            if (rex) controls.push(rex);
        }
    }

    const universe = new Set(meals.flatMap(m => [...m.factors]));
    const enough = cases.length >= MIN_EVENTS && controls.length > 0;
    const rows = [...universe].map(factor => {
        const a = cases.filter(s => s.has(factor)).length;
        const c = controls.filter(s => s.has(factor)).length;
        // +0.5 smoothing keeps a single exposure from producing an absurd ratio
        const ratio = ((a + .5) / (cases.length + 1)) / ((c + .5) / (controls.length + 1));
        let signal = 'none';
        if (!enough) signal = 'early';
        else if (ratio >= 2 && a >= 4) signal = 'strong';
        else if (ratio >= 1.5 && a >= 3) signal = 'possible';
        else if (ratio <= 0.6 && c >= 4) signal = 'lower';
        return { factor, a, c, ratio, signal };
    })
        .filter(r => r.a + r.c > 0)
        .sort((x, y) => ((y.a >= 2) - (x.a >= 2)) || (y.ratio - x.ratio));

    return { rows, events: cases.length, skipped, comparisons: controls.length, enough };
}

const SIGNAL_LABEL = {
    strong: 'Strong signal', possible: 'Possible signal', none: 'No clear signal',
    lower: 'Eaten less before symptoms', early: 'Too early to say'
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0) + '%';

export function renderPredictions(state, chipClass) {
    const $ = id => document.getElementById(id);
    if (!$('predBody')) return;

    // Symptom filter options come from what has actually been logged (case-insensitive, keep selection).
    const seen = new Map();
    state.symptoms.forEach(s => { const n = (s.symptom || '').trim(); if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n); });
    const sel = $('predSymptom'), cur = sel.value;
    sel.innerHTML = '<option value="">All symptoms</option>' +
        [...seen.values()].sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = [...seen.values()].includes(cur) ? cur : '';

    const group = $('predGroup').value;
    const res = analyze(state, {
        windowHours: +$('predWindow').value || 24,
        minSeverity: +$('predSeverity').value || 1,
        symptom: sel.value,
        group
    });

    $('predSummary').textContent = res.events
        ? `Based on ${res.events} symptom event${res.events === 1 ? '' : 's'}` +
        (res.skipped ? ` (${res.skipped} skipped: no meals logged in that window)` : '') +
        ` compared with ${res.comparisons} matching times on other days.` +
        (res.enough ? '' : ` Results are too early to rely on until you have at least ${MIN_EVENTS} events.`)
        : '';

    const empty = $('predEmpty');
    empty.hidden = res.rows.length > 0;
    empty.textContent = 'Log meals with ingredients and some symptoms, then check back here.';
    $('predTableWrap').hidden = res.rows.length === 0;

    $('predBody').innerHTML = res.rows.map(r => {
        const name = group === 'tags' ? `<span class="${chipClass(r.factor)}">${esc(r.factor)}</span>` : esc(r.factor);
        return `<tr>
      <td>${name}</td>
      <td>${SIGNAL_LABEL[r.signal]}</td>
      <td class="col-num">${r.a} of ${res.events} (${pct(r.a, res.events)})</td>
      <td class="col-num">${r.c} of ${res.comparisons} (${pct(r.c, res.comparisons)})</td>
      <td class="col-num">${r.ratio.toFixed(1)}&times;</td>
    </tr>`;
    }).join('');
}