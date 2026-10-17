const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../auth.js'), 'utf8');

function session(sub = 'primary', overrides = {}) {
    return {
        sub, email: sub + '@example.com', name: sub,
        accessToken: sub + '-token', grantedPlannerScopes: true,
        tokenExpiresAt: Date.now() + 3600000, ...overrides,
    };
}

function setup({ scopes = true, currentSession = null, configured = true, storageFails = false,
    localFails = false, googleLoaded = true, savedProfiles = {}, savedTokens = null, sharedLocal = null } = {}) {
    const data = new Map(currentSession ? [['lotus.session', JSON.stringify(currentSession)]] : []);
    if (savedTokens) data.set('lotus.accountTokens', JSON.stringify(savedTokens));
    const localData = sharedLocal || new Map([['lotus.accountProfiles', JSON.stringify(savedProfiles)]]);
    let oauth, click, redirect, request, fetches = 0, requests = 0;
    const button = { hidden: true, disabled: false, addEventListener: (_, fn) => { click = fn; } };
    const status = { classList: { toggle() {} } };
    const profiles = new Map();
    const google = { accounts: { oauth2: {
        hasGrantedAllScopes: () => scopes,
        initTokenClient: options => {
            oauth = options;
            return { requestAccessToken: options => { request = options; requests++; } };
        },
    } } };
    const window = {
        google: googleLoaded ? google : undefined,
        LOTUS_CONFIG: { googleClientId: configured ? 'web.apps.googleusercontent.com' : 'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com' },
        location: { replace: path => { redirect = path; } },
    };
    function storage(map, fails) {
        return {
            getItem: key => map.get(key) || null, removeItem: key => map.delete(key),
            setItem: (key, value) => { if (fails) throw Error(); map.set(key, value); },
        };
    }
    vm.runInNewContext(source, {
        window, sessionStorage: storage(data, storageFails), localStorage: storage(localData, localFails),
        fetch: async (_, options) => {
            fetches++;
            const profile = profiles.get(options.headers.Authorization.slice(7)) || { sub: 'primary', email: 'primary@example.com' };
            return { ok: true, json: async () => profile };
        },
        setTimeout, Date,
    });
    return {
        auth: window.LotusAuth, data, localData, button, status,
        init: () => window.LotusAuth.initLoginPage({ fallbackButton: button, statusEl: status }),
        click: () => click(), reply: response => oauth.callback(response),
        popupError: type => oauth.error_callback({ type }),
        setProfile: (token, sub) => profiles.set(token, { sub, email: sub + '@example.com', name: sub }),
        get redirect() { return redirect; }, get request() { return request; },
        get fetches() { return fetches; }, get requests() { return requests; },
    };
}
const token = { access_token: 'token', expires_in: 3600 };

test('sign-in requests Google access from a click and saves a verified session', async () => {
    const app = setup(); await app.init(); app.click();
    assert.equal(app.request.prompt, 'select_account');
    await app.reply(token);
    assert.equal(app.redirect, 'index.html');
    assert.equal(app.auth.getSession().sub, 'primary');
    assert.equal(app.auth.getAccounts().length, 1);
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
});

test('returning users obtain a fresh token rather than skipping authorization', async () => {
    const app = setup({ currentSession: { sub: 'primary', grantedPlannerScopes: true } });
    await app.init(); app.click(); await app.reply(token);
    assert.equal(app.fetches, 1); assert.equal(app.redirect, 'index.html');
});

test('partial permission grants stay on login and can retry', async () => {
    const app = setup({ scopes: false }); await app.init(); app.click(); await app.reply(token);
    assert.equal(app.redirect, undefined); assert.equal(app.auth.getSession(), null);
    assert.match(app.status.textContent, /both/); assert.equal(app.button.disabled, false);
    assert.equal(app.fetches, 0);
});

test('denied authorization and blocked popups allow retry', async () => {
    const app = setup(); await app.init(); app.click(); await app.reply({ error: 'access_denied' });
    assert.equal(app.redirect, undefined); assert.equal(app.button.disabled, false);
    app.click(); app.popupError('popup_failed_to_open');
    assert.match(app.status.textContent, /pop-ups/); assert.equal(app.button.disabled, false);
});

test('expired primary sessions redirect to sign-in and clear session tokens', () => {
    const app = setup({ currentSession: session('primary', { tokenExpiresAt: Date.now() - 1 }),
        savedTokens: { primarySub: 'primary', secondary: session('second') } });
    assert.equal(app.auth.requireSession(), null); assert.equal(app.redirect, 'login.html'); assert.equal(app.data.size, 0);
});

test('placeholder client disables login', async () => {
    const app = setup({ configured: false }); await app.init();
    assert.equal(app.button.disabled, true); assert.match(app.status.textContent, /not available/);
});

test('storage failure does not redirect to the planner', async () => {
    const app = setup({ storageFails: true }); await app.init(); await app.reply(token);
    assert.equal(app.redirect, undefined); assert.match(app.status.textContent, /storage/);
});

test('a second account opens its popup synchronously and stores tokens only in session storage', async () => {
    const app = setup({ currentSession: session() }); app.setProfile('second-token', 'second');
    await app.auth.ready();
    const linking = app.auth.linkSecondAccount();
    assert.equal(app.requests, 1);
    assert.equal(app.request.prompt, 'select_account');
    await app.reply({ access_token: 'second-token', expires_in: 3600 });
    const linked = await linking;
    assert.equal(linked.sub, 'second');
    assert.equal(app.auth.getSession().sub, 'primary');
    assert.equal(app.auth.getAccounts()[1].accessToken, 'second-token');
    assert.equal(app.auth.shouldOfferSecondAccount(), false);
    const persisted = app.localData.get('lotus.accountProfiles');
    assert.equal(persisted.includes('accessToken'), false);
    assert.equal(persisted.includes('second-token'), false);
    assert.equal(persisted.includes('second@example.com'), true);
});

test('duplicate accounts are rejected without replacing the primary or marking onboarding complete', async () => {
    const app = setup({ currentSession: session() });
    const linking = app.auth.linkSecondAccount();
    const rejected = assert.rejects(linking, { code: 'duplicate_account' });
    await app.reply(token); await rejected;
    assert.equal(app.auth.getAccounts().length, 1);
    assert.equal(app.auth.getSession().accessToken, 'primary-token');
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
    assert.equal(app.data.has('lotus.accountTokens'), false);
});

test('cancelled linking and denied scopes preserve the existing session and permit retry', async () => {
    const app = setup({ currentSession: session() });
    const first = app.auth.linkSecondAccount();
    const cancelled = assert.rejects(first, { code: 'popup_cancelled' });
    app.popupError('popup_closed'); await cancelled;
    const second = app.auth.linkSecondAccount();
    const declined = assert.rejects(second, { code: 'authorization_declined' });
    await app.reply({ error: 'access_denied' }); await declined;
    assert.equal(app.auth.getSession().accessToken, 'primary-token');
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
    const partial = setup({ scopes: false, currentSession: session() });
    const third = partial.auth.linkSecondAccount();
    const denied = assert.rejects(third, { code: 'permissions_required' });
    await partial.reply(token); await denied;
    assert.equal(partial.auth.getAccounts().length, 1);
});

test('saved secondary accounts require an exact Google identity when reconnecting', async () => {
    const app = setup({ currentSession: session(), savedProfiles: {
        primary: { secondary: { sub: 'second', email: 'second@example.com' }, secondAccountOfferSeen: true },
    } });
    app.setProfile('wrong-token', 'third'); app.setProfile('second-token', 'second');
    assert.equal(app.auth.getAccounts()[1].needsReconnect, true);
    const reconnecting = app.auth.reconnectAccount('second');
    assert.equal(app.request.login_hint, 'second@example.com');
    const mismatch = assert.rejects(reconnecting, { code: 'account_mismatch' });
    await app.reply({ access_token: 'wrong-token', expires_in: 3600 }); await mismatch;
    assert.equal(app.auth.getAccounts()[1].sub, 'second');
    assert.equal(app.auth.getAccounts()[1].needsReconnect, true);
    const retry = app.auth.reconnectAccount('second');
    await app.reply({ access_token: 'second-token', expires_in: 3600 }); await retry;
    assert.equal(app.auth.getAccounts()[1].needsReconnect, false);
    assert.equal(app.auth.getAccounts()[1].accessToken, 'second-token');
});

test('two-account limit and unknown reconnections do not open a popup', async () => {
    const app = setup({ currentSession: session(), savedProfiles: { primary: { secondary: { sub: 'second' } } } });
    await assert.rejects(app.auth.linkSecondAccount(), { code: 'account_limit' });
    await assert.rejects(app.auth.reconnectAccount('third'), { code: 'unknown_account' });
    assert.equal(app.requests, 0);
    assert.equal(app.auth.shouldOfferSecondAccount(), false);
});

test('expired secondary tokens return only account metadata while preserving primary access', () => {
    const app = setup({ currentSession: session(), savedProfiles: { primary: { secondary: { sub: 'second' } } },
        savedTokens: { primarySub: 'primary', secondary: session('second', { tokenExpiresAt: Date.now() - 1 }) } });
    const accounts = app.auth.getAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].needsReconnect, false);
    assert.equal(accounts[1].needsReconnect, true);
    assert.equal(accounts[1].accessToken, undefined);
    assert.equal(app.data.has('lotus.accountTokens'), false);
    assert.equal(app.auth.requireSession().sub, 'primary');
    assert.equal(app.redirect, undefined);
});

test('onboarding is remembered only for the primary profile that dismisses it', () => {
    const app = setup({ currentSession: session() });
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
    app.auth.dismissSecondAccountOffer();
    assert.equal(app.auth.shouldOfferSecondAccount(), false);
    const returning = setup({ currentSession: session(), sharedLocal: app.localData });
    assert.equal(returning.auth.shouldOfferSecondAccount(), false);
    const otherUser = setup({ currentSession: session('other'), sharedLocal: app.localData });
    assert.equal(otherUser.auth.shouldOfferSecondAccount(), true);
    assert.equal(otherUser.auth.getAccounts().length, 1);
});

test('sign out clears both tokens and retains account metadata and onboarding preference', () => {
    const app = setup({ currentSession: session(), savedProfiles: {
        primary: { secondary: { sub: 'second' }, secondAccountOfferSeen: true },
    }, savedTokens: { primarySub: 'primary', secondary: session('second') } });
    app.auth.signOut();
    assert.equal(app.data.size, 0);
    assert.equal(app.auth.getSession(), null);
    assert.equal(app.redirect, 'login.html');
    const returning = setup({ currentSession: session(), sharedLocal: app.localData });
    assert.equal(returning.auth.getAccounts()[1].sub, 'second');
    assert.equal(returning.auth.getAccounts()[1].needsReconnect, true);
    assert.equal(returning.auth.shouldOfferSecondAccount(), false);
});

test('linking rejects while Google loads and prevents concurrent authorization requests', async () => {
    const unloaded = setup({ currentSession: session(), googleLoaded: false });
    await assert.rejects(unloaded.auth.linkSecondAccount(), { code: 'google_not_ready' });
    const app = setup({ currentSession: session() });
    const first = app.auth.linkSecondAccount();
    const firstRejection = assert.rejects(first, { code: 'popup_cancelled' });
    await assert.rejects(app.auth.linkSecondAccount(), { code: 'request_pending' });
    assert.equal(app.requests, 1);
    app.popupError('popup_closed'); await firstRejection;
});

test('failed persistent storage leaves the primary session and onboarding unchanged', async () => {
    const app = setup({ currentSession: session(), localFails: true }); app.setProfile('second-token', 'second');
    const linking = app.auth.linkSecondAccount();
    const rejected = assert.rejects(linking, { code: 'storage_unavailable' });
    await app.reply({ access_token: 'second-token', expires_in: 3600 }); await rejected;
    assert.equal(app.auth.getSession().accessToken, 'primary-token');
    assert.equal(app.auth.getAccounts().length, 1);
    assert.equal(app.data.has('lotus.accountTokens'), false);
    assert.equal(app.auth.shouldOfferSecondAccount(), true);
});

test('a response arriving after sign out cannot restore a linked account', async () => {
    const app = setup({ currentSession: session() }); app.setProfile('second-token', 'second');
    const linking = app.auth.linkSecondAccount();
    const rejected = assert.rejects(linking, { code: 'session_expired' });
    app.auth.signOut();
    await app.reply({ access_token: 'second-token', expires_in: 3600 }); await rejected;
    assert.equal(app.data.size, 0);
    assert.equal(app.auth.getAccounts().length, 0);
});

test('primary reconnect renews only its verified token and preserves the secondary session', async () => {
    const app = setup({ currentSession: session(), savedProfiles: {
        primary: { secondary: { sub: 'second' }, secondAccountOfferSeen: true },
    }, savedTokens: { primarySub: 'primary', secondary: session('second') } });
    app.setProfile('fresh-primary-token', 'primary');
    const reconnecting = app.auth.reconnectAccount('primary');
    assert.equal(app.request.login_hint, 'primary@example.com');
    assert.equal(app.requests, 1);
    await app.reply({ access_token: 'fresh-primary-token', expires_in: 3600 });
    const renewed = await reconnecting;
    assert.equal(renewed.isPrimary, true);
    assert.equal(app.auth.getSession().accessToken, 'fresh-primary-token');
    assert.equal(app.auth.getAccounts()[1].accessToken, 'second-token');
    assert.equal(app.auth.shouldOfferSecondAccount(), false);
    assert.equal(app.redirect, undefined);
});

test('primary reconnect rejects a different Google identity without changing either account', async () => {
    const app = setup({ currentSession: session(), savedProfiles: { primary: { secondary: { sub: 'second' } } },
        savedTokens: { primarySub: 'primary', secondary: session('second') } });
    app.setProfile('other-token', 'second');
    const previousPrimary = app.data.get('lotus.session');
    const previousSecondary = app.data.get('lotus.accountTokens');
    const reconnecting = app.auth.reconnectAccount('primary');
    const rejected = assert.rejects(reconnecting, { code: 'account_mismatch' });
    await app.reply({ access_token: 'other-token', expires_in: 3600 }); await rejected;
    assert.equal(app.data.get('lotus.session'), previousPrimary);
    assert.equal(app.data.get('lotus.accountTokens'), previousSecondary);
    assert.equal(app.auth.getAccounts().length, 2);
    assert.equal(app.redirect, undefined);
});

test('cancelled primary reconnect preserves both existing account sessions', async () => {
    const app = setup({ currentSession: session(), savedProfiles: { primary: { secondary: { sub: 'second' } } },
        savedTokens: { primarySub: 'primary', secondary: session('second') } });
    const previousPrimary = app.data.get('lotus.session');
    const previousSecondary = app.data.get('lotus.accountTokens');
    const reconnecting = app.auth.reconnectAccount('primary');
    const rejected = assert.rejects(reconnecting, { code: 'popup_cancelled' });
    app.popupError('popup_closed'); await rejected;
    assert.equal(app.data.get('lotus.session'), previousPrimary);
    assert.equal(app.data.get('lotus.accountTokens'), previousSecondary);
    assert.equal(app.auth.getAccounts()[1].needsReconnect, false);
    assert.equal(app.redirect, undefined);
});
