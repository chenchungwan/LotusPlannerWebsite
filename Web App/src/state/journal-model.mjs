export const JOURNAL_LIMITS = Object.freeze({ blocks: 256, text: 200000, imageCharacters: 900000, documentBytes: 950000 });

const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function fail(message) { throw new TypeError('Invalid journal data: ' + message); }
function identifier(value, label = 'id') {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 || value === '.' || value === '..' || /[\/\u0000-\u001f\u007f]/.test(value)) fail('invalid ' + label);
    return value;
}
export function validateJournalDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('choose a valid YYYY-MM-DD date');
    const [year, month, day] = value.split('-').map(Number), date = new Date(0);
    date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
    if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail('choose a valid YYYY-MM-DD date');
    return value;
}
function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    if (value instanceof Date) return new Date(value);
    // Preserve Firestore Timestamp, GeoPoint and DocumentReference instances.
    return value;
}
function coordinate(value, label, positive = false) {
    if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0) || value > 1000000) fail('invalid block ' + label);
}
function text(value) { if (typeof value !== 'string' || value.length > JOURNAL_LIMITS.text) fail('text is too long or invalid'); }
function stable(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value) || ['function', 'symbol', 'bigint', 'undefined'].includes(typeof value)) fail('unsupported journal value');
        return value;
    }
    if (seen.has(value)) fail('journal values must not contain cycles');
    seen.add(value);
    let result;
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) fail('invalid timestamp');
        result = { '$date': value.toISOString() };
    } else if (!plain(value) && typeof value.toJSON === 'function') result = stable(value.toJSON(), seen);
    else if (!plain(value) && typeof value.path === 'string' && value.firestore) result = { '$reference': value.path };
    else if (Array.isArray(value)) result = value.map(item => stable(item, seen));
    else result = Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], seen)]));
    seen.delete(value); return result;
}
export function journalDocumentBytes(value) { return new TextEncoder().encode(JSON.stringify(stable(value))).length; }
export function validateJournalDocument(value) {
    if (!plain(value)) fail('journal entry must be an object');
    if (journalDocumentBytes(value) >= JOURNAL_LIMITS.documentBytes) fail('this journal document is too large; remove some text or blocks');
    return clone(value);
}

/** Keep unfamiliar blocks and fields so this editor cannot erase newer clients' data. */
export function validateJournalBlocks(value) {
    if (!Array.isArray(value) || value.length > JOURNAL_LIMITS.blocks) fail('use no more than ' + JOURNAL_LIMITS.blocks + ' blocks');
    const ids = new Set(); let totalText = 0;
    const result = value.map(block => {
        if (!plain(block)) fail('block must be an object');
        const id = identifier(block.id, 'block id');
        if (ids.has(id)) fail('block ids must be unique'); ids.add(id);
        if (typeof block.type !== 'string' || !block.type.trim() || block.type.length > 80) fail('invalid block type');
        const known = block.type === 'text' || block.type === 'image';
        for (const key of ['x', 'y', 'w', 'h']) if (known || block[key] !== undefined) coordinate(block[key], key, key === 'w' || key === 'h');
        if (block.type === 'text' && block.text !== undefined) { text(block.text); totalText += block.text.length; }
        if (block.type === 'image') {
            identifier(block.image, 'image id');
            if (block.crop !== undefined && block.crop !== null) {
                if (!plain(block.crop)) fail('invalid image crop');
                const crop = block.crop;
                for (const key of ['x', 'y', 'w', 'h']) if (!Number.isFinite(crop[key]) || (key === 'w' || key === 'h' ? crop[key] <= 0 : crop[key] < 0) || crop[key] > 1) fail('invalid image crop');
                if (crop.x + crop.w > 1.000001 || crop.y + crop.h > 1.000001) fail('crop must stay inside the image');
            }
        }
        return clone(block);
    });
    if (totalText > JOURNAL_LIMITS.text) fail('total journal text is too long');
    if (journalDocumentBytes({ blocks: result, text: journalText(result) }) >= JOURNAL_LIMITS.documentBytes) fail('this journal document is too large');
    return result;
}

/** Legacy text gets a repeatable identity until the first intentional board save. */
export function journalBlocks(entry) {
    if (entry === undefined || entry === null) return [];
    if (!plain(entry)) fail('journal entry must be an object');
    if (Object.hasOwn(entry, 'blocks')) return validateJournalBlocks(entry.blocks);
    if (entry.text === undefined || entry.text === null) return [];
    text(entry.text);
    return entry.text.trim() ? [{ id: 'legacy-text', type: 'text', x: 12, y: 12, w: 520, h: 160, text: entry.text }] : [];
}
export function journalText(blocks) { return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()).map(block => block.text.trim()).join('\n\n'); }

/** Property insertion order and a timestamp-only update do not create a conflict. */
export function journalRevision(entry) {
    if (entry === undefined || entry === null) return 'null';
    if (!plain(entry)) fail('journal entry must be an object');
    const { modifiedAt, ...semantic } = entry;
    return JSON.stringify(stable(semantic));
}

export function validateJournalImage(value) {
    if (!plain(value)) fail('image must be an object');
    if (typeof value.data !== 'string' || value.data.length > JOURNAL_LIMITS.imageCharacters) fail('image is too large or invalid');
    const match = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value.data);
    if (!match || match[2].length % 4 !== 0) fail('use a JPEG, PNG, WebP or GIF image');
    let bytes;
    try { bytes = atob(match[2]); } catch { fail('invalid image encoding'); }
    const starts = signature => bytes.startsWith(signature);
    const valid = match[1].toLowerCase() === 'jpeg' ? starts('\xff\xd8\xff')
        : match[1].toLowerCase() === 'png' ? starts('\x89PNG\r\n\x1a\n')
            : match[1].toLowerCase() === 'gif' ? starts('GIF87a') || starts('GIF89a')
                : starts('RIFF') && bytes.slice(8, 12) === 'WEBP';
    if (!valid) fail('image data does not match its raster format');
    if (value.date !== undefined) validateJournalDay(value.date);
    if (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))) fail('invalid image creation timestamp');
    if (journalDocumentBytes(value) >= JOURNAL_LIMITS.documentBytes) fail('image document is too large');
    return clone(value);
}
