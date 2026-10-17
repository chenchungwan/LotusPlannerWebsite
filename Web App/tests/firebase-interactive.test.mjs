import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseLogsRepository, createFirebaseLogSession } from '../src/services/firebase-logs.mjs';

const config = { apiKey: 'public-test', projectId: 'demo-pocky', authDomain: 'demo-pocky.firebaseapp.com', appId: 'public-test-app' };
const primary = { sub: 'google-primary', email: 'primary@example.test', accessToken: 'test-access-token' };
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const googleUser = (sub = primary.sub, uid = 'existing-pocky-firebase-uid') => ({ uid, email: primary.email, providerData: [{ providerId: 'google.com', uid: sub }] });

function setup({ factory = createFirebaseLogSession, credentialUser } = {}) {
    const auth = { currentUser: null }, apps = [], popups = [], credentials = [], watches = [];
    const popupResolver = Object.freeze({ name: 'browser-popup-redirect-resolver' });
    let signOuts = 0;
    class Provider {
        static credential(idToken, accessToken) { return { idToken, accessToken }; }
        setCustomParameters(parameters) { this.parameters = parameters; }
    }
    const sdk = {
        inMemoryPersistence: { type: 'none' },
        getApps: () => apps,
        initializeApp: (options, name) => { const app = { options, name }; apps.push(app); return app; },
        initializeAuth: () => auth,
        initializeFirestore: () => ({ memoryOnly: true }),
        memoryLocalCache: () => ({ type: 'memory' }),
        browserPopupRedirectResolver: popupResolver,
        GoogleAuthProvider: Provider,
        signInWithCredential: async (firebaseAuth, credential) => {
            credentials.push(credential);
            if (!credentialUser) throw failure('auth/invalid-credential', 'Credential belongs to another Google project');
            firebaseAuth.currentUser = credentialUser;
            return { user: credentialUser };
        },
        signInWithPopup: (firebaseAuth, provider, resolver) => {
            // initializeAuth with only in-memory persistence installs no default
            // popup resolver; mirror the real SDK's argument-error regression.
            if (resolver !== popupResolver) throw failure('auth/argument-error', 'An explicit popup resolver is required');
            const gate = deferred(); popups.push({ gate, provider, resolver });
            return gate.promise.then(user => { firebaseAuth.currentUser = user; return { user }; });
        },
        signOut: async firebaseAuth => { signOuts++; firebaseAuth.currentUser = null; },
        collection: (db, ...path) => ({ path }),
        onSnapshot: (reference, options, next, error) => {
            const watch = { reference, next, error, active: true }; watches.push(watch);
            return () => { watch.active = false; };
        },
    };
    const client = factory({ config, loadSdk: async () => sdk });
    async function warm() {
        await assert.rejects(client.connect(primary), error => error.code === 'auth/invalid-credential');
        await Promise.resolve();
    }
    return { client, auth, popups, credentials, watches, warm, popupResolver, get signOuts() { return signOuts; } };
}

test('interactive authorization opens synchronously from the user click and reuses the existing Firebase UID', async () => {
    const app = setup();
    await app.warm();
    let microtaskRan = false;
    queueMicrotask(() => { microtaskRan = true; });
    const request = app.client.authorize(primary);
    assert.equal(app.popups.length, 1);
    assert.equal(microtaskRan, false);
    assert.equal(app.popups[0].resolver, app.popupResolver);
    assert.deepEqual(app.popups[0].provider.parameters, { prompt: 'select_account', login_hint: primary.email });
    assert.throws(() => app.client.client(), error => error.code === 'unauthenticated');
    app.popups[0].gate.resolve(googleUser());
    assert.deepEqual(await request, { uid: 'existing-pocky-firebase-uid', googleSub: primary.sub });
    assert.equal(app.client.client().uid, 'existing-pocky-firebase-uid');
    const credentialCount = app.credentials.length;
    assert.deepEqual(await app.client.connect(primary), { uid: 'existing-pocky-firebase-uid', googleSub: primary.sub });
    assert.equal(app.credentials.length, credentialCount);
    await app.client.destroy();
});

test('a popup account with the wrong Google subject or provider is signed out and cannot attach reads', async () => {
    const wrongAccounts = [
        googleUser('different-google-account'),
        { uid: 'existing-pocky-firebase-uid', email: primary.email, providerData: [{ providerId: 'password', uid: primary.sub }] },
    ];
    for (const account of wrongAccounts) {
        const app = setup({ factory: createFirebaseLogsRepository });
        await app.warm();
        const request = app.client.authorize(primary);
        app.popups[0].gate.resolve(account);
        await assert.rejects(request, error => error.code === 'identity-mismatch');
        assert.equal(app.auth.currentUser, null);
        assert.equal(app.signOuts, 1);
        assert.throws(() => app.client.client(), error => error.code === 'unauthenticated');
        assert.throws(() => app.client.watchDefinitions(() => {}, assert.fail), error => error.code === 'unauthenticated');
        assert.equal(app.watches.length, 0);
        await app.client.destroy();
    }
});

test('popup cancellation detaches prior reads, leaves no authorized owner, and permits a deliberate retry', async () => {
    const app = setup({ factory: createFirebaseLogsRepository, credentialUser: googleUser() });
    await app.client.connect(primary);
    app.client.watchDefinitions(() => {}, assert.fail);
    const request = app.client.authorize(primary);
    assert.equal(app.watches[0].active, false);
    app.popups[0].gate.reject(failure('auth/popup-closed-by-user'));
    await assert.rejects(request, error => error.code === 'auth/popup-closed-by-user' && /cancelled/.test(error.message));
    assert.throws(() => app.client.client(), error => error.code === 'unauthenticated');
    assert.throws(() => app.client.watchDefinitions(() => {}, assert.fail));
    const retry = app.client.authorize(primary);
    assert.equal(app.popups.length, 2);
    app.popups[1].gate.resolve(googleUser());
    assert.equal((await retry).uid, 'existing-pocky-firebase-uid');
    await app.client.destroy();
});

test('duplicate popup requests reject without opening or corrupting the first authorization', async () => {
    const app = setup();
    await app.warm();
    const first = app.client.authorize(primary);
    await assert.rejects(app.client.authorize(primary), error => error.code === 'unavailable');
    assert.equal(app.popups.length, 1);
    app.popups[0].gate.resolve(googleUser());
    assert.equal((await first).googleSub, primary.sub);
    assert.equal(app.client.client().uid, 'existing-pocky-firebase-uid');
    await app.client.destroy();
});

test('secondary identities, uninitialized sessions, and disposed sessions cannot open a popup', async () => {
    const app = setup();
    await assert.rejects(app.client.authorize(primary), error => error.code === 'unavailable');
    assert.equal(app.popups.length, 0);
    await app.warm();
    await assert.rejects(app.client.authorize({ ...primary, isPrimary: false }), error => error.code === 'identity-mismatch');
    assert.equal(app.popups.length, 0);
    await app.client.destroy();
    await assert.rejects(app.client.authorize(primary));
    assert.equal(app.popups.length, 0);
});

test('a pending popup cannot restore ownership after the session is destroyed', async () => {
    const app = setup();
    await app.warm();
    const request = app.client.authorize(primary);
    const destroyed = app.client.destroy();
    app.popups[0].gate.resolve(googleUser());
    await assert.rejects(request);
    await destroyed;
    assert.equal(app.auth.currentUser, null);
    assert.throws(() => app.client.client());
});
