# Lotus Planner web app

The website’s Log In links open `login.html`. Continue with Google requests identity, Google Calendar, and Google Tasks access in one popup. After both planner permissions are granted, users open the daily planner.

## Current scaffold

- Expandable left navigation and top date/view/tool bars, based on the native planner.
- Daily timeline with selected Google calendars from both linked accounts, all-day events, overlapping events, and a current-time marker.
- One task column per linked account, grouped by Google task list, with completed-task visibility control. Tasks are shown across all dates; the date selector changes the calendar day.
- First-visit invitation to optionally link a second Google account. Dismissing the invitation or linking successfully records the choice per primary Google identity in this browser. Linked accounts remains available from the sidebar.
- Up to two distinct Google accounts. Account metadata is remembered per primary account in local storage, while access tokens remain in per-tab session storage. Linking requires both Calendar and Tasks permissions. Cancelled, duplicate, or mismatched-account authorization does not replace the existing account.
- Reconnection for expired secondary access or revoked permissions, preserving the other account. Primary expiry returns to login.
- Refresh, date navigation, date picker, Today, sidebar expansion, linked accounts, and logout are functional. Other view and new-item controls are marked as coming soon. Calendar and task data are read-only at this stage.

There is no backend or cross-browser account database yet. A first visit means the first visit for that Google identity in this browser; another browser or cleared local storage will show the invitation again. Account links made in the native app are not available to the web app automatically.

## Google Cloud setup

Project: `neon-concord-448921-g1` (`1079954098512`). The web OAuth client is configured in `config.js`; the native iOS client cannot be reused.

Authorized JavaScript origins:

- `https://www.lotusplanner.com`
- `https://lotusplanner.com`
- `http://localhost:8080` for local testing

The client ID is public; never add a client secret to this static website. This popup token flow does not require a redirect URI.

Enable Google Calendar API and Google Tasks API in the project. Configure the OAuth consent screen for identity and the Calendar/Tasks scopes used in `auth.js`. While the consent screen is in testing, add the accounts used to test as test users. Complete Google’s applicable verification before public rollout.

Google documentation: [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [Tasks](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list).

## Local verification

From the website root, run `python3 -m http.server 8080` and open `http://localhost:8080`.

Run automated flow and data checks with `node --test 'Web App/tests/'*.test.cjs`.

Verify sign-in, partial/cancelled consent, first-visit skip/link choices, duplicate accounts, exact-account reconnection, account expiry, and both one- and two-account layouts. Check date navigation, all-day/overlapping events, task-list grouping, completed-task visibility, and desktop/mobile sidebar behavior. Browser layout checks can use isolated local test fixtures; production never substitutes sample data when Google data fails.

## Session behavior

Sessions expiring within one minute return to login; the app rechecks on tab return and every 30 seconds. Expired secondary access leaves its task column with a Reconnect action. Renewal requires another user click. No refresh tokens or background/offline access are used.

This is a static browser client, with Google API access authorized by Google-issued access tokens. Browser session storage is not server-side authentication. Future private backend endpoints must validate identity and authorization independently.
