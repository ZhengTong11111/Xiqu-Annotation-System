# State Architecture Notes

This branch starts the migration from `App.tsx` as a single state hub toward a document-oriented state layer that can support autosave, version restore, remote sync, and collaboration.

## Current Boundary

`src/state/projectDocumentState.ts` owns the durable project document boundary:

- `project`: the editable `ProjectData` document.
- `trackSnapEnabled`: persisted timeline UI state that travels with project saves.
- `undoStack` / `redoStack`: local version restore for committed document changes.
- `hasUnsavedChanges`: derived from the saved baseline plus track snap state.
- `operationLog`: append-only local operation records.
- `pendingOperations`: operations not yet acknowledged by a save or future sync backend.
- `syncState`: local revision, saved revision, pending count, sync status, and timestamps.

Transient interaction state stays local to UI components. For example, `Timeline.tsx` should keep hover state, pointer drag state, RAF throttling, and preview-frame refs inside the component. Those are high-frequency UI concerns, not collaborative document state.

## Commit Contract

Use `commitProject()` for completed document changes. It records history, clears redo, updates the document, increments `localRevision`, and adds a pending operation.

Use `applyProjectWithoutHistory()` for transient drag updates. It preserves the pre-drag document in `transientProjectRef` and does not create sync operations for every pointer frame.

Use `markProjectAsSaved()` after a project file save or future successful autosave. It advances the saved baseline, acknowledges pending operations, and resets the sync status to `saved`.

Use `applyTrackSnapEnabledState()` for track snap UI state. Pass `{ recordOperation: false }` only for normalization/migration updates that should not become user operations.

## Future Autosave

Autosave should watch `pendingOperations` and `syncState.status`.

Recommended flow:

1. When `pendingOperations.length > 0`, debounce an autosave request.
2. Send `{ project, uiState, baseRevision, operations }` to the backend.
3. Set `syncState.status` to `saving` while the request is in flight.
4. On success, call `markProjectAsSaved(project, trackSnapEnabled)`.
5. On network failure, set status to `offline` and keep `pendingOperations`.
6. On server rejection/version mismatch, set status to `conflict` and keep the local pending queue intact.

The current file-save path already calls `markProjectAsSaved()`, so future autosave should reuse that same acknowledgement boundary.

## Future Collaboration

The operation log is intentionally explicit, but current operations still include full before/after project snapshots. That is enough for local recovery and database autosave experiments, but real-time collaboration should gradually replace broad `project.commit` operations with domain commands such as:

- `character.updateTiming`
- `character.updateText`
- `action.create`
- `track.rename`
- `timeline.deleteItems`
- `attachedPoint.move`

Those commands should include stable IDs, base revision, actor ID, and minimal payloads. The UI should continue to call high-level domain functions in `App.tsx` while the state layer translates them into syncable operations.

## Conflict Policy

For database autosave, use optimistic concurrency first:

- The client sends its `baseRevision` and current `localRevision`.
- The server accepts if the base matches the stored project revision.
- If the base does not match, the client enters `conflict`.

For true simultaneous editing, introduce a CRDT or operation-transform layer later. Do not try to merge arbitrary full `ProjectData` snapshots once multiple editors can change the same timeline range.

## Migration Direction

Good next extractions:

- Move project normalization/import-save helpers from `App.tsx` into a persistence module.
- Move paste/cut/copy conflict logic into a clipboard module.
- Move project mutation functions into command modules that return `{ project, operation }`.
- Keep timeline drag math in `Timeline.tsx` or a timeline interaction utility until its public contract is smaller.
