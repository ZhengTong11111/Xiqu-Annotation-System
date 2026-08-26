# Repository Guidelines

## Product Intent
This repository is evolving from a local React/TypeScript annotation workstation into a full Kunqu multimodal academic database and classroom annotation platform. It now includes the original timeline editor plus a real Fastify/Prisma/PostgreSQL platform backend for accounts, a hierarchical resource tree, media files, mutable annotation files, recovery snapshots, and per-resource account permissions.

The editor remains a research-oriented workstation for aligning video, sentence-level SRT, sentence delivery/role classification, character-level timing and tone, action tracks, point annotations, audio cues, Banyan beat/eye information, Gongche notation, and recursive custom-track branches. SRT remains an important exchange format for subtitle-like tracks: sentence SRT in, editable TypeScript state in the app, per-track SRT out.

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
- resource permission Inspector with three base-preset radios, an independent review checkbox, and the complete detailed capability
  matrix; simple controls only rewrite direct ACL rows, preserve custom grants until explicit overwrite, and never replace
  server-side effective permission calculation
- independent annotation-range comments alongside confirmed ranges; both reuse one saved range/target contract and `read + review`
  gate, while comments remain non-confirming append-only governance facts with required plain-text bodies and withdrawal history
- permission-gated native streaming downloads for media resources and authoritative JSON downloads for annotation resources, exposed through the shared resource context menu and Inspector
- Fastify API backed by Prisma 7 and PostgreSQL, with local storage under `data/` or an S3-compatible backend
- local `dev:api` and `dev:analysis-worker` commands load the ignored root `.env` through Node 22
  `--env-file-if-exists`; production `start:*` continues to require an explicit systemd/container environment
- 修改 `packages/shared` 或 `packages/document-model` 后，必须重新执行对应 build 并重启已运行的 `dev:api`；Vite
  热更新不会刷新 API 进程已经加载的 workspace `dist` parser，不能用旧 API 产物验证新的命令合同
- R5 controlled single-server deployment candidate with fail-closed production configuration, same-origin `/api`, one-time
  administrator bootstrap, systemd/Nginx templates, read-only smoke checks, and `docs/server-deployment.md`
- backend audit logs and annotation operation logs for the first platform-governance layer
- authenticated file WebSockets plus schema-isolated PostgreSQL LISTEN/NOTIFY revision invalidations across API instances;
  these are lossy wake-up hints, while HTTP committed-feed/snapshot catch-up remains authoritative
- database-backed 60-second collaboration presence with cross-instance invalidation, same-account multi-window aggregation,
  revoke/disconnect cleanup, bounded member snapshots, and a compact current-file online-member UI
- remote playhead, pointer-time, and anonymized selection-summary previews over one transient collaboration channel, with
  strict complete-snapshot parsing, browser/server rate limits, cross-instance fan-out, privacy controls,
  disconnect/stale cleanup, same-account aggregation, and exact Timeline coordinates
- database-backed short-lived annotation mutation leases for structural/bulk writes; ordinary operation/save/restore stays
  unchanged without a lease, while an active lease requires its one-time token and is released only by a successful revision write
- existing custom-track metadata, recursive branch trees, and block branch ownership now use the strict top-level
  `annotation.track.structure.update` command; platform edits acquire/renew a file lease before local commit, and structural
  undo/redo retain inverse/forward command envelopes
- 结构新建入口发生历史 `local_chain_mismatch` 时，保存器会在相同服务器 revision、写权限和结构租约约束下执行一次
  完整快照恢复；远端 revision 变化仍必须进入冲突流程。结构事务调试日志只能记录 purpose、revision、命令类型和
  数量等定位事实，不得记录 token、AccessKey、PlayAuth、媒体 URL 或完整 ProjectData
- custom-track, builtin character-track, attached-point-track, builtin action-block, custom-block, attached-point, and Gongche-block
  creation/deletion plus custom type-option/block-type coupling now use the bounded
  `annotation.track.structure.transaction.apply`; ordinary lifecycle leaves that create/delete annotation entities count as
  structure children inside this container, so the transaction cannot be rejected merely because it has no separate track snapshot.
  It composes strict structure/content/timing/lifecycle/state leaves, requires the same mutation lease, and is replayable by
  drafts/history/clean HTTP catch-up
- bulk imports/repairs and over-budget builtin-track deletion use the strict non-replayable
  `annotation.project.snapshot.boundary`; the boundary contains no ProjectData, requires a purpose-specific mutation lease,
  survives drafts/history, and forces clean catch-up to fetch the authoritative snapshot
- version 1 timing, stable content-update, lifecycle, composite-state, and dependency-transaction domain commands with strict shared validation,
  draft persistence, inverse/precondition semantics, all-or-nothing ProjectData adapters, atomic server command-batch apply, and clean-client
  HTTP replay; lifecycle covers sentences, characters, custom blocks, attached points, Gongche blocks/symbols, and Banyan
  marks/sections; state atomically replaces sentence-role configuration and coupled Gongche/Banyan snapshots, while transactions bind sentence synchronization,
  parent/Gongche cascades, and Banyan-reference repair. Replayable editor saves now use atomic server command batches;
  full-snapshot save remains only for explicit legacy, snapshot, track-snap, submitted-draft, and old-payload migration boundaries
- client atomic-command planning/runtime, App/autosave wiring, partial document acknowledgement, mutation-lease handoff, and
  browser-recovery baseline advancement are implemented; each frozen pending chain is fully audited before bounded batch slicing
- ordinary online 409 conflicts reuse the same complete pending-chain audit and all-or-nothing rebase planner; disjoint commands
  replay unchanged; same-target timing conflicts preserve authoritative values on untouched edges and use the later recovered
  client's absolute target on locally changed edges, while same-field content commands use the later recovered client value.
  Rebuilt commands keep their operation ids and are immediately resubmitted against the latest server revision;
  lifecycle, structure, legacy, snapshot, track-snap, lease, permission, or request-drift cases remain explicit conflicts
- per-file operation acceptance sequence plus snapshot-committed operation facts and separate bounded feeds; clean web
  sessions now perform bounded HTTP catch-up, atomically replay complete mixed domain-command chains, and fall back to the
  authoritative snapshot for incomplete or non-replayable evidence
- project document state architecture (`src/state/projectDocumentState.ts`)
- versioned browser recovery drafts for writable platform files, isolated by account/file and recoverable only against
  the same server revision
- writable platform-file autosave with idle scheduling, single-flight snapshots, online recovery, and bounded retry
- super-admin-only account lifecycle UI/API plus self-service password change; ordinary admins retain full resource/operations
  access but cannot manage accounts. Deactivation and password changes revoke sessions, account records are retained, and
  per-resource ACL remains a separate Inspector concern
- annotation files use a real database foreign key to media resources; JSON import and the Inspector share one media-binding
  dialog, while protected runtime URLs stay outside ProjectData
- App now uses one media playback controller for native local/uploaded media and Aliyun VOD; Aliplayer is loaded from a fixed
  official CDN, short-lived playauth stays memory-only, and late seek/session events cannot revive a replaced source. Modern
  Web Aliplayer also requires a deployment-provided `domain + key` License; it is public browser configuration, distinct from
  AccessKey/Secret, and must flow through the strict no-store playback-session DTO rather than frontend hardcoding
- platform waveform, spectrogram, and F0 now use media-scoped canonical analysis runs plus object-storage tiles produced by
  an independent PostgreSQL-claim worker; multiple annotation files reuse the same content/config run, uploaded inputs stream
  through FFmpeg stdin, and VOD analysis uses a temporary pure-audio URL that must never enter persistence or logs
- analysis audio defaults to the bound uploaded/VOD media but can always be overridden with a readable server audio/VOD
  resource and restored to auto; these settings and assets are platform state, never ProjectData or undo/history state
- the compact audio-track selector is a high-frequency listening surface; persistent relation CRUD belongs in the separate
  low-frequency track manager. Track management derives only from effective `write` on the primary media, while changing the
  shared annotation default derives from annotation-file write permission; neither capability may substitute for the other
- recursive custom-track branching with merged/expanded display modes, per-track/per-branch colors, and filled overlap layout for conflicting blocks
- saved project JSON v6 sentence classification: every sentence independently stores `spoken | sung` and one project-defined
  ordered role option; only both valid values count as complete. Sentence lists and Timeline overlays share one red/blue
  completion policy, while role add/rename/remove/reorder uses a lease-protected structure transaction with reference cascades
- the former per-character `singingStyle` and built-in character-track options are no longer current ProjectData or UI concepts;
  historical JSON is normalized at the single project-file migration boundary and current cavity labels belong on custom tracks
- browser-created stable ids use `src/utils/runtimeUuid.ts`; production may temporarily run on an HTTP IP where
  `crypto.randomUUID()` is unavailable, so frontend code must never call it directly. The helper prefers native UUID,
  falls back to `crypto.getRandomValues()` UUID v4, and reserves the non-crypto fallback only for old-browser identity,
  never credentials or authorization values

If starting a new conversation, assume the repo is already beyond the earlier simple waveform-only stage.

## Directory & Ownership Map
- `src/App.tsx`
  - main orchestrator
  - wires together project state, playback state, import/export, clipboard, selection, context menu, loop range, spectrogram settings, detached windows, and inspector actions
  - all lease-protected local mutations pass through one exclusive coordinator; next ProjectData must be rebuilt from the latest
    `projectRef` after lease acquisition. Bounded structure uses `track_structure`; controlled snapshot boundaries use
    `bulk_import` or `bulk_repair`. Platform imports remain dirty until a real server revision save succeeds.
  - the exclusive mutation coordinator and server save are a two-way barrier: a lease mutation waits for an already-running save,
    while save synchronously yields to an acquiring/committing lease mutation. Never allow an ordinary unleased batch to leave
    while a structure lease is being acquired, because the server will correctly reject it once that lease becomes active.
  - platform media rebinding is not a document mutation: it is allowed only at a clean document boundary and must use
    `replaceCleanProjectFromRemote()` so it never creates undo/history/pending operations or persists protected URLs
- `src/components/EditorSidebarLayout.tsx`
  - owns the editor sidebar's four peer regions: sentence subtitles, current-sentence character split, annotation confirmation,
    and the content Inspector; each visible boundary uses its own persisted `ResizableSplitLayout`
  - annotation confirmation placement is an App-level `docked | hidden | detached` view concern. Hidden/detached modes must
    remove the docked region entirely so the Inspector receives the released space; never reintroduce confirmation inside
    `.editor-inspector-stack` or couple its height to the selected-item Inspector
- `src/platform/PlatformWorkspace.tsx`
  - platform login/resource-explorer/editor switch and local editor entry
  - owns the single authoritative annotation-file open path; ordinary opens and comparison navigation both refetch
    the latest payload, revision, and permissions before creating one `PlatformEditorSession`
  - resolves browser recovery drafts before editor construction; selective merge must not bypass an unresolved draft
  - editor save-conflict handoff refetches the latest file and flushed IndexedDB draft before leaving the dirty editor
  - revision-conflict drafts are routed through one explicit state machine: recoverable/read-only recovery, confirmed
    optimistic rebase, or the existing fixed-direction manual comparison; do not recreate this with independent booleans
- `src/platform/platformProjectPayload.ts`
  - single platform client/server payload boundary for adding current protected media URLs and removing them before save
  - the `AnnotationFile.media` DTO is authoritative for new platform sessions; historical payload paths are migration fallback only
  - uploaded media hydrate a protected platform object URL; aliyun_vod media retain only stable identity until the playback
    adapter requests a short-lived session. Never manufacture a URL from a VOD id or send VOD through full browser fetch/decode
  - an explicit `media: null` must clear a stale `platform-file:` path; only an omitted media DTO may use the historical fallback
- `apps/api/src/aliyunVodGateway.ts`
  - the only Aliyun VOD SDK boundary; uses the official SDK and default credential chain behind an injectable gateway
  - normalizes provider failures to bounded categories and must never expose SDK errors, credentials, playauth, temporary URLs,
    signed covers, or raw provider responses to persistence/logging layers
  - analysis audio selection uses `GetPlayInfo` for HTTPS mp3 audio only; its temporary URL is worker-memory-only
  - VOD resource `mediaKind` comes from strict `GetPlayInfo.VideoBase.MediaType`, not from the existence of an MP3 rendition.
    Same-VID audio renditions use official `PlayInfo.JobId` as the stable identity; candidate and exact-session queries accept
    only Normal HTTPS mp3 audio streams. Temporary URLs stay inside no-store playback sessions or worker memory
- `apps/api/src/mediaAnalysisJobService.ts`
  - the only API business boundary for audio-track analysis resolution, ACL revalidation, source fingerprints, run/job reuse,
    status DTOs, tile descriptors, and protected asset reads
  - canonical runs are media-scoped by source media, offset-independent media fingerprint, algorithm, and config. Annotation
    file ids and track offset are only request/ACL/display context and must never re-enter run persistence or identity
  - every analysis request carries only `annotationFileId + audioTrackId`; the service must reread the enabled track,
    primary media, concrete source media, offset, and current `read + download` permissions. A missing, disabled, foreign, archived,
    trashed, or revoked track context must fail closed; no optional-id or legacy analysis-audio-setting fallback remains
  - asset reads revalidate the annotation and its currently resolved source, then require every bounded asset id to belong to
    the same canonical succeeded media run; missing/cross-run/cross-media ids fail as one batch without leaking existence
  - the algorithm config hash must include every parameter that changes persisted tile timing or values
- `apps/api/src/mediaAnalysisMigrationPlan.ts` + `apps/api/src/mediaAnalysisMigrationService.ts`
  - offline RA2 migration boundary for grouping annotation-scoped historical runs by media identity, validating manifest/assets/
    immutable object checksums, and recording reversible canonical/superseded relationships
  - dry-run fingerprints the complete bounded plan; execute is super-admin-only, rechecks database facts under advisory and row
    locks, writes all groups atomically, and never deletes or reparents assets. Online analysis routes and workers must not call it
  - manifest `waveformLevels` are configured bucket widths while asset `level` is the zero-based array index; never compare them
    directly. A CLI launched from another worktree must receive the authoritative object-storage root as an absolute path because
    a relative `XIQU_STORAGE_ROOT` follows that process's working directory
  - production RA2 rollout is deliberately two-release: deploy the additive migration code first, stop the analysis worker,
    dry-run and execute the exact migration plan, then deploy the final media-scoped schema migration. The final SQL fails closed
    on missing fingerprints, duplicate canonical identities, or active superseded jobs; never bypass this gate
- `prisma/migrations/20260826030000_remove_legacy_analysis_audio_settings/migration.sql`
  - final RA4c schema boundary: deletes the legacy per-annotation analysis setting and run annotation/mode/offset snapshot columns
    only after SQL revalidates that every old setting has an equivalent enabled media audio track and all required resource paths
    remain active. It intentionally preserves historical audit actions
  - production rollout is two-release. First deploy commit `d615add`, apply additive migrations 27/28, stop the analysis worker,
    run `analysis-audio-settings:migrate dry-run/execute`, and require zero blocked plus zero pending creates. Only then deploy a
    release containing migration 29. Never deploy the destructive release directly to an older database or bypass its SQL gate
- `apps/api/src/mediaAnalysisSourceFingerprint.ts`
  - the only media-content fingerprint boundary for media-scoped analysis; uploaded identity requires stable file checksum/size,
    VOD identity requires region/video id/duration, and annotation id, selection mode, and track offset have no input position
  - same-VID VOD renditions additionally include the official stable JobId and format, so original audio and different rendition
    streams cannot share a run. Definition, bitrate, display metadata, temporary URL, and track offset never enter the fingerprint
- `apps/api/src/mediaAnalysisWorkerService.ts` + `apps/api/src/mediaAnalysisWorkerRuntime.ts`
  - independent database claim/heartbeat/stale-recovery worker; normal shutdown removes partial assets and requeues the job
  - staged/final object compensation failures must become stable failed states and must never be silently swallowed
  - a run with `sourceVodRenditionJobId` must request that exact JobId through the existing VOD gateway and reject a mismatched
    provider response. The resulting HTTPS URL remains worker-memory-only and must never enter the database, audit, or logs
- `apps/api/src/mediaAnalysisFfmpeg.ts` + `apps/api/src/mediaAnalysisComputation.ts`
  - shell-free FFmpeg streaming to 16 kHz mono PCM and versioned fixed-duration tile production; new runs currently use
    10-second tiles, while historical runs expose their original duration through manifest/config
  - waveform bucket widths and spectrogram hop lengths must exactly divide a full tile; otherwise concatenated browser views
    accumulate time drift. Keep shared config fingerprints, run DTO tile duration, and frontend level selection synchronized
- `packages/shared/src/mediaAnalysisComputation.ts` + `packages/shared/src/mediaAnalysisTileCodec.ts` +
  `packages/shared/src/mediaAnalysisTileBatchCodec.ts`
  - shared bounded STFT/YIN computation, little-endian tile codec, and strict bounded batch envelope. Batch responses stream
    one manifest header plus raw tile sections; never replace them with Base64 JSON or an API-side whole-batch Buffer
- `src/platform/usePlatformMediaAnalysis.ts`
  - platform-only track-scoped status polling and run creation, run-duration-quantized viewport selection, debounced descriptor reads,
    session-scoped in-flight batch reuse, generation isolation, strict tile continuity checks, source offset conversion,
    progressive waveform/spectrogram assembly, bounded memory cache, and IndexedDB second-level cache
  - every status/create/list/batch/preload request must carry the same current `audioTrackId`, and a status response with a
    different identity is a protocol error. Track switches synchronously hide the previous status/timed data, advance the
    generation, abort old batches/preloads, and clear loading state that a discarded request can no longer settle
  - display-session identity includes track id and current relation offset so two tracks sharing one canonical run cannot reuse
    already assembled timeline data. Persistent tile bytes remain keyed by account/media/run/asset/size and may be reused only
    after the current annotation+track status request has revalidated access
  - when a new viewport enters the debounce window, immediately cancel old visible/adjacent batches outside the active
    preload set; after the new descriptor snapshot arrives, cancel batches outside the latest viewport plus preload set.
    Shared batches with any retained asset remain reusable. Changing waveform level, spectrogram preset, visibility, or F0
    cancels the old preload task; file/run/source switches abort the whole asset session.
    Keep the previous timed data while the next window loads so Timeline range intersection prevents flashes
  - polling must continue even when one response has an unchanged `updatedAt`; status requests stay single-flight
- `src/platform/platformMediaAnalysisLoading.ts`
  - pure request-window quantization, adjacent-window prefetch, batch partitioning, progressive contiguous-prefix selection,
    stale-batch cancellation, and bounded LRU policy; shared 48-asset/32 MiB transport limits must stay synchronized with the
    batch codec, while progressive foreground batches may use a smaller local budget
- `src/platform/platformMediaAnalysisCache.ts`
  - existing `idb` dependency-backed second-level analysis cache; records are keyed by encoded account/media/run/asset/size,
    contain only binary analysis bytes, and use bounded metadata-driven LRU cleanup. Quota/private-mode failures are an
    optimization downgrade, never an authorization bypass or document error
- `src/utils/localMediaAnalysis.ts`
  - browser-only local media fallback; user-selected `blob:` media retains full local decode behavior, while non-Blob URLs use
    a 256 MiB pre/post-download cap. Platform uploaded/VOD URLs must never call it
- `src/utils/runtimeUuid.ts`
  - the only frontend runtime UUID boundary for annotation entities, tracks, branches, drafts, and operation ids
  - HTTP IP deployments are not secure contexts in Chrome and do not expose `crypto.randomUUID()`; use this helper rather
    than adding local timestamp/random fallbacks. Generated ids are stable identities only and must never become secrets
- `apps/api/src/objectLifecycleService.ts` + `apps/api/src/backup/backupService.ts`
  - both FileObject and MediaAnalysisAsset storage keys are authoritative references; lifecycle cleanup and backup warnings
    must not classify analysis tiles as orphan binaries
  - future permanent Trash deletion must start from each trashed logical root and purge its complete descendant subtree;
    descendants usually inherit Trash state and need not carry `trashedAt`, so never implement this as a flat
    `DELETE WHERE trashed_at IS NOT NULL`. Use the root timestamp for retention, lock/revalidate the tree and permissions,
    retain audit facts, and perform post-commit reference-checked object/analysis-asset cleanup with compensation. This rule
    also covers resources placed in Trash before permanent deletion exists.
- `src/platform/platformMediaPlaybackSource.ts`
  - the only conversion from platform media DTO plus local runtime URL to native/VOD/unavailable playback source
  - VOD source construction must defer the no-store session request; never retain playauth in React/project state
- `src/platform/platformMediaAudioPlaybackSource.ts`
  - the only conversion from one persistent external audio-track record to an uploaded/VOD runtime source
  - every load reissues and identity-checks a file-bound playback session; uploaded Range URLs are built with the current
    access token only at load time, while PlayAuth and rendition URLs must never enter ProjectData, drafts, preferences, or
    persisted state. Same-VID rendition sessions must also match the track's stored JobId
- `src/platform/MediaAudioTrackManagerDialog.tsx` + `src/platform/useMediaAudioTrackManager.ts` +
  `src/platform/mediaAudioTrackOffset.ts` + `src/platform/mediaAudioTrackSourcePolicy.ts` +
  `src/platform/AliyunVodAudioRenditionDialog.tsx`
  - the low-frequency audio-relation management surface and its single-flight/session-generation owner; every committed
    mutation rereads the authoritative list, and a late response from a previous file/media session must remain inert
  - offset authority remains seconds in the API/database, while the editor's millisecond calibration buttons must use the
    shared integer-millisecond helper to avoid floating tails. Positive means the replacement audio is delayed on the video
    timeline; negative means it is advanced. Calibration remains an explicit save operation and must not create a parallel
    preview-only offset, ProjectData mutation, or per-click network write
  - the resource-tree picker accepts only active `media_file` resources whose authoritative `mediaKind` is `audio`. A same-VID
    rendition uses a separate provider-backed picker and stores only source VOD identity plus JobId; it must never be presented
    as a movable file, accept a user-supplied URL/JobId, or bypass server-side candidate revalidation
- `src/platform/platformMediaBindingPolicy.ts`
  - pure clean-session gate shared by current uploaded-media binding and future platform media sources
  - dirty/pending/transient/inline/merge/conflict/offline/error/remote-gap sessions must not replace the runtime media
- `src/platform/platformDraft.ts`
  - versioned, unknown-input-validated browser draft envelope and recovery compatibility rules
  - persists one sanitized project pair plus compact operations; it never stores access tokens, Blob URLs, or
    per-operation project snapshots
  - content equality intentionally ignores only `updatedAt`; the persistence queue must not rewrite an otherwise identical
    envelope during conflict handoff because proposal validation binds the last meaningful draft timestamp
- `src/platform/platformDraftStore.ts`
  - `idb`-backed IndexedDB repository keyed by encoded account id and annotation-file id
- `src/platform/usePlatformDraftPersistence.ts`
  - serialized/debounced draft writes, editor-unmount final capture, and clean-state deletion for writable sessions
  - must suspend all put/delete while any runtime merge draft is awaiting the editor's second confirmation
  - `flushNow()` must use the same task queue as debounce/unmount writes; conflict UI must never issue a parallel store put
  - duplicate-content writes are skipped, while any real project/operation/revision change still creates a new draft timestamp
- `src/platform/platformAutoSavePolicy.ts`
  - pure idle/retry/block decision and bounded exponential-backoff constants for server autosave
- `src/platform/platformAutoSaveRuntime.ts`
  - testable timer, single-flight, online-resume, retry, disposal, and unexpected-save-error coordinator
  - consumes policy decisions and save outcomes; it never owns project payloads, revisions, operations, or IndexedDB
  - `rebased` means the command is not committed yet and must be resubmitted immediately; it is not equivalent to `saved`
- `src/platform/usePlatformAutoSave.ts`
  - thin React facts/callback adapter around one `PlatformAutoSaveRuntime`
  - Strict Effects cleanup must dispose and clear the runtime ref so the second setup creates a live instance
- `src/platform/platformMutationLeaseRuntime.ts`
  - memory-only acquire/renew/retry/release coordinator for one annotation-file session; plaintext tokens must never enter
    React-persisted state, ProjectData, IndexedDB, logs, or command payloads
  - temporary renewal failure may retain an unexpired token, but near-expiry failure clears it and reports lease loss
  - committed/catch-up revisions advance the existing runtime in place; a non-forward renewal at the server absolute cap must
    schedule real expiry loss instead of a zero-delay renewal loop
- `src/platform/usePlatformMutationLease.ts`
  - thin file-session React adapter; changing file disposes the old runtime, while revision changes update its acquisition baseline
- `src/platform/platformOperationCatchUp.ts`
  - pure bounded committed-feed reader, revision-continuity validator, and all-or-nothing known-command replay planner
  - malformed pages, revision gaps, legacy operations, pagination overflow, and precondition failures require a snapshot
  - catch-up eligibility treats a completely clean `error` session like `saved`, so an acknowledgement/runtime error cannot
    permanently stop authoritative recovery; any dirty, pending, transient, inline, merge, save, or media-binding fact still
    blocks replacement and preserves the browser draft
- `src/platform/platformSyncFailureDiagnostic.ts`
  - builds the bounded client report written as `annotation_client_sync_failure` audit rows when document sync enters `error`
  - reports local/server revisions, timestamps, mismatch domains, pending operation identities/targets, bounded command
    envelopes, and leaf-level saved/replayed/current mismatch values for debugging; annotation text and command before/after
    are intentionally retained, while authorization values, PlayAuth, AccessKeys, tokens, and URLs are always redacted on
    both client and server even in development
- `src/platform/platformOperationCatchUpRuntime.ts`
  - owns the HTTP catch-up timer, single-flight request, retry delay, session generation, and disposal behavior
  - a stale file response must never apply or recreate a timer for a later editor session
- `src/platform/platformRemoteEditGate.ts`
  - separates the highest server revision observed through collaboration from the revision already applied to local
    `ProjectData`; while a clean client is between those revisions, new mutating gestures/menus/shortcuts must be blocked
  - this gate must never interrupt a transient or inline edit already in progress; HTTP committed-feed/snapshot catch-up remains
    the only way to clear a clean-client gap, while edits already in flight are resolved only after a definitive server 409
  - a clean `error` session with an observed/applied revision gap remains edit-blocked until catch-up succeeds; error status must
    not become a bypass around the stale-snapshot gate
- `src/platform/platformAtomicCommandPlan.ts`
  - pure bounded next-batch planner for the atomic command endpoint; full-chain proof is delegated to the shared pending-chain audit
  - never submit a prefix when a later command is blocked or the replayed chain does not equal the current project
- `src/platform/platformPendingCommandChain.ts`
  - the single pure local pending-chain audit used by normal atomic save and conflict rebase planning
  - owns legacy/submitted/snapshot/track-snap barriers, operation identity, local-revision continuity, envelope validation,
    precondition replay, and final current-project equality; do not fork these rules into another save/conflict path
- `src/platform/platformConflictRebase.ts`
  - pure all-or-nothing optimistic rebase decision after a revision conflict; first proves the local chain against its saved
    baseline, then applies the same envelopes to the latest authoritative server project
  - live 409 handling may opt into document-model conflict resolution: timing keeps the authoritative value for each untouched
    edge and uses the later recovered client's absolute target for each locally changed edge, while stable content rewrites
    `before` to the authoritative value and keeps the local `after`; structure,
    lifecycle and unsupported transaction conflicts still fail closed
  - `rebase_ready` is not authorization or persistence: the caller must still use the latest revision, current ACL, original
    operation ids, rebuilt pending envelopes, and any required mutation lease. Conflict summaries are bounded code/target facts
    and must never include annotation text, track names, project payloads, tokens, or a partially applied project
- `packages/document-model/src/annotationCommandConflictResolution.ts`
  - the only value-level resolver for a definitive live revision conflict; ordinary apply/catch-up remains strict
  - timing resolves start/end independently: an untouched edge preserves the authoritative server value, while a locally changed
    edge uses the later recovered client's absolute target. Opposite-edge resizes still compose, but same-edge drags and whole-block
    moves never add stale deltas. Content uses later-recovered-client wins because arbitrary text has no safe generic merge.
    Transaction resolution remains all-or-nothing
  - stale browser-draft preparation must not call this resolver: an old draft can represent a committed request whose response was
    lost, so rewriting and resubmitting it could apply an edit twice
- `src/platform/platformConflictRebasePreparation.ts`
  - the only two-phase browser rebase preparation boundary: builds a lightweight proposal, then rechecks draft identity/content,
    latest file identity/revision, current write capability, planner result, and plan fingerprint after explicit confirmation
  - successful preparation uses latest server ProjectData as saved baseline, the complete replay result as current ProjectData,
    and preserves original operation ids/local revisions/envelopes; it also builds the crash-safe IndexedDB checkpoint that must
    be written before the existing editor-open path is re-entered
- `src/platform/PlatformConflictRebaseDialog.tsx`
  - explicit user confirmation surface for a proven rebase proposal; displays only revisions, operation count, and lease purpose
  - always retains manual comparison as a peer fallback and never performs network reads, IndexedDB writes, or document mutation
- `src/platform/platformAtomicSubmitPolicy.ts`
  - strict command-batch acknowledgement validation and atomic-endpoint-specific HTTP/network classification
  - lease failures and the exact old-payload migration code are separate deterministic errors; neither is a generic revision conflict
- `src/platform/platformAtomicSubmitRuntime.ts`
  - frozen-plan single-flight transport lifecycle with same-ID retries, online recovery, protocol blocking, and session disposal
  - it does not own ProjectData, React state, access tokens, mutation leases, or IndexedDB
- `src/platform/platformAtomicCommandSubmitCoordinator.ts`
  - awaited transaction facade over the atomic submit runtime; one file session permits one frozen plan and one completion Promise
  - session switches return `cancelled`, retryable failures keep the same call alive, and final failures never create a second request
- `src/platform/usePlatformAtomicCommandSubmit.ts`
  - thin React adapter supplying current client/session/online/apply callbacks to the testable coordinator
- `src/platform/usePlatformOperationCatchUp.ts`
  - thin React facts/callback adapter; App owns snapshot hydration and document replacement gating
- `src/platform/platformCollaborationRuntime.ts`
  - owns one collaboration ticket request, WebSocket, handshake timeout, retry timer, generation, and connection status
  - waits for strict `session.ready`; revision messages only wake HTTP catch-up, while presence and timeline activity remain
    runtime-only
  - owns one complete playhead/pointer/selection candidate, ready-before-send, 8 Hz trailing coalescing, 2-second keepalive,
    browser backpressure, and activity timers; do not fork separate queues for the three activity fields
  - file session changes clear the complete candidate; same-file reconnect may retain the latest facts, while
    offline/dispose must clear every timer and connection generation
  - permanent protocol/authentication/authorization failures (4400/4401/4403) halt until the file, online state, or session changes
- `src/platform/usePlatformCollaborationSession.ts`
  - thin browser/React adapter around the collaboration runtime
  - clears stale members and remote activities on disconnect/file switch; owns the single stale-prune timer only while the
    remote registry is nonempty; local editor sessions stay disabled and Strict Effects cleanup disposes the runtime
- `src/platform/remoteTimelineActivityRegistry.ts`
  - connection-level strict sequence/clear/stale registry plus same-account latest-complete-snapshot aggregation and stable
    colors
  - hides the current account, requires a current presence member, caps mounted remote views at 32, and caps selection bands
    at 12 without dropping the associated playhead or pointer
- `src/platform/timelineSelectionSummary.ts`
  - converts valid current Timeline selections into an anonymized time/count/lane/domain summary
  - must never expose entity ids, annotation text, labels, track names, or branch names; stale selection items are ignored
- `src/platform/collaborationPresenceView.ts` + `src/components/CollaborationPresenceMenu.tsx`
  - pure current-user-first member view plus the compact top-bar member popover
  - online membership is informational only; it must never grant permissions or alter save/sync state
  - owns local display and pointer/selection-sharing controls; hiding hints must not destroy the registry, and disabling
    sharing clears only pointer/selection while preserving playhead preview
- `src/platform/PlatformDraftRecoveryDialog.tsx`
  - explicit same-revision recovery, stale comparison entry, and read-only export-or-discard decision before opening editor
- `src/platform/PlatformDraftConflictDialog.tsx`
  - fixed local-draft-left/server-current-right structured review; it cannot treat the browser draft as a resource file
- `src/platform/platformDraftConflict.ts`
  - pure authoritative reread validation and fixed-direction stale-draft merge preparation
  - rejects changed draft/server identities, revisions, permissions, selections, conflicts, or plan fingerprints
- `src/platform/ResourceExplorer.tsx`
  - desktop-style three-pane resource manager
  - owns folder navigation, view switching, selection, keyboard actions, import/upload/download, and the resource Inspector
  - blank annotation creation uses `createEmptyProjectData()` and the real annotation-file API, then enters through
    `PlatformWorkspace`'s single authoritative open path; it must not use `mockProject`, bypass revision/ACL initialization,
    or require media binding before the first editor session
  - the Inspector is the canonical detailed UI for direct permissions on the selected resource; the separate project permission
    dialog is only the global-admin quick entry for common project-level presets and must not absorb file/folder exceptions
  - file downloads must use the protected resource download route; never rebuild annotation JSON from an already-open editor or buffer large media into a browser Blob
  - uploaded media and aliyun_vod are distinct sources: VOD may be bound/copied/moved/authorized but has no platform original-file
    download. Local computer media, uploaded server media, and VOD entry points must remain available as separate workflows
  - future analysis-audio selection belongs to platform media/derived-asset state, never `ProjectData`. Automatic embedded/uploaded/
    same-vid VOD audio remains the default, but users must always be able to force a readable uploaded server audio resource,
    even while automatic VOD audio works, so analysis can completely bypass a slow provider; restoring automatic selection is explicit
- `src/platform/ResourcePermissionEditor.tsx`
  - owns permission-matrix loading, simple/detailed presentation, direct grant writes, resource inheritance controls, and explanations
    for role/inherited residual access; both modes edit the same direct ACL and must reread the server matrix after every write
  - simple mode is three mutually exclusive base presets plus an independent review checkbox. “不额外授权” deletes the direct
    grant only when review is also off; review-only is a real ACL and never implies read. Owner/admin rows stay immutable, and row
    writes block mode switching/refresh until their authoritative result is reloaded
- `src/platform/ProjectPermissionManagementDialog.tsx` + `src/platform/projectPermissionManagement.ts`
  - global-admin three-pane quick assignment for one active account and one active project; account/project searches are independent,
    the selected project matrix is authoritative, and owner/admin rows remain read-only
  - every nonempty project simple selection uses `inheritToChildren=true`; custom or non-inheriting direct ACL requires explicit
    overwrite confirmation. None without review deletes only the project direct ACL and must explain remaining role/ancestor access
- `src/platform/ResourcePermissionPresetSelector.tsx`
  - shared controlled presentation for three base-preset radios plus one independent review checkbox. It owns icons, labels, ARIA,
    resource applicability, and delegation-disabled display only; it never performs network writes or computes roles, ownership,
    inheritance, or effective permissions
- `src/platform/resourcePermissionPresets.ts`
  - the only frontend mapping for `none | view | edit` base presets and the orthogonal review addon. View is `read + download`; edit
    adds ordinary content/file operations and container `create_child`; review adds only `review`, never `read` or
    `manage_permissions`
  - recognition removes optional review before exact base matching so all six standard combinations round-trip, while other grants
    remain custom. This helper must not calculate roles, inheritance, ownership, expiry, or effective permission; those remain
    authoritative server concerns
- `src/platform/AccountManagementDialog.tsx` + `src/platform/ChangePasswordDialog.tsx`
  - global account lifecycle/role administration and all-user self-service password change
  - neither component edits resource ACL; password values must never enter audit details, logs, saved project state, or browser drafts
- `src/platform/AnnotationMediaBindingDialog.tsx`
  - shared JSON-import/Inspector/editor picker for root/project/folder navigation, bounded pagination, current-directory search,
    existing media, new upload, explicit unbind, and later rebinding
  - selection is only intent; the API must recheck annotation write plus media read/download and active media type
- `src/platform/resourcePickerPaging.ts`
  - generic bounded filtered-page collector for resource pickers; it may skip a limited number of irrelevant pages while
    preserving the server cursor and must never turn a picker into a hidden full-directory fetch
- `src/platform/AuditLogDialog.tsx`
  - standalone global-admin audit browser with draft/applied filters, stable incremental loading, and server-side CSV export
  - resource-scoped non-admin access is supported by the API contract but is not a substitute for the Inspector permission UI
- `src/platform/auditLogView.ts`
  - exhaustive Chinese audit-action labels plus deleted-resource/user fallbacks and bounded detail formatting
- `src/platform/ResourceRecoveryHistory.tsx`
  - annotation-file Inspector recovery-history list, read-only snapshot detail, safe restore, and snapshot/current comparison entry
  - loads lightweight summaries first, requests one full snapshot payload only after explicit selection, and refetches the
    current annotation file when comparison starts rather than trusting stale Inspector metadata
- `src/platform/AnnotationReviewPanel.tsx`
  - platform-editor governance panel for browsing, creating, navigating to, and withdrawing/revoking confirmations and range comments
  - uses the existing loop range as an explicit review range; comments never imply confirmation, and neither fact may edit `ProjectData`
  - docked and detached rendering share one data/mutation path. Detached Radix dialogs must portal into the detached document;
    the detached copy stays expanded while the docked copy may use the standard sidebar collapse control
- `src/platform/useAnnotationReviews.ts`
  - authoritative client-side confirmation/comment list, pagination, create and withdraw lifecycle for one open annotation file
  - rejects stale async responses across file switches and refreshes after mutations or `annotation.review.changed` hints instead of
    optimistically inventing facts
- `src/platform/annotationConfirmationView.ts`
  - pure labels, persisted-track options, both lifecycle/freshness view records, create blockers, withdraw visibility, and shared interval layout
  - Timeline and panel must consume this module instead of duplicating review state or target formatting
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
  - clean remote replacement must atomically advance current/saved `ProjectData` and the document-owned remote revision;
    App-level revision/cursor state alone is insufficient, because the next successful local acknowledgement validates against
    `syncState.remoteRevision`
  - an acknowledged response may repair a lower document-owned revision only when the frozen plan's server-base ProjectData
    exactly equals the current saved baseline; a higher revision or base mismatch remains a hard rejection
  - migrated edits may carry a validated versioned command envelope; history retains the forward envelope so undo records
    its inverse and redo records the original command; unported edits remain legacy operations
  - `acknowledgeAtomicCommandBatch()` may advance only the exact pending prefix plus saved ProjectData/track-snap/remote baseline;
    later current state, operations, and history remain local and dirty
- `src/components/Timeline.tsx`
  - heaviest file
  - owns zoom, ruler scrubbing, snapping, marquee selection, drag/resize, creation flows, waveform guides, spectrogram lane rendering, loop range interaction, Gongche lane rendering, attached point editing
  - sentence overlay right-click only reports the stable sentence id and viewport coordinates to App; Timeline must not
    duplicate sentence-classification mutations, move the playhead, or disturb left-button timing drag behavior
  - sentence overlay labels use content-fit tiers based on block width plus sentence/delivery/role visual text widths: full
    delivery/role/text, then role/text, then text only. Keep the decision in `sentenceTimelineLabel.ts` and the whole visible
    label in one sticky content group so horizontal scrolling does not detach metadata from the sentence
  - publishes only exact pointer time to the collaboration callback and renders remote playhead/pointer/selection hints as
    read-only `pointer-events: none` overlays using the same `trackHeaderWidth + time * zoom` coordinate as local timing
- `src/components/VideoPlayer.tsx`
  - owns master-backend mount/unmount, the synchronized playback runtime, preview-frame behavior, native controls auto-hide,
    VOD loading/error UI, hidden inert VOD-audio host, and detached-panel button; exposes `MediaPlaybackController`, never an
    HTML media element or supplier player
  - external audio is optional and defaults to original sound. Master source/retry effects must reapply the current selection
    intent before ready, while same-source selection stays idempotent across layout/passive effects
- `src/media/mediaPlaybackController.ts`
  - App-facing playback contract and latest-command ordering; all App media commands must pass through this boundary
  - expected source-switch/preview cancellation is not a user error, while play/seek failures are contained by the player UI
- `src/media/nativeAudioPlaybackBackend.ts` + `src/media/aliyunVodPlaybackBackend.ts`
  - the external-audio-capable playback backends; HTMLAudio owns and removes its listeners, while Aliplayer validates an explicit
    expected `video | audio` kind and retains rate/volume/mute across short-session refresh
  - buffering is an event to the synchronized composite owner. App and Timeline must never operate the hidden audio element or
    supplier player directly, and dispose/source generation must make all late events inert
- `packages/shared/src/mediaAudioTracks.ts` + `packages/shared/src/mediaAudioPlaybackSession.ts` +
  `packages/shared/src/mediaAnalysisIdentity.ts`
  - strict platform contracts for a primary media's ordered audio-track set, shared annotation-file default preference,
    short-lived file-bound playback session, bounded analysis status, and media-scoped analysis run identity
  - embedded original audio, independent media resources, and same-VID VOD renditions are distinct source variants. Original
    uses the primary media at zero offset; a rendition binds a real VOD media resource plus JobId. Persistent DTOs never carry
    URLs, AccessKeys, provider responses, or ProjectData; PlayAuth/temporary HTTPS source exists only in strict no-store sessions
- `apps/api/src/mediaAudioTrackService.ts`
  - the only backend business boundary for a primary media's ordered audio-track relations and an annotation file's shared
    default audio preference; it also produces the strict annotation-context playback-option snapshot without issuing VOD
    credentials. Persistent track records deliberately do not claim analysis status before a real media-scoped run is resolved
  - primary-media mutations reuse the resource-tree advisory gate, lock the media row, and recheck ACL. Independent sources
    must be active audio resources with `read + download`; VOD renditions require an active video VOD source with the same
    capabilities and a provider-confirmed JobId. Listing relation metadata never grants playback or analysis access
  - option DTO `canManageTracks` is derived only from effective primary-media `write`. Annotation-file write independently
    controls the shared default; frontend visibility is only a hint and every CRUD/default mutation must reauthorize server-side
  - uploaded/VOD media creation and media copy must create exactly one original track in the same transaction. Copies get only
    their own original, while disabling/deleting external tracks clears default references without deleting source media;
    rebinding an annotation file atomically removes its old audio preference
  - media analysis reuse identity contains only media resource, source fingerprint, algorithm version, and config hash.
    Annotation-file identity, source-selection mode, and track offset must never be added; offset only maps source time to
    project time
- `apps/api/src/mediaPlaybackAccess.ts` + `apps/api/src/mediaAudioPlaybackSessionService.ts` +
  `apps/api/src/aliyunVodPlaybackSessionIssuer.ts`
  - the only external-track playback authorization and shared VOD credential boundaries. Every session request revalidates the
    active annotation, its current primary media, track ownership/enabled state, source audio type, and all required
    `read + download` capabilities; relation creation never substitutes for playback-time authorization
  - option snapshots and real playback sessions share the same active-media/source/ACL resolver. Option availability is a
    no-store hint for UI and never replaces session-time authorization; listing options must not issue PlayAuth or read objects
  - uploaded sessions return file identity only and continue through the protected Range route. Main video and audio VOD use
    one issuer; missing License fails before PlayAuth, provider errors are normalized, and session payloads are never audited,
    logged, cached, or persisted
  - same-VID rendition sessions re-fetch the exact stored JobId and return only a short-lived HTTPS source in the no-store DTO;
    missing/replaced streams fail closed and must never silently select another bitrate or rendition
- `src/media/synchronizedPlaybackPolicy.ts` + `src/media/synchronizedPlaybackState.ts`
  - pure RA0 contracts for master-video/audio time mapping, drift classification, source-generation ordering, buffering,
    resync, failure, and disposal; they do not own media elements, timers, React state, or temporary playback sessions
  - late events from an old audio-track generation are normal stale facts, while illegal events for the current generation
    remain explicit invalid transitions. Repeated browser ready/play/buffering facts are intentionally idempotent
  - these pure modules are consumed by `SynchronizedMediaPlaybackRuntime`; analysis display selection remains a separate later
    phase and must not be inferred from playback state
- `src/media/synchronizedMediaPlaybackRuntime.ts` + `src/media/synchronizedPlaybackDiagnostic.ts` +
  `src/media/externalAudioPlaybackBackendFactory.ts`
  - the only composite playback owner and delayed external-backend construction boundary. Video remains the authoritative clock;
    at most one external backend may exist, and selection/command generations make old prepare/ready/error/buffering facts inert
  - uploaded URLs and VOD PlayAuth are requested only inside the factory, remain memory-only, and are disposed on cancellation,
    timeout, source switch, master replacement, or failure. App, Timeline, collaboration, ProjectData, drafts, and undo/history
    must never own the second media element or temporary session
  - the preparation signal owns only the initial external-source request. After installation, every VOD refresh receives a fresh
    signal from `AliyunVodPlaybackBackend`; backend disposal aborts all in-flight session requests. Never capture the completed
    preparation controller for later refreshes or rely only on generation checks to leave an HTTP request running
  - selection must mute the master before asynchronous preparation. External failure, revoked/unavailable selection, or option
    loading failure pauses playback and keeps master audio muted; only an explicit original selection restores master output.
    Offset maps playback time only and never changes analysis identity
  - drift/buffering diagnostics are bounded session-only facts: emit only meaningful resync/recovery boundaries, use closed
    reason/phase values plus clamped integer measurements, and never include account/file/track identity, URLs, credentials,
    provider errors, or stacks. Diagnostic callbacks are observers and must never control or delay safe playback actions
  - buffering duration uses an injectable monotonic clock. Repeated buffering events count once, and pause/source change/dispose
    clears unfinished observations. A seek completing after user pause is a normal cancelled recovery, not an invalid transition
  - native/Aliplayer control events and natural master-media end must call the runtime's single master-play-state boundary.
    Internal buffering pauses preserve the playing intent; user pause/end stops the external backend and drift sampler. The
    boundary returns the effective state so an error-state nested pause cannot leave React displaying a false playing state
  - external before-start/playable/after-end/invalid observations are generation-local. Sampling performs boundary pause only
    when the region changes, while explicit seek/alignment remains authoritative and can return a shorter track to playback
- `src/platform/usePlatformAudioTrackSelection.ts` + `src/platform/platformAudioTrackSelection.ts` +
  `src/components/AudioTrackSelector.tsx`
  - own the annotation-file session's playback-option load, shared-default initialization, current listening selection, retry,
    refresh, and compact top-menu surface. Current selection is React session state only and must never enter ProjectData,
    revision/operations, drafts, collaboration, undo/history, analysis settings, or mutation leases
  - refresh preserves the current listening intent even when that track was removed or revoked, producing an explicit blocked
    state instead of silently choosing original. Updating the shared default is a separate permission-gated API action; original
    maps to a null preference and a default-write failure must not alter current playback
- `src/platform/usePlatformAnalysisTrackSelection.ts` + `src/platform/platformAnalysisTrackSelection.ts`
  - own the editor-session-only analysis display choice. Each file/media session starts by following the current listening track;
    disabling follow freezes that instant's identity, and later listening changes do not move the fixed analysis track
  - a deleted, disabled, or revoked fixed track remains an explicit unavailable identity rather than silently falling back to
    original audio. This state never enters ProjectData, revisions, drafts, collaboration, undo/history, localStorage, or the
    shared listening default
- `src/media/nativeMediaPlaybackBackend.ts`
  - narrow HTMLMediaElement adapter with deterministic seeked/error/timeout/dispose settlement
- `src/media/aliplayerSdk.ts` + `src/media/aliyunVodPlaybackBackend.ts`
  - fixed official Aliplayer 2.38.3 CDN loader and the only VOD player adapter
  - every real session must include the server-validated Web License `domain + key` and pass it through the SDK `license`
    option; missing License is a deployment error, never a reason to downgrade the SDK or reuse a stale PlayAuth
  - short-lived sessions stay memory-only; refresh is single-flight, obtains new credentials before replacing the old player,
    and generation checks reject late provider events after source switch/dispose
  - ordinary VOD uses vid + PlayAuth, while a same-VID audio rendition uses the no-store HTTPS source with mediaType audio and
    format mp3. Both paths share the same refresh, time/rate/volume restoration, generation, and disposal logic
- `src/components/InspectorPanel.tsx`
  - canonical editor for selected items, tracks, sentence delivery/role classification, attached point tracks, spectrogram
    settings entry, and Gongche editing entry points
- `src/components/SentenceAnnotationSettingsDialog.tsx`
  - the single ordered role-option editor used by both the Edit menu and built-in character-track Inspector entry
  - add/rename/delete/reorder callbacks remain App-owned because role changes must coordinate structure leases, commands,
    history, sentence-reference cascades, and collaboration state
  - role drag/drop reuses Atlaskit Pragmatic Drag and Drop and carries stable role names rather than array indexes; unsaved
    rename drafts, delete confirmation, read-only/catch-up gates, and an in-flight structure mutation disable drag start
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
  - v1-v5 files normalize to v6 by adding an empty sentence-role list and nullable sentence classification; historical
    per-character singing style and built-in character-track options are intentionally omitted from current output
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
- `src/utils/sentenceClassification.ts`
  - the only sentence completion rule and delivery-mode label mapping used by the sentence list and Timeline
  - a sentence is complete only when delivery mode is `spoken | sung` and its nonempty role still exists in the project role list
- `src/utils/sentenceRoleReorder.ts`
  - pure immutable conversion from a stable source role plus target `before | after` edge to the next ordered role list
  - no-op and stale-name drops return `null`; DOM drag behavior stays in the Dialog and App alone starts structure mutations
- `src/utils/sentenceTimelineLabel.ts`
  - pure sentence-overlay content-fit policy; estimates Unicode visual width and compares complete candidate labels with the
    actual time-derived block width. Do not replace this with fixed CSS/container breakpoints
- `src/utils/platformOperations.ts`
  - stable operation request builder plus structured manual/automatic server-save outcomes
  - sends migrated domain envelopes intact; it must never reduce them back to boolean legacy summaries
  - retryable save failures are limited to offline/network/408/429/5xx; conflict and deterministic 4xx must stop autosave
- `src/utils/editorProjectEquality.ts`
  - pure editor-level ProjectData equality that ignores non-persisted media runtime details without caching mutable object signatures
- `src/utils/timelineTimingCommand.ts`
  - Web compatibility re-export for the shared validated timing builder, resolver, and Gongche transaction-target collector
- `src/utils/timelineTimingCommandApply.ts`
  - Web compatibility re-export for the shared timing apply adapter; do not add another Web implementation
- `src/utils/annotationContentCommand.ts`
  - Web compatibility re-export for the shared content resolver/builder/writer
- `src/utils/annotationContentCommandApply.ts`
  - Web compatibility re-export for the shared all-or-nothing content adapter
- `src/utils/annotationLifecycleCommand.ts`
  - Web compatibility re-export for the shared lifecycle resolver/builder/writer
- `src/utils/annotationLifecycleCommandApply.ts`
  - Web compatibility re-export for the shared all-or-nothing lifecycle adapter
- `src/utils/annotationStateCommand.ts`
  - Web compatibility re-export for the shared Gongche/Banyan state resolver/builder/writer
- `src/utils/annotationStateCommandApply.ts`
  - Web compatibility re-export for the shared all-or-nothing state adapter
- `src/utils/annotationCompositeSnapshots.ts`
  - Web compatibility re-export for shared Gongche-symbol and Banyan snapshot conversion
- `src/utils/banyanReferenceIntegrity.ts`
  - Web compatibility re-export for the shared Banyan reference validator/repair policy
- `src/utils/gongcheSymbols.ts`
  - stable-id-preserving Gongche quick-input/add/remove redistribution helpers; UI code must not regenerate all symbol ids on every edit
- `src/utils/annotationTransactionCommand.ts`
  - Web compatibility re-export for the shared annotation transaction builder
- `src/utils/annotationTransactionCommandApply.ts`
  - Web compatibility re-export for the shared annotation transaction apply adapter
- `src/utils/projectValueEquality.ts`
  - Web compatibility re-export for document-model's reference-first deep equality
- `src/utils/customTrackStructureCommand.ts` + `src/utils/customTrackStructureCommandApply.ts`
  - Web compatibility re-exports for document-model's canonical ProjectData snapshot/builder/apply path
  - the command updates existing custom tracks only; its complete-next equality gate must reject block content, timing,
    lifecycle, attached-point, or other out-of-contract changes
- `src/utils/trackStructureLifecycleCommand.ts` + `src/utils/trackStructureLifecycleCommandApply.ts`
  - Web compatibility re-exports for canonical full-owned-subtree snapshots and exact collection-position apply for
    custom-track, builtin character-track, and attached-point-track creation/deletion leaves
  - custom tracks must occur exactly once in both `customTracks` and `activeTrackOrder`; attached point-track ids are global
    across parents; every top-level track must occur exactly once in `activeTrackOrder`. Malformed absence must never be
    reinterpreted as a valid creation.
- `src/utils/trackStructureTransactionCommand.ts` + `src/utils/trackStructureTransactionCommandApply.ts`
  - Web compatibility re-exports for the canonical ProjectData builder/apply path
  - orders parent creation/deletion around content/lifecycle/state children, proves the complete next project by replay, and
    publishes no partial result when any child or final reference/container invariant fails
- `src/utils/trackConfigurationCommand.ts` + `src/utils/trackConfigurationCommandApply.ts`
  - Web compatibility re-exports for canonical top-level track order, builtin-track configuration, and
    attached-point-track configuration snapshot/build/apply
  - configuration snapshots never contain characters, points, or other owned entities; content cascades must be explicit
    transaction children, and point-track ids must resolve uniquely across every parent track
- `src/utils/annotationCommandApply.ts`
  - Web compatibility re-export for the generic document-model dispatcher used by clean catch-up; it only discriminates
    validated command types and must not duplicate a domain parser, precondition, or apply implementation
  - snapshot boundaries return `snapshot_required`; they are valid operation facts but never mutate a local ProjectData
- `packages/shared/src/annotationCommands.ts`
  - authoritative timing/content/state/lifecycle/transaction annotation-command DTOs, deterministic builders/inverse, strict discriminated unknown
    parsers, all-target precondition assessment, target keys, limits, and API action/payload allowlist shared by web,
    IndexedDB recovery, and Fastify
  - `annotation.track.structure.transaction.apply` is the only top-level container allowed to combine structure leaves with
    ordinary domain leaves; it requires one structure child, forbids recursion, and shares one 20-command/500-entity budget
  - `getAnnotationMutationLeasePurposeForCommand()` is the sole App/API semantic lease resolver. Callers that need a purpose
    must pass the full envelope because snapshot-boundary kind distinguishes `bulk_import` from `bulk_repair`; the boolean
    type helper exists only for compatibility.
  - sentence content targets distinguish `text`, `deliveryMode`, and `roleType`; nullable classification values are deliberate
    unannotated states. The project role list is a fixed state target and rename/delete cascades must combine sentence content
    leaves plus that state leaf in one structure transaction, never as independent local mutations
  - the atomic command-batch route applies replayable envelopes to `AnnotationFile.payload`; the editor uses this route for
    ordinary timing/content/lifecycle/state edits and bounded structure transactions. Legacy full snapshots remain only at
    explicit import/repair, old-payload migration, submitted-draft, track-snap, and other documented snapshot boundaries.
- `packages/shared/src/annotationCommandCommit.ts`
  - authoritative ordered atomic-command batch request parser, count limit, replayable-envelope gate, and shared client
    operation id validator
  - array order is semantic because later commands may depend on earlier after values; legacy summaries and snapshot
    boundaries are intentionally rejected and remain full-payload save cases
- `packages/shared/src/annotationCollaboration.ts`
  - authoritative strict WebSocket protocol for session/revision/presence and complete transient Timeline activity snapshots
  - activity contains nullable playhead, pointer, and anonymized selection-summary fields; exact-key parsing, bounded
    times/counts/kinds, stable kind ordering, and defensive nested cloning are shared by browser and Fastify
- `packages/shared/src/customTrackStructureCommands.ts`
  - strict top-level structure DTO/parser/builder/inverse; it is excluded from `annotation.transaction.apply` because every
    newly accepted structure operation requires a file mutation lease
  - before/after keep track type and block identities stable; recursive lane identity/parentage, block-parent cycles,
    branch-scope references, ordering, no-op, and the 500-item budget fail closed
- `packages/shared/src/trackStructureLifecycleCommands.ts`
  - strict structure-only leaf DTOs for custom-track, builtin character-track, and attached-point-track lifecycle; these leaves
    are legal only inside the top-level structure transaction and are not standalone operation actions
- `packages/shared/src/projectSnapshotBoundaryCommands.ts`
  - strict small intent envelope for approved bulk import/repair boundaries; it stores id/kind/direction only, never ProjectData
  - inverse flips direction, but the command is deliberately non-replayable. API acceptance/logging and browser drafts are valid;
    committed-feed catch-up must fetch the authoritative snapshot instead of calling a ProjectData apply adapter.
- `packages/shared/src/trackConfigurationCommands.ts`
  - strict transaction-only leaves for track order and existing builtin/attached-point-track configuration
  - order updates preserve the exact id set; configuration updates preserve identity/parent scope, reject no-ops and duplicate
    targets, and share the structure transaction's 500-entity budget
- `apps/api/src/`
  - Fastify backend: auth, resource routes, resource ACL evaluation, annotation-file revision saves, Prisma mapping,
    and replaceable local/S3 object storage
- `apps/api/src/serverConfig.ts`
  - API 生产启动配置的唯一解析边界；生产默认只监听 loopback、禁用开发 seed 和 CORS，并要求显式数据库
  - 新增安全相关环境变量时必须在这里严格 fail closed，同时更新专项测试、环境模板和部署说明
- `apps/api/src/bootstrapAdmin.ts` + `apps/api/src/bootstrapAdminArguments.ts` + `apps/api/src/bootstrapAdminCli.ts`
  - 空数据库首位 `super_admin` 的一次性创建边界；事务 advisory lock 防止并发创建
  - 密码只从 stdin 读取，不能进入 argv、环境模板、日志或审计详情；已有管理员后必须永久拒绝 bootstrap
- `apps/api/src/database.ts`
  - shared PrismaPg connection factory plus dedicated maintenance and collaboration `pg` pools
  - explicitly aligns Prisma schema and PostgreSQL `search_path`; tests and CLIs must use this composition root instead
    of constructing a second adapter path
  - collaboration LISTEN/NOTIFY connections must never reuse Prisma business-query or maintenance advisory-lock pools
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
  - AWS SDK v3 adapter for S3-compatible staged multipart upload, size-aware publish, Range reads, paginated listing,
    deletion, readiness, and prefix isolation
  - publish uses single `CopyObject` only through the decimal 5 GB boundary; larger objects use bounded-concurrency
    multipart copy with contiguous ranges, ordered completion, abort-on-failure, and a 5 TB fail-closed object ceiling
- `apps/api/src/resourceAccess.ts`
  - authoritative server-side resource capability resolution
  - combines global admin bypass, ownership, direct grants, and nearest inherited folder grants
- `apps/api/src/resourceService.ts`
  - resource-tree mutations, copy/move/trash behavior, annotation-file save/recovery, and confirmed-range governance
  - the project-permission selector endpoint is a global-admin-only, stable cursor page over all active projects, including nested
    projects. It batch-loads ancestor paths and excludes projects below archived/trashed ancestors without changing the resource
    explorer's root-only `all_projects` semantics or returning full permission matrices
  - annotation save atomically binds the current actor's declared client operation ids to the new payload revision;
    missing, foreign, stale-base, or already-committed ids must roll back payload, revision, snapshots, and audit together
- `apps/api/src/annotationFileWriteLock.ts`
  - the single transaction lock order for annotation content writes: shared resource-tree lock, resource row, active ancestry,
    transaction-scoped ACL, then annotation-file row
  - operation, save, restore, and mutation-lease services must reuse it instead of checking permission/activity independently
- `apps/api/src/annotationMutationLease.ts`
  - pure lease purpose/token/hash/expiry policy; plaintext lease tokens must never enter PostgreSQL, audit details, logs, or payloads
- `apps/api/src/annotationMutationLeaseStore.ts`
  - shared active-lease write guard for operation/save/restore; an active lease requires holder, token, and base revision to match
  - `annotation.track.structure.update` passes `required=true`, so it is rejected without a lease even when no lease row
    exists; ordinary domain and legacy commands preserve the no-lease path
- `apps/api/src/storage.ts`
  - local filesystem adapter for `ObjectStorage`, including staging, checksum/size/header capture, atomic publish, safe
    listing, and idempotent deletion; business services must not depend on `LocalObjectStorage` directly
- `apps/api/src/uploadPolicy.ts`
  - centralized upload limits, filename rules, and binary-signature media validation
  - single-file size is no longer capped at the Int4 2 GiB bound: `FileObject.size`/`MediaFile.size` are `BigInt`,
    and `XIQU_MAX_UPLOAD_BYTES` (a safe-integer env value) plus user/platform quotas are the only ceilings
- `apps/api/src/mediaUploadService.ts`
  - single-command media upload across storage staging, quota transaction, publish, and compensation
- `apps/api/src/objectLifecycleService.ts`
  - admin-only object orphan inspection and confirmed cleanup
- `apps/api/src/healthService.ts`
  - liveness/readiness dependency probes; readiness stays lightweight and does not recursively scan storage
- `apps/api/src/observability.ts`
  - per-app Prometheus Registry, normalized HTTP and operational Gauges, upload/cleanup outcomes, collaboration event-bus
    connection/queue/result metrics, and metrics-token validation
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
- `apps/api/src/annotationCommandCommitService.ts`
  - authoritative atomic commit boundary for ordered replayable annotation-command batches
  - locks the active file, rechecks ACL/base revision/lease purpose, strictly parses current `ProjectData`, applies the whole
    chain, and atomically writes snapshot, one revision, committed operations, audit, and lease release
  - exact retries must match the complete original actor/base/committed-revision sequence; subsets, reordering, partial
    legacy rows, or hash mismatches must never be reported as a successful replay
- `apps/api/src/annotationOperationRecord.ts`
  - single database-row to shared operation-record mapper for accepted feed, committed feed, and atomic commit responses
- `apps/api/src/annotationOperationPagination.ts`
  - pure bounded operation-feed limit and opaque file-bound cursor validation
  - sequence is a per-annotation-file log acceptance order and cursor is an observed-read position; neither proves that
    the corresponding full annotation payload has been persisted at a newer revision
- `apps/api/src/annotationCommittedOperationPagination.ts`
  - pure cursor for committed operation order `(committedRevision, acceptanceSequence)` and snapshot-revision starting points
  - acceptance and committed feeds intentionally use different cursors; never filter nullable committed rows behind an
    acceptance-sequence cursor because a sequence hole may become permanent
- `apps/api/src/annotationCollaborationTicketService.ts`
  - issues 30-second one-use WebSocket tickets and stores only SHA-256 token hashes
  - plaintext tickets travel in a WebSocket subprotocol header, never in the upgrade URL or normal access logs
  - consumption and every established-session recheck use current account activity, current roles, ACL, and active-tree state
- `apps/api/src/annotationCollaborationHub.ts`
  - process-local WebSocket fan-out only; cross-instance transport belongs to the revision/presence/activity event buses
  - rejects duplicate/backward revisions and duplicate member structures; clearing the last subscriber also clears the
    presence fingerprint so a reconnect always receives its first authoritative snapshot
  - remote activity is sequence-monotonic per connection, excludes the source session, and retains bounded clear
    watermarks so a delayed frame cannot resurrect disconnected playhead/pointer/selection activity
- `apps/api/src/annotationRevisionEventEnvelope.ts`
  - strict, exact-key, size-bounded cross-instance revision-event parser and schema-derived PostgreSQL channel name
  - events carry only source instance, annotation-file id, committed revision, and committed-feed cursor; never payloads,
    users, tickets, access tokens, filenames, or operation bodies
- `apps/api/src/postgresAnnotationRevisionEventBus.ts`
  - local-first revision publisher plus PostgreSQL LISTEN/NOTIFY cross-instance transport
  - only defines revision coalescing/protocol/metrics; shared queue and listener behavior belongs to the generic bus
- `apps/api/src/postgresCoalescedEventBus.ts`
  - generic bounded local-first PostgreSQL LISTEN/NOTIFY core with per-key coalescing and runtime reconnect
  - business wrappers own strict envelopes and labels; do not fork another connection/queue implementation
- `apps/api/src/annotationPresenceService.ts`
  - authoritative join/renew/leave/list service for 60-second PostgreSQL presence sessions
  - serializes per-file joins, enforces bounded file/user/member counts, aggregates tabs by account, and never persists
    presence into ProjectData, snapshots, operation logs, or audit logs
- `apps/api/src/annotationPresenceCoordinator.ts`
  - converts lossy file-level invalidations into single-flight authoritative member reads only when local subscribers exist
  - an invalidation during a read schedules exactly one follow-up pass; periodic refresh removes expired crash residue
- `apps/api/src/annotationPresenceEventEnvelope.ts` + `apps/api/src/postgresAnnotationPresenceEventBus.ts`
  - strict schema-isolated file-id-only invalidation protocol and PostgreSQL wrapper
  - NOTIFY must never contain member identities; every receiving instance rereads PostgreSQL before WebSocket delivery
- `apps/api/src/annotationRemoteActivityEventEnvelope.ts` + `apps/api/src/postgresAnnotationRemoteActivityEventBus.ts`
  - strict <=1500-byte transient activity envelope and schema-isolated local-first PostgreSQL wrapper
  - coalesces by annotation file plus activity session at the highest sequence; carries no annotation content, ACL, token,
    display name, entity id, track name, snapshot, operation, or audit fact
- `apps/api/src/annotationRemoteActivityRateLimiter.ts`
  - per-connection token bucket for high-frequency client activity; rate-limited sequences still advance the observed
    watermark so a later lower sequence cannot be accepted
- `apps/api/src/annotationCollaborationRoutes.ts`
  - owns socket authentication, heartbeat/ACL rechecks, presence join/renew/leave, subscriber registration, and shutdown cleanup
  - server-initiated closes must finalize presence immediately rather than waiting for the peer close handshake; shutdown waits
    in-flight ticket/join setup before Prisma closes
  - accepts only the strict bounded complete timeline-activity client message after `session.ready`; malformed, binary,
    oversized, or pre-ready messages fail closed, while slow-consumer activity frames may be dropped without affecting
    document correctness
  - client activity never becomes a save/operation path. HTTP remains the only annotation mutation and persistence path
- `apps/api/src/database.ts`
  - collaboration pool must accommodate three persistent LISTEN clients (revision, presence, activity), asynchronous NOTIFY,
    reconnect overlap, and controlled multi-app integration tests; do not reduce its max below the documented capacity audit
- `apps/api/src/requestAuthentication.ts`
  - shared HTTP Bearer parser; protected-media query-token compatibility remains explicit at its existing call site
- `apps/api/src/annotationFileActivity.ts`
  - shared active annotation-file and trashed-ancestor check used by content governance and collaboration tickets
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
- `deploy/single-server/`
  - R5 受控单服务器候选的环境、systemd 与 Nginx/TLS 模板；操作步骤只在 `docs/server-deployment.md` 维护
  - 模板不能包含真实域名、密码、metrics token、TLS 私钥或对象存储凭据
  - 首次正式生产部署默认使用空 PostgreSQL 数据库和空对象存储，运行 migration 后创建正式首管理员；本机
    debug 数据、开发 seed、`.env` 和 `data/` 只有在用户另行明确批准数据迁移时才允许进入生产
  - GitHub 只分发代码、migration 和模板；账号、资源树、标注 payload、媒体对象、分析瓦片和运行环境必须
    通过 PostgreSQL + 对象存储一致备份/恢复或全新初始化部署，绝不能把 `git pull` 当作数据迁移
  - 首次部署和升级都应从已审查 commit/tag 构建不可变 release，再原子切换 `/opt/xiqu/current`；不要在
    正在运行的 release 目录直接 `git pull`、重新构建或覆盖持久数据
  - production release must include `prisma.config.ts` and built `packages/shared`/`packages/document-model` in
    addition to `prisma`, `dist`, and `node_modules`: Prisma 7 migration reads the root config, while npm workspace
    links under `node_modules/@xiqu` resolve back into `packages/`. Verify these paths before starting systemd services
  - Prisma schema changes are independent of `package-lock.json`: never reuse an earlier release's generated
    `node_modules/.prisma` or `node_modules/@prisma/client` merely because the lock hash is unchanged. Every candidate
    must run `db:generate` during its build and `release:check` before cutover. API, worker, and operational CLI startup
    also fail closed through `prismaClientSchemaGuard`; repair a mismatched candidate by building a new immutable release,
    never by mutating the active release. This same contract applies when rebuilding from Git on a replacement server
  - local restore drills publish through a sibling staging directory; place `target-storage` below a dedicated parent
    writable by `xiqu`, not directly below a root-owned persistent-data directory. A failed drill may already have restored
    the isolated database before object publication, so recreate only that isolated target before retrying
- `scripts/deploymentCheck.mjs` + `scripts/checkDeployment.mjs`
  - 无凭据、只读的部署 smoke check；统一验证 Web 入口、API liveness 与依赖 readiness
  - 不能把登录写入、迁移或破坏性恢复塞进 smoke check；这些步骤属于部署清单和人工验收
- `apps/api/src/prismaClientSchemaGuard.ts` + `apps/api/src/prismaClientSchemaGuardCli.ts`
  - compare the release source schema with Prisma's generated schema while ignoring formatting-only alignment; model,
    field, relation, enum, attribute, string, and meaningful comment changes remain detectable
  - `createPrismaConnection()` is the shared runtime fail-closed boundary, while `release:check` is the proactive
    pre-cutover command. Do not replace either with a model-name-only grep or a lockfile hash check
- `packages/shared/src/`
  - API/platform DTOs and shared contract types used by web and API
- `packages/document-model/src/`
  - pure persisted annotation-document types, resource-capability helpers, and annotation-confirmation contract logic
  - must not import React, DOM, Prisma, Fastify, or Web-owned `src/`; this package is the shared pure domain boundary for
    browser and API code
- `packages/document-model/src/projectData.ts`
  - the only definition of persisted `ProjectData`, `SavedProjectFile`, tracks, recursive branches, and annotation entities
  - platform revision/ACL/session, waveform/spectrogram caches, Inspector state, and Timeline selection must never enter it
  - R5b3a1 established this type boundary; R5b3a2 moved the complete pure command execution engine into the same package
- `packages/document-model/src/projectDataSchema.ts`
  - strict current-format runtime parser exposed only through `@xiqu/document-model/project-data-schema`
  - unknown database JSON must pass this boundary before authoritative command apply; it never performs legacy migration,
    default filling, unknown-key stripping, media hydration, or semantic repair
  - the Zod dependency must stay off the document-model root barrel so Web consumers that do not parse server JSON do not
    pay its bundle cost
- `packages/document-model/src/timelineTimingCommand*.ts` + `annotationContentCommand*.ts` + `annotationStateCommand*.ts`
  - R5b3a2a shared pure resolver/builder/writer/apply core for timing, stable content, and Gongche/Banyan full state
  - standalone timing/content/state builders must prove complete-next reconstruction instead of comparing only declared targets;
    annotation transactions use leaf envelope builders and perform the complete proof after all children are applied
  - parent character/sentence/custom-block timing that remaps Gongche must use
    `getGongcheTransactionTargetsForParents()` and include both block timing and surviving symbol state targets
- `packages/document-model/src/annotationCompositeSnapshots.ts` + `banyanReferenceIntegrity.ts` + `projectValueEquality.ts`
  - shared snapshot conversion, cross-entity reference validation/repair, and complete-project equality foundations
  - lifecycle and structure modules now consume the package implementation directly; no second function implementation may
    be added under `src/utils`
- `packages/document-model/src/annotationLifecycleCommand*.ts` + `annotationTransactionCommand*.ts`
  - R5b3a2b canonical lifecycle collection-position resolver/writer and ordinary annotation transaction builder/apply
  - preserve parent existence, unique identity, exact collection position, final cross-entity references, and local-only
    transaction staging; a blocked child must never publish an earlier child's partial ProjectData
- `packages/document-model/src/customTrackStructureCommand*.ts` + `track*Command*.ts` + `annotationCommandApply.ts`
  - R5b3a2c canonical recursive-track structure, configuration, owned-subtree lifecycle, structure transaction, and generic
    dispatcher implementation; snapshot boundaries remain valid but non-replayable and return `snapshot_required`
- `packages/document-model/src/annotationConfirmations.ts`
  - canonical neutral review-scope normalization, overlap, persisted-track and permission helpers plus confirmation lifecycle/freshness
  - contains no Prisma, API, React, payload mutation, or global-role lookup; backend and platform UI must reuse
    this contract instead of duplicating scope or freshness rules
- `packages/document-model/src/annotationRangeComments.ts`
  - required-body validation and comment lifecycle/freshness rules layered on the canonical neutral review scope
  - comment text is business data returned only by the protected comment API; it must never enter audit detail, WebSocket, NOTIFY or logs
- `prisma/schema.prisma`
  - PostgreSQL schema for users, sessions, resource entries, projects, annotation/media files, resource permissions/user state,
    recovery snapshots, confirmed ranges, range comments, short-lived collaboration presence, processing jobs, audit logs, and operations
- `docs/`
  - roadmap, architecture notes, and curated screenshots; keep this updated for long-running platform/backend work
- `docs/server-deployment.md`
  - R5 单服务器候选的唯一部署手册，覆盖迁移、首管理员、持久目录、TLS、健康检查、备份、升级和回滚
  - 它不是 R7 生产认证；目标环境 IAM、防火墙、告警、续期、容量和灾难恢复结果必须另行验收
  - 接手部署前先核对本地 HEAD、远端目标 commit 与干净工作区；部署完成后把 release commit、migration、
    备份 id、环境变更和人工验收结果记录到受控运维记录，不在仓库日志中写入任何真实凭据
- `deploy/monitoring/`
  - vendor-neutral Prometheus scrape/rule and Alertmanager example configuration
  - real metrics tokens, receiver URLs, TLS material, and deployment secrets never belong in this directory
- `src/types.ts`
  - Web runtime types for derived track views, audio-analysis caches, Inspector focus, and editor selection
  - compatibility type re-exports point to `@xiqu/document-model`; do not recreate persisted project types here
- `src/mockData.ts`
  - runnable demo dataset
- `examples_insights/`
  - real example annotation data and research notes; use it as format/workflow reference, not as app runtime source

## Commands
- `npm install`
- `npm run dev`
- `npm run dev:web`
- `npm run dev:api`
- `npm run dev:analysis-worker`
- `npm run db:generate`
- `npm run db:push`
- `npm run db:migrate`
- `npm run db:deploy`
- `npm run build`
- `npm run test:api`
- `npm run test:permissions`
- `npm run test:annotation-confirmations`
- `npm run test:project-data-schema`
- `npm run test:annotation-confirmation-view`
- `npm run test:annotation-commands`
- `npm run test:annotation-command-commit`
- `npm run test:timeline-timing-command`
- `npm run test:timeline-timing-command-apply`
- `npm run test:annotation-content-command`
- `npm run test:annotation-lifecycle-command`
- `npm run test:annotation-state-command`
- `npm run test:custom-track-structure-command`
- `npm run test:annotation-mutation-lease`
- `npm run test:annotation-transaction-command`
- `npm run test:platform-operations`
- `npm run test:platform-auto-save`
- `npm run test:platform-auto-save-runtime`
- `npm run test:platform-atomic-submit`
- `npm run test:platform-mutation-lease-runtime`
- `npm run test:platform-operation-catch-up`
- `npm run test:annotation-collaboration`
- `npm run test:annotation-presence`
- `npm run test:annotation-revision-event-bus`
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
- upload defaults are `XIQU_USER_STORAGE_QUOTA_BYTES=20 GiB`,
  `XIQU_PLATFORM_STORAGE_QUOTA_BYTES=200 GiB`, and `XIQU_ORPHAN_GRACE_MS=24h`. `XIQU_MAX_UPLOAD_BYTES` no longer
  defaults to 1 GiB: when unset it equals the user storage quota (a single file cannot exceed the account quota
  anyway, so the quota is the per-file ceiling). `FileObject.size`/`MediaFile.size` are `BigInt`, so any of these
  may be set above 2 GiB; invalid values fail startup
- `/api/health/live` is dependency-free liveness; `/api/health/ready` and compatibility `/api/health` check
  PostgreSQL and storage-root readiness and return 503 when unavailable
- `/metrics` is disabled unless `XIQU_METRICS_TOKEN` is configured; it uses a separate Bearer credential rather than
  a browser session. Metric labels must remain low-cardinality and must never include user/resource ids, filenames,
  query strings, storage keys, or error messages
- operational metric scrapes share one bounded in-flight collection per API instance. Dependency-unavailable is a
  successfully collected fault, while collector exceptions/timeouts set `xiqu_operational_metrics_collection_success=0`
  and retain the previous real Gauge values rather than inventing zero usage.
- each API instance owns a small dedicated PostgreSQL collaboration pool. The schema-derived LISTEN/NOTIFY channel carries
  only bounded revision invalidations; it is not a durable queue and must never replace HTTP catch-up or revision checks.
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
- `sentenceAnnotationConfig`
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
- `SubtitleLine` / `SentenceAnnotationConfig`
  - `deliveryMode` is nullable `spoken | sung`; `roleType` is nullable and must reference the ordered project role list
  - both fields must be valid for a completed sentence; do not infer completion from color or duplicate the helper in UI code
  - role-list rename/delete must update affected sentence references in the same lease-protected structure transaction
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
- current `PROJECT_FILE_VERSION` is `6`
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
- right: sentence list + current line split + annotation review + inspector/settings; the review region may be docked,
  hidden, or detached without changing its platform facts

Global visibility controls:
- the top menu `视图` is the canonical place for toggling:
  - `音频波形`
  - `人声频谱图`
  - `板眼轨`
  - `全局板眼纵线`
- do not move Banyan visibility toggles back into `SpectrogramSettingsPanel`
- `SpectrogramSettingsPanel` may expose waveform visibility as a redundant convenience control because the waveform track is also the settings entry point for audio analysis

Command search (`搜索` top menu):
- the sixth top menu `搜索` is a full-feature index, not a second owner of any setting; `视图` remains canonical for visibility toggles
- `src/utils/commandCatalog.ts` holds the pure searchable definitions (id, label, breadcrumb path, keywords) and `src/utils/commandSearch.ts` the pure matcher; both are React-free and covered by `npm run test:command-search`
- runtime wiring lives in `src/App.tsx` as `commandSearchEntries`; every entry must reuse an existing handler and must never introduce a mutation path of its own
- toggle-vs-navigate is declared per field in the catalog: a searchable **toggle** flips the value through the same handler the panel switch uses (so it keeps undo history and the platform lease) and still selects/highlights the field; a **navigate** entry only scrolls to a control that needs real input (name, color, type list). Do not make search a silent mutation with no visible target
- a searched toggle must honour the same gating as its panel switch (e.g. the two snap sub-options stay disabled until the track-head `吸附` master switch is on), and its `checked` state must come from a pure resolver, not from a second copy of the rule
- invariant: an entry carries `checked` **iff** running it flips that value. Multi-choice controls (`纵轴映射`, `频率范围`, `分析精度`, `类型列表`) are one navigate entry with no `checked`; enumerated discrete actions (`播放速度 0.5x`…) stay one entry per value and apply directly, mirroring the `播放` menu
- platform-only entries are gated by absence: they are simply not written into the runtime map without an `editorSession`, so local mode cannot surface a dead entry
- static ids are typed as a required `Record<LocalStaticCommandId, …>`, so adding a definition without wiring it fails `tsc`; keep it that way instead of loosening the map to `Partial`
- pinyin fallback lives in `src/utils/pinyin.ts` (`tiny-pinyin`, MIT, ~13 KB dist): a latin-only query is folded against a full-pinyin and an initials string built from each entry's breadcrumb + label. It scores **below** explicit keywords and **above** path hits, and is skipped entirely for Chinese queries. `tiny-pinyin` is CJS `module.exports = {}`; the module keeps an explicit `default ?? namespace` interop fallback because Node ESM and Vite disagree on hoisting its named exports — do not "simplify" that away
- when adding a menu item, an Inspector track-settings field, or a `SpectrogramSettingsPanel` group, register it in the catalog in the same change; settings fields also need an `InspectorFocusTarget` in `src/types.ts` plus a `registerFocusField(...)` / `focusGroupProps([...])` anchor so search can scroll to and highlight them

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

The transient project is visual interaction state, not a persistable document revision. Until pointer-up has produced the
single replayable operation, both server autosave and IndexedDB recovery-draft writes must remain suspended. The server-save
entry point must also synchronously inspect `transientProjectRef.current`; React suspension facts alone cannot close the
timer/pointer-up race between adjacent frames.

### Critical state rule
Hot interaction paths depend on `projectRef.current`, not just render-state closures.
If changing drag, selection, clipboard, import merge, or undo logic, assume stale closure bugs are a real risk.

`ProjectData` equality follows its JSON persistence boundary for object properties: an absent optional key and an own key
whose value is `undefined` are equivalent, while `null`, array positions, and all concrete values remain strict. Normalizers
should omit empty optional keys instead of manufacturing `key: undefined`; command builders must keep using the shared
`areProjectValuesEqual()` proof rather than ad hoc stringify comparisons.

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

Writable platform sessions persist one sanitized, versioned IndexedDB recovery envelope. Same-revision recovery、stale
draft structured integration、network retry/backoff、server autosave、clean committed-feed catch-up and explicit 409
rebase decisions are implemented. Future sync work must continue through this document-state/command boundary rather
than bypassing it inside `App.tsx` or introducing a second WebSocket write path.

For online revision conflicts, App may automatically use the pure rebase planner only after auditing the complete local pending
chain. Disjoint commands replay unchanged; a definitive live 409 may rebuild same-target timing/content commands using the
document-model resolver described above. The document hook revalidates project/revision/operation identity, replaces pending
envelopes without changing operation ids, clears history snapshots tied to the old remote baseline, and autosave immediately
resubmits. Do not extend this later-client-wins rule to lifecycle, structure, bulk boundaries, stale browser drafts, or permission
failures. The collaboration WebSocket subscribes before rereading the authoritative file head and sending `session.ready`; it is
still only a lossy wake-up channel, never the source of committed project content.

## Platform / Backend Status
The platform backend is a real PostgreSQL/Fastify platform with an R5 controlled single-server deployment candidate;
it has not completed the separate R7 public-production acceptance:
- Fastify server entry: `apps/api/src/server.ts`
- routes: `apps/api/src/router.ts`
- repository queries: `apps/api/src/repository.ts`
- resource permission evaluation: `apps/api/src/resourceAccess.ts`
- resource and annotation-file mutations: `apps/api/src/resourceService.ts`
- account lifecycle administration: `apps/api/src/accountAdminService.ts`
- authenticated collaboration handshake: `apps/api/src/annotationCollaborationRoutes.ts` and
  `apps/api/src/annotationCollaborationTicketService.ts`
- Prisma row-to-DTO conversion: `apps/api/src/repositoryMappers.ts`
- development seed accounts/resource tree: `apps/api/src/repositorySeed.ts`
- production runtime policy: `apps/api/src/serverConfig.ts`
- one-time first administrator bootstrap: `apps/api/src/bootstrapAdminCli.ts`
- object storage port/factory: `apps/api/src/objectStorage.ts`, `apps/api/src/objectStorageFactory.ts`
- local/S3 adapters: `apps/api/src/storage.ts`, `apps/api/src/s3ObjectStorage.ts`
- shared API types: `packages/shared/src/`
- resource-capability helpers: `packages/document-model/src/`
- deployment templates and guide: `deploy/single-server/`, `docs/server-deployment.md`

Current backend capabilities:
- login/session tokens with scrypt password hashing and sha256 token hashes
- users/roles/sessions in PostgreSQL
- global-admin account creation, role/status updates and password reset, plus self-service password change; deactivation and
  password mutation revoke existing sessions, and the platform protects the current/last active global administrator
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
- annotation-to-media foreign-key binding with active media/type/ACL checks, auditable bind/unbind, and `ON DELETE SET NULL`
- hidden recovery snapshots created automatically before an annotation-file payload is replaced
- recovery-snapshot restore writes historical payload as a new monotonically increasing revision; current payload
  protection, annotation update, and audit entry commit in one transaction
- lightweight recovery-snapshot summary API plus a file-bound detail API for controlled Inspector previews
- recursive project/folder copy, media/annotation-file copy, file-like move/rename/soft-delete/restore, favorite, and recent-open state
- atomic batch trash with parent/descendant selection collapsing; the legacy single-item endpoint delegates to the same core
- audit-log table plus a generic browser/filter/export API for login, upload, resource mutations, permission changes,
  annotation saves, review facts, maintenance, and recovery operations
- annotation operation-log and committed-feed APIs with per-file/per-actor client idempotency, immutable request fingerprints,
  atomic payload/revision application for replayable domain batches, and snapshot fallback for explicit non-replayable boundaries
- confirmed annotation ranges backed by PostgreSQL, with all/domain/persisted-track scopes, immutable revision binding,
  additive revocation facts, list/create/revoke APIs, and same-transaction audit summaries
- placeholder processing-job API for future pitch, spectrogram, Gongche render, pose, transcode, and export services
- per-resource ACL:
  - capabilities are `read`, `write`, `review`, `create_child`, `copy`, `move`, `delete`, `download`, and
    `manage_permissions`
  - `super_admin` / `admin`, the resource owner, and the owner of an ancestor project/folder receive full effective resource access
  - only `super_admin` can manage account lifecycle and platform roles; `admin` must receive 403 from account-management APIs
  - `teacher` automatically receives global `read + download`, but not `write`, `review`, `create_child`, or
    `manage_permissions`; the former `ta` role is migrated to `teacher`
  - direct grants belong to one resource and one account
  - folder/project grants inherit to descendants unless a descendant sets `breakPermissionInheritance`
  - there is no explicit deny rule; a direct grant augments inherited capabilities
  - only users with effective `manage_permissions` may edit grants
  - authorization is enforced by the API; disabled frontend controls are only an affordance
  - `download` is checked independently from `read`; media streams and authoritative annotation JSON both use
    `/api/resources/:resourceId/download`, while projects/folders require a future bounded archive job
  - role defaults live in `packages/shared/src/platformRolePolicy.ts`, while effective ACL evaluation lives in
    `resourceAccess.ts`; do not create a second UI-only implementation

Annotation-review contract status:
- R2.5d extends the confirmed-range workflow with independent range comments. The shared panel lists current/stale and
  revoked/withdrawn facts, creates from the saved loop range, navigates to exact times, and preserves append-only history.
  The Timeline renders active confirmation and comment facts in one separate read-only lane with distinct colors.
- a confirmation binds one annotation file revision to a non-empty half-open time range and either all content, stable
  research domains, or real persisted parent-track ids. Derived Gongche, attached-point, and branch-lane visual tracks
  are not saved top-level track ids.
- confirmation and range comment are server governance metadata, never part of `ProjectData`, annotation payload, recovery
  snapshots, or annotation operation logs. Revision advancement makes either record stale; comments remain historical opinions
  and confirmations require a future explicit re-review rather than being silently carried forward.
- read access reuses resource `read`; create and revoke/withdraw require an independent per-resource `review` capability.
  `write`, `manage_permissions`, and the global reviewer role must not independently imply review authority.
- revocation preserves the original confirmation and records revoker/time/reason. Do not update or delete the original
  audit fact in place.
- comment withdrawal follows the same author-or-manager boundary. Comment bodies must not be copied into audit rows,
  collaboration messages, PostgreSQL NOTIFY payloads, server logs, or sync diagnostics.
- review mutations do not advance annotation revision. `annotation.review.changed` is a lossy invalidation hint only;
  HTTP confirmation/comment reads remain authoritative, including after reconnect or cross-instance delivery.

Current platform UI capabilities:
- login page without prefilled development credentials
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
- the current maintenance gate governs HTTP mutations only. The independent media-analysis worker does not yet acquire
  its permit or observe a drain phase, so operators must stop `xiqu-analysis-worker` before a consistent production backup,
  migration, or release cutover and restart it only after verification. Do not describe current maintenance as globally
  quiescent until the R7a worker-drain protocol is implemented and tested.
- the current editor recognizes a server `maintenance_mode` save rejection as non-retryable for that command chain, immediately
  checkpoints the latest writable file draft to IndexedDB, and warns again after each later local revision unless the user
  suppresses reminders for that one open-file session. Suppression must never stop draft persistence, survive a file reopen, or
  claim that the browser draft reached the server. This is a temporary R5 safety net, not the future public R7a drain protocol.
- API route handlers should perform runtime validation before Prisma writes; invalid revision/action/limit inputs should return `400`, stale annotation-file revisions should return `409`
- browser platform writes use `PATCH` and `DELETE`; keep both methods in the Fastify CORS allow-list when changing server bootstrap
- the API has an R5 controlled single-server deployment baseline, committed migrations, protected media serving, upload and
  collaboration rate limits, health/metrics, backup, and recovery; R7 public-production IAM, network, capacity, DR, and
  long-term security acceptance remain future target-environment work
- the browser platform client always targets same-origin `/api`; Vite proxies it in development and Nginx proxies it in
  deployment. Do not reintroduce an absolute visitor-local API URL into `PlatformWorkspace.tsx`
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
- storage quota counts each immutable FileObject once, regardless of how many media resources reuse it.
  `FileObject.size` / `MediaFile.size` are `BigInt`, so the per-file ceiling is no longer bounded by the
  PostgreSQL Int4 range; single-file size is governed by `XIQU_MAX_UPLOAD_BYTES` and the user/platform quotas.
  The wire format stays JSON `number`; BigInt↔number conversion happens only at the Prisma mapper boundary
  (`Number()` on read, `BigInt()` on write) — never introduce a global `BigInt.prototype.toJSON` patch.
- S3 staged promotion must not send objects larger than 5 GB through one `CopyObject`. Keep multipart-copy planning
  contiguous and below 10,000 parts, preserve bounded request concurrency, abort failed sessions only after in-flight
  parts settle, and delete the staged object only after complete succeeds. The single-server Nginx
  `client_max_body_size` and `XIQU_MAX_UPLOAD_BYTES` examples must remain aligned.
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
- `src/utils/timelineViewDefaults.ts` is the single session-default policy for waveform, spectrogram, Banyan track, and
  Banyan global guides; all four start hidden and users opt in from View/search/settings. These are UI session facts, not
  ProjectData, collaboration, undo/history, or analysis-asset state. Future preference persistence must remain outside the
  annotation JSON and must not remove the explicit manual toggles
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
- `docs/server-deployment.md`
  - R5 controlled single-server deployment guide and operator checklist
  - update it whenever production startup policy, environment variables, migrations, process management, proxy/TLS,
    health checks, backup, upgrade, or rollback behavior changes
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
- App uses only `MediaPlaybackController`; direct HTMLVideoElement or Aliplayer access outside the backends is prohibited
- native and VOD playback sync is requestAnimationFrame-driven from the same snapshot contract while playing
- preview mode pauses/resumes around ordered edge-preview seeks; later pause/play/seek commands always supersede older async work
- local computer media, uploaded server media, and Aliyun VOD must remain three independent selectable workflows

Aliyun VOD startup and credential rules:
- root `.env` is a local-development input only, must remain Git-ignored, and should have mode `600`; never print its real
  AccessKey, Secret, Web License key, playauth, or temporary media URLs into tool output, tests, screenshots, docs, or logs
- always start development API/worker through `npm run dev:api` and `npm run dev:analysis-worker`; both scripts use Node 22
  `--env-file-if-exists=.env`. Direct `tsx apps/api/src/server.ts`/`analysisWorkerCli.ts` execution bypasses this contract
- changing `.env` requires restarting the affected API/worker process. Vite HMR cannot update server credentials or provider
  configuration, and a process started before the change must be treated as stale
- VOD enable/region and Web License `domain + key` are server configuration. The License domain must equal the browser
  hostname registered in the Aliyun console: a `localhost` authorization requires opening `http://localhost:...`, not
  `http://127.0.0.1:...`; never include scheme, port, path, or wildcard in the configured domain
- server AccessKey/default-credential-chain identity authorizes VOD API calls; Web License authorizes Aliplayer in the browser.
  They are independent and must never substitute for each other. License data may cross the short-lived playback-session DTO
  only because the SDK requires it, but account-specific values still must not be hard-coded into frontend source
- production `start:*` does not read repository `.env`; systemd/container/secret management must inject configuration explicitly.
  VOD remains optional, and missing VOD configuration must never disable local-computer or uploaded-server media workflows

Audio pipeline:
- platform files never fetch and decode a complete uploaded/VOD video in the browser for analysis; the independent analysis
  worker streams uploaded objects or a short-lived VOD audio URL through FFmpeg and publishes ACL-protected waveform,
  spectrogram, and F0 tiles
- platform Timeline requests the current viewport first through `usePlatformMediaAnalysis`, then performs bounded adjacent-window
  prefetch and offers user-triggered full preloading of the current analysis configuration. Source changes and file switches
  must cancel or invalidate stale requests, and both memory/IndexedDB caches stay bounded. Pixel-level scrolling is quantized
  to the current run's server tile duration (new runs use 10 seconds; historical runs keep their manifest/config duration);
  one bounded binary batch carries missing waveform/spectrogram/F0 assets after one ACL check
- local computer media remains a browser-only fallback; a user-selected `blob:` may use the browser's full decode capacity,
  while non-Blob URLs retain the 256 MiB download cap. It may reuse the shared bounded STFT/YIN implementation, but protected
  platform uploaded/VOD URLs must never enter that path
- waveform keypoints remain onset-like heuristics for local analysis; platform waveform assets currently store min/max/RMS
  levels and do not fabricate keypoints

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
