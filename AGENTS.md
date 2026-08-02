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
- Fastify API backed by Prisma 7 and PostgreSQL, with local object storage under `data/`
- backend audit logs and annotation operation logs for the first platform-governance layer
- project document state architecture (`src/state/projectDocumentState.ts`)
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
- `src/platform/ResourceExplorer.tsx`
  - desktop-style three-pane resource manager
  - owns folder navigation, view switching, selection, keyboard actions, import/upload, and the resource Inspector
  - the Inspector is the canonical UI for editing each account's direct permissions on the selected resource
- `src/platform/ResourceRecoveryHistory.tsx`
  - annotation-file Inspector recovery-history list and read-only snapshot dialog
  - loads lightweight summaries first and requests one full payload only after explicit selection
- `src/platform/recoverySnapshotPreview.ts`
  - pure, failure-contained conversion from unknown historical payload to a current-format multimodal summary
  - reuses `normalizeImportedProjectFile()`; do not create a second project migration path for snapshot previews
- `src/platform/annotationDiff.ts`
  - pure stable-id structured comparison for two normalized annotation payloads
  - owns research-domain matching and left/right time ranges; UI must not re-diff raw payloads
- `src/platform/annotationDiffTimeline.ts`
  - pure time-index, filter, range validation, coordinate, and hit-test model derived only from structured diff
  - preserves one shared duration while filters change; invalid or untimed differences never enter Canvas as fake ranges
- `src/platform/AnnotationDiffTimelineOverview.tsx`
  - high-DPI read-only Canvas for left/right diff distribution; does not load files or own editor state
- `src/platform/AnnotationComparisonDialog.tsx`
  - owns parallel side-isolated reads, stale-response protection, structured diff presentation, time filters,
    Canvas/list bidirectional selection, left/right swapping, and explicit open-left/open-right commands
  - comparison remains read-only and must not instantiate a second editable Timeline inside the dialog
- `src/platform/annotationComparisonNavigation.ts`
  - pure validation and normalization from one diff entry's real left/right time range to a one-shot editor focus
  - missing, negative, or non-finite ranges return `null`; never substitute zero or the opposite side's time
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
- `src/platform/useResourceColumns.ts`
  - asynchronous visible-column loader with stale-response protection and conservative path validation
- `src/platform/ResourceColumnBrowser.tsx`
  - multi-column renderer; column group scrolls horizontally while each column owns vertical scrolling
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
- `apps/api/src/`
  - Fastify backend: auth, resource routes, resource ACL evaluation, annotation-file revision saves, Prisma mapping, and local object storage
- `apps/api/src/database.ts`
  - shared PrismaPg connection factory
  - explicitly aligns Prisma schema and PostgreSQL `search_path`; do not construct a second adapter path in tests
- `apps/api/src/resourceAccess.ts`
  - authoritative server-side resource capability resolution
  - combines global admin bypass, ownership, direct grants, and nearest inherited folder grants
- `apps/api/src/resourceService.ts`
  - resource-tree mutations, copy/move/trash behavior, annotation-file save, and recovery-snapshot creation
- `apps/api/src/resourceSelection.ts`
  - pure parent/descendant selection normalization shared by atomic batch move and batch trash
  - selected descendants collapse under a selected ancestor so a subtree is mutated only once
- `apps/api/src/resourceCopy.ts`
  - pure recursive-copy planning, topological ordering, id allocation, and internal media-reference remapping
- `packages/shared/src/`
  - API/platform DTOs and shared contract types used by web and API
- `packages/document-model/src/`
  - pure resource-capability helpers and their regression tests
- `prisma/schema.prisma`
  - PostgreSQL schema for users, sessions, resource entries, projects, annotation/media files, resource permissions/user state, recovery snapshots, processing jobs, audit logs, and annotation operations
- `docs/`
  - roadmap, architecture notes, and curated screenshots; keep this updated for long-running platform/backend work
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
- `npm run test:resource-columns`
- `npm run test:recovery-preview`
- `npm run test:annotation-diff`
- `npm run test:annotation-diff-timeline`
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

## Sync / Revision Model
Even though this is still local-first, the hook already tracks document-sync concepts:
- `ProjectSyncStatus`
  - `saved`, `dirty`, `saving`, `offline`, `conflict`, `error`
- local revision
- saved revision
- pending operation count
- operation log

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
- local object storage: `apps/api/src/storage.ts`
- shared API types: `packages/shared/src/`
- resource-capability helpers: `packages/document-model/src/`

Current backend capabilities:
- login/session tokens with scrypt password hashing and sha256 token hashes
- users/roles/sessions in PostgreSQL
- media/file upload through multipart
- file metadata in PostgreSQL and binary data in local object storage
- protected file reading, including HTTP Range / `206 Partial Content` for stable MP4 seeking
- hierarchical `ResourceEntry` tree with `folder`, `project`, `annotation_file`, and `media_file` resource types
- atomic batch move with parent/descendant selection collapsing; the legacy single-item endpoint delegates to the same core
- mutable annotation files with integer revision and `baseRevision` conflict checking
- hidden recovery snapshots created automatically before an annotation-file payload is replaced
- recovery-snapshot restore writes historical payload as a new monotonically increasing revision; current payload
  protection, annotation update, and audit entry commit in one transaction
- lightweight recovery-snapshot summary API plus a file-bound detail API for controlled Inspector previews
- recursive project/folder copy, media/annotation-file copy, file-like move/rename/soft-delete/restore, favorite, and recent-open state
- atomic batch trash with parent/descendant selection collapsing; the legacy single-item endpoint delegates to the same core
- audit-log table and API for key platform events such as login, upload, resource creation/move/copy/delete, permission changes, and annotation-file save
- annotation operation-log table and API for recording client-submitted edit operations before future autosave/collaboration work
- placeholder processing-job API for future pitch, spectrogram, Gongche render, pose, transcode, and export services
- per-resource ACL:
  - capabilities are `read`, `write`, `create_child`, `copy`, `move`, `delete`, `download`, and `manage_permissions`
  - `super_admin` / `admin`, the resource owner, and the owner of an ancestor project/folder receive full effective access
  - direct grants belong to one resource and one account
  - folder/project grants inherit to descendants unless a descendant sets `breakPermissionInheritance`
  - there is no explicit deny rule; a direct grant augments inherited capabilities
  - only users with effective `manage_permissions` may edit grants
  - authorization is enforced by the API; disabled frontend controls are only an affordance
  - permission core lives in `packages/document-model` plus `resourceAccess.ts`; do not create a second UI-only implementation

Current platform UI capabilities:
- login page with development defaults
- desktop-style three-pane resource explorer with folder/project navigation, search, sorting, list/grid/Finder-column modes, multi-selection, keyboard shortcuts, and context menus
- column mode keeps selection within one logical column, searches only the rightmost visible column, and preserves ancestor columns; temporary column read failures must not truncate an otherwise valid path
- multi-selection destination picker plus list/grid/column/breadcrumb drag-to-move powered by headless Pragmatic Drag and Drop
- create projects/folders, import annotation JSON, upload media, copy/paste all four resource types, rename, move through the API, and soft-delete resources
- open mutable or read-only annotation files in the existing editor
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
- recursive copy is synchronous and capped at 2,000 active nodes per root. Larger copies should become future
  processing jobs rather than extending one HTTP/database transaction without a bound.
- media copy creates a new media resource that reuses the immutable `FileObject`; physical object duplication,
  reference-counted permanent deletion, and orphan cleanup are not implemented yet.
- real-time collaborative editing is not implemented yet
- the removed Course/Assignment/Submission runtime is not a pending compatibility target; future classroom
  distribution/review should build on resource copy, ACL, file comparison, and a separate confirmed-annotation layer
- confirmed-annotation workflow and real-time collaboration are not implemented yet
- annotation operations currently only record operation metadata/payload and do not mutate annotation-file payloads; full payloads are still written by the annotation-file save route
- audit logs intentionally store summary `detail` objects, not full annotation payloads or uploaded file contents
- global audit queries are admin-only; non-admin queries require effective resource visibility appropriate to the route
- processing jobs must validate job type and referenced resources; service roles bypass user visibility, not file existence
- API route handlers should perform runtime validation before Prisma writes; invalid revision/action/limit inputs should return `400`, stale annotation-file revisions should return `409`
- browser platform writes use `PATCH` and `DELETE`; keep both methods in the Fastify CORS allow-list when changing server bootstrap
- the API is currently for local/dev use; production deployment hardening, migrations, rate limits, and secure file serving are future work
- platform client currently targets `http://localhost:4317/api` in `src/platform/PlatformWorkspace.tsx`
- frontend read-only state is enforced centrally by `useProjectDocumentState({ readOnly })`; UI disabling is not the security boundary, and permission lookup failures must fail closed
- permission core regression tests run with `npm run test:permissions`
- if backend contracts change, update `packages/shared`, API repository/routes, `src/api/platformClient.ts`, and `docs/kunqu-platform-roadmap.md` together

### Resource and annotation-file invariants
- `ResourceEntry` is the common identity, hierarchy, ownership, archive, and permission boundary for every managed item.
- a project is a specialized container resource, not a separate parallel navigation hierarchy. Project and folder use the same create-child, ACL, copy, move, trash, restore, naming, and cycle-protection paths; do not fork these operations by container type.
- project currently differs from folder through its resource type, icon/navigation semantics, and optional `ProjectMetadata`; it is not a separate storage volume, revision boundary, or permission engine.
- `all_projects` is the resource explorer's root-directory view and returns only top-level projects (`parentId = null`). It is not a recursive project search. Nested projects appear under their actual parent; recent, favorites, shared, archived, and trash remain virtual/aggregate views with their own semantics.
- an annotation file is the mutable user-facing unit. Copying it creates an independent annotation file at revision 1 owned by the copier.
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
- ordinary annotation-file comparison is also read-only: it must not save either file, create recovery snapshots, append
  editor history, or mutate resource selection. Compare by stable saved entity ids rather than array positions; derived
  Gongche/branch lanes are not saved entities, random fallback symbol ids are not semantic fields, and duplicate stable
  ids must produce a visible warning instead of being silently accepted.
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
