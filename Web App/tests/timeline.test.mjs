import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTimedEvents } from '../src/components/timeline.mjs';

function event(id, start, end) {
    return { id, title: id, start: { dateTime: start }, end: { dateTime: end } };
}

test('timeline clips overnight events, skips unrelated days and retains original event data', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
        const source = [
            event('overnight', '2026-10-15T23:00:00-07:00', '2026-10-16T01:30:00-07:00'),
            event('late', '2026-10-16T23:30:00-07:00', '2026-10-17T02:00:00-07:00'),
            event('yesterday', '2026-10-15T11:00:00-07:00', '2026-10-15T12:00:00-07:00'),
            event('tomorrow', '2026-10-17T11:00:00-07:00', '2026-10-17T12:00:00-07:00'),
        ];
        const before = JSON.stringify(source);
        const result = layoutTimedEvents(source, new Date(2026, 9, 16));
        assert.deepEqual(result.map(item => [item.event.id, item.top, item.bottom]), [
            ['overnight', 0, 90], ['late', 1410, 1440],
        ]);
        assert.equal(JSON.stringify(source), before);
        assert.equal(result[0].event, source[0]);
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
});

test('timeline preserves real events in the repeated daylight-saving hour', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
        const result = layoutTimedEvents([
            event('fall-back', '2026-11-01T01:45:00-07:00', '2026-11-01T01:15:00-08:00'),
        ], new Date(2026, 10, 1));
        assert.equal(result.length, 1);
        assert.equal(result[0].top, 105);
        assert.equal(result[0].bottom, 135);
        assert.equal((result[0].end - result[0].start) / 60000, 30);
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
});

test('overlap lanes are shared across a connected group and released for following events', () => {
    const result = layoutTimedEvents([
        event('long', '2026-10-16T09:00:00', '2026-10-16T11:00:00'),
        event('first', '2026-10-16T09:15:00', '2026-10-16T10:00:00'),
        event('reuses-lane', '2026-10-16T10:00:00', '2026-10-16T10:30:00'),
        event('next-group', '2026-10-16T11:00:00', '2026-10-16T12:00:00'),
    ].map(item => ({ event: item, account: { sub: 'one' } })), new Date(2026, 9, 16));
    assert.deepEqual(result.map(item => [item.event.id, item.lane, item.lanes]), [
        ['long', 0, 2], ['first', 1, 2], ['reuses-lane', 1, 2], ['next-group', 0, 1],
    ]);
    assert.equal(result[0].account.sub, 'one');
});

test('malformed, cancelled, all-day and nonpositive events do not create timed blocks', () => {
    const result = layoutTimedEvents([
        { id: 'all-day', start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
        { ...event('cancelled', '2026-10-16T09:00:00', '2026-10-16T10:00:00'), status: 'cancelled' },
        event('invalid', 'invalid', 'invalid'),
        event('backwards', '2026-10-16T10:00:00', '2026-10-16T09:00:00'),
        event('zero', '2026-10-16T10:00:00', '2026-10-16T10:00:00'),
        { id: 'missing-end', start: { dateTime: '2026-10-16T12:00:00' } },
        null,
    ], new Date(2026, 9, 16));
    assert.equal(result.length, 1);
    assert.equal(result[0].event.id, 'missing-end');
    assert.equal(result[0].bottom - result[0].top, 30);
});
