(function () {
    'use strict';

    const CALENDAR_ROOT = 'https://www.googleapis.com/calendar/v3';
    const TASKS_ROOT = 'https://tasks.googleapis.com/tasks/v1';
    const READABLE_ROLES = new Set(['reader', 'writer', 'writerWithoutPrivateAccess', 'owner']);

    function apiError(message, code, status) {
        const error = new Error(message);
        error.name = 'GoogleAPIError';
        error.code = code;
        error.status = status || 0;
        error.reconnect = status === 401;
        return error;
    }

    function throwIfAborted(signal) {
        if (!signal || !signal.aborted) return;
        const error = new Error('Request cancelled.');
        error.name = 'AbortError';
        throw error;
    }

    async function request(account, endpoint, parameters, signal, service) {
        throwIfAborted(signal);
        if (!account || !account.accessToken) {
            throw apiError('Reconnect this Google account to load ' + service + '.', 'UNAUTHORIZED', 401);
        }
        const url = new URL(endpoint);
        Object.entries(parameters).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        });
        let response;
        try {
            response = await fetch(url.toString(), {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + account.accessToken },
                signal,
                cache: 'no-store',
                credentials: 'omit',
            });
        } catch (error) {
            if (error.name === 'AbortError' || (signal && signal.aborted)) {
                throwIfAborted(signal);
                throw error;
            }
            // Do not expose Google responses, request URLs, or credentials in UI errors.
            throw apiError('Could not reach Google ' + service + '. Check your connection and try again.', 'NETWORK', 0);
        }
        throwIfAborted(signal);
        if (!response.ok) {
            let details = {};
            try { details = await response.json(); } catch (error) { /* An HTTP error may not contain JSON. */ }
            const googleError = details && details.error || {};
            const reasons = [googleError.status]
                .concat((googleError.errors || []).map(item => item.reason))
                .concat((googleError.details || []).map(item => item.reason));
            if (response.status === 401) {
                throw apiError('Reconnect this Google account to load ' + service + '.', 'UNAUTHORIZED', 401);
            }
            if (response.status === 403) {
                if (reasons.some(reason => ['accessNotConfigured', 'SERVICE_DISABLED', 'API_DISABLED'].includes(reason))) {
                    throw apiError('Google ' + service + ' is not enabled for Lotus Planner yet. Please try again later.', 'API_DISABLED', 403);
                }
                if (reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED'].includes(reason))) {
                    throw apiError('Google ' + service + ' is temporarily busy. Please try again shortly.', 'RATE_LIMITED', 403);
                }
                throw apiError('Google ' + service + ' access was denied. Reconnect this account and allow access, or check its sharing permissions.', 'FORBIDDEN', 403);
            }
            if (response.status === 429) {
                throw apiError('Google ' + service + ' is temporarily busy. Please try again shortly.', 'RATE_LIMITED', 429);
            }
            throw apiError('Could not load Google ' + service + '. Please try again.', 'HTTP_ERROR', response.status);
        }
        try {
            const data = await response.json();
            throwIfAborted(signal);
            if (!data || typeof data !== 'object') throw new Error('Invalid response');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw apiError('Google ' + service + ' returned an unreadable response. Please try again.', 'INVALID_RESPONSE', 0);
        }
    }

    async function allPages(account, endpoint, parameters, signal, service) {
        const items = [];
        const seenTokens = new Set();
        let pageToken;
        do {
            const page = await request(account, endpoint, { ...parameters, pageToken }, signal, service);
            if (Array.isArray(page.items)) items.push(...page.items);
            pageToken = page.nextPageToken;
            if (pageToken) {
                if (seenTokens.has(pageToken)) {
                    throw apiError('Google ' + service + ' could not finish loading. Please try again.', 'INVALID_PAGINATION', 0);
                }
                seenTokens.add(pageToken);
            }
        } while (pageToken);
        return items;
    }

    function localDay(date) {
        let day;
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const parts = date.split('-').map(Number);
            day = new Date(parts[0], parts[1] - 1, parts[2]);
            if (day.getFullYear() !== parts[0] || day.getMonth() !== parts[1] - 1 || day.getDate() !== parts[2]) {
                throw new TypeError('Choose a valid date.');
            }
        } else {
            day = new Date(date);
        }
        if (!Number.isFinite(day.getTime())) throw new TypeError('Choose a valid date.');
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
        // Construct tomorrow locally so daylight-saving days can contain 23 or 25 hours.
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        return { timeMin: start.toISOString(), timeMax: end.toISOString() };
    }

    function eventStart(event) {
        if (event.start.dateTime) return new Date(event.start.dateTime).getTime();
        const parts = event.start.date.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
    }

    async function loadEvents(account, date, options = {}) {
        const range = localDay(date);
        const calendars = await allPages(account, CALENDAR_ROOT + '/users/me/calendarList', {
            maxResults: 250, minAccessRole: 'reader', showDeleted: false, showHidden: false,
        }, options.signal, 'Calendar');
        const visible = calendars.filter(calendar => calendar && calendar.id && calendar.selected === true &&
            !calendar.hidden && !calendar.deleted && READABLE_ROLES.has(calendar.accessRole));
        const groups = await Promise.all(visible.map(async calendar => {
            const events = await allPages(account, CALENDAR_ROOT + '/calendars/' + encodeURIComponent(calendar.id) + '/events', {
                ...range, singleEvents: true, orderBy: 'startTime', maxResults: 2500, showDeleted: false,
            }, options.signal, 'Calendar');
            const metadata = { ...calendar, title: calendar.summaryOverride || calendar.summary || 'Calendar' };
            return events.filter(event => event && event.id && event.status !== 'cancelled' &&
                event.start && (event.start.dateTime || event.start.date)).map(event => ({
                ...event,
                googleId: event.id,
                id: [account.sub || account.email || '', calendar.id, event.id].map(encodeURIComponent).join('/'),
                accountId: account.sub || account.email || '',
                calendarId: calendar.id,
                calendarTitle: metadata.title,
                calendar: metadata,
                color: calendar.backgroundColor || '',
                title: event.summary || 'Busy',
            }));
        }));
        return groups.flat().sort((a, b) => eventStart(a) - eventStart(b));
    }

    async function loadTasks(account, options = {}) {
        const lists = await allPages(account, TASKS_ROOT + '/users/@me/lists', { maxResults: 1000 }, options.signal, 'Tasks');
        return Promise.all(lists.filter(list => list && list.id).map(async list => {
            const tasks = await allPages(account, TASKS_ROOT + '/lists/' + encodeURIComponent(list.id) + '/tasks', {
                maxResults: 100, showCompleted: true, showHidden: true, showDeleted: false, showAssigned: true,
            }, options.signal, 'Tasks');
            return {
                ...list,
                title: list.title || 'Tasks',
                accountId: account.sub || account.email || '',
                tasks: tasks.filter(task => task && task.id && !task.deleted).map(task => ({
                    ...task, title: task.title || 'Untitled task',
                })),
            };
        }));
    }

    window.LotusGoogle = { loadEvents, loadTasks };
})();
