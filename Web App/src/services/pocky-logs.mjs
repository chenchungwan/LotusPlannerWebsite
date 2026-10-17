import { validateLogEntry, validateCustomLog, validateCompletion, WORKOUT_TYPES } from '../state/log-model.mjs?v=pocky-1';
import { decodeDay, decodeSettings, decodeDefinitions, decodeCompletions, POCKY_ROUTINES_ID } from './pocky-log-mapping.mjs?v=pocky-1';

const kinds = { weight: 'weights', workout: 'workouts', food: 'food', water: 'water', sleep: 'sleep' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function failure(code, message) { const result = new Error(message); result.code = code; result.lotusLogs = true; return result; }
function safeError(error) {
    if (error?.lotusLogs || error instanceof TypeError && error.message.startsWith('Invalid log data:')) return error;
    const code = error?.code || 'cloud-error';
    const message = code === 'permission-denied' ? 'Cloud logs access was denied. Please reconnect your primary Google account.'
        : code === 'unauthenticated' || code === 'identity-mismatch' || code.startsWith('auth/') ? 'Reconnect your primary Google account to access cloud logs.'
            : code === 'unconfigured' ? 'Cloud logs aren’t configured yet.'
                : code === 'invalid-record' ? 'Some cloud log records could not be read.'
                    : code === 'cancelled' ? 'The active account changed. Please try again.'
                        : 'Couldn’t access your cloud logs. Please try again.';
    return failure(code, message);
}
function validId(id) {
    if (typeof id !== 'string' || !id || id.length > 256 || id !== id.trim() || id === '.' || id === '..' || /[\/\u0000-\u001f\u007f]/.test(id)) throw new TypeError('Invalid log data: invalid id');
    return id;
}
function validDay(day) { return validateCompletion({ id: 'check', itemId: 'check', customLogId: 'check', day, completed: false }).day; }
function routeKey(source) { return JSON.stringify([source.day, source.kind, source.rawId]); }
function route(id, source) {
    if (!plain(source) || !Object.values(kinds).concat('wake').includes(source.kind)) throw new TypeError('Invalid log data: invalid source');
    const result = { day: validDay(source.day), kind: source.kind, rawId: validId(source.rawId) };
    if (result.kind === 'wake' ? id !== 'wake:' + result.day || result.rawId !== result.day : id !== result.rawId) throw new TypeError('Invalid log data: source does not match entry');
    return result;
}
function objectDay(snapshot) {
    if (!snapshot.exists()) return {};
    const result = snapshot.data();
    if (!plain(result)) throw failure('invalid-record', 'Some cloud log records could not be read.');
    // Copy containers we mutate; retain Firestore Timestamp/GeoPoint/Reference values intact.
    return { ...result };
}
function list(day, kind) {
    if (day[kind] === undefined) return [];
    if (!Array.isArray(day[kind])) throw failure('invalid-record', 'This cloud log could not be edited safely.');
    return day[kind];
}
function localClock(instant) { const date = new Date(instant); return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'); }

/** Adapt the existing Pocky dataset, never copy it into a second user namespace. */
export function createPockyLogsRepository({ session, now = () => new Date().toISOString() } = {}) {
    if (!session || typeof session.connect !== 'function' || typeof session.client !== 'function') throw new TypeError('A primary Firebase session is required.');
    let owner, requestedSub, generation = 0, disposed = false;
    const listeners = new Set(), sources = new Map();
    function stop() { [...listeners].forEach(unsubscribe => unsubscribe()); }
    function client() {
        if (disposed || !owner) throw safeError({ code: 'unauthenticated' });
        let current;
        try { current = session.client(); }
        catch (error) { stop(); owner = undefined; generation++; throw safeError(error); }
        if (current.uid !== owner.uid || current.googleSub !== owner.googleSub) { stop(); owner = undefined; generation++; throw safeError({ code: 'identity-mismatch' }); }
        return current;
    }
    function assertOwner(current) { const active = client(); if (active.uid !== current.uid || active.googleSub !== current.googleSub) throw safeError({ code: 'cancelled' }); }
    async function attach(method, primary) {
        if (disposed) throw safeError({ code: 'cancelled' });
        if (primary?.isPrimary === false || !primary?.sub) throw safeError({ code: 'identity-mismatch' });
        if (requestedSub !== primary.sub) { requestedSub = primary.sub; generation++; stop(); sources.clear(); owner = undefined; }
        const epoch = generation;
        try {
            const result = await session[method](primary);
            if (disposed || epoch !== generation) throw safeError({ code: 'cancelled' });
            const current = session.client();
            if (current.googleSub !== primary.sub || !current.uid) throw safeError({ code: 'identity-mismatch' });
            owner = { uid: current.uid, googleSub: current.googleSub };
            return result || { ...owner };
        } catch (error) { throw safeError(error); }
    }
    function ref(current, collection, id) { return id === undefined ? current.sdk.collection(current.db, 'users', current.uid, collection) : current.sdk.doc(current.db, 'users', current.uid, collection, id); }
    function watchMany(references, next, error) {
        const current = client(), epoch = generation;
        const values = Array(references.length), received = new Set(), detaches = [];
        let active = true;
        const unsubscribe = () => { if (!active) return; active = false; listeners.delete(unsubscribe); detaches.forEach(detach => detach()); };
        listeners.add(unsubscribe);
        try {
            references.forEach((reference, index) => {
                const detach = current.sdk.onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
                    if (!active || disposed || epoch !== generation) return;
                    try {
                        assertOwner(current);
                        if (snapshot.metadata?.hasPendingWrites || snapshot.metadata?.fromCache) return;
                        values[index] = Array.isArray(snapshot.docs) ? snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })) : snapshot.exists() ? snapshot.data() : {};
                        received.add(index);
                        if (received.size === references.length) next(values);
                    } catch (cause) { error(safeError(cause instanceof TypeError ? { code: 'invalid-record' } : cause)); }
                }, cause => { if (active && !disposed && epoch === generation) error(safeError(cause)); });
                detaches.push(detach);
                if (!active) detach();
            });
        } catch (cause) { unsubscribe(); throw safeError(cause); }
        return unsubscribe;
    }
    function remember(entries, range) {
        if (range) for (const [id, routes] of sources) {
            for (const [key, source] of routes) if (source.day >= range.from && source.day <= range.to) routes.delete(key);
            if (!routes.size) sources.delete(id);
        }
        for (const entry of entries) {
            const source = route(entry.id, entry.source);
            if (!sources.has(entry.id)) sources.set(entry.id, new Map());
            sources.get(entry.id).set(routeKey(source), source);
        }
    }
    function sourceFor(id, explicit) {
        validId(id);
        if (explicit !== undefined) return route(id, explicit);
        const matches = sources.get(id);
        if (matches?.size > 1) throw failure('ambiguous-entry', 'This entry occurs on multiple days. Open it again before editing.');
        return matches?.values().next().value;
    }
    function watchSettings(next, error) {
        const current = client();
        return watchMany([ref(current, 'meta', 'settings')], ([settings]) => next(decodeSettings(settings)), error);
    }
    function watchEntries({ from, to }, next, error) {
        validDay(from); validDay(to);
        if (from > to) throw new TypeError('Invalid log date range.');
        const current = client();
        const query = current.sdk.query(ref(current, 'trackerDays'), current.sdk.where(current.sdk.documentId(), '>=', from), current.sdk.where(current.sdk.documentId(), '<=', to));
        return watchMany([query, ref(current, 'meta', 'settings')], ([days, settings]) => {
            const entries = days.flatMap(raw => decodeDay(raw.id, raw, decodeSettings(settings)));
            entries.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
            remember(entries, { from, to }); next(entries);
        }, error);
    }
    function watchDefinitions(next, error) {
        const current = client();
        return watchMany([ref(current, 'routines'), ref(current, 'lotusLogCollections')], ([routines, groups]) => next(decodeDefinitions(routines, groups)), error);
    }
    function watchCompletions(day, next, error) {
        validDay(day); const current = client();
        return watchMany([ref(current, 'trackerDays', day), ref(current, 'routines'), ref(current, 'lotusLogCollections')], ([raw, routines, groups]) => next(decodeCompletions(day, raw, routines, groups)), error);
    }
    function rawEntry(record, existing = {}) {
        const base = { ...existing, id: record.id, time: record.time };
        if (!Object.hasOwn(existing, 'createdAt')) base.createdAt = now();
        if (record.type === 'weight') return { ...base, value: record.weight, unit: record.unit === 'lbs' ? 'lb' : 'kg' };
        if (record.type === 'workout') return { ...base, type: record.workoutType, text: record.name };
        if (record.type === 'food') return { ...base, text: record.name };
        if (record.type === 'water') return { ...base, cups: record.cups };
        return { ...base, bedTime: record.bedTime, wakeTime: record.wakeTime };
    }
    function removeTarget(day, source) {
        if (source.kind === 'wake') {
            if (typeof day.wake !== 'string' || !day.wake) throw failure('missing-entry', 'This entry was removed. Refresh your logs.');
            if (day.lotusWake !== undefined && !plain(day.lotusWake)) throw failure('invalid-record', 'This wake time could not be edited safely.');
            const previous = day.lotusWake || {};
            delete day.wake; delete day.lotusWake; return previous;
        }
        if (source.kind === 'water') {
            if (!plain(day.water) || (day.water.id || 'water:' + source.day) !== source.rawId) throw failure('missing-entry', 'This entry was removed. Refresh your logs.');
            const previous = day.water; delete day.water; return previous;
        }
        const rows = list(day, source.kind), found = rows.filter(row => row?.id === source.rawId);
        if (found.length !== 1) throw failure(found.length ? 'ambiguous-entry' : 'missing-entry', 'This entry changed. Refresh your logs before editing.');
        day[source.kind] = rows.filter(row => row?.id !== source.rawId);
        if (!day[source.kind].length) delete day[source.kind];
        return found[0];
    }
    function insertTarget(day, record, source, existing, index) {
        if (source?.kind === 'wake') {
            if (!record.wakeTime) throw new TypeError('Invalid log data: set a wake time');
            if (day.wake) throw failure('entry-conflict', 'A wake time already exists on that day.');
            day.wake = localClock(record.wakeTime);
            day.lotusWake = { ...existing, bedTime: record.bedTime, wakeTime: record.wakeTime, time: record.time }; return;
        }
        const kind = kinds[record.type];
        if (kind === 'water') {
            if (day.water !== undefined) throw failure('entry-conflict', 'A water total already exists on that day. Refresh your logs.');
            day.water = rawEntry(record, existing); return;
        }
        const rows = list(day, kind);
        if (rows.some(row => row?.id === record.id)) throw failure('entry-conflict', 'This entry already exists. Refresh your logs.');
        const updated = [...rows];
        updated.splice(index === undefined ? updated.length : index, 0, rawEntry(record, existing));
        day[kind] = updated;
    }
    async function saveEntry(input) {
        const record = validateLogEntry(input), source = sourceFor(record.id, input.source), current = client();
        if (source && source.kind !== kinds[record.type] && !(source.kind === 'wake' && record.type === 'sleep')) throw new TypeError('Invalid log data: entry type does not match its source');
        const destinationRef = ref(current, 'trackerDays', record.day), originalRef = source ? ref(current, 'trackerDays', source.day) : destinationRef;
        const settingsRef = ref(current, 'meta', 'settings');
        try {
            await current.sdk.runTransaction(current.db, async transaction => {
                assertOwner(current);
                const oldSnapshot = await transaction.get(originalRef);
                const destinationSnapshot = source?.day !== undefined && source.day !== record.day ? await transaction.get(destinationRef) : oldSnapshot;
                const settingsSnapshot = record.type === 'workout' && WORKOUT_TYPES.some(type => type.id === record.workoutType) ? await transaction.get(settingsRef) : null;
                const oldDay = objectDay(oldSnapshot), destination = source && source.day !== record.day ? objectDay(destinationSnapshot) : oldDay;
                const index = source && source.day === record.day && !['water', 'wake'].includes(source.kind) ? list(oldDay, source.kind).findIndex(row => row?.id === source.rawId) : undefined;
                const existing = source ? removeTarget(oldDay, source) : {};
                insertTarget(destination, record, source, existing, index);
                let updatedSettings;
                if (settingsSnapshot) {
                    const settings = objectDay(settingsSnapshot), tracker = settings.trackerSettings === undefined ? {} : settings.trackerSettings;
                    if (!plain(tracker) || tracker.workoutTypes !== undefined && !Array.isArray(tracker.workoutTypes)) throw failure('invalid-record', 'Workout settings could not be edited safely.');
                    const types = tracker.workoutTypes === undefined ? decodeSettings(settings).workoutTypes : tracker.workoutTypes;
                    if (!types.some(type => type?.id === record.workoutType)) {
                        const type = WORKOUT_TYPES.find(type => type.id === record.workoutType);
                        updatedSettings = { ...settings, trackerSettings: { ...tracker, workoutTypes: [...types, { id: type.id, name: type.name, color: '#8e8e93', archived: false }] } };
                    }
                }
                assertOwner(current);
                if (source && source.day !== record.day) transaction.set(originalRef, oldDay);
                transaction.set(destinationRef, destination);
                if (updatedSettings) transaction.set(settingsRef, updatedSettings);
            });
            assertOwner(current);
            if (source) sources.get(record.id)?.delete(routeKey(source));
            const saved = { ...record, id: source?.kind === 'wake' ? 'wake:' + record.day : record.id, source: { day: record.day, kind: source?.kind === 'wake' ? 'wake' : kinds[record.type], rawId: source?.kind === 'wake' ? record.day : record.id } };
            remember([saved]); return saved;
        } catch (error) { throw safeError(error); }
    }
    async function deleteEntry(id, explicitSource) {
        const source = sourceFor(id, explicitSource), current = client();
        if (!source) throw failure('missing-entry', 'Open this entry again before deleting it.');
        try {
            await current.sdk.runTransaction(current.db, async transaction => {
                assertOwner(current);
                const reference = ref(current, 'trackerDays', source.day), snapshot = await transaction.get(reference), raw = objectDay(snapshot);
                removeTarget(raw, source); assertOwner(current); transaction.set(reference, raw);
            });
            assertOwner(current);
            sources.get(id)?.delete(routeKey(source));
        } catch (error) { throw safeError(error); }
    }
    async function saveCompletion(input) {
        const record = validateCompletion(input), current = client();
        try {
            await current.sdk.runTransaction(current.db, async transaction => {
                assertOwner(current);
                const dayRef = ref(current, 'trackerDays', record.day), routineRef = ref(current, 'routines', record.itemId);
                const [snapshot, routineSnapshot] = await Promise.all([transaction.get(dayRef), transaction.get(routineRef)]);
                if (!routineSnapshot.exists()) throw failure('missing-item', 'This routine was removed. Refresh your logs.');
                const routine = routineSnapshot.data();
                const groupSnapshot = routine.lotusCollectionId && routine.lotusCollectionId !== POCKY_ROUTINES_ID ? await transaction.get(ref(current, 'lotusLogCollections', validId(routine.lotusCollectionId))) : null;
                const group = groupSnapshot?.exists() ? routine.lotusCollectionId : POCKY_ROUTINES_ID;
                if (group !== record.customLogId) throw failure('entry-conflict', 'This routine moved. Refresh your logs.');
                const raw = objectDay(snapshot);
                if (raw.routines !== undefined && !plain(raw.routines)) throw failure('invalid-record', 'This routine day could not be edited safely.');
                const routines = record.completed ? { ...raw.routines, [record.itemId]: true } : { ...raw.routines };
                if (!record.completed) delete routines[record.itemId];
                if (Object.keys(routines).length) raw.routines = routines; else delete raw.routines;
                assertOwner(current);
                if (snapshot.exists() || record.completed) transaction.set(dayRef, raw);
            });
            return record;
        } catch (error) { throw safeError(error); }
    }
    async function saveCustomLog(input, { createOnly = false } = {}) {
        const definition = validateCustomLog(input), current = client();
        try {
            const all = await current.sdk.getDocs(ref(current, 'routines'));
            assertOwner(current);
            const observed = all.docs.map(doc => ({ ...doc.data(), id: doc.id }));
            const allGroups = await current.sdk.getDocs(ref(current, 'lotusLogCollections'));
            assertOwner(current);
            const knownGroups = new Set(allGroups.docs.map(doc => doc.id));
            const inGroup = routine => (knownGroups.has(routine.lotusCollectionId) ? routine.lotusCollectionId : POCKY_ROUTINES_ID) === definition.id;
            const ids = new Set([...observed.filter(inGroup).map(routine => routine.id), ...definition.items.map(item => item.id)]);
            const groupRef = ref(current, 'lotusLogCollections', definition.id);
            return await current.sdk.runTransaction(current.db, async transaction => {
                assertOwner(current);
                const groupSnapshot = groupRef ? await transaction.get(groupRef) : null;
                const snapshots = await Promise.all([...ids].map(id => transaction.get(ref(current, 'routines', id))));
                const rows = snapshots.filter(snapshot => snapshot.exists()).map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
                const referencedGroups = new Set(rows.map(row => row.lotusCollectionId).filter(Boolean));
                const groupSnapshots = await Promise.all([...referencedGroups].map(id => transaction.get(ref(current, 'lotusLogCollections', validId(id)))));
                const existingGroups = new Set(groupSnapshots.filter(snapshot => snapshot.exists()).map(snapshot => snapshot.id));
                const belongsHere = routine => (existingGroups.has(routine.lotusCollectionId) ? routine.lotusCollectionId : POCKY_ROUTINES_ID) === definition.id;
                if (createOnly && (groupSnapshot?.exists() || definition.id === POCKY_ROUTINES_ID)) {
                    const groups = groupSnapshots.filter(snapshot => snapshot.exists()).map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
                    if (groupSnapshot?.exists() && !groups.some(group => group.id === definition.id)) groups.push({ ...groupSnapshot.data(), id: definition.id });
                    return decodeDefinitions(rows, groups).find(group => group.id === definition.id);
                }
                const desired = new Map(definition.items.map(item => [item.id, item]));
                const byId = new Map(rows.map(row => [row.id, row]));
                const writes = [];
                for (const id of ids) {
                    const old = byId.get(id), item = desired.get(id);
                    if (old && !belongsHere(old)) throw failure('entry-conflict', 'A routine moved to another collection. Refresh your logs.');
                    // A stale manager may omit a routine added by another client. Only explicit items are edited.
                    if (!item) continue;
                    const raw = { ...old, id, name: item.title, order: item.order, archived: !item.enabled };
                    if (!old) raw.createdAt = now();
                    if (definition.id === POCKY_ROUTINES_ID) delete raw.lotusCollectionId; else raw.lotusCollectionId = definition.id;
                    writes.push([ref(current, 'routines', id), raw]);
                }
                assertOwner(current);
                if (groupRef) transaction.set(groupRef, { ...(groupSnapshot.exists() ? groupSnapshot.data() : {}), name: definition.name, enabled: definition.enabled, order: definition.order });
                writes.forEach(([reference, value]) => transaction.set(reference, value));
                return definition;
            });
        } catch (error) { throw safeError(error); }
    }
    async function destroy() { if (disposed) return; disposed = true; generation++; owner = undefined; sources.clear(); stop(); await Promise.resolve(session.destroy?.()).catch(() => {}); }
    return { connect: primary => attach('connect', primary), authorize: primary => attach('authorize', primary), watchDefinitions, watchEntries, watchCompletions, watchSettings, saveEntry, deleteEntry, saveCustomLog, saveCompletion, destroy };
}
