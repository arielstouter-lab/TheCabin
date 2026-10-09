// Shared "editable category row" builder — a <tr> with name, frequency,
// amount, an editable notes span, a computed read-only total, and a
// delete button. Used by every grid in creditcards.js (spend, bank
// spend, income, rental expenses).
//
// Needs #tpl-category-row present in the page. Sits next to dom.js at
// the app root so any page can import it the same way.

import { cloneEl, refs, focusAtEnd } from '../SharedJS/dom.js';

const FREQUENCIES = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'semimonthly', label: 'Semimonthly (twice a month)' },
    { value: 'biweekly', label: 'Biweekly (every other week)' },
    { value: 'annual', label: 'Annual' }
];

function populateFrequencyOptions(select){
    if(select.options.length) return; // already populated (template reused)
    FREQUENCIES.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.append(opt);
    });
}

// row: { id, category|name, frequency, amount, notes, monthly_spend }
// onUpdate(id, patch) / onDelete(id) are called with just the changed field(s).
// options: { deleteTitle, notePlaceholder, fmt$ }
export function buildCategoryRow(row, { onUpdate, onDelete, deleteTitle = 'Delete', notePlaceholder, fmt$ }){
    const tr = cloneEl('tpl-category-row');
    const r = refs(tr);

    populateFrequencyOptions(r.frequency);

    r.name.value = row.category || row.name || '';
    r.frequency.value = row.frequency || 'monthly';
    r.amount.value = row.amount ?? row.monthly_spend ?? 0;
    r.notes.textContent = row.notes || '';
    if(notePlaceholder) r.notes.dataset.placeholder = notePlaceholder;
    r.monthly.textContent = fmt$(row.monthly_spend || 0);
    r.delBtn.title = deleteTitle;

    r.name.addEventListener('change', () => onUpdate(row.id, { category: r.name.value }));
    r.frequency.addEventListener('change', () => onUpdate(row.id, { frequency: r.frequency.value }));
    r.amount.addEventListener('change', () => onUpdate(row.id, { amount: parseFloat(r.amount.value) || 0 }));

    r.notes.addEventListener('focusout', () => {
        const val = r.notes.textContent.trim();
        if(val !== (row.notes || '')) onUpdate(row.id, { notes: val });
    });
    r.notes.addEventListener('keydown', e => {
        if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); r.notes.blur(); }
    });

    r.delBtn.addEventListener('click', () => onDelete(row.id));

    return tr;
}
