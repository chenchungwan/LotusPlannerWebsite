import { createPlannerStore } from './src/state/planner-store.mjs?v=pocky-1';
import { createDataController } from './src/state/data-controller.mjs?v=pocky-1';
import { createLayoutRepository } from './src/layout/layout-model.mjs?v=pocky-1';
import { createPlannerLayout } from './src/layout/layout-renderer.mjs?v=pocky-1';
import { createWidgetRegistry } from './src/layout/widget-registry.mjs?v=journal-1';
import { createPlannerChrome } from './src/components/planner-chrome.mjs?v=pocky-1';
import { createAccountDialogs } from './src/components/account-dialogs.mjs?v=journal-1';
import { createLayoutEditor } from './src/components/layout-editor.mjs?v=journal-1';
import { createFirebaseLogSession } from './src/services/firebase-logs.mjs?v=pocky-1';
import { createPockyLogsRepository } from './src/services/pocky-logs.mjs?v=pocky-1';
import { createLogsController } from './src/state/logs-controller.mjs?v=journal-1';
import { createPockyJournalRepository } from './src/services/pocky-journal.mjs?v=journal-1';
import { createJournalController } from './src/state/journal-controller.mjs?v=journal-1';
import { createLogEntryDialog } from './src/components/log-entry-dialog.mjs?v=pocky-1';
import { createLogManager } from './src/components/log-dialogs.mjs?v=pocky-1';
import { localDate } from './src/ui/dom.mjs?v=pocky-1';

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
    const store = createPlannerStore({ accounts: auth.getAccounts(), showCompleted: preferences.get('lotus.showCompleted') !== 'false', taskDateFilter: 'day-overdue', customLogs: [] });
    const data = createDataController({ store, auth, google: window.LotusGoogle });
    // A Firebase project alone is insufficient: its existing record paths and schema must be reviewed first.
    const logBinding = window.LOTUS_CONFIG?.logs;
    const cloudSession = createFirebaseLogSession({ config: logBinding?.schema === 'pocky' && logBinding.schemaVersion === 1 ? window.LOTUS_CONFIG?.firebase : undefined });
    const logs = createLogsController({ store, auth, repository: createPockyLogsRepository({ session: cloudSession }) });
    const journal = createJournalController({ store, auth, repository: createPockyJournalRepository({ session: cloudSession }) });
    let dialogs;
    let editor;
    let logEntries;
    let logManager;
    const actions = {
        refresh: () => Promise.all([data.refresh(), logs.refresh()]),
        designLayout: () => editor.open(),
        signOut: () => {
            if (journal.hasUnsavedChanges() && !window.confirm('Your journal has unsaved changes. Log out and discard them?')) return;
            journal.destroy(); logs.destroy(); auth.signOut();
        },
        reconnect: account => dialogs.reconnect(account),
        changeDay(day) { day.setHours(0, 0, 0, 0); store.update({ day }); return data.refresh(); },
        toggleCompleted() {
            const showCompleted = !store.getState().showCompleted;
            preferences.set('lotus.showCompleted', String(showCompleted));
            store.update({ showCompleted });
        },
        // The editor saves a validated draft before applying it to the daily view.
        async saveLayout(definition) {
            const existing = new Set([...(store.getState().customLogs || []), ...(layout.getLayout().customLogs || [])].map(log => log.id));
            // New checklist names are explicit creations; existing cloud definitions are never replaced by layout metadata.
            for (const [order, log] of (definition.customLogs || []).entries()) {
                if (!existing.has(log.id)) await logs.saveCustomLog({ ...log, enabled: true, order, items: [] }, { createOnly: true });
            }
            const valid = repository.save(definition); layout.setLayout(valid); render(store.getState());
        },
        resetLayout() { layout.setLayout(repository.reset()); render(store.getState()); },
        addLog: (type, day) => logEntries.open(type, day),
        editLog: entry => logEntries.open(entry.type, new Date(entry.day + 'T12:00:00'), entry),
        saveEntry: entry => logs.saveEntry(entry),
        deleteEntry: (id, source) => logs.deleteEntry(id, source),
        setWater(day, cups) {
            const key = localDate(day);
            const existing = store.getState().logs?.entries.find(entry => entry.type === 'water' && entry.day === key);
            return logs.saveEntry({ id: existing?.id || 'water-' + key, type: 'water', day: key, time: existing?.time || '12:00', cups, ...(existing?.source ? { source: existing.source } : {}) });
        },
        toggleCustomLog: (customLogId, itemId, day, completed) => logs.toggleCompletion({ customLogId, itemId, day: localDate(day), completed }),
        manageLogs: id => logManager.open(id),
        saveCustomLog: definition => logs.saveCustomLog(definition),
        refreshLogs: () => logs.refresh(),
        connectLogs: () => logs.authorize(),
        updateJournalText: input => journal.updateText(input),
        addJournalText: day => journal.addText(day),
        addJournalImages: input => journal.addImages(input),
        removeJournalBlock: input => journal.removeBlock(input),
        saveJournal: day => journal.save(day),
        discardJournal: day => journal.discard(day),
        refreshJournal: () => journal.refresh(),
    };
    const chrome = createPlannerChrome({ root: document.body, primary, preferences, actions });
    dialogs = createAccountDialogs({ root: document.body, auth, store, actions });
    const layout = createPlannerLayout({
        root: document.getElementById('day-board'), registry: createWidgetRegistry(), layout: saved.layout, actions,
    });
    // Legacy layout names remain empty checklists until the user explicitly saves them to Firebase.
    function logContext(context = store.getState()) {
        const definitions = new Map((context.customLogs || []).map(log => [log.id, log]));
        for (const log of layout.getLayout().customLogs || []) if (!definitions.has(log.id)) definitions.set(log.id, { ...log, enabled: true, items: [] });
        return { ...context, customLogs: [...definitions.values()] };
    }
    logEntries = createLogEntryDialog({ root: document.body, getContext: logContext, actions });
    logManager = createLogManager({ root: document.body, getContext: logContext, actions });
    editor = createLayoutEditor({
        root: document.getElementById('layout-editor-host'),
        getLayout: () => layout.getLayout(), getContext: logContext,
        onSave: definition => actions.saveLayout(definition),
    });
    function render(context) {
        const content = logContext(context);
        chrome.update(context); dialogs.update(context); layout.update(content); editor.update(content); logEntries.update(content); logManager.update(content);
    }
    render(store.getState());
    const unsubscribe = store.subscribe(render);
    document.body.hidden = false;
    data.refresh();
    logs.start();
    journal.start();
    dialogs.offerSecondAccount();
    auth.ready().then(() => store.update({ googleReady: true })).catch(error => dialogs.showError(error.message));
    function checkSession() {
        const active = auth.requireSession();
        if (!active) return;
        if (active.sub !== primary.sub) { journal.destroy(); logs.destroy(); window.location.reload(); return; }
        data.checkAccounts();
        layout.tick(store.getState());
    }
    const listeners = new AbortController();
    window.addEventListener('beforeunload', event => {
        if (!journal.hasUnsavedChanges()) return;
        event.preventDefault(); event.returnValue = '';
    }, { signal: listeners.signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); }, { signal: listeners.signal });
    window.addEventListener('pageshow', checkSession, { signal: listeners.signal });
    const timer = setInterval(checkSession, 30000);
    // A restored bfcache document keeps its mounted widgets and rechecks the session.
    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        clearInterval(timer); listeners.abort(); unsubscribe(); data.destroy(); journal.destroy(); logs.destroy(); layout.destroy(); chrome.destroy(); dialogs.destroy(); editor.destroy(); logEntries.destroy(); logManager.destroy(); store.destroy();
    });
}
