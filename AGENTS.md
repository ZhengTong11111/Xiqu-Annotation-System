# Repository Guidelines

## Product Intent
This repository is a front-end MVP for `戏曲数据库多轨时间标注`: a research-oriented tool for aligning video, sentence-level SRT, character-level timing, singing style labels, and independent action tracks. Keep SRT as the exchange format: sentence SRT in, editable TypeScript state in the app, per-track SRT out.

## Project Structure & Ownership
`src/App.tsx` is the state hub: playback time, preview frame state, undo/redo, import/export, context menus, clipboard, project save/load, track ordering, loop range, and project synchronization all live here. `src/components/Timeline.tsx` is still the heaviest interaction surface and now contains zoom, ruler scrubbing, snapping, marquee selection, drag/resize, creation flows, waveform/keypoint rendering, attached-point editing, and loop-range interaction. `src/components/VideoPlayer.tsx` owns playback sync, preview-frame behavior, native video UX, and panel detachment control. `src/components/InspectorPanel.tsx` is the canonical form editor for selected items and tracks. `src/components/ResizableSplitLayout.tsx` is the app’s core pane splitter. `src/components/FloatingPanelWindow.tsx` is the current lightweight in-app floating window shell for detached preview/timeline panes. Shared types live in `src/types.ts`; SRT helpers live in `src/utils/srt.ts`; track metadata and project helpers live in `src/utils/project.ts`; `src/mockData.ts` is the runnable demo dataset. `example/` stores real annotation examples for format and workflow experiments.

## Commands
- `npm install`: install dependencies.
- `npm run dev`: run the Vite app locally.
- `npm run build`: type-check and build; this is the required pre-merge verification step.
- `npm run preview`: inspect the production bundle locally.

There is still no dedicated test or lint script. Manual verification matters: import video/SRT, timeline editing, undo/redo, preview behavior, snapping, and export.

## Coding Style
Use React function components with TypeScript strict mode. Match the existing codebase: 2-space indentation, double quotes, semicolons, trailing commas. Keep shared shapes in `src/types.ts`. Treat Chinese subtitle content as character-based annotation data, not tokenized words.

## Current Layout & Workspace Model
- The app now behaves like a desktop workbench instead of a document page. `AppShell` + nested `ResizableSplitLayout` control the main viewport.
- The left side is a split workspace: preview on top, timeline below. The right side is a stacked sidebar: sentence list, per-line split panel, and inspector/settings.
- Preview and timeline panes can now detach into in-app floating windows. This is intentionally lightweight windowing, not native browser popup windows yet.
- Global page scrolling should remain disabled. Panels scroll internally.

## Current Timeline & Annotation Model
- Timeline zoom is intentionally research-oriented: `5-500 px/s`.
- The top ruler is draggable and clickable for playhead scrubbing; this is separate from the video element controls.
- There are built-in active tracks (`character-track`, `hand-action`, `body-action`) plus reorderable custom text/action tracks. Order is persisted through `activeTrackOrder`.
- Each built-in/custom track may contain attached point tracks (`attachedPointTracks`). These are lightweight point-annotation subtracks used for things like breathing or other non-block events.
- Character and action tracks both support `Command/Ctrl + drag` creation. Character tracks also support blank-area double-click creation with line-merge heuristics.
- Multi-select is first-class: marquee select, `Command/Ctrl` additive select, blank-click clear, `Command/Ctrl + A`, group move, batch delete, and copy/cut/paste. Attached point annotations are part of this model now.
- Character block context menus include split, line reassignment, and singing-style selection. Action block context menus include track-specific label selection.
- There is DAW-style loop-range selection on the timeline. The loop range can be created, resized, moved, toggled on/off without clearing the range, and saved into project UI state.

## State and History Notes
Undo/redo is sensitive. `commitProject()` records real history; `applyProjectWithoutHistory()` is for transient drag updates. Do not collapse multiple completed drags into one history entry. Character timing/text edits must continue to resync sentence lines through `syncSubtitleLine()` / `syncSubtitleLines()`. Clipboard, import/merge flows, and transient drags all depend on `projectRef.current` being authoritative in hot paths.

## Snapping, Preview, and Media Notes
- Dragging character/action edges previews video frames through `previewTime` without changing the real playhead. Creation drag uses the same preview idea.
- Track labels are sticky on the left side of the timeline viewport. The per-track `吸附` toggle is expected to remain visible while horizontally scrolling.
- Snapping behavior is intentionally nuanced: preserve the distinction between shared-boundary drag and individual edge drag. Hover feedback must match actual hit zones.
- Tracks can optionally snap to waveform keypoints; attached point tracks can additionally snap to parent block boundaries. Audio keypoints are visualized on the waveform lane.
- `VideoPlayer.tsx` sets initial volume to 50%, and native browser controls auto-hide when the pointer leaves the video surface so subtitles remain visible.

## Project Import / Save Notes
- Project JSON import/export exists and is no longer just a raw `ProjectData` dump. It includes UI state such as zoom, loop range, and track snap state.
- There is an import-merge workflow: incoming project tracks can be merged into the current project rather than only replacing it.
- Local browser-imported videos cannot be reliably restored across sessions by disk path in plain web mode. The current workflow records relink metadata and prompts the user to manually relink when needed.
- Imported project filenames are remembered in memory and reused as the default save filename.

## Media, Waveform, and Demo Notes
- The demo mock timeline in `src/mockData.ts` has been intentionally stretched to make editing easier at low zoom.
- Waveform rendering in `Timeline.tsx` is optimized for visible-window rendering plus bounded per-bucket sampling. Preserve that performance posture when increasing waveform detail or adding spectrogram work later.
- Attached point tracks, waveform keypoint guides, and loop range overlays all share the same dense timeline area; UI changes here should be tested together.

## Commit & PR Guidelines
Prefer short imperative commits such as `Improve timeline block context menus`. Keep branches focused. For UI-heavy changes, include screenshots or recordings, and call out any behavior changes in snapping, undo/redo, preview, import/export, or SRT compatibility.
