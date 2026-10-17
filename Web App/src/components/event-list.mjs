import { el } from '../ui/dom.mjs?v=pocky-1';

let headingSequence = 0;
const ACCOUNT_COLORS = ['#1595ff', '#ce7df3', '#26a58a', '#f0a344', '#e27689'];

function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dayBounds(day) {
    if (!(day instanceof Date) || !Number.isFinite(day.getTime())) throw new TypeError('A valid events-list day is required.');
    return {
        start: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
        end: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    };
}

function calendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(2000, month - 1, day);
    date.setFullYear(year);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** Select and deduplicate one local day's events without changing the supplied data. */
export function selectDayEvents(records, day) {
    const bounds = dayBounds(day);
    const selected = [];
    const seen = new Set();
    records.forEach(record => {
        const event = record && (record.event || record);
        if (!event || event.status === 'cancelled' || !event.start || !event.end) return;
        const allDay = Boolean(event.start.date);
        const start = allDay ? calendarDate(event.start.date) : new Date(event.start.dateTime);
        const end = allDay ? calendarDate(event.end.date) : new Date(event.end.dateTime);
        if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;
        // Google all-day end dates and the selected day's end are both exclusive.
        if (start >= bounds.end || end <= bounds.start) return;
        const googleId = event.googleId || event.id;
        const key = googleId ? JSON.stringify([event.calendarId || event.calendar?.id || '', googleId]) : null;
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        selected.push({
            event,
            account: record.account || null,
            allDay,
            start,
            end,
            displayStart: new Date(Math.max(start.getTime(), bounds.start.getTime())),
            displayEnd: new Date(Math.min(end.getTime(), bounds.end.getTime())),
            continuesBefore: start < bounds.start,
            continuesAfter: end > bounds.end,
        });
    });
    return selected.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.end - b.end ||
        (a.event.title || a.event.summary || '').localeCompare(b.event.title || b.event.summary || ''));
}

export function createEventList({ id, options = {}, actions = {} }) {
    if (typeof id !== 'string' || !id) throw new TypeError('An events-list widget id is required.');
    const element = el('section', 'events-list-panel planner-widget');
    element.dataset.widgetId = id;
    element.dataset.component = 'event-list';
    const heading = el('div', 'column-heading');
    const title = el('h2', 'event-list-heading', options.title || 'Events');
    title.id = 'event-list-heading-' + (++headingSequence);
    element.setAttribute('aria-labelledby', title.id);
    const caption = el('span', 'column-caption');
    heading.append(title, caption);
    const notices = el('div', 'event-list-notices calendar-notices');
    notices.setAttribute('aria-live', 'polite');
    const list = el('ul', 'events-list');
    const empty = el('div', 'event-list-empty empty-state');
    empty.setAttribute('role', 'status');
    empty.hidden = true;
    element.append(heading, notices, list, empty);
    const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const zoneTimeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    let destroyed = false;
    let lastDay = '';
    let retainedScroll = 0;
    let previouslyLoading = false;

    function selectedAccounts(context) {
        const accounts = context.accounts || [];
        return Array.isArray(options.accountIds) ? accounts.filter(account => options.accountIds.includes(account.sub)) : accounts;
    }

    function reconnectButton(account, context) {
        const button = el('button', 'inline-reconnect', 'Reconnect');
        button.type = 'button';
        button.disabled = !context.googleReady || context.linking || typeof actions.reconnect !== 'function';
        button.addEventListener('click', () => {
            if (!destroyed && !button.disabled && typeof actions.reconnect === 'function') actions.reconnect(account);
        });
        return button;
    }

    function renderItem(record, context, bounds) {
        const { event, account } = record;
        const item = el('li', 'event-list-item' + (record.allDay ? ' all-day' : ''));
        const accountIndex = Math.max(0, (context.accounts || []).findIndex(value => value.sub === account?.sub));
        item.style.setProperty('--account-color', account?.color || account?.accentColor || ACCOUNT_COLORS[accountIndex % ACCOUNT_COLORS.length]);
        const time = el('div', 'event-list-time');
        if (record.allDay) {
            time.textContent = 'All day';
        } else {
            // Include zones on clock-change days so the two occurrences of an hour are clear.
            const formatter = bounds.end - bounds.start === 24 * 60 * 60 * 1000 ? timeFormat : zoneTimeFormat;
            time.textContent = formatter.format(record.displayStart);
            if (!event.endTimeUnspecified) time.textContent += ' – ' + (record.displayEnd.getTime() === bounds.end.getTime() ? 'midnight' : formatter.format(record.displayEnd));
        }
        const copy = el('div', 'event-list-copy');
        copy.append(el('strong', 'event-list-title', event.title || event.summary || 'Busy'));
        const calendar = event.calendarTitle || event.calendar?.title || event.calendar?.summary || 'Calendar';
        const accountName = account?.email || account?.name || '';
        copy.append(el('span', 'event-list-caption', calendar + (accountName ? ' · ' + accountName : '')));
        const continuation = [];
        if (record.continuesBefore) continuation.push('Continues from previous day');
        if (record.continuesAfter) continuation.push('Continues tomorrow');
        if (event.endTimeUnspecified && !record.allDay) continuation.push('End time not set');
        if (continuation.length) copy.append(el('span', 'event-list-continuation', continuation.join(' · ')));
        if (event.location) copy.append(el('span', 'event-list-location', event.location));
        item.append(time, copy);
        return item;
    }

    function update(context) {
        if (destroyed) return;
        const bounds = dayBounds(context.day);
        const dateKey = localDate(context.day);
        if (lastDay !== dateKey) retainedScroll = 0;
        else if (!previouslyLoading) retainedScroll = list.scrollTop;
        lastDay = dateKey;
        caption.textContent = dateFormat.format(context.day);
        notices.replaceChildren();
        list.replaceChildren();
        empty.replaceChildren();
        empty.hidden = true;
        const records = [];
        const accounts = selectedAccounts(context);
        let loading = false;
        let errors = false;
        accounts.forEach(account => {
            const state = context.results?.get(account.sub) || {};
            if (account.needsReconnect || state.eventsError) {
                errors = true;
                const error = state.eventsError || { reconnect: true, message: 'Reconnect to load this calendar.' };
                const notice = el('div', 'calendar-notice');
                const prefix = accounts.length > 1 ? (account.email || account.name || 'Google account') + ': ' : '';
                notice.append(el('span', '', prefix + (error.message || 'Couldn’t load this calendar. Please try refreshing.')));
                if (error.reconnect || error.code === 'FORBIDDEN') notice.append(reconnectButton(account, context));
                notices.append(notice);
            } else if (!Array.isArray(state.events)) {
                loading = true;
                const notice = el('div', 'calendar-notice', accounts.length > 1 ? 'Loading ' + (account.email || account.name || 'Google account') + '…' : 'Loading calendar events…');
                notice.setAttribute('role', 'status');
                notices.append(notice);
            }
            if (!account.needsReconnect && Array.isArray(state.events)) state.events.forEach(event => records.push({ event, account }));
        });
        const events = selectDayEvents(records, context.day);
        events.forEach(record => list.append(renderItem(record, context, bounds)));
        list.setAttribute('aria-busy', String(loading));
        if (!events.length && !loading) {
            let title = 'A clear calendar.';
            let message = 'No events scheduled for this day.';
            if (!accounts.length) { title = 'Choose an account.'; message = 'No linked accounts in this events list.'; }
            else if (errors) { title = 'Calendar events aren’t available.'; message = 'Reconnect the affected account or try refreshing.'; }
            empty.append(el('strong', '', title), el('span', '', message));
            empty.hidden = false;
        }
        previouslyLoading = loading;
        list.scrollTop = retainedScroll;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        element.replaceChildren();
        element.remove();
    }

    return { element, update, destroy };
}
