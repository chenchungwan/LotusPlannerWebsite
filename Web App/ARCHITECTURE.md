# Planner architecture

The planner is composed from reusable widgets and a versioned layout definition. The day layout editor uses a free-position canvas: each widget has its own rectangle, and unused space is preserved. Calendar, task, and log components share state between independent instances and editor previews. Preview controls cannot mutate records.

The Firebase log implementation is present but not connected to production. Confirm the existing Firebase project's public Web configuration and reconcile its current data schema with this adapter before enabling cloud logs or deploying rules. [FIREBASE_SETUP.md](FIREBASE_SETUP.md) documents the proposed setup; its `webLogUsers` namespace must not be assumed to match existing native storage.

## Boundaries

| Layer | Files | Responsibility |
| --- | --- | --- |
| Google services | `auth.js`, `google-api.js` | Authentication, account linking, read-only Calendar and Tasks APIs. No layout knowledge. |
| Cloud log service | `src/services/firebase-logs.mjs` | Primary-owned Firebase Authentication and Firestore subscriptions/writes. Validate reads and writes; publish confirmed server snapshots. No layout knowledge. |
| Shared state | `src/state/planner-store.mjs`, `data-controller.mjs`, `logs-controller.mjs` | Selected day, accounts, loading/error states, and shared data. Share requests/subscriptions across components, cancel older work, and discard stale responses. |
| Pure log model | `src/state/log-model.mjs` | Native log/workout catalogs, sanitized entry/checklist/completion schemas, local calendar-day filtering, rolling workout days, and sleep-duration calculations. |
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

## Log model and native behavior

The native reference is the sibling `LotusPlannerV3/LotusPlannerV3/LotusPlannerV3` source directory. The web model retains native raw workout identifiers and all 78 display labels, while keeping new web records separate from native Core Data/iCloud records.

| Log | Web fields and behavior | Native source reference |
| --- | --- | --- |
| Weight | Positive numeric `weight`, `unit: "lbs"` or `"kg"`, calendar day and clock time; multiple entries per day. Display up to one decimal place, newest clock time first. | `LogsDataModel.swift:33`, `LogsViewModel.swift:259`, `LogsComponent.swift:322` |
| Workout | One of 78 `workoutType` identifiers, trimmed required `name` description, day and time; multiple entries per day. | `LogsDataModel.swift:72`, `LogsViewModel.swift:305`, `AddLogEntryView.swift:141` |
| Food | Trimmed required `name`, day and time; individual entries, displayed in ascending clock order. | `LogsDataModel.swift:365`, `LogsViewModel.swift:340`, `AddLogEntryView.swift:155` |
| Water | Integer `cups` from 0–99 for a selected day. Minus/plus and four quick-set controls update the existing daily record ID; first writes use `water-YYYY-MM-DD`. | `LogsViewModel.swift:383`, `LogsComponent.swift:662` |
| Sleep | Nullable full ISO `bedTime` and `wakeTime`, with at least one set; selected day is separate. Set defaults are previous-day 23:00 and selected-day 08:00. Both set times must have positive elapsed duration; display decimal hours. | `LogsDataModel.swift:410`, `AddLogEntryView.swift:192`, `LogsViewModel.swift:426` |
| Workout days | Count distinct workout dates in the selected day and previous six calendar days, range 0–7. Multiple workouts in a day count once; gaps do not reset the count. No persisted entry of this derived type. | `LogsViewModel.swift:133` |

`validateLogEntry(input)` returns only `{ id, type, day, time }` and the fields for that type. Days are validated `YYYY-MM-DD` strings; clocks are `HH:mm`. Water/sleep default the bookkeeping clock to `12:00` if omitted. Food/workout descriptions are limited to 500 characters. Sleep instants must include a timezone and are normalized to ISO UTC; duration uses actual elapsed time, including daylight-saving changes. The native reversed-time calculation can produce an incorrect duration, so the web form rejects wake times at/before bed times instead of copying that behavior.

`validateCustomLog(input)` returns `{ id, name, enabled, order, items }`, with stable item `{ id, title, enabled, order }` records. Names are bounded to 80 characters, item titles to 160, and each collection to 500 items. Collections have no native two-collection cap. `validateCompletion(input)` returns `{ id, customLogId, itemId, day, completed }`. Unknown fields, Google identities/tokens, fetched data, and server timestamps are stripped from normalized records. `entriesForDay`, `workoutDays`, and `formatSleepDuration` are pure helpers shared by widgets and tests.

Custom collection/item archive is `enabled:false`; restoration reuses the same identities and retains dated completion records. Reordering changes `order` without replacing item IDs. Removing a new unsaved item does not affect persisted history. Multiple All logs or individual log widgets share records rather than creating widget-specific copies.

The web entry dialog handles one log type for the captured selected day. It does not reproduce the native combined Add Logs form or its current-date reset. `createLogEntryDialog({ root, getContext, actions })` exposes `open(type, day, entry?)`, `update(context)`, and `destroy()`. It validates before calling asynchronous `saveEntry(entry)`/`deleteEntry(id)`, preserves edit IDs, retains failed drafts, and requires inline delete confirmation. Pending writes disable fields, duplicate submissions, Cancel, and Escape until acknowledgment. Water edits are inline. `createLogManager` owns an isolated custom-definition draft and saves through `saveCustomLog`; archived definitions remain manageable.

## Cloud log service and controller

`createFirebaseLogsRepository({ config, loadSdk?, rootCollection? })` owns the Firebase SDK and exposes `connect(primary)`, `watchDefinitions(next, error)`, `watchEntries({ from, to }, next, error)`, `watchCompletions(day, next, error)`, `saveEntry`, `deleteEntry`, `saveCustomLog`, `saveCompletion`, and `destroy`. The proposed default paths are `webLogUsers/{firebaseUid}/entries`, `customLogs`, and `completions`.

Connection exchanges the existing primary Google access token for Firebase credentials and verifies the Firebase Google provider subject against the primary account's `sub`. Secondary calendar accounts never change ownership. The adapter serializes identity exchanges, detaches stale listeners, validates document reads and writes, and publishes only confirmed server snapshots rather than optimistic/cache-only snapshots. Writes resolve after Firestore acknowledgment. Review and reconcile the owner rules and proposed document schema with the existing project before deploying them; production connection is still pending.

Firebase Authentication and Firestore use memory-only browser state. There is no log-record fallback in localStorage, IndexedDB, or iCloud, and no automatic native/iCloud import. The native app's built-in logs use Core Data plus CloudKit under its iCloud identity (`LogsViewModel.swift:458`, `Persistence.swift:39`), independently of its linked Google accounts. That native ownership model is not implicitly mapped to Firebase.

`createLogsController({ store, auth, repository })` exposes `start`, `refresh`, `saveEntry`, `deleteEntry`, `saveCustomLog`, `toggleCompletion`, and `destroy`. One set of subscriptions serves every widget: all custom definitions, entries for selected day/prior six days, and selected-day completions. Day or primary-owner changes replace subscriptions and discard stale callbacks. The controller tracks pending writes across components and exposes setup/auth/network errors without substituting records. Completion IDs are deterministic hashes of collection ID, item ID, and day so repeated toggles update one record.

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

Run `node --test 'Web App/tests/'*.test.cjs 'Web App/tests/'*.test.mjs` from the repository root. Tests cover authentication, Google pagination/errors, event placement/DST, event-list date boundaries/deduplication, compact-task filters, placeholder variants, shared fetching/cancellation, layout validation/storage, repeated accounts, independent component lifecycles, and movement without remounting. Log checks cover sanitization, native workout types, sleep/timezone boundaries, rolling workout days, form retry/delete behavior, shared log widgets, custom archive/restore, and Firebase identity/listener/write boundaries. Emulator instructions are in [FIREBASE_SETUP.md](FIREBASE_SETUP.md); production Firebase configuration and schema verification remain outstanding.

Browser checks use isolated sample-data fixtures outside the repository to verify both the default screen and an alternate layout with stacked task panels and two independently configured timelines. Production has no sample-data fallback or test login bypass.
