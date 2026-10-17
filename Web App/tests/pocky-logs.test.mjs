import test from 'node:test';
import assert from 'node:assert/strict';
import { createPockyLogsRepository } from '../src/services/pocky-logs.mjs';

const primary = { sub: 'primary', accessToken: 'fake' }, day = '2026-10-17';
const root = 'users/firebase-primary/';
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(seed = {}, options = {}) {
    const data = new Map(Object.entries(seed).map(([path, value]) => [root + path, clone(value)]));
    const watches = [], commits = [], reads = [];
    let owner = null, disposed = false, authorizations = 0;
    function snapshot(reference) {
        const path = reference.path, value = data.get(path);
        return { id: path.split('/').at(-1), exists: () => value !== undefined, data: () => clone(value) };
    }
    const sdk = {
        doc: (db, ...parts) => ({ path: parts.join('/') }), collection: (db, ...parts) => ({ path: parts.join('/'), collection: true }),
        documentId: () => '__name__', where: (field, op, value) => ({ field, op, value }), query: (reference, ...constraints) => ({ ...reference, constraints }),
        getDocs: async reference => ({ docs: [...data.keys()].filter(path => path.startsWith(reference.path + '/') && path.slice(reference.path.length + 1).indexOf('/') < 0).map(path => snapshot({ path })) }),
        onSnapshot: (reference, settings, next, error) => { const watch = { reference, settings, next, error, active: true }; watches.push(watch); return () => { watch.active = false; }; },
        runTransaction: async (db, update) => {
            const staged = [];
            const result = await update({
                get: async reference => { assert.equal(staged.length, 0, 'all transaction reads precede writes'); reads.push(reference.path); return snapshot(reference); },
                set: (reference, value) => staged.push([reference.path, clone(value)]),
            });
            if (options.ack) await options.ack();
            if (options.reject) throw Object.assign(new Error('backend private detail'), { code: options.reject });
            commits.push(staged); staged.forEach(([path, value]) => data.set(path, value)); return result;
        },
    };
    const session = {
        connect: async value => { owner = { uid: 'firebase-' + value.sub, googleSub: value.sub }; return { ...owner }; },
        authorize: async value => { authorizations++; return session.connect(value); },
        client: () => { if (!owner || disposed) throw Object.assign(new Error('no owner'), { code: 'unauthenticated' }); return { sdk, db: {}, ...owner }; },
        destroy: async () => { disposed = true; owner = null; },
    };
    const repository = createPockyLogsRepository({ session, now: () => '2026-10-17T20:00:00.000Z' });
    function emit(index, records, metadata = {}) {
        const watch = watches[index];
        if (watch.reference.collection) watch.next({ metadata, docs: records.map(record => ({ id: record.id, data: () => clone(record) })) });
        else watch.next({ metadata, exists: () => records !== undefined, data: () => clone(records) });
    }
    return { repository, session, data, watches, commits, reads, emit, sdk, get authorizations() { return authorizations; } };
}
const weight = (id = 'weight-1', selected = day) => ({ id, type: 'weight', day: selected, time: '09:15', weight: 140, unit: 'lbs' });
const source = (kind, rawId, selected = day) => ({ day: selected, kind, rawId });

test('all reads are scoped to the primary Pocky UID with document-date range constraints', async () => {
    const app = setup(); await app.repository.connect(primary);
    app.repository.watchEntries({ from: '2026-10-11', to: day }, () => {}, assert.fail);
    assert.equal(app.watches[0].reference.path, root + 'trackerDays');
    assert.deepEqual(app.watches[0].reference.constraints, [{ field: '__name__', op: '>=', value: '2026-10-11' }, { field: '__name__', op: '<=', value: day }]);
    assert.equal(app.watches[1].reference.path, root + 'meta/settings');
    app.repository.watchDefinitions(() => {}, assert.fail);
    assert.equal(app.watches[2].reference.path, root + 'routines');
    assert.equal(app.watches[3].reference.path, root + 'lotusLogCollections');
    assert.ok(app.watches.every(watch => !watch.reference.path.includes('webLogUsers')));
    await app.repository.authorize(primary); assert.equal(app.authorizations, 1);
    await assert.rejects(app.repository.connect({ ...primary, isPrimary: false }), error => error.code === 'identity-mismatch');
});

test('listeners wait for server-confirmed settings/data, map existing records and surface malformed data', async () => {
    const app = setup(); await app.repository.connect(primary);
    const values = [], errors = [];
    app.repository.watchEntries({ from: day, to: day }, value => values.push(value), error => errors.push(error));
    const raw = { id: day, weights: [{ id: 'legacy-weight', value: 143, unit: 'lb', createdAt: '2026-10-17T09:00:00Z' }], privateUnknown: 'not exposed' };
    app.emit(0, [raw], { hasPendingWrites: true }); app.emit(1, {}); assert.equal(values.length, 0);
    app.emit(0, [raw], { fromCache: true }); assert.equal(values.length, 0);
    app.emit(0, [raw]); assert.equal(values[0][0].weight, 143); assert.equal(values[0][0].unit, 'lbs');
    assert.deepEqual(values[0][0].source, source('weights', 'legacy-weight'));
    assert.equal(values[0][0].privateUnknown, undefined);
    app.emit(0, [{ id: day, weights: 'bad' }]); assert.equal(errors[0].code, 'invalid-record');
});

test('definitions and completions reuse original routine identities and shared flat-day completion map', async () => {
    const app = setup(); await app.repository.connect(primary);
    const definitions = [], completions = [];
    app.repository.watchDefinitions(value => definitions.push(value), assert.fail);
    app.emit(0, [{ id: 'routine-1', name: 'Walk', order: 0 }, { id: 'routine-2', name: 'Read', lotusCollectionId: 'evening' }]);
    app.emit(1, [{ id: 'evening', name: 'Evening', enabled: true, order: 1 }]);
    assert.equal(definitions[0][0].id, 'pocky-routines'); assert.equal(definitions[0][1].items[0].id, 'routine-2');
    app.repository.watchCompletions(day, value => completions.push(value), assert.fail);
    app.emit(2, { routines: { 'routine-2': true } }); app.emit(3, [{ id: 'routine-2', name: 'Read', lotusCollectionId: 'evening' }]); app.emit(4, [{ id: 'evening', name: 'Evening' }]);
    assert.equal(completions[0][0].customLogId, 'evening'); assert.equal(completions[0][0].itemId, 'routine-2');
});

test('edits preserve latest unrelated day fields, array rows, raw metadata and creation time', async () => {
    const raw = { wake: '07:30', weights: [{ id: 'weight-1', value: 141, unit: 'lb', createdAt: 'original', imported: true }, { id: 'weight-2', value: 142, unit: 'kg' }], routines: { walk: true }, anotherApp: { unknown: 7 } };
    const app = setup({ ['trackerDays/' + day]: raw }); await app.repository.connect(primary);
    await app.repository.saveEntry({ ...weight(), source: source('weights', 'weight-1'), accessToken: 'never save' });
    const saved = app.data.get(root + 'trackerDays/' + day);
    assert.deepEqual(saved.weights[0], { id: 'weight-1', value: 140, unit: 'lb', createdAt: 'original', imported: true, time: '09:15' });
    assert.equal(saved.weights[1].value, 142);
    assert.deepEqual(saved.routines, raw.routines); assert.deepEqual(saved.anotherApp, raw.anotherApp); assert.equal(saved.wake, raw.wake);
    assert.equal(JSON.stringify(saved).includes('never save'), false);
});

test('unrelated Firestore value objects retain their SDK types and source containers are not mutated', async () => {
    class TimestampLike { constructor() { this.seconds = 10; this.nanoseconds = 5; } toDate() { return new Date(10000); } }
    const special = new TimestampLike(), raw = { weights: [{ id: 'weight-1', value: 141, unit: 'lb', createdAt: special }], foreignTimestamp: special, nested: { referenceLike: special } };
    const app = setup(); await app.repository.connect(primary);
    app.sdk.runTransaction = async (db, update) => update({
        get: async () => ({ exists: () => true, data: () => raw }),
        set: (reference, value) => { assert.equal(value.foreignTimestamp, special); assert.equal(value.nested.referenceLike, special); assert.equal(value.weights[0].createdAt, special); },
    });
    await app.repository.saveEntry({ ...weight(), source: source('weights', 'weight-1') });
    assert.equal(raw.weights[0].value, 141); assert.equal(raw.weights.length, 1);
});

test('moving an existing row changes only original and destination day atomically', async () => {
    const destination = '2026-10-18';
    const app = setup({ ['trackerDays/' + day]: { weights: [{ id: 'weight-1', value: 141, unit: 'lb', origin: true }], food: [{ id: 'food', text: 'Lunch' }] }, ['trackerDays/' + destination]: { wake: '08:00', weights: [{ id: 'another', value: 50, unit: 'kg' }] } });
    await app.repository.connect(primary);
    await app.repository.saveEntry({ ...weight('weight-1', destination), source: source('weights', 'weight-1') });
    assert.equal(app.commits.length, 1); assert.equal(app.commits[0].length, 2);
    const old = app.data.get(root + 'trackerDays/' + day), next = app.data.get(root + 'trackerDays/' + destination);
    assert.equal(old.weights, undefined); assert.equal(old.food[0].id, 'food'); assert.equal(next.wake, '08:00');
    assert.equal(next.weights[1].origin, true);
});

test('duplicate imported IDs require an explicit source for edits and deletes', async () => {
    const other = '2026-10-18';
    const app = setup({ ['trackerDays/' + day]: { weights: [{ id: 'same', value: 100, unit: 'lb' }] }, ['trackerDays/' + other]: { weights: [{ id: 'same', value: 200, unit: 'lb' }] } });
    await app.repository.connect(primary);
    app.repository.watchEntries({ from: day, to: other }, () => {}, assert.fail);
    app.emit(0, [{ id: day, weights: [{ id: 'same', value: 100, unit: 'lb' }] }, { id: other, weights: [{ id: 'same', value: 200, unit: 'lb' }] }]); app.emit(1, {});
    await assert.rejects(app.repository.saveEntry(weight('same')), error => error.code === 'ambiguous-entry');
    await assert.rejects(app.repository.deleteEntry('same'), error => error.code === 'ambiguous-entry');
    await app.repository.deleteEntry('same', source('weights', 'same', other));
    assert.equal(app.data.get(root + 'trackerDays/' + day).weights[0].value, 100);
    assert.equal(app.data.get(root + 'trackerDays/' + other).weights, undefined);
});

test('stale/mismatched routes reject without touching unrelated entries', async () => {
    const app = setup({ ['trackerDays/' + day]: { weights: [{ id: 'other', value: 100, unit: 'lb' }] } }); await app.repository.connect(primary);
    await assert.rejects(app.repository.saveEntry({ ...weight(), source: source('weights', 'different') }), /source does not match/);
    await assert.rejects(app.repository.saveEntry({ ...weight(), source: source('weights', 'weight-1') }), error => error.code === 'missing-entry');
    await assert.rejects(app.repository.deleteEntry('unknown'), error => error.code === 'missing-entry');
    assert.equal(app.commits.length, 0);
});

test('legacy wake edits retain one source wake plus bedtime metadata; delete removes both', async () => {
    const app = setup({ ['trackerDays/' + day]: { wake: '07:00', lotusWake: { unknown: true }, food: [{ id: 'f', text: 'Food' }] } }); await app.repository.connect(primary);
    await app.repository.saveEntry({ id: 'wake:' + day, type: 'sleep', day, time: '08:00', bedTime: '2026-10-17T05:00:00Z', wakeTime: '2026-10-17T15:00:00Z', source: source('wake', day) });
    const raw = app.data.get(root + 'trackerDays/' + day);
    assert.equal(raw.wake, new Date('2026-10-17T15:00:00Z').toTimeString().slice(0, 5));
    assert.equal(raw.lotusWake.bedTime, '2026-10-17T05:00:00.000Z'); assert.equal(raw.lotusWake.unknown, true); assert.equal(raw.sleep, undefined);
    await app.repository.deleteEntry('wake:' + day, source('wake', day));
    const deleted = app.data.get(root + 'trackerDays/' + day); assert.equal(deleted.wake, undefined); assert.equal(deleted.lotusWake, undefined); assert.equal(deleted.food.length, 1);
});

test('additional sleep and water are additive and never overwrite an existing legacy wake', async () => {
    const app = setup({ ['trackerDays/' + day]: { wake: '07:00', arbitrary: true } }); await app.repository.connect(primary);
    await app.repository.saveEntry({ id: 'sleep-new', type: 'sleep', day, time: '09:00', wakeTime: '2026-10-17T16:00:00Z' });
    await app.repository.saveEntry({ id: 'water-new', type: 'water', day, cups: 4 });
    const raw = app.data.get(root + 'trackerDays/' + day); assert.equal(raw.wake, '07:00'); assert.equal(raw.sleep[0].id, 'sleep-new'); assert.equal(raw.water.cups, 4); assert.equal(raw.arbitrary, true);
    await assert.rejects(app.repository.saveEntry({ id: 'different-water', type: 'water', day, cups: 1 }), error => error.code === 'entry-conflict');
});

test('moving wake into an existing wake rejects the whole transaction', async () => {
    const other = '2026-10-18';
    const app = setup({ ['trackerDays/' + day]: { wake: '07:00' }, ['trackerDays/' + other]: { wake: '08:00' } }); await app.repository.connect(primary);
    await assert.rejects(app.repository.saveEntry({ id: 'wake:' + day, type: 'sleep', day: other, wakeTime: '2026-10-18T15:00:00Z', source: source('wake', day) }), error => error.code === 'entry-conflict');
    assert.equal(app.commits.length, 0); assert.equal(app.data.get(root + 'trackerDays/' + day).wake, '07:00');
});

test('native workout types are appended only upon save while custom Pocky IDs remain unchanged', async () => {
    const settings = { version: 4, preferences: { theme: 'green' }, trackerSettings: { weightUnit: 'kg', unknown: true, workoutTypes: [{ id: 'pocky-custom', name: 'My workout', color: '#111111' }] } };
    const app = setup({ 'meta/settings': settings }); await app.repository.connect(primary);
    await app.repository.saveEntry({ id: 'workout-custom', type: 'workout', day, workoutType: 'pocky-custom', name: '' });
    assert.deepEqual(app.data.get(root + 'meta/settings'), settings);
    await app.repository.saveEntry({ id: 'workout-native', type: 'workout', day, workoutType: 'running', name: '' });
    const saved = app.data.get(root + 'meta/settings'); assert.equal(saved.trackerSettings.workoutTypes[1].id, 'running');
    assert.equal(saved.trackerSettings.workoutTypes[0].name, 'My workout'); assert.equal(saved.trackerSettings.unknown, true); assert.deepEqual(saved.preferences, settings.preferences);
    assert.equal(app.data.get(root + 'trackerDays/' + day).workouts[0].type, 'pocky-custom');
    await app.repository.saveEntry({ id: 'workout-other', type: 'workout', day, workoutType: null, name: 'Stairs' });
    assert.equal(app.data.get(root + 'trackerDays/' + day).workouts[2].type, null);
});

test('first native type save retains virtual Pocky defaults while an explicit empty list remains intentional', async () => {
    const app = setup({ 'meta/settings': { preferences: { keep: true }, trackerSettings: { weightUnit: 'lb' } } }); await app.repository.connect(primary);
    await app.repository.saveEntry({ id: 'run', type: 'workout', day, workoutType: 'running' });
    assert.deepEqual(app.data.get(root + 'meta/settings').trackerSettings.workoutTypes.map(type => type.id), ['walk', 'hike', 'paddling', 'yoga', 'other', 'running']);
    assert.deepEqual(app.data.get(root + 'meta/settings').preferences, { keep: true });
    const empty = setup({ 'meta/settings': { trackerSettings: { workoutTypes: [] } } }); await empty.repository.connect(primary);
    await empty.repository.saveEntry({ id: 'run', type: 'workout', day, workoutType: 'running' });
    assert.deepEqual(empty.data.get(root + 'meta/settings').trackerSettings.workoutTypes.map(type => type.id), ['running']);
});

test('completion transactions preserve unrelated routine flags and day fields; unchecking deletes its key', async () => {
    const app = setup({ 'routines/walk': { id: 'walk', name: 'Walk' }, ['trackerDays/' + day]: { wake: '07:00', routines: { read: true }, unknown: 8 } }); await app.repository.connect(primary);
    const value = { id: 'completion', customLogId: 'pocky-routines', itemId: 'walk', day, completed: true };
    await app.repository.saveCompletion(value);
    assert.deepEqual(app.data.get(root + 'trackerDays/' + day).routines, { read: true, walk: true });
    await app.repository.saveCompletion({ ...value, completed: false });
    assert.deepEqual(app.data.get(root + 'trackerDays/' + day).routines, { read: true }); assert.equal(app.data.get(root + 'trackerDays/' + day).unknown, 8);
    const empty = setup({ 'routines/walk': { id: 'walk', name: 'Walk' } }); await empty.repository.connect(primary); await empty.repository.saveCompletion({ ...value, completed: false });
    assert.equal(empty.commits[0].length, 0); assert.equal(empty.data.has(root + 'trackerDays/' + day), false);
});

test('custom groups edit flat routines, preserve omitted concurrent rows and archive explicit items without copying completions', async () => {
    const app = setup({ 'lotusLogCollections/evening': { name: 'Evening', enabled: true, order: 0, extra: true }, 'routines/read': { id: 'read', name: 'Read', order: 0, lotusCollectionId: 'evening', createdAt: 'original', imported: 1 }, 'routines/remove': { id: 'remove', name: 'Old', lotusCollectionId: 'evening' }, 'routines/unrelated': { id: 'unrelated', name: 'Unrelated', createdAt: 'keep' }, ['trackerDays/' + day]: { routines: { read: true } } });
    await app.repository.connect(primary);
    await app.repository.saveCustomLog({ id: 'evening', name: 'Night', enabled: false, order: 2, items: [{ id: 'read', title: 'Read book', enabled: false, order: 1 }, { id: 'new', title: 'Tea', enabled: true, order: 0 }] });
    const read = app.data.get(root + 'routines/read'); assert.equal(read.createdAt, 'original'); assert.equal(read.imported, 1); assert.equal(read.name, 'Read book');
    assert.equal(read.archived, true); assert.equal(app.data.get(root + 'routines/remove').archived, undefined); assert.equal(app.data.get(root + 'routines/unrelated').name, 'Unrelated');
    assert.equal(app.data.get(root + 'lotusLogCollections/evening').extra, true); assert.equal(app.data.get(root + 'lotusLogCollections/evening').enabled, false);
    assert.deepEqual(app.data.get(root + 'trackerDays/' + day).routines, { read: true });
});

test('virtual Routines metadata can be renamed/disabled without changing raw routine membership', async () => {
    const app = setup({ 'routines/walk': { id: 'walk', name: 'Walk' } }); await app.repository.connect(primary);
    await app.repository.saveCustomLog({ id: 'pocky-routines', name: 'Daily habits', enabled: false, order: 3, items: [{ id: 'walk', title: 'Walk', enabled: true, order: 0 }] });
    assert.equal(app.data.get(root + 'lotusLogCollections/pocky-routines').name, 'Daily habits'); assert.equal(app.data.get(root + 'routines/walk').lotusCollectionId, undefined);
});

test('create-only group retries return existing items untouched and new groups atomically add rows', async () => {
    const app = setup({ 'lotusLogCollections/group': { name: 'Existing', enabled: true, order: 1 }, 'routines/existing': { id: 'existing', name: 'Existing item', lotusCollectionId: 'group' } }); await app.repository.connect(primary);
    const value = await app.repository.saveCustomLog({ id: 'group', name: 'Overwrite', items: [] }, { createOnly: true });
    assert.equal(value.name, 'Existing'); assert.equal(value.items[0].id, 'existing'); assert.equal(app.commits[0].length, 0);
    const empty = setup(); await empty.repository.connect(primary); await empty.repository.saveCustomLog({ id: 'group', name: 'New', items: [{ id: 'new', title: 'New item' }] }, { createOnly: true });
    assert.equal(empty.commits[0].length, 2); assert.equal(empty.data.get(root + 'routines/new').lotusCollectionId, 'group');
});

test('cross-group routine identity collisions reject instead of stealing or replacing shared rows', async () => {
    const app = setup({ 'lotusLogCollections/other': { name: 'Other' }, 'routines/existing': { id: 'existing', name: 'Keep', lotusCollectionId: 'other' } }); await app.repository.connect(primary);
    await assert.rejects(app.repository.saveCustomLog({ id: 'new', name: 'New', items: [{ id: 'existing', title: 'Overwrite' }] }), error => error.code === 'entry-conflict');
    assert.equal(app.commits.length, 0); assert.equal(app.data.get(root + 'routines/existing').name, 'Keep');
});

test('backend acknowledgments are awaited and denied saves never mutate cached or confirmed values', async () => {
    const gate = deferred(), app = setup({}, { ack: () => gate.promise }); await app.repository.connect(primary);
    let resolved = false; const saving = app.repository.saveEntry(weight()).then(() => { resolved = true; }); await flush();
    assert.equal(resolved, false); assert.equal(app.data.size, 0); gate.resolve(); await saving; assert.equal(resolved, true);
    const rejected = setup({}, { reject: 'permission-denied' }); await rejected.repository.connect(primary);
    await assert.rejects(rejected.repository.saveEntry(weight()), error => error.code === 'permission-denied' && !error.message.includes('private detail'));
    assert.equal(rejected.data.size, 0); await assert.rejects(rejected.repository.deleteEntry('weight-1'), error => error.code === 'missing-entry');
});

test('owner changes stop listeners, reject stale identity and suppress late callbacks', async () => {
    const app = setup(); await app.repository.connect(primary);
    const values = []; app.repository.watchSettings(value => values.push(value), assert.fail);
    await app.repository.connect({ sub: 'other', accessToken: 'fake' }); assert.equal(app.watches[0].active, false);
    app.emit(0, {}); assert.equal(values.length, 0);
    await app.session.connect(primary);
    await assert.rejects(app.repository.saveEntry(weight()), error => error.code === 'identity-mismatch');
    assert.equal(app.commits.length, 0); await app.repository.destroy();
});

// Optional integration check of the existing Pocky owner rules, isolated from any real project.
test('existing Pocky rules allow only the matching UID for shared tracker/routine/settings/group paths', { skip: !process.env.POCKY_FIRESTORE_EMULATOR_HOST }, async () => {
    const host = process.env.POCKY_FIRESTORE_EMULATOR_HOST;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Pocky rule tests require a localhost emulator.');
    const project = 'demo-lotus-pocky-rules', base = 'http://' + host;
    const documents = base + '/v1/projects/' + project + '/databases/(default)/documents';
    // Exact ownership condition from Pocky/firestore.rules; this fixture is never deployed.
    const rules = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{userId}/{document=**} { allow read, write: if request.auth != null && request.auth.uid == userId; } } }";
    const response = await fetch(base + '/emulator/v1/projects/' + project + ':securityRules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }) });
    assert.equal(response.status, 200, await response.text());
    const fields = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)]));
    function field(value) {
        if (value === null) return { nullValue: null };
        if (typeof value === 'string') return { stringValue: value };
        if (typeof value === 'boolean') return { booleanValue: value };
        if (typeof value === 'number') return { integerValue: String(value) };
        if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
        return { mapValue: { fields: fields(value) } };
    }
    function token(uid) {
        const clock = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ iss: 'https://securetoken.google.com/' + project, aud: project, sub: uid, user_id: uid, iat: clock, exp: clock + 3600, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['fake-google-' + uid] } } }) + '.';
    }
    async function request(path, uid, method = 'GET', value) {
        const headers = { 'Content-Type': 'application/json', ...(uid ? { Authorization: 'Bearer ' + token(uid) } : {}) };
        return fetch(documents + '/' + path, { method, headers, ...(value ? { body: JSON.stringify({ fields: fields(value) }) } : {}) });
    }
    await fetch(base + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
    try {
        const records = [
            ['trackerDays/2026-10-17', { wake: '07:00', routines: { walk: true }, water: { id: 'water', cups: 2, time: '12:00' }, unknownPockyField: true }],
            ['routines/walk', { id: 'walk', name: 'Walk', archived: false }],
            ['meta/settings', { trackerSettings: { weightUnit: 'lb', workoutTypes: [{ id: 'walk', name: 'Walk' }] }, preferences: { retained: true } }],
            ['lotusLogCollections/pocky-routines', { name: 'Routines', enabled: true, order: 0 }],
        ];
        for (const [path, value] of records) {
            const ownPath = 'users/owner/' + path;
            const saved = await request(ownPath, 'owner', 'PATCH', value); assert.equal(saved.status, 200, await saved.text());
            assert.equal((await request(ownPath, 'owner')).status, 200);
            assert.equal((await request(ownPath, null)).status, 403);
            assert.equal((await request(ownPath, 'another-owner')).status, 403);
            assert.equal((await request(ownPath, 'another-owner', 'PATCH', value)).status, 403);
            assert.equal((await request(ownPath, 'another-owner', 'DELETE')).status, 403);
        }
        assert.equal((await request('webLogUsers/owner/entries/anything', 'owner', 'PATCH', { id: 'anything' })).status, 403);
    } finally { await fetch(base + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' }); }
});
