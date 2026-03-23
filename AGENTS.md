# Repository Guidelines

## Product Intent
This repository is a front-end MVP for `戏曲数据库多轨时间标注`: a research-oriented annotation tool for aligning video, sentence-level SRT subtitles, character-level timing, singing style labels, and independent action tracks. Keep SRT as the core exchange format. New work should preserve the current model: sentence SRT in, editable timeline state in TypeScript, per-track SRT out.

## Project Structure & Module Organization
`src/App.tsx` coordinates playback, selection, history, import, and export. UI is split under `src/components/`: `VideoPlayer`, `Timeline`, `SubtitleList`, `InspectorPanel`, and `Toolbar`. Shared types are in `src/types.ts`. SRT parsing/formatting/export live in `src/utils/srt.ts`; project shaping, character splitting, track metadata, and timing helpers live in `src/utils/project.ts`. `src/mockData.ts` provides a runnable demo dataset.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start the Vite dev server.
- `npm run build`: run TypeScript checks and build production assets.
- `npm run preview`: inspect the production bundle locally.

There is no dedicated test or lint script yet. Before merging, run `npm run build` and manually verify import, playback sync, timeline edits, and export.

## Coding Style & Naming Conventions
Use React function components with TypeScript strict mode. Follow the existing style: 2-space indentation, double quotes, semicolons, and trailing commas. Use `PascalCase` for component files, `camelCase` for helpers, and keep cross-component data shapes centralized in `src/types.ts`. Treat Chinese text as character-based annotation content, not tokenized words.

## Annotation-Specific Rules
Preserve these behaviors when editing:
- `parseSrt`, `parseSrtTime`, `formatSecondsToSrtTime`, and track exporters in `src/utils/srt.ts` are compatibility-critical.
- Character annotations must remain independently editable with `id`, `lineId`, `char`, `startTime`, `endTime`, and `singingStyle`.
- Action tracks stay independent from text timing; current defaults are `hand-action` and `body-action`, defined in `trackDefinitions`.
- Timeline work should continue to support playhead sync, drag/resize, snapping, zoom, focus by subtitle line, and undo/redo.

## Commit & PR Guidelines
Current git history is minimal, so prefer clear imperative commits such as `Add snapping for action blocks`. Keep PRs focused. Include a short summary, note any SRT format changes, and attach screenshots or a recording for timeline or inspector UI changes.
