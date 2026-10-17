import { createTimeline } from '../components/timeline.mjs';
import { createAccountTasks } from '../components/account-tasks.mjs';

// Add a component factory here and its serializable options in layout-model.mjs.
export function createWidgetRegistry() {
    return new Map([
        ['timeline', createTimeline],
        ['account-tasks', createAccountTasks],
    ]);
}
