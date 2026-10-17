import { createPlannerStore } from './src/state/planner-store.mjs';
import { createDataController } from './src/state/data-controller.mjs';
import { createLayoutRepository } from './src/layout/layout-model.mjs';
import { createPlannerLayout } from './src/layout/layout-renderer.mjs';
import { createWidgetRegistry } from './src/layout/widget-registry.mjs';
import { createPlannerChrome } from './src/components/planner-chrome.mjs';
import { createAccountDialogs } from './src/components/account-dialogs.mjs';

// Composition root: wire services, state, the fixed app frame, and configurable content.
const auth = window.LotusAuth;
const primary = auth.requireSession();
if (primary) {
    const preferences = {
        get(key) { try { return localStorage.getItem(key); } catch (error) { return null; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch (error) { /* Optional browser preference. */ } },
    };
    const repository = createLayoutRepository({
        ownerId: primary.sub,
        storage: {
            getItem: key => localStorage.getItem(key),
            setItem: (key, value) => localStorage.setItem(key, value),
            removeItem: key => localStorage.removeItem(key),
        },
    });
    const saved = repository.load();
    const store = createPlannerStore({ accounts: auth.getAccounts(), showCompleted: preferences.get('lotus.showCompleted') !== 'false' });
    const data = createDataController({ store, auth, google: window.LotusGoogle });
    let dialogs;
    const actions = {
        refresh: () => data.refresh(),
        signOut: () => auth.signOut(),
        reconnect: account => dialogs.reconnect(account),
        changeDay(day) { day.setHours(0, 0, 0, 0); store.update({ day }); return data.refresh(); },
        toggleCompleted() {
            const showCompleted = !store.getState().showCompleted;
            preferences.set('lotus.showCompleted', String(showCompleted));
            store.update({ showCompleted });
        },
        // A future layout editor calls this same path for drag, resize, and widget options.
        saveLayout(definition) { const valid = repository.save(definition); layout.setLayout(valid); },
        resetLayout() { layout.setLayout(repository.reset()); },
    };
    const chrome = createPlannerChrome({ root: document.body, primary, preferences, actions });
    dialogs = createAccountDialogs({ root: document.body, auth, store, actions });
    const layout = createPlannerLayout({
        root: document.getElementById('day-board'), registry: createWidgetRegistry(), layout: saved.layout, actions,
    });
    function render(context) { chrome.update(context); dialogs.update(context); layout.update(context); }
    render(store.getState());
    const unsubscribe = store.subscribe(render);
    document.body.hidden = false;
    data.refresh();
    dialogs.offerSecondAccount();
    auth.ready().then(() => store.update({ googleReady: true })).catch(error => dialogs.showError(error.message));
    function checkSession() {
        if (!auth.requireSession()) return;
        data.checkAccounts();
        layout.tick(store.getState());
    }
    const listeners = new AbortController();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); }, { signal: listeners.signal });
    window.addEventListener('pageshow', checkSession, { signal: listeners.signal });
    const timer = setInterval(checkSession, 30000);
    // A restored bfcache document keeps its mounted widgets and rechecks the session.
    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        clearInterval(timer); listeners.abort(); unsubscribe(); data.destroy(); layout.destroy(); chrome.destroy(); dialogs.destroy(); store.destroy();
    });
}
