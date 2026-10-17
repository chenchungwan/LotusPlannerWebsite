import { el } from '../ui/dom.mjs?v=logs-1';

let headingSequence = 0;
const ACCOUNT_COLORS = ['#1595ff', '#ce7df3', '#26a58a', '#f0a344', '#e27689'];

function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dayBounds(day) {
    if (!(day instanceof Date) || !Number.isFinite(day.getTime())) throw new TypeError('A valid timeline day is required.');
    return {
        start: new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(),
        end: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
    };
}

function wallMinutes(date, bounds) {
    if (date.getTime() <= bounds.start) return 0;
    if (date.getTime() >= bounds.end) return 1440;
    return date.getHours() * 60 + date.getMinutes();
}

/**
 * Place timed Google events on a local 24-hour clock without changing their data.
 * Records may be an event or { event, account }; account metadata is carried through.
 * Positions are in minutes, leaving each component free to choose its hour height.
 */
export function layoutTimedEvents(events, day) {
    const bounds = dayBounds(day);
    const timed = [];
    events.forEach(record => {
        const event = record && (record.event || record);
        if (!event || event.status === 'cancelled' || !event.start || !event.start.dateTime) return;
        const start = new Date(event.start.dateTime);
        const end = event.end && event.end.dateTime ? new Date(event.end.dateTime) : new Date(start.getTime() + 30 * 60000);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;
        if (end.getTime() <= bounds.start || start.getTime() >= bounds.end) return;
        const top = wallMinutes(start, bounds);
        let bottom = wallMinutes(end, bounds);
        // The repeated autumn hour can end a real event before its start on the clock.
        if (bottom <= top) {
            const elapsed = (Math.min(end.getTime(), bounds.end) - Math.max(start.getTime(), bounds.start)) / 60000;
            bottom = Math.min(1440, top + elapsed);
        }
        if (bottom <= top) return;
        timed.push({ ...record, event, start, end, top, bottom, lane: 0, lanes: 1 });
    });
    timed.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    let group = [];
    let laneEnds = [];
    function finishGroup() {
        group.forEach(item => { item.lanes = laneEnds.length; });
        group = [];
        laneEnds = [];
    }
    timed.forEach(item => {
        if (group.length && item.top >= Math.max(...laneEnds)) finishGroup();
        let lane = laneEnds.findIndex(end => end <= item.top);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = item.bottom;
        item.lane = lane;
        group.push(item);
    });
    finishGroup();
    return timed;
}

export function createTimeline({ id, options = {}, actions = {} }) {
    if (typeof id !== 'string' || !id) throw new TypeError('A timeline widget id is required.');
    const requestedHeight = Number(options.hourHeight);
    const hourHeight = Number.isFinite(requestedHeight) ? Math.min(160, Math.max(32, requestedHeight)) : 76;
    const requestedHour = Number(options.initialHour);
    const initialHour = options.initialHour !== undefined && Number.isFinite(requestedHour)
        ? Math.min(23, Math.max(0, requestedHour)) : null;
    const element = el('section', 'timeline-panel planner-widget');
    element.dataset.widgetId = id;
    element.dataset.component = 'timeline';
    element.style.setProperty('--hour', hourHeight + 'px');
    const heading = el('div', 'column-heading');
    const title = el('h2', 'timeline-heading', options.title || 'Timeline');
    title.id = id + '-heading-' + (++headingSequence);
    element.setAttribute('aria-labelledby', title.id);
    const timezone = el('span', 'column-caption');
    heading.append(title, timezone);
    const notices = el('div', 'calendar-notices');
    notices.setAttribute('aria-live', 'polite');
    const allDay = el('div', 'all-day-events');
    allDay.hidden = true;
    const scroller = el('div', 'timeline-scroll');
    const hours = el('div', 'timeline-hours');
    scroller.append(hours);
    element.append(heading, notices, allDay, scroller);
    const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const timezoneFormat = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
    let lastDay = '';
    let latestContext;
    let nowLine;
    let destroyed = false;
    let pendingScroll;

    function selectedAccounts(context) {
        const accounts = context.accounts || [];
        if (!Array.isArray(options.accountIds)) return accounts;
        return accounts.filter(account => options.accountIds.includes(account.sub));
    }

    function accountColor(account, context) {
        const index = Math.max(0, (context.accounts || []).findIndex(item => item.sub === account.sub));
        return account.color || account.accentColor || ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
    }

    function reconnectButton(account, context) {
        const button = el('button', 'inline-reconnect', 'Reconnect');
        button.type = 'button';
        button.disabled = !context.googleReady || context.linking || typeof actions.reconnect !== 'function';
        button.addEventListener('click', () => { if (!destroyed && actions.reconnect) actions.reconnect(account); });
        return button;
    }

    function buildHours() {
        hours.replaceChildren();
        nowLine = undefined;
        for (let hour = 0; hour < 24; hour++) {
            const row = el('div', 'hour-line');
            row.append(el('span', 'hour-label', (hour % 12 || 12) + (hour < 12 ? 'a' : 'p')));
            hours.append(row);
        }
    }

    function tick(context = latestContext) {
        if (destroyed || !context || !context.day) return;
        if (nowLine) { nowLine.remove(); nowLine = undefined; }
        const now = new Date();
        if (localDate(now) !== localDate(context.day)) return;
        nowLine = el('div', 'now-line');
        nowLine.style.top = ((now.getHours() * 60 + now.getMinutes()) / 60 * hourHeight) + 'px';
        nowLine.setAttribute('aria-label', 'Current time ' + timeFormat.format(now));
        hours.append(nowLine);
    }

    function update(context) {
        if (destroyed) return;
        dayBounds(context.day);
        latestContext = context;
        const dateKey = localDate(context.day);
        const dayChanged = lastDay !== dateKey;
        const scrollTop = scroller.scrollTop;
        lastDay = dateKey;
        const zone = timezoneFormat.formatToParts(context.day).find(part => part.type === 'timeZoneName');
        timezone.textContent = zone ? zone.value : '';
        buildHours();
        notices.replaceChildren();
        allDay.replaceChildren();
        const records = [];
        const seen = new Set();
        const accounts = selectedAccounts(context);
        let loading = false;
        let allLoaded = accounts.length > 0;
        accounts.forEach(account => {
            const state = context.results && context.results.get(account.sub) || {};
            if (account.needsReconnect || state.eventsError) {
                allLoaded = false;
                const error = state.eventsError || { reconnect: true, message: 'Reconnect to load this calendar.' };
                const notice = el('div', 'calendar-notice');
                notice.append(el('span', '', (accounts.length > 1 ? account.email + ': ' : '') + (error.message || 'Couldn’t load this calendar.')));
                if (error.reconnect || error.code === 'FORBIDDEN') notice.append(reconnectButton(account, context));
                notices.append(notice);
            } else if (!Array.isArray(state.events)) {
                loading = true;
                allLoaded = false;
                notices.append(el('div', 'calendar-notice', 'Loading calendar…'));
            } else {
                state.events.forEach(event => {
                    if (!event || !event.start || event.status === 'cancelled') return;
                    const key = JSON.stringify([event.calendarId, event.googleId || event.id]);
                    if (seen.has(key)) return;
                    seen.add(key);
                    if (event.start.date) {
                        if (event.start.date > dateKey || (event.end && event.end.date ? event.end.date <= dateKey : event.start.date !== dateKey)) return;
                        const item = el('div', 'all-day-event', event.title || event.summary || 'Busy');
                        item.style.setProperty('--account-color', accountColor(account, context));
                        item.title = 'All day · ' + (account.email || account.name || '') + ' · ' + (event.calendarTitle || 'Calendar');
                        allDay.append(item);
                    } else {
                        records.push({ event, account });
                    }
                });
            }
        });
        const timed = layoutTimedEvents(records, context.day);
        timed.forEach(item => {
            const block = el('div', 'timeline-event');
            const color = accountColor(item.account, context);
            block.style.top = (item.top / 60 * hourHeight) + 'px';
            block.style.height = Math.max(20, (item.bottom - item.top) / 60 * hourHeight - 2) + 'px';
            block.style.left = (item.lane / item.lanes * 100) + '%';
            block.style.width = 'calc(' + (100 / item.lanes) + '% - 3px)';
            block.style.setProperty('--account-color', color);
            block.style.background = 'color-mix(in srgb, ' + color + ' 10%, white)';
            block.style.color = 'color-mix(in srgb, ' + color + ' 60%, #34383d)';
            const times = timeFormat.format(item.start) + ' – ' + timeFormat.format(item.end);
            const eventTitle = item.event.title || item.event.summary || 'Busy';
            block.title = eventTitle + '\n' + times + '\n' + (item.account.email || item.account.name || '') + ' · ' + (item.event.calendarTitle || 'Calendar');
            block.append(el('strong', '', eventTitle), el('time', '', times));
            hours.append(block);
        });
        allDay.hidden = !allDay.children.length;
        if (!accounts.length) notices.append(el('p', 'calendar-notice', 'No linked accounts in this timeline.'));
        else if (allLoaded && !timed.length && !allDay.children.length) notices.append(el('p', 'calendar-notice', 'A clear calendar. Make the day yours.'));
        element.setAttribute('aria-busy', String(loading));
        tick(context);
        if (dayChanged) {
            const now = new Date();
            const hour = initialHour === null ? (localDate(now) === dateKey ? Math.max(0, now.getHours() - 2) : 7) : initialHour;
            pendingScroll = hour * hourHeight;
            scroller.scrollTop = pendingScroll;
            // Support hosts that update a component just before mounting it.
            queueMicrotask(() => {
                if (!destroyed && pendingScroll !== undefined) {
                    scroller.scrollTop = pendingScroll;
                    pendingScroll = undefined;
                }
            });
        } else {
            scroller.scrollTop = pendingScroll === undefined ? scrollTop : pendingScroll;
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        latestContext = undefined;
        pendingScroll = undefined;
        element.replaceChildren();
        element.remove();
    }

    return { element, update, tick, destroy };
}
