import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogs } from '../src/components/logs.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = ''; this.scrollTop = 0;
    }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error('Log values must be rendered as text.'); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...nodes) { nodes.forEach(node => { node.remove(); this.children.push(node); node.parentNode = this; }); }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    async dispatch(type, extra = {}) {
        if ((type === 'click' || type === 'change') && this.disabled) return;
        const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
        await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
    }
}
const nodes = (root, predicate) => [root, ...root.children.flatMap(child => nodes(child, predicate))].filter(predicate);
const byClass = (root, name) => nodes(root, node => node.className.split(/\s+/).includes(name));
const one = (root, name) => byClass(root, name)[0];
const inputs = root => nodes(root, node => node.tagName === 'INPUT');
const buttons = root => nodes(root, node => node.tagName === 'BUTTON');
const day = date => new Date(2026, 9, date);
const dayKey = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const checklist = () => ({ id: 'habits', name: 'Daily checklist', enabled: true, order: 0, items: [
    { id: 'read', title: 'Read a page', enabled: true, order: 0 },
    { id: 'walk', title: 'Take a walk', enabled: true, order: 1 },
    { id: 'old', title: 'Archived item', enabled: false, order: 2 },
] });
const context = extra => ({ day: day(17), customLogs: [checklist()], logs: { status: 'ready', entries: [], completions: [] }, ...extra });
function setup(t) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('duplicate widgets share supplied data without mutating it and keep independent headings and scroll', t => {
    setup(t);
    const shared = context({ logs: { status: 'ready', entries: [
        { id: 'today', type: 'food', day: '2026-10-17', time: '12:00', name: 'Today meal' },
        { id: 'other', type: 'food', day: '2026-10-16', time: '12:00', name: 'Other day meal' },
    ], completions: [] } });
    const before = JSON.stringify(shared);
    const first = createLogs({ id: 'one' }), second = createLogs({ id: 'two' });
    first.update(shared); second.update(shared);
    assert.match(first.element.textContent, /Today meal/); assert.doesNotMatch(first.element.textContent, /Other day meal/);
    assert.equal(first.element.textContent, second.element.textContent);
    assert.notEqual(first.element.getAttribute('aria-labelledby'), second.element.getAttribute('aria-labelledby'));
    one(first.element, 'logs-content').scrollTop = 180; one(second.element, 'logs-content').scrollTop = 24;
    first.update(shared); second.update(shared);
    assert.equal(one(first.element, 'logs-content').scrollTop, 180); assert.equal(one(second.element, 'logs-content').scrollTop, 24);
    assert.equal(JSON.stringify(shared), before);
    first.destroy(); assert.ok(second.element.children.length);
});

test('custom completion lookup matches the collection, item, and selected local day', t => {
    setup(t);
    const widget = createLogs({ id: 'habits', type: 'log', options: { logType: 'custom', customLogId: 'habits' } });
    const value = context({ logs: { status: 'ready', entries: [], completions: [
        { customLogId: 'habits', itemId: 'read', day: '2026-10-16', completed: true },
        { customLogId: 'habits', itemId: 'read', day: '2026-10-17', completed: false },
        { customLogId: 'other', itemId: 'read', day: '2026-10-17', completed: true },
        { customLogId: 'habits', itemId: 'walk', day: '2026-10-17', completed: true },
    ] } });
    widget.update(value);
    assert.deepEqual(inputs(widget.element).map(input => input.checked), [false, true]);
    assert.doesNotMatch(widget.element.textContent, /Archived item/);
    widget.update({ ...value, day: day(16) });
    assert.deepEqual(inputs(widget.element).map(input => input.checked), [true, false]);
    assert.equal(one(widget.element, 'logs-date').getAttribute('datetime'), '2026-10-16');
});

test('water and checklist callbacks retain the rendered day after a later context update', async t => {
    setup(t);
    const waterCalls = [], completionCalls = [];
    const widget = createLogs({ id: 'all', actions: {
        setWater: async (date, cups) => waterCalls.push([dayKey(date), cups]),
        toggleCustomLog: async (collectionId, itemId, date, checked) => completionCalls.push([collectionId, itemId, dayKey(date), checked]),
    } });
    widget.update(context({ logs: { status: 'ready', entries: [{ id: 'water', type: 'water', day: '2026-10-17', time: '12:00', cups: 2 }], completions: [] } }));
    const oldPlus = byClass(widget.element, 'water-step')[1];
    const oldCheckbox = inputs(widget.element)[0];
    widget.update(context({ day: day(18) }));
    await oldPlus.dispatch('click'); oldCheckbox.checked = true; await oldCheckbox.dispatch('change');
    assert.deepEqual(waterCalls, [['2026-10-17', 3]]);
    assert.deepEqual(completionCalls, [['habits', 'read', '2026-10-17', true]]);
});

test('add and edit actions use the selected day and exact supplied entry identity', async t => {
    setup(t);
    const added = [], edited = [];
    const entry = { id: 'meal', type: 'food', day: '2026-10-17', time: '12:00', name: '<b>Meal</b>' };
    const widget = createLogs({ id: 'food', type: 'log', options: { logType: 'food' }, actions: {
        addLog: (type, date) => added.push([type, dayKey(date)]), editLog: value => edited.push(value),
    } });
    widget.update(context({ logs: { status: 'ready', entries: [entry], completions: [] } }));
    const add = one(widget.element, 'log-add'), edit = one(widget.element, 'log-entry-button');
    widget.update(context({ day: day(18) }));
    await add.dispatch('click'); await edit.dispatch('click');
    assert.deepEqual(added, [['food', '2026-10-17']]); assert.equal(edited[0], entry);
});

test('failed checklist and water saves display visible errors and restore editable controls', async t => {
    setup(t);
    const widget = createLogs({ id: 'logs', actions: {
        toggleCustomLog: async () => { throw new Error('Checklist write failed'); },
        setWater: async () => { throw new Error('Water write failed'); },
    } });
    widget.update(context());
    const checkbox = inputs(widget.element)[0]; checkbox.checked = true;
    await checkbox.dispatch('change');
    assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
    assert.equal(one(widget.element, 'logs-notice').hidden, false);
    assert.match(one(widget.element, 'logs-notice').textContent, /Checklist write failed/);
    const plus = byClass(widget.element, 'water-step')[1]; await plus.dispatch('click');
    assert.equal(plus.disabled, false); assert.equal(one(widget.element, 'logs-notice').hidden, false);
    assert.match(one(widget.element, 'logs-notice').textContent, /Water write failed/);
});

test('layout previews disable every write and management control, including error retry', async t => {
    setup(t);
    let calls = 0;
    const actions = Object.fromEntries(['setWater', 'toggleCustomLog', 'addLog', 'editLog', 'manageLogs', 'refreshLogs'].map(key => [key, () => { calls++; }]));
    const widget = createLogs({ id: 'preview', actions });
    widget.update(context({ isLayoutPreview: true }));
    assert.equal(buttons(widget.element).every(button => button.disabled), true);
    assert.equal(inputs(widget.element).every(input => input.disabled), true);
    for (const button of buttons(widget.element)) await button.dispatch('click');
    assert.equal(calls, 0);
    widget.update(context({ isLayoutPreview: true, logs: { status: 'error', error: 'Offline', entries: [], completions: [] } }));
    assert.equal(buttons(widget.element).every(button => button.disabled), true);
    for (const button of buttons(widget.element)) await button.dispatch('click');
    assert.equal(calls, 0);
});

test('unconfigured and loading views show unavailable values instead of fabricated zero water measurements', t => {
    setup(t);
    const widget = createLogs({ id: 'water', type: 'log', options: { logType: 'water' } });
    for (const status of ['loading', 'unconfigured']) {
        widget.update(context({ customLogs: [], logs: { status, entries: [], completions: [] } }));
        assert.equal(one(widget.element, 'water-amount').textContent, '— cups');
        assert.doesNotMatch(widget.element.textContent, /0 cups/);
        assert.equal(byClass(widget.element, 'water-step').every(button => button.disabled), true);
        assert.equal(byClass(widget.element, 'water-drop').every(button => button.disabled), true);
        assert.equal(one(widget.element, 'logs-notice').hidden, false);
    }
    widget.update(context({ logs: { status: 'ready', entries: [], completions: [] } }));
    assert.equal(one(widget.element, 'water-amount').textContent, '0 cups');
});

test('retry errors are caught and teardown ignores pending action failures', async t => {
    setup(t);
    const retry = createLogs({ id: 'retry', actions: { refreshLogs: async () => {
        retry.update(context({ logs: { status: 'error', error: 'Retry failed' } }));
        throw new Error('Retry failed');
    } } });
    retry.update(context({ logs: { status: 'error', error: 'Offline' } }));
    await buttons(one(retry.element, 'logs-notice'))[0].dispatch('click');
    assert.match(one(retry.element, 'logs-notice').textContent, /Retry failed/);
    const pending = deferred();
    const widget = createLogs({ id: 'pending', type: 'log', options: { logType: 'water' }, actions: { setWater: () => pending.promise } });
    widget.update(context()); const notice = one(widget.element, 'logs-notice');
    const saving = byClass(widget.element, 'water-step')[1].dispatch('click');
    widget.destroy(); widget.destroy(); pending.reject(new Error('Late failure')); await saving;
    assert.equal(widget.element.children.length, 0); assert.equal(notice.textContent, '');
    widget.update(context()); assert.equal(widget.element.children.length, 0);
});

test('a failed retry preserves the controller-rendered Connect Google button and permits another sign-in attempt', async t => {
    setup(t);
    let refreshes = 0, signIns = 0;
    const widget = createLogs({ id: 'retry-sign-in', actions: {
        refreshLogs: async () => {
            refreshes++;
            widget.update(context({ logs: { status: 'error', error: 'Connect your primary Google account.', needsSignIn: true, entries: [], completions: [] } }));
            throw new Error('The existing credential was rejected');
        },
        connectLogs: async () => {
            signIns++;
            widget.update(context({ logs: { status: 'error', error: 'Cloud sign-in was cancelled. You can try again.', needsSignIn: true, entries: [], completions: [] } }));
            throw new Error('Popup closed');
        },
    } });
    widget.update(context({ logs: { status: 'error', error: 'Connection unavailable', needsSignIn: false } }));
    const tryAgain = buttons(one(widget.element, 'logs-notice'))[0];
    assert.equal(tryAgain.textContent, 'Try again');
    await tryAgain.dispatch('click');
    assert.equal(refreshes, 1);
    let notice = one(widget.element, 'logs-notice');
    assert.match(notice.textContent, /Connect your primary Google account/);
    let connect = buttons(notice)[0];
    assert.ok(connect); assert.equal(connect.textContent, 'Connect Google'); assert.equal(connect.disabled, false);
    await connect.dispatch('click');
    assert.equal(signIns, 1);
    notice = one(widget.element, 'logs-notice');
    assert.match(notice.textContent, /Cloud sign-in was cancelled/);
    connect = buttons(notice)[0];
    assert.ok(connect); assert.equal(connect.textContent, 'Connect Google'); assert.equal(connect.disabled, false);
    await connect.dispatch('click');
    assert.equal(signIns, 2);
});
