// Lists-specific UI helpers. Generic ones (chips, slots, status toasts) live in
// SharedJS/ui.js and are re-exported here so the panels keep a single import.

import { cloneEl } from '../SharedJS/dom.js';
import { sectionSlug } from './lists-state.js';

export { makeChip, fillSlots, setStatus } from '../SharedJS/ui.js';

// Wires a quantity stepper (tpl-stepper refs) to a value.
// getValue() returns the current number; onChange(next) is called with the new one.
export function bindStepper(r, getValue, onChange){
    r.stepVal.textContent = String(getValue());
    r.stepDown.addEventListener('click', () => onChange(Math.max(1, getValue() - 1)));
    r.stepUp.addEventListener('click', () => onChange(Math.max(1, getValue() + 1)));
}

// Single place that builds the "Manage tags" link target.
// returnTo defaults to this section's tab on the Lists page.
export function manageHref(sec, returnTo = `lists.html#${sectionSlug(sec)}`){
    return `managegroceries.html?section=${encodeURIComponent(sec.id)}` +
        `&return=${encodeURIComponent(returnTo)}`;
}

// Fills the <select data-ref="newPerson"> from state.people using tpl-person-option.
export function fillPersonOptions(select, people){
    select.append(...people.map(p => {
        const opt = cloneEl('tpl-person-option');
        opt.value = p.id;
        opt.textContent = p.name;
        return opt;
    }));
}