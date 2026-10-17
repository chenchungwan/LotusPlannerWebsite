// Shared application state. Widgets receive snapshots and request changes through actions.
export function createPlannerStore(initial = {}) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let state = {
        day: today, accounts: [], results: new Map(), googleReady: false,
        linking: false, showCompleted: true, loading: false, notice: '', ...initial,
    };
    const listeners = new Set();
    return {
        getState: () => state,
        update(change) {
            const patch = typeof change === 'function' ? change(state) : change;
            state = { ...state, ...patch };
            listeners.forEach(listener => listener(state));
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        destroy() { listeners.clear(); },
    };
}
