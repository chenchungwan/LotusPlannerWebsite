import { el } from '../ui/dom.mjs?v=logs-1';
import { BUILT_IN_LOGS, WORKOUT_TYPES, validateLogEntry } from '../state/log-model.mjs?v=logs-1';

const supported = new Set(['weight', 'workout', 'food', 'sleep']);
let sequence = 0;
const pad = value => String(value).padStart(2, '0');
const clock = value => pad(value.getHours()) + ':' + pad(value.getMinutes());
const localDay = value => [String(value.getFullYear()).padStart(4, '0'), pad(value.getMonth() + 1), pad(value.getDate())].join('-');
const localTimestamp = value => localDay(value) + 'T' + clock(value);

function parseDay(value) {
    const key = value instanceof Date && Number.isFinite(value.getTime()) ? localDay(value) : value;
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError('Choose a valid date.');
    const [year, month, day] = key.split('-').map(Number);
    const parsed = new Date(0); parsed.setFullYear(year, month - 1, day); parsed.setHours(12, 0, 0, 0);
    if (year < 1 || parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) throw new TypeError('Choose a valid date.');
    return { key, parsed };
}

function toInstant(value, label) {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new TypeError('Choose a valid ' + label + '.');
    const { parsed } = parseDay(value.slice(0, 10));
    const [hours, minutes] = value.slice(11).split(':').map(Number);
    parsed.setHours(hours, minutes, 0, 0);
    // A nonexistent daylight-saving clock time must not silently move forward.
    if (parsed.getHours() !== hours || parsed.getMinutes() !== minutes) throw new TypeError('That ' + label + ' does not exist in your timezone. Choose another time.');
    return parsed.toISOString();
}

function newId() {
    return globalThis.crypto?.randomUUID?.() || 'log-' + Date.now().toString(36) + '-' + (++sequence) + '-' + Math.random().toString(36).slice(2);
}

/** One captured entry draft; data changes elsewhere never replace its date or values. */
export function createLogEntryDialog({ root, getContext = () => ({}), actions = {} }) {
    const dialog = el('dialog', 'log-entry-dialog');
    const title = el('h2'); title.id = 'log-entry-title-' + (++sequence);
    dialog.setAttribute('aria-labelledby', title.id);
    const form = el('form'); form.noValidate = true;
    const header = el('header', 'log-entry-header');
    const closeButton = button('Close', 'log-entry-close'); closeButton.setAttribute('aria-label', 'Close log entry');
    header.append(title, closeButton);
    const fields = el('div', 'log-entry-fields');
    const status = el('p', 'log-entry-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const confirmation = el('div', 'log-entry-delete-confirmation'); confirmation.hidden = true;
    const confirmCopy = el('p', '', 'Delete this entry? This cannot be undone.');
    const keepButton = button('Keep entry', 'log-entry-keep');
    const confirmDelete = button('Delete entry', 'log-entry-confirm-delete');
    confirmation.append(confirmCopy, keepButton, confirmDelete);
    const footer = el('div', 'log-entry-actions');
    const deleteButton = button('Delete', 'log-entry-delete');
    const cancel = button('Cancel', 'log-entry-cancel secondary-button');
    const save = button('Create', 'log-entry-save primary-button'); save.type = 'submit';
    footer.append(deleteButton, cancel, save);
    form.append(header, fields, status, confirmation, footer); dialog.append(form); root.append(dialog);

    let entryType, entryId, existing, controls = {}, inputControls = [];
    let context = getContext();
    let pending = false, destroyed = false;
    const listeners = new AbortController();
    const on = (node, type, listener) => node.addEventListener(type, listener, { signal: listeners.signal });

    function button(text, className) { const value = el('button', className, text); value.type = 'button'; return value; }
    function message(text = '', error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
    function input(type, name, value = '') {
        const node = el('input'); node.type = type; node.name = name; node.value = value;
        inputControls.push(node); controls[name] = node; return node;
    }
    function field(label, node) {
        const wrapper = el('label', 'log-entry-field'); wrapper.append(el('span', '', label), node); fields.append(wrapper); return wrapper;
    }
    function optionalTime(name, label, value) {
        const row = el('div', 'log-entry-optional-time');
        const picker = input('datetime-local', name, value ? localTimestamp(new Date(value)) : ''); picker.step = '60';
        const wrapper = el('label', 'log-entry-field'); wrapper.append(el('span', '', label), picker);
        const set = button('Set ' + label.toLowerCase(), 'log-entry-set-time');
        const clear = button('Clear', 'log-entry-clear-time'); clear.setAttribute('aria-label', 'Clear ' + label.toLowerCase());
        inputControls.push(set, clear);
        set.addEventListener('click', () => {
            if (pending) return;
            try {
                const date = parseDay(controls.day.value).parsed;
                if (name === 'bedTime') { date.setDate(date.getDate() - 1); date.setHours(23, 0, 0, 0); }
                else date.setHours(8, 0, 0, 0);
                picker.value = localTimestamp(date); message();
            } catch (error) { message(error.message, true); }
        });
        clear.addEventListener('click', () => { if (!pending) picker.value = ''; });
        row.append(wrapper, set, clear); fields.append(row);
    }
    function setBusy(value) {
        pending = value;
        [...inputControls, closeButton, cancel, save, deleteButton, keepButton, confirmDelete].forEach(control => { control.disabled = value; });
        form.setAttribute('aria-busy', String(value));
        save.textContent = value ? 'Saving…' : existing ? 'Save changes' : 'Create';
    }
    function close() {
        if (pending || !dialog.open) return;
        dialog.close(); entryId = null; existing = null; confirmation.hidden = true; message();
    }
    function open(type, day, entry) {
        if (destroyed || dialog.open || pending) return false;
        if (!supported.has(type)) throw new TypeError('Choose Weight, Workout, Food, or Sleep.');
        const valid = entry ? validateLogEntry(entry) : null;
        if (valid && valid.type !== type) throw new TypeError('The entry type does not match this form.');
        const date = parseDay(valid?.day || day);
        entryType = type; existing = valid; entryId = valid?.id || newId();
        context = getContext();
        controls = {}; inputControls = []; fields.replaceChildren(); confirmation.hidden = true; message();
        const name = BUILT_IN_LOGS.find(log => log.id === type).name;
        title.textContent = (valid ? 'Edit ' : 'Add ') + name;
        const dateInput = input('date', 'day', date.key); dateInput.required = true; field('Date', dateInput);
        if (type !== 'sleep') {
            const time = input('time', 'time', valid?.time || clock(new Date())); time.required = true; field('Time', time);
        }
        if (type === 'weight') {
            const weight = input('number', 'weight', valid ? String(valid.weight) : '');
            weight.step = 'any'; weight.min = '0'; weight.inputMode = 'decimal'; weight.required = true; field('Weight', weight);
            const unit = el('select'); unit.name = 'unit';
            for (const value of ['lbs', 'kg']) { const option = el('option', '', value); option.value = value; unit.append(option); }
            unit.value = valid?.unit || 'lbs'; controls.unit = unit; inputControls.push(unit); field('Unit', unit);
        } else if (type === 'workout') {
            const select = el('select'); select.name = 'workoutType';
            for (const value of WORKOUT_TYPES) { const option = el('option', '', value.name); option.value = value.id; select.append(option); }
            select.value = valid?.workoutType || 'running'; controls.workoutType = select; inputControls.push(select); field('Workout type', select);
            const description = input('text', 'name', valid?.name || ''); description.maxLength = 500; description.required = true; field('Description', description);
        } else if (type === 'food') {
            const nameInput = el('textarea'); nameInput.name = 'name'; nameInput.value = valid?.name || ''; nameInput.maxLength = 500; nameInput.required = true;
            controls.name = nameInput; inputControls.push(nameInput); field('Food name', nameInput);
        } else {
            fields.append(el('p', 'log-entry-help', 'Set a bed time, a wake time, or both.'));
            optionalTime('bedTime', 'Bed time', valid?.bedTime);
            optionalTime('wakeTime', 'Wake time', valid?.wakeTime);
        }
        deleteButton.hidden = !valid;
        setBusy(false); dialog.showModal();
        return true;
    }
    function draft() {
        const entry = { id: entryId, type: entryType, day: controls.day.value, time: controls.time?.value || existing?.time || '12:00' };
        if (entryType === 'weight') Object.assign(entry, { weight: Number(controls.weight.value), unit: controls.unit.value });
        else if (entryType === 'workout') Object.assign(entry, { workoutType: controls.workoutType.value, name: controls.name.value });
        else if (entryType === 'food') entry.name = controls.name.value;
        else Object.assign(entry, { bedTime: toInstant(controls.bedTime.value, 'bed time'), wakeTime: toInstant(controls.wakeTime.value, 'wake time') });
        return validateLogEntry(entry);
    }
    async function submit(event) {
        event.preventDefault();
        if (pending || destroyed || !dialog.open) return;
        let value;
        try { value = draft(); } catch (error) { message(error.message || 'Check your entry and try again.', true); return; }
        confirmation.hidden = true; setBusy(true); message('Saving…');
        try {
            if (typeof actions.saveEntry !== 'function') throw new Error('Saving is unavailable. Please try again.');
            await actions.saveEntry(value);
            if (destroyed) return;
            setBusy(false); close();
        } catch (error) {
            if (!destroyed) { setBusy(false); message(error.message || 'Your entry could not be saved. Please try again.', true); }
        }
    }
    async function remove() {
        if (pending || destroyed || !existing || confirmation.hidden) return;
        setBusy(true); message('Deleting…');
        try {
            if (typeof actions.deleteEntry !== 'function') throw new Error('Deleting is unavailable. Please try again.');
            await actions.deleteEntry(entryId);
            if (destroyed) return;
            setBusy(false); close();
        } catch (error) {
            if (!destroyed) { setBusy(false); message(error.message || 'Your entry could not be deleted. Please try again.', true); }
        }
    }
    on(form, 'submit', submit);
    on(closeButton, 'click', close); on(cancel, 'click', close);
    on(deleteButton, 'click', () => { if (!pending && existing) { confirmation.hidden = false; message(); } });
    on(keepButton, 'click', () => { if (!pending) confirmation.hidden = true; });
    on(confirmDelete, 'click', remove);
    on(dialog, 'cancel', event => { event.preventDefault(); close(); });
    on(dialog, 'keydown', event => { if (event.key === 'Escape' && pending) { event.preventDefault(); event.stopPropagation(); } });
    return {
        open,
        update(next) { context = next; },
        destroy() {
            if (destroyed) return;
            destroyed = true; listeners.abort();
            if (dialog.open) dialog.close(); dialog.remove(); controls = {}; inputControls = []; context = null;
        },
    };
}
