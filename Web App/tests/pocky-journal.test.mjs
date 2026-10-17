import test from 'node:test';
import assert from 'node:assert/strict';
import { createPockyJournalRepository } from '../src/services/pocky-journal.mjs';

const day = '2026-10-17', prefix = 'users/firebase-primary/';
const text = (values = {}) => ({ id: 'text', type: 'text', x: 12, y: 12, w: 320, h: 140, text: 'Hello', ...values });
const picture = (id = 'image-1', values = {}) => ({ id: 'block-' + id, type: 'image', x: 0, y: 200, w: 300, h: 200, image: id, ...values });
const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64');
const asset = (values = {}) => ({ data: png, date: day, createdAt: '2026-10-17T08:00:00.000Z', ...values });
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(seed = {}, options = {}) {
    const data = new Map(Object.entries(seed).map(([path, value]) => [prefix + path, copy(value)]));
    const watches = [], reads = [], commits = [];
    let current = { uid: 'firebase-primary', googleSub: 'primary' }, authMutations = 0;
    function snapshot(path) { return { exists: () => data.has(path), data: () => copy(data.get(path)), id: path.split('/').at(-1) }; }
    const sdk = {
        doc: (db, ...path) => ({ path: path.join('/') }),
        onSnapshot: (reference, settings, next, error) => { const watch = { reference, settings, next, error, active: true }; watches.push(watch); return () => { watch.active = false; }; },
        runTransaction: async (db, update) => {
            if (options.beforeTransaction) options.beforeTransaction(data);
            const writes = [];
            const result = await update({ get: async reference => { assert.equal(writes.length, 0, 'reads before writes'); reads.push(reference.path); options.onGet?.(reference.path); return snapshot(reference.path); }, set: (reference, value) => writes.push([reference.path, copy(value)]) });
            if (options.ack) await options.ack();
            if (options.fail) throw Object.assign(new Error('secret backend message'), { code: options.fail });
            commits.push(writes); for (const [path, value] of writes) data.set(path, value);
            return result;
        },
    };
    const session = { client: () => { if (!current) throw Object.assign(new Error('not connected'), { code: 'unauthenticated' }); return { ...current, sdk, db: {} }; }, connect() { authMutations++; }, authorize() { authMutations++; }, destroy() { authMutations++; } };
    const repository = createPockyJournalRepository({ session, now: () => '2026-10-17T12:00:00.000Z' });
    function emit(index, value, metadata = {}) { watches[index].next({ metadata, exists: () => value !== undefined, data: () => copy(value) }); }
    return { repository, session, sdk, data, watches, reads, commits, emit, owner: value => { current = value; }, get authMutations() { return authMutations; } };
}

test('day and image reads stay under the verified primary UID and fetch only referenced image documents', () => {
    const app = setup(), values = [];
    app.repository.watchDay(day, value => values.push(value), assert.fail);
    assert.equal(app.watches[0].reference.path, prefix + 'journal/' + day);
    app.emit(0, { blocks: [text(), picture()], text: 'Hello' });
    assert.equal(values.length, 0); assert.equal(app.watches[1].reference.path, prefix + 'journalImages/image-1');
    app.emit(1, asset()); assert.equal(values.length, 1); assert.equal(values[0].images['image-1'].data, png);
    assert.equal(app.watches.length, 2); assert.equal(app.authMutations, 0);
});

test('pending and cached snapshots cannot publish unacknowledged journal or image content', () => {
    const app = setup(), values = [];
    app.repository.watchDay(day, value => values.push(value), assert.fail);
    app.emit(0, { blocks: [text()] }, { hasPendingWrites: true }); app.emit(0, { blocks: [text()] }, { fromCache: true }); assert.equal(values.length, 0);
    app.emit(0, { blocks: [picture()] }); app.emit(1, asset(), { hasPendingWrites: true }); assert.equal(values.length, 0);
    app.emit(1, asset()); assert.equal(values.length, 1);
});

test('missing image docs remain placeholders and changed references unsubscribe old image listeners', () => {
    const app = setup(), values = []; app.repository.watchDay(day, value => values.push(value), assert.fail);
    app.emit(0, { blocks: [picture()] }); app.emit(1, undefined);
    assert.deepEqual(values[0].images, {});
    app.emit(0, { blocks: [picture('image-2')] }); assert.equal(app.watches[1].active, false);
    app.emit(1, asset()); assert.equal(values.length, 1);
    app.emit(2, asset()); assert.deepEqual(Object.keys(values[1].images), ['image-2']);
});

test('malformed known journal or unsafe image values surface errors without leaking content', () => {
    const app = setup(), values = [], errors = []; app.repository.watchDay(day, value => values.push(value), error => errors.push(error));
    app.emit(0, { blocks: [text({ w: -1 })] }); assert.equal(errors.length, 1); assert.equal(values.length, 0);
    app.emit(0, { blocks: [picture()] }); app.emit(1, { data: 'data:image/svg+xml;base64,c2VjcmV0' });
    assert.equal(errors.length, 2); assert.equal(errors[1].message.includes('c2VjcmV0'), false);
});

test('empty days and legacy text entries are readable without writes or random block generation', () => {
    const app = setup(), values = []; app.repository.watchDay(day, value => values.push(value), assert.fail);
    app.emit(0, undefined); assert.equal(values[0].entry, null); assert.deepEqual(values[0].images, {});
    app.emit(0, { text: 'Legacy text', modifiedAt: 'old' }); assert.equal(values[1].entry.text, 'Legacy text');
    assert.equal(app.commits.length, 0);
});

test('first saves atomically create the new image and journal and await backend acknowledgment', async () => {
    const gate = deferred(), app = setup({}, { ack: () => gate.promise });
    let done = false; const saving = app.repository.saveDay({ day, baseEntry: null, blocks: [text(), picture()], images: { 'image-1': { data: png } } }).then(value => { done = true; return value; });
    await flush(); assert.equal(done, false); assert.equal(app.data.size, 0);
    gate.resolve(); const result = await saving;
    assert.equal(app.commits.length, 1); assert.equal(app.commits[0].length, 2); assert.equal(result.entry.text, 'Hello');
    assert.equal(result.images['image-1'].date, day); assert.equal(result.images['image-1'].createdAt, '2026-10-17T12:00:00.000Z');
    assert.equal(app.data.get(prefix + 'journal/' + day).modifiedAt, '2026-10-17T12:00:00.000Z'); assert.equal(app.authMutations, 0);
});

test('concurrent journal changes reject every write including pending images', async () => {
    const original = { blocks: [text()], text: 'Hello', modifiedAt: 'one' };
    const app = setup({ ['journal/' + day]: { ...original, blocks: [text({ text: 'Remote change' })], text: 'Remote change', modifiedAt: 'two' } });
    await assert.rejects(app.repository.saveDay({ day, baseEntry: original, blocks: [text({ text: 'Local change' }), picture()], images: { 'image-1': asset() } }), error => error.code === 'conflict');
    assert.equal(app.commits.length, 0); assert.equal(app.data.has(prefix + 'journalImages/image-1'), false);
});

test('timestamp-only changes do not conflict and unknown entry/block fields survive edits', async () => {
    const original = { blocks: [text({ future: { keep: true } })], text: 'Hello', metadata: { untouched: 1 }, modifiedAt: 'one' };
    const app = setup({ ['journal/' + day]: { ...original, modifiedAt: 'two' } });
    const result = await app.repository.saveDay({ day, baseEntry: original, blocks: [text({ text: 'Edited' })], images: {} });
    assert.deepEqual(result.entry.metadata, original.metadata); assert.deepEqual(result.entry.blocks[0].future, { keep: true }); assert.equal(result.entry.blocks[0].text, 'Edited');
});

test('resetting a crop removes the optional known field while unsupported raw blocks remain intact', async () => {
    const unsupported = { id: 'future', type: 'drawing', strokes: [{ value: 1 }] };
    const original = { blocks: [picture('image-1', { crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, caption: 'retain' }), unsupported], text: '' };
    const app = setup({ ['journal/' + day]: original, 'journalImages/image-1': asset() });
    const result = await app.repository.saveDay({ day, baseEntry: original, blocks: [picture(), unsupported] });
    assert.equal(result.entry.blocks[0].crop, undefined); assert.equal(result.entry.blocks[0].caption, 'retain'); assert.deepEqual(result.entry.blocks[1], unsupported);
});

test('removing image references or clearing a board never deletes underlying images or unknown day metadata', async () => {
    const original = { blocks: [picture()], text: '', future: true };
    const app = setup({ ['journal/' + day]: original, 'journalImages/image-1': asset() });
    await app.repository.saveDay({ day, baseEntry: original, blocks: [] });
    assert.equal(app.data.has(prefix + 'journalImages/image-1'), true); assert.equal(app.data.get(prefix + 'journal/' + day).future, true); assert.deepEqual(app.data.get(prefix + 'journal/' + day).blocks, []);
});

test('existing asset ID collisions reject replacement but identical image retries reuse the immutable document', async () => {
    const app = setup({ 'journalImages/image-1': asset({ retained: true }) });
    const other = 'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64');
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [picture()], images: { 'image-1': asset({ data: other }) } }), error => error.code === 'image-conflict');
    assert.equal(app.commits.length, 0);
    const result = await app.repository.saveDay({ day, baseEntry: null, blocks: [picture()], images: { 'image-1': asset({ createdAt: '2026-10-17T09:00:00Z' }) } });
    assert.equal(result.images['image-1'].retained, true); assert.equal(app.commits[0].length, 1); assert.equal(result.images['image-1'].createdAt, '2026-10-17T08:00:00.000Z');
});

test('missing new image links fail, while a previously broken link permits unrelated journal edits', async () => {
    const app = setup(); await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [picture()] }), error => error.code === 'missing-image');
    assert.equal(app.commits.length, 0);
    const original = { blocks: [picture()], text: '' }; app.data.set(prefix + 'journal/' + day, original);
    const result = await app.repository.saveDay({ day, baseEntry: original, blocks: [picture(), text()] }); assert.equal(result.entry.text, 'Hello'); assert.deepEqual(result.images, {});
});

test('malformed image IDs, unreferenced uploads and absent base revision reject before any writes', async () => {
    const app = setup();
    await assert.rejects(app.repository.saveDay({ day, blocks: [text()] }), /base entry is required/);
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [picture('../private', { id: 'valid-block' })] }), /image id/);
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [text()], images: { orphan: asset() } }), /must be referenced/);
    assert.equal(app.reads.length, 0); assert.equal(app.commits.length, 0);
});

test('denied atomic transactions leave both day and image absent and expose only a safe error', async () => {
    const app = setup({}, { fail: 'permission-denied' });
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [picture()], images: { 'image-1': asset() } }), error => error.code === 'permission-denied' && !error.message.includes('secret'));
    assert.equal(app.data.size, 0);
});

test('combined image upload bytes are bounded before any transaction starts', async () => {
    const app = setup();
    const large = 'data:image/png;base64,' + Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(674800)]).toString('base64');
    assert.ok(large.length < 900000);
    const blocks = Array.from({ length: 9 }, (_, index) => picture('large-' + index));
    const images = Object.fromEntries(blocks.map(block => [block.image, asset({ data: large })]));
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks, images }), /add fewer images at a time/);
    assert.equal(app.reads.length, 0); assert.equal(app.commits.length, 0);
});

test('owner switches abort writes before commit and suppress all stale subscription callbacks', async () => {
    const app = setup(), values = [], errors = []; app.repository.watchDay(day, value => values.push(value), error => errors.push(error));
    app.emit(0, { blocks: [picture()] }); app.owner({ uid: 'firebase-other', googleSub: 'other' }); app.emit(1, asset());
    assert.equal(values.length, 0); assert.equal(errors.length, 0); assert.ok(app.watches.every(watch => !watch.active));
    const changing = setup({}, { onGet: () => changing.owner({ uid: 'firebase-other', googleSub: 'other' }) });
    await assert.rejects(changing.repository.saveDay({ day, baseEntry: null, blocks: [text()] }), error => error.code === 'identity-mismatch'); assert.equal(changing.commits.length, 0);
});

test('destroy stops only journal listeners and never changes shared auth lifecycle', async () => {
    const app = setup(), values = []; app.repository.watchDay(day, value => values.push(value), assert.fail); app.emit(0, { blocks: [picture()] });
    app.repository.destroy(); assert.ok(app.watches.every(watch => !watch.active)); app.emit(1, asset()); assert.equal(values.length, 0);
    await assert.rejects(app.repository.saveDay({ day, baseEntry: null, blocks: [text()] }), error => error.code === 'cancelled'); assert.equal(app.authMutations, 0);
});

test('existing Pocky rules restrict journal and journalImages to the owning UID', { skip: !process.env.POCKY_FIRESTORE_EMULATOR_HOST }, async () => {
    const host = process.env.POCKY_FIRESTORE_EMULATOR_HOST;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Journal rule tests require a localhost emulator.');
    const project = 'demo-lotus-pocky-journal-rules', base = 'http://' + host;
    const docs = base + '/v1/projects/' + project + '/databases/(default)/documents';
    const rules = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{userId}/{document=**} { allow read, write: if request.auth != null && request.auth.uid == userId; } } }";
    const response = await fetch(base + '/emulator/v1/projects/' + project + ':securityRules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }) });
    assert.equal(response.status, 200, await response.text());
    function field(value) {
        if (value === null) return { nullValue: null };
        if (typeof value === 'string') return { stringValue: value };
        if (typeof value === 'number') return { integerValue: String(value) };
        if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
        return { mapValue: { fields: fields(value) } };
    }
    const fields = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)]));
    function token(uid) {
        const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ iss: 'https://securetoken.google.com/' + project, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['fake-google-' + uid] } } }) + '.';
    }
    async function request(path, uid, method = 'GET', value) {
        return fetch(docs + '/' + path, { method, headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: 'Bearer ' + token(uid) } : {}) }, ...(value ? { body: JSON.stringify({ fields: fields(value) }) } : {}) });
    }
    const cleanup = () => fetch(base + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
    await cleanup();
    try {
        for (const [path, value] of [['journal/' + day, { blocks: [text(), picture()], text: 'Hello', modifiedAt: '2026-10-17T12:00:00Z' }], ['journalImages/image-1', asset()]]) {
            const ownPath = 'users/owner/' + path;
            const saved = await request(ownPath, 'owner', 'PATCH', value); assert.equal(saved.status, 200, await saved.text());
            assert.equal((await request(ownPath, 'owner')).status, 200);
            for (const uid of [null, 'another-owner']) {
                assert.equal((await request(ownPath, uid)).status, 403);
                assert.equal((await request(ownPath, uid, 'PATCH', value)).status, 403);
                assert.equal((await request(ownPath, uid, 'DELETE')).status, 403);
            }
        }
    } finally { await cleanup(); }
});
