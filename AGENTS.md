# Repository Guidelines

## Product Intent
This repository is evolving from a local React/TypeScript annotation workstation into a full Kunqu multimodal academic database and classroom annotation platform. It now includes the original timeline editor plus a real Fastify/Prisma/PostgreSQL platform backend for accounts, a hierarchical resource tree, media files, mutable annotation files, recovery snapshots, and per-resource account permissions.

The editor remains a research-oriented workstation for aligning video, sentence-level SRT, character-level timing, singing-style labels, action tracks, point annotations, audio cues, Banyan beat/eye information, Gongche notation, and recursive custom-track branches. SRT remains an important exchange format for subtitle-like tracks: sentence SRT in, editable TypeScript state in the app, per-track SRT out.

This is not a generic subtitle editor. It behaves more like a compact DAW / NLE / annotation workstation:
- precise time-axis editing
- cross-linked text/action/media annotation
- strong local editing UX
- future-facing state architecture for sync/collaboration

## Current Repository Status
Main currently contains all major recent feature lines that matter for context:
- desktop-style workbench layout
- detachable preview and timeline panes
- dynamic tracks + reorderable active track model
- attached point tracks
- import/merge project workflow
- DAW-style loop range playback
- spectrogram preview + settings
- Gongche attached-track workflow and renderer
- Gongche glyph preview is currently marked finished for research/demo use, but the glyph font must be replaced or licensed before release
- Banyan beat/eye parsing, track display, editing, and global vertical guide rendering
- platform login/resource-explorer UI, local editor entry, media upload, project/folder/file management, JSON import, revision-checked server save, recovery snapshots, and per-resource account permissions
- Fastify API backed by Prisma 7 and PostgreSQL, with local storage under `data/` or an S3-compatible backend
- backend audit logs and annotation operation logs for the first platform-governance layer
- version 1 timing, stable content-update, lifecycle, and dependency-transaction domain commands with strict shared validation,
  draft persistence, inverse/precondition semantics, all-or-nothing ProjectData adapters, server logging, and clean-client
  HTTP replay; lifecycle covers sentences, characters, custom blocks, attached points, and complete Gongche blocks, while
  transactions atomically bind sentence synchronization and parent/Gongche cascades. Server-side application is not implemented yet
- per-file operation acceptance sequence plus snapshot-committed operation facts and separate bounded feeds; clean web
  sessions now perform bounded HTTP catch-up, atomically replay complete mixed domain-command chains, and fall back to the
  authoritative snapshot for incomplete or non-replayable evidence
- project document state architecture (`src/state/projectDocumentState.ts`)
- versioned browser recovery drafts for writable platform files, isolated by account/file and recoverable only against
  the same server revision
- writable platform-file autosave with idle scheduling, single-flight snapshots, online recovery, and bounded retry
- recursive custom-track branching with merged/expanded display modes, per-track/per-branch colors, and filled overlap layout for conflicting blocks

If starting a new conversation, assume the repo is already beyond the earlier simple waveform-only stage.

## Directory & Ownership Map
- `src/App.tsx`
  - main orchestrator
  - wires together project state, playback state, import/export, clipboard, selection, context menu, loop range, spectrogram settings, detached windows, and inspector actions
- `src/platform/PlatformWorkspace.tsx`
  - platform login/resource-explorer/editor switch and local editor entry
  - owns the single authoritative annotation-file open path; ordinary opens and comparison navigation both refetch
    the latest payload, revision, and permissions before creating one `PlatformEditorSession`
  - resolves browser recovery drafts before editor construction; selective merge must not bypass an unresolved draft
  - editor save-conflict handoff refetches the latest file and flushed IndexedDB draft before leaving the dirty editor
- `src/platform/platformProjectPayload.ts`
  - single platform client/server payload boundary for adding current protected media URLs and removing them before save
- `src/platform/platformDraft.ts`
  - versioned, unknown-input-validated browser draft envelope and recovery compatibility rules
  - persists one sanitized project pair plus compact operations; it never stores access tokens, Blob URLs, or
    per-operation project snapshots
- `src/platform/platformDraftStore.ts`
  - `idb`-backed IndexedDB repository keyed by encoded account id and annotation-file id
- `src/platform/usePlatformDraftPersistence.ts`
  - serialized/debounced draft writes, editor-unmount final capture, and clean-state deletion for writable sessions
  - must suspend all put/delete while any runtime merge draft is awaiting the editor's second confirmation
  - `flushNow()` must use the same task queue as debounce/unmount writes; conflict UI must never issue a parallel store put
- `src/platform/platformAutoSavePolicy.ts`
  - pure idle/retry/block decision and bounded exponential-backoff constants for server autosave
- `src/platform/platformAutoSaveRuntime.ts`
  - testable timer, single-flight, online-resume, retry, disposal, and unexpected-save-error coordinator
  - consumes policy decisions and save outcomes; it never owns project payloads, revisions, operations, or IndexedDB
- `src/platform/usePlatformAutoSave.ts`
  - thin React facts/callback adapter around one `PlatformAutoSaveRuntime`
  - Strict Effects cleanup must dispose and clear the runtime ref so the second setup creates a live instance
- `src/platform/platformOperationCatchUp.ts`
  - pure bounded committed-feed reader, revision-continuity validator, and all-or-nothing known-command replay planner
  - malformed pages, revision gaps, legacy operations, pagination overflow, and precondition failures require a snapshot
- `src/platform/platformOperationCatchUpRuntime.ts`
  - owns the HTTP catch-up timer, single-flight request, retry delay, session generation, and disposal behavior
  - a stale file response must never apply or recreate a timer for a later editor session
- `src/platform/usePlatformOperationCatchUp.ts`
  - thin React facts/callback adapter; App owns snapshot hydration and document replacement gating
- `src/platform/PlatformDraftRecoveryDialog.tsx`
  - explicit same-revision recovery, stale comparison entry, and read-only export-or-discard decision before opening editor
- `src/platform/PlatformDraftConflictDialog.tsx`
  - fixed local-draft-left/server-current-right structured review; it cannot treat the browser draft as a resource file
- `src/platform/platformDraftConflict.ts`
  - pure authoritative reread validation and fixed-direction stale-draft merge preparation
  - rejects changed draft/server identities, revisions, permissions, selections, conflicts, or plan fingerprints
- `src/platform/ResourceExplorer.tsx`
  - desktop-style three-pane resource manager
  - owns folder navigation, view switching, selection, keyboard actions, import/upload, and the resource Inspector
  - the Inspector is the canonical UI for editing each account's direct permissions on the selected resource
- `src/platform/AuditLogDialog.tsx`
  - standalone global-admin audit browser with draft/applied filters, stable incremental loading, and server-side CSV export
  - resource-scoped non-admin access is supported by the API contract but is not a substitute for the Inspector permission UI
- `src/platform/auditLogView.ts`
  - exhaustive Chinese audit-action labels plus deleted-resource/user fallbacks and bounded detail formatting
- `src/platform/ResourceRecoveryHistory.tsx`
  - annotation-file Inspector recovery-history list, read-only snapshot detail, safe restore, and snapshot/current comparison entry
  - loads lightweight summaries first, requests one full snapshot payload only after explicit selection, and refetches the
    current annotation file when comparison starts rather than trusting stale Inspector metadata
- `src/platform/AnnotationConfirmationPanel.tsx`
  - platform-editor governance panel for browsing, creating, navigating to, and revoking confirmed annotation ranges
  - uses the existing loop range as an explicit review range; it must not edit `ProjectData` or replace the content Inspector
- `src/platform/useAnnotationConfirmations.ts`
  - authoritative client-side list/create/revoke lifecycle for one open annotation file
  - rejects stale async responses across file switches and refreshes after mutations instead of optimistically inventing facts
- `src/platform/annotationConfirmationView.ts`
  - pure labels, persisted-track options, lifecycle/freshness view records, create blockers, revoke visibility, and interval layout
  - Timeline and panel must consume this module instead of duplicating confirmation state or target formatting
- `src/platform/recoverySnapshotPreview.ts`
  - pure, failure-contained conversion from unknown historical payload to a current-format multimodal summary
  - reuses `normalizeImportedProjectFile()`; do not create a second project migration path for snapshot previews
- `src/platform/recoverySnapshotComparison.ts`
  - pure fixed-direction comparison with historical snapshot on the left and current annotation file on the right
  - delegates normalization and stable-id matching to `buildAnnotationDiff()`; it has no restore, merge, or network behavior
- `src/platform/annotationDiff.ts`
  - pure stable-id structured comparison for two normalized annotation payloads
  - owns research-domain matching and left/right time ranges; UI must not re-diff raw payloads
  - one successful build also returns both normalized projects for the merge planner; this is runtime comparison state,
    not a second migration path or saved document state
- `src/platform/annotationDiffTimeline.ts`
  - pure time-index, filter, range validation, coordinate, and hit-test model derived only from structured diff
  - preserves one shared duration while filters change; invalid or untimed differences never enter Canvas as fake ranges
- `src/platform/AnnotationDiffTimelineOverview.tsx`
  - high-DPI read-only Canvas for left/right diff distribution; does not load files or own editor state
- `src/platform/AnnotationDiffReview.tsx`
  - shared read-only summary, warnings, filters, Canvas timeline, domain groups, and entry navigation used by ordinary-file
    and recovery-snapshot comparisons
  - extension slots may add ordinary-file merge controls, but this component must not learn merge, restore, or persistence
    semantics
- `src/platform/AnnotationComparisonDialog.tsx`
  - owns parallel side-isolated reads, stale-response protection, left/right swapping, ordinary-file open commands, and
    composition of the shared read-only diff review
  - delegates selective-merge selection and explicit conflict decisions to the shared merge review, and never writes a file
  - comparison must not instantiate a second editable Timeline inside the dialog
- `src/platform/AnnotationMergeDiffReview.tsx`
  - shared direction/selection/dependency-plan/conflict-decision UI for ordinary-file and stale-browser-draft integration
  - receives a prepared diff model and emits user intent only; it must not read resources, IndexedDB, or editor state
- `src/platform/RecoverySnapshotComparisonDialog.tsx`
  - composes the shared read-only diff review with fixed snapshot-left/current-right metadata
  - only the current-file side can open in the editor; there is no swap or selective-merge surface
- `src/platform/annotationComparisonNavigation.ts`
  - pure validation and normalization from one diff entry's real left/right time range to a one-shot editor focus
  - missing, negative, or non-finite ranges return `null`; never substitute zero or the opposite side's time
- `src/platform/annotationMergePlan.ts`
  - pure dependency-aware plan for selective left-to-right/right-to-left annotation integration
  - uses structured diff keys, closes strong entity references, reports machine-readable integrity issues, and never
    mutates either `ProjectData`; UI and apply stages must not reimplement this graph
- `src/platform/annotationMergeSelection.ts`
  - pure direction-aware selection normalization plus item/group checkbox state
  - excludes project/unchanged and source-missing entities; filtering and folding must not be inputs to this module
- `src/platform/AnnotationMergePlanPanel.tsx`
  - selective-integration preview for direction, selected/dependency counts, actions, structural issues, and explicit
    per-conflict decisions; caps the initial non-conflict DOM list and never saves a file itself
- `src/platform/annotationMergeConflict.ts`
  - pure normalization and readiness model for explicit take-source/keep-target conflict decisions
- `src/platform/annotationMergeApply.ts`
  - pure all-or-nothing application of a reviewed plan to a cloned target project
  - preserves unselected collection contents and validates cross-domain references before a draft can reach the editor
- `src/platform/annotationMergePreparation.ts`
  - rechecks latest file identities, revisions, capabilities, normalized diff, plan fingerprint, and conflict decisions
    before creating a runtime merge draft
- `src/platform/annotationMergeDraft.ts`
  - runtime-only contract passed from the platform comparison flow into the existing target-file editor
  - must never be serialized into `ProjectData`, annotation payloads, local storage, audit logs, or operation logs
- `src/platform/resourceComparison.ts`
  - centralized list/grid/column selection qualification for comparing exactly two readable annotation files
  - preserves `selectedIds` order as the comparison's left/right order
- `src/platform/ResourceItem.tsx`
  - shared list/grid/column resource item, formatting, Radix context menu, and Pragmatic DnD lifecycle
  - keep resource commands and drag/drop registration shared instead of forking behavior by view mode
  - display CSS names are intentionally asymmetric: list uses `.resource-list-row`, while grid/column use
    `.resource-grid-item` / `.resource-column-item`; do not derive all three from one `*-item` template because
    the existing five-column detail layout and its selected/drag/drop states depend on `.resource-list-row`
- `src/platform/resourceColumnModel.ts`
  - pure Finder-style column-path transitions, truncation, current-location, and path-validation helpers
- `src/platform/resourcePageState.ts`
  - pure first-page/next-page aggregation for the main list/grid explorer
  - preserves server order, removes cross-page duplicate ids, and never converts pagination into a hidden all-pages fetch
- `src/platform/resourceColumnPageState.ts`
  - pure Finder-column page replacement/append/failure state; next-page errors retain loaded resources and cursor
- `src/platform/resourceDestinationPaging.ts`
  - bounded multi-page scan for move destinations; skips file-only pages without eagerly reading an entire directory
- `src/platform/useResourceColumns.ts`
  - asynchronous per-column pagination with stale-response protection and conservative path validation
  - an upstream path may be truncated only after its source column is exhausted; a missing item on an incomplete page is
    not evidence that the container was moved or deleted
- `src/platform/ResourceColumnBrowser.tsx`
  - virtualized multi-column renderer; column group scrolls horizontally while each column owns vertical scrolling and
    its own next-page lifecycle
- `src/platform/ResourceVirtualCollection.tsx`
  - TanStack Virtual-backed list/grid renderer; only visible/overscan resources mount `ResourceItem`, while selection and
    commands remain based on the complete set of pages loaded in browser state
- `src/platform/resourceClipboard.ts`
  - multi-root copy/paste result orchestration
  - each root remains a separate server transaction; one failed root does not suppress unrelated successful roots
- `src/platform/resourceRestore.ts`
  - trash multi-restore ordering and partial-result aggregation helper
  - restores selected ancestors before descendants; keep this orchestration outside `ResourceExplorer.tsx`
- `src/api/platformClient.ts`
  - browser-side API client for platform backend calls, including audit log and annotation operation APIs
- `src/state/projectDocumentState.ts`
  - authoritative local document/history/sync-state hook
  - owns undo/redo stacks, pending operations, revision counters, dirty/saved status
  - completed timing edits may carry a validated versioned command envelope; unported edits remain legacy operations
- `src/components/Timeline.tsx`
  - heaviest file
  - owns zoom, ruler scrubbing, snapping, marquee selection, drag/resize, creation flows, waveform guides, spectrogram lane rendering, loop range interaction, Gongche lane rendering, attached point editing
- `src/components/VideoPlayer.tsx`
  - playback sync, preview-frame behavior, native controls auto-hide, detached-panel button
- `src/components/InspectorPanel.tsx`
  - canonical editor for selected items, tracks, attached point tracks, spectrogram settings entry, Gongche editing entry points
- `src/components/SpectrogramCanvas.tsx`
  - spectrogram viewport rendering
- `src/components/SpectrogramSettingsPanel.tsx`
  - spectrogram control surface plus redundant waveform visibility toggle
- `src/components/TopMenuBar.tsx`
  - global file/edit/view/help menu
  - view menu owns visibility toggles for waveform, spectrogram, Banyan track, and global Banyan grid lines
- `src/components/GongcheCharacterRenderer.tsx`
  - single-character Gongche preview renderer
- `src/components/ResizableSplitLayout.tsx`
  - reusable splitter for desktop-style panel layout
- `src/components/FloatingPanelWindow.tsx`
  - current lightweight in-app floating window shell for detached panes
- `src/utils/project.ts`
  - track defaults, timeline track definition expansion, project builders, duration helpers, Gongche attached track id helpers, branch-lane track id helpers
- `src/utils/projectFile.ts`
  - saved project JSON normalization/migration, local/project-platform import compatibility, `PROJECT_FILE_VERSION`
  - legacy built-in action tracks and `actionAnnotations` migrate to custom action tracks/blocks; current-format features
    must target custom blocks instead of extending that compatibility array
- `src/utils/srt.ts`
  - SRT parse/export helpers
- `src/utils/banyan.ts`
  - Banyan/Gongche-derived beat/eye parsing helpers
- `src/utils/spectrogram.ts` + `src/utils/spectrogram.worker.ts`
  - worker-driven spectrogram analysis pipeline
- `src/utils/trackBranching.ts`
  - recursive branch-lane flattening/counting helpers
- `src/utils/trackColors.ts`
  - track/branch color defaults, palette helpers, and CSS variable helpers
- `src/utils/tone.ts`
  - 《韵学骊珠》four-tone (yin/yang × ping/shang/qu/ru) label mapping, validity checks, and sentence-level tone summary helpers
  - used by Inspector (character tone editor + derived sentence preview), Timeline (in-block tone label), and `projectFile.ts` (tone normalization)
- `src/utils/platformOperations.ts`
  - stable operation request builder plus structured manual/automatic server-save outcomes
  - sends migrated domain envelopes intact; it must never reduce them back to boolean legacy summaries
  - retryable save failures are limited to offline/network/408/429/5xx; conflict and deterministic 4xx must stop autosave
- `src/utils/timelineTimingCommand.ts`
  - pure extraction of version 1 timing commands from the true undo base project and final project
  - centralizes timing lookup for both extraction and apply across nested track entities and derived Gongche targets;
    unsupported edits return `null` so
    the caller can retain the legacy snapshot operation without recording a partial domain fact
- `src/utils/timelineTimingCommandApply.ts`
  - the only current ProjectData adapter for version 1 timing commands
  - resolves every target and checks all before values before immutable apply; never rerun sentence/Gongche synchronization
    because derived targets are already explicit command items
  - Banyan timing apply also maintains manualOffset/manual confidence; inverse currently guarantees timing restoration,
    not byte-identical restoration of that derived review metadata
- `src/utils/annotationContentCommand.ts`
  - authoritative ProjectData resolver, builder, complete-next reconstruction gate, and validated-item immutable writer for
    stable sentence/character/action/custom-block/attached-point content fields
  - builder must apply its own envelope to the base and compare the complete project; target-only equality is insufficient
    because it could omit timing, structure, or derived changes from the operation fact
- `src/utils/annotationContentCommandApply.ts`
  - all-or-nothing ProjectData adapter for `annotation.items.content.update`; resolves all current values and checks every
    before precondition before reusing the single immutable content writer
- `src/utils/annotationLifecycleCommand.ts`
  - authoritative ProjectData resolver, complete-next builder gate, canonical sentence/character/custom-block/attached-point/
    Gongche snapshots, and
    grouped collection reconstruction for `annotation.items.lifecycle.update`
  - collection position is a correctness fact, not presentation metadata; builder/apply must preserve index, length, and
    neighboring stable ids; global Gongche storage must not be grouped by its reference track id
- `src/utils/annotationLifecycleCommandApply.ts`
  - all-or-nothing lifecycle adapter; uniquely resolves parent containers, checks full before state, and only then rebuilds
    every affected collection
- `src/utils/annotationTransactionCommand.ts`
  - builds `annotation.transaction.apply` from authoritative base/next projects and explicit content/timing/lifecycle targets
  - must reconstruct the complete next project through the replay adapter; UI code never hand-authors child before/after values
- `src/utils/annotationTransactionCommandApply.ts`
  - applies validated leaf commands only to a local ProjectData variable and publishes no partial project when a child blocks
  - transaction inverse reverses child order; recursive transactions are forbidden by the shared parser
- `src/utils/projectValueEquality.ts`
  - shared reference-first deep equality used by command builders to prove that one envelope reconstructs the complete next
    ProjectData; do not add another JSON-stringify or target-only equality path
- `src/utils/annotationCommandApply.ts`
  - generic ProjectData command dispatcher used by clean catch-up; it only discriminates validated command types and must
    not duplicate a domain parser, precondition, or apply implementation
- `packages/shared/src/annotationCommands.ts`
  - authoritative timing/content/lifecycle/transaction annotation-command DTOs, deterministic builders/inverse, strict discriminated unknown
    parsers, all-target precondition assessment, target keys, limits, and API action/payload allowlist shared by web,
    IndexedDB recovery, and Fastify
  - the server currently validates and logs these commands but does not apply them to `AnnotationFile.payload`
- `apps/api/src/`
  - Fastify backend: auth, resource routes, resource ACL evaluation, annotation-file revision saves, Prisma mapping,
    and replaceable local/S3 object storage
- `apps/api/src/database.ts`
  - shared PrismaPg connection factory
  - explicitly aligns Prisma schema and PostgreSQL `search_path`; do not construct a second adapter path in tests
- `apps/api/src/auditLogQuery.ts`
  - pure audit filter normalization, query-bound cursor encoding, Prisma where construction, and formula-safe CSV serialization
- `apps/api/src/auditLogService.ts`
  - authoritative audit read/export service; combines global-admin access, resource `manage_permissions`, stable keyset pages,
    batched relation summaries, and the bounded export policy
- `apps/api/src/objectStorage.ts`
  - stable object-storage port, staged publish/read/range/lifecycle contracts, backend descriptor, and local-backup
    capability narrowing
- `apps/api/src/objectStorageFactory.ts`
  - the only production environment composition root for local/S3 object storage; undefined defaults to `local`, while
    blank, unknown, or incomplete backends fail closed
- `apps/api/src/s3ObjectStorage.ts`
  - AWS SDK v3 adapter for S3-compatible staged multipart upload, server-side-copy publish, Range reads, paginated
    listing, deletion, readiness, and prefix isolation
- `apps/api/src/resourceAccess.ts`
  - authoritative server-side resource capability resolution
  - combines global admin bypass, ownership, direct grants, and nearest inherited folder grants
- `apps/api/src/resourceService.ts`
  - resource-tree mutations, copy/move/trash behavior, annotation-file save/recovery, and confirmed-range governance
  - annotation save atomically binds the current actor's declared client operation ids to the new payload revision;
    missing, foreign, stale-base, or already-committed ids must roll back payload, revision, snapshots, and audit together
- `apps/api/src/storage.ts`
  - local filesystem adapter for `ObjectStorage`, including staging, checksum/size/header capture, atomic publish, safe
    listing, and idempotent deletion; business services must not depend on `LocalObjectStorage` directly
- `apps/api/src/uploadPolicy.ts`
  - centralized upload limits, filename rules, and binary-signature media validation
- `apps/api/src/mediaUploadService.ts`
  - single-command media upload across storage staging, quota transaction, publish, and compensation
- `apps/api/src/objectLifecycleService.ts`
  - admin-only object orphan inspection and confirmed cleanup
- `apps/api/src/healthService.ts`
  - liveness/readiness dependency probes; readiness stays lightweight and does not recursively scan storage
- `apps/api/src/observability.ts`
  - per-app Prometheus Registry, normalized HTTP and operational Gauges, upload/cleanup outcomes, and metrics-token validation
- `apps/api/src/operationalMetricsCollector.ts`
  - bounded, in-flight-shared readiness/capacity/job collection executed only after `/metrics` authorization
  - failures set the collection-success Gauge without replacing the last real capacity/job snapshot with false zeros
- `apps/api/src/maintenanceCoordinator.ts`
  - persistent global maintenance mode and cross-instance PostgreSQL shared/exclusive advisory write gate
  - uses a dedicated pg Pool so request-lifetime permits cannot exhaust Prisma's business-query connections
- `apps/api/src/systemDiagnosticsService.ts`
  - admin-only capacity/resource/job/object-consistency aggregation and server-authored alerts
  - admin-only dry-run and confirmed cleanup for aged storage/database orphans; missing binaries are report-only
- `apps/api/src/resourceSelection.ts`
  - pure parent/descendant selection normalization shared by atomic batch move and batch trash
  - selected descendants collapse under a selected ancestor so a subtree is mutated only once
- `apps/api/src/resourcePagination.ts`
  - pure normalized query context, opaque cursor, stable Prisma order, bounded scan size, and limited-concurrency helpers
  - cursors bind view/parent/search/type/sort/direction but never carry permission facts; API still evaluates ACL per request
- `apps/api/src/resourceCopy.ts`
  - pure recursive-copy planning, topological ordering, id allocation, and internal media-reference remapping
- `apps/api/src/annotationOperationIdempotency.ts`
  - pure bounded client-operation-id validation and stable JSON/SHA-256 request fingerprinting
  - idempotency scope is `(annotationFileId, actorUserId, clientOperationId)`; an exact accepted replay returns the original
    row before current-revision rejection, while the same key with a different fingerprint is a 409 conflict
- `apps/api/src/annotationOperationPagination.ts`
  - pure bounded operation-feed limit and opaque file-bound cursor validation
  - sequence is a per-annotation-file log acceptance order and cursor is an observed-read position; neither proves that
    the corresponding full annotation payload has been persisted at a newer revision
- `apps/api/src/annotationCommittedOperationPagination.ts`
  - pure cursor for committed operation order `(committedRevision, acceptanceSequence)` and snapshot-revision starting points
  - acceptance and committed feeds intentionally use different cursors; never filter nullable committed rows behind an
    acceptance-sequence cursor because a sequence hole may become permanent
- `apps/api/src/backup/`
  - versioned local/remote full-backup, offline/streamed verification, PostgreSQL tool runner, maintenance operator CLI,
    and isolated local/remote restore-drill modules
  - `backupService.ts` owns the maintenance window and staging-to-final publication; `restoreDrillService.ts` may only
    target a different empty database and isolated storage directory
  - `remoteBackupService.ts` owns manifest-last remote publication and reverse-order compensation; final payload objects
    are not a committed backup until `manifest.json` is promoted and streamed verification succeeds
  - `remoteBackupVerifier.ts` validates one explicit backup id without loading package payloads into memory;
    `remoteBackupStorageFactory.ts` requires an independent non-empty `XIQU_BACKUP_S3_PREFIX`
  - `remoteBackupPackage.ts` is the shared manifest/key/exact-object-set read contract for verification and restore;
    do not duplicate its package-index rules in another remote consumer
  - `remoteBackupMaterializer.ts` downloads each remote payload once into a unique temporary local package while
    checking size/SHA-256; `remoteRestoreDrillService.ts` only owns cleanup and delegates recovery to the single
    `restoreDrillService.ts` implementation
  - `remoteBackupLifecycle.ts` owns one-list package discovery, manifest-aware classification, retention planning,
    stable plan tokens, and manifest-first confirmed cleanup; malformed/inconsistent/unrecognized objects are
    report-only and must not silently become deletion candidates
  - `remoteBackupRetentionPolicy.ts` is the only parser for environment and CLI retention values
  - `remoteStorageCapabilityCheck.ts` owns the no-database, no-residue backup-target acceptance probe across readiness,
    staged upload, HEAD/LIST, server-side publish, full/range reads, and deletion; it must use the `ObjectStorage` port
    and aggregate cleanup failures instead of creating a second S3 client path
  - native PostgreSQL commands receive credentials through `PG*` environment variables, never shell-concatenated argv
- `deploy/object-storage/`
  - production backup-target least-privilege policy template and MinIO/AWS acceptance checklist
  - local SeaweedFS passing is protocol/tool validation only; never mark R3g2b2 production acceptance complete until the
    command, real backup/verify/restore, TLS/network checks, and IAM review run in the target environment
- `packages/shared/src/`
  - API/platform DTOs and shared contract types used by web and API
- `packages/document-model/src/`
  - pure resource-capability helpers and annotation-confirmation contract logic with regression tests
- `packages/document-model/src/annotationConfirmations.ts`
  - pure normalization, validation, lifecycle/freshness, overlap, persisted-track, and review-decision helpers for
    confirmed annotation ranges
  - contains no Prisma, API, React, payload mutation, or global-role lookup; backend and platform UI must reuse
    this contract instead of duplicating scope or freshness rules
- `prisma/schema.prisma`
  - PostgreSQL schema for users, sessions, resource entries, projects, annotation/media files, resource permissions/user state, recovery snapshots, confirmed ranges, processing jobs, audit logs, and annotation operations
- `docs/`
  - roadmap, architecture notes, and curated screenshots; keep this updated for long-running platform/backend work
- `deploy/monitoring/`
  - vendor-neutral Prometheus scrape/rule and Alertmanager example configuration
  - real metrics tokens, receiver URLs, TLS material, and deployment secrets never belong in this directory
- `src/types.ts`
  - all shared project/data/UI selection types
- `src/mockData.ts`
  - runnable demo dataset
- `examples_insights/`
  - real example annotation data and research notes; use it as format/workflow reference, not as app runtime source

## Commands
- `npm install`
- `npm run dev`
- `npm run dev:web`
- `npm run dev:api`
- `npm run db:generate`
- `npm run db:push`
- `npm run db:migrate`
- `npm run db:deploy`
- `npm run build`
- `npm run test:api`
- `npm run test:permissions`
- `npm run test:annotation-confirmations`
- `npm run test:annotation-confirmation-view`
- `npm run test:annotation-commands`
- `npm run test:timeline-timing-command`
- `npm run test:timeline-timing-command-apply`
- `npm run test:annotation-content-command`
- `npm run test:annotation-lifecycle-command`
- `npm run test:annotation-transaction-command`
- `npm run test:platform-operations`
- `npm run test:platform-auto-save`
- `npm run test:platform-auto-save-runtime`
- `npm run test:platform-operation-catch-up`
- `npm run test:platform-drafts`
- `npm run test:resource-pagination`
- `npm run test:resource-page-state`
- `npm run test:resource-column-pages`
- `npm run test:resource-columns`
- `npm run test:uploads`
- `npm run test:observability`
- `npm run test:audit-log`
- `npm run test:maintenance`
- `npm run test:backup`
- `npm run backup:check-remote-capabilities`
- `npm run backup:create-remote`
- `npm run backup:verify-remote`
- `npm run backup:restore-remote-drill`
- `npm run backup:inspect-remote`
- `npm run backup:cleanup-remote`
- `npm run test:recovery-preview`
- `npm run test:annotation-diff`
- `npm run test:annotation-diff-timeline`
- `npm run test:annotation-comparison-navigation`
- `npm run test:annotation-merge-plan`
- `npm run test:annotation-merge-selection`
- `npm run test:annotation-operation-pagination`
- `npm run test:annotation-committed-operation-pagination`
- `npm run test:resource-comparison`
- `npm run build:web`
- `npm run build:api`
- `npm run build:shared`
- `npm run build:document-model`
- `npm run preview`

There is still no general lint/full-test script. `npm run test:permissions` covers the scoped permission core. `npm run build` remains the mandatory pre-merge check; it runs Prisma generation plus shared, document-model, web, and API builds.

Backend local defaults:
- API port defaults to `4317`
- Prisma/PostgreSQL defaults to `postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public`
- local uploaded objects default to `./data/storage`
- `XIQU_OBJECT_STORAGE_BACKEND` supports `local` and `s3`; missing means local, while blank, unknown, or incomplete
  values fail startup instead of silently writing to the wrong backend
- S3 uses explicit `XIQU_S3_REGION`, `XIQU_S3_BUCKET`, `XIQU_S3_ACCESS_KEY_ID`, and
  `XIQU_S3_SECRET_ACCESS_KEY`; endpoint, path-style, and prefix are configurable. The default provider credential chain
  is intentionally disabled until a separate deployment/security review.
- local full backups default to `./data/backups`; `XIQU_PG_BIN_DIR` may point to PostgreSQL 16 client tools when they
  are not on `PATH`
- runtime Node.js must be 22 or newer because the media-signature dependency and backend toolchain require it
- upload defaults are `XIQU_MAX_UPLOAD_BYTES=1 GiB`, `XIQU_USER_STORAGE_QUOTA_BYTES=20 GiB`,
  `XIQU_PLATFORM_STORAGE_QUOTA_BYTES=200 GiB`, and `XIQU_ORPHAN_GRACE_MS=24h`; invalid values fail startup
- `/api/health/live` is dependency-free liveness; `/api/health/ready` and compatibility `/api/health` check
  PostgreSQL and storage-root readiness and return 503 when unavailable
- `/metrics` is disabled unless `XIQU_METRICS_TOKEN` is configured; it uses a separate Bearer credential rather than
  a browser session. Metric labels must remain low-cardinality and must never include user/resource ids, filenames,
  query strings, storage keys, or error messages
- operational metric scrapes share one bounded in-flight collection per API instance. Dependency-unavailable is a
  successfully collected fault, while collector exceptions/timeouts set `xiqu_operational_metrics_collection_success=0`
  and retain the previous real Gauge values rather than inventing zero usage.
- external notification grouping, inhibition, silence, retry, and webhook/email delivery belong to Prometheus/
  Alertmanager. Do not create a second application scheduler/delivery-state database for the same responsibility.
- `.env` and `data/` are intentionally ignored
- `prisma/migrations/20260801000000_resource_tree_baseline` is the committed resource-tree baseline;
  use `db:deploy` for a fresh/current database and reserve `db:push` for disposable local schema experiments
- `npm run test:api` applies migrations to the isolated `api_test` PostgreSQL schema; its safety guard rejects
  destructive cleanup unless the schema name ends with `_test`, and verifies the connection's actual schema before
  truncating. PrismaPg and node-postgres must both be configured through `apps/api/src/database.ts`; URL `?schema=`
  alone does not set pg `search_path`

## Coding Style
- React function components
- TypeScript strict mode
- 2-space indentation
- double quotes
- semicolons
- trailing commas
- keep shared shapes in `src/types.ts`
- prefer localized helpers over ad hoc inline logic in JSX when behavior is reused

### 中文功能注释（强制）

- 每个新增的逻辑代码块都必须配有中文注释，先说明这一段负责什么功能，再让读者进入实现细节。
- 至少覆盖：新文件或模块职责、类型/常量分组、函数与 React 组件、hook/effect、事件处理器、事务、
  循环，以及包含业务判断的条件分支。连续几行共同完成一个原子步骤时写一条块级注释，不要遗漏。
- 注释应说明功能、业务意图、边界条件或“为什么这样实现”，不能只把代码逐字翻译成中文，也不能
  用注释掩盖过长函数、重复逻辑或含糊命名。
- JSX 中新增独立功能区、复杂条件渲染或交互状态区时，在相邻 JSX/辅助函数处添加中文功能注释；
  简单的闭合标签、纯样式属性和显而易见的一行映射无需机械地逐行注释。
- 修改已有复杂逻辑时，如果附近没有足以帮助后续维护者理解的中文说明，应在本次修改中补齐；
  清理实现时同步删除失效注释，禁止留下与运行行为不一致的历史说明。
- 代码审查必须把“新增逻辑块是否具有准确中文功能注释”作为检查项；缺失注释视为未完成，而不是
  可选的后续优化。

Treat Chinese subtitle content as character-based annotation data, not tokenized words.

## Dependency Selection

新增依赖不是默认禁止项。若成熟依赖能够与现有视觉和交互风格保持一致，并且可以明显减少自维护
代码、简化状态与边界逻辑、提高无障碍或跨浏览器稳定性，应优先考虑采用依赖，而不是为了“零依赖”
重复实现复杂基础设施。代码清晰、行为稳定和长期可维护性高于表面上的依赖数量。

引入依赖前必须确认：

- 现有 React、Radix、Lucide、Prisma 或本仓库 helper 不能以同等清晰度直接满足需求，避免功能重叠。
- 依赖维护活跃、TypeScript 支持可靠、许可证可用于本项目，且没有已知的知识产权或安全风险。
- 优先选择可按需引入的小型、职责单一包；不要为了一个控件引入整套风格冲突的 UI 框架。
- 组件必须能沿用当前低饱和桌面工作站风格；依赖只负责稳定行为，不应强迫产品变成通用后台模板。
- 评估 bundle 体积、运行时成本、服务端/浏览器边界和未来升级成本。高频时间轴、音视频与频谱热路径
  不得因使用便利组件而引入不必要开销。
- 引入后删除被替代的手写实现和僵尸代码，不保留两套并行路径作为“备用”。
- 在 `docs/development-log.md` 记录选择该依赖的原因、替代了什么、许可证/维护判断和验证结果；若影响
  长期架构或部署，同时更新 roadmap 或相关架构文档。
- 同步提交 `package.json` 与 lockfile，并运行受影响测试和完整 `npm run build`。依赖不能成为跳过
  错误处理、类型建模或服务端鉴权的理由。

典型适用场景包括可访问对话框、菜单、表格/虚拟列表、拖拽、快捷键、颜色选择器和成熟领域算法。
对于很小且稳定的纯函数、已有本地 helper 能清楚表达的逻辑，继续使用仓库现有实现，避免过度依赖。

## Core Data Model
The current `ProjectData` is broader than the original MVP:
- `video`
- `subtitleLines`
- `characterAnnotations`
- `gongcheAnnotations`
- `banyanSections`
- `banyanMarks`
- `actionAnnotations`
- `builtinTracks`
- `customTracks`
- `activeTrackOrder`

Important type families:
- `BuiltinTrack`
  - current built-in track id is only `character-track`
  - older hand/body action built-ins were migrated away; use custom action tracks for action categories
- `CustomTrack`
  - `text` or `action`
  - supports saved color and optional recursive `branching`
- `AttachedPointTrack`
  - attached to either built-in or custom parent track
- `GongcheAnnotation`
  - attached to a text-capable parent block (`character-track` or custom text block)
- `CharacterToneInfo` (optional `tone` field on `CharacterAnnotation`)
  - 《韵学骊珠》four-tone eight-class system: `toneClass` is one of yin/yang × ping/shang/qu/ru
  - `yxlzShangSubtype` preserves the 上声 阴阳通用 layer (`toneClass: "yang_shang"`, subtype `yinyang_tongyong`); only set for 上声
  - `null` means unannotated; old files and SRT-imported characters normalize to `null`
  - four-tone lives only on character blocks; the sentence-level tone preview is derived from a line's character blocks, never copied onto `SubtitleLine`
- `BanyanSection` / `BanyanMark`
  - beat/eye sections and parsed/editable marks derived from Gongche or manually adjusted
- `WaveformData`
  - raw mixed audio samples + sample rate + keypoints
- `SpectrogramData`
  - worker-computed magnitudes + frequency bins + optional pitch frames

Saved project JSON:
- current `PROJECT_FILE_VERSION` is `5`
- import must go through `normalizeImportedProjectFile()` from `src/utils/projectFile.ts`
- do not duplicate project-file migration logic in platform or local import paths

## Track Model
There are now several track layers in play:

### 1. Active timeline tracks
- built-in character track
- custom text/action tracks
- ordered by `activeTrackOrder`

### 2. Gongche attached tracks
- text-capable parent tracks implicitly expose a Gongche attached lane
- `buildTimelineTrackDefinitions()` injects `gongche-attached` pseudo-tracks for:
  - built-in character track
  - custom text tracks

### 3. Attached point tracks
- explicitly created subtracks under a parent track
- used for things like breathing or other event markers
- can be expanded/collapsed via `attachedPointTracksExpanded`

### 4. Recursive custom-track branches
- custom text/action tracks can enable recursive branches through `CustomTrack.branching`
- branches are not separate saved top-level tracks; blocks remain saved on the parent custom track
- block branch ownership is stored on `ResolvedCustomTrackBlock.branchScope`
  - root/unscoped blocks belong to the parent/root lane
  - `mode: "lanes"` blocks belong to one or more branch lane ids
  - multi-lane blocks represent shared/common annotations
- branch display modes:
  - `merged`: one visible parent lane, with semantic bands for root and descendant branches
  - `expanded`: parent/root lane plus derived `branch-lane` pseudo-tracks
- branch names are user-defined; do not assume left/right hands
- per-track and per-branch colors are saved and used by custom block rendering
- branch helpers live primarily in `src/utils/trackBranching.ts` and timeline layout code in `src/components/Timeline.tsx`

Important implication:
- not every visible lane is a first-class saved track entry
- Gongche lanes are derived lanes
- attached point lanes are saved under parent tracks
- branch lanes are derived lanes; do not add them to `activeTrackOrder` as independent saved tracks

## Current Layout & Windowing Model
The app now behaves like a desktop workbench, not a document page:
- `AppShell` wraps the viewport
- nested `ResizableSplitLayout` components control main workspace, sidebar, and detail splits
- global page scrolling should remain disabled
- all scrolling should happen inside panels

Main arrangement:
- left: preview + timeline split
- right: sentence list + current line split + inspector/settings

Global visibility controls:
- the top menu `视图` is the canonical place for toggling:
  - `音频波形`
  - `人声频谱图`
  - `板眼轨`
  - `全局板眼纵线`
- do not move Banyan visibility toggles back into `SpectrogramSettingsPanel`
- `SpectrogramSettingsPanel` may expose waveform visibility as a redundant convenience control because the waveform track is also the settings entry point for audio analysis

Windowing:
- preview and timeline can detach into in-app floating windows
- this is not native browser popup logic
- `FloatingPanelWindow.tsx` is the current implementation
- when detached:
  - original pane becomes a placeholder panel
  - floating panel still uses the same shared React state
  - selection/playback/timeline state stays synchronized

## Project State Architecture
The earlier ad hoc document state has been replaced by `useProjectDocumentState()` in `src/state/projectDocumentState.ts`.

That hook currently owns:
- `project`
- `projectRef`
- `trackSnapEnabled`
- `trackSnapEnabledRef`
- `undoStack`
- `redoStack`
- `hasUnsavedChanges`
- `operationLog`
- `pendingOperations`
- `syncState`
- `transientProjectRef`
- one-shot `initialRecoveryState` for atomic first-render restoration

Important APIs:
- `commitProject(nextProject, baseProject?, action?)`
  - real history entry
  - records document operation
- `applyProjectWithoutHistory(nextProject)`
  - transient drag/live updates
  - preserves the ability to commit once on pointer-up
- `applyTrackSnapEnabledState(nextState, options?)`
- `markProjectAsSaved(...)`
- `undoProject(...)`
- `redoProject()`
- `getRecoveryState()`
  - returns the only supported complete snapshot for browser-draft persistence

`ProjectDocumentOperation` is intentionally compact. It contains stable id/revisions, action/type/sync state, and a
small change summary; do not restore the old full `beforeProject`/`afterProject` or duplicated track-snap maps. The
browser draft stores current/saved projects once per account/file envelope.

### Browser recovery draft rules
- Browser drafts apply only to writable platform editor sessions. Local JSON and read-only sessions keep their existing
  boundaries.
- The IndexedDB key is account id + annotation-file id. Never key by display name, filename, token, or current folder.
- Persisted projects must pass through `getPersistableProjectData()` and `prepareProjectForServer()`; protected media
  URLs, access tokens, Blob URLs, pending merge drafts, focus commands, and UI overlays must never enter IndexedDB.
- Opening always fetches the latest server file first. Only an exact `remoteBaseRevision` match can restore directly.
  Stale/read-only drafts may be exported or explicitly discarded, but must not silently overwrite or enter editable state.
- A successful full save returns the document to clean and deletes its draft. Writes and deletes must stay serialized so
  a delayed write cannot recreate a draft after save.
- This is recovery persistence, not autosave. Do not describe it as server synchronization, retry/backoff, stale-draft
  merging, operation replay into payload, or real-time collaboration.

### Critical history rule
Do not collapse multiple completed drags into one history entry.
Dragging should remain:
- transient during movement
- single commit on completion

### Critical state rule
Hot interaction paths depend on `projectRef.current`, not just render-state closures.
If changing drag, selection, clipboard, import merge, or undo logic, assume stale closure bugs are a real risk.

### Platform editor startup focus
- `PlatformEditorSession.initialFocus` is an optional one-shot navigation command, currently produced by annotation
  comparison; it is runtime session state, not part of `ProjectData`, saved JSON, localStorage, operations, or history.
- Comparison navigation must use `buildAnnotationComparisonFocus()` and the selected side's real range. Missing or
  invalid ranges disable navigation rather than falling back to zero or borrowing the opposite side.
- `EditorWorkbench` initializes the playhead from the focus and exposes one focus range to the existing Timeline.
  Timeline acknowledgment clears it; later scrolling or zooming must never snap back to the startup location.
- Opening from comparison still uses the normal single-file session and server-provided capabilities. Do not infer
  write access from the comparison UI or preserve the Dialog's previously fetched payload as the editor document.

### Selective annotation integration planning
- `buildAnnotationMergePlan()` is the only dependency-closure source for future selective integration. It accepts
  normalized left/right projects, the structured diff, a direction, and stable entry keys; React must not infer
  dependencies from visible rows or time overlap.
- Strong references currently include character → subtitle line, Gongche → parent text block, Banyan mark → section
  and linked Gongche, custom block → track and recursive parent block, and attached point → point-track definition →
  custom parent track. Selecting a container does not automatically absorb all descendants.
- A plan distinguishes explicit selection from automatic dependencies and `add`, `replace-conflict`, and
  `already-equal`. Conflicts are not structural failure, but missing/invalid/cyclic references and project-level
  selection make the plan non-applicable.
- The planner is deliberately read-only: it does not generate ids, clone entities, call `commitProject()`, save an
  annotation file, or touch revision/history/operation state. The future UI must preview this plan before a separate
  apply stage performs one explicit, undoable target-document commit.
- Comparison navigation selection and merge selection are separate state. Clicking a timeline segment or diff row may
  change the open-left/open-right focus, but must never toggle an integration checkbox.
- Merge selection is direction-aware and survives domain/change filters and group folding. Direction changes retain
  still-valid modified entities while pruning entities absent from the new source; swapping files rebuilds the
  comparison session and clears prior selections.
- The c2 plan panel is intentionally read-only and bounded for large plans. Do not add an apply button until the c3
  conflict-decision and target-session commit contract has revalidated target revision and permissions.

## Sync / Revision Model
Even though this is still local-first, the hook already tracks document-sync concepts:
- `ProjectSyncStatus`
  - `saved`, `dirty`, `saving`, `offline`, `conflict`, `error`
- local revision
- saved revision
- pending operation count
- operation log

Writable platform sessions additionally persist one sanitized, versioned IndexedDB recovery envelope. Refresh recovery
is explicit and same-revision only; stale-draft comparison, network retry/backoff, and server autosave remain R4 work.

This means future remote sync/collaboration work should extend the existing document-state layer rather than bypass it inside `App.tsx`.

## Platform / Backend Status
The platform backend is no longer just a mock, but it is still an early development platform:
- Fastify server entry: `apps/api/src/server.ts`
- routes: `apps/api/src/router.ts`
- repository queries: `apps/api/src/repository.ts`
- resource permission evaluation: `apps/api/src/resourceAccess.ts`
- resource and annotation-file mutations: `apps/api/src/resourceService.ts`
- Prisma row-to-DTO conversion: `apps/api/src/repositoryMappers.ts`
- development seed accounts/resource tree: `apps/api/src/repositorySeed.ts`
- object storage port/factory: `apps/api/src/objectStorage.ts`, `apps/api/src/objectStorageFactory.ts`
- local/S3 adapters: `apps/api/src/storage.ts`, `apps/api/src/s3ObjectStorage.ts`
- shared API types: `packages/shared/src/`
- resource-capability helpers: `packages/document-model/src/`

Current backend capabilities:
- login/session tokens with scrypt password hashing and sha256 token hashes
- users/roles/sessions in PostgreSQL
- media upload through one multipart business command; the former bare FileObject upload/import pair is removed
- server-side signature/extension validation via `file-type`, streaming size limits, checksum capture,
  platform/user quota locks, and compensating deletion when the metadata transaction fails
- admin-only object-lifecycle inspection and confirmed cleanup for aged staged/disk/database orphans
- file metadata in PostgreSQL and binary data in local object storage
- protected file reading, including HTTP Range / `206 Partial Content` for stable MP4 seeking
- maintenance-coordinated PostgreSQL/local-object full backup, offline checksum verification, and isolated restore drill
- hierarchical `ResourceEntry` tree with `folder`, `project`, `annotation_file`, and `media_file` resource types
- stable resource keyset pagination with query-bound opaque cursors, database ordering plus id tie-break, bounded candidate
  scans, and ACL-after-query page filling
- atomic batch move with parent/descendant selection collapsing; the legacy single-item endpoint delegates to the same core
- mutable annotation files with integer revision and `baseRevision` conflict checking
- hidden recovery snapshots created automatically before an annotation-file payload is replaced
- recovery-snapshot restore writes historical payload as a new monotonically increasing revision; current payload
  protection, annotation update, and audit entry commit in one transaction
- lightweight recovery-snapshot summary API plus a file-bound detail API for controlled Inspector previews
- recursive project/folder copy, media/annotation-file copy, file-like move/rename/soft-delete/restore, favorite, and recent-open state
- atomic batch trash with parent/descendant selection collapsing; the legacy single-item endpoint delegates to the same core
- audit-log table plus a generic browser/filter/export API for login, upload, resource mutations, permission changes,
  annotation saves, review facts, maintenance, and recovery operations
- annotation operation-log table and API with per-file/per-actor client idempotency, immutable request fingerprints, and
  concurrent single-row acceptance before future autosave/collaboration work
- confirmed annotation ranges backed by PostgreSQL, with all/domain/persisted-track scopes, immutable revision binding,
  additive revocation facts, list/create/revoke APIs, and same-transaction audit summaries
- placeholder processing-job API for future pitch, spectrogram, Gongche render, pose, transcode, and export services
- per-resource ACL:
  - capabilities are `read`, `write`, `review`, `create_child`, `copy`, `move`, `delete`, `download`, and
    `manage_permissions`
  - `super_admin` / `admin`, the resource owner, and the owner of an ancestor project/folder receive full effective access
  - direct grants belong to one resource and one account
  - folder/project grants inherit to descendants unless a descendant sets `breakPermissionInheritance`
  - there is no explicit deny rule; a direct grant augments inherited capabilities
  - only users with effective `manage_permissions` may edit grants
  - authorization is enforced by the API; disabled frontend controls are only an affordance
  - permission core lives in `packages/document-model` plus `resourceAccess.ts`; do not create a second UI-only implementation

Confirmed-annotation contract status:
- R2.5c completes the platform-editor workflow on top of the R2.5b database/API: a dedicated Inspector section lists
  current/stale/revoked facts, creates from the saved loop range, navigates to exact times, and revokes through a
  confirmed dialog. The Timeline renders active facts in a separate read-only lane.
- a confirmation binds one annotation file revision to a non-empty half-open time range and either all content, stable
  research domains, or real persisted parent-track ids. Derived Gongche, attached-point, and branch-lane visual tracks
  are not saved top-level track ids.
- confirmation is server governance metadata, never part of `ProjectData`, annotation payload, recovery snapshots, or
  annotation operation logs. Revision advancement makes a record stale until a future explicit re-review; it is not
  silently carried forward.
- read access reuses resource `read`; create/revoke require an independent per-resource `review` capability.
  `write`, `manage_permissions`, and the global reviewer role must not independently imply review authority.
- revocation preserves the original confirmation and records revoker/time/reason. Do not update or delete the original
  audit fact in place.

Current platform UI capabilities:
- login page with development defaults
- desktop-style three-pane resource explorer with folder/project navigation, search, sorting, list/grid/Finder-column modes, multi-selection, keyboard shortcuts, and context menus
- list/grid mode and every Finder column consume server pages incrementally without clearing loaded resources;
  search/location/sort changes invalidate old responses. List, grid, and column resource items are virtualized through
  `@tanstack/react-virtual`, while the shared `ResourceItem` remains the only menu/permission/DnD implementation.
- column mode keeps selection within one logical column, searches only the rightmost visible column, and preserves
  ancestor columns. Temporary errors and incomplete upstream pages must not truncate an otherwise valid path.
- the move destination picker scans a bounded number of additional pages when a page contains only files, then exposes
  an explicit “load more locations” command; it must not reintroduce an eager all-pages helper.
- multi-selection destination picker plus list/grid/column/breadcrumb drag-to-move powered by headless Pragmatic Drag and Drop
- create projects/folders, import annotation JSON, upload media, copy/paste all four resource types, rename, move through the API, and soft-delete resources
- open mutable or read-only annotation files in the existing editor
- compare two ordinary annotation files and selectively integrate stable-id entities with dependency closure, explicit
  conflict decisions, stale-plan rejection, and one editor-side undoable commit
- browse/create/revoke confirmed annotation ranges in the platform editor, with current/stale history, explicit
  all/domain/persisted-track targets, exact Timeline navigation, and a local-mode boundary
- revision-checked annotation-file save
- Inspector details plus per-account permission matrix for every selected resource
- annotation-file Inspector recovery history supports a lazy list, on-demand read-only multimodal summary, and an
  explicit confirmed restore command; unpreviewable historical payloads remain recoverable with a prominent warning
- two selected readable annotation files can be compared from the shared toolbar or list/grid/column context menu;
  both payloads are loaded on demand, normalized through the canonical importer, and shown as a read-only grouped diff
- toggle permission inheritance and edit direct per-account capabilities when authorized
- trash is a read-only resource context except for single/multi restore; normal open/copy/move/rename/delete
  shortcuts are suppressed while the trash view is active
- enter a local editor mode without login

Important backend caveats:
- resource pagination bounds database candidate batches and browser memory, but effective ACL and trashed-ancestor checks
  are still evaluated per candidate. R3b/R3 operations may batch/cache those reads after measuring real workloads.
- name `contains` search currently uses PostgreSQL `ILIKE` without a trigram index. `pg_trgm` is a database-level
  deployment prerequisite and must not be installed/moved by an isolated-schema application migration.
- recursive copy is synchronous and capped at 2,000 active nodes per root. Larger copies should become future
  processing jobs rather than extending one HTTP/database transaction without a bound.
- media copy creates a new media resource that reuses the immutable `FileObject`; copies do not consume quota again.
  Aged orphan inspection/cleanup exists, but user-facing permanent deletion and physical duplication remain future work.
- real-time collaborative editing is not implemented yet
- local directory backup/restore and S3-compatible manifest-last remote backup create/verify/isolated restore and
  manifest-aware retention cleanup are implemented. There is still no scheduler, encryption, incremental chain,
  production IAM/default
  credential-chain review, or production bucket acceptance. The local directory snapshot command remains local-only.
- remote backup targets use an independent `XIQU_BACKUP_S3_*` configuration and a required non-empty prefix. The source
  and target namespaces must not be equal or contain one another. `manifest.json` is the only commit marker; payloads
  under a prefix without it are incomplete and must never be offered for restore.
- remote restore materializes one explicit committed package into a unique local work directory. Manifest and every
  payload are opened once over the network while payloads are written and hashed; the existing local verifier then
  rechecks on-disk bytes before the sole restore implementation runs. Success, failure, and cancellation must remove
  the materialized package, and cleanup failures must not be swallowed.
- remote retention inspection scans the dedicated backup namespace once, recognizes only production backup ids, and
  protects incomplete packages by their newest object modification time. Complete packages use manifest `createdAt`,
  retention days, and a minimum-newest count. Cleanup requires the exact current SHA-256 plan token plus explicit
  confirmation; complete-package deletion must revoke `manifest.json` before payloads. Invalid manifest, inconsistent
  package, and unrecognized objects remain report-only.
- business storage consumers must depend on `ObjectStorage` or a narrow `Pick` of required methods. The concrete local
  adapter is confined to the factory, adapter tests, and the explicitly local restore-drill target. S3/MinIO must be
  implemented as a real adapter with integration tests, not as a path shim. `getObjectStream()` is asynchronous so
  authentication/network errors happen before Fastify sends the response stream.
- the removed Course/Assignment/Submission runtime is not a pending compatibility target; future classroom
  distribution/review should build on resource copy, ACL, file comparison, and a separate confirmed-annotation layer
- confirmed-range review is implemented end to end; entity-level confirmation, comments/signatures, automatic
  carry-forward across revisions, and real-time collaboration are not implemented
- annotation operations do not mutate server annotation-file payloads; full payloads are still written by the save route.
  Clean web sessions may replay a complete committed timing-command chain locally, but idempotent acceptance alone must
  not be described as autosave, offline persistence, a committed snapshot, or real-time collaboration
- audit logs intentionally store summary `detail` objects, not full annotation payloads or uploaded file contents
- global audit queries are admin-only. A non-admin query must be scoped to one resource and requires effective
  `manage_permissions`; ordinary `read` access is insufficient.
- audit pages use `(createdAt DESC, id DESC)` keyset order. Cursors are opaque, versioned, and bound to the normalized
  filter fingerprint; never accept a cursor from another query or fall back to offset pagination.
- audit CSV is generated by the server from the same normalized filters, capped at 10,000 rows, and must protect cells
  beginning with spreadsheet formula prefixes. The browser must not rebuild a partial export from currently loaded rows.
- `packages/shared` `AUDIT_ACTIONS`, Prisma `AuditAction`, runtime route validation, and Chinese action labels must remain
  exhaustive together. Add a regression assertion whenever the enum changes.
- processing jobs must validate job type and referenced resources; service roles bypass user visibility, not file existence
- system diagnostics are global-admin-only. Resource-level `manage_permissions` never grants platform diagnostics,
  and the UI must display server-authored capacity/alert conclusions instead of reimplementing quota rules
- maintenance state is stored in `PlatformRuntimeState`; all HTTP mutations except the dedicated admin maintenance
  command acquire a shared advisory permit until response completion, while enabling maintenance takes the exclusive
  form and waits for in-flight mutations to drain. Do not add a mutation route that bypasses this Fastify gate.
- maintenance locks must use the dedicated `maintenancePool`, not Prisma's adapter Pool. Sharing one finite pool can
  deadlock when requests hold permits while waiting for Prisma connections. New API instances/tests must pass and close
  both pools explicitly.
- GET/HEAD handlers allowed during maintenance must be genuinely side-effect free. “最近打开” is an explicit
  `POST /resources/:resourceId/opened`; do not move that write back into annotation-file GET. Future worker/CLI writers
  must acquire the same shared maintenance permit before mutation; the HTTP hook cannot govern out-of-process work.
- maintenance mode intentionally blocks login and all ordinary mutations. The browser diagnostic panel can restore
  through its authenticated bypass endpoint; `maintenance:disable` is also a controlled local CLI recovery path, so
  expired browser sessions do not strand a deployment in maintenance.
- API route handlers should perform runtime validation before Prisma writes; invalid revision/action/limit inputs should return `400`, stale annotation-file revisions should return `409`
- browser platform writes use `PATCH` and `DELETE`; keep both methods in the Fastify CORS allow-list when changing server bootstrap
- the API is currently for local/dev use; production deployment hardening, migrations, rate limits, and secure file serving are future work
- platform client currently targets `http://localhost:4317/api` in `src/platform/PlatformWorkspace.tsx`
- frontend read-only state is enforced centrally by `useProjectDocumentState({ readOnly })`; UI disabling is not the security boundary, and permission lookup failures must fail closed
- permission core regression tests run with `npm run test:permissions`
- if backend contracts change, update `packages/shared`, API repository/routes, `src/api/platformClient.ts`, and `docs/kunqu-platform-roadmap.md` together

### Maintenance, backup, and restore invariants

- every HTTP mutation acquires the shared maintenance advisory permit; future worker/CLI writers must use the same
  protocol instead of writing directly while a backup may hold the maintenance window
- `backup:create` refuses to take ownership of an already-active maintenance window. It preflights tools, paths, and a
  real active global-admin operator before enabling maintenance; controlled failure normally restores writes, while
  `--keep-maintenance-on-failure` and process crashes intentionally fail closed
- a valid final backup is published only after PostgreSQL custom dump, complete local object-root copy, SHA-256/size
  manifest, fsync, and offline verification succeed in staging. Failed staging must never be renamed as final
- backup output and source object storage must be physically separate even through symlinked ancestors. Object keys and
  manifest paths are normalized relative POSIX paths; symlinks in the source object tree are rejected
- manifest contains safe database identity and data summaries, never passwords, tokens, full database URLs, or public
  absolute paths. Existing missing binaries and disk orphans remain explicit warnings and are not auto-cleaned
- restore drill must first pass offline verification, then target a different-named database with no user tables and an
  absent/empty isolated storage directory. It must never target the source/current database or PostgreSQL system DBs
- remote restore must not call full remote verification and then download the package a second time. Shared remote
  package indexing performs manifest/object-set checks, materialization performs one streamed download, and the local
  verifier provides the separate post-download disk check.
- remote cleanup must re-inspect immediately before mutation. A changed object or policy invalidates the plan token and
  causes zero deletions. Package failures are isolated, but manifest deletion failure must stop deletion within that
  complete package; successful independent packages may still be reported and removed.
- restored databases intentionally retain the captured `maintenance=true`; an operator must inspect the report and
  explicitly disable maintenance before routing traffic to a recovered database
- `maintenance:disable` loads an active global-admin operator directly from PostgreSQL and continues using the existing
  maintenance audit path; it does not depend on a browser session or bypass coordinator state transitions

### Resource and annotation-file invariants
- `ResourceEntry` is the common identity, hierarchy, ownership, archive, and permission boundary for every managed item.
- a project is a specialized container resource, not a separate parallel navigation hierarchy. Project and folder use the same create-child, ACL, copy, move, trash, restore, naming, and cycle-protection paths; do not fork these operations by container type.
- project currently differs from folder through its resource type, icon/navigation semantics, and optional `ProjectMetadata`; it is not a separate storage volume, revision boundary, or permission engine.
- `all_projects` is the resource explorer's root-directory view and returns only top-level projects (`parentId = null`). It is not a recursive project search. Nested projects appear under their actual parent; recent, favorites, shared, archived, and trash remain virtual/aggregate views with their own semantics.
- resource list cursors are opaque, versioned and bound to normalized view/parent/query/type/sort/direction. A malformed,
  mismatched, moved, or deleted cursor is a `400` refresh condition, never permission evidence or a reason to fall back
  silently to page one. Every page re-evaluates effective read permission.
- resource ordering is a stable total order of the requested database field plus id in the same direction. Do not restore
  Node-side full-list sorting or use offset pagination. Main list/grid and each column append pages independently;
  virtual rendering must not become a reason to preload every page.
- `Command/Ctrl+A`, Shift ranges, multi-selection commands, and drag payloads operate on resources already loaded in the
  current logical list/column. They do not silently claim selection of server pages that have not been requested.
  per-column pagination rather than calling a helper that eagerly fetches all pages.
- an annotation file is the mutable user-facing unit. Copying it creates an independent annotation file at revision 1 owned by the copier.
- media upload is one command: validate target `create_child` before consuming the stream, stage and validate the binary,
  atomically publish it, then under platform/user quota locks create FileObject, media resource and audit in one database
  transaction. Never restore the removed browser-visible bare FileObject endpoint.
- storage quota counts each immutable FileObject once, regardless of how many media resources reuse it. The current
  per-file ceiling must stay below PostgreSQL integer range until FileObject/MediaFile/shared DTOs migrate together.
- filesystem and PostgreSQL cannot share a transaction. A failure before database commit deletes staged/final binary;
  a crash between publish and commit leaves an aged disk orphan discoverable by lifecycle audit. After database commit,
  DTO mapping failure must not delete the now-referenced binary.
- lifecycle cleanup may delete only objects older than its grace period and confirmed to have no media reference.
  `missing_binary` is diagnostic and must never trigger automatic metadata deletion.
- standalone annotation-file copy preserves an external media reference. Recursive container copy remaps references
  that point to media inside the copied subtree to the corresponding copied media resource.
- recursive copy requires effective `read` and `copy` on every active source descendant and `create_child` on the
  target. Each root is atomic; direct ACL, user state, recovery snapshots, operations, jobs, and audit history are not
  copied. The copier owns every new node and permissions are inherited afresh from the target.
- saving an annotation file must compare `baseRevision`; stale writes return `409` rather than silently overwriting.
- before replacing a payload, preserve the previous payload as an `AnnotationRecoverySnapshot`.
- ordinary saves and snapshot restores share the same active-file content-mutation path. They acquire a shared
  transaction advisory lock on the resource-tree mutation key before resource/annotation row locks; structural
  move/trash/restore operations acquire the exclusive form of that same lock. Do not reverse this order.
- restoring a recovery snapshot never decrements revision or deletes the source snapshot. It protects the current
  payload, writes the historical payload as `revision + 1`, and records an audit summary without payload content.
- recovery snapshots are implementation history, not ordinary user-visible files or published versions.
- recovery-history lists must never select or return snapshot payloads; full payloads are read only through a detail
  endpoint that binds both annotation-file id and snapshot id and currently requires effective `write` capability.
- historical payload preview must fail inside its own UI boundary and reuse the canonical project-file normalizer; a bad
  snapshot must not replace, open, or mutate the current editor document.
- confirmed annotation ranges are governance records outside `ProjectData`: `[startTime, endTime)` is half-open,
  `confirmedRevision` never auto-advances, and current/stale is derived against the file's current revision.
- listing confirmations requires `read`; creating and revoking require both `read` and the independent per-resource
  `review` capability. `write`, `manage_permissions`, or the global `reviewer` role do not substitute for `review`.
- track-scoped confirmations may reference only current payload top-level persisted tracks (`character-track` and saved
  custom track ids). Derived Gongche, branch-lane and attached-point visual lanes are not standalone confirmation tracks.
- confirmation creation follows the same resource-tree shared lock, ordered resource-row lock and annotation-row lock
  sequence as content writes, then compares the locked revision. Revocation is additive and idempotent; only the creator,
  global admin, resource owner or ancestor owner may revoke another user's record.
- saving does not delete or rewrite confirmations; older facts become stale. Annotation-file copy does not copy
  confirmations, and active-file checks prohibit listing/creating/revoking through a trashed resource or ancestor.
- confirmation UI exists only for an authenticated platform editor session. It must not appear in local mode, and its
  state must never be serialized into `ProjectData` or local JSON.
- confirmation creation uses the existing loop range but does not enable/change looping. It is blocked while the
  document is dirty, while list state is loading, without `review`, without a range, or when the server revision differs
  from the editor's saved revision.
- confirmation track choices include only `character-track` and top-level saved custom tracks. The read-only Timeline
  lane uses the same `getCanvasX(time, zoom)` coordinate system as the ruler and navigates from original record times;
  it must not participate in snapping, dragging, block history, or pixel-to-time reverse mapping.
- frontend revoke visibility mirrors creator/admin/resource-owner/ancestor-owner rules only as an affordance. Network
  lookup failure hides owner-only commands, and the service remains the authoritative permission boundary.
- recovery-snapshot comparison must refetch the current annotation file when the user starts comparison, keep the
  historical snapshot fixed on the left and the current server revision on the right, and reuse `AnnotationDiffReview`.
  It is read-only: never add side swapping, snapshot opening/editing, selective merge, revision writes, or a second
  migration path. Closing it must return to the underlying snapshot detail so restore remains a separate confirmed act.
- selective merge is a two-step local editor operation: the comparison dialog only prepares a reviewed runtime draft;
  the editor applies it with exactly one `commitProject()` and never auto-saves. Preparation must refetch both files,
  recheck source `read` and target `write`, reject changed revisions/duplicate identities/fingerprint drift, and rerun
  the pure application integrity checks. A later normal save remains the only server payload mutation path.
- ordinary annotation-file comparison is also read-only: it must not save either file, create recovery snapshots, append
  editor history, or mutate resource selection. Compare by stable saved entity ids rather than array positions; derived
  Gongche/branch lanes are not saved entities, normalized fallback symbol ids must be deterministic, and duplicate
  stable ids must produce a visible warning instead of being silently accepted.
- moving a resource must reject cycles and destinations where the caller lacks `create_child`.
- moving a selection is all-or-nothing; selected descendants collapse under their selected ancestor and must not be moved a second time.
- moving to trash is also all-or-nothing. Only normalized logical roots receive `trashedAt`; descendants keep their
  parent links and remain hidden through their trashed ancestor. Permission rechecks and one audit row per logical root
  belong to the same transaction.
- move, trash, and restore share the resource-tree mutation advisory lock before resource-row and parent-namespace
  locks. Restore must reject an absent/non-container/trashed original parent or trashed ancestor; it must never return
  success for an item that remains hidden behind a trashed ancestor.
- descendants inherit folder/project grants unless inheritance is explicitly broken; never infer permissions only from what the frontend happens to display.

## Timeline Interaction Model
Timeline behavior is now quite rich and tightly coupled. Preserve these assumptions:

### Zoom and ruler
- zoom range: `5-500 px/s`
- top ruler is clickable and draggable for playhead scrubbing
- this is separate from native video controls

### Sentence preview pills
- `.line-overlay` pills in `.line-focus-layer` (top-deck) represent each `SubtitleLine` time range; drag to move the line, click to select
- each pill shows its sentence text, left-aligned, clipped to the capsule (`border-radius: 999px`)
- the text is `position: sticky; left: calc(var(--track-label-width) + 10px)`; the pill uses `overflow: clip` (not `hidden`) so the sticky anchors to the timeline scroll container instead of the pill — when a pill scrolls behind the left track-header column the text slides to the header's right edge and stays readable, scrolling out left only when the pill's visible portion can no longer fit it
- do NOT switch the pill back to `overflow: hidden`: `hidden` establishes a scroll container and breaks the sticky; `clip` does not

### Track headers
- sticky on the left while horizontal scrolling
- per-track `吸附` toggle must remain visible
- compact/low-height rendering exists and has special hiding behavior
- branch track headers expose display state such as `分叉合并` / `分叉展开`
- right-click on custom tracks can enter branch settings; block context menus can set branch ownership

### Creation
- character, custom text, custom action, and branch-lane tracks support `Command/Ctrl + drag` creation
- character tracks also support blank double-click creation with line-merge heuristics
- attached point tracks support point creation
- Gongche attached tracks create/open blocks relative to their parent text block timing
- branch-lane creation still creates a custom block on the parent track and writes branch ownership to `branchScope`

### Selection
- single selection
- marquee selection
- `Command/Ctrl` additive selection
- blank-click clear
- `Command/Ctrl + A`
- group move
- batch delete
- clipboard copy/cut/paste

Attached point annotations are part of the main selection/clipboard/multi-move model now.

### Loop range
DAW-style loop range exists:
- create by dragging in loop lane
- move entire range
- resize edges
- click loop block toggles loop playback on/off without clearing stored range
- stored in project UI state
- some tracks can auto-set loop range from selected block(s)
- for multi-selection, contiguous blocks on the same track can define a merged loop range
- `P` starts continuous playback from the loop-range start; when it temporarily enables looping, Space exits that temporary loop without changing the normal Space semantics
- `Tab` plays the current loop range exactly once and pauses at its end, while preserving the user's persistent loop setting
- `Command/Ctrl + Left/Right` selects the adjacent duration block on the current logical lane; tracks with `autoSetLoopRangeOnSelect` then update the loop range through the normal selection path
- expanded recursive branches carry a transient selected branch-lane id so shared blocks navigate along the lane instance the user actually clicked; this context is UI-only and is not saved in project JSON

### Snapping
Snapping is intentionally nuanced:
- shared-boundary drag is different from individual edge drag
- hover feedback must match actual hit zones
- most snap behavior is now px-based, not second-threshold-based
- attached point tracks can optionally snap to:
  - waveform keypoints
  - parent block boundaries
- Gongche/text timelines may also inherit parent-based snap affordances

If touching snapping, test:
- block edge drag
- block move
- linked/shared-boundary drag
- attached point drag
- creation drag
- low zoom and high zoom

### Recursive branch layout / filled overlap layout
`Timeline.tsx` now has one active visual layout path for timeline blocks:
- `buildTrackBlockLayouts()` builds per-track `StackedTrackLayout`
- normal character/action/custom/expanded branch-lane tracks use `layoutSingleBandTrackBlocks()`
- merged branch parent tracks use `layoutMergedBranchTrackBlocks()`
- rendering consumes `blockDisplayLayouts` only

Important layout rules:
- ordinary non-branch tracks also use filled overlap layout now:
  - blocks are grouped by true time overlap
  - each overlap group is laid out independently
  - non-conflicting groups fill the available band height
  - conflicting groups split the band vertically only for that group
- merged branch tracks preserve semantic bands:
  - parent/root band first
  - descendant branch bands in tree order
  - empty branch subtrees are hidden
  - parent/root groups can fill the descendant subtree only when no descendant block overlaps that group in time
  - if a parent/root group fills, its own internal conflicts still split the filled subtree height
- expanded branch-lane tracks use the same single-band filled overlap layout within each visible branch lane

Removed legacy path:
- the old fixed-row render interface (`blockLayout`, `blockLayouts`, `StackedTrackBlockLayout`, and `buildStackedBlockLayoutMap`) has been removed
- do not reintroduce block positioning through `blockLayout`
- new layout work should write `StackedTrackBlockDisplayLayout` entries into `blockDisplayLayouts`

Creation drag note:
- `Command/Ctrl + drag` finalization uses the pointer-up coordinate and avoids a second floating-point min-duration rejection
- this fixes deterministic creation failures at some zoom ratios such as around `11px/s`

### Preview behavior
Dragging block edges or creation drags should preview frames through `previewTime` without moving the real playhead.
This behavior is easy to regress.

### Character block tone label
- a character block with a valid `tone` bolds its glyph (`.has-tone`) and shows a gray tone label beside it
- layout is progressive by available space: inline beside the glyph when the block is wide enough, stacked two-row (glyph above, label below) when only vertical room exists, otherwise just bold with no label
- the inline/stacked decision is computed in `renderBlock` from the block's pixel width and height against `TONE_LABEL_*` constants; do not move it back into CSS-only logic
- only the built-in `character-track` carries tone; custom text tracks do not

## Spectrogram Feature
Spectrogram support is now first-class, not experimental.

Current shape:
- `waveformData` is still the source audio base
- waveform track visibility is controlled by `waveformVisible` in `App.tsx` and can be toggled from `TopMenuBar` view menu
- `spectrogramSettings` lives in `App.tsx`
- `spectrogramData` is computed by `buildSpectrogramData(...)`
- computation runs in `src/utils/spectrogram.worker.ts`
- rendering is done via `src/components/SpectrogramCanvas.tsx`
- settings UI is in `src/components/SpectrogramSettingsPanel.tsx`

Current settings dimensions:
- visible / hidden
- pitch contour on/off
- frequency scale: `linear`, `log`, `mel`
- frequency presets:
  - `full-vocal`
  - `vocal-2000`
  - `vocal-1500`
- analysis presets:
  - `time-detail`
  - `frequency-detail`

Important implementation notes:
- spectrogram uses worker-based offline computation
- analysis is derived from `WaveformData`, not direct separate media decode
- timeline has a selected state for `spectrogram-track`
- there is a dedicated spectrogram settings panel path in the inspector
- spectrogram was recently merged and should be treated as active product surface

Performance posture:
- visible-window rendering matters
- do not casually move spectrogram work back onto the main thread
- preserve worker/off-thread design

## Gongche Feature
Gongche support is now part of the repository and should be treated as real context, even if some workflows are still demo-oriented.

Current model:
- Gongche is attached to text-capable parent blocks
- saved as `gongcheAnnotations`
- each annotation contains `symbols`
- each symbol has timing and optional notation metadata

Where it appears:
- built-in character track has a Gongche attached lane
- custom text tracks also have Gongche attached lanes
- selection types include:
  - `gongche-track`
  - `gongche-block`

Current usage:
- a selected character or custom text block can create/open a Gongche block from Inspector
- Gongche source text can be imported in batch for a parent text track
- importer aligns parsed Gongche entries to ordered parent text blocks using fuzzy/contextual matching
- each Gongche block can be edited in Inspector:
  - quick input
  - symbol list
  - per-symbol timing
  - per-symbol notation/raw text

Rendering:
- `GongcheCharacterRenderer.tsx` renders a single-character Gongche preview
- current renderer follows the `gongchepu.net`-style model: parse GCN-like tokens, build DOM note glyphs, stack them vertically, then rotate the note cluster
- CSS contains extensive Gongche-specific glyph/layout classes
- `public/fonts/GCNSymbolKai.woff2` is currently vendored so the preview can display the same style of glyphs offline

### Gongche rendering IP / replacement warning
The current Gongche glyph preview is intentionally marked as a finished research branch, but it is not a final release-safe asset strategy.

Important:
- the parser/layout approach is locally implemented, but it was informed by studying `gongchepu.net/reader/647/`
- `GCNSymbolKai.woff2` came from that public site and does not currently have a confirmed license in this repository
- before public release, distribution, or long-term productization, replace that font with:
  - a self-owned glyph font
  - a clearly licensed alternative
  - or explicit permission from the original rights holder
- do not expand dependency on that font without resolving licensing
- keep `examples_insights/gongche_rendering_research.md` updated when the glyph strategy changes

Important implementation tricks:
- `buildTimelineTrackDefinitions()` injects Gongche pseudo-tracks using `getGongcheTrackId(parentTrackId)`
- parent lookup helpers map Gongche track ids back to source text tracks
- block timing is normalized against parent timing
- when parent text timing changes, Gongche timing is remapped rather than discarded (`synchronizeGongcheWithChangedParents`)

This means:
- Gongche is not just a label string
- it is timing-aware and parent-block-aware

## Import / Save / Merge Behavior
Project JSON handling is more advanced than a raw dump.

### Save
- saved file version: currently `5`
- includes:
  - normalized `project`
  - `uiState`
    - `zoom`
    - `currentTime`
    - `playbackRate`
    - `trackSnapEnabled`
    - `loopPlaybackEnabled`
    - `loopPlaybackRange`
- the local JSON format and the platform resource model are separate layers
- on the platform, this payload is stored inside one mutable `AnnotationFile`; server revision and recovery snapshots must not be embedded into `ProjectData`

### Import
- supports either wrapped `SavedProjectFile` or older bare `ProjectData`
- normalizes built-ins, customs, attached point tracks, Gongche annotations, Banyan data, branch metadata/colors, and active track order
- imported filename is remembered and reused as default save filename
- platform JSON import must call the same normalization path, then create a new annotation-file resource rather than inventing a workspace/version wrapper

### Import merge
- there is an overlay/replace merge flow for project import
- imported project content can be mapped into current tracks instead of replacing the full project
- this includes attached point tracks; be careful when extending it for recursive branch ownership

### Local video caveat
Browser-imported local video cannot be reliably reopened by true disk path in plain web mode.
Current behavior:
- persist relink metadata
- blank/normalize unstable blob URLs
- prompt user to relink manually when needed
- `filePath` field is preserved for future desktop/Electron-style use

## Documentation / Development Log Rules
Use `docs/` as the handoff memory for long-running architecture work, especially backend/platform changes that span multiple conversations.

Current docs:
- `docs/kunqu-platform-roadmap.md`
  - canonical current architecture and roadmap for the backend/platform/database/collaboration transformation
  - update it when changing API behavior, Prisma schema, platform UI workflows, storage, auth, permissions, document save/version semantics, or phase status
- `docs/state-architecture.md`
  - state-management and document-state notes; update it when changing `useProjectDocumentState()` or history/sync semantics
- `docs/development-log.md`
  - committed cross-agent development log for important completed changes, validation, and residual risks
  - use it for what actually changed; keep `docs/kunqu-platform-roadmap.md` focused on architecture direction and phase planning
- `docs/screenshots/`
  - curated screenshots for README/docs; avoid dumping transient screenshots here
- `CLAUDE_WORK.md`
  - local-only handoff/task file for Claude Code or other local agents
  - intentionally ignored by git; never stage or commit it
  - keep only the current task, not historical logs
  - rewrite it after reviews when the next local agent needs a clearer task boundary

Cross-agent workflow:
- At the start of backend/platform/database/collaboration work, read `AGENTS.md`, `docs/kunqu-platform-roadmap.md`, and `docs/development-log.md` before planning or editing.
- Use `docs/kunqu-platform-roadmap.md` to understand the intended architecture, phase order, and any approved deviations from the original plan.
- Use `docs/development-log.md` to understand what actually happened in recent rounds, including Codex reviews, Claude Code/GLM changes, validations, residual risks, and follow-up tasks.
- When handing work to Claude Code or another local agent, rewrite `CLAUDE_WORK.md` as a current-task brief. Include branch/status, files to read, implementation goals, non-goals, quality expectations, validation order, and review expectations.
- Do not let `CLAUDE_WORK.md` become a log. After each review or task change, replace stale instructions with the next actionable task.
- After reviewing Claude Code/GLM output, record the review outcome in `docs/development-log.md`: what the other agent changed, what Codex found, what Codex fixed, what was validated, and what still needs attention.
- If a change affects long-term architecture, API contracts, database shape, permissions, storage, sync semantics, or platform workflow, update `docs/kunqu-platform-roadmap.md` in the same work round.
- If a change creates or clarifies a durable repo rule, module responsibility, data-format rule, or agent handoff convention, update `AGENTS.md`; also remove or rewrite stale guidance that could mislead future agents.
- The intended order for substantial platform work is: check git status, read the three context docs, update `CLAUDE_WORK.md` if delegation is needed, implement/review, run the relevant build or smoke checks, update roadmap/log/AGENTS as needed, then commit.
- For an autonomous multi-round goal, treat every roadmap slice as a separate closed round. At the beginning of each
  round, reassess the actual code and tests, update the roadmap if reality has changed, and completely rewrite
  `CLAUDE_WORK.md` with only that round's detailed plan. Implement only that brief, then review functionality, logic,
  dead code, Chinese comments, tests and browser behavior; update development log/roadmap/AGENTS and commit the round.
  Only after the commit is clean may the next roadmap slice be planned and written to `CLAUDE_WORK.md`. Do not batch
  several nominal phases into one unreviewed implementation, and do not preserve stale task text as a progress log.

Documentation rules:
- record what changed, why, validation performed, and any divergence from the roadmap
- keep notes actionable for another agent; include relevant commands and outcome summaries, not huge raw logs
- do not include private absolute local paths, access tokens, database passwords beyond the existing local-dev examples, or large pasted data
- do not commit generated runtime data from `data/`, local database files, or uploaded media binaries
- if a backend change requires manual DB setup, note the required `DATABASE_URL`, `db:generate`, `db:push`/migration, and seed expectations
- if UI behavior changes substantially, update docs or README screenshots only with curated images that are safe to keep in the repo
- when maintaining `CLAUDE_WORK.md`, be explicit about uncommitted changes, non-goals, files to read, validation order, and review expectations

## Media Pipeline
Current media behavior:
- `VideoPlayer.tsx` starts at 50% volume
- native controls auto-hide when pointer leaves video
- playback sync is requestAnimationFrame-driven while playing
- preview mode pauses/resumes around edge-preview seeks

Audio pipeline:
- video is fetched and decoded to build `WaveformData`
- waveform keypoints are onset-like heuristics
- spectrogram derives from waveform audio, not a second independent decode pipeline

## Clipboard / Paste Model
Timeline clipboard is more than simple browser copy:
- own app clipboard state in `App.tsx`
- supports:
  - copy
  - cut
  - paste
  - multi-selection
  - conflict handling

Paste has track/time awareness:
- paste target comes from recent timeline click / context menu location
- conflicts may offer:
  - cancel
  - overwrite
  - replace
  - keep original

Do not replace this with raw browser clipboard semantics.

## Inspector Rules
`InspectorPanel.tsx` is now a broad control center:
- selected line editing (includes a derived four-tone preview from the line's character blocks)
- character editing (includes 四声 tone editing)
- action editing
- custom block editing
- attached point editing
- track settings
- spectrogram settings
- Gongche editing

If you add a new selectable entity, it usually needs:
- a `SelectedItem` variant in `src/types.ts`
- selection wiring in `Timeline.tsx`
- inspector rendering branch in `InspectorPanel.tsx`

## UI / Small-Screen Notes
The UI has been repeatedly compacted toward a Premiere/Logic/VS Code feel:
- smaller radii
- denser controls
- compact track headers
- better small-screen handling

Important:
- small viewport behavior matters
- right sidebar used to clip badly; layout now clamps more carefully
- low-height track headers have custom compact modes and selective label hiding

## Verification Checklist
Before finishing substantial work, manually sanity-check the relevant subset:
- import video
- import SRT
- save project
- import project
- import merge
- video relink prompt
- play/pause + ruler scrub
- block edge preview
- loop range create/move/resize/toggle
- track snapping
- recursive branch merged/expanded display, including parent/root fill, empty branch hiding, and ordinary non-branch filled overlap layout
- attached point track create/drag/snap
- Gongche create/open/edit/import
- Gongche single-character preview, especially `（...）`, `/`, `+/-`, and `h/s/d/c`
- four-tone: set on a character, save and reimport, tone preserved across split/merge/copy/paste; old v4 JSON imports with `tone: null`
- character block tone label: inline when wide, stacked when only vertical room, bold-only when cramped, none when unannotated
- sentence preview pill: text left-aligned, sticks to the track header's right edge when scrolled behind it, scrolls out left when it no longer fits
- spectrogram visibility/settings/pitch contour
- detached preview/timeline panes
- undo/redo after drag-heavy operations
- export SRT tracks
- platform login/home/local-editor entry when touching platform UI
- file upload + MP4 Range seeking when touching backend media/file serving
- resource-tree create/move/copy/trash/restore, per-resource ACL inheritance, annotation-file revision save,
  and recovery snapshots when touching platform persistence APIs
- audit log list and annotation operation create/list when touching platform governance or sync APIs
- bad platform API inputs return `400`, stale document revisions return `409`, and normal edit/save paths do not regress to `500`
- `docs/kunqu-platform-roadmap.md` update when backend/platform/database behavior changes

Always run:
- `npm run build`

## Example / Research Data
- `examples_insights/` is intentionally in-repo for annotation examples and data-format experiments
- do not assume those files are production fixtures
- they are useful for import, schema, and workflow exploration

## Commit & PR Guidelines
Prefer short imperative commits such as:
- `Add detachable workspace panels`
- `Improve spectrogram clarity controls`
- `Merge Gongche glyph renderer`

Keep branches focused. For UI-heavy changes, include screenshots or recordings, and call out any behavior changes in:
- snapping
- undo/redo
- preview
- import/export
- SRT compatibility
- spectrogram settings
- Gongche editing/import
