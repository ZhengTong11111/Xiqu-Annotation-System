# Repository Guidelines

## Product Intent
This repository is a front-end MVP for `戏曲数据库多轨时间标注`: a research-oriented annotation workstation for aligning video, sentence-level SRT, character-level timing, singing-style labels, action tracks, point annotations, audio cues, and now demonstration-oriented Gongche notation. Keep SRT as the exchange format: sentence SRT in, editable TypeScript state in the app, per-track SRT out.

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
- project document state architecture (`src/state/projectDocumentState.ts`)
- recursive custom-track branching with merged/expanded display modes, per-track/per-branch colors, and filled overlap layout for conflicting blocks

If starting a new conversation, assume the repo is already beyond the earlier simple waveform-only stage.

## Directory & Ownership Map
- `src/App.tsx`
  - main orchestrator
  - wires together project state, playback state, import/export, clipboard, selection, context menu, loop range, spectrogram settings, detached windows, and inspector actions
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
  - spectrogram control surface
- `src/components/GongcheCharacterRenderer.tsx`
  - single-character Gongche preview renderer
- `src/components/ResizableSplitLayout.tsx`
  - reusable splitter for desktop-style panel layout
- `src/components/FloatingPanelWindow.tsx`
  - current lightweight in-app floating window shell for detached panes
- `src/utils/project.ts`
  - track defaults, timeline track definition expansion, project builders, duration helpers, Gongche attached track id helpers
- `src/utils/srt.ts`
  - SRT parse/export helpers
- `src/utils/spectrogram.ts` + `src/utils/spectrogram.worker.ts`
  - worker-driven spectrogram analysis pipeline
- `src/types.ts`
  - all shared project/data/UI selection types
- `src/mockData.ts`
  - runnable demo dataset
- `examples_insights/`
  - real example annotation data and research notes; use it as format/workflow reference, not as app runtime source

## Commands
- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

There is still no dedicated lint/test script. `npm run build` is the mandatory pre-merge check.

## Coding Style
- React function components
- TypeScript strict mode
- 2-space indentation
- double quotes
- semicolons
- trailing commas
- keep shared shapes in `src/types.ts`
- prefer localized helpers over ad hoc inline logic in JSX when behavior is reused

Treat Chinese subtitle content as character-based annotation data, not tokenized words.

## Core Data Model
The current `ProjectData` is broader than the original MVP:
- `video`
- `subtitleLines`
- `characterAnnotations`
- `gongcheAnnotations`
- `actionAnnotations`
- `builtinTracks`
- `customTracks`
- `activeTrackOrder`

Important type families:
- `BuiltinTrack`
  - current built-ins: `character-track`, `hand-action`, `body-action`
- `CustomTrack`
  - `text` or `action`
- `AttachedPointTrack`
  - attached to either built-in or custom parent track
- `GongcheAnnotation`
  - attached to a text-capable parent block (`character-track` or custom text block)
- `WaveformData`
  - raw mixed audio samples + sample rate + keypoints
- `SpectrogramData`
  - worker-computed magnitudes + frequency bins + optional pitch frames

## Track Model
There are now several track layers in play:

### 1. Active timeline tracks
- built-in character/action tracks
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

## Sync / Revision Model
Even though this is still local-first, the hook already tracks document-sync concepts:
- `ProjectSyncStatus`
  - `saved`, `dirty`, `saving`, `offline`, `conflict`, `error`
- local revision
- saved revision
- pending operation count
- operation log

This means future remote sync/collaboration work should extend the existing document-state layer rather than bypass it inside `App.tsx`.

## Timeline Interaction Model
Timeline behavior is now quite rich and tightly coupled. Preserve these assumptions:

### Zoom and ruler
- zoom range: `5-500 px/s`
- top ruler is clickable and draggable for playhead scrubbing
- this is separate from native video controls

### Track headers
- sticky on the left while horizontal scrolling
- per-track `吸附` toggle must remain visible
- compact/low-height rendering exists and has special hiding behavior
- branch track headers expose display state such as `分叉合并` / `分叉展开`
- right-click on custom tracks can enter branch settings; block context menus can set branch ownership

### Creation
- character and action tracks support `Command/Ctrl + drag` creation
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

## Spectrogram Feature
Spectrogram support is now first-class, not experimental.

Current shape:
- `waveformData` is still the source audio base
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
- saved file version: currently `2`
- includes:
  - normalized `project`
  - `uiState`
    - `zoom`
    - `currentTime`
    - `playbackRate`
    - `trackSnapEnabled`
    - `loopPlaybackEnabled`
    - `loopPlaybackRange`

### Import
- supports either wrapped `SavedProjectFile` or older bare `ProjectData`
- normalizes built-ins, customs, attached point tracks, Gongche annotations, and active track order
- imported filename is remembered and reused as default save filename

### Import merge
- there is an overlay/replace merge flow for project import
- imported project content can be mapped into current tracks instead of replacing the full project
- this includes attached point tracks

### Local video caveat
Browser-imported local video cannot be reliably reopened by true disk path in plain web mode.
Current behavior:
- persist relink metadata
- blank/normalize unstable blob URLs
- prompt user to relink manually when needed
- `filePath` field is preserved for future desktop/Electron-style use

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
- selected line editing
- character editing
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
- spectrogram visibility/settings/pitch contour
- detached preview/timeline panes
- undo/redo after drag-heavy operations
- export SRT tracks

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
