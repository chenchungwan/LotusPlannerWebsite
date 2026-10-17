// User log values are separate from layout definitions and Google account data.
export const BUILT_IN_LOGS = Object.freeze([
    { id: 'sleep', name: 'Sleep', derived: false },
    { id: 'weight', name: 'Weight', derived: false },
    { id: 'workout', name: 'Workout', derived: false },
    { id: 'food', name: 'Food', derived: false },
    { id: 'water', name: 'Water', derived: false },
    { id: 'workout-streak', name: 'Workout streak', derived: true },
].map(Object.freeze));

// Raw identifiers and labels match the native Lotus Planner workout picker.
export const WORKOUT_TYPES = Object.freeze([
    ['archery', 'Archery'], ['badminton', 'Badminton'], ['barre', 'Barre'],
    ['baseball', 'Baseball'], ['basketball', 'Basketball'], ['bowling', 'Bowling'],
    ['boxing', 'Boxing'], ['climbing', 'Climbing'], ['cooldown', 'Cooldown'],
    ['core_training', 'Core Training'], ['cricket', 'Cricket'], ['cross_training', 'Cross Training'],
    ['curling', 'Curling'], ['cycling', 'Cycling'], ['dance', 'Dance'],
    ['disc_sports', 'Disc Sports'], ['elliptical', 'Elliptical'], ['equestrian_sports', 'Equestrian Sports'],
    ['fencing', 'Fencing'], ['fishing', 'Fishing'], ['fitness_gaming', 'Fitness Gaming'],
    ['flexibility', 'Flexibility'], ['american_football', 'American Football'],
    ['australian_football', 'Australian Football'], ['functional_strength_training', 'Functional Strength Training'],
    ['golf', 'Golf'], ['gymnastics', 'Gymnastics'], ['hand_cycling', 'Hand Cycling'],
    ['handball', 'Handball'], ['hiit', 'HIIT'], ['hiking', 'Hiking'], ['hockey', 'Hockey'],
    ['hunting', 'Hunting'], ['jump_rope', 'Jump Rope'], ['kickboxing', 'Kickboxing'],
    ['lacrosse', 'Lacrosse'], ['martial_arts', 'Martial Arts'], ['mind_and_body', 'Mind & Body'],
    ['mixed_cardio', 'Mixed Cardio'], ['multisport', 'Multisport'], ['paddling', 'Paddling'],
    ['pickleball', 'Pickleball'], ['pilates', 'Pilates'], ['play', 'Play'],
    ['racquetball', 'Racquetball'], ['rolling', 'Rolling'], ['rowing', 'Rowing'],
    ['rugby', 'Rugby'], ['running', 'Running'], ['sailing', 'Sailing'], ['skating', 'Skating'],
    ['cross_country_skiing', 'Cross Country Skiing'], ['downhill_skiing', 'Downhill Skiing'],
    ['snow_sports', 'Snow Sports'], ['snowboarding', 'Snowboarding'], ['soccer', 'Soccer'],
    ['social_dance', 'Social Dance'], ['softball', 'Softball'], ['squash', 'Squash'],
    ['stair_stepper', 'Stair Stepper'], ['stairs', 'Stairs'], ['step_training', 'Step Training'],
    ['surfing', 'Surfing'], ['swimming', 'Swimming'], ['table_tennis', 'Table Tennis'],
    ['tai_chi', 'Tai Chi'], ['tennis', 'Tennis'], ['track_and_field', 'Track & Field'],
    ['traditional_strength_training', 'Traditional Strength Training'], ['volleyball', 'Volleyball'],
    ['walking', 'Walking'], ['water_fitness', 'Water Fitness'], ['water_polo', 'Water Polo'],
    ['water_sports', 'Water Sports'], ['wheelchair', 'Wheelchair'], ['wrestling', 'Wrestling'],
    ['yoga', 'Yoga'], ['other', 'Other'],
].map(([id, name]) => Object.freeze({ id, name })));

const entryTypes = new Set(BUILT_IN_LOGS.filter(log => !log.derived).map(log => log.id));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const fail = message => { throw new TypeError('Invalid log data: ' + message); };

function id(value, label = 'id') {
    if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() ||
        value === '.' || value === '..' || /[\/\u0000-\u001f\u007f]/.test(value)) fail('invalid ' + label);
    return value;
}

function dateKey(value) {
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) return null;
        value = [String(value.getFullYear()).padStart(4, '0'), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

function day(value) {
    // Stored day fields are calendar strings, never converted from UTC instants.
    if (typeof value !== 'string' || !dateKey(value)) fail('day must be a valid YYYY-MM-DD date');
    return value;
}

function text(value, label, limit) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) fail(label + ' must contain 1–' + limit + ' characters');
    return value.trim();
}

function enabled(value) {
    if (value === undefined) return true;
    if (typeof value !== 'boolean') fail('enabled must be true or false');
    return value;
}

function order(value) {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || value < 0 || value > 1000000) fail('order must be a nonnegative integer');
    return value;
}

function instant(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) ||
        !dateKey(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) fail(label + ' must be an ISO timestamp with a timezone');
    return new Date(value).toISOString();
}

/** Validate and copy only the persisted fields belonging to this entry type. */
export function validateLogEntry(input) {
    if (!plain(input) || !entryTypes.has(input.type)) fail('unknown entry type');
    // Pocky records may have only a creation timestamp and no entered clock.
    const time = input.time === undefined ? '12:00' : input.time;
    if (!validTime(time)) fail('time must be HH:mm');
    const result = { id: id(input.id), type: input.type, day: day(input.day), time };
    if (input.type === 'weight') {
        if (!Number.isFinite(input.weight) || input.weight <= 0) fail('weight must be a positive number');
        if (!['lbs', 'kg'].includes(input.unit)) fail('weight unit must be lbs or kg');
        return { ...result, weight: input.weight, unit: input.unit };
    }
    if (input.type === 'workout') {
        const workoutType = input.workoutType === undefined || input.workoutType === null ? null : id(input.workoutType, 'workout type');
        const name = input.name === undefined ? '' : input.name;
        if (typeof name !== 'string' || name.trim().length > 500) fail('workout description must contain no more than 500 characters');
        if (!workoutType && !name.trim()) fail('choose a workout type or enter a description');
        return { ...result, workoutType, name: name.trim() };
    }
    if (input.type === 'food') return { ...result, name: text(input.name, 'food name', 500) };
    if (input.type === 'water') {
        if (!Number.isInteger(input.cups) || input.cups < 0 || input.cups > 99) fail('water cups must be an integer from 0 to 99');
        return { ...result, cups: input.cups };
    }
    const bedTime = instant(input.bedTime, 'bed time'), wakeTime = instant(input.wakeTime, 'wake time');
    if (!bedTime && !wakeTime) fail('set a bed time or wake time');
    if (bedTime && wakeTime && Date.parse(wakeTime) <= Date.parse(bedTime)) fail('wake time must be after bed time');
    return { ...result, bedTime, wakeTime };
}

/** Custom collections have stable identities and independently enabled items. */
export function validateCustomLog(input) {
    if (!plain(input)) fail('custom log must be an object');
    const source = input.items === undefined ? [] : input.items;
    if (!Array.isArray(source) || source.length > 500) fail('custom log needs no more than 500 items');
    const seen = new Set();
    const items = source.map(item => {
        if (!plain(item)) fail('custom log item must be an object');
        const itemId = id(item.id, 'item id');
        if (seen.has(itemId)) fail('custom log item ids must be unique');
        seen.add(itemId);
        return { id: itemId, title: text(item.title, 'item title', 160), enabled: enabled(item.enabled), order: order(item.order) };
    });
    return { id: id(input.id), name: text(input.name, 'custom log name', 80), enabled: enabled(input.enabled), order: order(input.order), items };
}

export function validateCompletion(input) {
    if (!plain(input) || typeof input.completed !== 'boolean') fail('completion must be true or false');
    return { id: id(input.id), customLogId: id(input.customLogId, 'custom log id'), itemId: id(input.itemId, 'item id'), day: day(input.day), completed: input.completed };
}

/** Return a new array in source order; day Date arguments use the local day. */
export function entriesForDay(entries, selectedDay) {
    const selected = dateKey(selectedDay);
    if (!Array.isArray(entries) || !selected) return [];
    return entries.filter(entry => entry && entry.day === selected);
}

/** Number of distinct workout dates in the rolling 7 days, including selectedDay. */
export function workoutDays(entries, selectedDay) {
    const selected = dateKey(selectedDay);
    if (!Array.isArray(entries) || !selected) return 0;
    const date = new Date(selected + 'T12:00:00.000Z');
    const window = new Set();
    for (let offset = 0; offset < 7; offset++) {
        window.add(date.toISOString().slice(0, 10)); date.setUTCDate(date.getUTCDate() - 1);
    }
    return new Set(entries.filter(entry => entry?.type === 'workout' && window.has(entry.day)).map(entry => entry.day)).size;
}

/** Decimal hours as in the native app, without its reversed-time duration bug. */
export function formatSleepDuration(entry) {
    try {
        const bed = instant(entry?.bedTime, 'bed time'), wake = instant(entry?.wakeTime, 'wake time');
        if (!bed || !wake) return null;
        const hours = (Date.parse(wake) - Date.parse(bed)) / 3600000;
        return hours > 0 ? hours.toFixed(1) + ' h' : null;
    } catch { return null; }
}
