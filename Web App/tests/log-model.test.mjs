import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_LOGS, WORKOUT_TYPES, validateLogEntry, validateCustomLog, validateCompletion, entriesForDay, workoutDays, formatSleepDuration } from '../src/state/log-model.mjs';

const base = { id: 'entry-one', day: '2026-10-17', time: '08:30' };
const weight = extra => ({ ...base, type: 'weight', weight: 65.4, unit: 'kg', ...extra });

test('catalog includes five persisted native logs, derived streak metadata, and all 78 native workout types', () => {
    assert.deepEqual(BUILT_IN_LOGS.filter(log => !log.derived).map(log => log.id).sort(), ['food', 'sleep', 'water', 'weight', 'workout']);
    assert.equal(BUILT_IN_LOGS.find(log => log.id === 'workout-streak').derived, true);
    assert.equal(WORKOUT_TYPES.length, 78);
    assert.equal(new Set(WORKOUT_TYPES.map(type => type.id)).size, 78);
    assert.equal(WORKOUT_TYPES.find(type => type.id === 'traditional_strength_training').name, 'Traditional Strength Training');
    assert.equal(WORKOUT_TYPES.find(type => type.id === 'mind_and_body').name, 'Mind & Body');
    assert.ok(Object.isFrozen(WORKOUT_TYPES[0]));
});

test('entry validation sanitizes type-specific records without mutating or retaining unrelated fields', () => {
    const source = Object.freeze(weight({ userId: 'private', accessToken: 'secret', cups: 8, fetchedData: {}, source: { day: base.day, kind: 'weights', rawId: base.id } }));
    assert.deepEqual(validateLogEntry(source), { ...base, type: 'weight', weight: 65.4, unit: 'kg' });
    assert.deepEqual(validateLogEntry({ ...base, type: 'workout', workoutType: 'running', name: '  Morning run  ' }), { ...base, type: 'workout', workoutType: 'running', name: 'Morning run' });
    assert.deepEqual(validateLogEntry({ ...base, type: 'food', name: '  Porridge  ', weight: 55 }), { ...base, type: 'food', name: 'Porridge' });
    assert.deepEqual(validateLogEntry({ id: 'water', type: 'water', day: base.day, cups: 0 }), { id: 'water', type: 'water', day: base.day, time: '12:00', cups: 0 });
    assert.equal(source.userId, 'private');
});

test('invalid calendar dates, clocks, numeric values, and derived entry types cannot be stored', () => {
    for (const invalid of [
        weight({ day: '2026-02-29' }), weight({ day: '2026-13-01' }), weight({ day: '2026-10-00' }),
        weight({ day: new Date(2026, 9, 17) }), weight({ time: '24:00' }), weight({ time: '8:30' }),
        weight({ weight: 0 }), weight({ weight: -1 }), weight({ weight: Infinity }), weight({ weight: '65' }),
        weight({ unit: 'stone' }), weight({ id: 'unsafe/path' }), weight({ id: ' padded ' }),
        { ...base, type: 'workout-streak' }, { ...base, type: 'unknown' }, null,
    ]) assert.throws(() => validateLogEntry(invalid), TypeError);
    assert.equal(validateLogEntry(weight({ day: '2028-02-29' })).day, '2028-02-29');
});

test('food requires bounded trimmed text and workouts accept a saved type or a description', () => {
    const food = { ...base, type: 'food' };
    for (const name of ['', '  \n ', 'x'.repeat(501), null]) assert.throws(() => validateLogEntry({ ...food, name }), TypeError);
    assert.equal(validateLogEntry({ ...food, name: 'x'.repeat(500) }).name.length, 500);
    const workout = { ...base, type: 'workout', workoutType: 'yoga' };
    assert.equal(validateLogEntry({ ...workout, name: '  ' }).name, '');
    assert.equal(validateLogEntry(workout).name, '');
    assert.equal(validateLogEntry({ ...workout, workoutType: null, name: '  Free movement  ' }).name, 'Free movement');
    for (const name of ['', ' \n ', undefined]) assert.throws(() => validateLogEntry({ ...workout, workoutType: null, name }), TypeError);
    for (const name of ['x'.repeat(501), null, 42]) assert.throws(() => validateLogEntry({ ...workout, name }), TypeError);
});

test('Pocky custom workout IDs and type-only entries retain identities without storing display metadata', () => {
    const source = Object.freeze({ ...base, type: 'workout', workoutType: 'a6411970-f21b-471b-9985-31aaff77bfda', name: '', typeName: 'My strength routine', color: '#123456', createdAt: '2026-10-18T01:00:00Z' });
    assert.deepEqual(validateLogEntry(source), { ...base, type: 'workout', workoutType: source.workoutType, name: '' });
    assert.equal(validateLogEntry({ ...source, workoutType: 'walk' }).workoutType, 'walk');
    for (const workoutType of ['', 'bad/type', ' padded ', 'x'.repeat(257), 42]) assert.throws(() => validateLogEntry({ ...source, workoutType }), TypeError);
});

test('legacy records with no entered clock use a display fallback for every persisted type', () => {
    for (const entry of [
        weight(), { ...base, type: 'food', name: 'Lunch' }, { ...base, type: 'workout', workoutType: 'walk', name: '' },
        { ...base, type: 'water', cups: 4 }, { ...base, type: 'sleep', wakeTime: '2026-10-17T08:00:00Z' },
    ]) {
        delete entry.time;
        assert.equal(validateLogEntry(entry).time, '12:00');
    }
});

test('water uses bounded integer cup counts and preserves explicit day and time', () => {
    const entry = { ...base, type: 'water' };
    for (const cups of [0, 4, 20, 99]) assert.equal(validateLogEntry({ ...entry, cups }).cups, cups);
    for (const cups of [-1, 100, 1.5, NaN, '4', null]) assert.throws(() => validateLogEntry({ ...entry, cups }), TypeError);
});

test('sleep accepts either time, normalizes ISO instants, and calculates real elapsed hours across daylight saving', () => {
    const sleep = { ...base, type: 'sleep', bedTime: '2026-10-16T23:00:00-07:00', wakeTime: '2026-10-17T08:00:00-07:00' };
    const valid = validateLogEntry(sleep);
    assert.equal(valid.bedTime, '2026-10-17T06:00:00.000Z');
    assert.equal(valid.wakeTime, '2026-10-17T15:00:00.000Z');
    assert.equal(formatSleepDuration(valid), '9.0 h');
    assert.equal(validateLogEntry({ ...sleep, wakeTime: null }).wakeTime, null);
    assert.equal(validateLogEntry({ ...sleep, bedTime: null }).bedTime, null);
    assert.equal(formatSleepDuration({ bedTime: '2026-10-31T23:00:00-07:00', wakeTime: '2026-11-01T08:00:00-08:00' }), '10.0 h');
    assert.equal(formatSleepDuration({ bedTime: '2026-03-07T23:00:00-08:00', wakeTime: '2026-03-08T08:00:00-07:00' }), '8.0 h');
});

test('sleep rejects missing, impossible, timezone-free, equal, and reversed timestamps safely', () => {
    const entry = { ...base, type: 'sleep' };
    for (const change of [
        {}, { bedTime: '2026-10-17T23:00', wakeTime: null }, { bedTime: '2026-02-30T23:00:00Z' },
        { wakeTime: '2026-10-17T24:00:00Z' }, { bedTime: 'invalid' },
        { bedTime: '2026-10-17T08:00:00Z', wakeTime: '2026-10-17T08:00:00Z' },
        { bedTime: '2026-10-17T23:00:00Z', wakeTime: '2026-10-17T08:00:00Z' },
    ]) {
        assert.throws(() => validateLogEntry({ ...entry, ...change }), TypeError);
        assert.equal(formatSleepDuration(change), null);
    }
});

test('custom definitions sanitize nested items and support independent collections without native two-collection cap', () => {
    const input = {
        id: 'reflection', name: '  Reflection  ', secret: 'drop', enabled: false, order: 2,
        items: [{ id: 'gratitude', title: '  Gratitude  ', token: 'drop' }, { id: 'review', title: 'Review', enabled: false, order: 3 }],
    };
    const before = JSON.stringify(input);
    assert.deepEqual(validateCustomLog(input), {
        id: 'reflection', name: 'Reflection', enabled: false, order: 2,
        items: [{ id: 'gratitude', title: 'Gratitude', enabled: true, order: 0 }, { id: 'review', title: 'Review', enabled: false, order: 3 }],
    });
    for (let index = 0; index < 10; index++) assert.equal(validateCustomLog({ id: 'collection-' + index, name: 'Log ' + index }).items.length, 0);
    assert.equal(JSON.stringify(input), before);
});

test('custom definitions reject duplicate item identities, invalid preferences, and unbounded names', () => {
    const valid = { id: 'custom', name: 'Custom', items: [{ id: 'one', title: 'One' }] };
    for (const change of [
        { name: ' ' }, { name: 'x'.repeat(81) }, { enabled: 'true' }, { order: -1 }, { order: 1.5 },
        { items: [{ id: 'same', title: 'One' }, { id: 'same', title: 'Two' }] },
        { items: [{ id: 'one', title: '' }] }, { items: [{ id: 'one', title: 'x'.repeat(161) }] },
        { items: [{ id: 'one', title: 'One', enabled: 1 }] }, { items: 'invalid' },
    ]) assert.throws(() => validateCustomLog({ ...valid, ...change }), TypeError);
});

test('completions have stable independent day/item identities and retain explicit false values', () => {
    const input = { id: 'reflection:one:2026-10-17', customLogId: 'reflection', itemId: 'one', day: base.day, completed: false, accountId: 'drop' };
    assert.deepEqual(validateCompletion(input), { id: input.id, customLogId: 'reflection', itemId: 'one', day: base.day, completed: false });
    for (const change of [{ completed: 'false' }, { completed: undefined }, { day: 'bad' }, { itemId: '' }, { customLogId: 'bad/path' }]) {
        assert.throws(() => validateCompletion({ ...input, ...change }), TypeError);
    }
});

test('day selection compares local calendar strings without mutation or timezone shifts', () => {
    const previous = process.env.TZ;
    const entries = Object.freeze([Object.freeze({ id: 'one', day: '2026-10-17' }), Object.freeze({ id: 'two', day: '2026-10-16' }), Object.freeze({ id: 'three', day: '2026-10-17' })]);
    try {
        for (const timezone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
            process.env.TZ = timezone;
            const result = entriesForDay(entries, new Date(2026, 9, 17));
            assert.deepEqual(result.map(entry => entry.id), ['one', 'three']);
            assert.equal(result[0], entries[0]); assert.notEqual(result, entries);
        }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
    assert.deepEqual(entriesForDay(entries, '2026-02-29'), []);
    assert.deepEqual(entriesForDay(entries, new Date(NaN)), []);
    assert.deepEqual(entriesForDay(null, base.day), []);
});

test('workout streak counts distinct days in the inclusive seven-day window instead of consecutive days or entries', () => {
    const entries = [
        { type: 'workout', day: '2026-10-17' }, { type: 'workout', day: '2026-10-17' },
        { type: 'workout', day: '2026-10-15' }, { type: 'workout', day: '2026-10-11' },
        { type: 'workout', day: '2026-10-10' }, { type: 'workout', day: '2026-10-18' },
        { type: 'food', day: '2026-10-16' }, null,
    ];
    const before = JSON.stringify(entries);
    assert.equal(workoutDays(entries, base.day), 3);
    assert.equal(workoutDays(entries, new Date(2026, 9, 17)), 3);
    assert.equal(workoutDays(Array.from({ length: 7 }, (_, index) => ({ type: 'workout', day: '2026-10-' + (11 + index) })), base.day), 7);
    assert.equal(workoutDays(entries, 'invalid'), 0);
    assert.equal(workoutDays([], base.day), 0);
    assert.equal(JSON.stringify(entries), before);
});
