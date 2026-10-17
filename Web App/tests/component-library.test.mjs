import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetRegistry, getWidgetCatalog, getWidgetLabel } from '../src/layout/widget-registry.mjs';
import { validateLayout, createCanvasLayout, createLayoutRepository } from '../src/layout/layout-model.mjs';
const accounts = [{ sub: 'one', email: 'work@example.com', isPrimary: true }, { sub: 'two', email: 'home@example.com', isPrimary: false }];
const customLogs = [{ id: 'mood', name: 'Mood' }, { id: 'reading', name: 'Reading' }];

test('all palette components have registered factories and valid persisted options', () => {
    const registry = createWidgetRegistry();
    const catalog = getWidgetCatalog(accounts, customLogs);
    assert.equal(new Set(catalog.map(entry => entry.key)).size, catalog.length);
    assert.ok(catalog.some(entry => entry.type === 'events-list' && !entry.placeholder));
    assert.equal(catalog.filter(entry => entry.type === 'compact-tasks').length, 2);
    for (const entry of catalog) {
        assert.equal(typeof registry.get(entry.type), 'function', entry.type);
        const layout = validateLayout({ version: 2, id: 'day', name: 'My day', canvas: { width: 1000, height: 1000 }, customLogs,
            widgets: [{ id: 'panel', type: entry.type, x: 0, y: 0, ...entry.size, options: entry.options }] });
        assert.equal(layout.widgets[0].type, entry.type);
        assert.equal(getWidgetLabel(layout.widgets[0], accounts, customLogs), entry.title);
        if (entry.type === 'log') assert.equal(layout.widgets[0].options.logType, entry.options.logType);
    }
});
test('library covers all requested placeholders and makes their status explicit', () => {
    const catalog = getWidgetCatalog(accounts, customLogs);
    for (const type of ['journal', 'logs-group', 'log', 'goals', 'weight-graph']) assert.ok(catalog.filter(entry => entry.type === type).every(entry => entry.placeholder && /Placeholder/.test(entry.description)));
    assert.deepEqual(catalog.filter(entry => entry.type === 'weight-graph').map(entry => entry.options.period), ['week', 'month', 'year']);
    assert.deepEqual(catalog.filter(entry => entry.type === 'goals').map(entry => entry.options.orientation), ['vertical', 'horizontal']);
    for (const type of ['sleep', 'weight', 'workout', 'workout-streak', 'food', 'water']) assert.ok(catalog.some(entry => entry.options.logType === type));
    assert.equal(catalog.filter(entry => entry.options.logType === 'custom').length, 2);
});
test('custom log names survive migration and per-user storage without carrying data values', () => {
    const source = { version: 1, id: 'day', name: 'Day', customLogs: [...customLogs, { id: 'water-custom', name: 'Custom habit', entries: ['not-saved'], accessToken: 'not-saved' }], columns: [{ id: 'logs', widgets: [{ id: 'group', type: 'logs-group', options: {} }] }] };
    const canvas = createCanvasLayout(source, accounts);
    const memory = new Map();
    const repo = createLayoutRepository({ ownerId: 'user', storage: { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) } });
    repo.save(canvas);
    assert.deepEqual(repo.load().layout.customLogs, [{ id: 'mood', name: 'Mood' }, { id: 'reading', name: 'Reading' }, { id: 'water-custom', name: 'Custom habit' }]);
    assert.doesNotMatch([...memory.values()].join(''), /not-saved/);
});
test('invalid placeholder settings and duplicate log identities are rejected', () => {
    const layout = options => ({ version: 2, id: 'day', name: 'Day', canvas: { width: 500, height: 500 }, widgets: [{ id: 'one', type: 'log', x: 0, y: 0, width: 250, height: 250, options }] });
    assert.throws(() => validateLayout(layout({ logType: 'unknown' })), /valid log/);
    assert.throws(() => validateLayout(layout({ logType: 'custom' })), /stable identity/);
    const duplicate = { ...layout({ logType: 'sleep' }), customLogs: [{ id: 'one', name: 'Mood' }, { id: 'one', name: 'Energy' }] };
    assert.throws(() => validateLayout(duplicate), /unique ids/);
    const goals = layout({ orientation: 'diagonal' }); goals.widgets[0].type = 'goals';
    assert.throws(() => validateLayout(goals), /orientation/);
    const graph = layout({ period: 'decade' }); graph.widgets[0].type = 'weight-graph';
    assert.throws(() => validateLayout(graph), /period/);
});
