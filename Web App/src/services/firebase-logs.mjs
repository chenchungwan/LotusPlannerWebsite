import { validateLogEntry, validateCustomLog, validateCompletion } from '../state/log-model.mjs?v=pocky-1';

const SDK_VERSION = '13.0.0';

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function safeError(error) {
    if (error?.lotusLogs || (error instanceof TypeError && error.message.startsWith('Invalid log data:'))) return error;
    const code = error?.code || '';
    let message = 'Couldn’t access your cloud logs. Please try again.';
    if (code === 'unconfigured') message = 'Cloud logs aren’t configured yet. Please try again later.';
    else if (code === 'identity-mismatch') message = 'Reconnect your primary Google account to access its cloud logs.';
    else if (code === 'auth/unauthorized-domain') message = 'Cloud sign-in is not enabled for this website yet.';
    else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') message = 'Cloud sign-in was cancelled. You can try again.';
    else if (code === 'unavailable' || code === 'auth/network-request-failed') message = 'Cloud logs are unavailable. Check your connection and try again.';
    else if (code === 'unauthenticated' || code.startsWith('auth/')) message = 'Reconnect your primary Google account to access cloud logs.';
    else if (code === 'permission-denied') message = 'Cloud logs access was denied. Please reconnect your primary account or try again later.';
    else if (code === 'cancelled') message = 'The active account changed. Please try again.';
    else if (code === 'invalid-record') message = 'Some cloud log records could not be read. Please try again later.';
    const result = failure(code || 'cloud-error', message);
    result.lotusLogs = true;
    return result;
}

async function defaultLoadSdk() {
    const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
    const modules = await Promise.all([
        import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js'),
    ]);
    return Object.assign({}, ...modules);
}

function configured(config) {
    return config && ['apiKey', 'authDomain', 'projectId', 'appId'].every(key =>
        typeof config[key] === 'string' && config[key].trim() && !/REPLACE|YOUR_|PLACEHOLDER/i.test(config[key]));
}

function validId(id) {
    if (typeof id !== 'string' || !id || id.length > 256 || id !== id.trim() || id === '.' || id === '..' || /[\/\u0000-\u001f\u007f]/.test(id)) {
        throw new TypeError('Invalid log data: invalid id');
    }
    return id;
}

function validDay(day) {
    // Reuse the same real-date validation as persisted records.
    return validateCompletion({ id: 'date-check', customLogId: 'date-check', itemId: 'date-check', day, completed: false }).day;
}

function sameGoogleUser(user, sub) {
    return Boolean(user?.uid && user.providerData?.some(provider => provider.providerId === 'google.com' && provider.uid === sub));
}

/** Firebase owns only the primary identity; linked Calendar/Tasks accounts never enter this service. */
export function createFirebaseLogsRepository({ config, loadSdk = defaultLoadSdk, rootCollection = 'webLogUsers' } = {}) {
    if (typeof rootCollection !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(rootCollection)) throw new TypeError('Invalid cloud logs collection.');
    let runtimePromise;
    let runtime;
    let owner;
    let generation = 0;
    let disposed = false;
    let connectQueue = Promise.resolve();
    let pendingConnect;
    let popupPending = false;
    const listeners = new Set();

    function stopListeners() {
        [...listeners].forEach(unsubscribe => unsubscribe());
    }

    async function initialize() {
        if (!configured(config)) throw safeError(failure('unconfigured'));
        if (!runtimePromise) {
            runtimePromise = (async () => {
                const sdk = await loadSdk();
                const name = 'lotus-web-logs-' + config.projectId;
                const existing = sdk.getApps().find(app => app.name === name);
                const app = existing || sdk.initializeApp(config, name);
                let firebaseAuth;
                try { firebaseAuth = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence }); }
                catch (error) {
                    if (error.code !== 'auth/already-initialized') throw error;
                    firebaseAuth = sdk.getAuth(app);
                    await sdk.setPersistence(firebaseAuth, sdk.inMemoryPersistence);
                }
                let db;
                try { db = sdk.initializeFirestore(app, { localCache: sdk.memoryLocalCache() }); }
                catch (error) {
                    if (error.code !== 'failed-precondition') throw error;
                    db = sdk.getFirestore(app);
                }
                runtime = { sdk, app, auth: firebaseAuth, db };
                return runtime;
            })().catch(error => { runtimePromise = undefined; throw safeError(error); });
        }
        return runtimePromise;
    }

    async function connect(primary) {
        if (disposed) throw safeError(failure('cancelled'));
        if (!primary || typeof primary.sub !== 'string' || !primary.sub || !primary.accessToken) throw safeError(failure('unauthenticated'));
        if (primary.isPrimary === false) throw safeError(failure('identity-mismatch'));
        if (owner?.googleSub === primary.sub && sameGoogleUser(runtime?.auth.currentUser, primary.sub)) return { ...owner };
        if (pendingConnect?.sub === primary.sub) return pendingConnect.promise;
        const current = ++generation;
        stopListeners();
        owner = undefined;
        // Serialize changes to Firebase Auth so an older exchange cannot replace a newer owner.
        const job = connectQueue.catch(() => {}).then(async () => {
            if (disposed || current !== generation) throw failure('cancelled');
            const client = await initialize();
            if (disposed || current !== generation) throw failure('cancelled');
            if (client.auth.currentUser) await client.sdk.signOut(client.auth);
            const credential = client.sdk.GoogleAuthProvider.credential(null, primary.accessToken);
            const result = await client.sdk.signInWithCredential(client.auth, credential);
            if (disposed || current !== generation || !sameGoogleUser(result.user, primary.sub) ||
                !sameGoogleUser(client.auth.currentUser, primary.sub)) {
                await client.sdk.signOut(client.auth);
                throw failure(disposed || current !== generation ? 'cancelled' : 'identity-mismatch');
            }
            owner = { uid: result.user.uid, googleSub: primary.sub };
            return { ...owner };
        }).catch(error => { throw safeError(error); });
        connectQueue = job.catch(() => {});
        pendingConnect = { sub: primary.sub, promise: job };
        void job.finally(() => { if (pendingConnect?.promise === job) pendingConnect = undefined; }).catch(() => {});
        return job;
    }

    function client() {
        if (disposed || !owner || !runtime) throw safeError(failure('unauthenticated'));
        if (!sameGoogleUser(runtime.auth.currentUser, owner.googleSub) || runtime.auth.currentUser.uid !== owner.uid) {
            owner = undefined;
            generation++;
            stopListeners();
            void runtime.sdk.signOut(runtime.auth).catch(() => {});
            throw safeError(failure('identity-mismatch'));
        }
        return { ...runtime, uid: owner.uid, googleSub: owner.googleSub };
    }

    // Called directly from a click. A same-project Firebase popup can finish cloud
    // sign-in when the Calendar OAuth token belongs to another Google project.
    function authorize(primary) {
        if (disposed || !primary?.sub || primary.isPrimary === false) return Promise.reject(safeError(failure('identity-mismatch')));
        if (!runtime || pendingConnect || popupPending) return Promise.reject(failure('unavailable', 'Cloud sign-in is still loading. Please try again.'));
        const current = ++generation;
        stopListeners(); owner = undefined; popupPending = true;
        const provider = new runtime.sdk.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account', login_hint: primary.email || '' });
        // Do not await initialization or sign-out before opening this popup.
        let request;
        try { request = runtime.sdk.signInWithPopup(runtime.auth, provider, runtime.sdk.browserPopupRedirectResolver); }
        catch (error) { popupPending = false; return Promise.reject(safeError(error)); }
        const job = request.then(async result => {
            if (disposed || current !== generation || !sameGoogleUser(result.user, primary.sub) ||
                !sameGoogleUser(runtime.auth.currentUser, primary.sub)) {
                await runtime.sdk.signOut(runtime.auth).catch(() => {});
                throw failure(current !== generation ? 'cancelled' : 'identity-mismatch');
            }
            owner = { uid: result.user.uid, googleSub: primary.sub };
            return { ...owner };
        }).catch(error => { throw safeError(error); }).finally(() => { popupPending = false; });
        connectQueue = job.catch(() => {});
        return job;
    }

    function watch(collectionName, constraints, validate, next, error) {
        const current = client();
        const epoch = generation;
        const reference = current.sdk.collection(current.db, rootCollection, current.uid, collectionName);
        const query = constraints.length ? current.sdk.query(reference, ...constraints) : reference;
        let active = true;
        let detach = () => {};
        const unsubscribe = () => { if (!active) return; active = false; listeners.delete(unsubscribe); detach(); };
        listeners.add(unsubscribe);
        try {
            detach = current.sdk.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
                if (!active || disposed || epoch !== generation) return;
                try {
                    client();
                    // Publish confirmed cloud state, not optimistic writes or an empty local cache.
                    if (snapshot.metadata?.hasPendingWrites || snapshot.metadata?.fromCache) return;
                    const records = snapshot.docs.map(document => validate({ ...document.data(), id: document.id }));
                    if (collectionName === 'entries') records.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
                    if (collectionName === 'customLogs') records.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
                    next(records);
                } catch (cause) {
                    error(safeError(cause instanceof TypeError ? failure('invalid-record') : cause));
                }
            }, cause => {
                if (active && !disposed && epoch === generation) error(safeError(cause));
            });
            if (!active) detach();
        } catch (cause) {
            unsubscribe();
            throw safeError(cause);
        }
        return unsubscribe;
    }

    function watchDefinitions(next, error) { return watch('customLogs', [], validateCustomLog, next, error); }
    function watchEntries({ from, to }, next, error) {
        validDay(from); validDay(to);
        if (from > to) throw new TypeError('Invalid log date range.');
        const current = client();
        return watch('entries', [current.sdk.where('day', '>=', from), current.sdk.where('day', '<=', to), current.sdk.orderBy('day', 'asc')], validateLogEntry, next, error);
    }
    function watchCompletions(day, next, error) {
        validDay(day);
        const current = client();
        return watch('completions', [current.sdk.where('day', '==', day)], validateCompletion, next, error);
    }

    async function save(collectionName, value, validate) {
        const record = validate(value);
        const current = client();
        try {
            const reference = current.sdk.doc(current.db, rootCollection, current.uid, collectionName, record.id);
            await current.sdk.setDoc(reference, { ...record, updatedAt: current.sdk.serverTimestamp() });
            return record;
        } catch (error) { throw safeError(error); }
    }

    async function deleteEntry(id) {
        validId(id);
        const current = client();
        try { await current.sdk.deleteDoc(current.sdk.doc(current.db, rootCollection, current.uid, 'entries', id)); }
        catch (error) { throw safeError(error); }
    }

    async function saveCustomLog(definition, { createOnly = false } = {}) {
        if (!createOnly) return save('customLogs', definition, validateCustomLog);
        const record = validateCustomLog(definition);
        const current = client();
        const reference = current.sdk.doc(current.db, rootCollection, current.uid, 'customLogs', record.id);
        try {
            return await current.sdk.runTransaction(current.db, async transaction => {
                if (client().uid !== current.uid) throw failure('cancelled');
                const snapshot = await transaction.get(reference);
                if (snapshot.exists()) return validateCustomLog({ ...snapshot.data(), id: snapshot.id || record.id });
                transaction.set(reference, { ...record, updatedAt: current.sdk.serverTimestamp() });
                return record;
            });
        } catch (error) { throw safeError(error); }
    }

    async function destroy() {
        if (disposed) return;
        disposed = true;
        generation++;
        owner = undefined;
        stopListeners();
        await connectQueue.catch(() => {});
        if (runtime) await runtime.sdk.signOut(runtime.auth).catch(() => {});
    }

    return {
        connect, authorize, client, watchDefinitions, watchEntries, watchCompletions,
        saveEntry: entry => save('entries', entry, validateLogEntry), deleteEntry,
        saveCustomLog,
        saveCompletion: completion => save('completions', completion, validateCompletion),
        destroy,
    };
}

/** Authentication and ownership shared by schema-specific repositories. */
export function createFirebaseLogSession(options) {
    const repository = createFirebaseLogsRepository(options);
    return { connect: repository.connect, authorize: repository.authorize, client: repository.client, destroy: repository.destroy };
}
