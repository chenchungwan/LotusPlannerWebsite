import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseLogsRepository } from '../src/services/firebase-logs.mjs';
import { createLogsController } from '../src/state/logs-controller.mjs';
import { createPlannerStore } from '../src/state/planner-store.mjs';

const config = { apiKey: 'public-test-key', projectId: 'demo-lotus', authDomain: 'demo-lotus.firebaseapp.com', appId: 'public-test-app' };
const primary = { sub: 'google-primary', accessToken: 'fake-primary-token' };
const alternate = { sub: 'google-alternate', accessToken: 'fake-alternate-token' };
const entry = { id: 'water-2026-10-17', type: 'water', day: '2026-10-17', cups: 3 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function mockSdk(options = {}) {
    const apps = [], watches = [], writes = [], deletions = [], credentials = [];
    const auth = { currentUser: null };
    let signOuts = 0, loads = 0;
    let authOptions, firestoreOptions;
    const sdk = {
        inMemoryPersistence: { type: 'NONE' },
        getApps: () => apps,
        initializeApp: (settings, name) => { const app = { options: settings, name }; apps.push(app); return app; },
        initializeAuth: (app, settings) => { authOptions = settings; return auth; },
        initializeFirestore: (app, settings) => { firestoreOptions = settings; return { app }; },
        memoryLocalCache: () => ({ type: 'memory' }),
        GoogleAuthProvider: { credential: (idToken, accessToken) => ({ idToken, accessToken }) },
        signInWithCredential: async (firebaseAuth, credential) => {
            credentials.push(credential);
            if (options.exchange) await options.exchange(credential);
            const sub = options.mismatch ? 'wrong-google-user' : credential.accessToken === primary.accessToken ? primary.sub : alternate.sub;
            const user = { uid: 'firebase-' + sub, providerData: [{ providerId: 'google.com', uid: sub }] };
            firebaseAuth.currentUser = user;
            return { user };
        },
        signOut: async firebaseAuth => { signOuts++; firebaseAuth.currentUser = null; },
        collection: (db, ...path) => ({ path }),
        doc: (db, ...path) => ({ path }),
        where: (field, op, value) => ({ field, op, value }),
        orderBy: (field, direction) => ({ field, direction }),
        query: (reference, ...constraints) => ({ ...reference, constraints }),
        onSnapshot: (reference, settings, next, error) => {
            const watch = { reference, settings, next, error, active: true };
            watches.push(watch);
            return () => { watch.active = false; };
        },
        setDoc: async (reference, value) => { writes.push({ reference, value }); if (options.save) await options.save(reference, value); },
        deleteDoc: async reference => { deletions.push(reference); },
        serverTimestamp: () => ({ sentinel: 'server-timestamp' }),
        runTransaction: async (db, update) => update({
            get: async reference => ({ id: reference.path.at(-1), exists: () => Boolean(options.existingDefinition), data: () => options.existingDefinition }),
            set: (reference, value) => writes.push({ reference, value, transactional: true }),
        }),
    };
    const repository = createFirebaseLogsRepository({ config, rootCollection: options.rootCollection, loadSdk: async () => { loads++; return sdk; } });
    function emit(index, records, metadata = {}) {
        watches[index].next({ metadata, docs: records.map(record => ({ id: record.id, data: () => record })) });
    }
    return { repository, sdk, auth, apps, watches, writes, deletions, credentials, emit,
        get signOuts() { return signOuts; }, get loads() { return loads; }, get authOptions() { return authOptions; }, get firestoreOptions() { return firestoreOptions; } };
}

test('unconfigured logs fail explicitly without loading SDKs or writing browser fallback data', async () => {
    let loaded = false;
    const repository = createFirebaseLogsRepository({ loadSdk: async () => { loaded = true; } });
    await assert.rejects(repository.connect(primary), error => error.code === 'unconfigured');
    assert.equal(loaded, false);
    await assert.rejects(repository.saveEntry(entry), /primary Google account/);
});

test('primary credential exchange uses named memory-only services and coalesces concurrent connects', async () => {
    const gate = deferred();
    const app = mockSdk({ exchange: () => gate.promise });
    const one = app.repository.connect(primary);
    const two = app.repository.connect(primary);
    await flush();
    assert.equal(app.credentials.length, 1);
    assert.deepEqual(app.credentials[0], { idToken: null, accessToken: primary.accessToken });
    gate.resolve();
    assert.deepEqual(await one, await two);
    assert.equal(app.authOptions.persistence, app.sdk.inMemoryPersistence);
    assert.equal(app.firestoreOptions.localCache.type, 'memory');
    assert.match(app.apps[0].name, /^lotus-web-logs-/);
    await app.repository.connect(primary);
    assert.equal(app.loads, 1);
    assert.equal(app.credentials.length, 1);
    await app.repository.destroy();
});

test('wrong provider identity and explicitly secondary accounts never attach listeners or write', async () => {
    const app = mockSdk({ mismatch: true });
    await assert.rejects(app.repository.connect(primary), error => error.code === 'identity-mismatch');
    assert.equal(app.auth.currentUser, null);
    assert.equal(app.signOuts, 1);
    assert.throws(() => app.repository.watchDefinitions(() => {}, () => {}), /primary Google account/);
    await assert.rejects(app.repository.saveEntry(entry));
    assert.equal(app.watches.length, 0);
    assert.equal(app.writes.length, 0);
    const secondary = mockSdk();
    await assert.rejects(secondary.repository.connect({ ...alternate, isPrimary: false }), error => error.code === 'identity-mismatch');
    assert.equal(secondary.loads, 0);
});

test('listeners query only the primary UID and validate all cloud records without exposing unknown fields', async () => {
    const app = mockSdk({ rootCollection: 'existingLogUsers' });
    await app.repository.connect(primary);
    const values = [], errors = [];
    app.repository.watchEntries({ from: '2026-10-11', to: '2026-10-17' }, records => values.push(records), error => errors.push(error));
    app.repository.watchCompletions('2026-10-17', () => {}, error => errors.push(error));
    assert.deepEqual(app.watches[0].reference.path, ['existingLogUsers', 'firebase-google-primary', 'entries']);
    assert.deepEqual(app.watches[0].reference.constraints, [
        { field: 'day', op: '>=', value: '2026-10-11' }, { field: 'day', op: '<=', value: '2026-10-17' }, { field: 'day', direction: 'asc' },
    ]);
    assert.deepEqual(app.watches[1].reference.constraints, [{ field: 'day', op: '==', value: '2026-10-17' }]);
    app.emit(0, [{ ...entry, accessToken: 'never-expose', userId: 'wrong-owner', updatedAt: {} }]);
    assert.deepEqual(values[0], [{ ...entry, time: '12:00' }]);
    app.emit(0, [{ ...entry, cups: 'bad' }]);
    assert.equal(errors[0].code, 'invalid-record');
    assert.equal(values.length, 1);
    assert.throws(() => app.repository.watchEntries({ from: '2026-02-30', to: '2026-10-17' }, () => {}, () => {}), /valid YYYY-MM-DD/);
});

test('pending and cached snapshots never publish unconfirmed log values', async () => {
    const app = mockSdk();
    await app.repository.connect(primary);
    const values = [];
    app.repository.watchEntries({ from: '2026-10-11', to: '2026-10-17' }, records => values.push(records), assert.fail);
    assert.equal(app.watches[0].settings.includeMetadataChanges, true);
    app.emit(0, [{ ...entry, cups: 9 }], { hasPendingWrites: true, fromCache: false });
    app.emit(0, [], { hasPendingWrites: false, fromCache: true });
    assert.equal(values.length, 0);
    app.emit(0, [{ ...entry, cups: 9 }], { hasPendingWrites: false, fromCache: false });
    assert.equal(values[0][0].cups, 9);
});

test('malformed nested custom items produce a read error rather than entering shared context', async () => {
    const app = mockSdk();
    await app.repository.connect(primary);
    const values = [], errors = [];
    app.repository.watchDefinitions(records => values.push(records), error => errors.push(error));
    app.emit(0, [{ id: 'ritual', name: 'Ritual', enabled: true, order: 0, items: [{ id: 'item', title: '', enabled: true, order: 0 }] }]);
    assert.equal(values.length, 0);
    assert.equal(errors[0].code, 'invalid-record');
    assert.match(errors[0].message, /could not be read/);
});

test('writes normalize fields and resolve only after backend acknowledgment', async () => {
    const gate = deferred();
    const app = mockSdk({ save: () => gate.promise });
    await app.repository.connect(primary);
    let acknowledged = false;
    const save = app.repository.saveEntry({ ...entry, accessToken: 'never-save', workoutType: 'running' }).then(result => { acknowledged = true; return result; });
    await flush();
    assert.equal(acknowledged, false);
    assert.deepEqual(app.writes[0].reference.path, ['webLogUsers', 'firebase-google-primary', 'entries', entry.id]);
    assert.deepEqual(app.writes[0].value, { ...entry, time: '12:00', updatedAt: { sentinel: 'server-timestamp' } });
    gate.resolve();
    assert.deepEqual(await save, { ...entry, time: '12:00' });
    assert.equal(acknowledged, true);
    await assert.rejects(app.repository.deleteEntry('bad/id'), /invalid id/);
    assert.equal(app.deletions.length, 0);
    await app.repository.deleteEntry(entry.id);
    assert.deepEqual(app.deletions[0].path, ['webLogUsers', 'firebase-google-primary', 'entries', entry.id]);
});

test('identity changes unsubscribe previous listeners and ignore their late callbacks', async () => {
    const app = mockSdk();
    await app.repository.connect(primary);
    const values = [];
    app.repository.watchDefinitions(records => values.push(records), assert.fail);
    await app.repository.connect(alternate);
    assert.equal(app.watches[0].active, false);
    app.emit(0, [{ id: 'old', name: 'Old', items: [] }]);
    assert.equal(values.length, 0);
    app.repository.watchDefinitions(records => values.push(records), assert.fail);
    assert.deepEqual(app.watches[1].reference.path, ['webLogUsers', 'firebase-google-alternate', 'customLogs']);
    app.auth.currentUser = { uid: 'wrong', providerData: [{ providerId: 'google.com', uid: 'wrong' }] };
    await assert.rejects(app.repository.saveEntry(entry), error => error.code === 'identity-mismatch');
    await flush();
    assert.equal(app.auth.currentUser, null);
    assert.ok(app.watches.every(watch => !watch.active));
    await app.repository.destroy();
});

test('create-only custom definitions preserve existing cloud items and atomically create missing definitions', async () => {
    const existing = { id: 'ritual', name: 'Existing', enabled: true, order: 2, items: [{ id: 'walk', title: 'Walk', enabled: true, order: 0 }] };
    const app = mockSdk({ existingDefinition: existing });
    await app.repository.connect(primary);
    const result = await app.repository.saveCustomLog({ id: 'ritual', name: 'New name', items: [] }, { createOnly: true });
    assert.deepEqual(result, existing);
    assert.equal(app.writes.length, 0);
    const empty = mockSdk();
    await empty.repository.connect(primary);
    const created = await empty.repository.saveCustomLog({ id: 'ritual', name: 'New log', items: [] }, { createOnly: true });
    assert.equal(empty.writes.length, 1);
    assert.equal(empty.writes[0].transactional, true);
    assert.deepEqual(created.items, []);
});

function controllerSetup(options = {}) {
    const store = createPlannerStore({ day: new Date(2026, 9, 17), customLogs: [{ id: 'legacy', name: 'Legacy', items: [] }] });
    let current = primary;
    const watches = [], connections = [], saves = [], deletions = [];
    let destroys = 0;
    const repository = {
        connect: async session => { connections.push(session); if (options.connectError) throw options.connectError; return { uid: 'firebase-' + session.sub }; },
        watchDefinitions: (next, error) => addWatch('definitions', {}, next, error),
        watchEntries: (range, next, error) => addWatch('entries', range, next, error),
        watchCompletions: (day, next, error) => addWatch('completions', { day }, next, error),
        saveEntry: async value => { saves.push({ kind: 'entry', value }); if (options.save) await options.save(value); return value; },
        deleteEntry: async id => { deletions.push(id); if (options.save) await options.save(id); },
        saveCustomLog: async value => { saves.push({ kind: 'definition', value }); if (options.save) await options.save(value); return value; },
        saveCompletion: async value => { saves.push({ kind: 'completion', value }); if (options.save) await options.save(value); return value; },
        destroy: async () => { destroys++; },
    };
    function addWatch(kind, filter, next, error) { const watch = { kind, filter, next, error, active: true }; watches.push(watch); return () => { watch.active = false; }; }
    const controller = createLogsController({ store, auth: { getSession: () => current }, repository });
    function ready(offset = 0) { watches[offset].next([]); watches[offset + 1].next([]); watches[offset + 2].next([]); }
    return { store, controller, repository, watches, connections, saves, deletions, ready, setPrimary: value => { current = value; }, get destroys() { return destroys; } };
}

test('controller subscribes once to rolling seven local days and publishes cloud definitions without migrating legacy data', async () => {
    const app = controllerSetup();
    await app.controller.start(); await app.controller.start();
    assert.equal(app.connections.length, 1);
    assert.equal(app.watches.length, 3);
    assert.deepEqual(app.watches[1].filter, { from: '2026-10-11', to: '2026-10-17' });
    assert.deepEqual(app.watches[2].filter, { day: '2026-10-17' });
    assert.equal(app.store.getState().logs.status, 'loading');
    assert.deepEqual(app.store.getState().customLogs, []);
    app.ready();
    assert.equal(app.store.getState().logs.status, 'ready');
    assert.equal(app.saves.length, 0);
    app.controller.destroy();
    assert.ok(app.watches.every(watch => !watch.active));
});

test('day changes clear records immediately and ignore previous-day callbacks', async () => {
    const app = controllerSetup();
    await app.controller.start(); app.ready();
    app.watches[1].next([{ ...entry, time: '12:00' }]);
    app.watches[2].next([{ id: 'completion', customLogId: 'custom', itemId: 'item', day: '2026-10-17', completed: true }]);
    app.store.update({ day: new Date(2026, 10, 1) });
    assert.deepEqual(app.store.getState().logs.entries, []);
    assert.deepEqual(app.store.getState().logs.completions, []);
    app.watches[1].next([{ ...entry, cups: 99 }]);
    assert.deepEqual(app.store.getState().logs.entries, []);
    await flush();
    assert.deepEqual(app.watches[4].filter, { from: '2026-10-26', to: '2026-11-01' });
    assert.deepEqual(app.watches[5].filter, { day: '2026-11-01' });
    assert.ok(app.watches.slice(0, 3).every(watch => !watch.active));
});

test('unconfigured and failed reads surface honest cloud states', async () => {
    const missing = controllerSetup({ connectError: Object.assign(new Error('Cloud logs aren’t configured.'), { code: 'unconfigured' }) });
    await missing.controller.start();
    assert.equal(missing.store.getState().logs.status, 'unconfigured');
    assert.equal(missing.watches.length, 0);
    const app = controllerSetup();
    await app.controller.start();
    app.watches[1].next([{ ...entry, time: '12:00' }]);
    app.watches[0].error(new Error('Definitions could not load.'));
    assert.equal(app.store.getState().logs.status, 'error');
    assert.match(app.store.getState().logs.error, /Definitions/);
    assert.equal(app.store.getState().logs.entries.length, 1);
});

test('failed saves retain read-ready status and error text so the same draft can retry', async () => {
    let attempts = 0;
    const app = controllerSetup({ save: async () => { if (++attempts === 1) throw Object.assign(new Error('Try saving again.'), { code: 'unavailable' }); } });
    await app.controller.start(); app.ready();
    await assert.rejects(app.controller.saveEntry(entry), /Try saving again/);
    assert.equal(app.store.getState().logs.status, 'ready');
    assert.equal(app.store.getState().logs.saving, false);
    assert.match(app.store.getState().logs.error, /Try saving again/);
    assert.deepEqual(app.store.getState().logs.entries, []);
    await app.controller.saveEntry(entry);
    assert.equal(app.saves.length, 2);
    assert.equal(app.store.getState().logs.error, '');
    assert.equal(app.store.getState().logs.status, 'ready');
});

test('pending writes wait for backend acknowledgement and never repopulate a newly selected day', async () => {
    const gate = deferred();
    const app = controllerSetup({ save: () => gate.promise });
    await app.controller.start(); app.ready();
    let saved = false;
    const operation = app.controller.saveEntry(entry).then(() => { saved = true; });
    await flush();
    assert.equal(saved, false);
    assert.equal(app.store.getState().logs.saving, true);
    app.store.update({ day: new Date(2026, 9, 18) });
    await flush();
    gate.resolve(); await operation;
    assert.equal(saved, true);
    assert.deepEqual(app.store.getState().logs.entries, []);
    assert.equal(app.saves[0].value.day, '2026-10-17');
    assert.equal(app.store.getState().logs.saving, false);
});

test('completion identity is stable per definition/item/day and primary changes clear all prior data', async () => {
    const app = controllerSetup();
    await app.controller.start(); app.ready();
    const value = { customLogId: 'ritual', itemId: 'walk', day: '2026-10-17', completed: true };
    await app.controller.toggleCompletion(value);
    await app.controller.toggleCompletion({ ...value, completed: false });
    assert.equal(app.saves[0].value.id, app.saves[1].value.id);
    assert.equal(app.saves[1].value.completed, false);
    assert.ok(app.saves[0].value.id.length <= 256);
    app.watches[0].next([{ id: 'primary-only', name: 'Primary definition', items: [] }]);
    app.setPrimary(alternate);
    app.store.update({ linking: false });
    assert.deepEqual(app.store.getState().customLogs, []);
    assert.deepEqual(app.store.getState().logs.entries, []);
    await flush();
    assert.equal(app.connections.at(-1), alternate);
    app.controller.destroy();
    app.watches.at(-1).next([{ id: 'late' }]);
    assert.deepEqual(app.store.getState().logs.completions, []);
    await flush();
    assert.equal(app.destroys, 1);
});
