import assert from 'node:assert/strict';
import { test } from 'node:test';
class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; this._text = ''; this.style = { setProperty(name, value) { this[name] = value; } }; this.ownerDocument = globalThis.document; this.open = false; this.value = ''; this.clientWidth = 1000; this.clientHeight = 800; this.captures = new Set();
        const values = () => new Set(this.className.split(/\s+/).filter(Boolean));
        this.classList = { contains: x => values().has(x), add: (...xs) => { const set = values(); xs.forEach(x => set.add(x)); this.className = [...set].join(' '); }, remove: (...xs) => { const set = values(); xs.forEach(x => set.delete(x)); this.className = [...set].join(' '); }, toggle: (x, on) => { const set = values(); const yes = on === undefined ? !set.has(x) : on; yes ? set.add(x) : set.delete(x); this.className = [...set].join(' '); } };
    }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    insertBefore(node, reference) { node.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, node); node.parentNode = this; return node; }
    append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { const match = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector === '[data-fit]' ? node.dataset.fit : false; return this.children.flatMap(child => [ ...(match(child) ? [child] : []), ...child.querySelectorAll(selector) ]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener, options = {}) { const list = this.listeners.get(type) || []; list.push({ listener, options }); this.listeners.set(type, list); }
    async dispatch(type, data = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...data }; await Promise.all((this.listeners.get(type) || []).filter(item => !item.options.signal?.aborted).map(item => item.listener(event))); }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }; }
}
test('editor drafts, keyboard movement, cancellation, collision rejection, save failure and retry', async () => {
const previousDocument = globalThis.document;
try {
globalThis.document = { activeElement: null, createElement: tag => new Element(tag) };
const { createLayoutEditor } = await import('../src/components/layout-editor.mjs');
const root = document.createElement('div');
const original = { version: 2, id: 'day', name: 'My day', canvas: { width: 1000, height: 800 }, widgets: [{ id: 'timeline', type: 'timeline', x: 0, y: 0, width: 300, height: 400, options: {} }] };
const context = { accounts: [{ sub: 'primary', email: 'one@example.com', isPrimary: true }], day: new Date(2026, 9, 17), results: new Map(), googleReady: true };
let saved = null, fail = false, saveCalls = 0;
const factory = () => ({ element: document.createElement('section'), update(next) { assert.equal(next.googleReady, false); }, destroy() {} });
const editor = createLayoutEditor({ root, getLayout: () => original, getContext: () => context, registry: new Map([['timeline', factory], ['account-tasks', factory]]), onSave: value => { saveCalls++; if (fail) throw new Error('Storage unavailable'); saved = value; } });
editor.open(); assert.equal(editor.isOpen(), true); assert.equal(saveCalls, 0);
const dialog = root.children[0];
let handle = root.querySelector('.layout-editor-drag-handle');
await handle.dispatch('click'); handle.focus();
await dialog.dispatch('keydown', { target: handle, key: 'ArrowRight' });
handle = document.activeElement;
await dialog.dispatch('keydown', { target: handle, key: 'ArrowRight', shiftKey: true });
assert.equal(root.querySelector('.layout-editor-widget').style.left, '11px');
assert.equal(original.widgets[0].x, 0);
const undo = root.querySelector('.layout-editor-history').children[0];
await undo.dispatch('click'); assert.equal(root.querySelector('.layout-editor-widget').style.left, '1px');
await root.querySelector('.layout-editor-history').children[1].dispatch('click'); assert.equal(root.querySelector('.layout-editor-widget').style.left, '11px');
// Keyboard add uses the palette without fetching or mutating the live layout.
const cards = root.querySelectorAll('.layout-editor-palette-card');
await cards[1].dispatch('click', { detail: 0 });
assert.equal(root.querySelectorAll('.layout-editor-widget').length, 2);
assert.equal(original.widgets.length, 1);
// A colliding drag keeps its initial placement and provides an error.
let frames = root.querySelectorAll('.layout-editor-widget');
const second = frames[1]; const secondLeft = second.style.left, secondTop = second.style.top;
const surface = root.querySelector('.layout-editor-surface');
await second.querySelector('.layout-editor-drag-handle').dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
await surface.dispatch('pointermove', { pointerId: 1, clientX: -Number.parseFloat(secondLeft), clientY: -Number.parseFloat(secondTop) });
assert.equal(root.querySelector('.layout-editor-ghost').classList.contains('is-invalid'), true);
await surface.dispatch('pointerup', { pointerId: 1 });
frames = root.querySelectorAll('.layout-editor-widget'); assert.equal(frames[1].style.left, secondLeft); assert.equal(frames[1].style.top, secondTop);
// Pointer cancellation never commits a draft change.
await frames[1].querySelector('.layout-editor-drag-handle').dispatch('pointerdown', { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
await surface.dispatch('pointermove', { pointerId: 2, clientX: 50, clientY: 20 });
await surface.dispatch('pointercancel', { pointerId: 2 });
assert.equal(root.querySelector('.layout-editor-ghost').hidden, true);
assert.equal(root.querySelectorAll('.layout-editor-widget')[1].style.left, secondLeft);
// Failed persistence leaves the modal and private draft intact for retry.
fail = true;
await root.querySelector('.layout-editor-save').dispatch('click');
assert.equal(editor.isOpen(), true); assert.match(root.querySelector('.layout-editor-status').textContent, /Storage unavailable/);
fail = false; await root.querySelector('.layout-editor-save').dispatch('click');
assert.equal(editor.isOpen(), false); assert.equal(saved.widgets.length, 2); assert.equal(saved.widgets[0].x, 11);
editor.open(); assert.equal(root.querySelectorAll('.layout-editor-widget').length, 1);
await root.querySelector('.layout-editor-cancel').dispatch('click');
assert.equal(editor.isOpen(), false); assert.equal(original.widgets.length, 1);
editor.destroy(); assert.equal(root.children.length, 0); editor.open(); assert.equal(root.children.length, 0);
} finally { globalThis.document = previousDocument; }
});
