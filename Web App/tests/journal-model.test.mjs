import test from 'node:test';
import assert from 'node:assert/strict';
import { journalBlocks, journalText, journalRevision, validateJournalDay, validateJournalBlocks, validateJournalImage, validateJournalDocument } from '../src/state/journal-model.mjs';

const block = (fields = {}) => ({ id: 'text-1', type: 'text', x: 12, y: 12, w: 320, h: 140, text: 'Hello', ...fields });
const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64');

test('journal dates validate real calendar days including leap years and early years', () => {
    for (const day of ['2026-10-17', '2024-02-29', '0001-01-01']) assert.equal(validateJournalDay(day), day);
    for (const day of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-1', '../private']) assert.throws(() => validateJournalDay(day), /valid YYYY-MM-DD/);
});

test('legacy text block identity is stable and source entries remain unchanged', () => {
    const entry = { text: ' Legacy text ', future: { keep: true } };
    const one = journalBlocks(entry), two = journalBlocks(entry);
    assert.equal(one[0].id, two[0].id); assert.equal(one[0].text, entry.text); assert.equal(one[0].type, 'text');
    one[0].text = 'changed'; assert.equal(entry.text, ' Legacy text ');
    assert.deepEqual(journalBlocks(null), []); assert.deepEqual(journalBlocks({ text: '  ' }), []);
});

test('block validation preserves unsupported types and unknown nested fields without sharing mutable maps', () => {
    const input = [block({ future: { colors: ['green'] } }), { id: 'drawing', type: 'future-drawing', strokes: { untouched: true } }];
    const result = validateJournalBlocks(input);
    assert.deepEqual(result, input); result[0].future.colors.push('blue'); assert.equal(input[0].future.colors.length, 1);
    assert.equal(result[1].type, 'future-drawing');
});

test('invalid identities, duplicate blocks, geometry, text and crops fail explicitly', () => {
    for (const blocks of [
        [block({ id: 'bad/id' })], [block(), block()], [block({ x: -1 })], [block({ w: 0 })], [block({ y: NaN })],
        [block({ text: 'x'.repeat(200001) })], [block({ type: 'image', image: '../bad' })],
        [block({ type: 'image', image: 'img', crop: { x: 0.9, y: 0, w: 0.5, h: 1 } })],
        [block({ type: 'image', image: 'img', crop: { x: 0, y: 0, w: 0, h: 1 } })],
        Array.from({ length: 257 }, (_, index) => block({ id: 'b-' + index })),
    ]) assert.throws(() => validateJournalBlocks(blocks), /Invalid journal data/);
});

test('text previews retain block order and semantic revision ignores only metadata timestamp/key order', () => {
    assert.equal(journalText([block({ text: ' A ' }), { type: 'image' }, block({ text: '  ' }), block({ text: ' B ' })]), 'A\n\nB');
    const first = { blocks: [block()], text: 'Hello', extra: { b: 2, a: 1 }, modifiedAt: 'one' };
    const same = { modifiedAt: 'two', extra: { a: 1, b: 2 }, text: 'Hello', blocks: [block()] };
    assert.equal(journalRevision(first), journalRevision(same)); assert.equal(journalRevision(null), journalRevision(undefined));
    assert.notEqual(journalRevision(first), journalRevision({ ...first, text: 'Changed' }));
    assert.notEqual(journalRevision(first), journalRevision({ ...first, extra: { a: 2, b: 2 } }));
});

test('only correctly tagged raster base64 URLs within the image size budget are accepted', () => {
    const samples = [png,
        'data:image/jpeg;base64,' + Buffer.from('\xff\xd8\xff\xe0', 'latin1').toString('base64'),
        'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64'),
        'data:image/webp;base64,' + Buffer.from('RIFF1234WEBP').toString('base64')];
    for (const data of samples) assert.equal(validateJournalImage({ data, date: '2026-10-17', createdAt: '2026-10-17T12:00:00Z', extra: true }).data, data);
    for (const data of ['javascript:alert(1)', 'https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,SGVsbG8=', 'data:image/png;base64,PHN2Zz4=', 'data:image/png;base64,abc', png + 'x'.repeat(900000)]) assert.throws(() => validateJournalImage({ data }), /Invalid journal data/);
});

test('document limits account for UTF-8 bytes and unknown metadata rather than only visible text', () => {
    assert.throws(() => validateJournalDocument({ extra: 'x'.repeat(950000) }), /too large/);
    assert.throws(() => validateJournalBlocks([block({ text: '界'.repeat(170000) })]), /too large/);
    assert.throws(() => validateJournalDocument({ loop: (() => { const value = {}; value.self = value; return value; })() }), /cycles/);
});
