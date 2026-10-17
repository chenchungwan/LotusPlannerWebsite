import { validateLogEntry, validateCompletion } from '../state/log-model.mjs?v=pocky-1';

export const POCKY_ROUTINES_ID = 'pocky-routines';
export const POCKY_WORKOUT_TYPES = Object.freeze([
    { id: 'walk', name: 'Walk', color: '#34c759', archived: false },
    { id: 'hike', name: 'Hike', color: '#a2845e', archived: false },
    { id: 'paddling', name: 'Paddling', color: '#0a84ff', archived: false },
    { id: 'yoga', name: 'Yoga', color: '#af52de', archived: false },
    { id: 'other', name: 'Other', color: '#8e8e93', archived: false },
].map(Object.freeze));

const own = (object, key) => Object.hasOwn(object, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function fail(message) { throw new TypeError('Invalid Pocky log data: ' + message); }
function object(value, label) { if (!plain(value)) fail(label + ' must be an object'); return value; }
function identifier(value, label = 'id') {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 ||
        value === '.' || value === '..' || /[\/\u0000-\u001f\u007f]/.test(value)) fail('invalid ' + label);
    return value;
}
function text(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('invalid ' + label);
    return value.trim();
}
function boolean(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') fail(label + ' must be true or false');
    return value;
}
function order(value) {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || value < 0 || value > 1000000) fail('invalid display order');
    return value;
}
function day(value) {
    return validateCompletion({ id: 'day-check', customLogId: 'day-check', itemId: 'day-check', day: value, completed: false }).day;
}
function rows(record, key) {
    if (!own(record, key)) return [];
    if (!Array.isArray(record[key])) fail(key + ' must be a list');
    return record[key];
}
function unit(value, fallback = 'lbs') {
    if (value === undefined) return fallback;
    if (value === 'lb' || value === 'lbs') return 'lbs';
    if (value === 'kg') return 'kg';
    fail('invalid weight unit');
}
function entryTime(entry) {
    if (validTime(entry.time)) return entry.time;
    const created = typeof entry.createdAt === 'string' || entry.createdAt instanceof Date ? new Date(entry.createdAt) : null;
    if (created && Number.isFinite(created.getTime())) {
        return String(created.getHours()).padStart(2, '0') + ':' + String(created.getMinutes()).padStart(2, '0');
    }
    return '12:00';
}
function sourced(entry, selectedDay, kind, rawId) {
    return { ...validateLogEntry(entry), source: { day: selectedDay, kind, rawId } };
}
function sleepInstant(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const validated = validateLogEntry({ id: 'wake-metadata', type: 'sleep', day: '2000-01-01', time: '12:00', [field]: value });
    return validated[field];
}

/** Decode shared settings without writing defaults back to the Pocky settings document. */
export function decodeSettings(rawMetaSettings = {}) {
    const meta = object(rawMetaSettings, 'settings document');
    const settings = own(meta, 'trackerSettings') ? object(meta.trackerSettings, 'tracker settings') : {};
    const workoutTypes = own(settings, 'workoutTypes') ? rows(settings, 'workoutTypes').map(value => {
        const record = object(value, 'workout type');
        if (record.color !== undefined && typeof record.color !== 'string') fail('invalid workout color');
        return {
            id: identifier(record.id, 'workout type id'), name: text(record.name, 'workout type name', 80),
            color: record.color || '#8e8e93', archived: boolean(record.archived, false, 'workout archived'),
        };
    }) : POCKY_WORKOUT_TYPES.map(value => ({ ...value }));
    const ids = new Set();
    for (const workout of workoutTypes) {
        if (ids.has(workout.id)) fail('workout type ids must be unique');
        ids.add(workout.id);
    }
    return { weightUnit: unit(settings.weightUnit), workoutTypes };
}

/** Canonical views retain the exact raw row identity used by the existing apps. */
export function decodeDay(dayId, rawDay = {}, settings = {}) {
    const selectedDay = day(dayId), raw = object(rawDay, 'tracker day');
    const result = [];
    const add = (kind, record, fields) => {
        const row = object(record, kind + ' entry');
        const rawId = identifier(row.id, kind + ' entry id');
        result.push(sourced({ id: rawId, day: selectedDay, time: entryTime(row), ...fields(row) }, selectedDay, kind, rawId));
    };
    for (const record of rows(raw, 'weights')) add('weights', record, row => ({ type: 'weight', weight: row.value, unit: unit(row.unit, unit(settings.weightUnit)) }));
    for (const record of rows(raw, 'workouts')) add('workouts', record, row => {
        if (row.type !== undefined && row.type !== null) identifier(row.type, 'workout type id');
        if (row.text !== undefined && typeof row.text !== 'string') fail('invalid workout description');
        return { type: 'workout', workoutType: row.type ?? null, name: row.text ?? '' };
    });
    for (const record of rows(raw, 'food')) add('food', record, row => ({ type: 'food', name: row.text }));
    for (const record of rows(raw, 'sleep')) add('sleep', record, row => ({ type: 'sleep', bedTime: row.bedTime ?? null, wakeTime: row.wakeTime ?? null }));
    let wakeMetadata = {};
    if (own(raw, 'lotusWake')) {
        const metadata = object(raw.lotusWake, 'wake metadata');
        wakeMetadata = { bedTime: sleepInstant(metadata.bedTime, 'bedTime'),
            wakeTime: sleepInstant(metadata.wakeTime, 'wakeTime'), time: metadata.time };
    }
    if (own(raw, 'wake') && raw.wake !== null && raw.wake !== '') {
        if (!validTime(raw.wake)) fail('wake must be HH:mm');
        let wakeTime = new Date(selectedDay + 'T' + raw.wake + ':00');
        if (!Number.isFinite(wakeTime.getTime())) fail('invalid local wake time');
        if (wakeMetadata.wakeTime) {
            const stored = new Date(wakeMetadata.wakeTime);
            const clock = String(stored.getHours()).padStart(2, '0') + ':' + String(stored.getMinutes()).padStart(2, '0');
            if (clock === raw.wake) wakeTime = stored;
        }
        result.push(sourced({ id: 'wake:' + selectedDay, type: 'sleep', day: selectedDay,
            time: validTime(wakeMetadata.time) ? wakeMetadata.time : raw.wake,
            bedTime: wakeMetadata.bedTime || null, wakeTime: wakeTime.toISOString() }, selectedDay, 'wake', selectedDay));
    }
    if (own(raw, 'water')) {
        const water = object(raw.water, 'water entry');
        const rawId = water.id === undefined ? 'water:' + selectedDay : identifier(water.id, 'water entry id');
        result.push(sourced({ id: rawId, type: 'water', day: selectedDay, time: entryTime(water), cups: water.cups }, selectedDay, 'water', rawId));
    }
    const identities = new Set();
    for (const entry of result) {
        const key = entry.source.kind + ':' + entry.id;
        if (identities.has(key)) fail('duplicate ' + entry.source.kind + ' entry id');
        identities.add(key);
    }
    return result;
}

function bindings(rawRoutines = [], rawGroups = []) {
    if (!Array.isArray(rawRoutines) || !Array.isArray(rawGroups)) fail('routines and groups must be lists');
    const groups = new Map([[POCKY_ROUTINES_ID, { id: POCKY_ROUTINES_ID, name: 'Routines', enabled: true, order: 0, items: [] }]]);
    const groupIds = new Set();
    for (const value of rawGroups) {
        const group = object(value, 'routine collection');
        const groupId = identifier(group.id, 'collection id');
        if (groupIds.has(groupId)) fail('collection ids must be unique');
        groupIds.add(groupId);
        const archived = boolean(group.archived, false, 'collection archived');
        groups.set(groupId, { id: groupId, name: text(group.name, 'collection name', 80),
            enabled: boolean(group.enabled, !archived, 'collection enabled'), order: order(group.order), items: [] });
    }
    const routineGroups = new Map();
    for (const value of rawRoutines) {
        const routine = object(value, 'routine');
        const routineId = identifier(routine.id, 'routine id');
        if (routineGroups.has(routineId)) fail('routine ids must be unique');
        let collectionId = routine.lotusCollectionId;
        if (collectionId !== undefined && collectionId !== null && collectionId !== '') identifier(collectionId, 'routine collection id');
        if (!groups.has(collectionId)) collectionId = POCKY_ROUTINES_ID;
        const item = { id: routineId, title: text(routine.name, 'routine name', 160),
            enabled: !boolean(routine.archived, false, 'routine archived'), order: order(routine.order) };
        groups.get(collectionId).items.push(item); routineGroups.set(routineId, collectionId);
    }
    for (const group of groups.values()) group.items.sort((a, b) => a.order - b.order);
    return { groups, routineGroups };
}

/** Grouping is presentation metadata over the existing routine IDs, never a copy. */
export function decodeDefinitions(rawRoutines = [], groups = []) {
    return [...bindings(rawRoutines, groups).groups.values()].sort((a, b) => a.order - b.order);
}

function completionIdentity(selectedDay, routineId) {
    const readable = 'routine:' + selectedDay + ':' + routineId;
    if (readable.length <= 256) return readable;
    let left = 2166136261, right = 2246822519;
    for (const character of routineId) {
        const code = character.codePointAt(0);
        left = Math.imul(left ^ code, 16777619); right = Math.imul(right ^ code, 3266489917);
    }
    return 'routine:' + selectedDay + ':h-' + (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}

/** Unchecking is absent in the source map; archived and orphaned historical keys stay readable. */
export function decodeCompletions(dayId, rawDay = {}, rawRoutines = [], groups = []) {
    const selectedDay = day(dayId), raw = object(rawDay, 'tracker day');
    const source = own(raw, 'routines') ? object(raw.routines, 'routine completions') : {};
    const { routineGroups } = bindings(rawRoutines, groups);
    const result = [];
    for (const [routineId, completed] of Object.entries(source)) {
        identifier(routineId, 'routine id');
        if (typeof completed !== 'boolean') fail('routine completion must be true or false');
        if (!completed) continue;
        result.push(validateCompletion({ id: completionIdentity(selectedDay, routineId),
            customLogId: routineGroups.get(routineId) || POCKY_ROUTINES_ID, itemId: routineId, day: selectedDay, completed: true }));
    }
    return result;
}
