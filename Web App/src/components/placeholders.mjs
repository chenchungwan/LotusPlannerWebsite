import { el, localDate } from '../ui/dom.mjs?v=components-1';

export const LOG_TYPES = Object.freeze([
    { id: 'sleep', name: 'Sleep' },
    { id: 'weight', name: 'Weight' },
    { id: 'workout', name: 'Workout' },
    { id: 'workout-streak', name: 'Workout streak' },
    { id: 'food', name: 'Food' },
    { id: 'water', name: 'Water' },
].map(Object.freeze));

const titles = { journal: 'Journal', 'logs-group': 'Logs', log: 'Log', goals: 'Goals', 'weight-graph': 'Weight graph' };
let nextInstance = 0;

function customLogs(options, context) {
    const seen = new Set();
    const merged = [];
    for (const source of [options.customLogs, context.customLogs]) {
        if (!Array.isArray(source)) continue;
        for (const entry of source) {
            if (!entry || typeof entry.id !== 'string' || !entry.id.trim() ||
                typeof entry.name !== 'string' || !entry.name.trim() || seen.has(entry.id)) continue;
            seen.add(entry.id);
            merged.push({ id: entry.id, name: entry.name.trim(), custom: true });
        }
    }
    return merged;
}

function customName(options, context) {
    const current = (Array.isArray(context.customLogs) ? context.customLogs : []).find(log => log?.id === options.customLogId);
    return current?.name || customLogs(options, context).find(log => log.id === options.customLogId)?.name ||
        options.customLogName || 'Custom log';
}

function nameForLog(options, context) {
    if (options.title) return options.title;
    if (options.logType === 'custom') return customName(options, context);
    return LOG_TYPES.find(log => log.id === options.logType)?.name || 'Log';
}

function defaultTitle(kind, options, context) {
    if (kind === 'log') return nameForLog(options, context);
    if (kind === 'weight-graph') return ({ week: 'Weekly weight', month: 'Monthly weight', year: 'Yearly weight' })[options.period] || 'Weekly weight';
    if (kind === 'goals') return 'Goals · ' + (options.orientation === 'horizontal' ? 'horizontal' : 'vertical') + ' bars';
    return titles[kind];
}

function validDay(day) {
    return day instanceof Date && Number.isFinite(day.getTime()) ? day : null;
}

function graphLabels(period, day) {
    if (!day) return [];
    const year = day.getFullYear(), month = day.getMonth();
    if (period === 'year') {
        const formatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
        return Array.from({ length: 12 }, (_, index) => formatter.format(new Date(year, index, 1)));
    }
    if (period === 'month') {
        const lastDay = new Date(year, month + 1, 0).getDate();
        const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
        return [...new Set([1, 8, 15, 22, lastDay])].map(date => formatter.format(new Date(year, month, date)));
    }
    const start = new Date(year, month, day.getDate() - ((day.getDay() + 6) % 7));
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
}

/** Read-only component previews. No values are inferred from the user or the calendar. */
export function createPlaceholder({ id, type = 'journal', options = {}, actions = {} }) {
    const kind = Object.hasOwn(titles, type) ? type : 'journal';
    const element = el('section', 'placeholder-panel planner-widget placeholder-' + kind);
    element.dataset.widgetId = String(id);
    element.dataset.placeholderType = kind;
    const heading = el('div', 'column-heading placeholder-heading');
    const title = el('h2'); title.id = 'placeholder-title-' + (++nextInstance);
    const badge = el('span', 'placeholder-badge', 'Coming soon');
    heading.append(title, badge);
    element.setAttribute('aria-labelledby', title.id);
    const date = el('time', 'placeholder-date');
    const body = el('div', 'placeholder-body');
    element.append(heading, date, body);
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    let destroyed = false;
    let bodySignature;

    function logCard(log) {
        const card = el('div', 'placeholder-log-card'); card.dataset.logType = log.custom ? 'custom:' + log.id : log.id;
        const value = el('span', 'placeholder-log-value', '—'); value.setAttribute('aria-label', 'No data');
        card.append(el('span', 'placeholder-log-label', log.name), value);
        return card;
    }

    function renderJournal() {
        body.append(el('p', 'placeholder-hint', 'A space for your thoughts. Journal writing is coming soon.'));
        const lines = el('div', 'placeholder-journal-lines'); lines.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 6; index++) lines.append(el('div', 'placeholder-journal-line'));
        body.append(lines);
    }

    function renderLogs(context) {
        const grid = el('div', 'placeholder-log-grid');
        for (const log of [...LOG_TYPES, ...customLogs(options, context)]) grid.append(logCard(log));
        body.append(grid, el('p', 'placeholder-hint', 'Log entries will appear here. This is a placeholder.'));
    }

    function renderLog(context) {
        const id = options.logType === 'custom' ? options.customLogId || 'custom' : options.logType || 'log';
        body.append(logCard({ id, name: nameForLog(options, context), custom: options.logType === 'custom' }),
            el('p', 'placeholder-hint', 'Your entries will appear here. Logging is coming soon.'));
    }

    function renderGoals() {
        const orientation = options.orientation === 'horizontal' ? 'horizontal' : 'vertical';
        const list = el('div', 'placeholder-goals-list is-' + orientation); list.dataset.orientation = orientation;
        for (let index = 0; index < 3; index++) {
            const card = el('div', 'placeholder-goal-card');
            const track = el('div', 'placeholder-track'); track.setAttribute('aria-hidden', 'true');
            card.append(el('span', 'placeholder-goal-label', 'Goal placeholder'), track); list.append(card);
        }
        body.append(list, el('p', 'placeholder-hint', 'Your goals and progress will appear here. Goal tracking is coming soon.'));
    }

    function renderGraph(day) {
        const period = ['week', 'month', 'year'].includes(options.period) ? options.period : 'week';
        const graph = el('div', 'placeholder-graph period-' + period); graph.dataset.period = period;
        graph.setAttribute('role', 'img'); graph.setAttribute('aria-label', 'Empty weight graph for the selected ' + period + '. No weight data.');
        const plot = el('div', 'placeholder-graph-plot');
        const grid = el('div', 'placeholder-graph-grid'); grid.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 5; index++) grid.append(el('div', 'placeholder-graph-grid-line'));
        plot.append(grid, el('span', 'placeholder-graph-axis-label', 'Weight'),
            el('p', 'placeholder-graph-empty', 'Weight data will appear here'));
        const labels = el('div', 'placeholder-graph-labels');
        for (const label of graphLabels(period, day)) labels.append(el('span', '', label));
        graph.append(plot, labels);
        body.append(graph, el('p', 'placeholder-hint', 'Graph placeholder · ' + ({ week: 'Weekly', month: 'Monthly', year: 'Yearly' })[period] + ' view'));
    }

    function update(context = {}) {
        if (destroyed) return;
        const day = validDay(context.day);
        title.textContent = options.title || defaultTitle(kind, options, context);
        date.textContent = day ? formatter.format(day) : 'Selected day';
        if (day) date.setAttribute('datetime', localDate(day)); else date.removeAttribute('datetime');
        const signature = JSON.stringify([kind, options, customLogs(options, context),
            kind === 'log' ? nameForLog(options, context) : '', kind === 'weight-graph' && day ? localDate(day) : '']);
        if (signature === bodySignature) return;
        bodySignature = signature;
        const scrollTop = body.scrollTop;
        body.replaceChildren();
        if (kind === 'journal') renderJournal();
        else if (kind === 'logs-group') renderLogs(context);
        else if (kind === 'log') renderLog(context);
        else if (kind === 'goals') renderGoals();
        else renderGraph(day);
        body.scrollTop = scrollTop;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true; body.replaceChildren(); element.replaceChildren(); element.remove();
    }

    return { element, update, destroy };
}
