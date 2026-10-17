import { renderIcons, localDate } from '../ui/dom.mjs?v=pocky-1';

// The app frame stays outside user-designed content. It emits actions, not data requests.
export function createPlannerChrome({ root, primary, preferences, actions }) {
    const $ = id => root.querySelector('[id="' + id + '"]');
    const listeners = new AbortController();
    const on = (id, event, handler) => $(id).addEventListener(event, handler, { signal: listeners.signal });
    const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    let context;
    renderIcons(root);
    function setSidebar(expanded) {
        $('planner-shell').classList.toggle('sidebar-expanded', expanded);
        $('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
        $('sidebar-toggle').setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        $('sidebar-toggle').title = expanded ? 'Collapse sidebar' : 'Expand sidebar';
        preferences.set('lotus.sidebarExpanded', String(expanded));
    }
    setSidebar(preferences.get('lotus.sidebarExpanded') === 'true');
    on('sidebar-toggle', 'click', () => setSidebar($('sidebar-toggle').getAttribute('aria-expanded') !== 'true'));
    on('sign-out', 'click', actions.signOut);
    $('primary-name').textContent = primary.name || primary.email;
    $('primary-avatar').textContent = (primary.name || primary.email || 'L').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    $('primary-avatar').title = primary.email;
    function offsetDay(offset) {
        const day = context.day;
        actions.changeDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset));
    }
    on('previous-day', 'click', () => offsetDay(-1));
    on('next-day', 'click', () => offsetDay(1));
    on('today', 'click', () => actions.changeDay(new Date()));
    on('planner-date', 'change', event => {
        if (!event.target.value) return;
        const parts = event.target.value.split('-').map(Number);
        const next = new Date(parts[0], parts[1] - 1, parts[2]);
        if (Number.isFinite(next.getTime())) actions.changeDay(next);
    });
    on('refresh', 'click', actions.refresh);
    on('design-layout', 'click', () => actions.designLayout());
    on('completed-toggle', 'click', actions.toggleCompleted);
    return {
        update(next) {
            context = next;
            $('date-label').textContent = dateFormat.format(next.day);
            $('planner-date').value = localDate(next.day);
            const label = next.showCompleted ? 'Hide completed tasks' : 'Show completed tasks';
            $('completed-toggle').setAttribute('aria-label', label);
            $('completed-toggle').setAttribute('aria-pressed', String(next.showCompleted));
            $('completed-toggle').title = label;
            $('refresh').disabled = next.loading;
            $('planner-status').hidden = !next.loading && !next.notice;
            $('planner-status').textContent = next.loading ? 'Refreshing your calendars and tasks…' : next.notice;
        },
        destroy() { listeners.abort(); },
    };
}
