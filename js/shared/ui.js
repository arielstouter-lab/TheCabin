// Page-agnostic UI helpers. Each page keeps its own <template id="tpl-chip"> etc.
// in its HTML; these only fill and toggle what the templates declare.

import { cloneEl } from './dom.js';

// Chip from <template id="tpl-chip">.
// kind  -> data-kind  (priority | assigned | due | aisle), styled via .chip[data-kind="..."]
// state -> data-state (e.g. the due-date state), styled via .chip[data-state="..."]
export function makeChip(text, kind = 'default', state = ''){
    const chip = cloneEl('tpl-chip');
    chip.textContent = text;
    chip.dataset.kind = kind;
    if(state) chip.dataset.state = state;
    return chip;
}

// Replaces every <div data-slot="name"></div> inside root with a clone of <template id="tpl-name">.
// Call this BEFORE refs(root) so the slotted elements' data-ref hooks are found.
export function fillSlots(root){
    root.querySelectorAll('[data-slot]').forEach(slot => {
        slot.replaceWith(cloneEl(`tpl-${slot.dataset.slot}`));
    });
}

// Thin wrapper over app.js's showToast (a global from a classic script).
// Defaults to an error toast; pass '' to do nothing. Returns the toast element.
export function setStatus(message, type = 'error', duration){
    if(!message) return null;
    if(typeof window.showToast !== 'function'){
        console.warn(message);
        return null;
    }
    return window.showToast(message, type, duration);
}

// onChange handler for initSync(): one persistent toast tracks the offline write queue.
// Created on the first pending change, updated as the count moves, closed when empty.
export function syncStatusHandler(){
    let toast = null;
    return n => {
        if(!n){
            toast?.querySelector('.toast-close')?.click();
            toast = null;
            return;
        }
        const text = `${n} change${n === 1 ? '' : 's'} pending sync…`;
        if(toast?.isConnected){
            toast.querySelector('.toast-message').textContent = text;
        } else {
            toast = setStatus(text, 'info', 0);   // 0 = stays until closed
        }
    };
}

// Currency, e.g. -1234.5 -> "-$1,234.50". Non-numbers render as $0.00.
export function fmt$(n) {
    const val = typeof n === 'number' && !isNaN(n) ? n : 0;
    const sign = val < 0 ? '-' : '';
    return sign + '$' + (Math.round(Math.abs(val) * 100) / 100)
        .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Tiny element factory: el('p', 'text', 'css-class')
export function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
}

// <details> open/closed state survives a re-render that rebuilds its container.
// Each <details> is keyed by its nearest ancestor with an id plus its position
// among the <details> inside that ancestor, which is stable as long as the
// order of the rebuilt content is stable.
function detailsKey(d) {
    const host = d.parentElement ? d.parentElement.closest('[id]') : null;
    const all = host ? [...host.querySelectorAll('details')] : [];
    return `${host ? host.id : ''}:${all.indexOf(d)}`;
}

export function captureDetailsState(root = document) {
    return new Map([...root.querySelectorAll('details')].map(d => [detailsKey(d), d.open]));
}

export function restoreDetailsState(state, root = document) {
    root.querySelectorAll('details').forEach(d => {
        const key = detailsKey(d);
        if (state.has(key)) d.open = state.get(key);
    });
}