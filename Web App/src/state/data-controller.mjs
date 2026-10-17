import { localDate } from '../ui/dom.mjs?v=canvas-1';

// Fetches once per account/service; every widget shares the same results.
export function createDataController({ store, auth, google }) {
    let generation = 0;
    let controller;
    let lastAccountState = '';
    let disposed = false;
    function accountState() {
        return auth.getAccounts().map(account => account.sub + ':' + account.needsReconnect).join('|');
    }
    async function refresh() {
        if (disposed || !auth.requireSession()) return;
        const current = ++generation;
        if (controller) controller.abort();
        controller = new AbortController();
        const signal = controller.signal;
        const accounts = auth.getAccounts();
        const date = localDate(store.getState().day);
        lastAccountState = accountState();
        store.update({ accounts, results: new Map(accounts.map(account => [account.sub, {}])), loading: true, notice: '' });
        const work = accounts.filter(account => !account.needsReconnect).flatMap(account => ['events', 'tasks'].map(async key => {
            let patch;
            try {
                const result = key === 'events'
                    ? await google.loadEvents(account, date, { signal })
                    : await google.loadTasks(account, { signal });
                patch = { [key]: result };
            } catch (error) {
                if (error.name === 'AbortError') return;
                patch = { [key + 'Error']: error };
            }
            if (disposed || current !== generation) return;
            store.update(state => {
                const results = new Map(state.results);
                results.set(account.sub, { ...results.get(account.sub), ...patch });
                return { results };
            });
        }));
        await Promise.allSettled(work);
        if (disposed || current !== generation) return;
        const errors = [...store.getState().results.values()].some(result => result.eventsError || result.tasksError);
        store.update({ loading: false, notice: errors ? 'Some Google data couldn’t load. You can reconnect the affected account or try refreshing.' : '' });
    }
    return {
        refresh,
        checkAccounts() { if (!disposed && accountState() !== lastAccountState) return refresh(); },
        destroy() { disposed = true; generation++; if (controller) controller.abort(); },
    };
}
