// Template helpers: markup lives in <template> elements in the page; JS only clones and fills them.
//   data-field="x"  -> textContent = data.x
//   data-if="x"     -> element is removed unless data.x is truthy (removed, not hidden, so CSS display rules can't leak through)
//   data-slot="x"   -> an empty container JS appends child nodes into

export const tpl = id => document.getElementById(id).content.firstElementChild.cloneNode(true);

export function fill(root, data = {}) {
    root.querySelectorAll('[data-if]').forEach(el => { if (!data[el.dataset.if]) el.remove(); });
    const targets = [...root.querySelectorAll('[data-field]')];
    if (root.matches('[data-field]')) targets.unshift(root);
    targets.forEach(el => { el.textContent = data[el.dataset.field] ?? ''; });
    return root;
}

export const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

// pairs: [value, text]. keepFirst keeps the placeholder <option> that lives in the HTML.
export function setOptions(el, pairs, keepFirst = false) {
    const first = keepFirst && el.firstElementChild ? [el.firstElementChild] : [];
    el.replaceChildren(...first, ...pairs.map(([value, text = '']) => new Option(text, value)));
}

// Empty text comes from the container's data-empty (or data-empty-filtered) attribute in the HTML.
export function renderList(el, nodes, emptyKey = 'empty') {
    if (nodes.length) return el.replaceChildren(...nodes);
    const p = tpl('tpl-empty');
    p.textContent = el.dataset[emptyKey] || '';
    el.replaceChildren(p);
}