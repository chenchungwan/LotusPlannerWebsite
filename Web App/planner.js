(function () {
    'use strict';
    const auth = window.LotusAuth;
    const primary = auth.requireSession();
    if (!primary) return;
    document.body.hidden = false;
    const $ = id => document.getElementById(id);
    const icons = {
        sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
        calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h1m3 0h1m3 0h1M8 17h1m3 0h1"/>',
        checklist: '<path d="m3 6 1.5 1.5L7 4m3 2h11M3 12h4m3 0h11M3 18h4m3 0h11"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
        book: '<path d="M12 5v16M12 5C8 2 3 4 3 4v15s5-2 9 2c4-4 9-2 9-2V4s-5-2-9 1Z"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
        settings: '<path d="m9 3-.8 2.1-2.2.4L4.5 8l1 2-.5 2 .5 2-1 2L6 18.5l2.2.4L9 21h6l.8-2.1 2.2-.4 1.5-2.5-1-2 .5-2-.5-2 1-2L18 5.5l-2.2-.4L15 3Z"/><circle cx="12" cy="12" r="3"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
        logout: '<path d="M9 4H4v16h5m4-4 4-4-4-4m-5 4h13"/>',
        left: '<path d="m15 5-7 7 7 7"/>', right: '<path d="m9 5 7 7-7 7"/>',
        refresh: '<path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5m-4 9a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
        eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
        plus: '<path d="M12 4v16M4 12h16"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
    };
    function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'; }
    document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function storageGet(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
    function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (error) { /* Preferences are optional. */ } }
    function localDate(date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); }
    let day = new Date();
    day.setHours(0, 0, 0, 0);
    let accounts = [];
    let results = new Map();
    let generation = 0;
    let controller;
    let googleReady = false;
    let linking = false;
    let showCompleted = storageGet('lotus.showCompleted') !== 'false';
    let initialScroll = true;
    let lastAccountState = '';
    const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    function setSidebar(expanded) {
        $('planner-shell').classList.toggle('sidebar-expanded', expanded);
        $('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
        $('sidebar-toggle').setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        $('sidebar-toggle').title = expanded ? 'Collapse sidebar' : 'Expand sidebar';
        storageSet('lotus.sidebarExpanded', String(expanded));
    }
    setSidebar(storageGet('lotus.sidebarExpanded') === 'true');
    $('sidebar-toggle').addEventListener('click', () => setSidebar($('sidebar-toggle').getAttribute('aria-expanded') !== 'true'));
    $('sign-out').addEventListener('click', () => auth.signOut());
    $('primary-name').textContent = primary.name || primary.email;
    $('primary-avatar').textContent = (primary.name || primary.email || 'L').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    $('primary-avatar').title = primary.email;
    $('timezone-label').textContent = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName').value;

    function updateDate() { $('date-label').textContent = dateFormat.format(day); $('planner-date').value = localDate(day); }
    function changeDay(next) { day = next; day.setHours(0, 0, 0, 0); initialScroll = true; updateDate(); load(); }
    $('previous-day').addEventListener('click', () => changeDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1)));
    $('next-day').addEventListener('click', () => changeDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)));
    $('today').addEventListener('click', () => changeDay(new Date()));
    $('planner-date').addEventListener('change', event => {
        if (!event.target.value) return;
        const parts = event.target.value.split('-').map(Number);
        const next = new Date(parts[0], parts[1] - 1, parts[2]);
        if (Number.isFinite(next.getTime())) changeDay(next);
    });
    $('refresh').addEventListener('click', () => load());
    function updateCompletedButton() {
        const label = showCompleted ? 'Hide completed tasks' : 'Show completed tasks';
        $('completed-toggle').setAttribute('aria-label', label);
        $('completed-toggle').setAttribute('aria-pressed', String(showCompleted));
        $('completed-toggle').title = label;
    }
    $('completed-toggle').addEventListener('click', () => {
        showCompleted = !showCompleted; storageSet('lotus.showCompleted', String(showCompleted)); updateCompletedButton(); renderTasks();
    });
    updateCompletedButton();

    function accountLabel(account) { return account.isPrimary ? 'Primary Tasks' : 'Second Account Tasks'; }
    function stateKey() { return auth.getAccounts().map(account => account.sub + ':' + account.needsReconnect).join('|'); }
    function reconnectButton(account) {
        const button = el('button', 'inline-reconnect', 'Reconnect');
        button.disabled = !googleReady || linking;
        button.addEventListener('click', () => reconnect(account));
        return button;
    }
    function errorState(account, error) {
        const box = el('div', 'empty-state');
        box.append(el('strong', '', error.reconnect ? 'Reconnect your account' : 'Couldn’t load tasks'), el('span', '', error.message || 'Please try refreshing.'));
        if (error.reconnect || error.code === 'FORBIDDEN') box.append(reconnectButton(account));
        return box;
    }
    function renderTasks() {
        const scrollPositions = new Map([...$('account-columns').querySelectorAll('.tasks-panel')].map(panel => [panel.dataset.account, panel.querySelector('.task-lists').scrollTop]));
        $('account-columns').replaceChildren();
        $('account-columns').style.setProperty('--account-count', accounts.length || 1);
        accounts.forEach(account => {
            const state = results.get(account.sub) || {};
            const section = el('section', 'tasks-panel' + (account.isPrimary ? '' : ' secondary'));
            section.dataset.account = account.sub;
            const heading = el('div', 'column-heading tasks-heading');
            const title = el('h2', '', accountLabel(account)); title.id = 'tasks-' + account.sub;
            section.setAttribute('aria-labelledby', title.id);
            heading.append(title, el('span', 'account-email', account.email));
            const lists = el('div', 'task-lists');
            lists.setAttribute('aria-busy', String(!account.needsReconnect && !state.tasks && !state.tasksError));
            if (account.needsReconnect) {
                lists.append(errorState(account, { reconnect: true, message: 'Reconnect ' + account.email + ' to see its calendars and tasks.' }));
            } else if (state.tasksError) {
                lists.append(errorState(account, state.tasksError));
            } else if (!state.tasks) {
                for (let i = 0; i < 3; i++) lists.append(el('div', 'loading-skeleton'));
                const loading = el('p', 'column-caption', 'Loading Google Tasks…'); loading.setAttribute('role', 'status'); lists.append(loading);
            } else {
                let shown = 0;
                state.tasks.forEach(list => {
                    const tasks = list.tasks.filter(task => showCompleted || task.status !== 'completed');
                    if (!tasks.length) return;
                    shown += tasks.length;
                    const card = el('section', 'task-card'); card.append(el('h3', '', list.title));
                    const items = el('ul', 'task-items');
                    tasks.forEach(task => {
                        const completed = task.status === 'completed';
                        const row = el('li', 'task-item' + (completed ? ' completed' : ''));
                        const mark = el('span', 'task-status'); mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', completed ? 'Completed' : 'Incomplete');
                        if (completed) mark.innerHTML = icon('check');
                        const copy = el('div', 'task-copy');
                        const text = el('span', 'task-title', task.title); text.title = task.title;
                        copy.append(text);
                        if (task.due && !completed) {
                            // Google Tasks due dates are calendar dates, not local instants.
                            const due = task.due.slice(0, 10);
                            const parts = due.split('-').map(Number);
                            const parsed = new Date(parts[0], parts[1] - 1, parts[2]);
                            if (Number.isFinite(parsed.getTime())) copy.append(el('span', 'task-due' + (due < localDate(new Date()) ? ' overdue' : ''), 'Due ' + parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
                        }
                        if (task.parent) copy.style.paddingLeft = '10px';
                        row.append(mark, copy); items.append(row);
                    });
                    card.append(items); lists.append(card);
                });
                if (!shown) {
                    const box = el('div', 'empty-state');
                    box.append(el('strong', '', showCompleted ? 'A little breathing room.' : 'All caught up.'), el('span', '', showCompleted ? 'No tasks in this Google account yet.' : 'No incomplete tasks. Show completed tasks using the eye above.'));
                    lists.append(box);
                }
            }
            section.append(heading, lists); $('account-columns').append(section);
            lists.scrollTop = scrollPositions.get(account.sub) || 0;
        });
    }

    function buildHours() {
        const hours = $('timeline-hours'); hours.replaceChildren();
        for (let hour = 0; hour < 24; hour++) {
            const row = el('div', 'hour-line');
            row.append(el('span', 'hour-label', (hour % 12 || 12) + (hour < 12 ? 'a' : 'p')));
            hours.append(row);
        }
    }
    function minutesInDay(date, isEnd) {
        const start = day.getTime();
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
        if (date.getTime() <= start) return 0;
        if (date.getTime() >= end) return 1440;
        const value = date.getHours() * 60 + date.getMinutes();
        return isEnd ? Math.min(1440, value) : Math.max(0, value);
    }
    function updateNow() {
        const old = $('timeline-hours').querySelector('.now-line'); if (old) old.remove();
        const now = new Date();
        if (localDate(now) !== localDate(day)) return;
        const line = el('div', 'now-line');
        line.style.top = ((now.getHours() * 60 + now.getMinutes()) / 60 * 76) + 'px';
        line.setAttribute('aria-label', 'Current time ' + timeFormat.format(now));
        $('timeline-hours').append(line);
    }
    function renderTimeline() {
        buildHours();
        $('calendar-notices').replaceChildren(); $('all-day-events').replaceChildren();
        const timed = [], seen = new Set();
        accounts.forEach(account => {
            const state = results.get(account.sub) || {};
            const notice = el('div', 'calendar-notice');
            if (account.needsReconnect || state.eventsError) {
                const error = state.eventsError || { reconnect: true, message: 'Reconnect to load this calendar.' };
                notice.append(el('span', '', (accounts.length > 1 ? account.email + ': ' : '') + error.message));
                if (error.reconnect || error.code === 'FORBIDDEN') notice.append(reconnectButton(account));
                $('calendar-notices').append(notice);
            } else if (!state.events) {
                notice.textContent = 'Loading calendar…'; $('calendar-notices').append(notice);
            } else {
                state.events.forEach(event => {
                    const key = event.calendarId + '/' + event.googleId;
                    if (seen.has(key)) return;
                    seen.add(key);
                    if (event.start.date) {
                        const item = el('div', 'all-day-event', event.title);
                        item.style.setProperty('--account-color', account.isPrimary ? '#1595ff' : '#ce7df3');
                        item.title = 'All day · ' + account.email + ' · ' + event.calendarTitle;
                        $('all-day-events').append(item);
                    } else {
                        const start = new Date(event.start.dateTime);
                        const end = event.end && event.end.dateTime ? new Date(event.end.dateTime) : new Date(start.getTime() + 30 * 60000);
                        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return;
                        const top = minutesInDay(start, false);
                        let bottom = minutesInDay(end, true);
                        // A fall-back clock change can end a real event at an earlier wall-clock time.
                        if (bottom <= top && end.getTime() > start.getTime()) {
                            bottom = Math.min(1440, top + (end.getTime() - start.getTime()) / 60000);
                        }
                        if (bottom <= top) return;
                        timed.push({ event, account, start, end, top, bottom, lane: 0, lanes: 1 });
                    }
                });
            }
        });
        timed.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
        let group = [], laneEnds = [];
        function finishGroup() { group.forEach(item => { item.lanes = laneEnds.length; }); group = []; laneEnds = []; }
        timed.forEach(item => {
            if (group.length && item.top >= Math.max(...laneEnds)) finishGroup();
            let lane = laneEnds.findIndex(end => end <= item.top);
            if (lane < 0) lane = laneEnds.length;
            laneEnds[lane] = item.bottom; item.lane = lane; group.push(item);
        });
        finishGroup();
        timed.forEach(item => {
            const block = el('div', 'timeline-event' + (item.account.isPrimary ? '' : ' secondary'));
            block.style.top = (item.top / 60 * 76) + 'px';
            block.style.height = Math.max(20, (item.bottom - item.top) / 60 * 76 - 2) + 'px';
            block.style.left = (item.lane / item.lanes * 100) + '%';
            block.style.width = 'calc(' + (100 / item.lanes) + '% - 3px)';
            block.style.setProperty('--account-color', item.account.isPrimary ? '#1595ff' : '#ce7df3');
            const times = timeFormat.format(item.start) + ' – ' + timeFormat.format(item.end);
            block.title = item.event.title + '\n' + times + '\n' + item.account.email + ' · ' + item.event.calendarTitle;
            block.append(el('strong', '', item.event.title), el('time', '', times));
            $('timeline-hours').append(block);
        });
        $('all-day-events').hidden = !$('all-day-events').children.length;
        const readyStates = [...results.values()];
        if (readyStates.length && readyStates.every(state => state.events) && !timed.length && !$('all-day-events').children.length) {
            $('calendar-notices').append(el('p', 'calendar-notice', 'A clear calendar. Make the day yours.'));
        }
        updateNow();
        if (initialScroll) {
            const now = new Date();
            const hour = localDate(now) === localDate(day) ? Math.max(0, now.getHours() - 2) : 7;
            $('timeline-scroll').scrollTop = hour * 76;
            initialScroll = false;
        }
    }

    async function load() {
        if (!auth.requireSession()) return;
        const currentGeneration = ++generation;
        if (controller) controller.abort();
        controller = new AbortController();
        accounts = auth.getAccounts(); lastAccountState = stateKey();
        results = new Map(accounts.map(account => [account.sub, {}]));
        renderTasks(); renderTimeline(); renderSettings();
        $('refresh').disabled = true;
        $('planner-status').hidden = false; $('planner-status').textContent = 'Refreshing your calendars and tasks…';
        const work = accounts.filter(account => !account.needsReconnect).flatMap(account => [
            { key: 'events', promise: window.LotusGoogle.loadEvents(account, localDate(day), { signal: controller.signal }) },
            { key: 'tasks', promise: window.LotusGoogle.loadTasks(account, { signal: controller.signal }) },
        ].map(async ({ key, promise }) => {
            try {
                const data = await promise;
                if (currentGeneration !== generation) return;
                results.get(account.sub)[key] = data;
            } catch (error) {
                if (currentGeneration !== generation || error.name === 'AbortError') return;
                results.get(account.sub)[key + 'Error'] = error;
            }
            if (currentGeneration === generation) {
                if (key === 'tasks') renderTasks(); else renderTimeline();
            }
        }));
        await Promise.allSettled(work);
        if (currentGeneration !== generation) return;
        $('refresh').disabled = false;
        const hasErrors = [...results.values()].some(state => state.eventsError || state.tasksError);
        $('planner-status').hidden = !hasErrors;
        $('planner-status').textContent = 'Some Google data couldn’t load. You can reconnect the affected account or try refreshing.';
    }

    function dialogStatus(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
    function refreshAccountButtons() {
        $('link-second-account').disabled = !googleReady || linking;
        $('settings-link-account').disabled = !googleReady || linking;
        $('skip-second-account').disabled = linking;
    }
    async function linkSecond(source) {
        if (linking) return;
        const statusId = source === 'onboarding' ? 'onboarding-status' : 'settings-status';
        // Start Google synchronously from the user's click before awaiting anything.
        const request = auth.linkSecondAccount();
        linking = true; refreshAccountButtons(); dialogStatus(statusId, 'Choose your second account in the Google window…');
        try {
            await request;
            dialogStatus(statusId, '');
            if ($('second-account-dialog').open) $('second-account-dialog').close();
            if ($('settings-dialog').open) $('settings-dialog').close();
            linking = false; await load();
        } catch (error) {
            dialogStatus(statusId, error.message || 'Couldn’t link this account. Please try again.');
        } finally { linking = false; refreshAccountButtons(); renderSettings(); }
    }
    function reconnect(account) {
        if (linking) return;
        const request = auth.reconnectAccount(account.sub);
        linking = true; refreshAccountButtons();
        request.then(() => { linking = false; dialogStatus('settings-status', ''); return load(); }).catch(error => {
            dialogStatus('settings-status', error.message || 'Couldn’t reconnect. Please try again.');
            if (!$('settings-dialog').open) openSettings();
        }).finally(() => { linking = false; refreshAccountButtons(); renderSettings(); });
    }
    function renderSettings() {
        $('settings-accounts').replaceChildren();
        auth.getAccounts().forEach(account => {
            const row = el('div', 'settings-account');
            const avatar = el('span', 'account-avatar', (account.name || account.email || 'G').slice(0, 1).toUpperCase());
            if (!account.isPrimary) { avatar.style.background = '#f5e9fd'; avatar.style.color = '#bd6dea'; }
            const copy = el('div', 'settings-account-copy');
            copy.append(el('strong', '', account.isPrimary ? 'Primary account' : 'Second account'), el('span', '', account.email), el('span', '', account.needsReconnect ? 'Reconnect to load Google data' : 'Google Calendar & Tasks connected'));
            row.append(avatar, copy);
            // Also available for revoked permission before the token's scheduled expiry.
            const button = el('button', 'secondary-button', 'Reconnect');
            button.disabled = !googleReady || linking; button.addEventListener('click', () => reconnect(account)); row.append(button);
            $('settings-accounts').append(row);
        });
        $('settings-link-account').hidden = auth.getAccounts().length >= 2;
    }
    function openSettings() { renderSettings(); if (!$('settings-dialog').open) $('settings-dialog').showModal(); }
    $('accounts-button').addEventListener('click', openSettings);
    $('settings-button').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', () => $('settings-dialog').close());
    $('settings-link-account').addEventListener('click', () => linkSecond('settings'));
    $('link-second-account').addEventListener('click', () => linkSecond('onboarding'));
    function dismissOffer(event) {
        if (event) event.preventDefault();
        if (linking) return;
        try { auth.dismissSecondAccountOffer(); }
        catch (error) {
            $('planner-status').textContent = 'Your browser couldn’t remember this preference. You can still use your planner.';
            $('planner-status').hidden = false;
        }
        $('second-account-dialog').close();
    }
    $('skip-second-account').addEventListener('click', dismissOffer);
    $('second-account-dialog').addEventListener('cancel', dismissOffer);
    $('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog') && !linking) $('settings-dialog').close(); });
    auth.ready().then(() => {
        googleReady = true; refreshAccountButtons(); renderSettings(); renderTasks(); renderTimeline();
    }).catch(error => {
        dialogStatus('onboarding-status', error.message);
        dialogStatus('settings-status', error.message);
    });
    updateDate(); load();
    if (auth.shouldOfferSecondAccount()) $('second-account-dialog').showModal();
    function checkSession() {
        if (!auth.requireSession()) return;
        if (stateKey() !== lastAccountState) load();
        updateNow();
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
    window.addEventListener('pageshow', checkSession);
    setInterval(checkSession, 30000);
})();
