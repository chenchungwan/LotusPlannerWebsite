import { createTimeline } from '../components/timeline.mjs?v=logs-1';
import { createEventList } from '../components/event-list.mjs?v=logs-1';
import { createAccountTasks, createCompactTasks } from '../components/account-tasks.mjs?v=logs-1';
import { createPlaceholder, LOG_TYPES } from '../components/placeholders.mjs?v=logs-1';
import { createLogs } from '../components/logs.mjs?v=logs-1';

// Factories and palette metadata share one extension point for future components.
export function createWidgetRegistry() {
    const registry = new Map([
        ['timeline', createTimeline], ['events-list', createEventList],
        ['account-tasks', createAccountTasks], ['compact-tasks', createCompactTasks],
    ]);
    for (const type of ['journal', 'goals', 'weight-graph']) {
        registry.set(type, config => createPlaceholder({ ...config, type }));
    }
    for (const type of ['logs-group', 'log']) registry.set(type, config => createLogs({ ...config, type }));
    return registry;
}

export function getWidgetCatalog(accounts = [], customLogs = []) {
    const entry = (key, type, title, category, description, size, options = {}, placeholder = false) => ({ key, type, title, category, description, size, options, placeholder });
    const logEntries = LOG_TYPES.map(log => entry('log-' + log.id, 'log', log.name, 'Logs', log.id === 'workout-streak' ? 'Workout days in the last 7 days' : 'Track your daily ' + log.name.toLowerCase(), { width: 280, height: 280 }, { logType: log.id }));
    return [
        entry('timeline', 'timeline', 'Timeline', 'Calendar', 'Events on a 24-hour timeline', { width: 300, height: 640 }, { accountIds: 'all' }),
        entry('events-list', 'events-list', 'Events list', 'Calendar', 'The selected day in a simple list', { width: 380, height: 440 }, { accountIds: 'all' }),
        ...accounts.flatMap(account => [
            entry('tasks-' + account.sub, 'account-tasks', account.isPrimary ? 'Primary Tasks' : 'Second Account Tasks', 'Tasks', 'Grouped by list · ' + (account.email || 'Google Tasks'), { width: 380, height: 420 }, { accountId: account.sub }),
            entry('compact-' + account.sub, 'compact-tasks', account.isPrimary ? 'Primary Tasks · compact' : 'Second Account Tasks · compact', 'Tasks', 'One compact list · ' + (account.email || 'Google Tasks'), { width: 340, height: 340 }, { accountId: account.sub }),
        ]),
        entry('journal', 'journal', 'Journal', 'Journal', 'Placeholder · daily journal', { width: 420, height: 360 }, {}, true),
        entry('logs-group', 'logs-group', 'All logs', 'Logs', 'Built-in logs and custom checklists together', { width: 420, height: 500 }),
        ...logEntries,
        ...customLogs.filter(log => log.enabled !== false).map(log => entry('custom-log-' + log.id, 'log', log.name, 'Custom logs', 'Daily checklist · stored with your logs', { width: 280, height: 280 }, { logType: 'custom', customLogId: log.id, customLogName: log.name })),
        entry('goals-vertical', 'goals', 'Goals · vertical bars', 'Goals', 'Placeholder · vertical progress bars', { width: 320, height: 340 }, { orientation: 'vertical' }, true),
        entry('goals-horizontal', 'goals', 'Goals · horizontal bars', 'Goals', 'Placeholder · horizontal progress bars', { width: 380, height: 280 }, { orientation: 'horizontal' }, true),
        ...[['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']].map(([period, label]) => entry('weight-' + period, 'weight-graph', label + ' weight graph', 'Weight graphs', 'Placeholder · ' + label.toLowerCase() + ' weight view', { width: 420, height: 300 }, { period }, true)),
    ];
}

export function getWidgetLabel(widget, accounts = [], customLogs = []) {
    if (widget.options?.title) return widget.options.title;
    const catalog = getWidgetCatalog(accounts, customLogs);
    const options = widget.options || {};
    const matching = catalog.find(item => item.type === widget.type &&
        (widget.type !== 'log' || (item.options.logType === options.logType && (options.logType !== 'custom' || item.options.customLogId === options.customLogId))) &&
        (widget.type !== 'goals' || item.options.orientation === (options.orientation || 'vertical')) &&
        (widget.type !== 'weight-graph' || item.options.period === (options.period || 'week')) &&
        (!['account-tasks', 'compact-tasks'].includes(widget.type) || item.options.accountId === options.accountId));
    return matching?.title || ({ 'account-tasks': 'Tasks', 'compact-tasks': 'Compact tasks', log: options.customLogName || 'Custom log' })[widget.type] || widget.type;
}
