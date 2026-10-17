import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventList, selectDayEvents } from '../src/components/event-list.mjs';

const primary = { sub: 'primary', email: 'one@example.com', isPrimary: true };
const secondary = { sub: 'secondary', email: 'two@example.com', isPrimary: false };
function timed(id, start, end, extra = {}) { return { id, googleId: id, calendarId: 'calendar', title: id, start: { dateTime: start }, end: { dateTime: end }, ...extra }; }
function allDay(id, start, end) { return { id, googleId: id, calendarId: 'calendar', title: id, start: { date: start }, end: { date: end } }; }
function withTimezone(t, timezone = 'America/Los_Angeles') {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
}

test('all-day events precede timed events and their end date is exclusive', t => {
    withTimezone(t);
    const records = [
        timed('meeting', '2026-10-17T09:00:00-07:00', '2026-10-17T10:00:00-07:00'),
        allDay('today', '2026-10-17', '2026-10-18'),
        allDay('spanning', '2026-10-16', '2026-10-19'),
        allDay('ended', '2026-10-16', '2026-10-17'),
        allDay('tomorrow', '2026-10-18', '2026-10-19'),
        allDay('invalid', '2026-02-30', '2026-03-03'),
    ];
    const before = JSON.stringify(records);
    const result = selectDayEvents(records, new Date(2026, 9, 17));
    assert.deepEqual(result.map(record => record.event.id), ['spanning', 'today', 'meeting']);
    assert.equal(result[0].continuesBefore, true);
    assert.equal(result[0].continuesAfter, true);
    assert.equal(result[1].continuesBefore, false);
    assert.equal(result[1].continuesAfter, false);
    assert.equal(result[0].event, records[2]);
    assert.equal(JSON.stringify(records), before);
});

test('timed events clip overnight intervals and exclude events touching the outside of the day', t => {
    withTimezone(t);
    const result = selectDayEvents([
        timed('prior', '2026-10-16T23:30:00-07:00', '2026-10-17T01:00:00-07:00'),
        timed('following', '2026-10-17T23:00:00-07:00', '2026-10-18T02:00:00-07:00'),
        timed('ends-at-start', '2026-10-16T23:00:00-07:00', '2026-10-17T00:00:00-07:00'),
        timed('starts-at-end', '2026-10-18T00:00:00-07:00', '2026-10-18T01:00:00-07:00'),
        timed('zero', '2026-10-17T12:00:00-07:00', '2026-10-17T12:00:00-07:00'),
        timed('invalid', 'invalid', 'invalid'),
        timed('cancelled', '2026-10-17T09:00:00-07:00', '2026-10-17T10:00:00-07:00', { status: 'cancelled' }),
    ], new Date(2026, 9, 17));
    assert.deepEqual(result.map(record => record.event.id), ['prior', 'following']);
    assert.equal(result[0].displayStart.getTime(), new Date(2026, 9, 17).getTime());
    assert.equal(result[0].start.getDate(), 16);
    assert.equal(result[0].continuesBefore, true);
    assert.equal(result[1].displayEnd.getTime(), new Date(2026, 9, 18).getTime());
    assert.equal(result[1].continuesAfter, true);
});

test('sorting uses actual instants across calendar time zones and the repeated DST hour', t => {
    withTimezone(t);
    const result = selectDayEvents([
        timed('second-hour', '2026-11-01T01:15:00-08:00', '2026-11-01T01:45:00-08:00'),
        timed('fall-back', '2026-11-01T01:45:00-07:00', '2026-11-01T01:15:00-08:00'),
        timed('utc-early', '2026-11-01T08:00:00Z', '2026-11-01T08:30:00Z'),
        timed('last-hour', '2026-11-01T23:00:00-08:00', '2026-11-02T01:00:00-08:00'),
    ], new Date(2026, 10, 1));
    assert.deepEqual(result.map(record => record.event.id), ['utc-early', 'fall-back', 'second-hour', 'last-hour']);
    assert.equal((result[1].end - result[1].start) / 60000, 30);
    assert.equal(result[3].displayEnd.getTime(), new Date('2026-11-02T08:00:00Z').getTime());
    const spring = selectDayEvents([timed('spring', '2026-03-08T00:00:00-08:00', '2026-03-09T00:00:00-07:00')], new Date(2026, 2, 8));
    assert.equal((spring[0].displayEnd - spring[0].displayStart) / 3600000, 23);
});

test('shared calendar events deduplicate across accounts while distinct calendars and IDs remain', t => {
    withTimezone(t);
    const shared = timed('shared', '2026-10-17T09:00:00-07:00', '2026-10-17T10:00:00-07:00');
    const result = selectDayEvents([
        { event: shared, account: primary },
        { event: { ...shared, id: 'account-specific-normalized-id' }, account: secondary },
        { event: { ...shared, calendarId: 'other-calendar' }, account: secondary },
        { event: { ...shared, id: 'different', googleId: 'different' }, account: primary },
    ], new Date(2026, 9, 17));
    assert.equal(result.length, 3);
    assert.equal(result.filter(record => record.event.calendarId === 'calendar' && record.event.googleId === 'shared').length, 1);
    assert.equal(result[0].account, primary);
});

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
        this.scrollTop = 0;
        this.style = { setProperty() {} };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    append(...nodes) { nodes.forEach(node => { node.remove(); node.parentNode = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
function dom(t) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tagName => new FakeElement(tagName) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}
function nodes(root) { return [root, ...root.children.flatMap(nodes)]; }
function byClass(root, className) { return nodes(root).filter(node => (node.className || '').split(/\s+/).includes(className)); }
function text(root) { return nodes(root).map(node => node.textContent).join(' '); }
function context(results, extra = {}) { return { day: new Date(2026, 9, 17), accounts: [primary, secondary], results, googleReady: true, linking: false, ...extra }; }

test('partial loading and account errors preserve available events and scoped reconnection controls', t => {
    withTimezone(t); dom(t);
    let reconnected;
    const widget = createEventList({ id: 'events', actions: { reconnect: account => { reconnected = account; } } });
    const results = new Map([[primary.sub, { events: [timed('Available', '2026-10-17T09:00:00-07:00', '2026-10-17T10:00:00-07:00')] }], [secondary.sub, {}]]);
    widget.update(context(results));
    assert.equal(byClass(widget.element, 'event-list-item').length, 1);
    assert.match(text(widget.element), /Loading two@example.com/);
    assert.equal(byClass(widget.element, 'events-list')[0].getAttribute('aria-busy'), 'true');
    assert.equal(byClass(widget.element, 'event-list-empty')[0].hidden, true);
    results.set(secondary.sub, { eventsError: { reconnect: true, message: 'Reconnect this account.' } });
    widget.update(context(results));
    assert.equal(byClass(widget.element, 'event-list-item').length, 1);
    assert.equal(byClass(widget.element, 'events-list')[0].getAttribute('aria-busy'), 'false');
    byClass(widget.element, 'inline-reconnect')[0].click();
    assert.equal(reconnected, secondary);
    widget.update(context(results, { linking: true }));
    assert.equal(byClass(widget.element, 'inline-reconnect')[0].disabled, true);
    widget.destroy();
    assert.equal(widget.element.children.length, 0);
    widget.update(context(results));
    assert.equal(widget.element.children.length, 0);
});

test('instances have unique headings, filter accounts independently and render event details as plain text', t => {
    withTimezone(t); dom(t);
    const first = createEventList({ id: 'same-id', options: { accountIds: [primary.sub] } });
    const second = createEventList({ id: 'same-id', options: { accountIds: [secondary.sub], title: 'Home events' } });
    const results = new Map([
        [primary.sub, { events: [timed('work', '2026-10-17T09:00:00-07:00', '2026-10-17T10:00:00-07:00', { title: '<img src=x onerror=alert(1)>', location: '<b>Office</b>', calendarTitle: 'Work' })] }],
        [secondary.sub, { events: [] }],
    ]);
    first.update(context(results)); second.update(context(results));
    assert.notEqual(first.element.getAttribute('aria-labelledby'), second.element.getAttribute('aria-labelledby'));
    assert.equal(first.element.dataset.component, 'event-list');
    assert.equal(byClass(first.element, 'event-list-item').length, 1);
    assert.equal(byClass(second.element, 'event-list-item').length, 0);
    assert.equal(byClass(first.element, 'event-list-title')[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(byClass(first.element, 'event-list-location')[0].textContent, '<b>Office</b>');
    assert.equal(byClass(first.element, 'event-list-caption')[0].textContent, 'Work · one@example.com');
    assert.match(text(second.element), /No events scheduled for this day/);
    const list = byClass(first.element, 'events-list')[0]; list.scrollTop = 250;
    first.update(context(results));
    assert.equal(list.scrollTop, 250);
    first.destroy();
    assert.match(text(second.element), /Home events/);
});

test('overnight events display clipped times and explicit continuation labels', t => {
    withTimezone(t); dom(t);
    const widget = createEventList({ id: 'events' });
    widget.update(context(new Map([[primary.sub, { events: [
        timed('overnight', '2026-10-16T23:00:00-07:00', '2026-10-18T02:00:00-07:00'),
    ] }]]), { accounts: [primary] }));
    assert.match(byClass(widget.element, 'event-list-time')[0].textContent, /midnight/);
    assert.equal(byClass(widget.element, 'event-list-continuation')[0].textContent, 'Continues from previous day · Continues tomorrow');
    widget.update(context(new Map(), { accounts: [] }));
    assert.match(text(widget.element), /No linked accounts in this events list/);
});

test('loading and failed accounts never show a misleading empty-calendar message', t => {
    withTimezone(t); dom(t);
    const widget = createEventList({ id: 'events', actions: { reconnect() {} } });
    const results = new Map([[primary.sub, { eventsError: { code: 'FORBIDDEN', message: 'Calendar access denied.' } }], [secondary.sub, {}]]);
    widget.update(context(results));
    assert.equal(byClass(widget.element, 'event-list-empty')[0].hidden, true);
    assert.match(text(widget.element), /Calendar access denied/);
    assert.doesNotMatch(text(widget.element), /No events scheduled/);
    results.set(secondary.sub, { events: [] });
    widget.update(context(results));
    assert.equal(byClass(widget.element, 'event-list-empty')[0].hidden, false);
    assert.equal(byClass(widget.element, 'event-list-empty')[0].getAttribute('role'), 'status');
    assert.match(text(widget.element), /Calendar events aren’t available/);
    assert.doesNotMatch(text(widget.element), /A clear calendar/);
});
