// Shared "summary card" builder (label + big value + optional foot text +
// optional status color). Used for budget balance, rental profit/loss,
// and card-comparison summaries. Needs #tpl-summary-card present in the page.

import { cloneEl, refs } from './dom.js';

// opts: { label, value, unit = '/mo', foot = '', statusClass = '' }
// `foot` may contain simple inline HTML (e.g. "&middot;" separators) —
// it's set via innerHTML since callers already build it as markup;
// keep it to fixed separators and formatted numbers, never raw user input.
export function buildSummaryCard({ label, value, unit = '/mo', foot = '', statusClass = '' }){
    const card = cloneEl('tpl-summary-card');
    const r = refs(card);

    if(statusClass) card.classList.add(statusClass);
    r.label.textContent = label;
    r.value.textContent = value;
    r.unit.textContent = unit;

    if(foot){
        r.foot.innerHTML = foot;
    } else {
        r.foot.remove();
    }

    return card;
}

// Renders a list of summary cards into a container, replacing its contents.
export function renderSummaryCards(container, cardsSpec){
    container.replaceChildren(...cardsSpec.map(buildSummaryCard));
}
