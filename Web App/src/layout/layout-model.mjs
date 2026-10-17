import { MIN_WIDGET_SIZE, canPlace, rectsOverlap } from './canvas-geometry.mjs?v=canvas-1';

// Layouts contain presentation choices only: no Google tokens or fetched data.
export const LAYOUT_VERSION = 2;
export const WIDGET_TYPES = Object.freeze(['timeline', 'account-tasks']);
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function createDefaultLayout() {
    return {
        version: 1, id: 'daily', name: 'Daily planner',
        columns: [
            { id: 'schedule', width: 260, widgets: [{ id: 'timeline', type: 'timeline', options: { accountIds: 'all', hourHeight: 76 } }] },
            { id: 'account', size: 1, repeat: 'accounts', widgets: [{ id: 'tasks', type: 'account-tasks', options: { accountId: '$account' } }] },
        ],
    };
}

function fail(message) { throw new TypeError('Invalid planner layout: ' + message); }
function validId(value) { return typeof value === 'string' && idPattern.test(value); }
function bounded(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function accountId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }

export function validateLayout(input, types = WIDGET_TYPES) {
    if (!plain(input) || ![1, 2].includes(input.version)) fail('unsupported version');
    if (!validId(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) fail('missing id or name');
    if (input.version === 2) return validateCanvas(input, types);
    if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 12) fail('use between 1 and 12 columns');
    const columnIds = new Set();
    const widgetIds = new Set();
    const columns = input.columns.map(column => {
        if (!plain(column) || !validId(column.id) || columnIds.has(column.id)) fail('column ids must be unique');
        columnIds.add(column.id);
        if (column.repeat !== undefined && column.repeat !== 'accounts') fail('unknown repetition');
        if (column.width !== undefined && !bounded(column.width, 160, 960)) fail('column width must be between 160 and 960');
        if (column.size !== undefined && !bounded(column.size, 0.25, 12)) fail('column size must be between 0.25 and 12');
        if (!Array.isArray(column.widgets) || !column.widgets.length || column.widgets.length > 12) fail('each column needs 1 to 12 widgets');
        const widgets = column.widgets.map(widget => {
            if (!plain(widget) || !validId(widget.id) || widgetIds.has(widget.id)) fail('widget ids must be unique across the layout');
            widgetIds.add(widget.id);
            if (!types.includes(widget.type)) fail('unknown widget type');
            if (widget.flex !== undefined && !bounded(widget.flex, 0.25, 12)) fail('invalid widget size');
            if (widget.height !== undefined && !bounded(widget.height, 180, 2000)) fail('invalid widget height');
            const options = validateOptions(widget, column.repeat === 'accounts');
            return { id: widget.id, type: widget.type, options,
                ...(widget.flex !== undefined ? { flex: widget.flex } : {}),
                ...(widget.height !== undefined ? { height: widget.height } : {}),
            };
        });
        return { id: column.id, widgets,
            ...(column.repeat ? { repeat: column.repeat } : {}),
            ...(column.width !== undefined ? { width: column.width } : {}),
            ...(column.size !== undefined ? { size: column.size } : {}),
        };
    });
    return { version: 1, id: input.id, name: input.name, columns };
}

function validateOptions(widget, allowAccountRepeat) {
    const raw = widget.options === undefined ? {} : widget.options;
    if (!plain(raw)) fail('widget options must be an object');
    const options = {};
    if (raw.title !== undefined) {
        if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 100) fail('invalid widget title');
        options.title = raw.title;
    }
    if (widget.type === 'timeline') {
        if (raw.accountIds !== undefined && raw.accountIds !== 'all' &&
            (!Array.isArray(raw.accountIds) || raw.accountIds.length > 20 || !raw.accountIds.every(accountId))) fail('invalid calendar account selection');
        if (Array.isArray(raw.accountIds) && raw.accountIds.includes('$account') && !allowAccountRepeat) fail('$account requires an account-repeated column');
        if (raw.hourHeight !== undefined && !bounded(raw.hourHeight, 32, 160)) fail('invalid timeline density');
        if (raw.initialHour !== undefined && !bounded(raw.initialHour, 0, 23)) fail('invalid initial hour');
        if (raw.accountIds !== undefined) options.accountIds = Array.isArray(raw.accountIds) ? [...raw.accountIds] : raw.accountIds;
        if (raw.hourHeight !== undefined) options.hourHeight = raw.hourHeight;
        if (raw.initialHour !== undefined) options.initialHour = raw.initialHour;
    }
    if (widget.type === 'account-tasks') {
        if (!accountId(raw.accountId)) fail('task widgets need an account');
        if (raw.accountId === '$account' && !allowAccountRepeat) fail('$account requires an account-repeated column');
        options.accountId = raw.accountId;
        if (raw.showCompleted !== undefined) {
            if (typeof raw.showCompleted !== 'boolean') fail('invalid completed-task preference');
            options.showCompleted = raw.showCompleted;
        }
        if (raw.taskListIds !== undefined) {
            if (!Array.isArray(raw.taskListIds) || raw.taskListIds.length > 200 || !raw.taskListIds.every(accountId)) fail('invalid task list selection');
            options.taskListIds = [...raw.taskListIds];
        }
        if (raw.dateFilter !== undefined) {
            if (!['day', 'day-overdue', 'all'].includes(raw.dateFilter)) fail('invalid task date filter');
            options.dateFilter = raw.dateFilter;
        }
    }
    return options;
}

function validateCanvas(input, types) {
    if (!plain(input.canvas) || !bounded(input.canvas.width, MIN_WIDGET_SIZE.width, 100000) ||
        !bounded(input.canvas.height, MIN_WIDGET_SIZE.height, 100000)) fail('invalid canvas size');
    if (!Array.isArray(input.widgets) || input.widgets.length > 288) fail('use no more than 288 widgets');
    const canvas = { width: input.canvas.width, height: input.canvas.height };
    const ids = new Set();
    const widgets = [];
    input.widgets.forEach(widget => {
        if (!plain(widget) || !validId(widget.id) || ids.has(widget.id)) fail('widget ids must be unique across the layout');
        ids.add(widget.id);
        if (!types.includes(widget.type)) fail('unknown widget type');
        const options = validateOptions(widget, false);
        const rect = { id: widget.id, type: widget.type, x: widget.x, y: widget.y, width: widget.width, height: widget.height, options };
        if (!canPlace(rect, [], canvas)) fail('widgets must be at least 200 × 200 and stay inside the canvas');
        if (widgets.some(other => rectsOverlap(rect, other))) fail('widgets must not overlap');
        widgets.push(rect);
    });
    return { version: 2, id: input.id, name: input.name, canvas, widgets };
}

function accountResolver(accounts) {
    const primary = accounts.find(account => account.isPrimary);
    const secondary = accounts.find(account => !account.isPrimary);
    return (id, repeated) => id === '$account' ? repeated?.sub : id === '$primary' ? primary?.sub : id === '$secondary' ? secondary?.sub : id;
}

function resolveOptions(options, resolveAccount, account) {
    const resolved = { ...options };
    if (resolved.accountId) resolved.accountId = resolveAccount(resolved.accountId, account);
    if (Array.isArray(resolved.accountIds)) resolved.accountIds = resolved.accountIds.map(id => resolveAccount(id, account)).filter(Boolean);
    return resolved;
}

export function resolveLayout(input, accounts = []) {
    const layout = validateLayout(input);
    if (layout.version !== 1) fail('canvas layouts require resolveCanvasLayout');
    const resolveAccount = accountResolver(accounts);
    return layout.columns.flatMap(column => {
        const bindings = column.repeat === 'accounts' ? accounts : [null];
        return bindings.map(account => {
            const key = column.id + (account ? ':' + account.sub : '');
            return { ...column, id: key, widgets: column.widgets.map(widget => {
                const options = resolveOptions(widget.options, resolveAccount, account);
                return { ...widget, id: layout.id + ':' + widget.id + (account ? ':' + account.sub : ''), options };
            }) };
        });
    });
}

export function resolveCanvasLayout(input, accounts = []) {
    const layout = validateLayout(input);
    if (layout.version !== 2) fail('migrate columns with createCanvasLayout first');
    const resolveAccount = accountResolver(accounts);
    return layout.widgets.map(widget => ({
        ...widget,
        id: layout.id + ':' + widget.id,
        options: resolveOptions(widget.options, resolveAccount),
    }));
}

function weightedSizes(items, space, weight, minimum) {
    const result = new Map();
    let pending = [...items];
    let remaining = space;
    while (pending.length) {
        const total = pending.reduce((sum, item) => sum + weight(item), 0);
        const small = pending.filter(item => remaining * weight(item) / total < minimum);
        if (!small.length) {
            pending.forEach(item => result.set(item, remaining * weight(item) / total));
            break;
        }
        small.forEach(item => { result.set(item, minimum); remaining -= minimum; });
        pending = pending.filter(item => !small.includes(item));
    }
    return result;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(36);
}

/** Expand columns once, then let every widget move independently on a canvas. */
export function createCanvasLayout(input, accounts = [], { width = 1280, height = 900 } = {}) {
    const layout = validateLayout(input);
    if (layout.version === 2) return layout;
    const columns = resolveLayout(layout, accounts);
    const gap = 20;
    const requestedWidth = bounded(width, 200, 100000) ? width : 1280;
    const requestedHeight = bounded(height, 200, 100000) ? height : 900;
    const fixed = columns.filter(column => column.width !== undefined);
    const flexible = columns.filter(column => column.width === undefined);
    const fixedWidth = fixed.reduce((sum, column) => sum + Math.max(200, column.width), 0);
    const spacing = Math.max(0, columns.length - 1) * gap;
    const canvasWidth = Math.max(requestedWidth, spacing + fixedWidth + flexible.length * 200);
    const widths = weightedSizes(flexible, canvasWidth - spacing - fixedWidth, column => column.size || 1, 200);
    const targetHeight = Math.max(200, Math.min(760, requestedHeight));
    const reserved = new Set(columns.flatMap(column => column.widgets.map(widget => widget.id.slice(layout.id.length + 1))).filter(validId));
    const originalWidgets = new Map(layout.columns.flatMap(column => column.widgets).map(widget => [widget.id, widget]));
    const assigned = new Set();
    const widgets = [];
    let x = 0;
    let canvasHeight = requestedHeight;
    columns.forEach(column => {
        const columnWidth = column.width === undefined ? widths.get(column) : Math.max(200, column.width);
        const fixedWidgets = column.widgets.filter(widget => widget.height !== undefined);
        const flexibleWidgets = column.widgets.filter(widget => widget.height === undefined);
        const fixedHeight = fixedWidgets.reduce((sum, widget) => sum + Math.max(200, widget.height), 0);
        const gaps = (column.widgets.length - 1) * gap;
        const columnHeight = Math.max(targetHeight, fixedHeight + flexibleWidgets.length * 200 + gaps);
        const heights = weightedSizes(flexibleWidgets, columnHeight - gaps - fixedHeight, widget => widget.flex || 1, 200);
        let y = 0;
        column.widgets.forEach(widget => {
            const rawId = widget.id.slice(layout.id.length + 1);
            let id = rawId;
            if (!validId(id)) {
                const base = rawId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) + '-' + stableHash(rawId);
                id = base;
                let suffix = 1;
                while (reserved.has(id) || assigned.has(id)) id = base.slice(0, 58) + '-' + suffix++;
            }
            assigned.add(id);
            const widgetHeight = widget.height === undefined ? heights.get(widget) : Math.max(200, widget.height);
            const originalId = rawId.split(':')[0];
            const options = { ...originalWidgets.get(originalId).options };
            // Expand repetition while retaining primary/secondary aliases for missing accounts.
            const repeatedSub = column.repeat === 'accounts' ? rawId.slice(originalId.length + 1) : undefined;
            if (options.accountId === '$account') options.accountId = repeatedSub;
            if (Array.isArray(options.accountIds)) options.accountIds = options.accountIds.map(value => value === '$account' ? repeatedSub : value);
            widgets.push({ id, type: widget.type, x, y, width: columnWidth, height: widgetHeight, options });
            y += widgetHeight + gap;
        });
        canvasHeight = Math.max(canvasHeight, y - gap);
        x += columnWidth + gap;
    });
    // Fractional weighted sizes can sum a fraction of a floating-point unit past
    // the requested edge. Use actual edges so strict placement checks still hold.
    const canvas = {
        width: Math.max(canvasWidth, ...widgets.map(widget => widget.x + widget.width)),
        height: Math.max(canvasHeight, ...widgets.map(widget => widget.y + widget.height)),
    };
    return validateLayout({ version: 2, id: layout.id, name: layout.name, canvas, widgets });
}

export function createLayoutRepository({ storage, ownerId }) {
    if (!ownerId) throw new TypeError('A layout owner is required.');
    // Keep the original key so both old columns and new canvases load seamlessly.
    const key = 'lotus.layout.v1.' + encodeURIComponent(ownerId);
    return {
        load() {
            try {
                const raw = storage.getItem(key);
                if (!raw) return { layout: createDefaultLayout(), recovered: false };
                return { layout: validateLayout(JSON.parse(raw)), recovered: false };
            } catch (error) { return { layout: createDefaultLayout(), recovered: true }; }
        },
        save(layout) { const valid = validateLayout(layout); storage.setItem(key, JSON.stringify(valid)); return valid; },
        reset() { storage.removeItem(key); return createDefaultLayout(); },
    };
}
