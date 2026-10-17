import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// This suite only targets a localhost emulator and a dedicated fake project.
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Rules tests require a localhost Firestore emulator.');
const project = 'demo-lotus-logs-rules';
const base = host ? 'http://' + host : '';
const documents = base + '/v1/projects/' + project + '/databases/(default)/documents';
const skip = !host;

function token(uid, provider = 'google.com') {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'https://securetoken.google.com/' + project, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600,
        firebase: { sign_in_provider: provider, identities: { 'google.com': ['fake-google-' + uid] } } };
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(claims) + '.';
}
function field(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
    return { mapValue: { fields: fields(value) } };
}
function fields(value) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)])); }
async function request(path, { uid = 'owner', provider = 'google.com', method = 'GET', value } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (uid) headers.Authorization = 'Bearer ' + token(uid, provider);
    return fetch(documents + '/' + path, { method, headers, ...(value ? { body: JSON.stringify({ fields: fields(value) }) } : {}) });
}
function entryPath(id, owner = 'owner') { return 'webLogUsers/' + owner + '/entries/' + encodeURIComponent(id); }
const water = id => ({ id, type: 'water', day: '2026-10-17', time: '12:00', cups: 3 });
async function expectStatus(response, expected) {
    const body = await response.text();
    assert.equal(response.status, expected, body);
}
before(async () => {
    if (!host) return;
    const content = await fs.readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
    const response = await fetch(base + '/emulator/v1/projects/' + project + ':securityRules', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
    });
    await expectStatus(response, 200);
    await fetch(base + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
});
after(async () => {
    if (host) await fetch(base + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
});

test('rules allow an authenticated Google owner and deny anonymous, another owner, and non-Google identities', { skip }, async () => {
    await expectStatus(await request(entryPath('water'), { method: 'PATCH', value: water('water') }), 200);
    await expectStatus(await request(entryPath('water')), 200);
    await expectStatus(await request(entryPath('water'), { uid: null }), 403);
    await expectStatus(await request(entryPath('water'), { uid: 'another-owner' }), 403);
    await expectStatus(await request(entryPath('water'), { provider: 'password' }), 403);
    await expectStatus(await request(entryPath('foreign'), { uid: 'another-owner', method: 'PATCH', value: water('foreign') }), 403);
    await expectStatus(await request(entryPath('water'), { uid: 'another-owner', method: 'DELETE' }), 403);
    await expectStatus(await request('unrelatedCollection/private', { method: 'PATCH', value: { id: 'private' } }), 403);
});

test('all five valid entry schemas are accepted, including partial and complete sleep intervals', { skip }, async () => {
    const entries = [
        { id: 'weight', type: 'weight', day: '2026-10-17', time: '08:15', weight: 145.5, unit: 'lbs' },
        { id: 'workout', type: 'workout', day: '2026-10-17', time: '08:30', workoutType: 'running', name: 'Morning run' },
        { id: 'food', type: 'food', day: '2026-10-17', time: '12:30', name: 'Lunch' },
        water('valid-water'),
        { id: 'sleep', type: 'sleep', day: '2026-10-17', time: '12:00', bedTime: '2026-10-17T05:00:00.000Z', wakeTime: '2026-10-17T13:00:00.000Z' },
        { id: 'partial-sleep', type: 'sleep', day: '2026-10-17', time: '12:00', bedTime: '2026-10-17T05:00:00.000Z', wakeTime: null },
    ];
    for (const entry of entries) await expectStatus(await request(entryPath(entry.id), { method: 'PATCH', value: entry }), 200);
});

test('invalid entry fields, dates, values, type enums and credentials are denied', { skip }, async () => {
    const baseEntry = water('invalid');
    for (const entry of [
        { ...baseEntry, id: 'wrong-document-id' },
        { ...baseEntry, accessToken: 'fake-forbidden-token' },
        { ...baseEntry, cups: -1 }, { ...baseEntry, cups: 100 }, { ...baseEntry, cups: 1.5 },
        { ...baseEntry, cups: '3' }, { ...baseEntry, day: '2026-02-30' }, { ...baseEntry, time: '24:00' },
        { ...baseEntry, type: 'unknown' },
        { id: 'invalid', type: 'weight', day: '2026-10-17', time: '09:00', weight: 0, unit: 'kg' },
        { id: 'invalid', type: 'workout', day: '2026-10-17', time: '09:00', workoutType: 'not-a-workout', name: 'No' },
        { id: 'invalid', type: 'food', day: '2026-10-17', time: '09:00', name: '' },
        { id: 'invalid', type: 'sleep', day: '2026-10-17', time: '09:00', bedTime: null, wakeTime: null },
        { id: 'invalid', type: 'sleep', day: '2026-10-17', time: '09:00', bedTime: '2026-10-17T13:00:00.000Z', wakeTime: '2026-10-17T05:00:00.000Z' },
    ]) await expectStatus(await request(entryPath('invalid'), { method: 'PATCH', value: entry }), 403);
});

test('custom definitions enforce owner, outer schema, bounds and archival instead of deletion', { skip }, async () => {
    const path = 'webLogUsers/owner/customLogs/ritual';
    const definition = { id: 'ritual', name: 'Daily ritual', enabled: true, order: 0, items: [{ id: 'walk', title: 'Walk', enabled: true, order: 0 }] };
    await expectStatus(await request(path, { method: 'PATCH', value: definition }), 200);
    await expectStatus(await request(path, { uid: 'another-owner' }), 403);
    await expectStatus(await request(path, { method: 'DELETE' }), 403);
    await expectStatus(await request(path, { method: 'PATCH', value: { ...definition, enabled: false } }), 200);
    for (const invalid of [
        { ...definition, items: {} }, { ...definition, items: Array(501).fill({}) },
        { ...definition, name: '' }, { ...definition, enabled: 'true' }, { ...definition, order: -1 },
        { ...definition, accessToken: 'fake-forbidden-token' },
    ]) await expectStatus(await request(path, { method: 'PATCH', value: invalid }), 403);
});

test('dated completions require valid identity, date and boolean fields', { skip }, async () => {
    const path = 'webLogUsers/owner/completions/check';
    const completion = { id: 'check', customLogId: 'ritual', itemId: 'walk', day: '2026-10-17', completed: true };
    await expectStatus(await request(path, { method: 'PATCH', value: completion }), 200);
    await expectStatus(await request(path, { uid: 'another-owner' }), 403);
    for (const invalid of [
        { ...completion, completed: 'true' }, { ...completion, day: '2026-02-30' },
        { ...completion, id: 'wrong' }, { ...completion, itemId: '' }, { ...completion, ownerUid: 'owner' },
    ]) await expectStatus(await request(path, { method: 'PATCH', value: invalid }), 403);
});
