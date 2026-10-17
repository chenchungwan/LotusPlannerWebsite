(function () {
    'use strict';
    const SESSION_KEY = 'lotus.session';
    const PLANNER_SCOPES = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/tasks',
    ];
    const SCOPES = ['openid', 'email', 'profile', ...PLANNER_SCOPES].join(' ');

    function isClientConfigured() {
        const clientId = (window.LOTUS_CONFIG || {}).googleClientId || '';
        return clientId.endsWith('.apps.googleusercontent.com') && !clientId.startsWith('REPLACE_WITH_');
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    function getSession() {
        try {
            const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
            if (session && session.sub && session.accessToken && session.grantedPlannerScopes === true &&
                Number.isFinite(session.tokenExpiresAt) && session.tokenExpiresAt > Date.now() + 60000) {
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

    async function completeLogin(response) {
        if (response.error || !response.access_token) {
            throw new Error('Google sign-in was cancelled or declined. Please try again.');
        }
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...PLANNER_SCOPES)) {
            throw new Error('Please allow both Google Calendar and Google Tasks access to continue. Try again and select both permissions.');
        }
        const result = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + response.access_token },
        });
        if (!result.ok) throw new Error('Could not load your Google account. Please try again.');
        const profile = await result.json();
        if (!profile.sub) throw new Error('Could not identify your Google account. Please try again.');
        const expiresIn = Number(response.expires_in);
        if (!Number.isFinite(expiresIn) || expiresIn <= 60) {
            throw new Error('Google access has expired. Please sign in again.');
        }
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                sub: profile.sub,
                email: profile.email || '',
                name: profile.name || '',
                accessToken: response.access_token,
                grantedPlannerScopes: true,
                tokenExpiresAt: Date.now() + expiresIn * 1000,
            }));
        } catch (error) {
            throw new Error('Please allow storage for this site in your browser, then try again.');
        }
        window.location.replace('index.html');
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
            await waitForGoogle();
            const client = google.accounts.oauth2.initTokenClient({
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

    window.LotusAuth = { initLoginPage, requireSession, signOut, getSession, isClientConfigured };
})();
