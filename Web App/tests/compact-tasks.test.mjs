import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountTasks, createCompactTasks } from '../src/components/account-tasks.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = '';
        this.style = {}; this._text = ''; this.scrollTop = 0;
        const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
        this.classList = {
            contains: name => tokens().has(name),
            toggle: (name, enabled) => {
                const values = tokens();
                (enabled === undefined ? !values.has(name) : enabled) ? values.add(name) : values.delete(name);
                this.className = [...values].join(' ');
            },
        };
    }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...nodes) { nodes.forEach(node => { node.remove(); this.children.push(node); node.parentNode = this; }); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    querySelectorAll(selector) {
        const match = node => selector[0] === '.' ? node.classList.contains(selector.slice(1)) : selector === '[id]' ? Boolean(node.id) : node.tagName === selector.toUpperCase();
        return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, callback) { const entries = this.listeners.get(type) || []; entries.push(callback); this.listeners.set(type, entries); }
    dispatch(type) { (this.listeners.get(type) || []).forEach(callback => callback({ target: this })); }
}

const account = { sub: 'one', email: 'one@example.com', isPrimary: true };
const second = { sub: 'two', email: 'two@example.com', isPrimary: false };
const due = date => date + 'T00:00:00.000Z';
const taskLists = [
    { id: 'work', title: 'Work', tasks: [
        { id: 'shared-id', title: 'Work today', due: due('2026-10-17') },
        { id: 'overdue', title: 'Work overdue', due: due('2026-10-16') },
        { id: 'later', title: 'Work later', due: due('2026-10-18') },
        { id: 'undated', title: 'Work undated' },
        { id: 'done', title: 'Done today', status: 'completed', due: due('2026-10-17') },
        { id: 'old-done', title: 'Done yesterday', status: 'completed', due: due('2026-10-16') },
    ] },
    { id: 'home', title: 'Home', tasks: [
        { id: 'shared-id', title: 'Home overdue', due: due('2026-10-16') },
    ] },
];
const context = (extra = {}) => ({
    accounts: [account], day: new Date(2026, 9, 17), showCompleted: true,
    taskDateFilter: 'day-overdue', googleReady: true, linking: false,
    results: new Map([[account.sub, { tasks: taskLists }]]), ...extra,
});
const titles = element => element.querySelectorAll('.task-title').map(node => node.textContent);

function setup(t) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    return document.createElement('main');
}

test('compact tasks use one flat list with source labels and the same day filtering as grouped tasks', t => {
    setup(t);
    const before = JSON.stringify(taskLists);
    const grouped = createAccountTasks({ id: 'grouped', options: { accountId: 'one' } });
    const compact = createCompactTasks({ id: 'compact', options: { accountId: 'one' } });
    grouped.update(context()); compact.update(context());
    assert.deepEqual(titles(compact.element), ['Work today', 'Work overdue', 'Done today', 'Home overdue']);
    assert.deepEqual(titles(compact.element), titles(grouped.element));
    assert.equal(compact.element.dataset.component, 'compact-tasks');
    assert.equal(compact.element.classList.contains('compact-tasks-panel'), true);
    assert.equal(compact.element.querySelectorAll('ul').length, 1);
    assert.equal(compact.element.querySelectorAll('.task-card').length, 0);
    assert.equal(compact.element.querySelectorAll('h3').length, 0);
    assert.deepEqual(compact.element.querySelectorAll('.task-source-list').map(node => node.textContent), ['Work', 'Work', 'Work', 'Home']);
    assert.equal(grouped.element.querySelectorAll('.task-card').length, 2);
    assert.equal(grouped.element.querySelectorAll('.task-source-list').length, 0);
    assert.equal(JSON.stringify(taskLists), before);
});

test('component settings override shared date/completion preferences and scope selected lists', t => {
    setup(t);
    const selectedDay = createCompactTasks({ id: 'selected-day', options: { accountId: 'one', dateFilter: 'day', showCompleted: true } });
    selectedDay.update(context({ showCompleted: false }));
    assert.deepEqual(titles(selectedDay.element), ['Work today', 'Done today']);
    const selectedList = createCompactTasks({ id: 'selected-list', options: { accountId: 'one', taskListIds: ['home'] } });
    selectedList.update(context());
    assert.deepEqual(titles(selectedList.element), ['Home overdue']);
    const incomplete = createCompactTasks({ id: 'incomplete', options: { accountId: 'one' } });
    incomplete.update(context({ showCompleted: false }));
    assert.deepEqual(titles(incomplete.element), ['Work today', 'Work overdue', 'Home overdue']);
    const all = createCompactTasks({ id: 'all', options: { accountId: 'one', dateFilter: 'all' } });
    all.update(context());
    assert.ok(titles(all.element).includes('Work undated'));
    assert.ok(titles(all.element).includes('Work later'));
});

test('duplicate task IDs in separate lists remain separate rows and duplicate component instances have unique heading IDs', t => {
    const root = setup(t);
    const first = createCompactTasks({ id: 'same-runtime-id', options: { accountId: 'one' } });
    const preview = createCompactTasks({ id: 'same-runtime-id', options: { accountId: 'one' } });
    root.append(first.element, preview.element);
    first.update(context()); preview.update(context());
    const repeated = first.element.querySelectorAll('.task-item').filter(row => row.dataset.taskId === 'shared-id');
    assert.equal(repeated.length, 2);
    assert.deepEqual(repeated.map(row => row.dataset.taskListId), ['work', 'home']);
    const ids = root.querySelectorAll('[id]').map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.notEqual(first.element.getAttribute('aria-labelledby'), preview.element.getAttribute('aria-labelledby'));
    first.destroy();
    assert.equal(root.children.length, 1);
    assert.deepEqual(titles(preview.element), ['Work today', 'Work overdue', 'Done today', 'Home overdue']);
});

test('compact empty states retain selected day/list context without rendering an empty list', t => {
    setup(t);
    const compact = createCompactTasks({ id: 'empty', options: { accountId: 'one', taskListIds: ['missing'], showCompleted: false } });
    compact.update(context());
    assert.equal(compact.element.querySelectorAll('ul').length, 0);
    const empty = compact.element.querySelector('.empty-state');
    assert.match(empty.textContent, /No incomplete tasks due by/);
    assert.match(empty.textContent, /selected lists/);
    assert.doesNotMatch(empty.textContent, /without a due date/);
});

test('compact lists preserve scroll through refresh placeholders and respond to account availability', t => {
    setup(t);
    const compact = createCompactTasks({ id: 'scrolling', options: { accountId: 'one' } });
    compact.update(context());
    const lists = compact.element.querySelector('.task-lists');
    lists.scrollTop = 189;
    compact.update(context({ results: new Map() }));
    assert.equal(lists.getAttribute('aria-busy'), 'true');
    assert.equal(compact.element.querySelectorAll('.loading-skeleton').length, 3);
    lists.scrollTop = 0;
    compact.update(context());
    assert.equal(lists.scrollTop, 189);
    assert.equal(lists.getAttribute('aria-busy'), 'false');
    compact.update(context({ accounts: [second] }));
    assert.equal(compact.element.hidden, true);
    assert.equal(lists.children.length, 0);
    compact.update(context());
    assert.equal(compact.element.hidden, false);
    assert.equal(titles(compact.element).length, 4);
});

test('compact reconnect actions are instance scoped, honor readiness, and become inert after destruction', t => {
    const root = setup(t);
    const calls = [];
    const compact = createCompactTasks({ id: 'reconnect', options: { accountId: 'one' }, actions: { reconnect: value => calls.push(value.sub) } });
    root.append(compact.element);
    const disconnected = { ...account, needsReconnect: true };
    compact.update(context({ accounts: [disconnected], googleReady: false }));
    let button = compact.element.querySelector('.inline-reconnect');
    assert.equal(button.disabled, true);
    button.dispatch('click'); assert.deepEqual(calls, []);
    compact.update(context({ accounts: [disconnected] }));
    button = compact.element.querySelector('.inline-reconnect');
    assert.equal(button.disabled, false);
    button.dispatch('click'); assert.deepEqual(calls, ['one']);
    compact.destroy(); compact.destroy();
    button.dispatch('click'); compact.update(context());
    assert.deepEqual(calls, ['one']);
    assert.equal(root.children.length, 0);
    assert.equal(compact.element.children.length, 0);
});
