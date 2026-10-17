import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDay, decodeSettings, decodeDefinitions, decodeCompletions, POCKY_ROUTINES_ID, POCKY_WORKOUT_TYPES } from '../src/services/pocky-log-mapping.mjs';

function inTimezone(zone, work) {
    const previous = process.env.TZ; process.env.TZ = zone;
    try { return work(); }
    finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}
const rawRoutines = () => [
    { id: 'read', name: 'Read', order: 1, archived: false, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'old', name: 'Old habit', order: 0, archived: true },
    { id: 'stretch', name: 'Stretch', order: 0, lotusCollectionId: 'evening' },
    { id: 'unknown-group', name: 'Still visible', order: 2, lotusCollectionId: 'missing-metadata' },
];
const rawGroups = () => [{ id: 'evening', name: 'Evening', enabled: true, order: 1 }];

test('legacy arrays keep original IDs and convert Pocky values without mutating source records', () => {
    inTimezone('America/Los_Angeles', () => {
        const raw = {
            weights: [{ id: 'weight-id', value: 123.4, unit: 'lb', createdAt: '2026-10-17T16:45:00.000Z', unrelated: { keep: true } }],
            workouts: [{ id: 'custom-workout', type: 'my-type', text: '', createdAt: '2026-10-17T17:30:00.000Z' },
                { id: 'description-only', type: null, text: 'A free form workout', time: '11:02' }],
            food: [{ id: 'food-id', text: 'Lunch', time: '12:15', createdAt: '2026-10-17T20:00:00.000Z' }],
            otherLegacyField: { untouched: 'metadata' },
        };
        const before = JSON.stringify(raw);
        const entries = decodeDay('2026-10-17', raw);
        assert.deepEqual(entries.map(entry => [entry.id, entry.type, entry.time]), [
            ['weight-id', 'weight', '09:45'], ['custom-workout', 'workout', '10:30'],
            ['description-only', 'workout', '11:02'], ['food-id', 'food', '12:15'],
        ]);
        assert.equal(entries[0].weight, 123.4); assert.equal(entries[0].unit, 'lbs');
        assert.equal(entries[1].workoutType, 'my-type'); assert.equal(entries[1].name, '');
        assert.equal(entries[2].workoutType, null); assert.equal(entries[2].name, 'A free form workout');
        assert.deepEqual(entries.map(entry => entry.source), [
            { day: '2026-10-17', kind: 'weights', rawId: 'weight-id' },
            { day: '2026-10-17', kind: 'workouts', rawId: 'custom-workout' },
            { day: '2026-10-17', kind: 'workouts', rawId: 'description-only' },
            { day: '2026-10-17', kind: 'food', rawId: 'food-id' },
        ]);
        assert.equal(JSON.stringify(raw), before);
        entries[0].source.rawId = 'view-only-change';
        assert.equal(raw.weights[0].id, 'weight-id');
    });
});

test('time priority is valid explicit clock, local createdAt clock, then noon without moving the record day', () => {
    inTimezone('America/Los_Angeles', () => {
        const entries = decodeDay('2026-10-17', { weights: [
            { id: 'explicit', value: 1, time: '08:07', createdAt: '2026-10-18T03:00:00Z' },
            { id: 'inferred', value: 2, time: '25:00', createdAt: '2026-10-18T03:00:00Z' },
            { id: 'fallback', value: 3, time: 'invalid', createdAt: 'invalid' },
        ] }, { weightUnit: 'kg' });
        assert.deepEqual(entries.map(entry => entry.time), ['08:07', '20:00', '12:00']);
        assert.equal(entries.every(entry => entry.day === '2026-10-17' && entry.unit === 'kg'), true);
    });
});

test('legacy wake and additive sleep decode independently with correct local calendar time', () => {
    inTimezone('America/Los_Angeles', () => {
        const entries = decodeDay('2026-10-17', {
            wake: '06:30', sleep: [{ id: 'sleep-id', bedTime: '2026-10-16T23:00:00-07:00', wakeTime: '2026-10-17T06:30:00-07:00', time: '07:00' }],
        });
        assert.equal(entries.length, 2);
        const legacy = entries.find(entry => entry.source.kind === 'wake');
        const native = entries.find(entry => entry.source.kind === 'sleep');
        assert.equal(legacy.id, 'wake:2026-10-17'); assert.equal(legacy.time, '06:30');
        assert.equal(legacy.wakeTime, '2026-10-17T13:30:00.000Z'); assert.equal(legacy.bedTime, null);
        assert.deepEqual(legacy.source, { day: '2026-10-17', kind: 'wake', rawId: '2026-10-17' });
        assert.equal(native.id, 'sleep-id'); assert.equal(native.bedTime, '2026-10-17T06:00:00.000Z');
        assert.equal(native.wakeTime, legacy.wakeTime);
        assert.deepEqual(decodeDay('2026-10-17', { wake: '', lotusWake: { bedTime: null, wakeTime: null } }), []);
    });
});

test('legacy lotusWake metadata preserves precise time and bed time while following raw clock edits', () => {
    inTimezone('America/Los_Angeles', () => {
        const raw = { wake: '06:30', lotusWake: {
            bedTime: '2026-10-16T23:15:00-07:00', wakeTime: '2026-10-17T06:30:45-07:00', time: '08:00',
        } };
        const before = JSON.stringify(raw);
        const unchanged = decodeDay('2026-10-17', raw)[0];
        assert.equal(unchanged.wakeTime, '2026-10-17T13:30:45.000Z');
        assert.equal(unchanged.bedTime, '2026-10-17T06:15:00.000Z'); assert.equal(unchanged.time, '08:00');
        const changed = decodeDay('2026-10-17', { ...raw, wake: '07:10' })[0];
        assert.equal(changed.id, unchanged.id); assert.equal(changed.wakeTime, '2026-10-17T14:10:00.000Z');
        assert.equal(changed.bedTime, unchanged.bedTime);
        assert.equal(JSON.stringify(raw), before);
        assert.throws(() => decodeDay('2026-10-17', { ...raw, wake: '01:00', lotusWake: {
            ...raw.lotusWake, bedTime: '2026-10-17T02:00:00-07:00',
        } }), /wake time must be after bed time/);
        assert.throws(() => decodeDay('2026-10-17', { ...raw, lotusWake: { wakeTime: 'bad timestamp' } }), /ISO timestamp/);
        assert.deepEqual(decodeDay('2026-10-17', { lotusWake: raw.lotusWake }), []);
    });
});

test('water identity is retained and missing legacy IDs get a stable virtual identity', () => {
    const existing = decodeDay('2026-10-17', { water: { id: 'old-water-id', cups: 3, time: '10:20' } })[0];
    assert.equal(existing.id, 'old-water-id'); assert.equal(existing.cups, 3);
    assert.deepEqual(existing.source, { day: '2026-10-17', kind: 'water', rawId: 'old-water-id' });
    const missing = decodeDay('2026-10-17', { water: { cups: 0 } })[0];
    assert.equal(missing.id, 'water:2026-10-17'); assert.equal(missing.time, '12:00');
    assert.equal(missing.source.rawId, missing.id); assert.equal(missing.cups, 0);
    assert.throws(() => decodeDay('2026-10-17', { water: { cups: 1.5 } }), /water cups/);
});

test('settings preserve editable and archived workout types while supplying isolated Pocky defaults', () => {
    const defaults = decodeSettings();
    assert.equal(defaults.weightUnit, 'lbs');
    assert.deepEqual(defaults.workoutTypes.map(type => type.id), ['walk', 'hike', 'paddling', 'yoga', 'other']);
    defaults.workoutTypes[0].name = 'View edit'; assert.equal(POCKY_WORKOUT_TYPES[0].name, 'Walk');
    const raw = { version: 4, preferences: { keep: true }, trackerSettings: { weightUnit: 'kg', workoutTypes: [
        { id: 'custom', name: 'My activity', color: '#123456', archived: true, unknown: 'keep' },
    ] } };
    const before = JSON.stringify(raw);
    assert.deepEqual(decodeSettings(raw), { weightUnit: 'kg', workoutTypes: [{ id: 'custom', name: 'My activity', color: '#123456', archived: true }] });
    assert.equal(JSON.stringify(raw), before);
    assert.deepEqual(decodeSettings({ trackerSettings: { workoutTypes: [] } }).workoutTypes, []);
    assert.equal(decodeSettings({ trackerSettings: { weightUnit: 'lb' } }).weightUnit, 'lbs');
});

test('routine definitions preserve IDs, archive state, order, and missing-group visibility', () => {
    const routines = rawRoutines(), groups = rawGroups();
    const before = JSON.stringify([routines, groups]);
    const definitions = decodeDefinitions(routines, groups);
    assert.equal(definitions[0].id, POCKY_ROUTINES_ID); assert.equal(definitions[0].name, 'Routines');
    assert.deepEqual(definitions[0].items.map(item => [item.id, item.enabled, item.order]), [
        ['old', false, 0], ['read', true, 1], ['unknown-group', true, 2],
    ]);
    assert.deepEqual(definitions[1], { id: 'evening', name: 'Evening', enabled: true, order: 1,
        items: [{ id: 'stretch', title: 'Stretch', enabled: true, order: 0 }] });
    assert.equal(JSON.stringify([routines, groups]), before);
    definitions[0].items[0].title = 'Changed view'; assert.equal(routines[1].name, 'Old habit');
});

test('virtual Routines metadata can be renamed or hidden without moving original item IDs', () => {
    const definitions = decodeDefinitions(rawRoutines(), [{ id: POCKY_ROUTINES_ID, name: 'My routines', enabled: false, order: 4 }, ...rawGroups()]);
    const virtual = definitions.find(group => group.id === POCKY_ROUTINES_ID);
    assert.equal(virtual.name, 'My routines'); assert.equal(virtual.enabled, false);
    assert.equal(virtual.items.some(item => item.id === 'read'), true);
    const archivedGroup = decodeDefinitions([], [{ id: 'old-group', name: 'Old group', archived: true }]).find(group => group.id === 'old-group');
    assert.equal(archivedGroup.enabled, false);
});

test('completion views retain archived and orphaned checks with the correct current group binding', () => {
    const raw = { routines: { read: true, old: true, stretch: true, orphan: true, unchecked: false }, weights: [{ id: 'unrelated', value: 1 }] };
    const before = JSON.stringify(raw);
    const completions = decodeCompletions('2026-10-17', raw, rawRoutines(), rawGroups());
    assert.deepEqual(completions.map(entry => [entry.itemId, entry.customLogId, entry.day, entry.completed]), [
        ['read', POCKY_ROUTINES_ID, '2026-10-17', true], ['old', POCKY_ROUTINES_ID, '2026-10-17', true],
        ['stretch', 'evening', '2026-10-17', true], ['orphan', POCKY_ROUTINES_ID, '2026-10-17', true],
    ]);
    assert.equal(completions[0].id, 'routine:2026-10-17:read');
    assert.equal(JSON.stringify(raw), before);
    assert.deepEqual(decodeCompletions('2026-10-17', {}), []);
});

test('long routine IDs produce bounded stable completion view IDs without changing item identity', () => {
    const id = 'r'.repeat(256), raw = { routines: { [id]: true } };
    const first = decodeCompletions('2026-10-17', raw)[0];
    assert.equal(first.itemId, id); assert.ok(first.id.length <= 256);
    assert.equal(decodeCompletions('2026-10-17', raw)[0].id, first.id);
    assert.notEqual(decodeCompletions('2026-10-18', raw)[0].id, first.id);
    assert.notEqual(decodeCompletions('2026-10-17', { routines: { ['q'.repeat(256)]: true } })[0].id, first.id);
});

test('malformed known fields fail visibly rather than producing partial or fabricated records', () => {
    const invalid = [
        () => decodeDay('2026-02-30', {}),
        () => decodeDay('2026-10-17', { weights: null }),
        () => decodeDay('2026-10-17', { weights: [{ id: 'bad', value: -1, unit: 'lb' }] }),
        () => decodeDay('2026-10-17', { weights: [{ id: 'bad', value: 1, unit: 'stone' }] }),
        () => decodeDay('2026-10-17', { food: [{ id: 'bad', text: '' }] }),
        () => decodeDay('2026-10-17', { workouts: [{ id: 'bad', type: null, text: '' }] }),
        () => decodeDay('2026-10-17', { wake: '25:00' }),
        () => decodeDay('2026-10-17', { sleep: [{ id: 'bad', bedTime: '2026-10-17T23:00:00Z', wakeTime: '2026-10-17T07:00:00Z' }] }),
        () => decodeCompletions('2026-10-17', { routines: { read: 1 } }),
        () => decodeDefinitions([{ id: 'bad', name: 'Habit', archived: 'false' }]),
        () => decodeDefinitions([{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }]),
        () => decodeDefinitions([], [{ id: 'group', name: 'Group', enabled: 'yes' }]),
        () => decodeSettings({ trackerSettings: { workoutTypes: 'bad' } }),
        () => decodeSettings({ trackerSettings: { weightUnit: 'stones' } }),
    ];
    invalid.forEach(work => assert.throws(work, /Invalid (Pocky )?log data/));
});
