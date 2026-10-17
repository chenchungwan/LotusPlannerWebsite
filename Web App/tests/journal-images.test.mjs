import test from 'node:test';
import assert from 'node:assert/strict';
import { compressImages, safeJournalImageData, MAX_IMAGE_BYTES, MAX_IMAGE_DATA_LENGTH } from '../src/services/journal-images.mjs';

const jpeg = () => new Blob([new Uint8Array([255, 216, 255, 224, 0, 0])], { type: 'image/jpeg' });
function browser({ width = 3200, height = 1600, encode = () => 'data:image/jpeg;base64,AAAA' } = {}) {
    let closed = 0;
    const fills = [], draws = [], encodes = [], canvases = [];
    return {
        dependencies: {
            createImageBitmap: async () => ({ width, height, close() { closed++; } }),
            createCanvas: () => {
                const painter = { fillStyle: null, fillRect(...args) { fills.push([this.fillStyle, ...args]); }, drawImage(...args) { draws.push(args.slice(1)); } };
                const canvas = { width: 0, height: 0, getContext: () => painter, toDataURL(type, quality) { encodes.push({ type, quality, width: this.width, height: this.height }); return encode(this, quality); } };
                canvases.push(canvas); return canvas;
            },
        },
        fills, draws, encodes, canvases, get closed() { return closed; },
    };
}

test('raster URL guard accepts only explicit base64 raster data and rejects SVG, HTML, links, and malformed data', () => {
    for (const mime of ['jpeg', 'jpg', 'png', 'webp', 'gif']) assert.equal(safeJournalImageData('data:image/' + mime + ';base64,AAAA=='), true);
    for (const data of [null, 'https://example.test/picture.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'data:image/png,<svg/>', 'data:image/png;base64,AAAA<script>']) assert.equal(safeJournalImageData(data), false);
});

test('images are scaled to at most 1600 pixels with white JPEG background and bitmap resources released', async () => {
    const mock = browser();
    const images = await compressImages([jpeg()], mock.dependencies);
    assert.deepEqual(images, [{ data: 'data:image/jpeg;base64,AAAA', width: 1600, height: 800 }]);
    assert.deepEqual(mock.fills, [['#ffffff', 0, 0, 1600, 800]]);
    assert.deepEqual(mock.draws, [[0, 0, 1600, 800]]);
    assert.equal(mock.encodes[0].type, 'image/jpeg'); assert.equal(mock.closed, 1);
    assert.equal(mock.canvases[0].width, 0); assert.equal(mock.canvases[0].height, 0);
});

test('small images retain their dimensions and every selected file is processed', async () => {
    const mock = browser({ width: 91, height: 123 });
    const images = await compressImages([jpeg(), jpeg()], mock.dependencies);
    assert.deepEqual(images.map(image => [image.width, image.height]), [[91, 123], [91, 123]]);
    assert.equal(mock.closed, 2);
});

test('oversize data URLs reduce JPEG quality and then dimensions until within the storage bound', async () => {
    const tooLarge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_IMAGE_DATA_LENGTH);
    const mock = browser({ encode: canvas => canvas.width > 1200 ? tooLarge : 'data:image/jpeg;base64,AAAA' });
    const [image] = await compressImages([jpeg()], mock.dependencies);
    assert.equal(image.width, 1152); assert.equal(image.height, 576);
    assert.ok(image.data.length <= MAX_IMAGE_DATA_LENGTH);
    assert.deepEqual(mock.encodes.slice(0, 5).map(entry => entry.quality), [.88, .72, .55, .38, .22]);
    assert.equal(mock.closed, 1);
});

test('unsupported, empty, oversized, and forged raster files fail before image decoding', async () => {
    const mock = browser(); let decodes = 0;
    mock.dependencies.createImageBitmap = () => { decodes++; throw new Error('unexpected'); };
    const invalid = [new Blob(['<svg/>'], { type: 'image/svg+xml' }), new Blob([], { type: 'image/png' }),
        { type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 }, new Blob(['<svg/>'], { type: 'image/jpeg' })];
    for (const file of invalid) await assert.rejects(compressImages([file], mock.dependencies), /(?:JPEG|empty|20 MB|raster)/);
    await assert.rejects(compressImages([jpeg(), invalid[0]], mock.dependencies));
    assert.equal(decodes, 0);
});

test('PNG, GIF, and WebP signatures are accepted while MIME mismatches are rejected', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    const gif = new Blob(['GIF89a'], { type: 'image/gif' });
    const webp = new Blob(['RIFF0000WEBP'], { type: 'image/webp' });
    assert.equal((await compressImages([png, gif, webp], browser().dependencies)).length, 3);
    await assert.rejects(compressImages([new Blob(['GIF89a'], { type: 'image/png' })], browser().dependencies), /raster/);
});

test('decode/encoding failures release resources and never return an unsafe fallback URL', async () => {
    await assert.rejects(compressImages([jpeg()], { createImageBitmap: async () => { throw new Error('bad image'); } }), /Couldn’t read/);
    const mock = browser({ encode: () => 'data:image/png;base64,AAAA' });
    await assert.rejects(compressImages([jpeg()], mock.dependencies), /JPEG/);
    assert.equal(mock.closed, 1); assert.equal(mock.canvases[0].width, 0);
    const invalid = browser({ width: 0 });
    await assert.rejects(compressImages([jpeg()], invalid.dependencies), /dimensions/); assert.equal(invalid.closed, 1);
});

test('an image that cannot meet the data bound fails rather than returning an oversized record', async () => {
    const mock = browser({ width: 1, height: 1, encode: () => 'data:image/jpeg;base64,' + 'A'.repeat(MAX_IMAGE_DATA_LENGTH) });
    await assert.rejects(compressImages([jpeg()], mock.dependencies), /too large/);
    assert.equal(mock.closed, 1);
});
