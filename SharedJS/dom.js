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

/**
 * Universal delegated event listener.
 * @param {Element|Document|Window|string} root - Target element, Document, Window or selector
 * @param {string} eventName - DOM event name (e.g. 'click', 'change')
 * @param {string} selector - CSS selector to match target elements
 * @param {Function} handler - Callback invoked with (event, delegateTarget)
 * @returns {Function} Cleanup function to remove listener
 */
export function on(root, eventName, selector, handler) {
    const container = typeof root === 'string' ? document.querySelector(root) : root;
    if (!container) return () => {};

    const listener = (e) => {
        const delegateTarget = e.target && e.target.closest ? e.target.closest(selector) : null;
        if (delegateTarget && (container === window || container === document || container === delegateTarget || container.contains(delegateTarget))) {
            handler(e, delegateTarget);
        }
    };

    container.addEventListener(eventName, listener);
    return () => container.removeEventListener(eventName, listener);
}

/**
 * Declarative action dispatcher for elements with [data-action].
 * @param {Element|Document|Window|string} root
 * @param {Record<string, Function>} actions - Map of action name -> handler(dataset, target, event)
 * @param {string} [eventName='click']
 * @returns {Function} Cleanup function
 */
export function bindActions(root, actions, eventName = 'click') {
    return on(root, eventName, '[data-action]', (e, target) => {
        const action = target.dataset.action;
        if (typeof actions[action] === 'function') {
            actions[action](target.dataset, target, e);
        }
    });
}

/**
 * Declarative static and delegated event binder.
 * Keys are formatted as 'eventName' or 'eventName selector'.
 * @param {Element|Document|Window|string} root
 * @param {Record<string, Function>} eventMap
 * @returns {Function} Cleanup function
 */
export function bindEvents(root, eventMap) {
    const container = typeof root === 'string' ? document.querySelector(root) : root;
    if (!container) return () => {};

    const unbinders = [];
    for (const [key, handler] of Object.entries(eventMap)) {
        const [eventName, ...selParts] = key.trim().split(/\s+/);
        const selector = selParts.join(' ');
        if (!selector) {
            container.addEventListener(eventName, handler);
            unbinders.push(() => container.removeEventListener(eventName, handler));
        } else {
            unbinders.push(on(container, eventName, selector, handler));
        }
    }
    return () => unbinders.forEach(fn => fn());
}