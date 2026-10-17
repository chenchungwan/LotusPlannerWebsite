import { validateCompletion } from './log-model.mjs?v=logs-1';

const emptyLogs = () => ({ status: 'loading', error: '', entries: [], completions: [], saving: false });
function localDate(date) { return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); }
function errorMessage(error) { return error?.message || 'Couldn’t access your cloud logs. Please try again.'; }

async function completionId(customLogId, itemId, day) {
    const bytes = new TextEncoder().encode(JSON.stringify([customLogId, itemId, day]));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return day + ':' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** One primary-owned cloud subscription shared by every log component. */
export function createLogsController({ store, auth, repository }) {
    let disposed = false;
    let started = false;
    let generation = 0;
    let observedKey = '';
    let ownerSub = '';
    let unsubscribeStore;
    let subscriptions = [];
    let refreshPromise = Promise.resolve();
    const pending = new Map();

    function session() { return auth.getSession(); }
    function key() { return (session()?.sub || '') + '|' + localDate(store.getState().day); }
    function updateLogs(patch) { store.update(state => ({ logs: { ...emptyLogs(), ...state.logs, ...patch } })); }
    function stopSubscriptions() { subscriptions.forEach(unsubscribe => unsubscribe()); subscriptions = []; }
    function savingFor(sub) { return [...pending.values()].some(value => value === sub); }

    async function refresh() {
        if (disposed) return;
        const current = ++generation;
        stopSubscriptions();
        const primary = session();
        const nextOwner = primary?.sub || '';
        const ownerChanged = nextOwner !== ownerSub;
        ownerSub = nextOwner;
        observedKey = key();
        const selected = new Date(store.getState().day);
        const to = localDate(selected);
        const first = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - 6);
        const from = localDate(first);
        store.update(state => ({
            logs: { ...emptyLogs(), saving: savingFor(nextOwner) },
            ...(ownerChanged ? { customLogs: [] } : {}),
        }));
        if (!primary) { updateLogs({ status: 'error', error: 'Sign in to your primary Google account to access cloud logs.' }); return; }
        const ready = { definitions: false, entries: false, completions: false };
        const errors = {};
        function status() {
            if (disposed || current !== generation) return;
            updateLogs({ status: Object.keys(errors).length ? 'error' : Object.values(ready).every(Boolean) ? 'ready' : 'loading', error: Object.values(errors).join(' ') });
        }
        function receive(source, data) {
            if (disposed || current !== generation) return;
            ready[source] = true;
            delete errors[source];
            if (source === 'definitions') store.update({ customLogs: data });
            else updateLogs({ [source]: data });
            status();
        }
        function failed(source, error) {
            if (disposed || current !== generation) return;
            errors[source] = errorMessage(error);
            status();
        }
        try {
            await repository.connect(primary);
            if (disposed || current !== generation) return;
            subscriptions.push(repository.watchDefinitions(data => receive('definitions', data), error => failed('definitions', error)));
            subscriptions.push(repository.watchEntries({ from, to }, data => receive('entries', data), error => failed('entries', error)));
            subscriptions.push(repository.watchCompletions(to, data => receive('completions', data), error => failed('completions', error)));
        } catch (error) {
            if (disposed || current !== generation) return;
            stopSubscriptions();
            updateLogs({ status: error.code === 'unconfigured' ? 'unconfigured' : 'error', error: errorMessage(error) });
        }
    }

    function requestRefresh() { refreshPromise = refresh(); return refreshPromise; }
    function start() {
        if (disposed || started) return refreshPromise;
        started = true;
        unsubscribeStore = store.subscribe(() => { if (!disposed && key() !== observedKey) void requestRefresh(); });
        return requestRefresh();
    }

    async function write(action) {
        if (disposed) throw new Error('Cloud logs are no longer connected.');
        const primary = session();
        if (!primary) {
            const error = new Error('Sign in to your primary Google account to save cloud logs.');
            updateLogs({ status: 'error', error: error.message });
            throw error;
        }
        const token = {};
        pending.set(token, primary.sub);
        updateLogs({ saving: true, error: '' });
        try {
            await repository.connect(primary);
            if (disposed || session()?.sub !== primary.sub) throw new Error('The active account changed. Please try again.');
            return await action();
        } catch (error) {
            if (!disposed && session()?.sub === primary.sub) {
                const authFailure = error.code === 'unauthenticated' || error.code === 'identity-mismatch' || error.code?.startsWith('auth/');
                updateLogs({ error: errorMessage(error), ...(error.code === 'unconfigured' ? { status: 'unconfigured' } : authFailure ? { status: 'error' } : {}) });
            }
            throw error;
        } finally {
            pending.delete(token);
            if (!disposed) updateLogs({ saving: savingFor(session()?.sub) });
        }
    }

    function saveEntry(entry) { return write(() => repository.saveEntry(entry)); }
    function deleteEntry(id) { return write(() => repository.deleteEntry(id)); }
    function saveCustomLog(definition, options) { return write(() => repository.saveCustomLog(definition, options)); }
    async function toggleCompletion(input) {
        try {
            const day = input.day || localDate(store.getState().day);
            const current = (store.getState().logs?.completions || []).find(record => record.customLogId === input.customLogId && record.itemId === input.itemId && record.day === day);
            const value = {
                ...input, day,
                id: input.id || current?.id || await completionId(input.customLogId, input.itemId, day),
                completed: input.completed === undefined ? !current?.completed : input.completed,
            };
            const completion = validateCompletion(value);
            return await write(() => repository.saveCompletion(completion));
        } catch (error) {
            if (!disposed) updateLogs({ error: errorMessage(error) });
            throw error;
        }
    }

    function destroy() {
        if (disposed) return;
        disposed = true;
        generation++;
        unsubscribeStore?.();
        stopSubscriptions();
        pending.clear();
        void Promise.resolve().then(() => repository.destroy()).catch(() => {});
    }

    return { start, refresh: requestRefresh, saveEntry, deleteEntry, saveCustomLog, toggleCompletion, destroy };
}
