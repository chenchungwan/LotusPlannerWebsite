import { el, icon } from '../ui/dom.mjs?v=canvas-1';
import { filterTasksForDay } from '../state/task-filter.mjs?v=canvas-1';

let nextInstance = 0;

function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dueDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    // Tasks stores a calendar date in a UTC-shaped string. Keep that date locally.
    const date = value.slice(0, 10);
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
    return { date, parsed };
}

/** A read-only Google Tasks panel. Its owner supplies data and account actions. */
export function createAccountTasks({ id, options = {}, actions = {} }) {
    const element = el('section', 'tasks-panel planner-widget');
    element.hidden = true;
    element.dataset.widgetId = String(id);
    element.dataset.component = 'account-tasks';
    const heading = el('div', 'column-heading tasks-heading');
    const title = el('h2');
    title.id = 'account-tasks-title-' + (++nextInstance);
    element.setAttribute('aria-labelledby', title.id);
    const email = el('span', 'account-email');
    heading.append(title, email);
    const lists = el('div', 'task-lists');
    element.append(heading, lists);

    let destroyed = false;
    let currentAccount = null;
    let currentContext = {};
    let scrollTop = 0;
    let hadLoadedTasks = false;

    function reconnectButton() {
        const button = el('button', 'inline-reconnect', 'Reconnect');
        button.type = 'button';
        button.disabled = !currentContext.googleReady || currentContext.linking;
        button.addEventListener('click', () => {
            if (!destroyed && currentAccount && currentContext.googleReady && !currentContext.linking) {
                // Keep Google popup authorization in the original click call stack.
                actions.reconnect(currentAccount);
            }
        });
        return button;
    }

    function errorState(error) {
        const box = el('div', 'empty-state');
        box.append(
            el('strong', '', error.reconnect ? 'Reconnect your account' : 'Couldn’t load tasks'),
            el('span', '', error.message || 'Please try refreshing.'),
        );
        if ((error.reconnect || error.code === 'FORBIDDEN') && typeof actions.reconnect === 'function') {
            box.append(reconnectButton());
        }
        return box;
    }

    function taskItem(task, today) {
        const completed = task.status === 'completed';
        const row = el('li', 'task-item' + (completed ? ' completed' : ''));
        const mark = el('span', 'task-status');
        mark.setAttribute('role', 'img');
        mark.setAttribute('aria-label', completed ? 'Completed' : 'Incomplete');
        if (completed) mark.innerHTML = icon('check');
        const copy = el('div', 'task-copy');
        const text = el('span', 'task-title', task.title || 'Untitled task');
        text.title = task.title || 'Untitled task';
        copy.append(text);
        const due = !completed && dueDate(task.due);
        if (due) {
            copy.append(el('span', 'task-due' + (due.date < today ? ' overdue' : ''),
                'Due ' + due.parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
        }
        if (task.parent) copy.style.paddingLeft = '10px';
        row.append(mark, copy);
        return row;
    }

    function update(context = {}) {
        if (destroyed) return;
        if (hadLoadedTasks && !element.hidden) scrollTop = lists.scrollTop;
        currentContext = context;
        const account = (context.accounts || []).find(item => item.sub === options.accountId);
        hadLoadedTasks = false;
        if (!account) {
            currentAccount = null;
            element.hidden = true;
            lists.setAttribute('aria-busy', 'false');
            lists.replaceChildren();
            return;
        }
        if (element.dataset.account && element.dataset.account !== account.sub) scrollTop = 0;
        currentAccount = account;
        element.dataset.account = account.sub;
        element.hidden = false;
        element.classList.toggle('secondary', !account.isPrimary);
        title.textContent = options.title || (account.isPrimary ? 'Primary Tasks' : 'Second Account Tasks');
        email.textContent = account.email || '';
        email.title = account.email || '';
        const state = context.results?.get(account.sub) || {};
        const showCompleted = typeof options.showCompleted === 'boolean' ? options.showCompleted : Boolean(context.showCompleted);
        const dateFilter = options.dateFilter || context.taskDateFilter || 'all';
        const taskListIds = Array.isArray(options.taskListIds) ? new Set(options.taskListIds) : null;
        lists.setAttribute('aria-busy', String(!account.needsReconnect && !state.tasks && !state.tasksError));
        lists.replaceChildren();
        if (account.needsReconnect) {
            lists.append(errorState({ reconnect: true, message: 'Reconnect ' + (account.email || 'this account') + ' to see its calendars and tasks.' }));
        } else if (state.tasksError) {
            lists.append(errorState(state.tasksError));
        } else if (!state.tasks) {
            for (let i = 0; i < 3; i++) lists.append(el('div', 'loading-skeleton'));
            const loading = el('p', 'column-caption', 'Loading Google Tasks…');
            loading.setAttribute('role', 'status');
            lists.append(loading);
        } else {
            hadLoadedTasks = true;
            const today = localDate(new Date());
            let shown = 0;
            state.tasks.forEach(list => {
                if (taskListIds && !taskListIds.has(list.id)) return;
                const tasks = filterTasksForDay(list.tasks, context.day, { mode: dateFilter, showCompleted });
                if (!tasks.length) return;
                shown += tasks.length;
                const card = el('section', 'task-card');
                card.append(el('h3', '', list.title || 'Tasks'));
                const items = el('ul', 'task-items');
                tasks.forEach(task => items.append(taskItem(task, today)));
                card.append(items);
                lists.append(card);
            });
            if (!shown) {
                const box = el('div', 'empty-state');
                let message = showCompleted ? 'No tasks in this Google account yet.' : 'No incomplete tasks. Show completed tasks using the eye above.';
                if (taskListIds) message = showCompleted ? 'No tasks in the selected lists.' : 'No incomplete tasks in the selected lists.';
                else if (options.showCompleted === false) message = 'No incomplete tasks in this Google account.';
                if (dateFilter === 'day' || dateFilter === 'day-overdue') {
                    const selectedDay = context.day instanceof Date && Number.isFinite(context.day.getTime())
                        ? context.day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'this day';
                    const scope = taskListIds ? ' in the selected lists' : '';
                    const taskKind = showCompleted ? 'tasks' : 'incomplete tasks';
                    message = dateFilter === 'day'
                        ? 'No ' + taskKind + ' due on ' + selectedDay + scope + '.'
                        : 'No ' + taskKind + ' due by ' + selectedDay + scope + '.';
                }
                box.append(el('strong', '', showCompleted ? 'A little breathing room.' : 'All caught up.'), el('span', '', message));
                lists.append(box);
            }
        }
        // Keep the desired position while refresh placeholders temporarily shorten the list.
        lists.scrollTop = scrollTop;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        currentAccount = null;
        currentContext = {};
        element.replaceChildren();
        element.remove();
    }

    return { element, update, destroy };
}
