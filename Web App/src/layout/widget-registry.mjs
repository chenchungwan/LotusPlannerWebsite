import { createTimeline } from '../components/timeline.mjs?v=canvas-1';
import { createAccountTasks } from '../components/account-tasks.mjs?v=canvas-1';

// Component factories and palette metadata share this extension point.
export function createWidgetRegistry() {
    return new Map([
        ['timeline', createTimeline],
        ['account-tasks', createAccountTasks],
    ]);
}

export function getWidgetCatalog(accounts = []) {
    return [
        { key: 'timeline', type: 'timeline', title: 'Timeline', description: 'Events for the selected day', size: { width: 300, height: 640 }, options: { accountIds: 'all' } },
        ...accounts.map(account => ({
            key: 'tasks-' + account.sub, type: 'account-tasks',
            title: account.isPrimary ? 'Primary Tasks' : 'Second Account Tasks',
            description: account.email || account.name || 'Google Tasks', size: { width: 380, height: 420 },
            options: { accountId: account.sub },
        })),
    ];
}
