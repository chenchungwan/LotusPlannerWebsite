# Pocky cloud logs setup

The planner reuses **Pocky Apps**, Firebase project **`life-planner-f0134`**, and the existing user's records under **`users/{firebaseUid}`**. Google Calendar and Google Tasks retain the separate OAuth project **`neon-concord-448921-g1`** and the existing two-account flow. There is no copy into `webLogUsers`, and no automatic import from LotusPlannerV3's separate iCloud storage.

## Current status

- The public Web SDK configuration is copied from [Pocky's existing registration](../../Pocky/public/firebase-config.js) into `config.js`. It contains public application identifiers, not a service-account key or client secret.
- The Pocky schema and source compatibility layer are implemented. The explicit binding is `schema:'pocky'`, `schemaVersion:1`, `rootCollection:'users'`.
- On October 17, 2026, with user approval, **`lotusplanner.com` and `www.lotusplanner.com` were added and verified** in Firebase Authentication authorized domains. The existing `localhost` and Firebase domains remain authorized. Live cloud sign-in and writes still require the manual end-to-end check below.
- The deployed Firestore rules were inspected and match the owner-only `users/{uid}` policy described below. No production rules replacement, database creation, record migration, or bulk data import is part of this setup.
- Automated checks and an isolated interactive preview pass. Live cloud reads/writes remain unverified: the browser testing tool relocates the Google popup into a tab group, after which Firebase reports a closed popup. Complete the next sign-in manually without moving its popup window before diagnosing an application callback failure.

## Authentication and verification

1. Firebase Authentication in project `life-planner-f0134` now authorizes both Lotus domains and the existing local test domain. Its Google provider and users are preserved.
2. Keep Calendar/Tasks OAuth configured in `neon-concord-448921-g1`. Its existing origins and scopes are independent of Firebase's authorized-domain list. A redirect URI remains unnecessary for the Calendar/Tasks popup token flow.
3. The app first tries the primary Google access token with Firebase. A token issued for the Calendar OAuth project may require authorization in Pocky's Firebase Google project. In that case, the user clicks **Connect Google**, which opens Firebase's Google popup for identity/profile access only.
4. The Firebase Google provider subject must exactly match the primary planner Google `sub`. A different account is rejected and signed out. The adapter uses the resulting **existing Firebase UID**, never the Google subject as a replacement Firestore owner path. Linking a second Calendar/Tasks account does not change ownership.
5. Test from an authorized origin using the same Google account already used in Pocky. Verify reads first, then perform a deliberately created test change and verify it in another Pocky client. Confirm cancellation and wrong-account selection leave existing records untouched.

The public binding in `config.js` is:

```js
window.LOTUS_CONFIG.logs = {
  schema: 'pocky',
  schemaVersion: 1,
  rootCollection: 'users',
};
```

Keep the existing public `window.LOTUS_CONFIG.firebase` registration for `life-planner-f0134`. There is no need to register a second Firebase application or duplicate users. Firebase JavaScript SDK 13.0.0 is loaded through the official [modular CDN setup](https://firebase.google.com/docs/web/alt-setup).

## Existing records and additive fields

| Path under `users/{firebaseUid}` | Existing Pocky data / Lotus additions |
| --- | --- |
| `trackerDays/{YYYY-MM-DD}` | Existing `wake:'HH:mm'`; `weights:[{id,value,unit,createdAt}]`; `workouts:[{id,type,text,createdAt}]`; `food:[{id,text,createdAt}]`; `routines:{routineId:true}`. Dates are local calendar keys. |
| `routines/{routineId}` | Existing `{id,name,order,archived,createdAt}`. The ID remains the original routine identity. Optional `lotusCollectionId` adds grouping without copying the routine. |
| `meta/settings` | Existing `trackerSettings.weightUnit` (`lb` or `kg`) and editable `trackerSettings.workoutTypes:[{id,name,color,archived?}]`, plus other settings/preferences that must be retained. |
| `lotusLogCollections/{collectionId}` | Additive `{name,enabled,order}` collection metadata. The default virtual collection is `pocky-routines`; it needs no document unless its metadata is explicitly changed. |
| Day `water` | Additive single object `{id,cups,time,...}`. Existing IDs are reused. |
| Day `sleep` | Additive array of independent sleep entries `{id,bedTime,wakeTime,time,...}`. New sleep entries do not overwrite legacy `wake`. |
| Day `lotusWake` | Additive `{bedTime,wakeTime,time}` metadata for an explicitly edited legacy wake entry. Raw `wake` stays readable by existing Pocky apps. |

Unchecked routines are absent from the day's map. Checking writes `true`; unchecking removes only that routine key. Archived routines and prior-day checks are retained. Additional grouping changes how Lotus displays the same routines; older Pocky clients continue to display them in one flat checklist.

The mapper converts `lb` to the view-model label `lbs`, derives a missing entry clock from local `createdAt`, and retains raw IDs/source routes. It does not rewrite records during reads. For legacy wake metadata, the raw Pocky clock wins if another Pocky client changes it; bed-time metadata is retained and impossible chronology is reported for review.

## Preservation and rules

`pocky-logs.mjs` uses targeted transactions that reread current day/routine records before changing the intended values. Unknown fields, unrelated day arrays, other routine completion keys, original IDs, and existing `createdAt` values are preserved. The collection editor blocks an unsaved draft if its observed cloud definition changes; closing and reopening loads the latest definition. Definition removal archives routines; it does not erase completion history. Creating a new collection checks cloud existence and retains an existing definition instead of replacing its items with layout metadata.

Older Pocky clients sometimes replace an entire day document from their local snapshot. Simultaneous edits across old and new clients can therefore still have a last-writer-wins race; Lotus transactions reduce its own risk but cannot change those older clients' write behavior.

The existing Pocky owner-prefix rules already cover user-owned documents and additive metadata under `users/{uid}`. **The checked-in generic `firestore.rules` is an isolated test example, not the production Pocky ruleset. Do not deploy that whole file to Pocky.** Preserve the deployed rules and other apps' collections; no full rules deployment is required for this adapter.

Firebase Authentication and Firestore use memory-only browser state. There is no log-record fallback to localStorage, browser IndexedDB, or iCloud. Listeners publish confirmed server snapshots; failed writes remain visible and retryable.

## Verification

Run the Node checks from the website root:

```sh
node --test 'Web App/tests/'*.test.cjs 'Web App/tests/'*.test.mjs
```

The current suite reports 214 passing checks and 6 emulator-only checks skipped when the emulator is not running. An additional Pocky owner-isolation check passed against a disposable emulator. Tests use synthetic records and injected Firebase boundaries. They cover schema conversion, original identities, local dates, custom workout settings, legacy wake metadata, shared widgets, archive/history behavior, and preserving unrelated source fields during writes. Emulator tests must use a disposable project and fixtures only. The existing `firebase.json` / generic rule fixture is not a command to deploy Pocky's production rules.

The authorized domains are configured. Finish live verification in a normal browser without moving the authentication popup. Confirm primary-account identity, existing routine names/checks, date switching, a new test entry, edit/delete routing, and visibility in the original Pocky app. This document does not claim those live checks have passed.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the component/service boundaries and [Pocky's cloud adapter](../../Pocky/public/cloud.js), [tracker model](../../Pocky/iPad/Pocky/Trackers.swift), and [routine settings writes](../../Pocky/iPad/Pocky/SettingsEdits.swift) for the source storage contract.
