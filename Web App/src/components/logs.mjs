import { el, localDate } from '../ui/dom.mjs?v=logs-1';
import { WORKOUT_TYPES, entriesForDay, workoutDays, formatSleepDuration } from '../state/log-model.mjs?v=logs-1';

let sequence = 0;
const labels = { sleep: 'Sleep', weight: 'Weight', workout: 'Workout', 'workout-streak': 'Workout days', food: 'Food', water: 'Water' };
const clock = value => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
function button(text, action, className = 'log-button') {
    const node = el('button', className, text); node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
}

/** Shared daily log presentation; the owner supplies persistence and editor actions. */
export function createLogs({ id, type = 'logs-group', options = {}, actions = {} }) {
    const grouped = type === 'logs-group';
    const element = el('section', 'logs-panel planner-widget' + (grouped ? ' logs-group-panel' : ' individual-log-panel'));
    element.dataset.widgetId = id;
    const heading = el('div', 'column-heading logs-heading');
    const title = el('h2'); title.id = 'logs-title-' + (++sequence); element.setAttribute('aria-labelledby', title.id);
    const manage = button('Manage logs', () => actions.manageLogs?.(options.logType === 'custom' ? options.customLogId : undefined), 'log-button log-manage');
    heading.append(title, manage);
    const date = el('time', 'logs-date');
    const notice = el('div', 'logs-notice'); notice.setAttribute('role', 'status');
    const content = el('div', 'logs-content');
    element.append(heading, date, notice, content);
    let current, destroyed = false;
    const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    function available() { return !current?.isLayoutPreview && current?.logs?.status === 'ready' && !current.logs.saving; }
    function actionButton(text, action, className) {
        const control = button(text, async () => {
            control.disabled = true;
            try { await action(); }
            catch (error) { if (!destroyed) { notice.hidden = false; notice.textContent = error.message || 'Couldn’t save your log. Try again.'; } }
            finally { if (!destroyed) control.disabled = !available(); }
        }, className); control.disabled = !available(); return control;
    }
    function empty(parent, text = 'No entries for this day.') { parent.append(el('p', 'log-empty', text)); }
    function entryText(entry) {
        if (entry.type === 'weight') return Number(entry.weight).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + entry.unit;
        if (entry.type === 'workout') {
            const workout = WORKOUT_TYPES.find(item => item.id === entry.workoutType);
            return (workout?.name || 'Workout') + (entry.name ? ' · ' + entry.name : '');
        }
        if (entry.type === 'food') return entry.name;
        if (entry.type === 'sleep') return clock(entry.bedTime) + ' – ' + clock(entry.wakeTime) + (formatSleepDuration(entry) ? ' · ' + formatSleepDuration(entry) : '');
        return '';
    }
    function builtIn(type, dayEntries) {
        const renderedDay = new Date(current.day);
        const section = el('section', 'daily-log-section log-' + type); section.dataset.logType = type;
        const header = el('div', 'daily-log-heading'); header.append(el('h3', '', labels[type]));
        if (type !== 'workout-streak' && type !== 'water') header.append(actionButton('Add', () => actions.addLog?.(type, renderedDay), 'log-button log-add'));
        section.append(header);
        if (type === 'workout-streak') {
            const count = workoutDays(current.logs?.entries || [], current.day);
            const value = el('strong', 'workout-days-value', available() || current.logs?.status === 'ready' ? count + ' / 7' : '— / 7');
            const dots = el('div', 'workout-days-dots'); dots.setAttribute('aria-hidden', 'true');
            for (let index = 0; index < 7; index++) dots.append(el('span', index < count ? 'is-filled' : ''));
            section.append(value, dots, el('p', 'log-empty', 'Days with a workout in the last 7 days.'));
            return section;
        }
        const entries = dayEntries.filter(entry => entry.type === type);
        if (type === 'water') {
            const cups = entries[0]?.cups || 0;
            const controls = el('div', 'water-controls');
            controls.append(actionButton('−', () => actions.setWater?.(renderedDay, Math.max(0, cups - 1)), 'log-button water-step'));
            const amount = el('span', 'water-amount', current.logs?.status === 'ready' ? cups + (cups === 1 ? ' cup' : ' cups') : '— cups'); amount.setAttribute('aria-live', 'polite');
            controls.append(amount, actionButton('+', () => actions.setWater?.(renderedDay, Math.min(99, cups + 1)), 'log-button water-step'));
            controls.firstElementChild.setAttribute('aria-label', 'Remove one cup of water');
            controls.lastElementChild.setAttribute('aria-label', 'Add one cup of water');
            const drops = el('div', 'water-drops');
            for (let index = 1; index <= 4; index++) {
                const drop = actionButton('●', () => actions.setWater?.(renderedDay, cups >= index ? index - 1 : index), 'water-drop' + (cups >= index ? ' is-filled' : ''));
                drop.setAttribute('aria-label', 'Set water to ' + (cups >= index ? index - 1 : index) + ' cups'); drops.append(drop);
            }
            section.append(controls, drops); return section;
        }
        const list = el('ul', 'log-entry-list');
        for (const entry of [...entries].sort((a, b) => (type === 'weight' ? -1 : 1) * a.time.localeCompare(b.time))) {
            const row = el('li');
            const edit = actionButton('', () => actions.editLog?.(entry), 'log-entry-button');
            if (entry.type !== 'sleep') edit.append(el('span', 'log-entry-time', entry.time));
            edit.append(el('span', 'log-entry-value', entryText(entry)));
            edit.setAttribute('aria-label', 'Edit ' + labels[type].toLowerCase() + ': ' + entryText(entry));
            row.append(edit); list.append(row);
        }
        if (entries.length) section.append(list); else empty(section, current.logs?.status === 'ready' ? 'No entries for this day.' : 'Entries will appear when your logs are connected.');
        return section;
    }
    function custom(definition) {
        const renderedDay = new Date(current.day);
        const section = el('section', 'daily-log-section log-custom'); section.dataset.customLogId = definition.id;
        const header = el('div', 'daily-log-heading');
        header.append(el('h3', '', definition.name), button('Edit items', () => actions.manageLogs?.(definition.id), 'log-button'));
        header.lastElementChild.disabled = current.isLayoutPreview === true;
        section.append(header);
        if (definition.enabled === false) { empty(section, 'This checklist is archived. Restore it in Manage logs.'); return section; }
        const items = (definition.items || []).filter(item => item.enabled !== false).sort((a, b) => a.order - b.order);
        if (!items.length) empty(section, 'Add checklist items to start tracking this log.');
        const list = el('ul', 'custom-log-checklist');
        for (const item of items) {
            const checked = (current.logs?.completions || []).some(entry => entry.day === localDate(renderedDay) && entry.customLogId === definition.id && entry.itemId === item.id && entry.completed);
            const row = el('li'); const label = el('label', checked ? 'is-completed' : '');
            const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = checked; checkbox.disabled = !available();
            checkbox.addEventListener('change', async () => {
                checkbox.disabled = true;
                try { await actions.toggleCustomLog?.(definition.id, item.id, renderedDay, checkbox.checked); }
                catch (error) { if (!destroyed) { checkbox.checked = checked; notice.hidden = false; notice.textContent = error.message || 'Couldn’t save this checklist. Try again.'; } }
                finally { if (!destroyed) checkbox.disabled = !available(); }
            });
            label.append(checkbox, el('span', '', item.title)); row.append(label); list.append(row);
        }
        section.append(list); return section;
    }
    function update(context) {
        if (destroyed) return;
        current = context;
        const definitions = context.customLogs || [];
        const definition = definitions.find(log => log.id === options.customLogId);
        title.textContent = options.title || (grouped ? 'Logs' : options.logType === 'custom' ? definition?.name || options.customLogName || 'Custom log' : labels[options.logType] || 'Log');
        manage.hidden = !grouped && options.logType !== 'custom';
        manage.disabled = context.isLayoutPreview === true;
        date.textContent = dateFormat.format(context.day); date.setAttribute('datetime', localDate(context.day));
        const scrollTop = content.scrollTop;
        content.replaceChildren(); notice.replaceChildren();
        const state = context.logs || { status: 'loading' };
        notice.hidden = state.status === 'ready' && !state.error;
        if (state.status === 'unconfigured') notice.textContent = 'Cloud logs aren’t connected yet. Firebase setup is required before entries can be saved.';
        else if (state.status === 'error') {
            const retry = button('Try again', async () => {
                try { await actions.refreshLogs?.(); }
                catch (error) { if (!destroyed) { notice.hidden = false; notice.textContent = error.message || 'Couldn’t reconnect your logs. Try again.'; } }
            });
            retry.disabled = context.isLayoutPreview === true;
            notice.append(el('span', '', state.error || 'Couldn’t load your logs.'), retry);
        } else if (state.status !== 'ready') notice.textContent = 'Loading your logs…';
        else if (state.error) notice.textContent = state.error;
        const dayEntries = entriesForDay(state.entries || [], context.day);
        if (grouped) {
            for (const type of ['sleep', 'weight', 'workout', 'workout-streak', 'food', 'water']) content.append(builtIn(type, dayEntries));
            for (const log of [...definitions].filter(log => log.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0))) content.append(custom(log));
        } else if (options.logType === 'custom') {
            if (definition) content.append(custom(definition));
            else empty(content, 'This checklist is unavailable. Open Manage logs to create or restore it.');
        } else content.append(builtIn(options.logType, dayEntries));
        content.scrollTop = scrollTop;
    }
    return { element, update, destroy() { destroyed = true; element.replaceChildren(); element.remove(); } };
}
