import { el } from '../ui/dom.mjs?v=logs-1';

// Singleton account-management UI. Authentication stays in the injected service.
export function createAccountDialogs({ root, auth, store, actions }) {
    const $ = id => root.querySelector('[id="' + id + '"]');
    let googleReady = store.getState().googleReady;
    let linking = store.getState().linking;
    let lastAccountsSignature;
    let disposed = false;
    const listeners = new AbortController();
    const on = (id, event, handler) => $(id).addEventListener(event, handler, { signal: listeners.signal });
    function setLinking(value) { if (disposed) return; linking = value; store.update({ linking: value }); }
    function dialogStatus(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
    function refreshAccountButtons() {
        $('link-second-account').disabled = !googleReady || linking;
        $('settings-link-account').disabled = !googleReady || linking;
        $('skip-second-account').disabled = linking;
    }
    async function linkSecond(source) {
        if (disposed || linking) return;
        const statusId = source === 'onboarding' ? 'onboarding-status' : 'settings-status';
        // Start Google synchronously from the user's click before awaiting anything.
        const request = auth.linkSecondAccount();
        setLinking(true); refreshAccountButtons(); dialogStatus(statusId, 'Choose your second account in the Google window…');
        try {
            await request;
            if (disposed) return;
            dialogStatus(statusId, '');
            if ($('second-account-dialog').open) $('second-account-dialog').close();
            if ($('settings-dialog').open) $('settings-dialog').close();
            setLinking(false); await actions.refresh();
        } catch (error) {
            if (disposed) return;
            dialogStatus(statusId, error.message || 'Couldn’t link this account. Please try again.');
        } finally { if (!disposed) { setLinking(false); refreshAccountButtons(); renderSettings(); } }
    }
    function reconnect(account) {
        if (disposed || linking) return;
        const request = auth.reconnectAccount(account.sub);
        setLinking(true); refreshAccountButtons();
        request.then(() => { if (disposed) return; setLinking(false); dialogStatus('settings-status', ''); return actions.refresh(); }).catch(error => {
            if (disposed) return;
            dialogStatus('settings-status', error.message || 'Couldn’t reconnect. Please try again.');
            if (!$('settings-dialog').open) openSettings();
        }).finally(() => { if (!disposed) { setLinking(false); refreshAccountButtons(); renderSettings(); } });
    }
    function renderSettings() {
        $('settings-accounts').replaceChildren();
        auth.getAccounts().forEach(account => {
            const row = el('div', 'settings-account');
            const avatar = el('span', 'account-avatar', (account.name || account.email || 'G').slice(0, 1).toUpperCase());
            if (!account.isPrimary) { avatar.style.background = '#f5e9fd'; avatar.style.color = '#bd6dea'; }
            const copy = el('div', 'settings-account-copy');
            copy.append(el('strong', '', account.isPrimary ? 'Primary account' : 'Second account'), el('span', '', account.email), el('span', '', account.needsReconnect ? 'Reconnect to load Google data' : 'Google Calendar & Tasks connected'));
            row.append(avatar, copy);
            // Also available for revoked permission before the token's scheduled expiry.
            const button = el('button', 'secondary-button', 'Reconnect');
            button.disabled = !googleReady || linking; button.addEventListener('click', () => reconnect(account)); row.append(button);
            $('settings-accounts').append(row);
        });
        $('settings-link-account').hidden = auth.getAccounts().length >= 2;
    }
    function openSettings() { renderSettings(); if (!$('settings-dialog').open) $('settings-dialog').showModal(); }
    on('accounts-button', 'click', openSettings);
    on('settings-button', 'click', openSettings);
    on('close-settings', 'click', () => $('settings-dialog').close());
    on('manage-custom-logs', 'click', () => { $('settings-dialog').close(); actions.manageLogs(); });
    on('settings-link-account', 'click', () => linkSecond('settings'));
    on('link-second-account', 'click', () => linkSecond('onboarding'));
    function dismissOffer(event) {
        if (event) event.preventDefault();
        if (disposed || linking) return;
        try { auth.dismissSecondAccountOffer(); }
        catch (error) {
            store.update({ notice: 'Your browser couldn’t remember this preference. You can still use your planner.' });
        }
        $('second-account-dialog').close();
    }
    on('skip-second-account', 'click', dismissOffer);
    on('second-account-dialog', 'cancel', dismissOffer);
    on('settings-dialog', 'click', event => { if (event.target === $('settings-dialog') && !linking) $('settings-dialog').close(); });

    return {
        update(context) {
            if (disposed) return;
            googleReady = context.googleReady; linking = context.linking;
            refreshAccountButtons();
            const signature = JSON.stringify([context.accounts.map(account => [account.sub, account.email, account.needsReconnect]), googleReady, linking]);
            if (signature !== lastAccountsSignature) { renderSettings(); lastAccountsSignature = signature; }
        },
        offerSecondAccount() { if (!disposed && auth.shouldOfferSecondAccount()) $('second-account-dialog').showModal(); },
        showError(message) { if (disposed) return; dialogStatus('onboarding-status', message); dialogStatus('settings-status', message); },
        reconnect,
        destroy() { disposed = true; listeners.abort(); for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close(); },
    };
}
