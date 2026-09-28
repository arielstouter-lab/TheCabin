// Small helpers for working with <template> elements.
// Templates mark the elements JS needs with data-ref="name";
// refs(root) returns { name: element } for all of them.

function template(id){
    const t = document.getElementById(id);
    if(!t) throw new Error(`Missing <template id="${id}">`);
    return t;
}

// For templates with several top-level elements (whole panels).
export function cloneFragment(id){
    return template(id).content.cloneNode(true);
}

// For templates with a single root element (rows, chips, buttons).
export function cloneEl(id){
    return template(id).content.firstElementChild.cloneNode(true);
}

export function refs(root){
    const map = {};
    root.querySelectorAll('[data-ref]').forEach(el => {
        map[el.dataset.ref] = el;
    });
    return map;
}

export function emptyState(text){
    const p = cloneEl('tpl-empty');
    p.textContent = text;
    return p;
}

export function focusAtEnd(el){
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}