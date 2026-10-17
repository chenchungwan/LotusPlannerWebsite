// Layouts contain presentation choices only: no Google tokens or fetched data.
export const LAYOUT_VERSION = 1;
export const WIDGET_TYPES = Object.freeze(['timeline', 'account-tasks']);
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function createDefaultLayout() {
    return {
        version: LAYOUT_VERSION, id: 'daily', name: 'Daily planner',
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
    if (!plain(input) || input.version !== LAYOUT_VERSION) fail('unsupported version');
    if (!validId(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) fail('missing id or name');
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
                if (Array.isArray(raw.accountIds) && raw.accountIds.includes('$account') && column.repeat !== 'accounts') fail('$account requires an account-repeated column');
                if (raw.hourHeight !== undefined && !bounded(raw.hourHeight, 32, 160)) fail('invalid timeline density');
                if (raw.initialHour !== undefined && !bounded(raw.initialHour, 0, 23)) fail('invalid initial hour');
                if (raw.accountIds !== undefined) options.accountIds = Array.isArray(raw.accountIds) ? [...raw.accountIds] : raw.accountIds;
                if (raw.hourHeight !== undefined) options.hourHeight = raw.hourHeight;
                if (raw.initialHour !== undefined) options.initialHour = raw.initialHour;
            }
            if (widget.type === 'account-tasks') {
                if (!accountId(raw.accountId)) fail('task widgets need an account');
                if (raw.accountId === '$account' && column.repeat !== 'accounts') fail('$account requires an account-repeated column');
                options.accountId = raw.accountId;
                if (raw.showCompleted !== undefined) {
                    if (typeof raw.showCompleted !== 'boolean') fail('invalid completed-task preference');
                    options.showCompleted = raw.showCompleted;
                }
                if (raw.taskListIds !== undefined) {
                    if (!Array.isArray(raw.taskListIds) || raw.taskListIds.length > 200 || !raw.taskListIds.every(accountId)) fail('invalid task list selection');
                    options.taskListIds = [...raw.taskListIds];
                }
            }
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
    return { version: LAYOUT_VERSION, id: input.id, name: input.name, columns };
}

export function resolveLayout(input, accounts) {
    const layout = validateLayout(input);
    const primary = accounts.find(account => account.isPrimary);
    const secondary = accounts.find(account => !account.isPrimary);
    const resolveAccount = (id, repeated) => id === '$account' ? repeated.sub : id === '$primary' ? primary?.sub : id === '$secondary' ? secondary?.sub : id;
    return layout.columns.flatMap(column => {
        const bindings = column.repeat === 'accounts' ? accounts : [null];
        return bindings.map(account => {
            const key = column.id + (account ? ':' + account.sub : '');
            return { ...column, id: key, widgets: column.widgets.map(widget => {
                const options = { ...widget.options };
                if (options.accountId) options.accountId = resolveAccount(options.accountId, account);
                if (Array.isArray(options.accountIds)) options.accountIds = options.accountIds.map(id => resolveAccount(id, account)).filter(Boolean);
                return { ...widget, id: layout.id + ':' + widget.id + (account ? ':' + account.sub : ''), options };
            }) };
        });
    });
}

export function createLayoutRepository({ storage, ownerId }) {
    if (!ownerId) throw new TypeError('A layout owner is required.');
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
