import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, validateLayout, resolveLayout, createLayoutRepository } from '../src/layout/layout-model.mjs';
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
