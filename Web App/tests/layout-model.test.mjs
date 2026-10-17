import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, createCanvasLayout, validateLayout, resolveLayout, resolveCanvasLayout, createLayoutRepository } from '../src/layout/layout-model.mjs';
import { canPlace } from '../src/layout/canvas-geometry.mjs';
const accounts = [{ sub: 'work-id', isPrimary: true }, { sub: 'home-id', isPrimary: false }];
function memory() { const data = new Map(); return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }

test('default definition expands from one to two task components without changing the template', () => {
    const definition = createDefaultLayout();
    const single = resolveLayout(definition, accounts.slice(0, 1));
    const double = resolveLayout(definition, accounts);
    assert.equal(single.length, 2); assert.equal(double.length, 3);
    assert.equal(double[1].widgets[0].options.accountId, 'work-id');
    assert.equal(double[2].widgets[0].options.accountId, 'home-id');
    assert.equal(single[1].widgets[0].id, double[1].widgets[0].id);
    assert.equal(definition.columns[1].widgets[0].options.accountId, '$account');
});
test('one definition supports reordered columns, stacked widgets, and independent options', () => {
    const definition = { version: 1, id: 'mine', name: 'My day', columns: [
        { id: 'tasks', size: 2, widgets: [
            { id: 'work', type: 'account-tasks', flex: 2, options: { accountId: '$primary', showCompleted: false, taskListIds: ['inbox'], title: 'Focus' } },
            { id: 'home', type: 'account-tasks', height: 300, options: { accountId: '$secondary', title: 'Home' } },
        ] },
        { id: 'calendars', width: 320, widgets: [
            { id: 'workday', type: 'timeline', options: { accountIds: ['$primary'], hourHeight: 48, initialHour: 8 } },
            { id: 'evening', type: 'timeline', options: { accountIds: ['$secondary'], hourHeight: 100, initialHour: 17 } },
        ] },
    ] };
    const result = resolveLayout(definition, accounts);
    assert.equal(result[0].widgets.length, 2);
    assert.equal(result[0].widgets[0].options.accountId, 'work-id');
    assert.equal(result[0].widgets[1].options.accountId, 'home-id');
    assert.deepEqual(result[1].widgets[0].options.accountIds, ['work-id']);
    assert.equal(result[1].widgets[1].options.hourHeight, 100);
    assert.equal(result[1].width, 320);
});
test('empty or missing accounts do not break layout resolution', () => {
    assert.equal(resolveLayout(createDefaultLayout(), []).length, 1);
    const layout = createDefaultLayout();
    layout.columns[1].repeat = undefined;
    layout.columns[1].widgets[0].options.accountId = '$secondary';
    assert.equal(resolveLayout(layout, accounts.slice(0, 1))[1].widgets[0].options.accountId, undefined);
});
test('validation rejects unknown versions/types, invalid bindings, duplicate identities and unsafe dimensions', () => {
    for (const change of [
        layout => { layout.version = 99; },
        layout => { layout.columns[0].widgets[0].type = 'unknown'; },
        layout => { layout.columns[0].width = -100; },
        layout => { layout.columns[0].widgets[0].options.hourHeight = 0; },
        layout => { layout.columns[1].repeat = undefined; },
        layout => { layout.columns[0].widgets[0].options.accountIds = ['$account']; },
        layout => { layout.columns[1].id = 'schedule'; },
        layout => { layout.columns[0].widgets.push(structuredClone(layout.columns[0].widgets[0])); },
        layout => { layout.columns[0].widgets[0].height = 0; },
    ]) {
        const layout = createDefaultLayout(); change(layout);
        assert.throws(() => validateLayout(layout), /Invalid planner layout/);
    }
});
test('saved layouts belong to a Google identity and contain only known presentation options', () => {
    const storage = memory();
    const work = createLayoutRepository({ storage, ownerId: 'work' });
    const home = createLayoutRepository({ storage, ownerId: 'home' });
    const layout = createDefaultLayout(); layout.name = 'Workday';
    layout.accessToken = 'never-save'; layout.columns[0].widgets[0].options.accessToken = 'never-save';
    work.save(layout);
    assert.equal(work.load().layout.name, 'Workday');
    assert.equal(home.load().layout.name, 'Daily planner');
    assert.doesNotMatch([...storage.data.values()].join(''), /never-save/);
    work.reset(); assert.equal(work.load().layout.name, 'Daily planner');
});
test('bad/unsupported saved data falls back without silently replacing the stored definition', () => {
    const storage = memory();
    storage.setItem('lotus.layout.v1.owner', '{broken');
    const repository = createLayoutRepository({ storage, ownerId: 'owner' });
    assert.equal(repository.load().recovered, true);
    assert.equal(repository.load().layout.id, 'daily');
    assert.equal(storage.getItem('lotus.layout.v1.owner'), '{broken');
});
test('blocked browser storage allows a default layout and reports save failures', () => {
    const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    const repository = createLayoutRepository({ storage, ownerId: 'owner' });
    assert.equal(repository.load().layout.id, 'daily');
    assert.throws(() => repository.save(createDefaultLayout()), /blocked/);
});
test('resolved snapshots do not mutate another user’s definition or widget options', () => {
    const definition = createDefaultLayout();
    const result = resolveLayout(definition, accounts);
    result[1].widgets[0].options.accountId = 'changed';
    assert.equal(definition.columns[1].widgets[0].options.accountId, '$account');
    const first = createDefaultLayout(); first.columns[0].width = 600;
    assert.equal(createDefaultLayout().columns[0].width, 260);
});

function canvasDefinition() {
    return { version: 2, id: 'mine', name: 'My canvas', canvas: { width: 1200, height: 900 }, widgets: [
        { id: 'calendar', type: 'timeline', x: 0, y: 0, width: 300, height: 760, options: { accountIds: ['$primary'] } },
        { id: 'tasks', type: 'account-tasks', x: 320, y: 40, width: 400, height: 650, options: { accountId: '$secondary', dateFilter: 'day-overdue', title: 'Home' } },
    ] };
}

test('canvas validation keeps exact positions and whitespace while allowing touching edges and empty canvases', () => {
    const layout = canvasDefinition();
    layout.widgets[1].x = 300;
    layout.widgets[1].y = 0.125;
    const result = validateLayout(layout);
    assert.equal(result.version, 2);
    assert.deepEqual(result.canvas, { width: 1200, height: 900 });
    assert.equal(result.widgets[1].x, 300);
    assert.equal(result.widgets[1].y, 0.125);
    assert.equal(result.widgets[1].options.dateFilter, 'day-overdue');
    assert.equal(validateLayout({ ...layout, widgets: [] }).widgets.length, 0);
    result.widgets[0].options.accountIds.push('changed');
    assert.deepEqual(layout.widgets[0].options.accountIds, ['$primary']);
});

test('canvas validation rejects overlapping, out-of-bounds, undersized or invalid widgets before persistence', () => {
    for (const change of [
        layout => { layout.widgets[1].x = 299.99; },
        layout => { layout.widgets[1].x = -1; },
        layout => { layout.widgets[1].y = -0.1; },
        layout => { layout.widgets[1].width = 199; },
        layout => { layout.widgets[1].height = 199; },
        layout => { layout.widgets[1].x = 801; },
        layout => { layout.widgets[1].y = 251; },
        layout => { layout.widgets[1].x = Infinity; },
        layout => { layout.widgets[1].id = 'calendar'; },
        layout => { layout.widgets[1].type = 'unknown'; },
        layout => { layout.widgets[1].options.accountId = '$account'; },
        layout => { layout.widgets[0].options.accountIds = ['$account']; },
        layout => { layout.widgets[1].options.dateFilter = 'tomorrow'; },
        layout => { layout.canvas.width = 199; },
        layout => { layout.canvas.height = NaN; },
    ]) {
        const layout = canvasDefinition(); change(layout);
        assert.throws(() => validateLayout(layout), /Invalid planner layout/);
    }
    const storage = memory();
    const repository = createLayoutRepository({ storage, ownerId: 'owner' });
    const invalid = canvasDefinition(); invalid.widgets[1].x = 100;
    assert.throws(() => repository.save(invalid), /overlap/);
    assert.equal(storage.data.size, 0);
});

test('canvas alias resolution keeps identities stable after movement and resolves missing accounts safely', () => {
    const layout = canvasDefinition();
    const result = resolveCanvasLayout(layout, accounts);
    assert.equal(result[0].id, 'mine:calendar');
    assert.deepEqual(result[0].options.accountIds, ['work-id']);
    assert.equal(result[1].options.accountId, 'home-id');
    layout.widgets[1].x = 800;
    layout.widgets[1].y = 200;
    layout.widgets.reverse();
    const moved = resolveCanvasLayout(layout, accounts);
    assert.equal(moved[0].id, result[1].id);
    assert.equal(moved[0].x, 800);
    assert.equal(resolveCanvasLayout(layout, accounts.slice(0, 1))[0].options.accountId, undefined);
    assert.equal(layout.widgets[0].options.accountId, '$secondary');
});

test('default column migration expands each linked account once into nonoverlapping movable widgets', () => {
    const source = createDefaultLayout();
    const before = structuredClone(source);
    const single = createCanvasLayout(source, accounts.slice(0, 1));
    const double = createCanvasLayout(source, accounts);
    assert.equal(single.version, 2);
    assert.equal(single.widgets.length, 2);
    assert.equal(double.widgets.length, 3);
    assert.deepEqual(double.canvas, { width: 1280, height: 900 });
    assert.equal(double.widgets[0].x, 0);
    assert.equal(double.widgets[0].y, 0);
    assert.equal(double.widgets[0].width, 260);
    assert.equal(double.widgets[0].height, 760);
    assert.deepEqual(double.widgets.filter(widget => widget.type === 'account-tasks').map(widget => widget.options.accountId), ['work-id', 'home-id']);
    assert.equal(single.widgets[1].id, double.widgets[1].id);
    double.widgets.forEach(widget => assert.equal(canPlace(widget, double.widgets, double.canvas, widget.id), true));
    assert.deepEqual(source, before);
    assert.deepEqual(createCanvasLayout(double, [], { width: 600, height: 400 }), double);
    assert.equal(createCanvasLayout(source, []).widgets.length, 1);
});

test('migration preserves stacked component sizing, aliases, options and expands canvas for minimum sizes', () => {
    const source = { version: 1, id: 'stacked', name: 'Stacked', columns: [
        { id: 'calendar', width: 160, widgets: [
            { id: 'morning', type: 'timeline', height: 180, options: { initialHour: 8, accountIds: ['$secondary'] } },
            { id: 'evening', type: 'timeline', height: 1200, options: { initialHour: 17 } },
        ] },
        { id: 'tasks', size: 0.25, widgets: [
            { id: 'home', type: 'account-tasks', options: { accountId: '$secondary', dateFilter: 'day', taskListIds: ['inbox'] } },
        ] },
    ] };
    const result = createCanvasLayout(source, accounts.slice(0, 1), { width: 300, height: 400 });
    assert.equal(result.canvas.width, 420);
    assert.equal(result.canvas.height, 1420);
    assert.equal(result.widgets[0].width, 200);
    assert.equal(result.widgets[0].height, 200);
    assert.equal(result.widgets[1].y, 220);
    assert.equal(result.widgets[1].height, 1200);
    assert.equal(result.widgets[2].width, 200);
    assert.equal(result.widgets[2].options.accountId, '$secondary');
    assert.deepEqual(result.widgets[0].options.accountIds, ['$secondary']);
    assert.equal(result.widgets[2].options.dateFilter, 'day');
    assert.deepEqual(result.widgets[2].options.taskListIds, ['inbox']);
    result.widgets.forEach(widget => assert.equal(canPlace(widget, result.widgets, result.canvas, widget.id), true));
});

test('canvas persistence uses the existing owner key, strips credentials and recovers legacy data', () => {
    const storage = memory();
    const key = 'lotus.layout.v1.owner';
    const repository = createLayoutRepository({ storage, ownerId: 'owner' });
    storage.setItem(key, JSON.stringify(createDefaultLayout()));
    assert.equal(repository.load().layout.version, 1);
    const migrated = createCanvasLayout(repository.load().layout, accounts);
    migrated.accessToken = 'never-save'; migrated.widgets[0].options.accessToken = 'never-save';
    const saved = repository.save(migrated);
    assert.equal(saved.version, 2);
    assert.equal(repository.load().recovered, false);
    assert.equal(repository.load().layout.widgets.length, 3);
    assert.equal(JSON.parse(storage.getItem(key)).version, 2);
    assert.doesNotMatch(storage.getItem(key), /never-save/);
    repository.save({ ...canvasDefinition(), widgets: [] });
    assert.equal(repository.load().layout.widgets.length, 0);
    assert.equal(repository.load().layout.version, 2);
    repository.reset();
    assert.equal(repository.load().layout.version, 1);
});

test('task date filtering is validated identically for column and canvas widgets', () => {
    for (const dateFilter of ['day', 'day-overdue', 'all']) {
        const columns = createDefaultLayout();
        columns.columns[1].widgets[0].options.dateFilter = dateFilter;
        assert.equal(validateLayout(columns).columns[1].widgets[0].options.dateFilter, dateFilter);
        const canvas = canvasDefinition(); canvas.widgets[1].options.dateFilter = dateFilter;
        assert.equal(validateLayout(canvas).widgets[1].options.dateFilter, dateFilter);
    }
    const invalid = createDefaultLayout(); invalid.columns[1].widgets[0].options.dateFilter = 'never';
    assert.throws(() => validateLayout(invalid), /date filter/);
});

test('fractional weighted migration stays in bounds despite floating-point edge sums', () => {
    const source = { version: 1, id: 'fractional', name: 'Fractional', columns: [0.5, 1, 1].map((size, index) => ({
        id: 'column' + index, size,
        widgets: [{ id: 'calendar' + index, type: 'timeline', options: {} }],
    })) };
    const result = createCanvasLayout(source, [], { width: 1280.3, height: 900 });
    assert.ok(Math.abs(result.canvas.width - 1280.3) < 0.000001);
    result.widgets.forEach(widget => {
        assert.ok(widget.x + widget.width <= result.canvas.width);
        assert.equal(canPlace(widget, result.widgets, result.canvas, widget.id), true);
    });
});
