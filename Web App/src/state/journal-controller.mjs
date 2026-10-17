import { journalBlocks, journalRevision, validateJournalDay, validateJournalBlocks, validateJournalImage, validateJournalDocument } from './journal-model.mjs?v=journal-1';

const copyEntry = value => value == null ? null : validateJournalDocument(value);
const copyImages = images => Object.fromEntries(Object.entries(images || {}).map(([id, image]) => [id, validateJournalImage(image)]));
const sameBlocks = (one, two) => journalRevision({ blocks: one }) === journalRevision({ blocks: two });
const message = error => error?.message || 'Couldn’t access your journal. Please try again.';
const conflictMessage = 'This journal changed on another device. Your draft is still here. Load the latest version before saving.';
const needsSignIn = error => error?.code === 'unauthenticated' || error?.code === 'identity-mismatch' || (error?.code?.startsWith('auth/') && error.code !== 'auth/network-request-failed');
function dayKey(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        value = [String(value.getFullYear()).padStart(4, '0'), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    }
    return validateJournalDay(value);
}

/** Shared memory-only drafts. Firebase identity belongs to the cloud session owner. */
export function createJournalController({ store, auth, repository, createId = () => globalThis.crypto.randomUUID() }) {
    const drafts = new Map();
    let owner = '', observed = '', started = false, disposed = false;
    let stopStore, stopWatch, generation = 0;

    function primary() { return auth.getSession()?.sub || ''; }
    function cloud() {
        const state = store.getState();
        const value = state.cloud || state.logs || { status: 'loading' };
        return value.ownerSub && value.ownerSub !== primary() ? { status: 'loading', error: '', needsSignIn: false } : value;
    }
    function selectedDay() { return dayKey(store.getState().day); }
    function ready() { return Boolean(owner && owner === primary() && cloud().status === 'ready'); }
    function record(day) {
        if (!drafts.has(day)) drafts.set(day, {
            day, blocks: [], images: {}, newImages: {}, baseEntry: null, remoteEntry: null, remoteImages: {},
            loaded: false, status: 'loading', error: '', needsSignIn: false, dirty: false, saving: false,
            conflict: false, modifiedAt: null, remoteSequence: 0,
        });
        return drafts.get(day);
    }
    function stateFor(value) {
        const connection = cloud();
        const connected = ready();
        return {
            day: value.day, status: connected ? value.status : owner ? connection.status || 'loading' : 'error',
            error: connected ? value.error : connection.error || (owner ? '' : 'Sign in to your primary Google account to open your journal.'),
            needsSignIn: connected ? value.needsSignIn : Boolean(connection.needsSignIn || !owner),
            // Image data is validated at receive/add/save boundaries. Publishing
            // trusted documents must not decode every image on each keystroke.
            blocks: validateJournalBlocks(value.blocks), images: { ...value.images }, dirty: value.dirty,
            saving: value.saving, conflict: value.conflict, modifiedAt: value.modifiedAt,
        };
    }
    function publish(value = record(selectedDay())) {
        if (!disposed && owner === primary() && value.day === selectedDay()) store.update({ journal: stateFor(value) });
    }
    function stop() { generation++; stopWatch?.(); stopWatch = null; }
    function adopt(value, entry, images) {
        value.baseEntry = copyEntry(entry); value.remoteEntry = copyEntry(entry);
        value.remoteImages = copyImages(images); value.images = copyImages(images);
        value.blocks = journalBlocks(entry); value.newImages = {}; value.loaded = true;
        value.status = 'ready'; value.error = ''; value.needsSignIn = false; value.dirty = false; value.conflict = false;
        value.modifiedAt = entry?.modifiedAt || null;
    }
    function receive(value, snapshot) {
        if (snapshot.day !== undefined && snapshot.day !== value.day) throw new TypeError('The journal response belongs to another day.');
        const entry = copyEntry(snapshot.entry), images = copyImages(snapshot.images);
        // Validate every remote block even while preserving a local draft.
        journalBlocks(entry);
        const hadError = value.status === 'error';
        value.remoteSequence++; value.remoteEntry = entry; value.remoteImages = images; value.loaded = true;
        if (!value.dirty && !value.saving) adopt(value, entry, images);
        else {
            value.images = { ...value.images, ...images, ...value.newImages };
            value.status = 'ready'; value.needsSignIn = false;
            if (hadError) value.error = '';
            if (!value.saving && journalRevision(entry) !== journalRevision(value.baseEntry)) {
                value.conflict = true; value.error = conflictMessage;
            }
        }
        publish(value);
    }
    function observe(force = false) {
        if (disposed) return;
        const nextOwner = primary(), day = selectedDay(), connection = cloud();
        const key = JSON.stringify([nextOwner, day, connection.status, connection.error || '', Boolean(connection.needsSignIn)]);
        if (!force && key === observed) return;
        observed = key;
        stop();
        if (nextOwner !== owner) { drafts.clear(); owner = nextOwner; }
        const value = record(day);
        if (!ready()) { publish(value); return; }
        const epoch = generation, capturedOwner = owner;
        value.status = 'loading'; publish(value);
        try {
            const detach = repository.watchDay(day, snapshot => {
                if (disposed || epoch !== generation || capturedOwner !== owner || capturedOwner !== primary()) return;
                try { receive(value, snapshot); }
                catch (error) { value.status = 'error'; value.error = message(error); value.needsSignIn = Boolean(needsSignIn(error)); publish(value); }
            }, error => {
                if (disposed || epoch !== generation || capturedOwner !== owner || capturedOwner !== primary()) return;
                value.status = 'error'; value.error = message(error); value.needsSignIn = Boolean(needsSignIn(error)); publish(value);
            });
            if (disposed || epoch !== generation) detach?.(); else stopWatch = detach;
        } catch (error) { value.status = 'error'; value.error = message(error); value.needsSignIn = Boolean(needsSignIn(error)); publish(value); }
    }
    function editable(day) {
        observe();
        if (disposed) throw new Error('This journal is no longer open.');
        const value = record(dayKey(day));
        if (!ready()) throw new Error(cloud().error || 'Connect your primary Google account before editing your journal.');
        if (!value.loaded || value.status !== 'ready') throw new Error('Wait for this journal day to load before editing.');
        if (value.saving) throw new Error('Wait for your journal to finish saving.');
        return value;
    }
    function uniqueId(occupied) {
        for (let attempt = 0; attempt < 100; attempt++) { const id = createId(); if (!occupied.has(id)) return id; }
        throw new Error('Couldn’t create a unique journal identity. Please try again.');
    }
    function bottom(blocks) { return Math.max(0, ...blocks.map(block => Number.isFinite(block.y) && Number.isFinite(block.h) ? block.y + block.h : 0)) + 12; }
    function edit(value, blocks, newImages = value.newImages) {
        const valid = validateJournalBlocks(blocks);
        const referenced = new Set(valid.filter(block => block.type === 'image').map(block => block.image));
        const images = { ...value.images };
        for (const id of Object.keys(value.newImages)) if (!referenced.has(id)) delete images[id];
        value.newImages = Object.fromEntries(Object.entries(newImages).filter(([id]) => referenced.has(id)));
        value.blocks = valid; value.images = { ...images, ...value.newImages };
        value.dirty = !sameBlocks(valid, journalBlocks(value.baseEntry)) || Object.keys(value.newImages).length > 0;
        value.error = value.conflict ? conflictMessage : ''; publish(value);
    }
    function updateText({ day, id, text }) {
        const value = editable(day);
        const existing = value.blocks.find(block => block.id === id);
        if (existing && existing.type !== 'text') throw new TypeError('Choose a text block to edit.');
        const blockId = id || uniqueId(new Set(value.blocks.map(block => block.id)));
        const blocks = existing
            ? value.blocks.map(block => block.id === blockId ? { ...block, text } : block)
            : [...value.blocks, { id: blockId, type: 'text', x: 12, y: bottom(value.blocks), w: 520, h: 160, text }];
        edit(value, blocks); return blockId;
    }
    function addText(day) { return updateText({ day, text: '' }); }
    function addImages({ day, images }) {
        const value = editable(day);
        if (!Array.isArray(images) || !images.length) return [];
        let blocks = [...value.blocks], pending = { ...value.newImages };
        const occupiedImages = new Set(Object.keys(value.images)), occupiedBlocks = new Set(blocks.map(block => block.id));
        const ids = [];
        for (const raw of images) {
            if (!raw || !Number.isFinite(raw.width) || raw.width <= 0 || !Number.isFinite(raw.height) || raw.height <= 0) throw new TypeError('Choose an image with valid dimensions.');
            const id = raw.id || uniqueId(occupiedImages);
            if (occupiedImages.has(id)) throw new TypeError('That journal image identity is already in use.');
            const image = validateJournalImage({ data: raw.data, width: raw.width, height: raw.height, date: value.day });
            const blockId = uniqueId(occupiedBlocks), width = Math.min(520, raw.width);
            const block = { id: blockId, type: 'image', image: id, x: 12, y: bottom(blocks), w: width, h: Math.max(1, Math.round(width * raw.height / raw.width)) };
            blocks.push(block); occupiedImages.add(id); occupiedBlocks.add(blockId); pending[id] = image; ids.push(id);
        }
        edit(value, blocks, pending); return ids;
    }
    function removeBlock({ day, id }) { const value = editable(day); edit(value, value.blocks.filter(block => block.id !== id)); }
    async function save(day) {
        const value = editable(day);
        if (value.conflict) throw Object.assign(new Error(conflictMessage), { code: 'journal-conflict' });
        if (!value.dirty) return { day: value.day, entry: copyEntry(value.baseEntry), images: copyImages(value.images) };
        const capturedOwner = owner, baseEntry = copyEntry(value.baseEntry), blocks = validateJournalBlocks(value.blocks);
        const images = copyImages(value.newImages), sequence = value.remoteSequence;
        value.saving = true; value.error = ''; publish(value);
        try {
            const result = await repository.saveDay({ day: value.day, baseEntry, blocks, images });
            if (disposed || capturedOwner !== owner || capturedOwner !== primary() || drafts.get(value.day) !== value) return result;
            const resultEntry = copyEntry(result.entry);
            journalBlocks(resultEntry);
            const newer = value.remoteSequence > sequence && journalRevision(value.remoteEntry) !== journalRevision(baseEntry) && journalRevision(value.remoteEntry) !== journalRevision(resultEntry);
            value.saving = false;
            if (newer) {
                value.conflict = true; value.error = conflictMessage; value.status = 'ready';
                value.images = { ...value.images, ...copyImages(result.images), ...value.newImages };
            } else adopt(value, resultEntry, { ...value.images, ...copyImages(result.images) });
            publish(value); return result;
        } catch (error) {
            if (!disposed && capturedOwner === owner && capturedOwner === primary() && drafts.get(value.day) === value) {
                const conflict = error.code === 'journal-conflict' || error.code === 'conflict';
                value.saving = false; value.error = conflict ? conflictMessage : message(error);
                value.conflict ||= conflict; value.needsSignIn = Boolean(needsSignIn(error));
                value.status = value.needsSignIn ? 'error' : 'ready'; publish(value);
            }
            throw error;
        }
    }
    function discard(day) {
        const value = editable(day);
        adopt(value, value.remoteEntry, value.remoteImages); publish(value);
        if (value.day === selectedDay()) observe(true);
    }
    return {
        start() { if (disposed || started) return; started = true; stopStore = store.subscribe(() => observe()); observe(); },
        refresh() { observe(true); }, updateText, addText, addImages, removeBlock, save, discard,
        hasUnsavedChanges() { return !disposed && [...drafts.values()].some(value => value.dirty || value.saving || value.conflict); },
        destroy() {
            if (disposed) return;
            disposed = true; stopStore?.(); stop(); drafts.clear();
            void Promise.resolve().then(() => repository.destroy()).catch(() => {});
        },
    };
}
