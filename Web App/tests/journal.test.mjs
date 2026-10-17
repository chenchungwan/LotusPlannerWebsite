import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/components/journal.mjs';
import { JOURNAL_LIMITS } from '../src/state/journal-model.mjs';

class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = ''; this._value = ''; this.scrollTop = 0; this.selectionStart = this.selectionEnd = 0; }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error('Journal must use safe text and image nodes.'); }
    set value(value) { this._value = String(value); this.selectionStart = this.selectionEnd = this._value.length; }
    get value() { return this._value; }
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
    insertBefore(node, before) { node.remove(); const at = before ? this.children.indexOf(before) : this.children.length; this.children.splice(at < 0 ? this.children.length : at, 0, node); node.parentNode = this; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    click() { return this.dispatch('click'); }
    async dispatch(type, extra = {}) {
        if (['click', 'change', 'input'].includes(type) && this.disabled) return;
        const event = { target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, ...extra };
        await Promise.all((this.listeners.get(type) || []).map(listener => listener(event))); return event;
    }
}
const nodes = root => [root, ...root.children.flatMap(nodes)];
const byClass = (root, name) => nodes(root).filter(node => node.className.split(/\s+/).includes(name));
const one = (root, name) => byClass(root, name)[0];
const button = (root, text) => nodes(root).find(node => node.tagName === 'BUTTON' && node.textContent === text);
const day = number => new Date(2026, 9, number);
const state = extra => ({ day: '2026-10-17', status: 'ready', blocks: [], images: {}, dirty: false, saving: false, ...extra });
const context = (journal = state(), extra = {}) => ({ day: day(17), accounts: [{ sub: 'primary', isPrimary: true }], journal, ...extra });
const textBlock = (id = 'first', text = 'Written words') => ({ id, type: 'text', text, x: 12, y: 12, w: 520, h: 160 });
const jpeg = () => new Blob([new Uint8Array([255, 216, 255, 224])], { type: 'image/jpeg' });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(t, bitmap = async () => ({ width: 100, height: 50, close() {} })) {
    const previous = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
    globalThis.document = { activeElement: null, createElement(tag) {
        if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' };
        return new Element(tag);
    } };
    globalThis.createImageBitmap = bitmap;
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
}

test('empty journal is ready to write and materializes its deterministic text block only on input', async t => {
    setup(t); const calls = [];
    const widget = createJournal({ id: 'one', actions: { updateJournalText: value => calls.push(value) } });
    widget.update(context()); const editor = one(widget.element, 'journal-text');
    assert.equal(editor.disabled, false); assert.equal(editor.value, ''); assert.equal(calls.length, 0);
    assert.equal(editor.maxLength, JOURNAL_LIMITS.text); assert.equal(one(widget.element, 'journal-remove').hidden, true);
    assert.match(one(widget.element, 'journal-status').textContent, /Ready to write/);
    assert.equal(button(widget.element, 'Save').disabled, true);
    editor.value = '<script>plain text</script>'; await editor.dispatch('input');
    assert.deepEqual(calls, [{ day: '2026-10-17', id: 'lotus-text-2026-10-17', text: '<script>plain text</script>' }]);
});

test('shared state updates preserve textarea identity, focus, cursor, and independent widget scroll', async t => {
    setup(t);
    let shared = context(state({ blocks: [textBlock()] }));
    const first = createJournal({ id: 'one', actions: { updateJournalText: value => { shared = context(state({ dirty: true, blocks: [textBlock(value.id, value.text)] })); first.update(shared); second.update(shared); } } });
    const second = createJournal({ id: 'two' }); first.update(shared); second.update(shared);
    const editor = one(first.element, 'journal-text'); document.activeElement = editor;
    editor.value = 'A revised note'; editor.setSelectionRange(3, 6, 'forward');
    one(first.element, 'journal-content').scrollTop = 77; one(second.element, 'journal-content').scrollTop = 15;
    await editor.dispatch('input'); first.update({ ...shared, googleReady: true });
    assert.equal(one(first.element, 'journal-text'), editor); assert.equal(editor.value, 'A revised note');
    assert.equal(editor.selectionStart, 3); assert.equal(editor.selectionEnd, 6);
    assert.equal(one(second.element, 'journal-text').value, 'A revised note');
    assert.equal(one(first.element, 'journal-content').scrollTop, 77); assert.equal(one(second.element, 'journal-content').scrollTop, 15);
    assert.notEqual(first.element.getAttribute('aria-labelledby'), second.element.getAttribute('aria-labelledby'));
});

test('image blocks use safe raster URLs and crop metadata while unsupported content stays visible and untouched', t => {
    setup(t); const blocks = [textBlock(), { id: 'photo', type: 'image', image: 'photo-doc', w: 300, h: 150, crop: { x: .25, y: .1, w: .5, h: .5 } }, { id: 'unsafe', type: 'image', image: 'unsafe-doc' }, { id: 'missing', type: 'image', image: 'missing-doc' }, { id: 'future', type: 'future-block', payload: { value: 'keep me' } }];
    const value = context(state({ blocks, images: { 'photo-doc': { data: 'data:image/png;base64,AAAA' }, 'unsafe-doc': { data: 'data:image/svg+xml;base64,AAAA' } } }));
    const before = JSON.stringify(value); const widget = createJournal({ id: 'images' }); widget.update(value);
    const images = nodes(widget.element).filter(node => node.tagName === 'IMG');
    assert.equal(images.length, 1); assert.equal(images[0].src, 'data:image/png;base64,AAAA');
    assert.equal(images[0].style.width, '200%'); assert.equal(images[0].style.left, '-50%');
    assert.match(widget.element.textContent, /Unsupported image format/); assert.match(widget.element.textContent, /image is unavailable/); assert.match(widget.element.textContent, /not supported here/);
    assert.equal(JSON.stringify(value), before);
});

test('explicit save reports backend failure without clearing unsaved changes or claiming success', async t => {
    setup(t); const gate = deferred(); const days = [];
    const widget = createJournal({ id: 'save', actions: { saveJournal: day => { days.push(day); return gate.promise; } } });
    widget.update(context(state({ dirty: true, blocks: [textBlock()] })));
    const saving = button(widget.element, 'Save').dispatch('click');
    assert.equal(one(widget.element, 'journal-status').textContent, 'Saving…');
    gate.reject(new Error('Journal write failed')); await saving;
    assert.deepEqual(days, ['2026-10-17']); assert.equal(one(widget.element, 'journal-status').textContent, 'Unsaved changes');
    assert.match(one(widget.element, 'journal-notice').textContent, /Journal write failed/); assert.equal(button(widget.element, 'Save').disabled, false);
});

test('discard and conflict reload require explicit confirmation before replacing a dirty draft', async t => {
    setup(t); const calls = [];
    const widget = createJournal({ id: 'conflict', actions: { discardJournal: day => calls.push(['discard', day]), refreshJournal: () => calls.push(['refresh']) } });
    widget.update(context(state({ dirty: true, conflict: true, blocks: [textBlock()] })));
    assert.equal(button(widget.element, 'Save').disabled, true);
    await button(widget.element, 'Load latest').dispatch('click'); assert.equal(calls.length, 0);
    assert.equal(one(widget.element, 'journal-discard-confirm').hidden, false);
    await button(widget.element, 'Keep editing').dispatch('click'); assert.equal(calls.length, 0);
    await button(widget.element, 'Load latest').dispatch('click'); await button(widget.element, 'Discard and load latest').dispatch('click');
    assert.deepEqual(calls, [['discard', '2026-10-17']]);
});

test('layout preview blocks text, every button, file input, paste, and drop mutations', async t => {
    setup(t); let calls = 0;
    const actions = Object.fromEntries(['updateJournalText', 'addJournalText', 'addJournalImages', 'removeJournalBlock', 'saveJournal', 'discardJournal', 'refreshJournal', 'connectLogs'].map(name => [name, () => { calls++; }]));
    const widget = createJournal({ id: 'preview', actions }); widget.update(context(state({ dirty: true, blocks: [textBlock()] }), { isLayoutPreview: true }));
    const controls = nodes(widget.element).filter(node => ['BUTTON', 'TEXTAREA', 'INPUT'].includes(node.tagName));
    assert.ok(controls.every(node => node.disabled));
    for (const control of controls) await control.dispatch(control.tagName === 'TEXTAREA' ? 'input' : control.tagName === 'INPUT' ? 'change' : 'click');
    await widget.element.dispatch('paste', { clipboardData: { files: [jpeg()] } });
    await widget.element.dispatch('drop', { dataTransfer: { files: [jpeg()] } });
    assert.equal(calls, 0);
});

test('file compression captures the original day across navigation and attaches to that shared draft', async t => {
    const decoded = deferred(); let started;
    const began = new Promise(resolve => { started = resolve; });
    setup(t, () => { started(); return decoded.promise; });
    const calls = []; const widget = createJournal({ id: 'upload', actions: { addJournalImages: value => calls.push(value) } }); widget.update(context());
    const uploading = widget.element.dispatch('drop', { dataTransfer: { files: [jpeg()] } }); await began;
    assert.equal(one(widget.element, 'journal-status').textContent, 'Preparing images…');
    widget.update(context(state({ day: '2026-10-18' }), { day: day(18) }));
    decoded.resolve({ width: 100, height: 50, close() {} }); await uploading;
    assert.deepEqual(calls, [{ day: '2026-10-17', images: [{ data: 'data:image/jpeg;base64,AAAA', width: 100, height: 50 }] }]);
    assert.equal(one(widget.element, 'journal-date').getAttribute('datetime'), '2026-10-18');
});

test('pending images never attach after destroy, owner switch, or transition to layout preview', async t => {
    setup(t);
    for (const transition of ['destroy', 'owner', 'preview']) {
        const decoded = deferred(); let began;
        const started = new Promise(resolve => { began = resolve; });
        globalThis.createImageBitmap = () => { began(); return decoded.promise; };
        let calls = 0; const widget = createJournal({ id: transition, actions: { addJournalImages: () => { calls++; } } }); widget.update(context());
        const uploading = widget.element.dispatch('paste', { clipboardData: { files: [jpeg()] } }); await started;
        if (transition === 'destroy') widget.destroy();
        else widget.update(context(state(), transition === 'owner' ? { accounts: [{ sub: 'other', isPrimary: true }] } : { isLayoutPreview: true }));
        decoded.resolve({ width: 80, height: 60, close() {} }); await uploading; assert.equal(calls, 0);
    }
});

test('invalid image batches show a recoverable error and a later valid upload succeeds', async t => {
    setup(t); const calls = [];
    const widget = createJournal({ id: 'invalid', actions: { addJournalImages: value => calls.push(value) } }); widget.update(context());
    await widget.element.dispatch('drop', { dataTransfer: { files: [new Blob(['<svg/>'], { type: 'image/svg+xml' })] } });
    assert.match(one(widget.element, 'journal-notice').textContent, /JPEG, PNG/); assert.equal(calls.length, 0);
    assert.notEqual(one(widget.element, 'journal-status').textContent, 'Saved');
    await widget.element.dispatch('paste', { clipboardData: { files: [jpeg()] } });
    assert.equal(calls.length, 1); assert.equal(one(widget.element, 'journal-notice').hidden, true);
});

test('cloud load errors offer the correct reconnect action and mismatched days remain read-only', async t => {
    setup(t); let connects = 0;
    const widget = createJournal({ id: 'connect', actions: { connectLogs: () => { connects++; } } });
    widget.update(context(state({ status: 'error', error: 'Connect your account', needsSignIn: true })));
    assert.equal(one(widget.element, 'journal-text').disabled, true);
    await button(widget.element, 'Connect Google').dispatch('click'); assert.equal(connects, 1);
    widget.update(context(state({ day: '2026-10-16', blocks: [textBlock('old', 'Other day text')] })));
    assert.equal(one(widget.element, 'journal-text').disabled, true); assert.equal(one(widget.element, 'journal-text').value, '');
    widget.destroy(); widget.destroy(); widget.update(context()); assert.equal(widget.element.children.length, 0);
});

test('a raster attachment that fails browser decoding shows a preserved-content message', async t => {
    setup(t); const widget = createJournal({ id: 'corrupt' });
    widget.update(context(state({ blocks: [{ id: 'photo', type: 'image', image: 'photo-doc' }], images: { 'photo-doc': { data: 'data:image/jpeg;base64,AAAA' } } })));
    await nodes(widget.element).find(node => node.tagName === 'IMG').dispatch('error');
    assert.match(widget.element.textContent, /could not be displayed/); assert.match(widget.element.textContent, /original attachment is preserved/);
    assert.equal(nodes(widget.element).some(node => node.tagName === 'IMG'), false);
});

test('rejected text edits restore the accepted draft and Save persists exactly the displayed content', async t => {
    setup(t);
    let shared = context(state({ dirty: true, blocks: [textBlock('first', 'Previously accepted draft')] }));
    let savedText;
    const widget = createJournal({ id: 'validation', actions: {
        updateJournalText: () => { throw new TypeError('Total journal text is too long'); },
        saveJournal: () => {
            savedText = shared.journal.blocks[0].text;
            shared = context(state({ blocks: [textBlock('first', savedText)], modifiedAt: '2026-10-17T12:00:00Z' }));
            widget.update(shared);
        },
    } });
    widget.update(shared);
    const editor = one(widget.element, 'journal-text'); document.activeElement = editor;
    editor.value = 'Rejected text that was never accepted by the controller'; editor.setSelectionRange(8, 12, 'forward');
    await editor.dispatch('input');
    assert.equal(editor.value, 'Previously accepted draft');
    assert.equal(editor.selectionStart, 8); assert.equal(editor.selectionEnd, 12);
    assert.match(one(widget.element, 'journal-notice').textContent, /Total journal text is too long/);
    assert.equal(one(widget.element, 'journal-status').textContent, 'Unsaved changes');
    widget.update({ ...shared, googleReady: true });
    assert.equal(editor.value, shared.journal.blocks[0].text);
    await button(widget.element, 'Save').dispatch('click');
    assert.equal(savedText, 'Previously accepted draft'); assert.equal(editor.value, savedText);
    assert.equal(one(widget.element, 'journal-status').textContent, 'Saved');
});

test('a delayed rejected edit restores newer accepted shared text and never rewrites another day', async t => {
    setup(t);
    const rejected = deferred();
    const widget = createJournal({ id: 'late-validation', actions: { updateJournalText: () => rejected.promise } });
    widget.update(context(state({ blocks: [textBlock('first', 'Original text')] })));
    const editor = one(widget.element, 'journal-text'); editor.value = 'Rejected pending edit';
    const editing = editor.dispatch('input');
    widget.update(context(state({ blocks: [textBlock('first', 'Accepted from another journal widget')] })));
    rejected.reject(new Error('Rejected by validation')); await editing;
    assert.equal(editor.value, 'Accepted from another journal widget');

    const later = deferred();
    const dated = createJournal({ id: 'day-validation', actions: { updateJournalText: () => later.promise } });
    dated.update(context(state({ blocks: [textBlock()] })));
    const old = one(dated.element, 'journal-text'); old.value = 'Old day rejected edit';
    const pending = old.dispatch('input');
    dated.update(context(state({ day: '2026-10-18', blocks: [textBlock('first', 'Next day accepted text')] }), { day: day(18) }));
    later.reject(new Error('Old day validation failure')); await pending;
    assert.equal(one(dated.element, 'journal-text').value, 'Next day accepted text');
});
