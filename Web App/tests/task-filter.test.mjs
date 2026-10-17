import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasksForDay } from '../src/state/task-filter.mjs';

const day = new Date(2026, 9, 17);
const due = date => date + 'T00:00:00.000Z';
const ids = tasks => tasks.map(task => task.id);
const tasks = Object.freeze([
    { id: 'overdue', status: 'needsAction', due: due('2026-10-16') },
    { id: 'today', status: 'needsAction', due: due('2026-10-17') },
    { id: 'future', status: 'needsAction', due: due('2026-10-18') },
    { id: 'undated', status: 'needsAction' },
    { id: 'completed-overdue', status: 'completed', due: due('2026-10-16') },
    { id: 'completed-today', status: 'completed', due: due('2026-10-17') },
    { id: 'completed-future', status: 'completed', due: due('2026-10-18') },
    { id: 'completed-undated', status: 'completed' },
].map(Object.freeze));

test('all mode preserves existing task order and defaults, with independent output array', () => {
    const result = filterTasksForDay(tasks, day);
    assert.deepEqual(result, tasks);
    assert.notEqual(result, tasks);
    result.forEach((task, index) => assert.equal(task, tasks[index]));
    assert.deepEqual(ids(filterTasksForDay(tasks, day, { mode: 'all', showCompleted: false })), ['overdue', 'today', 'future', 'undated']);
});

test('day mode selects only the selected calendar date, respecting completed visibility', () => {
    assert.deepEqual(ids(filterTasksForDay(tasks, day, { mode: 'day' })), ['today', 'completed-today']);
    assert.deepEqual(ids(filterTasksForDay(tasks, '2026-10-17', { mode: 'day', showCompleted: false })), ['today']);
});

test('day-overdue includes dated open overdue tasks and excludes undated or older completed tasks', () => {
    assert.deepEqual(ids(filterTasksForDay(tasks, day, { mode: 'day-overdue' })), ['overdue', 'today', 'completed-today']);
    assert.deepEqual(ids(filterTasksForDay(tasks, day, { mode: 'day-overdue', showCompleted: false })), ['overdue', 'today']);
    assert.deepEqual(ids(filterTasksForDay(tasks, '2026-10-18', { mode: 'day-overdue' })), ['overdue', 'today', 'future', 'completed-future']);
});

test('Google Tasks UTC-shaped due dates keep their calendar date in every local timezone', () => {
    const previousTimezone = process.env.TZ;
    try {
        for (const timezone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
            process.env.TZ = timezone;
            const selected = new Date(2026, 9, 17);
            const source = [
                { id: 'midnight', due: '2026-10-17T00:00:00.000Z' },
                { id: 'positive-offset', due: '2026-10-17T00:00:00+14:00' },
                { id: 'negative-offset', due: '2026-10-17T23:30:00-07:00' },
                { id: 'date-only', due: '2026-10-17' },
                { id: 'next-day', due: '2026-10-18T00:00:00.000Z' },
            ];
            assert.deepEqual(ids(filterTasksForDay(source, selected, { mode: 'day' })), ['midnight', 'positive-offset', 'negative-offset', 'date-only'], timezone);
        }
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test('malformed and impossible due dates are excluded from date filters safely', () => {
    const source = [
        { id: 'impossible', due: '2026-02-30T00:00:00.000Z' },
        { id: 'bad-month', due: '2026-13-01' },
        { id: 'bad-day', due: '2026-10-00' },
        { id: 'bad-time', due: '2026-10-17Tbad' },
        { id: 'not-a-date', due: 'today' },
        { id: 'numeric', due: 20261017 },
        { id: 'empty', due: '' },
        { id: 'null', due: null },
        { id: 'missing' },
        null,
    ];
    assert.deepEqual(ids(filterTasksForDay(source, day, { mode: 'day' })), []);
    assert.deepEqual(ids(filterTasksForDay(source, day, { mode: 'day-overdue' })), []);
    assert.equal(filterTasksForDay(source, day).length, source.length - 1);
    assert.deepEqual(filterTasksForDay(undefined, day), []);
});

test('invalid selected dates do not accidentally match or discard all-mode tasks', () => {
    for (const selected of [new Date(NaN), '2026-02-29', '2026-02-30', '2026-13-01', 'invalid', undefined, null]) {
        assert.deepEqual(filterTasksForDay(tasks, selected, { mode: 'day' }), []);
        assert.deepEqual(filterTasksForDay(tasks, selected, { mode: 'day-overdue' }), []);
        assert.deepEqual(filterTasksForDay(tasks, selected), tasks);
    }
    assert.deepEqual(ids(filterTasksForDay([{ id: 'leap', due: due('2028-02-29') }], '2028-02-29', { mode: 'day' })), ['leap']);
});

test('unknown modes retain backwards compatible all-task behavior without source mutation', () => {
    const before = JSON.stringify(tasks);
    assert.deepEqual(filterTasksForDay(tasks, day, { mode: 'future-option' }), tasks);
    filterTasksForDay(tasks, day, { mode: 'day-overdue' });
    filterTasksForDay(tasks, day, { mode: 'day', showCompleted: false });
    assert.equal(JSON.stringify(tasks), before);
});
