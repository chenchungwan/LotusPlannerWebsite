# Planner architecture

The planner is composed from reusable widgets and a versioned layout definition. The day layout editor uses a free-position canvas: each widget has its own rectangle, and unused space is preserved. Calendar and task components are shared between editor previews and the saved day view.

## Boundaries

| Layer | Files | Responsibility |
| --- | --- | --- |
| Google services | `auth.js`, `google-api.js` | Authentication, account linking, read-only Calendar and Tasks APIs. No layout knowledge. |
| Shared state | `src/state/planner-store.mjs`, `data-controller.mjs` | Selected day, accounts, loading/error states, and shared data. Fetch each account/service once per refresh, cancel older requests, discard stale responses. |
| Reusable widgets | `src/components/timeline.mjs`, `account-tasks.mjs` | Render only supplied state/options. No authentication, fetches, storage, global DOM lookups, or assumptions about neighboring panels. |
| Layout | `src/layout/layout-model.mjs`, `canvas-geometry.mjs`, `layout-renderer.mjs`, `widget-registry.mjs` | Validate/save layouts, prevent overlaps, resolve account bindings, arrange, update, and dispose independent widget instances. |
| Editor | `src/components/layout-editor.mjs`, `layout-editor.css` | Edit an isolated draft, provide palette/drag/resize controls, validate placements, and save through the composition root. |
| App frame | `src/components/planner-chrome.mjs`, `account-dialogs.mjs` | Sidebar, top navigation, and account dialogs. Emit actions through injected callbacks. These stay outside the user-designed content area. |
| Composition root | `planner.js` | Connect the services, state, frame, and layout. Own session checks and application teardown. |

Browser ES modules keep these boundaries explicit without introducing a build tool or framework requirement.

## Component contract

A widget factory receives `{ id, options, actions }` and returns:

- `element`: its scoped root element, filling the frame assigned by the layout.
- `update(context)`: render the supplied planner state.
- `tick(context)`: optional lightweight clock update.
- `destroy()`: remove owned elements/listeners and cancel component-local deferred work.

Each widget has its own DOM references and scroll position. Multiple timelines or task panels can coexist, including two panels showing the same underlying account with different filters. A component's identity remains stable when moved to a different column. Changing its options replaces only that instance. Widgets request actions; they never own Google tokens or issue requests.

The current context contains the selected `day`, `accounts`, shared `results` by Google subject, `googleReady`, `linking`, and the default `showCompleted` preference. A widget may override display preferences through its options.

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

Timeline options: `title`, `accountIds`, `hourHeight`, `initialHour`.
Task options: `title`, `accountId`, `taskListIds`, `showCompleted`, `dateFilter`.

The layout layer controls placement and dimensions. Component styles control the contents of each panel. On narrow screens, columns stack in saved order and each panel remains independently usable.

## Persistence and recovery

`createLayoutRepository` saves validated version 1 or 2 presentation settings under the existing `lotus.layout.v1.<Google subject>` browser key for backward compatibility. Layout storage is separate from Google account tokens and fetched data. Unknown fields are discarded before saving. Invalid, corrupt, or unsupported definitions fall back to the default without overwriting the original saved data.

The editor keeps changes in a draft until Save calls the composition root’s `actions.saveLayout(definition)`. Storage errors leave the draft open and visible. Cancel discards the draft. Editor actions do not refetch Google data or change calendar/task records.

Cross-device synchronization, a multi-template library, and independently saved breakpoint layouts are future work. Browser persistence is the first adapter; a future backend can implement the same repository contract. Future component types can join the registry and palette while using the same canvas geometry.

## Adding a feature

1. Add a data operation to the service/controller if shared data is required.
2. Implement a component using the widget contract and scoped DOM.
3. Register its factory in `widget-registry.mjs` and its serializable option schema in `layout-model.mjs`.
4. Add its palette metadata to `getWidgetCatalog` so the editor can place/configure it in a layout definition. Keep display logic out of the layout renderer.
5. Verify multiple instances, movement, option changes, disposal, and shared fetching.

## Verification

Run `node --test 'Web App/tests/'*.test.cjs 'Web App/tests/'*.test.mjs` from the repository root. Tests cover authentication, Google pagination/errors, event placement/DST, shared fetching/cancellation, layout validation/storage, repeated accounts, independent component lifecycles, and movement without remounting.

Browser checks use isolated sample-data fixtures outside the repository to verify both the default screen and an alternate layout with stacked task panels and two independently configured timelines. Production has no sample-data fallback or test login bypass.
