import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogManager } from '../src/components/log-dialogs.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = ''; this.open = false;
        const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
        this.classList = { toggle: (name, force) => { const values = classes(); const enabled = force === undefined ? !values.has(name) : force; enabled ? values.add(name) : values.delete(name); this.className = [...values].join(' '); } };
    }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error('User log definitions must not be interpreted as HTML.'); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...nodes) { nodes.forEach(node => { node.remove(); this.children.push(node); node.parentNode = this; }); }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(type, listener, options = {}) { const list = this.listeners.get(type) || []; list.push({ listener, options }); this.listeners.set(type, list); }
    async dispatch(type, extra = {}) {
        const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
        await Promise.all((this.listeners.get(type) || []).filter(value => !value.options.signal?.aborted).map(value => value.listener(event)));
    }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
}
function nodes(root, predicate) { return [root, ...root.children.flatMap(child => nodes(child, predicate))].filter(predicate); }
function byClass(root, name) { return nodes(root, node => node.className.split(/\s+/).includes(name)); }
function one(root, name) { return byClass(root, name)[0]; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const fullDefinition = () => ({ id: 'habits', name: 'Daily habits', enabled: true, order: 0, items: [
    { id: 'read', title: 'Read', enabled: true, order: 0 }, { id: 'walk', title: 'Walk', enabled: true, order: 1 },
] });
function setup(t, { customLogs = [fullDefinition()], status = 'ready', save } = {}) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    const context = { customLogs, logs: { status } };
    const saved = [], deleted = [];
    const root = document.createElement('div');
    const manager = createLogManager({ root, getContext: () => context, actions: {
        saveCustomLog: async value => { saved.push(value); if (save) await save(value); },
        deleteCustomLog: async id => { deleted.push(id); },
    } });
    return { root, manager, context, saved, deleted, get dialog() { return one(root, 'log-manager-dialog'); } };
}
async function type(input, value) { input.value = value; await input.dispatch('input'); }

test('layout-only custom names can become cloud checklists without changing identity or mutating source', async t => {
    const metadata = [{ id: 'legacy-id', name: 'Legacy name' }];
    const app = setup(t, { customLogs: metadata }); app.manager.open('legacy-id');
    assert.equal(app.dialog.open, true);
    assert.equal(one(app.root, 'log-manager-name').value, 'Legacy name');
    await one(app.root, 'log-manager-add-item').dispatch('click');
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    await type(one(app.root, 'log-manager-item-title'), '  A daily check  ');
    await type(one(app.root, 'log-manager-name'), '  Renamed collection  ');
    assert.deepEqual(metadata, [{ id: 'legacy-id', name: 'Legacy name' }]);
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.dialog.open, false);
    assert.equal(app.saved[0].id, 'legacy-id'); assert.equal(app.saved[0].name, 'Renamed collection');
    assert.equal(app.saved[0].enabled, true); assert.equal(app.saved[0].order, 0);
    assert.equal(app.saved[0].items[0].title, 'A daily check'); assert.ok(app.saved[0].items[0].id);
});

test('new collections have independent identities with no two-collection limit', async t => {
    const app = setup(t, { customLogs: [fullDefinition(), { id: 'second', name: 'Second collection', items: [] }] });
    app.manager.open(); await one(app.root, 'log-manager-new').dispatch('click');
    await type(one(app.root, 'log-manager-name'), '<b>Third collection</b>');
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved.length, 1); assert.equal(app.saved[0].name, '<b>Third collection</b>');
    assert.equal(app.saved[0].order, 2); assert.notEqual(app.saved[0].id, 'habits'); assert.notEqual(app.saved[0].id, 'second');
});

test('rename, collection visibility, item visibility, and reorder save a separate definition draft', async t => {
    const original = fullDefinition(); const before = JSON.stringify(original);
    const app = setup(t, { customLogs: [original] }); app.manager.open('habits');
    await type(one(app.root, 'log-manager-name'), 'My habits');
    const collectionToggle = nodes(one(app.root, 'log-manager-editor'), node => node.tagName === 'INPUT' && node.type === 'checkbox')[0];
    collectionToggle.checked = false; await collectionToggle.dispatch('change');
    let rows = byClass(app.root, 'log-manager-item');
    const itemToggle = nodes(rows[0], node => node.tagName === 'INPUT' && node.type === 'checkbox')[0];
    itemToggle.checked = false; await itemToggle.dispatch('change');
    assert.equal(one(rows[0], 'log-manager-item-archive').textContent, 'Restore');
    await one(rows[1], 'log-manager-item-up').dispatch('click');
    rows = byClass(app.root, 'log-manager-item'); assert.equal(rows[0].dataset.itemId, 'walk');
    assert.equal(JSON.stringify(original), before);
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved[0].name, 'My habits'); assert.equal(app.saved[0].enabled, false);
    assert.deepEqual(app.saved[0].items.map(item => [item.id, item.enabled, item.order]), [['walk', true, 0], ['read', false, 1]]);
    assert.equal(app.deleted.length, 0);
});

test('archiving an item preserves its identity and history instead of deleting its definition', async t => {
    const app = setup(t); app.manager.open('habits');
    await one(app.root, 'log-manager-item-archive').dispatch('click');
    assert.equal(byClass(app.root, 'log-manager-item').length, 2);
    assert.match(one(app.root, 'log-manager-status').textContent, /historical entries are retained/);
    assert.match(one(app.root, 'log-manager-history-note').textContent, /Restore it at any time/);
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved[0].items[0].id, 'read'); assert.equal(app.saved[0].items[0].enabled, false);
    assert.equal(app.saved[0].items.length, 2); assert.equal(app.deleted.length, 0);
});

test('a newly added unsaved row can be removed without blocking the rest of the collection', async t => {
    const app = setup(t); app.manager.open('habits');
    await one(app.root, 'log-manager-add-item').dispatch('click');
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    const added = byClass(app.root, 'log-manager-item')[2];
    assert.equal(one(added, 'log-manager-item-archive').textContent, 'Remove');
    await one(added, 'log-manager-item-archive').dispatch('click');
    assert.equal(byClass(app.root, 'log-manager-item').length, 2);
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.deepEqual(app.saved[0].items.map(item => item.id), ['read', 'walk']);
    assert.equal(app.deleted.length, 0);
});

test('cancel discards edits and dirty collection switching requires an explicit discard choice', async t => {
    const app = setup(t, { customLogs: [fullDefinition(), { id: 'second', name: 'Other', items: [] }] });
    app.manager.open('habits'); await type(one(app.root, 'log-manager-name'), 'Unsaved name');
    await byClass(app.root, 'log-manager-collection')[1].dispatch('click');
    const prompt = one(app.root, 'log-manager-discard'); assert.equal(prompt.hidden, false);
    assert.equal(one(app.root, 'log-manager-name').value, 'Unsaved name');
    await nodes(prompt, node => node.tagName === 'BUTTON')[0].dispatch('click');
    assert.equal(prompt.hidden, true);
    await byClass(app.root, 'log-manager-collection')[1].dispatch('click');
    await nodes(prompt, node => node.tagName === 'BUTTON')[1].dispatch('click');
    assert.equal(one(app.root, 'log-manager-name').value, 'Other');
    await type(one(app.root, 'log-manager-name'), 'Another unsaved name');
    await one(app.root, 'log-manager-close').dispatch('click');
    assert.equal(app.dialog.open, false); assert.equal(app.saved.length, 0);
    app.manager.open('second'); assert.equal(one(app.root, 'log-manager-name').value, 'Other');
});

test('failed save keeps the draft open and available for retry while pending saves disable edits', async t => {
    let fail = true; const pending = deferred(); let first = true;
    const app = setup(t, { save: async () => { if (first) { first = false; await pending.promise; } if (fail) throw new Error('Cloud write failed'); } });
    app.manager.open('habits'); await type(one(app.root, 'log-manager-name'), 'Keep my draft');
    const saving = one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    assert.equal(one(app.root, 'log-manager-name').disabled, true);
    assert.equal(one(app.root, 'log-manager-close').disabled, true);
    pending.resolve(); await saving;
    assert.equal(app.dialog.open, true); assert.equal(one(app.root, 'log-manager-name').value, 'Keep my draft');
    assert.match(one(app.root, 'log-manager-status').textContent, /Cloud write failed/);
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
    fail = false; await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.dialog.open, false); assert.equal(app.saved.length, 2);
});

test('remote changes to a selected collection block stale saves while retaining the local draft for review', async t => {
    const app = setup(t); app.manager.open('habits');
    await type(one(app.root, 'log-manager-name'), 'My unsaved collection name');
    const remote = fullDefinition();
    remote.items = [
        { id: 'walk', title: 'A longer walk from another device', enabled: false, order: 0 },
        { id: 'read', title: 'Read the new chapter', enabled: true, order: 1 },
    ];
    app.context.customLogs = [remote]; app.manager.update(app.context);
    assert.equal(one(app.root, 'log-manager-name').value, 'My unsaved collection name');
    assert.deepEqual(byClass(app.root, 'log-manager-item-title').map(input => input.value), ['Read', 'Walk']);
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    assert.match(one(app.root, 'log-manager-status').textContent, /changed on another device/);
    assert.match(one(app.root, 'log-manager-status').textContent, /Close and reopen/);
    await type(one(app.root, 'log-manager-name'), 'Keep this draft for review');
    assert.match(one(app.root, 'log-manager-status').textContent, /unsaved changes are still here/);
    await one(app.root, 'log-manager-item-archive').dispatch('click');
    assert.match(one(app.root, 'log-manager-status').textContent, /changed on another device/);
    // The handler also rejects a stale programmatic click on the disabled Save.
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved.length, 0); assert.equal(app.dialog.open, true);
    assert.equal(one(app.root, 'log-manager-name').value, 'Keep this draft for review');
    await one(app.root, 'log-manager-close').dispatch('click'); app.manager.open('habits');
    assert.equal(one(app.root, 'log-manager-name').value, 'Daily habits');
    assert.deepEqual(byClass(app.root, 'log-manager-item-title').map(input => input.value), ['A longer walk from another device', 'Read the new chapter']);
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
    await type(one(app.root, 'log-manager-name'), 'A fresh rename');
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved.length, 1);
    assert.deepEqual(app.saved[0].items, remote.items);
});

test('remote changes to other collections do not block a selected draft and clean drafts refresh safely', async t => {
    const app = setup(t, { customLogs: [fullDefinition(), { id: 'other', name: 'Other collection', items: [] }] });
    app.manager.open('habits'); await type(one(app.root, 'log-manager-name'), 'Local rename');
    app.context.customLogs = [fullDefinition(), { id: 'other', name: 'Remote rename elsewhere', items: [] }];
    app.manager.update(app.context);
    assert.equal(one(app.root, 'log-manager-name').value, 'Local rename');
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
    await one(app.root, 'log-manager-save').dispatch('click'); assert.equal(app.saved[0].name, 'Local rename');
    app.manager.open('habits');
    const remote = fullDefinition(); remote.items[0].title = 'Clean draft refreshed';
    app.context.customLogs = [remote]; app.manager.update(app.context);
    assert.equal(one(app.root, 'log-manager-item-title').value, 'Clean draft refreshed');
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
});

test('remotely removed selected definitions cannot be recreated from an old dirty draft', async t => {
    const app = setup(t); app.manager.open('habits');
    await type(one(app.root, 'log-manager-name'), 'Do not recreate');
    app.context.customLogs = []; app.manager.update(app.context);
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    await one(app.root, 'log-manager-save').dispatch('click');
    assert.equal(app.saved.length, 0); assert.equal(one(app.root, 'log-manager-name').value, 'Do not recreate');
    assert.match(one(app.root, 'log-manager-status').textContent, /load the latest version/);
});

test('loading, error, and unconfigured states prevent writes without erasing a draft', async t => {
    const app = setup(t, { status: 'loading' }); app.manager.open('habits');
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    assert.match(one(app.root, 'log-manager-state').textContent, /Loading/);
    await type(one(app.root, 'log-manager-name'), 'Still editing');
    app.manager.update({ ...app.context, logs: { status: 'error', error: 'Connection unavailable' } });
    assert.match(one(app.root, 'log-manager-state').textContent, /Connection unavailable/);
    assert.equal(one(app.root, 'log-manager-save').disabled, true);
    app.manager.update({ ...app.context, logs: { status: 'unconfigured' } });
    assert.match(one(app.root, 'log-manager-state').textContent, /not configured/);
    assert.equal(one(app.root, 'log-manager-name').value, 'Still editing');
    app.manager.update({ ...app.context, logs: { status: 'ready' } });
    assert.equal(one(app.root, 'log-manager-save').disabled, false);
});

test('destroy ignores pending save completion and removes the dialog permanently', async t => {
    const pending = deferred(); const app = setup(t, { save: () => pending.promise });
    app.manager.open('habits'); const saving = one(app.root, 'log-manager-save').dispatch('click');
    app.manager.destroy(); app.manager.destroy(); assert.equal(app.root.children.length, 0);
    pending.reject(new Error('Late failure')); await saving;
    assert.equal(app.root.children.length, 0);
    app.manager.open('habits'); app.manager.update(app.context); assert.equal(app.root.children.length, 0);
});
