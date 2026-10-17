# Cloud logs setup

The web planner uses Firebase Authentication and Cloud Firestore for log entries, custom log definitions, and dated completions. Google Calendar and Google Tasks keep their existing OAuth flow and two-account limit. Cloud logs belong to the primary Google identity; linking another calendar account never changes that owner.

## Project configuration

1. Confirm the Firebase project that already contains the intended logs. The current Google OAuth project is `neon-concord-448921-g1`; this does not prove that it owns the existing Firebase records. Inspect the existing collection paths, field schemas, Google-provider identity mapping, and deployed rules before configuring writes. Adapt the repository's `rootCollection` and schema mapping to existing data rather than creating a duplicate empty dataset.
2. Reuse a compatible existing Web app registration, or register one only if needed, and copy its public SDK configuration into `window.LOTUS_CONFIG.firebase` in `config.js`. The required fields are `apiKey`, `authDomain`, `projectId`, and `appId`. Optional public configuration fields can be included. Do not add service-account keys or OAuth client secrets.
3. Enable the Google provider in Firebase Authentication and authorize `lotusplanner.com`, `www.lotusplanner.com`, and the local test hostname. The web planner exchanges its existing primary Google access token for Firebase credentials; it does not open another Google sign-in popup.
4. Reuse the confirmed project's existing Firestore database. The included `firestore.rules` is a self-contained local test ruleset for the proposed default namespace, **not a replacement for an existing project's deployed rules**. Read and preserve the existing rules, adapt paths/identity mapping, then merge only the reviewed log rules needed for the existing schema. Blindly deploying this whole file could deny access to other apps or collections. No database creation, import, or rule deployment happens automatically from the website.

The app keeps cloud logs unconfigured until both Firebase settings and an explicit reviewed schema binding are present. After confirming that the existing fields and identity paths match this adapter, configure these two objects. Replace every example value, including `CONFIRMED_EXISTING_ROOT`, with the inspected existing configuration; do not enable this binding for an incompatible legacy schema.

```js
window.LOTUS_CONFIG.firebase = {
  apiKey: 'PUBLIC_WEB_APP_API_KEY',
  authDomain: 'CONFIRMED_PROJECT.firebaseapp.com',
  projectId: 'CONFIRMED_PROJECT',
  appId: 'PUBLIC_WEB_APP_ID',
};
window.LOTUS_CONFIG.logs = {
  schemaVersion: 1,
  rootCollection: 'CONFIRMED_EXISTING_ROOT',
};
```

If the existing data uses different fields or nesting, add and test that schema adapter before setting `schemaVersion:1`. The constructor's `webLogUsers` default is a sample fallback, not an automatically active production namespace. Future rules deployment must select the confirmed project explicitly rather than use an assumed default alias.

The SDK is pinned to Firebase JavaScript SDK **13.0.0**, using the official [modular CDN setup](https://firebase.google.com/docs/web/alt-setup). Google access-token credentials are supported by [GoogleAuthProvider.credential](https://firebase.google.com/docs/reference/js/auth.googleauthprovider#googleauthprovidercredential).

## Data and access

The adapter's default paths are `webLogUsers/{firebaseUid}/entries`, `customLogs`, and `completions`; the root collection is configurable, and existing schemas must be mapped before use. Connecting and listening create no documents. The repository verifies that the authenticated Firebase Google provider ID matches the primary Google account's `sub` before listening or writing. Rules require that Firebase UID and the authenticated Google provider. Unknown document fields, tokens, and account metadata are omitted by the shared log model. Quick-add definition creation uses a transaction that retains an existing record unchanged; deliberate manager edits use normal saves.

Entry and completion rules validate their complete schemas. Custom-log rules validate the outer definition schema and its maximum 500-item list. Firestore rules cannot iterate over arbitrary nested lists, so every custom item is additionally validated by the shared model on **both** writes and reads; malformed remote definitions produce a visible error. Custom definitions are archived with `enabled:false` rather than deleted.

Logs do not fall back to localStorage, browser IndexedDB, or iCloud. Firebase Auth and Firestore use memory-only browser state. Listeners ignore pending-write and cache-only snapshots, and writes resolve only after Firestore acknowledges them; failed saves are reported to the caller and can be retried. Existing iCloud records are outside this integration; existing Firebase records require the confirmed project/schema mapping above and are never silently replaced.

## Local verification

Run the normal Node tests from the website root. Emulator rules tests use fake identities and isolated test records only. With a Java runtime and Firebase CLI available, start the Firestore emulator on port **8085** using this folder's `firebase.json`, then run the emulator test file with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`. Production credentials or cloud data are never needed for emulator verification.
