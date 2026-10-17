# Lotus Planner web app

The website’s Log In links open `login.html`. Continue with Google requests identity, Google Calendar, and Google Tasks access in one popup. After both planner permissions are granted, users open the daily planner.

## Current scaffold

- Expandable left navigation and top date/view/tool bars, based on the native planner.
- Daily timeline with selected Google calendars from both linked accounts, all-day events, overlapping events, and a current-time marker.
- The default layout includes one task panel per linked account, grouped by Google task list, with completed-task visibility control. By default, tasks include tasks due on the selected day and incomplete overdue tasks; individual task components can choose a different date filter.
- First-visit invitation to optionally link a second Google account. Dismissing the invitation or linking successfully records the choice per primary Google identity in this browser. Linked accounts remains available from the sidebar.
- Up to two distinct Google accounts. Account metadata is remembered per primary account in local storage, while access tokens remain in per-tab session storage. Linking requires both Calendar and Tasks permissions. Cancelled, duplicate, or mismatched-account authorization does not replace the existing account.
- Reconnection for expired secondary access or revoked permissions, preserving the other account. Primary expiry returns to login.
- Refresh, date navigation, date picker, Today, sidebar expansion, linked accounts, and logout are functional. Other view and new-item controls are marked as coming soon. Calendar and task data are read-only at this stage.

Calendar account links remain browser-scoped. A first visit means the first visit for that Google identity in this browser; another browser or cleared local storage will show the invitation again. Account links made in the native app are not available to the web app automatically.

## Reusable layout foundation

The day view is composed from independent components. A versioned layout definition controls placement, size, account/list filters, timeline density, and per-component display options. Definitions are scoped to the signed-in Google identity and saved separately from account tokens. Google data is shared across components.

Choose **Design layout** in the top bar to open the day canvas editor. Start from the current layout or choose **Start blank**. Drag components from the palette, move them by their header, or resize from any corner. Overlapping or out-of-bounds placements are rejected. Save applies the design to the day view; Cancel discards draft changes. Layouts are saved per Google identity in this browser. Cross-device layout sync is future work. See [ARCHITECTURE.md](ARCHITECTURE.md) for the component contract, layout example, persistence boundary, and extension path.

The searchable component library includes:

- **Calendar:** the existing 24-hour timeline and an events list for the selected day.
- **Tasks:** grouped task lists or a compact, flat task list for each linked account. Both use the same date and completion filters.
- **Logs:** All logs, individual Sleep, Weight, Workout, Workout days, Food, Water, and custom daily checklists. These share the same cloud records wherever a component appears.
- **Placeholders:** Journal, vertical or horizontal goal bars, and weekly, monthly, or yearly weight graphs. They have no entries or invented progress yet.

## Logs implementation and setup status

The log components, entry forms, custom checklist manager, and Pocky compatibility adapter are implemented. The existing Firebase project is **Pocky Apps**, project **`life-planner-f0134`**. `config.js` reuses the public Web registration from the sibling [Pocky configuration](../../Pocky/public/firebase-config.js) and binds logs to its existing `users/{firebaseUid}` records. Existing data is read in place; it is not copied into a second dataset.

**Firebase domain setup is complete.** On October 17, 2026, both `lotusplanner.com` and `www.lotusplanner.com` were added to Firebase Authentication with user approval; `localhost` remains authorized. Production sign-in and writes still need manual end-to-end verification because the browser testing tool relocates the authentication popup. See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for verification steps.

The adapter supports:

- Add, edit, and delete Weight (`lbs` or `kg`), Workout, Food, and Sleep entries for the selected day. Existing Pocky IDs and metadata are retained. Workout types come from Pocky's editable settings, including custom or archived historical types; a type-only or description-only workout is valid.
- View/edit the existing Pocky wake time. Optional bed-time metadata is additive; a new Sleep entry remains independent of that legacy wake field.
- Set daily Water from 0–99 cups in an additive day field. Updating an existing day preserves its water ID.
- View **Workout days** as the number of distinct workout dates in the last seven days, including the selected day. It has no separate stored record.
- Use **Manage logs** to rename, reorder, and archive/restore checklist items and collections. Existing Pocky routines appear as **Routines** with their original item IDs and dated checks. Additional collections reference the same routine documents through additive grouping metadata. Other Pocky apps continue to show a flat routine list.

The layout editor's custom-name control creates a draft name. Save explicitly creates only new empty collection metadata; it never replaces existing routines or checklist items. Legacy layout-only names remain empty references until explicitly saved through Manage logs. Starting blank or resetting an arrangement does not reset cloud logs.

Logs belong to the existing Firebase UID for the primary Google account. Linking a second Calendar/Tasks account does not change that owner. The app first tries the current Google token with Firebase. If the two Google projects require separate authorization, **Connect Google** opens Pocky's Firebase Google popup for identity only and verifies that the chosen Google subject matches the primary account. It does not request Calendar/Tasks permissions again or create a parallel user namespace.

Firebase Auth and Firestore use memory-only browser state, with no localStorage/IndexedDB log-record fallback. Layout geometry and name/ID references remain local presentation metadata. The sibling LotusPlannerV3 app's separate Core Data/iCloud records are not imported automatically; this integration targets the user-confirmed existing **Pocky Firebase** data. [ARCHITECTURE.md](ARCHITECTURE.md) documents the storage mapping and preservation boundaries.

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

Run automated flow, component, and layout checks with `node --test 'Web App/tests/'*.test.cjs 'Web App/tests/'*.test.mjs`.

Verify sign-in, partial/cancelled consent, first-visit skip/link choices, duplicate accounts, exact-account reconnection, account expiry, and both one- and two-account layouts. Check date navigation, all-day/overlapping events, task filters, and desktop/mobile layout editing. Log checks cover selected-day forms, daylight-saving boundaries, failed-write retry, delete confirmation, daily water updates, shared components, custom archive/restore, and primary-owner isolation. Firebase emulator instructions are in [FIREBASE_SETUP.md](FIREBASE_SETUP.md). Browser checks can use isolated local fixtures; production never substitutes sample records when a service fails.

## Session behavior

Sessions expiring within one minute return to login; the app rechecks on tab return and every 30 seconds. Expired secondary access leaves its task column with a Reconnect action. Renewal requires another user click. No refresh tokens or background/offline access are used.

This is a static browser client. Google-issued access tokens authorize Calendar/Tasks access; the log adapter verifies the primary identity through Pocky Firebase Authentication and relies on the existing Firestore owner rules. Browser session storage alone is not backend authentication. Production-domain authorization and live verification remain outstanding.
