const MODES = new Set(['all', 'day', 'day-overdue']);

function validDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

function selectedDateKey(day) {
    if (day instanceof Date) {
        if (!Number.isFinite(day.getTime())) return null;
        return validDateKey([
            String(day.getFullYear()).padStart(4, '0'),
            String(day.getMonth() + 1).padStart(2, '0'),
            String(day.getDate()).padStart(2, '0'),
        ].join('-'));
    }
    return validDateKey(day);
}

function taskDateKey(due) {
    if (typeof due !== 'string') return null;
    if (due.length !== 10 && (due[10] !== 'T' || !Number.isFinite(Date.parse(due)))) return null;
    // Google Tasks dates are encoded as UTC-shaped timestamps. The prefix is the
    // calendar date, even when converting the timestamp would change local day.
    return validDateKey(due.slice(0, 10));
}

/**
 * Select tasks without changing the source array or task objects.
 * day-overdue includes incomplete tasks due on/before the selected date.
 * Undated tasks and completed overdue tasks are omitted. Completed tasks due on
 * the selected date remain available when showCompleted is on.
 * Malformed due dates are excluded from date modes; an invalid day returns [].
 */
export function filterTasksForDay(tasks, day, { mode = 'all', showCompleted = true } = {}) {
    if (!Array.isArray(tasks)) return [];
    const selected = selectedDateKey(day);
    const filter = MODES.has(mode) ? mode : 'all';
    return tasks.filter(task => {
        if (!task || typeof task !== 'object') return false;
        const completed = task.status === 'completed';
        if (completed && !showCompleted) return false;
        if (filter === 'all') return true;
        if (!selected) return false;
        const due = taskDateKey(task.due);
        if (filter === 'day') return due === selected;
        return due !== null && (completed ? due === selected : due <= selected);
    });
}
