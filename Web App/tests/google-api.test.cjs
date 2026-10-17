const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../google-api.js'), 'utf8');
const account = { sub: 'account', email: 'test@example.com', accessToken: 'private-token' };

function setup(handler) {
    const window = {};
    const requests = [];
    vm.runInNewContext(source, {
        window, URL, Date,
        fetch: async (url, options) => {
            const parsed = new URL(url);
            requests.push({ url: parsed, options });
            const result = await handler(parsed, options);
            return { ok: true, status: 200, json: async () => result };
        },
    });
    return { api: window.LotusGoogle, requests };
}

test('calendar list and event pagination respect selected visible readable calendars', async () => {
    const { api, requests } = setup(url => {
        if (url.pathname.endsWith('/calendarList')) {
            if (!url.searchParams.has('pageToken')) return {
                nextPageToken: 'next-calendar',
                items: [
                    { id: 'one@example.com', selected: true, accessRole: 'owner', summary: 'Main', backgroundColor: '#123456' },
                    { id: 'hidden', selected: true, hidden: true, accessRole: 'owner' },
                    { id: 'unselected', selected: false, accessRole: 'reader' },
                    { id: 'omitted-selection', accessRole: 'owner' },
                    { id: 'deleted', selected: true, deleted: true, accessRole: 'owner' },
                    { id: 'freebusy', selected: true, accessRole: 'freeBusyReader' },
                ],
            };
            assert.equal(url.searchParams.get('pageToken'), 'next-calendar');
            return { items: [{ id: 'two', selected: true, accessRole: 'writerWithoutPrivateAccess', summary: 'Original', summaryOverride: 'Shared' }] };
        }
        if (url.pathname.includes('one%40example.com')) {
            if (!url.searchParams.has('pageToken')) return { nextPageToken: 'next-event', items: [
                { id: 'one', summary: 'Meeting', start: { dateTime: '2026-10-16T10:00:00-07:00' }, end: { dateTime: '2026-10-16T11:00:00-07:00' } },
                { id: 'cancelled', status: 'cancelled', start: { date: '2026-10-16' } },
            ] };
            assert.equal(url.searchParams.get('pageToken'), 'next-event');
            return { items: [{ id: 'all-day', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } }] };
        }
        assert.equal(url.pathname, '/calendar/v3/calendars/two/events');
        return { items: [{ id: 'one', summary: 'Shared event', start: { dateTime: '2026-10-16T09:00:00-07:00' } }] };
    });
    const result = await api.loadEvents(account, '2026-10-16');
    assert.equal(result.length, 3);
    assert.equal(new Set(result.map(event => event.id)).size, 3);
    assert.equal(result[0].googleId, 'all-day');
    assert.equal(result[0].start.date, '2026-10-16');
    assert.equal(result[0].end.date, '2026-10-17');
    assert.equal(result[1].calendar.title, 'Shared');
    assert.equal(result[2].calendarTitle, 'Main');
    assert.equal(result[2].color, '#123456');
    assert.equal(requests.length, 5);
    for (const request of requests) {
        assert.equal(request.options.method, 'GET');
        assert.equal(request.options.headers.Authorization, 'Bearer private-token');
        assert.equal(request.url.searchParams.has('access_token'), false);
        if (request.url.pathname.endsWith('/events')) {
            assert.equal(request.url.searchParams.get('singleEvents'), 'true');
            assert.equal(request.url.searchParams.get('orderBy'), 'startTime');
            assert.equal(request.url.searchParams.get('maxResults'), '2500');
            assert.equal(request.url.searchParams.get('showDeleted'), 'false');
        }
    }
});

test('day boundaries use browser local midnight and next midnight, including daylight saving', async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
        const { api, requests } = setup(url => url.pathname.endsWith('/calendarList')
            ? { items: [{ id: 'primary', selected: true, accessRole: 'owner' }] } : { items: [] });
        await api.loadEvents(account, '2026-11-01');
        const url = requests[1].url;
        assert.equal(url.searchParams.get('timeMin'), '2026-11-01T07:00:00.000Z');
        assert.equal(url.searchParams.get('timeMax'), '2026-11-02T08:00:00.000Z');
        await api.loadEvents(account, '2026-03-08');
        assert.equal(requests[3].url.searchParams.get('timeMin'), '2026-03-08T08:00:00.000Z');
        assert.equal(requests[3].url.searchParams.get('timeMax'), '2026-03-09T07:00:00.000Z');
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
});

test('events from different calendar time zones sort by the actual instant', async () => {
    const app = setup(url => url.pathname.endsWith('/calendarList')
        ? { items: [{ id: 'primary', selected: true, accessRole: 'owner' }] }
        : { items: [
            { id: 'later', start: { dateTime: '2026-10-16T08:00:00-07:00' } },
            { id: 'earlier', start: { dateTime: '2026-10-16T14:00:00Z' } },
        ] });
    assert.deepEqual(Array.from(await app.api.loadEvents(account, '2026-10-16'), event => event.googleId), ['earlier', 'later']);
});

test('task lists and tasks paginate, retain completed hidden tasks and exclude deleted tasks', async () => {
    const { api, requests } = setup(url => {
        if (url.pathname.endsWith('/users/@me/lists')) {
            return url.searchParams.has('pageToken') ? { items: [{ id: 'empty', title: 'Empty list' }] }
                : { nextPageToken: 'more-lists', items: [{ id: 'work/list', title: 'Work' }] };
        }
        if (url.pathname.includes('/work%2Flist/')) {
            return url.searchParams.has('pageToken') ? { items: [
                { id: 'done', title: 'Done in Google', status: 'completed', hidden: true },
                { id: 'deleted', deleted: true, title: 'Deleted' },
            ] } : { nextPageToken: 'more-tasks', items: [
                { id: 'pending', title: 'Plan', status: 'needsAction', parent: 'parent', position: '0001', due: '2026-10-16T00:00:00.000Z' },
            ] };
        }
        return {};
    });
    const result = await api.loadTasks(account);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Work');
    assert.equal(result[0].accountId, account.sub);
    assert.deepEqual(Array.from(result[0].tasks, task => task.id), ['pending', 'done']);
    assert.equal(result[0].tasks[0].parent, 'parent');
    assert.equal(result[0].tasks[1].hidden, true);
    assert.equal(result[1].tasks.length, 0);
    assert.equal(requests.length, 5);
    for (const request of requests.filter(item => item.url.pathname.endsWith('/tasks'))) {
        assert.equal(request.url.searchParams.get('showCompleted'), 'true');
        assert.equal(request.url.searchParams.get('showHidden'), 'true');
        assert.equal(request.url.searchParams.get('showDeleted'), 'false');
        assert.equal(request.url.searchParams.get('maxResults'), '100');
    }
});

function setupFailure(status, payload) {
    const window = {};
    vm.runInNewContext(source, { window, URL, Date, fetch: async () => ({ ok: false, status, json: async () => payload }) });
    return window.LotusGoogle;
}

test('HTTP errors identify reconnection, disabled APIs, permission denial and quotas safely', async () => {
    const cases = [
        [401, {}, 'UNAUTHORIZED', /Reconnect/, true],
        [403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 'API_DISABLED', /not enabled/, false],
        [403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }, 'API_DISABLED', /not enabled/, false],
        [403, { error: { message: 'private-token raw response' } }, 'FORBIDDEN', /allow access/, false],
        [403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'RATE_LIMITED', /temporarily busy/, false],
        [429, {}, 'RATE_LIMITED', /temporarily busy/, false],
        [500, {}, 'HTTP_ERROR', /try again/, false],
    ];
    for (const [status, payload, code, pattern, reconnect] of cases) {
        await assert.rejects(setupFailure(status, payload).loadTasks(account), error => {
            assert.equal(error.status, status);
            assert.equal(error.code, code);
            assert.equal(error.reconnect, reconnect);
            assert.match(error.message, pattern);
            assert.doesNotMatch(error.message, /private-token/);
            return true;
        });
    }
});

test('missing authorization does not send a request; network errors are safe', async () => {
    const app = setup(() => { throw new Error('URL includes private-token'); });
    await assert.rejects(app.api.loadTasks({ sub: 'no-token' }), error => error.status === 401);
    assert.equal(app.requests.length, 0);
    await assert.rejects(app.api.loadTasks(account), error => error.code === 'NETWORK' && !error.message.includes('private-token'));
});

test('abort signal is forwarded and pre-aborted loads stop without requests', async () => {
    const controller = new AbortController();
    const app = setup(() => ({}));
    await app.api.loadTasks(account, { signal: controller.signal });
    assert.equal(app.requests[0].options.signal, controller.signal);
    controller.abort();
    await assert.rejects(app.api.loadTasks(account, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(app.requests.length, 1);
});

test('invalid dates and repeated page tokens fail rather than rendering incomplete data', async () => {
    const app = setup(() => ({ nextPageToken: 'same', items: [] }));
    await assert.rejects(app.api.loadEvents(account, '2026-02-30'), /valid date/);
    assert.equal(app.requests.length, 0);
    await assert.rejects(app.api.loadTasks(account), error => error.code === 'INVALID_PAGINATION');
    assert.equal(app.requests.length, 2);
});
