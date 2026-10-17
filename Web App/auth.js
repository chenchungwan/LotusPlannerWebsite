(function () {
    'use strict';
    const SESSION_KEY = 'lotus.session';
    const ACCOUNT_TOKENS_KEY = 'lotus.accountTokens';
    const ACCOUNT_PROFILES_KEY = 'lotus.accountProfiles';
    const PLANNER_SCOPES = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/tasks',
    ];
    const SCOPES = ['openid', 'email', 'profile', ...PLANNER_SCOPES].join(' ');
    let googleReadyPromise;
    let accountRequestPending = false;

    function authError(message, code) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function readObject(storage, key) {
        try {
            const value = JSON.parse(storage.getItem(key));
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (error) {
            return {};
        }
    }

    function accountMetadata(account) {
        return { sub: account.sub, email: account.email || '', name: account.name || '' };
    }

    function readProfiles() {
        try {
            return readObject(localStorage, ACCOUNT_PROFILES_KEY);
        } catch (error) {
            return {};
        }
    }

    function profileFor(primary) {
        const profile = readProfiles()[primary.sub];
        return profile && typeof profile === 'object' ? profile : {};
    }

    function writeProfile(primary, profile) {
        try {
            const profiles = readProfiles();
            profiles[primary.sub] = { ...profile, primary: accountMetadata(primary) };
            localStorage.setItem(ACCOUNT_PROFILES_KEY, JSON.stringify(profiles));
        } catch (error) {
            throw authError('Please allow storage for this site in your browser, then try again.', 'storage_unavailable');
        }
    }

    function isValidSession(session) {
        return Boolean(session && typeof session.sub === 'string' && session.sub && session.accessToken &&
            session.grantedPlannerScopes === true && Number.isFinite(session.tokenExpiresAt) &&
            session.tokenExpiresAt > Date.now() + 60000);
    }

    function isClientConfigured() {
        const clientId = (window.LOTUS_CONFIG || {}).googleClientId || '';
        return clientId.endsWith('.apps.googleusercontent.com') && !clientId.startsWith('REPLACE_WITH_');
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(ACCOUNT_TOKENS_KEY);
    }

    function getSession() {
        try {
            const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
            if (isValidSession(session)) {
                return session;
            }
            clearSession();
        } catch (error) {
            // Unavailable storage or an invalid session requires signing in again.
        }
        return null;
    }

    function waitForGoogle() {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            function check() {
                if (window.google && window.google.accounts && window.google.accounts.oauth2) {
                    resolve();
                } else if (++attempts >= 100) {
                    reject(new Error('Google sign-in could not load. Check your connection and reload this page.'));
                } else {
                    setTimeout(check, 100);
                }
            }
            check();
        });
    }

    function googleIsReady() {
        return Boolean(window.google && window.google.accounts && window.google.accounts.oauth2);
    }

    function ready() {
        if (!isClientConfigured()) {
            return Promise.reject(authError('Google sign-in is not available yet. Please try again later.', 'not_configured'));
        }
        if (!googleReadyPromise) {
            googleReadyPromise = waitForGoogle().catch(error => {
                googleReadyPromise = null;
                throw error;
            });
        }
        return googleReadyPromise;
    }

    async function verifiedAccount(response) {
        if (response.error || !response.access_token) {
            throw authError('Google sign-in was cancelled or declined. Please try again.', 'authorization_declined');
        }
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, ...PLANNER_SCOPES)) {
            throw authError('Please allow both Google Calendar and Google Tasks access to continue. Try again and select both permissions.', 'permissions_required');
        }
        const result = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + response.access_token },
        });
        if (!result.ok) throw new Error('Could not load your Google account. Please try again.');
        const profile = await result.json();
        if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('Could not identify your Google account. Please try again.');
        const expiresIn = Number(response.expires_in);
        if (!Number.isFinite(expiresIn) || expiresIn <= 60) {
            throw new Error('Google access has expired. Please sign in again.');
        }
        return {
            ...accountMetadata(profile),
            accessToken: response.access_token,
            grantedPlannerScopes: true,
            tokenExpiresAt: Date.now() + expiresIn * 1000,
        };
    }

    async function completeLogin(response) {
        const account = await verifiedAccount(response);
        try {
            const previous = readObject(sessionStorage, SESSION_KEY);
            if (previous.sub !== account.sub) sessionStorage.removeItem(ACCOUNT_TOKENS_KEY);
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(account));
        } catch (error) {
            throw new Error('Please allow storage for this site in your browser, then try again.');
        }
        // Sign-in remains usable if persistent browser storage is unavailable.
        // Account linking explains the storage requirement if it is requested.
        try { writeProfile(account, profileFor(account)); } catch (error) { /* Session is already saved. */ }
        window.location.replace('index.html');
    }

    function getPrimaryAccount() {
        const primary = getSession();
        return primary ? { ...primary, isPrimary: true, needsReconnect: false } : null;
    }

    function getAccounts() {
        const primary = getPrimaryAccount();
        if (!primary) return [];
        const accounts = [primary];
        const secondary = profileFor(primary).secondary;
        if (secondary && typeof secondary.sub === 'string' && secondary.sub && secondary.sub !== primary.sub) {
            const tokens = readObject(sessionStorage, ACCOUNT_TOKENS_KEY);
            const session = tokens.primarySub === primary.sub && tokens.secondary;
            const valid = session && session.sub === secondary.sub && isValidSession(session);
            accounts.push({
                ...accountMetadata(secondary),
                ...(valid ? session : {}),
                isPrimary: false,
                needsReconnect: !valid,
            });
            if (session && !valid) {
                try { sessionStorage.removeItem(ACCOUNT_TOKENS_KEY); } catch (error) { /* Expired tokens are never returned. */ }
            }
        }
        return accounts;
    }

    function shouldOfferSecondAccount() {
        const primary = getSession();
        if (!primary) return false;
        const profile = profileFor(primary);
        return !profile.secondAccountOfferSeen && !profile.secondary;
    }

    function dismissSecondAccountOffer() {
        const primary = getSession();
        if (primary) writeProfile(primary, { ...profileFor(primary), secondAccountOfferSeen: true });
    }

    function saveSecondary(primary, account) {
        const previousProfile = profileFor(primary);
        const previousTokens = sessionStorage.getItem(ACCOUNT_TOKENS_KEY);
        try {
            sessionStorage.setItem(ACCOUNT_TOKENS_KEY, JSON.stringify({ primarySub: primary.sub, secondary: account }));
            writeProfile(primary, { ...previousProfile, secondary: accountMetadata(account), secondAccountOfferSeen: true });
        } catch (error) {
            try {
                if (previousTokens) sessionStorage.setItem(ACCOUNT_TOKENS_KEY, previousTokens);
                else sessionStorage.removeItem(ACCOUNT_TOKENS_KEY);
            } catch (restoreError) { /* The primary session is never modified. */ }
            throw authError('Please allow storage for this site in your browser, then try again.', 'storage_unavailable');
        }
        return { ...account, isPrimary: false, needsReconnect: false };
    }

    function requestAccount(expectedSub) {
        const primary = getSession();
        if (!primary) return Promise.reject(authError('Your session has expired. Please sign in again.', 'session_expired'));
        const knownSecondary = profileFor(primary).secondary;
        const reconnectingPrimary = expectedSub === primary.sub;
        const expectedAccount = reconnectingPrimary ? primary : knownSecondary;
        if (expectedSub && (!expectedAccount || expectedAccount.sub !== expectedSub)) {
            return Promise.reject(authError('This account is not linked to your planner.', 'unknown_account'));
        }
        if (!expectedSub && knownSecondary) {
            return Promise.reject(authError('Two accounts are already linked. Reconnect your linked account to use it again.', 'account_limit'));
        }
        if (!isClientConfigured() || !googleIsReady()) {
            return Promise.reject(authError('Google sign-in is still loading. Please try again in a moment.', 'google_not_ready'));
        }
        if (accountRequestPending) {
            return Promise.reject(authError('Finish the open Google sign-in window first.', 'request_pending'));
        }
        accountRequestPending = true;
        return new Promise((resolve, reject) => {
            function fail(error) {
                accountRequestPending = false;
                reject(error);
            }
            try {
                const client = window.google.accounts.oauth2.initTokenClient({
                    client_id: window.LOTUS_CONFIG.googleClientId,
                    scope: SCOPES,
                    include_granted_scopes: true,
                    callback: async response => {
                        try {
                            const account = await verifiedAccount(response);
                            const currentPrimary = getSession();
                            if (!currentPrimary || currentPrimary.sub !== primary.sub) {
                                throw authError('Your session has changed. Please sign in again.', 'session_expired');
                            }
                            if (account.sub === primary.sub && !reconnectingPrimary) {
                                throw authError('That Google account is already linked. Choose a different account.', 'duplicate_account');
                            }
                            if (expectedSub && account.sub !== expectedSub) {
                                throw authError('Choose the same Google account to reconnect ' + (expectedAccount.email || 'your linked account') + '.', 'account_mismatch');
                            }
                            const currentSecondary = profileFor(primary).secondary;
                            if (!expectedSub && currentSecondary) {
                                throw authError('Two accounts are already linked to your planner.', 'account_limit');
                            }
                            if (expectedSub && !reconnectingPrimary && (!currentSecondary || currentSecondary.sub !== expectedSub)) {
                                throw authError('Your linked account has changed. Reload the planner and try again.', 'account_mismatch');
                            }
                            let saved;
                            if (reconnectingPrimary) {
                                try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(account)); }
                                catch (error) { throw authError('Please allow storage for this site in your browser, then try again.', 'storage_unavailable'); }
                                // Only refresh primary credentials; linked tokens and onboarding stay intact.
                                try { writeProfile(account, profileFor(account)); } catch (error) { /* Fresh session remains usable. */ }
                                saved = { ...account, isPrimary: true, needsReconnect: false };
                            } else {
                                saved = saveSecondary(currentPrimary, account);
                            }
                            accountRequestPending = false;
                            resolve(saved);
                        } catch (error) {
                            fail(error);
                        }
                    },
                    error_callback: error => fail(authError(error.type === 'popup_failed_to_open'
                        ? 'Allow pop-ups for this site, then try again.'
                        : 'Google sign-in was closed. Your linked accounts have not changed.', 'popup_cancelled')),
                });
                // Must stay in the original click call stack to avoid popup blockers.
                client.requestAccessToken({ prompt: 'select_account', ...(expectedSub ? { login_hint: expectedAccount.email || expectedSub } : {}) });
            } catch (error) {
                fail(authError('Could not open Google sign-in. Please try again.', 'popup_failed'));
            }
        });
    }

    function linkSecondAccount() {
        return requestAccount();
    }

    function reconnectAccount(sub) {
        if (!sub) return Promise.reject(authError('Choose a linked account to reconnect.', 'unknown_account'));
        return requestAccount(sub);
    }

    async function initLoginPage(options) {
        const button = options.fallbackButton;
        const status = options.statusEl;
        function setStatus(message, isError) {
            status.textContent = message;
            status.hidden = !message;
            status.classList.toggle('is-error', Boolean(isError));
        }
        if (getSession()) {
            window.location.replace('index.html');
            return;
        }
        button.hidden = false;
        button.disabled = true;
        if (!isClientConfigured()) {
            setStatus('Google sign-in is not available yet. Please try again later.', true);
            return;
        }
        setStatus('Loading Google sign-in…');
        try {
            await ready();
            const client = window.google.accounts.oauth2.initTokenClient({
                client_id: window.LOTUS_CONFIG.googleClientId,
                scope: SCOPES,
                include_granted_scopes: true,
                callback: async (response) => {
                    try {
                        setStatus('Finishing sign-in…');
                        await completeLogin(response);
                    } catch (error) {
                        setStatus(error.message || 'Sign-in failed. Please try again.', true);
                    } finally {
                        button.disabled = false;
                    }
                },
                error_callback: (error) => {
                    button.disabled = false;
                    setStatus(error.type === 'popup_failed_to_open'
                        ? 'Allow pop-ups for this site, then try again.'
                        : 'Google sign-in was closed. Please try again.', true);
                },
            });
            button.addEventListener('click', () => {
                button.disabled = true;
                setStatus('Continue in the Google window…');
                try {
                    // Keep the popup directly inside the click to avoid popup blockers.
                    client.requestAccessToken({ prompt: 'select_account' });
                } catch (error) {
                    button.disabled = false;
                    setStatus('Could not open Google sign-in. Please try again.', true);
                }
            });
            button.disabled = false;
            setStatus('');
        } catch (error) {
            setStatus(error.message || 'Google sign-in could not load. Reload to try again.', true);
        }
    }

    function requireSession() {
        const session = getSession();
        if (!session) window.location.replace('login.html');
        return session;
    }

    function signOut() {
        clearSession();
        window.location.replace('login.html');
    }

    window.LotusAuth = {
        initLoginPage, requireSession, signOut, getSession, isClientConfigured,
        ready, getPrimaryAccount, getAccounts, shouldOfferSecondAccount,
        dismissSecondAccountOffer, linkSecondAccount, reconnectAccount,
    };
})();
