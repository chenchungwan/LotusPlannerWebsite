# Lotus Planner web sign-in

The website’s Log In links open `login.html`. Continue with Google requests identity, Google Calendar, and Google Tasks access in one popup. Only a successful response with both planner permissions opens `index.html`, which displays “Welcome”. Returning users receive a new token through the same flow.

## Google Cloud setup

1. In Google Cloud project `1079954098512`, create an OAuth client with application type **Web application**. The native iOS client cannot be reused.
2. Add authorized JavaScript origins:
   - `https://www.lotusplanner.com`
   - `https://lotusplanner.com`
   - `http://localhost:8080` for local testing
3. Replace the placeholder `googleClientId` in `config.js` with that web client ID. The client ID is public; never add a client secret to this static website. This popup token flow does not require a redirect URI.
4. Enable Google Calendar API and Google Tasks API in the project. Configure the OAuth consent screen for identity and the Calendar/Tasks scopes used in `auth.js`. While the consent screen is in testing, add the accounts used to test as test users. Complete Google’s applicable verification before public rollout.

See Google’s token model guide: https://developers.google.com/identity/oauth2/web/guides/use-token-model

## Local verification

From the website root, run `python3 -m http.server 8080` and open `http://localhost:8080`.

Run automated flow checks with `node --test 'Web App/tests/auth.test.cjs'`.

With the configured web client, verify sign-in with a test account, selection of both planner permissions, the Welcome page, cancellation, partial consent, blocked popups, and returning after the session expires. Real Google consent cannot be verified with the placeholder client ID.

## Session behavior

Tokens live in per-tab session storage. Sessions expiring within one minute return to login; the Welcome page rechecks on tab return and every 30 seconds. Token renewal requires another user click on Continue with Google. No refresh tokens or background/offline access are used.

This is a static browser client, with Google API access authorized by Google-issued access tokens. Browser session storage is not server-side authentication. Future private backend endpoints must validate identity and authorization independently. No calendars or tasks are fetched or changed by the Welcome page.
