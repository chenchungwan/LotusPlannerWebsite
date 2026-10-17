const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../auth.js'), 'utf8');
function setup({ scopes = true, session = null, configured = true, storageFails = false } = {}) {
    const data = new Map(session ? [['lotus.session', JSON.stringify(session)]] : []);
    let oauth, click, redirect, request, fetches = 0;
    const button = { hidden: true, disabled: false, addEventListener: (_, fn) => { click = fn; } };
    const status = { classList: { toggle() {} } };
    const google = { accounts: { oauth2: {
        hasGrantedAllScopes: () => scopes,
        initTokenClient: options => { oauth = options; return { requestAccessToken: options => { request = options; } }; },
    } } };
    const window = { google, LOTUS_CONFIG: { googleClientId: configured ? 'web.apps.googleusercontent.com' : 'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com' }, location: { replace: path => { redirect = path; } } };
    vm.runInNewContext(source, { window, google, sessionStorage: {
        getItem: key => data.get(key) || null, removeItem: key => data.delete(key),
        setItem: (key, value) => { if (storageFails) throw Error(); data.set(key, value); },
    }, fetch: async () => { fetches++; return { ok: true, json: async () => ({ sub: 'account', email: 'test@example.com' }) }; }, setTimeout, Date });
    return { auth: window.LotusAuth, data, button, status, init: () => window.LotusAuth.initLoginPage({ fallbackButton: button, statusEl: status }), click: () => click(), reply: response => oauth.callback(response), popupError: type => oauth.error_callback({ type }), get redirect() { return redirect; }, get request() { return request; }, get fetches() { return fetches; } };
}
const token = { access_token: 'token', expires_in: 3600 };
test('sign-in requests Google access from a click and saves a valid session', async () => {
    const app = setup(); await app.init(); app.click();
    assert.equal(app.request.prompt, 'select_account');
    await app.reply(token);
    assert.equal(app.redirect, 'index.html');
    assert.equal(app.auth.getSession().sub, 'account');
});
test('returning users obtain a fresh token rather than skipping authorization', async () => {
    const app = setup({ session: { sub: 'account', grantedPlannerScopes: true } });
    await app.init(); app.click(); await app.reply(token);
    assert.equal(app.fetches, 1); assert.equal(app.redirect, 'index.html');
});
test('partial permission grants stay on login and can retry', async () => {
    const app = setup({ scopes: false }); await app.init(); app.click(); await app.reply(token);
    assert.equal(app.redirect, undefined); assert.equal(app.auth.getSession(), null);
    assert.match(app.status.textContent, /both/); assert.equal(app.button.disabled, false);
});
test('denied authorization and blocked popups allow retry', async () => {
    const app = setup(); await app.init(); app.click(); await app.reply({ error: 'access_denied' });
    assert.equal(app.redirect, undefined); assert.equal(app.button.disabled, false);
    app.click(); app.popupError('popup_failed_to_open');
    assert.match(app.status.textContent, /pop-ups/); assert.equal(app.button.disabled, false);
});
test('expired sessions redirect to sign-in and are cleared', () => {
    const app = setup({ session: { sub: 'account', accessToken: 'old', grantedPlannerScopes: true, tokenExpiresAt: Date.now() - 1 } });
    assert.equal(app.auth.requireSession(), null); assert.equal(app.redirect, 'login.html'); assert.equal(app.data.size, 0);
});
test('placeholder client disables login', async () => {
    const app = setup({ configured: false }); await app.init();
    assert.equal(app.button.disabled, true); assert.match(app.status.textContent, /not available/);
});
test('storage failure does not redirect to welcome', async () => {
    const app = setup({ storageFails: true }); await app.init(); await app.reply(token);
    assert.equal(app.redirect, undefined); assert.match(app.status.textContent, /storage/);
});
test('sign out clears the session', async () => {
    const app = setup(); await app.init(); await app.reply(token); app.auth.signOut();
    assert.equal(app.auth.getSession(), null); assert.equal(app.redirect, 'login.html');
});
