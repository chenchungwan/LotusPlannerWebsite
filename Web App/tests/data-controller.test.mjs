import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerStore } from '../src/state/planner-store.mjs';
import { createDataController } from '../src/state/data-controller.mjs';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup({ accounts = [{ sub: 'primary', isPrimary: true }], sessionAvailable = true } = {}) {
    let currentAccounts = accounts;
    const calls = [];
    const store = createPlannerStore({ day: new Date(2026, 9, 17) });
    function request(service, account, date, options) {
        const pending = deferred();
        calls.push({ service, account, date, signal: options.signal, ...pending });
        return pending.promise;
    }
    const auth = {
        requireSession: () => sessionAvailable ? { sub: 'primary' } : null,
        getAccounts: () => currentAccounts,
    };
    const google = {
        loadEvents: (account, date, options) => request('events', account, date, options),
        loadTasks: (account, options) => request('tasks', account, null, options),
    };
    const controller = createDataController({ store, auth, google });
    return { store, controller, calls, setAccounts: value => { currentAccounts = value; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('multiple widget subscribers share one fetch per linked account and service', async () => {
    const app = setup({ accounts: [{ sub: 'primary', isPrimary: true }, { sub: 'second' }] });
    const timelineSnapshots = [], firstTaskSnapshots = [], secondTaskSnapshots = [];
    app.store.subscribe(state => timelineSnapshots.push(state));
    app.store.subscribe(state => firstTaskSnapshots.push(state));
    app.store.subscribe(state => secondTaskSnapshots.push(state));
    const refreshing = app.controller.refresh();
    assert.equal(app.calls.length, 4);
    assert.deepEqual(app.calls.map(call => [call.account.sub, call.service]), [
        ['primary', 'events'], ['primary', 'tasks'], ['second', 'events'], ['second', 'tasks'],
    ]);
    assert.equal(app.calls.find(call => call.service === 'events').date, '2026-10-17');
    for (const call of app.calls) call.resolve([{ title: call.account.sub + ' ' + call.service }]);
    await refreshing;
    assert.equal(app.calls.length, 4);
    assert.equal(app.store.getState().loading, false);
    assert.equal(app.store.getState().results.size, 2);
    assert.equal(app.store.getState().results.get('second').tasks[0].title, 'second tasks');
    assert.equal(timelineSnapshots.length, firstTaskSnapshots.length);
    assert.equal(firstTaskSnapshots.length, secondTaskSnapshots.length);
    timelineSnapshots.forEach((state, index) => {
        assert.equal(state.results, firstTaskSnapshots[index].results);
        assert.equal(state.results, secondTaskSnapshots[index].results);
    });
});

test('one service can load incrementally while an error in the other preserves its data', async () => {
    const app = setup();
    const refreshing = app.controller.refresh();
    const events = [{ id: 'meeting' }];
    app.calls.find(call => call.service === 'events').resolve(events);
    await flush();
    assert.equal(app.store.getState().results.get('primary').events, events);
    assert.equal(app.store.getState().results.get('primary').tasksError, undefined);
    assert.equal(app.store.getState().loading, true);
    const taskError = new Error('Tasks is temporarily unavailable');
    app.calls.find(call => call.service === 'tasks').reject(taskError);
    await refreshing;
    const state = app.store.getState();
    assert.equal(state.results.get('primary').events, events);
    assert.equal(state.results.get('primary').tasksError, taskError);
    assert.equal(state.loading, false);
    assert.match(state.notice, /Some Google data couldn’t load/);
});

test('responses from an older day cannot replace a newer day after cancellation', async () => {
    const app = setup();
    const oldRefresh = app.controller.refresh();
    const oldCalls = app.calls.slice();
    app.store.update({ day: new Date(2026, 9, 18) });
    const newRefresh = app.controller.refresh();
    const newCalls = app.calls.slice(2);
    assert.equal(oldCalls.every(call => call.signal.aborted), true);
    assert.equal(newCalls.every(call => !call.signal.aborted), true);
    assert.equal(newCalls.find(call => call.service === 'events').date, '2026-10-18');
    newCalls.find(call => call.service === 'events').resolve([{ id: 'new-meeting' }]);
    newCalls.find(call => call.service === 'tasks').resolve([{ id: 'new-task-list' }]);
    await newRefresh;
    const currentResults = app.store.getState().results;
    // The fake transport intentionally delivers old responses after aborting.
    oldCalls.find(call => call.service === 'events').resolve([{ id: 'stale-meeting' }]);
    oldCalls.find(call => call.service === 'tasks').reject(new Error('Stale failure'));
    await oldRefresh;
    assert.equal(app.store.getState().results, currentResults);
    assert.equal(app.store.getState().results.get('primary').events[0].id, 'new-meeting');
    assert.equal(app.store.getState().results.get('primary').tasks[0].id, 'new-task-list');
    assert.equal(app.store.getState().notice, '');
    assert.equal(app.store.getState().loading, false);
});

test('destroy aborts pending work and ignores late responses and subsequent refreshes', async () => {
    const app = setup();
    let updates = 0;
    app.store.subscribe(() => updates++);
    const refreshing = app.controller.refresh();
    const beforeDestroy = app.store.getState();
    const beforeUpdates = updates;
    app.controller.destroy();
    assert.equal(app.calls.every(call => call.signal.aborted), true);
    app.calls[0].resolve([{ id: 'late-event' }]);
    app.calls[1].reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    await refreshing;
    await app.controller.refresh();
    await app.controller.checkAccounts();
    assert.equal(app.store.getState(), beforeDestroy);
    assert.equal(updates, beforeUpdates);
    assert.equal(app.calls.length, 2);
});

test('known secondary accounts awaiting reconnection are visible without fetching their data', async () => {
    const secondary = { sub: 'second', email: 'second@example.com', needsReconnect: true };
    const app = setup({ accounts: [{ sub: 'primary', isPrimary: true }, secondary] });
    const refreshing = app.controller.refresh();
    assert.equal(app.calls.length, 2);
    assert.equal(app.calls.every(call => call.account.sub === 'primary'), true);
    assert.equal(app.store.getState().accounts[1], secondary);
    assert.deepEqual(app.store.getState().results.get('second'), {});
    app.calls.forEach(call => call.resolve([]));
    await refreshing;
    assert.equal(app.store.getState().loading, false);
    assert.equal(app.store.getState().notice, '');
});

test('checking unchanged accounts does not refetch, while a reconnection refreshes shared data', async () => {
    const app = setup({ accounts: [{ sub: 'primary', isPrimary: true }, { sub: 'second', needsReconnect: true }] });
    const first = app.controller.refresh();
    app.calls.forEach(call => call.resolve([]));
    await first;
    await app.controller.checkAccounts();
    assert.equal(app.calls.length, 2);
    app.setAccounts([{ sub: 'primary', isPrimary: true }, { sub: 'second', needsReconnect: false }]);
    const changed = app.controller.checkAccounts();
    assert.equal(app.calls.length, 6);
    app.calls.slice(2).forEach(call => call.resolve([]));
    await changed;
    assert.equal(app.store.getState().accounts[1].needsReconnect, false);
    assert.deepEqual(app.store.getState().results.get('second').tasks, []);
});

test('missing primary authorization prevents fetching and preserves the current store', async () => {
    const app = setup({ sessionAvailable: false });
    const before = app.store.getState();
    await app.controller.refresh();
    assert.equal(app.calls.length, 0);
    assert.equal(app.store.getState(), before);
});

test('store updates publish shared snapshots and unsubscribe stops delivery independently', () => {
    const store = createPlannerStore({ showCompleted: false });
    const first = [], second = [];
    const unsubscribe = store.subscribe(state => first.push(state));
    store.subscribe(state => second.push(state));
    store.update({ showCompleted: true });
    assert.equal(first[0], second[0]);
    assert.equal(first[0], store.getState());
    unsubscribe(); unsubscribe();
    store.update(state => ({ showCompleted: !state.showCompleted, notice: 'Updated' }));
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    assert.equal(second[1].showCompleted, false);
    assert.equal(second[1].notice, 'Updated');
    store.destroy();
    store.update({ notice: 'No listeners' });
    assert.equal(second.length, 2);
});
