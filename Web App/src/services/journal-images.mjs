export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 1600;
export const MAX_IMAGE_DATA_LENGTH = 900000;

const rasterTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

/** Restrict rendered attachments to raster data URLs; never render arbitrary URLs or SVG. */
export function safeJournalImageData(data) {
    return typeof data === 'string' && /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(data);
}

function hasRasterSignature(bytes, type) {
    const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
    if (type === 'image/jpeg' || type === 'image/jpg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    if (type === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    return type === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
}

/** Encode each selected raster as a bounded JPEG. Browser dependencies are injectable for tests. */
export async function compressImages(files, dependencies = {}) {
    const decode = dependencies.createImageBitmap || globalThis.createImageBitmap;
    const createCanvas = dependencies.createCanvas || (() => document.createElement('canvas'));
    const selected = Array.from(files || []);
    // Validate the entire batch before doing expensive decoding or returning any attachments.
    for (const file of selected) {
        const type = String(file?.type || '').toLowerCase();
        if (!rasterTypes.has(type)) throw new Error('Choose JPEG, PNG, WebP, or GIF images.');
        if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('This image is empty or unreadable.');
        if (file.size > MAX_IMAGE_BYTES) throw new Error('Each image must be 20 MB or smaller.');
        const header = file.slice ? file.slice(0, 16) : file;
        const bytes = new Uint8Array(await header.arrayBuffer());
        if (!hasRasterSignature(bytes, type)) throw new Error('This file is not a supported raster image.');
    }
    if (selected.length && typeof decode !== 'function') throw new Error('Image processing is unavailable in this browser. Try another browser.');
    const images = [];
    for (const file of selected) {
        let bitmap, canvas;
        try {
            bitmap = await decode(file);
            if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0) throw new Error('Invalid image dimensions.');
            const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
            let width = Math.max(1, Math.round(bitmap.width * scale));
            let height = Math.max(1, Math.round(bitmap.height * scale));
            canvas = createCanvas();
            const painter = canvas.getContext('2d');
            if (!painter) throw new Error('Image processing is unavailable.');
            let data;
            for (let pass = 0; pass < 12; pass++) {
                canvas.width = width; canvas.height = height;
                painter.fillStyle = '#ffffff';
                painter.fillRect(0, 0, width, height);
                painter.drawImage(bitmap, 0, 0, width, height);
                for (const quality of [.88, .72, .55, .38, .22]) {
                    data = canvas.toDataURL('image/jpeg', quality);
                    if (!/^data:image\/jpeg;base64,/.test(data) || !safeJournalImageData(data)) throw new Error('Couldn’t encode this image as JPEG.');
                    if (data.length <= MAX_IMAGE_DATA_LENGTH) break;
                }
                if (data.length <= MAX_IMAGE_DATA_LENGTH) break;
                if (width === 1 && height === 1) break;
                width = Math.max(1, Math.floor(width * .72));
                height = Math.max(1, Math.floor(height * .72));
            }
            if (data.length > MAX_IMAGE_DATA_LENGTH) throw new Error('This image is too large to attach. Choose a smaller image.');
            images.push({ data, width, height });
        } catch (error) {
            throw new Error(error?.message && /(?:unavailable|JPEG|too large|dimensions)/.test(error.message)
                ? error.message : 'Couldn’t read this image. Try another JPEG, PNG, WebP, or GIF image.');
        } finally {
            bitmap?.close?.();
            if (canvas) { canvas.width = 0; canvas.height = 0; }
        }
    }
    return images;
}
