import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerLayout } from '../src/layout/layout-renderer.mjs';

// A small tree implementation exercises DOM movement and ownership without a browser.
class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.className = '';
        this.textContent = '';
        const properties = new Map();
        this.style = {
            setProperty(name, value) { properties.set(name, String(value)); },
            getPropertyValue(name) { return properties.get(name) || ''; },
        };
        const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
        this.classList = {
            contains: name => tokens().has(name),
            add: (...names) => { const next = tokens(); names.forEach(name => next.add(name)); this.className = [...next].join(' '); },
            remove: (...names) => { const next = tokens(); names.forEach(name => next.delete(name)); this.className = [...next].join(' '); },
            toggle: (name, force) => {
                const enabled = force === undefined ? !tokens().has(name) : Boolean(force);
                this.classList[enabled ? 'add' : 'remove'](name);
                return enabled;
            },
        };
    }

    insertBefore(node, reference) {
        if (node === reference) return node;
        if (reference !== null && !this.children.includes(reference)) throw new Error('Reference is not a child.');
        node.remove();
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        this.children.splice(index, 0, node);
        node.parentNode = this;
        return node;
    }

    append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }

    remove() {
        if (!this.parentNode) return;
        const parent = this.parentNode;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentNode = null;
    }

    replaceChildren(...nodes) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this.append(...nodes);
    }
}

const primary = { sub: 'primary', email: 'one@example.com', isPrimary: true };
const secondary = { sub: 'secondary', email: 'two@example.com', isPrimary: false };
const context = (accounts = [primary], extra = {}) => ({ accounts, day: new Date(2026, 9, 17), results: new Map(), ...extra });
const clone = value => JSON.parse(JSON.stringify(value));

function definition() {
    return {
        version: 1, id: 'daily', name: 'Test layout',
        columns: [
            { id: 'schedule', width: 260, widgets: [
                { id: 'morning', type: 'timeline', options: { initialHour: 7, hourHeight: 76 } },
                { id: 'evening', type: 'timeline', options: { initialHour: 18, hourHeight: 76 } },
            ] },
            { id: 'work', size: 2, widgets: [
                { id: 'tasks', type: 'account-tasks', options: { accountId: '$primary' } },
            ] },
        ],
    };
}

function canvasDefinition() {
    return {
        version: 2, id: 'daily', name: 'Freeform day', canvas: { width: 1440, height: 1100 },
        widgets: [
            { id: 'morning', type: 'timeline', x: 32, y: 48, width: 280, height: 600,
                options: { initialHour: 7, hourHeight: 76 } },
            { id: 'evening', type: 'timeline', x: 700, y: 680, width: 300, height: 260,
                options: { initialHour: 18, hourHeight: 76 } },
            { id: 'tasks', type: 'account-tasks', x: 400, y: 48, width: 500, height: 480,
                options: { accountId: '$primary' } },
        ],
    };
}

function setup(t, layout = definition()) {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: tag => new FakeElement(tag) };
    t.after(() => {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    });
    const created = [];
    const registry = new Map(['timeline', 'account-tasks'].map(type => [type, ({ id, options, actions }) => {
        const record = { type, id, options, actions, element: document.createElement('section'), updates: [], ticks: [], destroyCalls: 0 };
        created.push(record);
        return {
            element: record.element,
            update: next => record.updates.push(next),
            tick: next => record.ticks.push(next),
            destroy: () => { record.destroyCalls++; record.element.remove(); },
        };
    }]));
    const root = document.createElement('main');
    const actions = { reconnect() {} };
    const renderer = createPlannerLayout({ root, registry, layout, actions });
    const active = id => created.findLast(record => record.id === id && !record.destroyCalls);
    return { root, actions, created, renderer, active };
}

test('multiple instances of one widget type receive updates and have independent lifecycles', t => {
    const app = setup(t);
    const first = context();
    app.renderer.update(first);
    assert.equal(app.created.length, 3);
    const morning = app.active('daily:morning');
    const evening = app.active('daily:evening');
    const tasks = app.active('daily:tasks');
    assert.notEqual(morning.element, evening.element);
    assert.notEqual(morning.id, evening.id);
    assert.equal(morning.options.initialHour, 7);
    assert.equal(evening.options.initialHour, 18);
    assert.equal(tasks.options.accountId, primary.sub);
    app.created.forEach(record => {
        assert.deepEqual(record.updates, [first]);
        assert.equal(record.actions, app.actions);
    });

    const second = context([primary], { showCompleted: false });
    app.renderer.update(second);
    app.renderer.tick();
    app.created.forEach(record => {
        assert.deepEqual(record.updates, [first, second]);
        assert.deepEqual(record.ticks, [second]);
    });
    const nextLayout = definition();
    nextLayout.columns[0].widgets.shift();
    app.renderer.setLayout(nextLayout);
    assert.equal(morning.destroyCalls, 1);
    assert.equal(morning.element.parentNode, null);
    assert.equal(evening.destroyCalls, 0);
    assert.equal(app.active(evening.id), evening);
    assert.equal(app.root.children[0].children[0].children[0], evening.element);

    app.renderer.destroy();
    assert.equal(morning.destroyCalls, 1);
    assert.equal(evening.destroyCalls, 1);
    assert.equal(tasks.destroyCalls, 1);
    assert.equal(app.root.children.length, 0);
    const updateCounts = app.created.map(record => record.updates.length);
    const tickCounts = app.created.map(record => record.ticks.length);
    app.renderer.update(first);
    app.renderer.tick(first);
    app.renderer.destroy();
    assert.deepEqual(app.created.map(record => record.updates.length), updateCounts);
    assert.deepEqual(app.created.map(record => record.ticks.length), tickCounts);
    assert.ok(app.created.every(record => record.destroyCalls === 1));
});

test('reordering columns and widgets moves their existing elements without remounting', t => {
    const app = setup(t);
    app.renderer.update(context());
    const originalColumns = [...app.root.children];
    const originalFrames = [...originalColumns[0].children];
    const instances = [...app.created];
    const nextLayout = definition();
    nextLayout.columns[0].widgets.reverse();
    nextLayout.columns.reverse();
    app.renderer.setLayout(nextLayout);
    assert.equal(app.created.length, 3);
    assert.deepEqual(app.root.children, [originalColumns[1], originalColumns[0]]);
    assert.deepEqual(originalColumns[0].children, [originalFrames[1], originalFrames[0]]);
    instances.forEach(record => {
        assert.equal(record.destroyCalls, 0);
        assert.equal(app.active(record.id), record);
        assert.equal(record.updates.length, 2);
    });
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['work', 'schedule']);
    assert.deepEqual(originalColumns[0].children.map(frame => frame.dataset.widgetId), ['daily:evening', 'daily:morning']);
});

test('moving a widget between columns preserves its component instance and scroll position', t => {
    const app = setup(t);
    app.renderer.update(context());
    const morning = app.active('daily:morning');
    const evening = app.active('daily:evening');
    const tasks = app.active('daily:tasks');
    const morningFrame = morning.element.parentNode;
    morning.element.scrollTop = 437;
    evening.element.scrollTop = 912;
    tasks.element.scrollTop = 123;
    const movedLayout = definition();
    const movedWidget = movedLayout.columns[0].widgets.shift();
    movedLayout.columns[1].widgets.push(movedWidget);
    app.renderer.setLayout(movedLayout);
    assert.equal(app.created.length, 3);
    assert.equal(app.active(morning.id), morning);
    assert.equal(morning.element.parentNode, morningFrame);
    assert.equal(app.root.children[1].children[1], morningFrame);
    assert.equal(morning.element.scrollTop, 437);
    assert.equal(evening.element.scrollTop, 912);
    assert.equal(tasks.element.scrollTop, 123);
    assert.ok(app.created.every(record => record.destroyCalls === 0));
    assert.deepEqual(app.root.children[0].children.map(frame => frame.dataset.widgetId), ['daily:evening']);
    assert.deepEqual(app.root.children[1].children.map(frame => frame.dataset.widgetId), ['daily:tasks', 'daily:morning']);
});

test('changing an option remounts only that widget and passes its new options', t => {
    const app = setup(t);
    const current = context();
    app.renderer.update(current);
    const original = [...app.created];
    const previousEvening = app.active('daily:evening');
    const nextLayout = definition();
    nextLayout.columns[0].widgets[1].options.hourHeight = 96;
    app.renderer.setLayout(nextLayout);
    const nextEvening = app.active(previousEvening.id);
    assert.equal(app.created.length, 4);
    assert.notEqual(nextEvening, previousEvening);
    assert.equal(previousEvening.destroyCalls, 1);
    assert.equal(previousEvening.element.parentNode, null);
    assert.equal(nextEvening.options.hourHeight, 96);
    assert.equal(nextEvening.actions, app.actions);
    assert.deepEqual(nextEvening.updates, [current]);
    original.filter(record => record !== previousEvening).forEach(record => {
        assert.equal(app.active(record.id), record);
        assert.equal(record.destroyCalls, 0);
    });
    assert.equal(app.root.children[0].children[1].children[0], nextEvening.element);
    const nextContext = context([primary], { showCompleted: true });
    app.renderer.update(nextContext);
    assert.deepEqual(nextEvening.updates, [current, nextContext]);
    assert.equal(previousEvening.updates.length, 1);
});

test('account-repeated columns add, reorder and destroy only the affected account instances', t => {
    const layout = definition();
    layout.columns[0].widgets = layout.columns[0].widgets.slice(0, 1);
    layout.columns[1] = { id: 'account', repeat: 'accounts', size: 1, widgets: [
        { id: 'tasks', type: 'account-tasks', options: { accountId: '$account' } },
    ] };
    const app = setup(t, layout);
    app.renderer.update(context());
    assert.equal(app.created.length, 2);
    const timeline = app.active('daily:morning');
    const primaryTasks = app.active('daily:tasks:primary');
    assert.equal(primaryTasks.options.accountId, primary.sub);
    app.renderer.update(context([primary, secondary]));
    assert.equal(app.created.length, 3);
    const secondaryTasks = app.active('daily:tasks:secondary');
    assert.equal(secondaryTasks.options.accountId, secondary.sub);
    assert.equal(app.active(primaryTasks.id), primaryTasks);
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['schedule', 'account:primary', 'account:secondary']);

    app.renderer.update(context([secondary, primary]));
    assert.equal(app.created.length, 3);
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['schedule', 'account:secondary', 'account:primary']);
    assert.equal(app.active(secondaryTasks.id), secondaryTasks);
    assert.equal(app.active(primaryTasks.id), primaryTasks);
    app.renderer.update(context([primary]));
    assert.equal(secondaryTasks.destroyCalls, 1);
    assert.equal(primaryTasks.destroyCalls, 0);
    assert.equal(timeline.destroyCalls, 0);
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['schedule', 'account:primary']);

    app.renderer.update(context([primary, secondary]));
    assert.equal(app.created.length, 4);
    const restoredSecondary = app.active(secondaryTasks.id);
    assert.notEqual(restoredSecondary, secondaryTasks);
    assert.equal(restoredSecondary.options.accountId, secondary.sub);
    app.renderer.update(context([]));
    assert.equal(primaryTasks.destroyCalls, 1);
    assert.equal(restoredSecondary.destroyCalls, 1);
    assert.equal(secondaryTasks.destroyCalls, 1);
    assert.equal(timeline.destroyCalls, 0);
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['schedule']);
});

test('column widths, flexible sizes and widget heights follow config without remounting', t => {
    const layout = definition();
    layout.columns[0].width = 320;
    layout.columns[0].widgets[0].height = 420;
    layout.columns[0].widgets[1].flex = 2;
    layout.columns[1].size = 3;
    const app = setup(t, layout);
    app.renderer.update(context());
    const [schedule, work] = app.root.children;
    const [fixed, flexible] = schedule.children;
    assert.equal(app.root.classList.contains('layout-canvas'), true);
    assert.equal(schedule.style.getPropertyValue('--column-width'), '320px');
    assert.equal(schedule.style.getPropertyValue('--column-size'), '1');
    assert.equal(schedule.classList.contains('fixed-column'), true);
    assert.equal(work.style.getPropertyValue('--column-width'), 'auto');
    assert.equal(work.style.getPropertyValue('--column-size'), '3');
    assert.equal(work.classList.contains('fixed-column'), false);
    assert.equal(fixed.style.flex, '0 0 420px');
    assert.equal(fixed.style.getPropertyValue('--widget-height'), '420px');
    assert.equal(fixed.classList.contains('fixed-widget-height'), true);
    assert.equal(flexible.style.flex, '2 1 0');
    assert.equal(flexible.style.getPropertyValue('--widget-height'), 'auto');
    assert.equal(flexible.classList.contains('fixed-widget-height'), false);
    assert.equal(fixed.dataset.widgetType, 'timeline');
    assert.equal(work.children[0].dataset.widgetType, 'account-tasks');

    const resized = clone(layout);
    delete resized.columns[0].width;
    resized.columns[0].size = 4;
    delete resized.columns[0].widgets[0].height;
    resized.columns[0].widgets[0].flex = 1.5;
    resized.columns[0].widgets[1].height = 200;
    app.renderer.setLayout(resized);
    assert.equal(app.created.length, 3);
    assert.ok(app.created.every(record => record.destroyCalls === 0));
    assert.equal(schedule.style.getPropertyValue('--column-width'), 'auto');
    assert.equal(schedule.style.getPropertyValue('--column-size'), '4');
    assert.equal(schedule.classList.contains('fixed-column'), false);
    assert.equal(fixed.style.flex, '1.5 1 0');
    assert.equal(fixed.style.getPropertyValue('--widget-height'), 'auto');
    assert.equal(fixed.classList.contains('fixed-widget-height'), false);
    assert.equal(flexible.style.flex, '0 0 200px');
    assert.equal(flexible.classList.contains('fixed-widget-height'), true);
});

test('canvas layouts preserve precise frame dimensions, offsets, and intentional whitespace', t => {
    const layout = canvasDefinition();
    const app = setup(t, layout);
    app.renderer.update(context());
    assert.equal(app.root.classList.contains('layout-canvas'), true);
    assert.equal(app.root.classList.contains('freeform-layout'), true);
    assert.equal(app.root.style.getPropertyValue('--canvas-width'), '1440px');
    assert.equal(app.root.style.getPropertyValue('--canvas-height'), '1100px');
    assert.equal(app.root.children.length, 3);
    assert.deepEqual(app.root.children.map(frame => frame.dataset.widgetId), ['daily:morning', 'daily:evening', 'daily:tasks']);
    layout.widgets.forEach((spec, index) => {
        const frame = app.root.children[index];
        const instance = app.active('daily:' + spec.id);
        assert.equal(frame.children[0], instance.element);
        assert.equal(frame.style.position, 'absolute');
        assert.equal(frame.style.left, spec.x + 'px');
        assert.equal(frame.style.top, spec.y + 'px');
        assert.equal(frame.style.width, spec.width + 'px');
        assert.equal(frame.style.height, spec.height + 'px');
        assert.equal(frame.style.flex, 'none');
        assert.equal(frame.classList.contains('fixed-widget-height'), false);
    });
    assert.equal(app.active('daily:tasks').options.accountId, primary.sub);
    // The two gaps and unused outer canvas survive resolution and rendering.
    assert.equal(app.root.children[0].style.left, '32px');
    assert.equal(app.root.children[2].style.left, '400px');
    assert.deepEqual(app.renderer.getLayout().canvas, layout.canvas);
    assert.deepEqual(app.renderer.getLayout().widgets.map(({ x, y, width, height }) => ({ x, y, width, height })),
        layout.widgets.map(({ x, y, width, height }) => ({ x, y, width, height })));
});

test('moving, resizing, and reordering canvas widgets preserves component instances and scroll state', t => {
    const app = setup(t, canvasDefinition());
    const current = context();
    app.renderer.update(current);
    const instances = [...app.created];
    const morning = app.active('daily:morning');
    const frame = morning.element.parentNode;
    morning.element.scrollTop = 417;
    const changed = canvasDefinition();
    Object.assign(changed.widgets[0], { x: 74, y: 100, width: 300, height: 500 });
    changed.widgets.reverse();
    changed.canvas.height = 1300;
    app.renderer.setLayout(changed);
    assert.equal(app.created.length, 3);
    assert.equal(app.active(morning.id), morning);
    assert.equal(morning.element.parentNode, frame);
    assert.equal(morning.element.scrollTop, 417);
    assert.equal(frame.style.left, '74px');
    assert.equal(frame.style.top, '100px');
    assert.equal(frame.style.width, '300px');
    assert.equal(frame.style.height, '500px');
    assert.equal(app.root.style.getPropertyValue('--canvas-height'), '1300px');
    assert.deepEqual(app.root.children.map(item => item.dataset.widgetId), ['daily:tasks', 'daily:evening', 'daily:morning']);
    instances.forEach(instance => {
        assert.equal(app.active(instance.id), instance);
        assert.equal(instance.destroyCalls, 0);
        assert.deepEqual(instance.updates, [current, current]);
    });
});

test('switching between columns and canvas reuses widgets while removing stale container styles', t => {
    const app = setup(t);
    app.renderer.update(context());
    const columns = [...app.root.children];
    const instances = [...app.created];
    const frames = instances.map(instance => instance.element.parentNode);
    app.renderer.setLayout(canvasDefinition());
    assert.equal(app.created.length, 3);
    assert.equal(app.root.classList.contains('freeform-layout'), true);
    assert.equal(app.root.children.length, 3);
    assert.ok(columns.every(column => column.parentNode === null));
    assert.deepEqual(app.root.children, frames);
    assert.ok(frames.every(frame => frame.style.position === 'absolute' && frame.parentNode === app.root));
    assert.ok(instances.every(instance => instance.destroyCalls === 0));

    app.renderer.setLayout(definition());
    assert.equal(app.created.length, 3);
    assert.equal(app.root.classList.contains('freeform-layout'), false);
    assert.equal(app.root.style.getPropertyValue('--canvas-width'), 'auto');
    assert.equal(app.root.style.getPropertyValue('--canvas-height'), 'auto');
    assert.deepEqual(app.root.children.map(column => column.dataset.columnId), ['schedule', 'work']);
    assert.deepEqual(app.root.children.flatMap(column => column.children), frames);
    assert.ok(frames.every(frame => frame.style.position === '' && frame.style.left === '' && frame.style.top === '' && frame.style.width === '' && frame.style.height === ''));
    assert.ok(instances.every(instance => instance.destroyCalls === 0));

    const single = canvasDefinition();
    single.widgets = single.widgets.slice(0, 1);
    app.renderer.setLayout(single);
    assert.deepEqual(app.root.children, [frames[0]]);
    assert.equal(instances[0].destroyCalls, 0);
    assert.equal(instances[1].destroyCalls, 1);
    assert.equal(instances[2].destroyCalls, 1);
    assert.equal(frames[1].parentNode, null);
    assert.equal(frames[2].parentNode, null);
});

test('duplicate canvas components update, tick, and destroy independently', t => {
    const app = setup(t, canvasDefinition());
    const first = context();
    app.renderer.update(first);
    const morning = app.active('daily:morning');
    const evening = app.active('daily:evening');
    const tasks = app.active('daily:tasks');
    assert.notEqual(morning.element, evening.element);
    const removed = canvasDefinition();
    removed.widgets.shift();
    app.renderer.setLayout(removed);
    const next = context([primary], { showCompleted: false });
    app.renderer.update(next);
    app.renderer.tick();
    assert.equal(morning.destroyCalls, 1);
    assert.deepEqual(morning.updates, [first]);
    assert.deepEqual(morning.ticks, []);
    assert.deepEqual(evening.updates, [first, first, next]);
    assert.deepEqual(evening.ticks, [next]);
    assert.equal(evening.destroyCalls, 0);
    assert.equal(tasks.destroyCalls, 0);
    app.renderer.setLayout(canvasDefinition());
    const restored = app.active(morning.id);
    assert.notEqual(restored, morning);
    assert.equal(app.active(evening.id), evening);
    assert.equal(app.created.length, 4);
    app.renderer.destroy();
    app.renderer.destroy();
    assert.equal(app.root.children.length, 0);
    assert.ok(app.created.every(instance => instance.destroyCalls === 1));
});
