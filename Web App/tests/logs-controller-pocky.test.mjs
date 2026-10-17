import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogsController } from '../src/state/logs-controller.mjs';
import { createPlannerStore } from '../src/state/planner-store.mjs';

const primary = { sub: 'google-primary', accessToken: 'primary-test-token' };
const alternate = { sub: 'google-alternate', accessToken: 'alternate-test-token' };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ authorize, connect } = {}) {
    const store = createPlannerStore({ day: new Date(2026, 9, 17), customLogs: [] });
    let current = primary;
    const watches = [], authorizations = [], connections = [], saves = [], deletions = [];
    const repository = {
        connect: async session => { connections.push(session); if (connect) return connect(session); return { uid: 'existing-pocky-uid' }; },
        authorize: session => { authorizations.push(session); return authorize ? authorize(session) : Promise.resolve({ uid: 'existing-pocky-uid' }); },
        watchDefinitions: (next, error) => watch('definitions', {}, next, error),
        watchEntries: (range, next, error) => watch('entries', range, next, error),
        watchCompletions: (day, next, error) => watch('completions', { day }, next, error),
        watchSettings: (next, error) => watch('settings', {}, next, error),
        saveEntry: async entry => { saves.push(entry); return entry; },
        saveCustomLog: async (definition, options) => { saves.push({ definition, options }); return definition; },
        saveCompletion: async completion => { saves.push(completion); return completion; },
        deleteEntry: async (id, source) => { deletions.push({ id, source }); },
        destroy: async () => {},
    };
    function watch(kind, filter, next, error) {
        const record = { kind, filter, next, error, active: true }; watches.push(record);
        return () => { record.active = false; };
    }
    function send(kind, data, offset = 0) { watches.slice(offset).find(record => record.kind === kind).next(data); }
    function ready(offset = 0) { send('definitions', [], offset); send('entries', [], offset); send('completions', [], offset); send('settings', {}, offset); }
    const controller = createLogsController({ store, repository, auth: { getSession: () => current } });
    return { store, controller, repository, watches, authorizations, connections, saves, deletions, send, ready, setPrimary: value => { current = value; } };
}

test('Pocky settings participate in readiness and arrive through the same shared subscription set', async () => {
    const app = setup();
    await app.controller.start(); await app.controller.start();
    assert.equal(app.connections.length, 1); assert.equal(app.watches.length, 4);
    assert.deepEqual(app.watches.find(watch => watch.kind === 'entries').filter, { from: '2026-10-11', to: '2026-10-17' });
    app.send('definitions', []); app.send('entries', []); app.send('completions', []);
    assert.equal(app.store.getState().logs.status, 'loading');
    const settings = { weightUnit: 'kg', workoutTypes: [{ id: 'walk', name: 'Morning walk', color: '#34c759' }] };
    app.send('settings', settings);
    assert.equal(app.store.getState().logs.status, 'ready'); assert.deepEqual(app.store.getState().logs.settings, settings);
    app.watches.find(watch => watch.kind === 'settings').error(new Error('Settings could not load'));
    assert.equal(app.store.getState().logs.status, 'error'); assert.match(app.store.getState().logs.error, /Settings/);
    app.send('settings', settings);
    assert.equal(app.store.getState().logs.status, 'ready'); assert.equal(app.store.getState().logs.error, '');
    app.controller.destroy();
    assert.ok(app.watches.every(watch => !watch.active));
});

test('cloud identity is ready independently of log loading and malformed log records', async () => {
    const app = setup();
    await app.controller.start();
    assert.equal(app.store.getState().cloud.status, 'ready');
    assert.equal(app.store.getState().cloud.ownerSub, primary.sub);
    assert.equal(app.store.getState().logs.status, 'loading');
    app.watches.find(watch => watch.kind === 'entries').error(Object.assign(new Error('Malformed log record'), { code: 'invalid-record' }));
    assert.equal(app.store.getState().logs.status, 'error');
    assert.equal(app.store.getState().cloud.status, 'ready');
    app.controller.destroy();
});

test('an authentication failure closes shared cloud access until reconnection', async () => {
    const app = setup();
    await app.controller.start(); app.ready();
    app.watches.find(watch => watch.kind === 'entries').error(Object.assign(new Error('Sign in again'), { code: 'unauthenticated' }));
    assert.equal(app.store.getState().cloud.status, 'error');
    assert.equal(app.store.getState().cloud.needsSignIn, true);
    assert.equal(app.store.getState().logs.needsSignIn, true);
    app.controller.destroy();
});

test('authorize reaches the popup in the click stack and resubscribes only after acknowledgment', async () => {
    const gate = deferred();
    let invokedBeforeMicrotask = false, microtaskRan = false;
    const app = setup({ authorize: () => { invokedBeforeMicrotask = !microtaskRan; return gate.promise; } });
    await app.controller.start(); app.ready();
    queueMicrotask(() => { microtaskRan = true; });
    const request = app.controller.authorize();
    assert.equal(invokedBeforeMicrotask, true); assert.deepEqual(app.authorizations, [primary]);
    assert.equal(app.connections.length, 1); assert.equal(app.watches.length, 4);
    assert.ok(app.watches.every(watch => !watch.active));
    assert.equal(app.store.getState().logs.saving, true); assert.equal(app.store.getState().logs.status, 'loading');
    gate.resolve({ uid: 'existing-pocky-uid' }); await request;
    assert.equal(app.connections.length, 2); assert.equal(app.watches.length, 8);
    assert.equal(app.store.getState().logs.saving, false);
    app.ready(4); assert.equal(app.store.getState().logs.status, 'ready');
    app.controller.destroy();
});

test('failed interactive sign-in retains an actionable error and never starts new reads', async () => {
    const gate = deferred();
    const app = setup({ authorize: () => gate.promise });
    await app.controller.start(); app.ready();
    app.send('entries', [{ id: 'before-auth', type: 'water', day: '2026-10-17', cups: 4 }]);
    const request = app.controller.authorize();
    gate.reject(Object.assign(new Error('Cloud sign-in was cancelled. You can try again.'), { code: 'auth/popup-closed-by-user' }));
    await assert.rejects(request, /cancelled/);
    const state = app.store.getState().logs;
    assert.equal(state.status, 'error'); assert.equal(state.needsSignIn, true); assert.equal(state.saving, false);
    assert.match(state.error, /cancelled/); assert.deepEqual(state.entries, []); assert.deepEqual(state.completions, []);
    assert.equal(app.connections.length, 1); assert.equal(app.watches.length, 4);
    assert.ok(app.watches.every(watch => !watch.active));
    app.controller.destroy();
});

test('credential failures request interactive sign-in while network failures remain retryable without it', async () => {
    const app = setup({ connect: async () => { throw Object.assign(new Error('Connect this account'), { code: 'auth/invalid-credential' }); } });
    await app.controller.start();
    assert.equal(app.store.getState().logs.needsSignIn, true); assert.equal(app.store.getState().logs.status, 'error');
    assert.equal(app.watches.length, 0); app.controller.destroy();
    const network = setup({ connect: async () => { throw Object.assign(new Error('Connection unavailable'), { code: 'auth/network-request-failed' }); } });
    await network.controller.start();
    assert.equal(network.store.getState().logs.needsSignIn, false); assert.match(network.store.getState().logs.error, /unavailable/);
    network.controller.destroy();
});

test('delete forwards original Pocky source and save preserves source while a different day is selected', async () => {
    const app = setup();
    await app.controller.start(); app.ready();
    const source = Object.freeze({ day: '2026-10-16', kind: 'food', rawId: 'shared-uuid' });
    await app.controller.deleteEntry('shared-uuid', source);
    assert.deepEqual(app.deletions, [{ id: 'shared-uuid', source }]);
    const entry = Object.freeze({ id: 'shared-uuid', type: 'food', day: '2026-10-18', time: '12:00', name: 'Moved lunch', source });
    await app.controller.saveEntry(entry);
    assert.equal(app.saves[0], entry); assert.equal(app.saves[0].source.day, '2026-10-16');
    assert.equal(app.store.getState().logs.saving, false); app.controller.destroy();
});

test('primary changes clear old settings and ignore late settings callbacks from the prior owner', async () => {
    const app = setup();
    await app.controller.start(); app.ready();
    app.send('settings', { weightUnit: 'kg', workoutTypes: [{ id: 'private', name: 'Private type' }] });
    app.setPrimary(alternate); app.store.update({ linking: false });
    assert.deepEqual(app.store.getState().logs.settings, {});
    app.send('settings', { weightUnit: 'kg', workoutTypes: [{ id: 'late', name: 'Late old type' }] });
    assert.deepEqual(app.store.getState().logs.settings, {});
    await flush();
    assert.equal(app.connections.at(-1), alternate); assert.equal(app.watches.length, 8);
    app.ready(4); assert.equal(app.store.getState().logs.status, 'ready');
    assert.deepEqual(app.store.getState().logs.settings, {}); app.controller.destroy();
});
