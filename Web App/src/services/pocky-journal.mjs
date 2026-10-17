import { journalBlocks, journalText, journalRevision, validateJournalDay, validateJournalBlocks, validateJournalImage, validateJournalDocument, journalDocumentBytes } from '../state/journal-model.mjs?v=journal-1';

function failure(code, message) { return Object.assign(new Error(message), { code, lotusJournal: true }); }
function safeError(error) {
    if (error?.lotusJournal || error instanceof TypeError && error.message.startsWith('Invalid journal data:')) return error;
    const code = error?.code || 'cloud-error';
    return failure(code, code === 'conflict' ? 'This journal changed on another device. Reload it before saving your draft.'
        : code === 'permission-denied' ? 'Journal access was denied. Reconnect your primary Google account.'
            : ['unauthenticated', 'identity-mismatch', 'cancelled'].includes(code) || code.startsWith('auth/') ? 'Your primary account changed or disconnected. Reconnect before saving your journal.'
                : 'Couldn’t access your journal. Please try again.');
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 || value === '.' || value === '..' || /[\/\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Invalid journal data: invalid image id');
    return value;
}
const imageIds = blocks => [...new Set(blocks.filter(block => block.type === 'image').map(block => identifier(block.image)))];
const own = (object, key) => Object.hasOwn(object, key);

/** Uses the connected primary session; this service never opens auth or ends it. */
export function createPockyJournalRepository({ session, now = () => new Date().toISOString() } = {}) {
    if (!session || typeof session.client !== 'function') throw new TypeError('A connected primary Firebase session is required.');
    let disposed = false;
    const subscriptions = new Set();
    function client() {
        if (disposed) throw failure('cancelled', 'Journal is no longer connected.');
        const result = session.client();
        if (!result?.uid || !result.googleSub) throw failure('unauthenticated', 'Connect your primary Google account to access the journal.');
        return result;
    }
    function assertOwner(expected) {
        const current = client();
        if (current.uid !== expected.uid || current.googleSub !== expected.googleSub) throw failure('identity-mismatch', 'The primary account changed. Reload your journal.');
    }
    function reference(current, collection, id) { return current.sdk.doc(current.db, 'users', current.uid, collection, id); }
    function watchDay(day, next, error) {
        validateJournalDay(day);
        const current = client(), images = new Map(), loaded = new Set(), imageStops = new Map();
        let active = true, entry = null, ids = [], detach = () => {};
        function unsubscribe() {
            if (!active) return;
            active = false; subscriptions.delete(unsubscribe); detach();
            imageStops.forEach(stop => stop()); imageStops.clear(); images.clear();
        }
        subscriptions.add(unsubscribe);
        function isCurrent() {
            if (!active || disposed) return false;
            try { assertOwner(current); return true; }
            catch { unsubscribe(); return false; }
        }
        function publish() {
            if (!isCurrent() || !ids.every(id => loaded.has(id))) return;
            next({ day, entry, images: Object.fromEntries(ids.filter(id => images.has(id)).map(id => [id, images.get(id)])) });
        }
        function failed(cause) { if (isCurrent()) error(safeError(cause)); }
        function confirmed(snapshot) { return !snapshot.metadata?.hasPendingWrites && !snapshot.metadata?.fromCache; }
        try {
            detach = current.sdk.onSnapshot(reference(current, 'journal', day), { includeMetadataChanges: true }, snapshot => {
                if (!isCurrent() || !confirmed(snapshot)) return;
                try {
                    const fresh = snapshot.exists() ? validateJournalDocument(snapshot.data()) : null;
                    const references = imageIds(journalBlocks(fresh));
                    entry = fresh; ids = references;
                    for (const [id, stop] of imageStops) if (!ids.includes(id)) { stop(); imageStops.delete(id); images.delete(id); loaded.delete(id); }
                    for (const id of ids) if (!imageStops.has(id)) {
                        // Install the placeholder first because test transports can deliver synchronously.
                        imageStops.set(id, () => {});
                        const stop = current.sdk.onSnapshot(reference(current, 'journalImages', id), { includeMetadataChanges: true }, image => {
                            if (!isCurrent() || !ids.includes(id) || !confirmed(image)) return;
                            try {
                                if (image.exists()) images.set(id, validateJournalImage(image.data())); else images.delete(id);
                                loaded.add(id); publish();
                            } catch (cause) { failed(cause); }
                        }, failed);
                        if (active && ids.includes(id)) imageStops.set(id, stop); else stop();
                    }
                    publish();
                } catch (cause) { failed(cause); }
            }, failed);
            if (!active) detach();
        } catch (cause) { unsubscribe(); throw safeError(cause); }
        return unsubscribe;
    }
    async function saveDay(input) {
        if (!input || !own(input, 'baseEntry')) throw new TypeError('Invalid journal data: the loaded base entry is required');
        const day = validateJournalDay(input.day), blocks = validateJournalBlocks(input.blocks), baseRevision = journalRevision(input.baseEntry);
        const pending = input.images === undefined ? {} : input.images;
        if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new TypeError('Invalid journal data: images must be a map');
        const ids = imageIds(blocks), baseIds = new Set(imageIds(journalBlocks(input.baseEntry)));
        const images = new Map(Object.entries(pending).map(([id, raw]) => {
            identifier(id);
            if (!ids.includes(id)) throw new TypeError('Invalid journal data: new images must be referenced by a block');
            return [id, validateJournalImage({ ...raw, date: raw?.date ?? day, createdAt: raw?.createdAt ?? now() })];
        }));
        // Firestore commits have a 10 MiB request limit; leave room for the journal and protocol overhead.
        if ([...images.values()].reduce((size, image) => size + journalDocumentBytes(image), 0) > 8000000) throw new TypeError('Invalid journal data: add fewer images at a time');
        const current = client(), dayRef = reference(current, 'journal', day);
        try {
            const result = await current.sdk.runTransaction(current.db, async transaction => {
                assertOwner(current);
                const snapshot = await transaction.get(dayRef), latest = snapshot.exists() ? validateJournalDocument(snapshot.data()) : null;
                if (journalRevision(latest) !== baseRevision) throw failure('conflict', 'This journal changed on another device. Reload it before saving your draft.');
                const storedImages = await Promise.all(ids.map(id => transaction.get(reference(current, 'journalImages', id))));
                const outputImages = new Map(), writes = [];
                for (let index = 0; index < ids.length; index++) {
                    const id = ids[index], snapshot = storedImages[index], incoming = images.get(id);
                    if (snapshot.exists()) {
                        const existing = validateJournalImage(snapshot.data());
                        if (incoming && existing.data !== incoming.data) throw failure('image-conflict', 'An image with this ID already exists. Add the image again.');
                        outputImages.set(id, existing);
                    } else if (incoming) { outputImages.set(id, incoming); writes.push([reference(current, 'journalImages', id), incoming]); }
                    else if (!baseIds.has(id)) throw failure('missing-image', 'This image is no longer available. Add the image again.');
                    // A previously broken image reference remains visible as a placeholder, never blocks unrelated edits.
                }
                const originals = new Map(journalBlocks(latest).map(block => [block.id, block]));
                const preserved = blocks.map(block => {
                    const prior = { ...originals.get(block.id) };
                    // Optional known fields may be intentionally cleared, e.g. resetting a crop.
                    for (const key of ['text', 'image', 'crop']) delete prior[key];
                    return { ...prior, ...block };
                });
                const entry = validateJournalDocument({ ...latest, blocks: preserved, text: journalText(preserved), modifiedAt: now() });
                assertOwner(current);
                writes.forEach(([reference, value]) => transaction.set(reference, value));
                // Keep an empty board document rather than destroying unknown day-level metadata.
                transaction.set(dayRef, entry);
                return { day, entry, images: Object.fromEntries(outputImages) };
            });
            assertOwner(current); return result;
        } catch (cause) { throw safeError(cause); }
    }
    function destroy() { if (disposed) return; disposed = true; [...subscriptions].forEach(stop => stop()); }
    return { watchDay, saveDay, destroy };
}
