// Timeline export for elimination-diet: one CSV with every meal, not-eaten meal and symptom, oldest first,
// plus a few columns that tell a reader (or an AI) how complete the log was around each row.
//
// type values:  meal | meal_not_eaten | symptom | positive_symptom
// short_day:    TRUE on past days with fewer than 3 meal records (eaten or marked not eaten)
// within_24h_after_not_eaten_meal: TRUE when a meal was marked not eaten in the 24h before this row

import { mealGapDays, dayStart, DAY } from './diet-coverage.js';

export const COLUMNS = [
    'datetime_local', 'datetime_utc', 'weekday', 'type', 'meal_label', 'ingredients', 'tags',
    'symptom', 'severity', 'notes', 'meals_recorded_that_day', 'short_day', 'within_24h_after_not_eaten_meal',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const localStamp = t => { const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const cell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Pure: build the CSV text from full meal and symptom lists. Meals need diet_meal_ingredients.
export function buildCsv({ meals, symptoms, ingredients }, now = Date.now()) {
    const ingById = new Map(ingredients.map(i => [i.id, i]));
    const perDay = new Map();
    meals.forEach(m => { const k = dayStart(m.eaten_at); perDay.set(k, (perDay.get(k) || 0) + 1); });
    const shortDays = new Set(mealGapDays({ meals, symptoms }, now, Infinity).map(g => g.day));
    const notEaten = meals.filter(m => m.skipped).map(m => +new Date(m.eaten_at));

    const events = [
        ...meals.map(m => {
            const ings = (m.diet_meal_ingredients || []).map(x => ingById.get(x.ingredient_id)).filter(Boolean);
            return { t: +new Date(m.eaten_at), type: m.skipped ? 'meal_not_eaten' : 'meal', label: m.label,
                items: ings.map(i => i.name).join('; '), tags: [...new Set(ings.flatMap(i => i.tags || []))].join('; '),
                symptom: '', severity: '', notes: m.notes };
        }),
        ...symptoms.map(s => ({ t: +new Date(s.occurred_at), type: s.positive ? 'positive_symptom' : 'symptom', label: '',
            items: '', tags: '', symptom: s.symptom, severity: s.severity, notes: s.notes })),
    ].sort((a, b) => a.t - b.t);

    const lines = events.map(e => {
        const day = dayStart(e.t);
        return [
            localStamp(e.t), new Date(e.t).toISOString(), WEEKDAYS[new Date(e.t).getDay()], e.type, e.label, e.items, e.tags,
            e.symptom, e.severity, e.notes, perDay.get(day) || 0, shortDays.has(day) ? 'TRUE' : 'FALSE',
            notEaten.some(g => g < e.t && e.t <= g + DAY) ? 'TRUE' : 'FALSE',
        ].map(cell).join(',');
    });
    return { csv: [COLUMNS.join(','), ...lines].join('\r\n') + '\r\n', rows: lines.length };
}

// The page only keeps the latest 200 of each record type, so export fetches everything.
async function fetchAll(makeQuery) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await makeQuery().range(from, from + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) break;
    }
    return out;
}

export async function exportTimelineCsv(sb, ingredients) {
    const [meals, symptoms] = await Promise.all([
        fetchAll(() => sb.from('diet_meals').select('*, diet_meal_ingredients(ingredient_id)').order('eaten_at').order('id')),
        fetchAll(() => sb.from('diet_symptoms').select('*').order('occurred_at').order('id')),
    ]);
    const { csv, rows } = buildCsv({ meals, symptoms, ingredients });
    const d = new Date();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `elimination-diet-timeline-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return rows;
}