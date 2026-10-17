import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournalController } from '../src/state/journal-controller.mjs';
import { createPlannerStore } from '../src/state/planner-store.mjs';
import { journalText } from '../src/state/journal-model.mjs';

const primary = { sub: 'primary-google' }, alternate = { sub: 'alternate-google' };
const key = '2026-10-17';
const png = 'data:image/png;base64,iVBORw0KGgo=';
const block = (id = 'text', text = 'Original') => ({ id, type: 'text', x: 40, y: 70, w: 360, h: 160, text });
const entry = (blocks = [block()], extra = {}) => ({ blocks, text: journalText(blocks), modifiedAt: '2026-10-17T12:00:00.000Z', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ cloud, logs, save, createId } = {}) {
    let current = primary, ids = 0, destroys = 0;
    const store = createPlannerStore({ day: new Date(2026, 9, 17), cloud: cloud || { status: 'ready', ownerSub: primary.sub }, logs: logs || { status: 'ready' } });
    const watches = [], saves = [];
    const repository = {
        watchDay(day, next, error) { const watch = { day, next, error, active: true }; watches.push(watch); return () => { watch.active = false; }; },
        async saveDay(value) {
            saves.push(value);
            if (save) return save(value);
            return { day: value.day, entry: entry(value.blocks, { ...(value.baseEntry || {}), blocks: value.blocks, text: journalText(value.blocks), modifiedAt: '2026-10-17T13:00:00.000Z' }), images: value.images };
        },
        destroy() { destroys++; },
    };
    const controller = createJournalController({ store, auth: { getSession: () => current }, repository, createId: createId || (() => 'journal-id-' + (++ids)) });
    function emit(value = null, images = {}, watch = watches.at(-1)) { watch.next({ day: watch.day, entry: value, images }); }
    return { store, controller, repository, watches, saves, emit, setPrimary(value) { current = value; }, get state() { return store.getState().journal; }, get destroys() { return destroys; } };
}

test('one shared selected-day subscription waits for independent cloud readiness, regardless of failed log reads', () => {
    const app = setup({ cloud: { status: 'loading', ownerSub: primary.sub }, logs: { status: 'ready' } });
    app.controller.start(); app.controller.start(); assert.equal(app.watches.length, 0); assert.equal(app.state.status, 'loading');
    app.store.update({ cloud: { status: 'ready', ownerSub: primary.sub }, logs: { status: 'error', error: 'Malformed tracker day' } });
    assert.equal(app.watches.length, 1); assert.equal(app.watches[0].day, key);
    app.emit(entry()); assert.equal(app.state.status, 'ready'); assert.equal(app.state.error, '');
    app.store.update({ logs: { status: 'error', error: 'Another log failure', needsSignIn: true } });
    assert.equal(app.watches.length, 1); assert.equal(app.state.status, 'ready'); assert.equal(app.state.needsSignIn, false);
    app.controller.updateText({ day: key, id: 'text', text: 'Journal is independent' }); assert.equal(app.state.dirty, true);
    app.controller.destroy();
});

test('legacy text and raw block metadata stay intact while edits share one memory draft', () => {
    const app = setup(); app.controller.start(); app.emit({ text: 'Legacy entry', modifiedAt: 'old', future: { preserve: true } });
    assert.equal(app.state.blocks[0].id, 'legacy-text');
    app.controller.updateText({ day: key, id: 'legacy-text', text: 'Changed legacy' });
    assert.equal(app.state.blocks[0].text, 'Changed legacy'); assert.equal(app.state.dirty, true);
    const other = setup(); other.controller.start();
    const original = entry([{ ...block(), border: { color: 'purple' } }, { id: 'future', type: 'audio', payload: { keep: 'raw' } }], { unknownEntry: 'keep' });
    const before = JSON.stringify(original); other.emit(original);
    other.controller.updateText({ day: key, id: 'text', text: 'Edited' });
    assert.deepEqual(other.state.blocks[0].border, { color: 'purple' });
    assert.deepEqual(other.state.blocks[1], original.blocks[1]); assert.equal(JSON.stringify(original), before);
    app.controller.destroy(); other.controller.destroy();
});

test('virtual empty text creates a bottom block and invalid updates never partly mutate the draft', () => {
    const app = setup(); app.controller.start(); app.emit();
    app.controller.updateText({ day: key, id: 'lotus-text-' + key, text: 'First words' });
    assert.equal(app.state.blocks[0].id, 'lotus-text-' + key); assert.equal(app.state.blocks[0].y, 12);
    const second = app.controller.addText(new Date(2026, 9, 17));
    assert.equal(app.state.blocks[1].id, second); assert.equal(app.state.blocks[1].y, 184);
    const before = app.state.blocks;
    assert.throws(() => app.controller.updateText({ day: key, id: second, text: 'x'.repeat(200001) }));
    assert.deepEqual(app.state.blocks, before); app.controller.destroy();
});

test('drafts survive date/layout/cloud-refresh changes and unsaved checks are side-effect free', () => {
    const app = setup(); app.controller.start(); app.emit(entry());
    app.controller.updateText({ day: key, id: 'text', text: 'Keep this draft' });
    const old = app.watches[0];
    app.store.update({ day: new Date(2026, 9, 18) }); app.emit();
    assert.equal(app.state.day, '2026-10-18'); assert.equal(app.state.dirty, false); assert.equal(app.controller.hasUnsavedChanges(), true);
    old.next({ day: key, entry: entry([block('text', 'Late response')]), images: {} });
    assert.equal(app.state.day, '2026-10-18'); assert.equal(app.state.blocks.length, 0);
    app.store.update({ day: new Date(2026, 9, 17) }); app.emit(entry());
    assert.equal(app.state.blocks[0].text, 'Keep this draft'); assert.equal(app.state.dirty, true);
    app.store.update({ arbitraryLayoutChange: true }); assert.equal(app.state.blocks[0].text, 'Keep this draft');
    app.store.update({ cloud: { status: 'loading', ownerSub: primary.sub } });
    assert.equal(app.state.status, 'loading'); assert.equal(app.state.dirty, true);
    assert.throws(() => app.controller.updateText({ day: key, id: 'text', text: 'Blocked' }), /Connect/);
    app.store.update({ cloud: { status: 'ready', ownerSub: primary.sub } }); app.emit(entry());
    assert.equal(app.state.blocks[0].text, 'Keep this draft');
    let updates = 0; const stop = app.store.subscribe(() => updates++); const watches = app.watches.length;
    assert.equal(app.controller.hasUnsavedChanges(), true); assert.equal(app.controller.hasUnsavedChanges(), true);
    assert.equal(updates, 0); assert.equal(app.watches.length, watches); stop(); app.controller.destroy();
});

test('images append referenced blocks, upload only new documents, and removal does not delete stored images', async () => {
    const app = setup(); app.controller.start();
    const imageBlock = { id: 'existing-block', type: 'image', image: 'existing-image', x: 12, y: 12, w: 200, h: 150, crop: { x: .1, y: 0, w: .9, h: 1 } };
    app.emit(entry([imageBlock]), { 'existing-image': { data: png, date: key } });
    const [id] = app.controller.addImages({ day: key, images: [{ data: png, width: 400, height: 300 }] });
    assert.equal(app.state.blocks[1].image, id); assert.equal(app.state.blocks[1].y, 174);
    assert.equal(app.state.images[id].data, png); assert.deepEqual(app.state.blocks[0].crop, imageBlock.crop);
    app.controller.removeBlock({ day: key, id: 'existing-block' });
    await app.controller.save(key);
    assert.deepEqual(Object.keys(app.saves[0].images), [id]); assert.equal(app.saves[0].blocks.length, 1);
    assert.equal(app.saves[0].baseEntry.blocks[0].image, 'existing-image');
    assert.equal(app.state.dirty, false); app.controller.destroy();
});

test('new images removed before Save are never uploaded and partial invalid image batches are rejected atomically', () => {
    const app = setup(); app.controller.start(); app.emit();
    const [id] = app.controller.addImages({ day: key, images: [{ id: 'new-image', data: png, width: 20, height: 20 }] });
    app.controller.removeBlock({ day: key, id: app.state.blocks[0].id });
    assert.equal(app.state.dirty, false); assert.equal(app.state.images[id], undefined);
    assert.throws(() => app.controller.addImages({ day: key, images: [{ data: png, width: 100, height: 100 }, { data: 'bad', width: 100, height: 100 }] }));
    assert.equal(app.state.blocks.length, 0); assert.deepEqual(app.state.images, {}); app.controller.destroy();
});

test('typing alongside trusted images does not re-decode image data on every publication', () => {
    const app = setup(); app.controller.start(); app.emit(entry(), { photo: { data: png, date: key } });
    const original = globalThis.atob;
    try {
        globalThis.atob = () => { throw new Error('Image decoding during typing'); };
        app.controller.updateText({ day: key, id: 'text', text: 'Typing stays cheap' });
        assert.equal(app.state.blocks[0].text, 'Typing stays cheap');
    } finally { globalThis.atob = original; app.controller.destroy(); }
});

test('remote revisions conflict with dirty drafts while timestamp-only updates do not', async () => {
    const app = setup(); app.controller.start(); const original = entry(); app.emit(original);
    app.controller.updateText({ day: key, id: 'text', text: 'My draft' });
    app.emit({ ...original, modifiedAt: 'timestamp-only' }); assert.equal(app.state.conflict, false);
    const latest = entry([block('text', 'Remote words')], { modifiedAt: 'remote-new' }); app.emit(latest);
    assert.equal(app.state.blocks[0].text, 'My draft'); assert.equal(app.state.conflict, true); assert.equal(app.state.status, 'ready');
    await assert.rejects(app.controller.save(key), error => error.code === 'journal-conflict'); assert.equal(app.saves.length, 0);
    app.controller.discard(key); assert.equal(app.state.blocks[0].text, 'Remote words'); assert.equal(app.state.conflict, false);
    app.emit(latest); assert.equal(app.state.status, 'ready'); assert.equal(app.state.dirty, false); app.controller.destroy();
});

test('explicit saves wait for acknowledgment, retain failed drafts, and support retry', async () => {
    const gate = deferred(); let fail = true;
    const app = setup({ save: async value => { await gate.promise; if (fail) throw new Error('Connection interrupted'); return { day: value.day, entry: entry(value.blocks), images: value.images }; } });
    app.controller.start(); app.emit(entry()); app.controller.updateText({ day: key, id: 'text', text: 'Save me' });
    const saving = app.controller.save(key); assert.equal(app.state.saving, true);
    await assert.rejects(app.controller.save(key), /finish saving/); assert.equal(app.saves.length, 1);
    gate.resolve(); await assert.rejects(saving, /Connection interrupted/);
    assert.equal(app.state.status, 'ready'); assert.equal(app.state.saving, false); assert.equal(app.state.dirty, true); assert.equal(app.state.blocks[0].text, 'Save me');
    assert.match(app.state.error, /Connection interrupted/); fail = false; await app.controller.save(key);
    assert.equal(app.state.dirty, false); assert.equal(app.state.error, ''); app.controller.destroy();
});

test('atomic repository conflicts retain the user draft until latest remote data is explicitly loaded', async () => {
    const app = setup({ save: async () => { throw Object.assign(new Error('Concurrent write'), { code: 'conflict' }); } });
    app.controller.start(); app.emit(entry()); app.controller.updateText({ day: key, id: 'text', text: 'Preserved draft' });
    await assert.rejects(app.controller.save(key));
    assert.equal(app.state.conflict, true); assert.equal(app.state.dirty, true); assert.equal(app.state.status, 'ready');
    app.controller.refresh(); app.emit(entry([block('text', 'Latest server text')]));
    assert.equal(app.state.blocks[0].text, 'Preserved draft');
    app.controller.discard(key); app.emit(entry([block('text', 'Latest server text')]));
    assert.equal(app.state.blocks[0].text, 'Latest server text'); assert.equal(app.controller.hasUnsavedChanges(), false); app.controller.destroy();
});

test('a late save acknowledgment cannot replace a newer remote revision', async () => {
    const gate = deferred();
    const app = setup({ save: () => gate.promise }); app.controller.start(); app.emit(entry());
    app.controller.updateText({ day: key, id: 'text', text: 'My saved words' });
    const saving = app.controller.save(key);
    app.emit(entry([block('text', 'Newer remote edit')], { modifiedAt: 'later' }));
    gate.resolve({ day: key, entry: entry([block('text', 'My saved words')], { modifiedAt: 'earlier' }), images: {} }); await saving;
    assert.equal(app.state.blocks[0].text, 'My saved words'); assert.equal(app.state.conflict, true); assert.equal(app.state.dirty, true);
    app.controller.discard(key); app.emit(entry([block('text', 'Newer remote edit')]));
    assert.equal(app.state.blocks[0].text, 'Newer remote edit'); app.controller.destroy();
});

test('a confirmed snapshot of this save before acknowledgment does not create a false conflict', async () => {
    const gate = deferred(); const app = setup({ save: () => gate.promise });
    app.controller.start(); app.emit(entry(undefined, { futureMetadata: { keep: true } }));
    app.controller.updateText({ day: key, id: 'text', text: 'My confirmed save' });
    const saving = app.controller.save(key);
    const committed = entry([block('text', 'My confirmed save')], { futureMetadata: { keep: true }, modifiedAt: 'committed' });
    app.emit(committed);
    assert.equal(app.state.saving, true); assert.equal(app.state.conflict, false);
    gate.resolve({ day: key, entry: committed, images: {} }); await saving;
    assert.equal(app.state.dirty, false); assert.equal(app.state.conflict, false);
    assert.deepEqual(app.saves[0].baseEntry.futureMetadata, { keep: true });
    assert.equal(app.controller.hasUnsavedChanges(), false); app.controller.destroy();
});

test('saving the original day across navigation never replaces the newly selected day', async () => {
    const gate = deferred(); const app = setup({ save: () => gate.promise }); app.controller.start(); app.emit(entry());
    app.controller.updateText({ day: key, id: 'text', text: 'Original day draft' }); const saving = app.controller.save(key);
    app.store.update({ day: new Date(2026, 9, 18) }); app.emit(entry([block('text', 'Different day')]));
    gate.resolve({ day: key, entry: entry([block('text', 'Original day draft')]), images: {} }); await saving;
    assert.equal(app.state.day, '2026-10-18'); assert.equal(app.state.blocks[0].text, 'Different day'); assert.equal(app.state.saving, false);
    assert.equal(app.saves[0].day, key); app.controller.destroy();
});

test('owner changes erase every draft and late reads/save results cannot expose the previous owner', async () => {
    const gate = deferred(); const app = setup({ save: () => gate.promise }); app.controller.start(); app.emit(entry());
    app.controller.updateText({ day: key, id: 'text', text: 'Private old owner draft' }); const saving = app.controller.save(key), oldWatch = app.watches[0];
    app.setPrimary(alternate); app.store.update({ cloud: { status: 'ready', ownerSub: alternate.sub } });
    assert.deepEqual(app.state.blocks, []); assert.equal(app.controller.hasUnsavedChanges(), false);
    oldWatch.next({ day: key, entry: entry([block('text', 'Late private data')]), images: {} });
    app.emit(null); gate.resolve({ day: key, entry: entry([block('text', 'Private old owner draft')]), images: {} }); await saving;
    assert.deepEqual(app.state.blocks, []); assert.equal(app.state.dirty, false); app.controller.destroy();
});

test('auth/load failures disable edits and destruction detaches all listeners without touching Firebase auth', async () => {
    const app = setup(); app.controller.start(); app.emit(entry());
    app.watches[0].error(Object.assign(new Error('Reconnect this account'), { code: 'identity-mismatch' }));
    assert.equal(app.state.status, 'error'); assert.equal(app.state.needsSignIn, true);
    assert.throws(() => app.controller.updateText({ day: key, id: 'text', text: 'Blocked' }), /load/);
    app.controller.refresh(); app.emit(entry()); app.controller.updateText({ day: key, id: 'text', text: 'Unsaved' });
    app.controller.destroy(); app.controller.destroy(); assert.equal(app.controller.hasUnsavedChanges(), false);
    assert.ok(app.watches.every(watch => !watch.active)); await flush(); assert.equal(app.destroys, 1);
    assert.equal(app.repository.connect, undefined); assert.equal(app.repository.authorize, undefined);
});
