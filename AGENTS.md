# Repository Guidelines

## Product Intent
This repository is a front-end MVP for `戏曲数据库多轨时间标注`: a research-oriented tool for aligning video, sentence-level SRT, character-level timing, singing style labels, and independent action tracks. Keep SRT as the exchange format: sentence SRT in, editable TypeScript state in the app, per-track SRT out.

## Project Structure & Ownership
`src/App.tsx` is the state hub: playback time, undo/redo, import/export, context menus, selection, and project synchronization all live here. `src/components/Timeline.tsx` is the heaviest interaction surface and contains zoom, ruler scrubbing, snapping, marquee selection, drag/resize, creation flows, and waveform rendering. `src/components/VideoPlayer.tsx` owns playback sync, preview-frame behavior, and native video UX. `src/components/InspectorPanel.tsx` is the canonical form editor for selected items. Shared types live in `src/types.ts`; SRT helpers live in `src/utils/srt.ts`; track metadata and project helpers live in `src/utils/project.ts`; `src/mockData.ts` is the runnable demo dataset.

## Commands
- `npm install`: install dependencies.
- `npm run dev`: run the Vite app locally.
- `npm run build`: type-check and build; this is the required pre-merge verification step.
- `npm run preview`: inspect the production bundle locally.

There is still no dedicated test or lint script. Manual verification matters: import video/SRT, timeline editing, undo/redo, preview behavior, snapping, and export.

## Coding Style
Use React function components with TypeScript strict mode. Match the existing codebase: 2-space indentation, double quotes, semicolons, trailing commas. Keep shared shapes in `src/types.ts`. Treat Chinese subtitle content as character-based annotation data, not tokenized words.

## Current Interaction Model
- Timeline zoom is intentionally narrow and research-oriented: `5-100 px/s`.
- The top ruler is draggable and clickable for playhead scrubbing; this is separate from the video element controls.
- Track labels are sticky on the left side of the timeline viewport. The per-track `吸附` toggle is expected to remain visible while horizontally scrolling.
- Character and action tracks both support `Command/Ctrl + drag` creation. Character tracks also support blank-area double-click creation with line-merge heuristics.
- Dragging character/action edges previews video frames through `previewTime` without changing the real playhead. Creation drag now uses the same preview idea.
- Multi-select is first-class: marquee select, `Command/Ctrl` additive select, blank-click clear, `Command/Ctrl + A`, group move, and batch delete.
- Character block context menus currently include split, line reassignment, and singing-style selection. Action block context menus include track-specific label selection.
- If you touch snapping, preserve the current distinction between shared-boundary drag and individual edge drag. Hover feedback must match actual hit zones.

## State and History Notes
Undo/redo is sensitive. `commitProject()` records real history; `applyProjectWithoutHistory()` is for transient drag updates. Do not collapse multiple completed drags into one history entry. Character timing/text edits must continue to resync sentence lines through `syncSubtitleLine()` / `syncSubtitleLines()`.

## Media and Demo Notes
The demo mock timeline in `src/mockData.ts` has been intentionally stretched to make editing easier at low zoom. Waveform rendering in `Timeline.tsx` is already optimized for visible-window rendering plus bounded per-bucket sampling; preserve that performance posture when increasing waveform detail. `VideoPlayer.tsx` sets initial volume to 50%, and native browser controls auto-hide when the pointer leaves the video surface so subtitles remain visible.

## Commit & PR Guidelines
Prefer short imperative commits such as `Improve timeline block context menus`. Keep branches focused. For UI-heavy changes, include screenshots or recordings, and call out any behavior changes in snapping, undo/redo, preview, import/export, or SRT compatibility.
