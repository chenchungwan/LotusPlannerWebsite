# Planner architecture

The planner is composed from reusable widgets and a versioned layout definition. The day layout editor uses a free-position canvas: each widget has its own rectangle, and unused space is preserved. Calendar, task, and log components share state between independent instances and editor previews. Preview controls cannot mutate records.

Cloud logs use the user-confirmed existing **Pocky Apps** Firebase project, `life-planner-f0134`, through its original `users/{firebaseUid}` records. The public registration and source schema are configured; production-domain authorization and live sign-in/write verification are still in progress. [FIREBASE_SETUP.md](FIREBASE_SETUP.md) records the remaining setup. Existing Pocky records are adapted in place, not copied into a new dataset.

## Boundaries

| Layer | Files | Responsibility |
| --- | --- | --- |
| Google services | `auth.js`, `google-api.js` | Authentication, account linking, read-only Calendar and Tasks APIs. No layout knowledge. |
| Cloud log service | `src/services/firebase-logs.mjs`, `pocky-logs.mjs`, `pocky-log-mapping.mjs` | Primary identity verification, existing Pocky record mapping, and targeted Firestore transactions/subscriptions. Publish confirmed server snapshots. No layout knowledge. |
| Shared state | `src/state/planner-store.mjs`, `data-controller.mjs`, `logs-controller.mjs` | Selected day, accounts, loading/error states, and shared data. Share requests/subscriptions across components, cancel older work, and discard stale responses. |
| Pure log model | `src/state/log-model.mjs` | Canonical view/write schemas, local calendar-day filtering, rolling workout days, and sleep-duration calculations. Pocky settings supply its editable workout catalog. |
| Reusable widgets | `src/components/timeline.mjs`, `event-list.mjs`, `account-tasks.mjs`, `logs.mjs`, `placeholders.mjs` | Render supplied state/options and emit actions. No authentication, fetches, storage, global DOM lookups, or assumptions about neighboring panels. |
| Layout | `src/layout/layout-model.mjs`, `canvas-geometry.mjs`, `layout-renderer.mjs`, `widget-registry.mjs` | Validate/save layouts, prevent overlaps, resolve account bindings, arrange, update, and dispose independent widget instances. |
| Editor | `src/components/layout-editor.mjs`, `layout-editor.css` | Edit an isolated draft, provide palette/drag/resize controls, validate placements, and save through the composition root. |
| App frame and dialogs | `src/components/planner-chrome.mjs`, `account-dialogs.mjs`, `log-entry-dialog.mjs`, `log-dialogs.mjs` | Sidebar, top navigation, account dialogs, entry forms, and custom checklist management. Emit actions through injected callbacks. These stay outside the user-designed content area. |
| Composition root | `planner.js` | Connect the services, state, frame, and layout. Own session checks and application teardown. |

Browser ES modules keep these boundaries explicit without introducing a build tool or framework requirement.

## Component contract

A widget factory receives `{ id, options, actions }` and returns:

- `element`: its scoped root element, filling the frame assigned by the layout.
- `update(context)`: render the supplied planner state.
- `tick(context)`: optional lightweight clock update.
- `destroy()`: remove owned elements/listeners and cancel component-local deferred work.

Each widget has its own DOM references and scroll position. Multiple timelines or task panels can coexist, including two panels showing the same underlying account with different filters. A component's identity remains stable when moved to a different column. Changing its options replaces only that instance. Widgets request actions; they never own Google tokens or issue requests.

The context contains selected `day`, `accounts`, Google `results` by subject, `googleReady`, `linking`, default `showCompleted` and `taskDateFilter` preferences, cloud `customLogs` definitions, and `logs: { status, error, entries, completions, saving }`. Log status is `loading`, `ready`, `unconfigured`, or `error`. The composition root merges legacy name-only layout references into the display context without treating them as cloud records. A widget may override display preferences through its options.

## Component library

`getWidgetCatalog(accounts, customLogs)` supplies categorized, searchable palette entries, default sizes, and serializable options. Multiple entries can use the same factory with different options: goal orientation, graph period, log type, or linked task account. `getWidgetLabel` gives editor frames the corresponding component label.

| Type | Options beyond an optional `title` | Behavior |
| --- | --- | --- |
| `timeline` | `accountIds`, `hourHeight`, `initialHour` | Google events on the daily timeline. |
| `events-list` | `accountIds` | The selected day's all-day events first, then timed events; shared events are deduplicated. |
| `account-tasks` | `accountId`, `taskListIds`, `showCompleted`, `dateFilter` | Tasks grouped by Google task list. |
| `compact-tasks` | Same as `account-tasks` | One flat list, with source-list labels on individual tasks. |
| `journal` | — | Empty journal placeholder. |
| `logs-group` | — | Editable built-in logs, derived Workout days, and enabled custom checklists together. |
| `log` | `logType`; for custom logs, `customLogId` and optional `customLogName` | One built-in log, derived metric, or custom checklist using the same shared records as All logs. |
| `goals` | `orientation: "vertical"` or `"horizontal"` | Empty progress-bar placeholders. |
| `weight-graph` | `period: "week"`, `"month"`, or `"year"` | Empty graph with date labels based on the selected day. |

Built-in log types are `sleep`, `weight`, `workout`, `workout-streak`, `food`, and `water`. `workout-streak` is the stable saved option name; its UI label is **Workout days**, a derived rolling seven-day count. Entry mutations and checklist completions require ready cloud state and no pending write; Manage logs can still show collection names before connection. Journal, goals, and weight graphs remain explicit placeholders with no invented entries or progress. Future implementations can replace their factories without changing saved placements.

An optional layout-level `customLogs: [{ "id": "stable-id", "name": "Mood" }]` field contains presentation metadata only. Actual collection/item definitions and dated completions belong to the cloud log repository. The editor merges cloud names and draft references for its palette; cloud definitions take precedence. Saving a newly created editor name explicitly creates an empty cloud definition before saving its layout. It never replaces an existing cloud checklist with name-only metadata. Legacy names remain empty display references until explicitly saved through Manage logs. Resetting the arrangement or starting blank preserves editor references; Cancel discards draft changes. There is no fixed collection count.

## Canonical log model and existing Pocky data

The production source contract is the sibling Pocky app: [cloud record mapping](../../Pocky/public/cloud.js), [web tracker actions](../../Pocky/public/app.js), [iPad tracker model](../../Pocky/iPad/Pocky/Trackers.swift), and [routine settings writes](../../Pocky/iPad/Pocky/SettingsEdits.swift). iOS uses the same tracker schema. This differs from the separate LotusPlannerV3 Core Data/iCloud implementation; connecting the Pocky project does not import those iCloud records.

`pocky-log-mapping.mjs` supplies pure `decodeDay`, `decodeSettings`, `decodeDefinitions`, and `decodeCompletions` helpers. Views receive a canonical model while the repository retains original raw records for safe edits.

| Canonical view | Existing Pocky storage and mapping |
| --- | --- |
| Weight | `trackerDays/{day}.weights:[{id,value,unit,createdAt}]`. `value` becomes `weight`; `lb` becomes the UI label `lbs`; `kg` is unchanged. Multiple entries and original IDs are retained. |
| Workout | Day `workouts:[{id,type,text,createdAt}]`. `type` becomes `workoutType`, `text` becomes `name`. Types are editable in `meta/settings.trackerSettings.workoutTypes`, including custom/archived historical IDs. A selected type may have an empty description; a description-only entry may have no type. |
| Food | Day `food:[{id,text,createdAt}]`; `text` becomes `name`. Multiple original IDs remain distinct. |
| Legacy wake | Day `wake:'HH:mm'` becomes a sleep view with virtual ID `wake:YYYY-MM-DD`. Its ISO wake instant is derived from that local calendar day. Optional day `lotusWake:{bedTime,wakeTime,time}` retains explicitly added bed-time/precise-time metadata. If another Pocky client changes the raw clock, that clock wins; impossible chronology is reported. |
| New Sleep | Additive day `sleep:[{id,bedTime,wakeTime,time,...}]`. These independent entries do not overwrite or project the legacy wake field. Sleep needs a bed time or wake time; both set requires wake after bed. |
| Water | Additive day `water:{id,cups,time,...}`, one total from 0–99. Existing IDs are reused; a missing legacy ID gets a stable virtual route. |
| Workout days | Distinct workout dates in the selected day and prior six calendar days, range 0–7. No derived record is persisted. |

Canonical entries contain `{id,type,day,time}` plus type-specific fields. Decoded records also carry `source:{day,kind,rawId}` to identify the original day and array/field during edit or delete. Source kinds are `weights`, `workouts`, `food`, `sleep`, `water`, and `wake`. Valid explicit clocks win; otherwise the mapper uses local time from `createdAt`, then `12:00`. The original day key is retained even when creation happened on a different date. Existing IDs, `createdAt`, unknown metadata, and unrelated fields are not rewritten by decoding.

`validateLogEntry` returns sanitized fields for the selected type. Days are real `YYYY-MM-DD` strings and clocks are `HH:mm`. Weight is positive; water is an integer from 0–99. Workout/food descriptions have a 500-character limit. Sleep timestamps include a timezone and normalize to ISO UTC; elapsed duration respects daylight-saving changes. Canonical validation does not turn the Pocky schema into a new set of stored entry documents.

## Custom checklists and grouping

Pocky stores one flat set of routines at `users/{uid}/routines/{routineId}`:

```js
{ id, name, order, archived, createdAt }
```

The virtual collection **`pocky-routines`** displays these original IDs as checklist items. Canonical `item.title` maps to routine `name`; `item.enabled` is the inverse of `archived`; item order maps directly to routine `order`. Archive preserves the routine and all historical checks. Restore reuses its ID. Removing a newly added unsaved row affects only the draft.

Additional Lotus collections use `users/{uid}/lotusLogCollections/{collectionId}` metadata `{name,enabled,order}` and a routine's optional `lotusCollectionId`. This references the same routine document; it does not duplicate items or dated checks. Missing group metadata falls back to Routines instead of hiding a row. The virtual collection may also have explicit name/visibility metadata without moving its original items. Other Pocky clients continue to show the routines as one flat checklist.

Dated completion stays in the existing day map:

```js
// users/{uid}/trackerDays/YYYY-MM-DD
{ routines: { routineId: true } }
```

Unchecking removes only that key. Canonical completion records are view objects `{id,customLogId,itemId,day,completed}`; their IDs are deterministic and are not separate Firestore completion documents. Archived and orphaned historical keys are retained on read. No migration or copy is performed when connecting.

`validateCustomLog` validates the manager's canonical draft `{id,name,enabled,order,items}`. Names are bounded to 80 characters; item titles to 160; a saved collection can contain up to 500 items. There is no fixed number of collections. The repository maps the draft onto existing routine documents and collection metadata, preserving identifiers and existing fields. Manager Save is explicit; Cancel leaves cloud definitions unchanged.

Layout-level `customLogs:[{id,name}]` remains local presentation metadata. The composition root merges cloud definitions first and uses unmatched legacy names only as empty display references. Cloud names/items win. Existing legacy names are not silently converted into records. The editor's explicit quick-add creates only a new empty group on Save through a create-if-absent operation; existing cloud routines/items are not replaced by name-only layout data. Resetting or clearing layout geometry does not reset cloud definitions.

## Cloud identity, service, and controller

`createFirebaseLogSession` in `firebase-logs.mjs` handles SDK initialization and verified ownership. The composition root passes it to `createPockyLogsRepository({session})`. The production configuration is explicitly `schema:'pocky'`, `schemaVersion:1`, `rootCollection:'users'`, with project `life-planner-f0134`. The generic repository remaining in `firebase-logs.mjs` supports isolated fixtures; its `webLogUsers` paths are not used by the production planner.

The first connection attempts the existing primary Calendar/Tasks Google access token. Calendar OAuth still belongs to `neon-concord-448921-g1`; Firebase belongs to `life-planner-f0134`. If that cross-project token cannot complete Firebase authentication, a direct **Connect Google** click opens Pocky's Firebase Google popup for identity/profile authorization. It requests no additional Calendar/Tasks scopes. The returned Firebase Google provider subject must match the primary account's `sub`. The adapter then uses that account's existing Firebase UID under `users/{uid}`. Secondary linked accounts never become log owners. Choosing a different account is rejected and signed out.

Firebase Auth and Firestore use memory-only browser state. Identity exchanges are serialized; account changes dispose stale listeners. Confirmed server snapshots are published; cache-only and pending-write snapshots are not substituted for confirmed data. Failed writes remain visible and retryable. No localStorage/IndexedDB log-record fallback exists.

The Pocky repository exposes connection/authorization, settings/definition/entry/completion watches, entry saves/deletes, custom-definition saves/create-if-absent, completion saves, and teardown. It subscribes to `trackerDays`, `routines`, `meta/settings`, and additive `lotusLogCollections`; no copied `entries`, `customLogs`, or `completions` collection is created. Settings include Pocky's weight unit and editable workout labels/colors rather than requiring the separate native app's fixed catalog.

Writes use transactions that reread current source documents and change the intended values while retaining unrelated data. Updating a routine check preserves other check-offs, weights, workouts, food, and wake/sleep/water fields. Definition removal archives routines rather than deleting historical completion keys. Existing Pocky clients can still replace a whole day from an older local snapshot, so simultaneous legacy-client edits can have last-writer-wins races; Lotus transactions cannot change those older clients' behavior.

Existing Pocky owner-prefix rules cover the user-owned paths and additive metadata. The checked-in generic `firestore.rules` is a test example, not Pocky's production ruleset; no full rules deployment is required or authorized by this adapter. Both Lotus production domains were authorized in Firebase Authentication on October 17, 2026, with user approval; localhost remains authorized. Live production reads/writes are not yet claimed as verified; see [FIREBASE_SETUP.md](FIREBASE_SETUP.md).

`createLogsController({store,auth,repository})` shares data across all widget instances. It watches definitions/settings, entries for the selected day/prior six days, and selected-day completions. Day or primary-owner changes replace subscriptions and discard stale callbacks. `authorize()` keeps the Firebase popup in the user's click call stack. Pending writes are reflected across all components; setup/auth/network errors do not substitute sample records.

The entry dialog captures its selected day, preserves IDs/source routes, validates before asynchronous Save/Delete, retains failed drafts, and requires inline delete confirmation. Pending writes disable duplicate submissions, fields, Cancel, and Escape. `createLogManager` edits independent collection/item definition drafts, retains archived items, and shares the same cloud records with every log widget.

## Free-position canvas, version 2

The editor saves a single day template for the signed-in user. Coordinates and sizes are logical CSS pixels; there is no snap grid or automatic packing. All widgets stay inside the canvas and may touch edges without overlapping. Empty canvases and deliberate white space are valid.

```json
{
  "version": 2,
  "id": "daily",
  "name": "My day",
  "canvas": { "width": 1280, "height": 900 },
  "widgets": [
    { "id": "timeline", "type": "timeline", "x": 30, "y": 20, "width": 300, "height": 700, "options": { "accountIds": "all" } },
    { "id": "tasks", "type": "account-tasks", "x": 380, "y": 60, "width": 420, "height": 500, "options": { "accountId": "$primary", "dateFilter": "day-overdue" } }
  ]
}
```

Pure geometry helpers validate placement and calculate moves, corner resizes, and free starting positions. Schema validation independently checks bounds, minimum dimensions, and every rectangle pair before a layout can be saved. Invalid final pointer positions are rejected; widgets are not pushed aside or compacted.

Moving/resizing a widget changes its frame without remounting the underlying component. Narrow windows scroll the saved canvas rather than rearranging it and losing intended space. Editor zoom affects presentation only; stored coordinates remain unchanged.

Existing column layouts remain supported. `createCanvasLayout` converts a version 1 definition into explicit free-position widgets when the user starts designing. Linked-account repeaters become concrete widgets; adding another linked account later makes its Tasks component available in the palette and leaves the saved design in the user's control.

Task components support `dateFilter: "day"`, `"day-overdue"`, or `"all"`. The app default is `day-overdue`: incomplete tasks due on/before the selected day, excluding undated tasks. Completed overdue tasks are omitted; completed tasks on the selected day follow the completion-visibility setting. Google Tasks due dates are calendar dates, not local timestamp instants.

## Legacy column definition, version 1

A layout has a name and ordered columns. Columns can use a fixed width or proportional size, and contain one or more stacked widgets. Widgets can use a fixed height or proportional share of their column.

```json
{
  "version": 1,
  "id": "my-day",
  "name": "My day",
  "columns": [
    {
      "id": "focus",
      "size": 2,
      "widgets": [
        {
          "id": "work-tasks",
          "type": "account-tasks",
          "options": {
            "accountId": "$primary",
            "title": "Focus",
            "showCompleted": false
          }
        }
      ]
    },
    {
      "id": "calendar",
      "width": 320,
      "widgets": [
        {
          "id": "my-timeline",
          "type": "timeline",
          "options": {
            "accountIds": "all",
            "hourHeight": 64,
            "initialHour": 8
          }
        }
      ]
    }
  ]
}
```

Column order and widget order are presentation choices. IDs are stable identities: column IDs must be unique, and widget IDs must be unique across a layout. Reordering a widget does not change its ID. Account-repeated instances also include the Google subject in their runtime identity.

`repeat: "accounts"` on a column repeats its widgets once per linked account. In that column, `$account` binds to the repeated account. `$primary` and `$secondary` bind to the account roles; concrete Google subjects bind to a particular linked account. A missing task account produces a hidden widget. Timeline `accountIds: []` intentionally selects no accounts.

Widget options are shared with the version 2 component library above.

The layout layer controls placement and dimensions. Component styles control the contents of each panel. On narrow screens, columns stack in saved order and each panel remains independently usable.

## Persistence and recovery

`createLayoutRepository` saves validated version 1 or 2 presentation settings under the existing `lotus.layout.v1.<Google subject>` browser key for backward compatibility. Layout storage contains geometry/options and optional custom name/ID references, not entry values, checklist items/completions, Google tokens, or fetched data. Unknown fields are discarded before saving. Invalid, corrupt, or unsupported definitions fall back to the default without overwriting the original saved data.

The editor keeps changes in a draft until Save calls the composition root’s `actions.saveLayout(definition)`. New custom names require successful explicit cloud creation before the local layout is applied. Storage errors leave the draft open and visible. Cancel discards the draft. Moving/resizing or previewing components does not refetch Google data or change calendar/task/log records.

Cross-device layout synchronization, a multi-template library, and independently saved breakpoint layouts are future work. The local layout repository and cloud log repository have separate contracts. Future component types can join the registry and palette while using the same canvas geometry.

## Adding a feature

1. Add a data operation to the service/controller if shared data is required.
2. Implement a component using the widget contract and scoped DOM.
3. Register its factory in `widget-registry.mjs` and its serializable option schema in `layout-model.mjs`.
4. Add its palette metadata to `getWidgetCatalog` so the editor can place/configure it in a layout definition. Keep display logic out of the layout renderer.
5. Verify multiple instances, movement, option changes, disposal, and shared fetching.

## Verification

Run `node --test 'Web App/tests/'*.test.cjs 'Web App/tests/'*.test.mjs` from the repository root. Tests cover authentication, Google pagination/errors, event placement/DST, event-list date boundaries/deduplication, compact-task filters, placeholder variants, shared fetching/cancellation, layout validation/storage, repeated accounts, independent component lifecycles, and movement without remounting. Log checks cover Pocky schema conversion, custom workout settings, original IDs/source routes, legacy wake metadata, sleep/timezone boundaries, rolling workout days, shared log widgets, form retry/delete behavior, custom archive/restore, and Firebase identity/listener/transaction boundaries. Emulator guidance is in [FIREBASE_SETUP.md](FIREBASE_SETUP.md); production-domain authorization and live verification remain outstanding.

Browser checks use isolated sample-data fixtures outside the repository to verify both the default screen and an alternate layout with stacked task panels and two independently configured timelines. Production has no sample-data fallback or test login bypass.
