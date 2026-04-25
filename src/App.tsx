import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { FloatingPanelWindow } from "./components/FloatingPanelWindow";
import { InspectorPanel } from "./components/InspectorPanel";
import { LeftWorkspace } from "./components/LeftWorkspace";
import { PreviewPanel } from "./components/PreviewPanel";
import { ResizableSplitLayout } from "./components/ResizableSplitLayout";
import { SpectrogramSettingsPanel } from "./components/SpectrogramSettingsPanel";
import { SubtitleList } from "./components/SubtitleList";
import { Timeline } from "./components/Timeline";
import { TimelinePanel } from "./components/TimelinePanel";
import { TopMenuBar } from "./components/TopMenuBar";
import { VideoPlayer } from "./components/VideoPlayer";
import { mockProject } from "./mockData";
import {
  type HistoryAction,
  type HistoryEntry,
  useProjectDocumentState,
} from "./state/projectDocumentState";
import type {
  ActionAnnotation,
  AttachedPointAnnotation,
  AttachedPointTrack,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  CustomTrackType,
  ProjectData,
  ResolvedCustomTrackBlock,
  SavedProjectFile,
  SelectedItem,
  SpectrogramData,
  SpectrogramSettings,
  SubtitleLine,
  TimelineBatchMoveItem,
  TimelineSelectionItem,
  WaveformData,
} from "./types";
import {
  buildProjectFromLines,
  buildTimelineTrackDefinitions,
  flattenCustomTrackBlocks,
  getBuiltinTrackDefinition,
  getDefaultBuiltinTracks,
  getBuiltinTrackOptions,
  getDefaultAttachedPointTrackName,
  getDefaultAttachedPointTypeOptions,
  getDefaultCustomTrackName,
  getDefaultCustomTrackTypeOptions,
  getDefaultFixedActionLabel,
  getMissingBuiltinTracks,
  getProjectDuration,
  getNextCustomTrackTypeOptionName,
} from "./utils/project";
import {
  exportActionTrackToSrt,
  exportCharacterTrackToSrt,
  exportSingingStyleTrackToSrt,
  parseSrt,
} from "./utils/srt";
import {
  buildSpectrogramData,
  defaultSpectrogramSettings,
} from "./utils/spectrogram";

type CharacterEditLocation = "timeline" | "split-panel";
type CharacterLineAction =
  | "split-block"
  | "set-line-start"
  | "set-line-end"
  | "merge-prev-line"
  | "merge-next-line";

type LineFocusRequest = {
  lineId: string;
  requestId: number;
};

type PointTrackLocation =
  | {
      parentType: "builtin";
      parentTrack: BuiltinTrack;
      pointTrack: AttachedPointTrack;
    }
  | {
      parentType: "custom";
      parentTrack: CustomTrack;
      pointTrack: AttachedPointTrack;
    };

type TimelineClipboardItem =
  | {
      type: "character";
      sourceTrackId: "character-track";
      sourceLineId: string;
      char: string;
      singingStyle: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "action";
      sourceTrackId: string;
      label: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "custom-block";
      sourceTrackId: string;
      trackType: CustomTrackType;
      blockType: string;
      text?: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "attached-point";
      sourceTrackId: string;
      parentTrackId: string;
      label: string;
      timeOffset: number;
    };

type TimelineClipboard = {
  items: TimelineClipboardItem[];
  baseTime: number;
  primaryTrackId: string | null;
  sourceTrackIds: string[];
};

type TimelinePasteTarget = {
  trackId: string;
  time: number;
};

type PasteConflictResolution = "cancel" | "overwrite" | "replace" | "keep-original";

type PreparedPasteItem =
  | {
      type: "character";
      targetTrackId: "character-track";
      startTime: number;
      endTime: number;
      char: string;
      singingStyle: string;
      sourceLineId: string;
    }
  | {
      type: "action";
      targetTrackId: string;
      startTime: number;
      endTime: number;
      label: string;
    }
  | {
      type: "custom-block";
      targetTrackId: string;
      trackType: CustomTrackType;
      startTime: number;
      endTime: number;
      blockType: string;
      text?: string;
    }
  | {
      type: "attached-point";
      targetTrackId: string;
      parentTrackId: string;
      time: number;
      label: string;
    };

type PasteConflict = {
  item: PreparedPasteItem;
  existingKeys: string[];
  trackName: string;
};

type PendingPasteState = {
  preparedItems: PreparedPasteItem[];
  conflicts: PasteConflict[];
};

type ImportMergeMode = "replace" | "overlay";

type ImportMergeRow = {
  key: string;
  kind: "builtin-track" | "custom-track" | "attached-point-track";
  sourceTrackId: string;
  sourceTrackName: string;
  sourceTrackType: "character" | "action" | "custom-text" | "custom-action" | "attached-point";
  sourceParentKey?: string;
  sourceParentTrackId?: string;
  sourceParentTrackName?: string;
  importedCount: number;
  targetChoice: string;
  mergeMode: ImportMergeMode;
};

type PendingImportMergeState = {
  fileName: string;
  sourceProject: ProjectData;
  rows: ImportMergeRow[];
  videoWarning: string | null;
};

type ImportMergeTargetOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type ImportMergePreview = {
  targetLabel: string;
  importedCount: number;
  existingCount: number;
  duplicateCount: number;
  disabledReason: string | null;
};

type TimelineContextMenu =
  | {
      type: "character";
      id: string;
      x: number;
      y: number;
      trackId: "character-track";
      time: number;
    }
  | {
      type: "action";
      id: string;
      x: number;
      y: number;
      trackId: string;
      time: number;
    }
  | {
      type: "custom-block";
      id: string;
      trackId: string;
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "lane";
      trackId: string;
      x: number;
      y: number;
      time: number;
    };

const CHARACTER_CREATE_ATTACH_WINDOW = 1;
const DEFAULT_CHARACTER_DURATION = 1.05;
const MIN_CHARACTER_DURATION = 0.04;
const DEFAULT_ACTION_DURATION = 0.8;
const DEFAULT_CUSTOM_TEXT = "新标注";
const CONTEXT_MENU_GAP = 10;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;
const PROJECT_FILE_VERSION = 2;
const IMPORT_MERGE_SKIP = "__skip__";
const IMPORT_MERGE_NEW = "__new__";
const comparableProjectSignatureCache = new WeakMap<ProjectData, string>();
const trackSnapSignatureCache = new WeakMap<Record<string, boolean>, string>();
const WAVEFORM_KEYPOINT_MIN_SPACING_SECONDS = 0.06;
const WAVEFORM_KEYPOINT_MAX_COUNT = 1600;
const WAVEFORM_KEYPOINT_FRAME_DURATION_SECONDS = 0.012;

function App() {
  const {
    project,
    projectRef,
    trackSnapEnabled,
    trackSnapEnabledRef,
    undoStack,
    redoStack,
    hasUnsavedChanges,
    pendingOperations,
    syncState,
    applyProjectWithoutHistory,
    commitProject,
    applyTrackSnapEnabledState,
    markProjectAsSaved,
    undoProject,
    redoProject,
  } = useProjectDocumentState({
    initialProject: mockProject,
    initialTrackSnapEnabled: getDefaultTrackSnapEnabled(mockProject),
    areProjectsEqual: projectsEqual,
    areTrackSnapStatesEqual: trackSnapStatesEqual,
  });
  const [currentTime, setCurrentTime] = useState(12.4);
  const [duration, setDuration] = useState(getProjectDuration(mockProject));
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({
    type: "line",
    id: "line-1",
  });
  const [selectedTimelineItems, setSelectedTimelineItems] = useState<TimelineSelectionItem[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [isWaveformLoading, setIsWaveformLoading] = useState(false);
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [isSpectrogramLoading, setIsSpectrogramLoading] = useState(false);
  const [spectrogramSettings, setSpectrogramSettings] = useState<SpectrogramSettings>(
    defaultSpectrogramSettings,
  );
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingCharacterLocation, setEditingCharacterLocation] = useState<CharacterEditLocation | null>(null);
  const [editingCharacterValue, setEditingCharacterValue] = useState("");
  const [editingCustomTextBlock, setEditingCustomTextBlock] = useState<{
    trackId: string;
    id: string;
  } | null>(null);
  const [editingCustomTextValue, setEditingCustomTextValue] = useState("");
  const [blockContextMenu, setBlockContextMenu] = useState<TimelineContextMenu | null>(null);
  const [timelineClipboard, setTimelineClipboard] = useState<TimelineClipboard | null>(null);
  const [pendingPasteState, setPendingPasteState] = useState<PendingPasteState | null>(null);
  const [pendingImportMergeState, setPendingImportMergeState] = useState<PendingImportMergeState | null>(null);
  const [zoom, setZoom] = useState(20);
  const [loopPlaybackRange, setLoopPlaybackRange] = useState<{ start: number; end: number } | null>(null);
  const [loopPlaybackEnabled, setLoopPlaybackEnabled] = useState(false);
  const [lineFocusRequest, setLineFocusRequest] = useState<LineFocusRequest | null>(null);
  const [isSubtitlePanelCollapsed, setIsSubtitlePanelCollapsed] = useState(false);
  const [isSplitPanelCollapsed, setIsSplitPanelCollapsed] = useState(false);
  const [manualVideoRelinkPrompt, setManualVideoRelinkPrompt] = useState<ProjectData["video"] | null>(null);
  const [currentProjectFileName, setCurrentProjectFileName] = useState<string | null>(null);
  const [previewDetachedWindow, setPreviewDetachedWindow] = useState<Window | null>(null);
  const [timelineDetachedWindow, setTimelineDetachedWindow] = useState<Window | null>(null);
  const isPreviewDetached = Boolean(previewDetachedWindow && !previewDetachedWindow.closed);
  const isTimelineDetached = Boolean(timelineDetachedWindow && !timelineDetachedWindow.closed);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const srtFileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const mergeProjectFileInputRef = useRef<HTMLInputElement>(null);
  const waveformRequestIdRef = useRef(0);
  const spectrogramRequestIdRef = useRef(0);
  const preferredCharacterEditLocationRef = useRef<CharacterEditLocation>("timeline");
  const blockContextMenuRef = useRef<HTMLDivElement>(null);
  const [blockContextMenuPosition, setBlockContextMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const timelinePasteTargetRef = useRef<TimelinePasteTarget | null>(null);
  const timelineTrackDefinitions = useMemo(
    () => buildTimelineTrackDefinitions(project.builtinTracks, project.customTracks, project.activeTrackOrder),
    [project.activeTrackOrder, project.builtinTracks, project.customTracks],
  );
  const customBlocks = useMemo(
    () => flattenCustomTrackBlocks(project.customTracks),
    [project.customTracks],
  );
  const missingBuiltinTracks = useMemo(
    () => getMissingBuiltinTracks(project.builtinTracks),
    [project.builtinTracks],
  );
  const activeBuiltinTrackIds = useMemo(
    () => new Set(project.builtinTracks.map((track) => track.id)),
    [project.builtinTracks],
  );
  const importMergePreviews = useMemo(() => {
    if (!pendingImportMergeState) {
      return {};
    }
    return Object.fromEntries(
      pendingImportMergeState.rows.map((row) => [
        row.key,
        getImportMergePreview(projectRef.current, pendingImportMergeState.sourceProject, pendingImportMergeState.rows, row),
      ]),
    ) as Record<string, ImportMergePreview>;
  }, [pendingImportMergeState]);

  useEffect(() => {
    const currentTrackSnapState = trackSnapEnabledRef.current;
    const nextTrackSnapState = (() => {
      const next = Object.fromEntries(
        timelineTrackDefinitions.map((track) => [track.id, currentTrackSnapState[track.id] ?? true]),
      );
      const currentKeys = Object.keys(currentTrackSnapState);
      const nextKeys = Object.keys(next);
      const changed = currentKeys.length !== nextKeys.length ||
        nextKeys.some((key) => currentTrackSnapState[key] !== next[key]);
      return changed ? next : currentTrackSnapState;
    })();

    if (nextTrackSnapState !== currentTrackSnapState) {
      applyTrackSnapEnabledState(nextTrackSnapState, { recordOperation: false });
    }
  }, [applyTrackSnapEnabledState, timelineTrackDefinitions, trackSnapEnabledRef]);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  function applySelection(nextSelectedItem: SelectedItem, timelineItems?: TimelineSelectionItem[]) {
    setSelectedItem(nextSelectedItem);
    syncLoopPlaybackRangeFromSelection(nextSelectedItem);
    if (timelineItems !== undefined) {
      setSelectedTimelineItems(timelineItems);
      return;
    }
    if (nextSelectedItem?.type === "character" || nextSelectedItem?.type === "action") {
      setSelectedTimelineItems([{ type: nextSelectedItem.type, id: nextSelectedItem.id }]);
      return;
    }
    if (nextSelectedItem?.type === "custom-block") {
      setSelectedTimelineItems([
        { type: "custom-block", id: nextSelectedItem.id, trackId: nextSelectedItem.trackId },
      ]);
      return;
    }
    if (nextSelectedItem?.type === "attached-point") {
      setSelectedTimelineItems([
        {
          type: "attached-point",
          id: nextSelectedItem.id,
          trackId: nextSelectedItem.trackId,
          parentTrackId: nextSelectedItem.parentTrackId,
        },
      ]);
      return;
    }
    setSelectedTimelineItems([]);
  }

  function syncLoopPlaybackRangeFromSelection(nextSelectedItem: SelectedItem) {
    if (!nextSelectedItem) {
      return;
    }
    const currentProject = projectRef.current;
    if (nextSelectedItem.type === "character") {
      const track = currentProject.builtinTracks.find((item) => item.id === "character-track");
      const character = currentProject.characterAnnotations.find((item) => item.id === nextSelectedItem.id);
      if (track?.autoSetLoopRangeOnSelect && character) {
        setLoopPlaybackRange({ start: character.startTime, end: character.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "action") {
      const action = currentProject.actionAnnotations.find((item) => item.id === nextSelectedItem.id);
      const track = action
        ? currentProject.builtinTracks.find((item) => item.id === action.trackId)
        : null;
      if (track?.autoSetLoopRangeOnSelect && action) {
        setLoopPlaybackRange({ start: action.startTime, end: action.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "custom-block") {
      const track = currentProject.customTracks.find((item) => item.id === nextSelectedItem.trackId);
      const block = track?.blocks.find((item) => item.id === nextSelectedItem.id);
      if (track?.autoSetLoopRangeOnSelect && block) {
        setLoopPlaybackRange({ start: block.startTime, end: block.endTime });
      }
    }
  }

  function updateTimelinePasteTarget(trackId: string, time: number) {
    timelinePasteTargetRef.current = {
      trackId,
      time: Math.max(0, time),
    };
  }

  function closeTimelineContextMenu() {
    setBlockContextMenu(null);
  }

  const selectedLineId = selectedItem?.type === "line"
    ? selectedItem.id
    : selectedItem?.type === "character"
      ? project.characterAnnotations.find((item) => item.id === selectedItem.id)?.lineId ?? null
      : null;

  const focusRange = useMemo(() => {
    if (!lineFocusRequest) {
      return null;
    }
    const line = project.subtitleLines.find((item) => item.id === lineFocusRequest.lineId);
    if (!line) {
      return null;
    }
    return {
      requestId: lineFocusRequest.requestId,
      start: Math.max(0, line.startTime - 1.5),
      end: line.endTime + 1.5,
    };
  }, [lineFocusRequest, project.subtitleLines]);

  useEffect(() => {
    setDuration(
      Math.max(
        videoRef.current?.duration || 0,
        getProjectDuration(project),
      ),
    );
  }, [project]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (
      !isPlaying ||
      previewTime !== null ||
      !loopPlaybackEnabled ||
      !loopPlaybackRange ||
      !videoRef.current
    ) {
      return;
    }
    if (loopPlaybackRange.end - loopPlaybackRange.start <= 0.001) {
      return;
    }
    const loopEndThreshold = Math.max(0.01, 0.04 / Math.max(playbackRate, 0.25));
    if (currentTime < loopPlaybackRange.end - loopEndThreshold) {
      return;
    }
    const nextTime = clampTime(loopPlaybackRange.start, duration);
    videoRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, [currentTime, duration, isPlaying, loopPlaybackEnabled, loopPlaybackRange, playbackRate, previewTime]);

  useEffect(() => {
    const videoUrl = project.video.url;
    const requestId = waveformRequestIdRef.current + 1;
    waveformRequestIdRef.current = requestId;

    if (!videoUrl) {
      setWaveformData(null);
      setSpectrogramData(null);
      setIsWaveformLoading(false);
      setIsSpectrogramLoading(false);
      return;
    }

    let cancelled = false;
    setIsWaveformLoading(true);
    setSpectrogramData(null);

    void buildWaveformData(videoUrl)
      .then((nextWaveformData) => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setWaveformData(nextWaveformData);
      })
      .catch(() => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setWaveformData(null);
      })
      .finally(() => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setIsWaveformLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.video.url]);

  useEffect(() => {
    const requestId = spectrogramRequestIdRef.current + 1;
    spectrogramRequestIdRef.current = requestId;

    if (!spectrogramSettings.visible || !waveformData) {
      setSpectrogramData(null);
      setIsSpectrogramLoading(false);
      return;
    }

    if (
      spectrogramData &&
      spectrogramData.analysisPreset === spectrogramSettings.analysisPreset &&
      (!spectrogramSettings.showPitchContour || spectrogramData.pitchFrames)
    ) {
      return;
    }

    const abortController = new AbortController();
    setIsSpectrogramLoading(true);

    void buildSpectrogramData(
      waveformData,
      spectrogramSettings.showPitchContour,
      spectrogramSettings.analysisPreset,
      abortController.signal,
    )
      .then((nextSpectrogramData) => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setSpectrogramData(nextSpectrogramData);
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setSpectrogramData(null);
      })
      .finally(() => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setIsSpectrogramLoading(false);
      });

    return () => {
      abortController.abort();
    };
  }, [
    spectrogramData,
    spectrogramSettings.analysisPreset,
    spectrogramSettings.showPitchContour,
    spectrogramSettings.visible,
    waveformData,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProjectFile();
        return;
      }
      if ((event.target as HTMLElement | null)?.tagName === "INPUT" ||
          (event.target as HTMLElement | null)?.tagName === "SELECT") {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(currentTime - (event.shiftKey ? 1 : 0.04));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(currentTime + (event.shiftKey ? 1 : 0.04));
      }
      if (event.key === "Enter") {
        if (selectedItem?.type === "character" && !editingCharacterId) {
          event.preventDefault();
          startCharacterTextEdit(selectedItem.id, preferredCharacterEditLocationRef.current);
        }
        if (
          selectedItem?.type === "custom-block" &&
          !editingCustomTextBlock &&
          findCustomBlock(projectRef.current.customTracks, selectedItem.trackId, selectedItem.id)?.trackType === "text"
        ) {
          event.preventDefault();
          startCustomTextEdit(selectedItem.trackId, selectedItem.id);
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllTimelineItems();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copyTimelineSelection();
        closeTimelineContextMenu();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
        event.preventDefault();
        cutTimelineSelection();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteTimelineClipboard();
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (
          selectedTimelineItems.length > 0 ||
          selectedItem?.type === "character" ||
          selectedItem?.type === "action" ||
          selectedItem?.type === "custom-block"
        ) {
          event.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    currentTime,
    editingCharacterId,
    editingCustomTextBlock,
    previewTime,
    selectedItem,
    selectedTimelineItems,
    timelineClipboard,
    undoStack,
    redoStack,
    project,
    trackSnapEnabled,
  ]);

  useEffect(() => {
    const preventPageZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener("wheel", preventPageZoom, { passive: false, capture: true });
    document.addEventListener("gesturestart", preventGestureZoom, { passive: false });
    document.addEventListener("gesturechange", preventGestureZoom, { passive: false });
    document.addEventListener("gestureend", preventGestureZoom, { passive: false });

    return () => {
      window.removeEventListener("wheel", preventPageZoom, { capture: true });
      document.removeEventListener("gesturestart", preventGestureZoom);
      document.removeEventListener("gesturechange", preventGestureZoom);
      document.removeEventListener("gestureend", preventGestureZoom);
    };
  }, []);

  const activeCharacters = useMemo(() => {
    if (!selectedLineId) {
      return [];
    }
    return sortCharactersByTime(project.characterAnnotations.filter((item) => item.lineId === selectedLineId));
  }, [project.characterAnnotations, selectedLineId]);

  function toggleSubtitlePanelCollapsed() {
    setIsSubtitlePanelCollapsed((current) => !current);
  }

  function toggleSplitPanelCollapsed() {
    setIsSplitPanelCollapsed((current) => !current);
  }

  const contextMenuCharacter = blockContextMenu?.type === "character"
    ? project.characterAnnotations.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuAction = blockContextMenu?.type === "action"
    ? project.actionAnnotations.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuCustomBlock = blockContextMenu?.type === "custom-block"
    ? customBlocks.find((item) =>
        item.id === blockContextMenu.id && item.trackId === blockContextMenu.trackId,
      ) ?? null
    : null;
  const contextMenuSplitCharacters = contextMenuCharacter
    ? getSplittableCharacters(contextMenuCharacter.char)
    : [];
  const contextMenuCharacterTrack = timelineTrackDefinitions.find((track) => track.id === "character-track") ?? null;
  const contextMenuActionTrack = contextMenuAction
    ? timelineTrackDefinitions.find((track) => track.id === contextMenuAction.trackId) ?? null
    : null;
  const contextMenuCustomTrack = contextMenuCustomBlock
    ? project.customTracks.find((track) => track.id === contextMenuCustomBlock.trackId) ?? null
    : null;
  const canPasteTimelineClipboard = Boolean(timelineClipboard?.items.length);

  useLayoutEffect(() => {
    if (!blockContextMenu || !blockContextMenuRef.current) {
      setBlockContextMenuPosition(null);
      return;
    }

    const menu = blockContextMenuRef.current;
    const { innerWidth, innerHeight } = window;
    const menuRect = menu.getBoundingClientRect();
    let left = blockContextMenu.x + CONTEXT_MENU_GAP;
    let top = blockContextMenu.y + CONTEXT_MENU_GAP;

    if (left + menuRect.width > innerWidth - CONTEXT_MENU_VIEWPORT_MARGIN) {
      left = blockContextMenu.x - menuRect.width - CONTEXT_MENU_GAP;
    }
    if (top + menuRect.height > innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN) {
      top = blockContextMenu.y - menuRect.height - CONTEXT_MENU_GAP;
    }

    left = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      Math.min(left, innerWidth - menuRect.width - CONTEXT_MENU_VIEWPORT_MARGIN),
    );
    top = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      Math.min(top, innerHeight - menuRect.height - CONTEXT_MENU_VIEWPORT_MARGIN),
    );

    setBlockContextMenuPosition((current) =>
      current?.left === left && current?.top === top ? current : { left, top },
    );
  }, [blockContextMenu, contextMenuSplitCharacters.length, contextMenuActionTrack, project.characterAnnotations, project.actionAnnotations]);

  useEffect(() => {
    if (!editingCharacterId) {
      return;
    }
    const editingCharacter = project.characterAnnotations.find((item) => item.id === editingCharacterId);
    if (!editingCharacter || (selectedLineId && editingCharacter.lineId !== selectedLineId)) {
      setEditingCharacterId(null);
      setEditingCharacterLocation(null);
      setEditingCharacterValue("");
    }
  }, [editingCharacterId, project.characterAnnotations, selectedLineId]);

  useEffect(() => {
    if (!editingCustomTextBlock) {
      return;
    }
    const editingBlock = findCustomBlock(project.customTracks, editingCustomTextBlock.trackId, editingCustomTextBlock.id);
    if (
      !editingBlock ||
      editingBlock.trackType !== "text" ||
      selectedItem?.type !== "custom-block" ||
      selectedItem.id !== editingCustomTextBlock.id ||
      selectedItem.trackId !== editingCustomTextBlock.trackId
    ) {
      cancelCustomTextEdit();
    }
  }, [editingCustomTextBlock, project.customTracks, selectedItem]);

  useEffect(() => {
    if (!blockContextMenu) {
      return;
    }

    const handleClose = () => {
      setBlockContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBlockContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handleClose);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleClose);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [blockContextMenu]);

  function projectsEqual(left: ProjectData, right: ProjectData) {
    return serializeComparableProject(left) === serializeComparableProject(right);
  }

  function seekTo(time: number) {
    const safeTime = Math.max(0, Math.min(time, duration));
    setPreviewTime(null);
    setCurrentTime(safeTime);
    if (videoRef.current) {
      videoRef.current.currentTime = safeTime;
    }
  }

  function togglePlay() {
    if (!videoRef.current) {
      return;
    }
    const video = videoRef.current;
    const needsLoopStartSeek =
      video.paused &&
      loopPlaybackEnabled &&
      loopPlaybackRange &&
      (currentTime < loopPlaybackRange.start || currentTime > loopPlaybackRange.end);
    if (previewTime !== null) {
      video.currentTime = currentTime;
      setPreviewTime(null);
    }
    if (needsLoopStartSeek && loopPlaybackRange) {
      const nextTime = clampTime(loopPlaybackRange.start, duration);
      setCurrentTime(nextTime);
      if (Math.abs(video.currentTime - nextTime) > 0.001) {
        const handleSeeked = () => {
          video.removeEventListener("seeked", handleSeeked);
          void video.play();
        };
        video.addEventListener("seeked", handleSeeked);
        video.currentTime = nextTime;
        return;
      }
    }
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function updateCharacter(id: string, changes: Partial<CharacterAnnotation>, recordHistory = true) {
    const currentProject = projectRef.current;
    const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === id);
    const nextProject = {
      ...currentProject,
      characterAnnotations: currentProject.characterAnnotations.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    };
    const synchronizedProject =
      currentCharacter && (
        changes.char !== undefined ||
        changes.startTime !== undefined ||
        changes.endTime !== undefined
      )
        ? syncSubtitleLine(nextProject, currentCharacter.lineId)
        : nextProject;
    if (recordHistory) {
      commitProject(synchronizedProject);
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function updateLinePosition(
    id: string,
    changes: Pick<SubtitleLine, "startTime" | "endTime">,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const currentLine = currentProject.subtitleLines.find((line) => line.id === id);
    if (!currentLine) {
      return;
    }
    const deltaSeconds = changes.startTime - currentLine.startTime;
    const hasCharacters = currentProject.characterAnnotations.some((item) => item.lineId === id);

    const shiftedProject = {
      ...currentProject,
      subtitleLines: currentProject.subtitleLines.map((line) =>
        line.id === id
          ? { ...line, startTime: changes.startTime, endTime: changes.endTime }
          : line,
      ),
      characterAnnotations: hasCharacters
        ? currentProject.characterAnnotations.map((item) =>
            item.lineId === id
              ? {
                  ...item,
                  startTime: item.startTime + deltaSeconds,
                  endTime: item.endTime + deltaSeconds,
                }
              : item,
          )
        : currentProject.characterAnnotations,
    };

    const synchronizedProject = hasCharacters
      ? syncSubtitleLine(shiftedProject, id)
      : shiftedProject;

    if (recordHistory) {
      commitProject(synchronizedProject);
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function startCharacterTextEdit(id: string, location: CharacterEditLocation) {
    const currentCharacter = projectRef.current.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      return;
    }
    preferredCharacterEditLocationRef.current = location;
    applySelection({ type: "character", id });
    setEditingCharacterId(id);
    setEditingCharacterLocation(location);
    setEditingCharacterValue(currentCharacter.char);
  }

  function cancelCharacterTextEdit() {
    setEditingCharacterId(null);
    setEditingCharacterLocation(null);
    setEditingCharacterValue("");
  }

  function commitCharacterTextEdit(id: string) {
    const currentCharacter = projectRef.current.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      cancelCharacterTextEdit();
      return;
    }
    const normalizedChar = editingCharacterValue.trim();
    if (!normalizedChar) {
      window.alert("字内容不能为空。");
      return;
    }
    if (normalizedChar === currentCharacter.char) {
      cancelCharacterTextEdit();
      return;
    }
    if (!isSingleHanCharacter(normalizedChar)) {
      const confirmed = window.confirm(
        `当前输入为“${normalizedChar}”。通常这里建议使用单个汉字。是否仍然继续修改？`,
      );
      if (!confirmed) {
        return;
      }
    }
    updateCharacter(id, { char: normalizedChar });
    cancelCharacterTextEdit();
  }

  function updateCustomTrack(
    trackId: string,
    updater: (track: CustomTrack) => CustomTrack,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const nextProject = {
      ...currentProject,
      customTracks: currentProject.customTracks.map((track) =>
        track.id === trackId ? updater(track) : track,
      ) as CustomTrack[],
    };
    if (recordHistory) {
      commitProject(nextProject);
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function updateBuiltinTrack(
    trackId: BuiltinTrackId,
    updater: (track: BuiltinTrack) => BuiltinTrack,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const nextProject = {
      ...currentProject,
      builtinTracks: currentProject.builtinTracks.map((track) =>
        track.id === trackId ? updater(track) : track,
      ),
    };
    if (recordHistory) {
      commitProject(nextProject);
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function findPointTrackLocation(projectToSearch: ProjectData, pointTrackId: string): PointTrackLocation | null {
    for (const track of projectToSearch.builtinTracks) {
      const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
      if (pointTrack) {
        return {
          parentType: "builtin",
          parentTrack: track,
          pointTrack,
        };
      }
    }
    for (const track of projectToSearch.customTracks) {
      const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
      if (pointTrack) {
        return {
          parentType: "custom",
          parentTrack: track,
          pointTrack,
        };
      }
    }
    return null;
  }

  function updateAttachedPointTrack(
    pointTrackId: string,
    updater: (pointTrack: AttachedPointTrack) => AttachedPointTrack,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const updateTrackList = (attachedPointTracks: AttachedPointTrack[]) =>
      attachedPointTracks.map((pointTrack) =>
        pointTrack.id === pointTrackId ? updater(pointTrack) : pointTrack,
      );
    if (location.parentType === "builtin") {
      updateBuiltinTrack(
        location.parentTrack.id,
        (track) => ({
          ...track,
          attachedPointTracks: updateTrackList(track.attachedPointTracks ?? []),
        }),
        recordHistory,
      );
      return;
    }
    updateCustomTrack(
      location.parentTrack.id,
      (track) => ({
        ...track,
        attachedPointTracks: updateTrackList(track.attachedPointTracks ?? []),
      }) as CustomTrack,
      recordHistory,
    );
  }

  function updateAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
    recordHistory = true,
  ) {
    updateAttachedPointTrack(
      pointTrackId,
      (pointTrack) => ({
        ...pointTrack,
        points: pointTrack.points.map((point) =>
          point.id === pointId ? { ...point, ...changes } : point,
        ),
      }),
      recordHistory,
    );
  }

  function changeAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
  ) {
    updateAttachedPoint(pointTrackId, pointId, changes, false);
  }

  function commitAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
  ) {
    updateAttachedPoint(pointTrackId, pointId, changes, true);
  }

  function addAttachedPointTrack(parentTrackId: string) {
    const currentProject = projectRef.current;
    const builtinParent = currentProject.builtinTracks.find((track) => track.id === parentTrackId);
    const customParent = currentProject.customTracks.find((track) => track.id === parentTrackId);
    if (!builtinParent && !customParent) {
      return;
    }
    const parentTrack = builtinParent ?? customParent;
    const nextPointTrack: AttachedPointTrack = {
      id: `point-track-${crypto.randomUUID()}`,
      name: getDefaultAttachedPointTrackName(parentTrack?.attachedPointTracks ?? []),
      typeOptions: getDefaultAttachedPointTypeOptions(),
      points: [],
      snapToWaveformKeypoints: false,
      snapToParentBoundaries: true,
    };
    if (builtinParent) {
      updateBuiltinTrack(parentTrackId as BuiltinTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: true,
        attachedPointTracks: [...(track.attachedPointTracks ?? []), nextPointTrack],
      }));
    } else if (customParent) {
      updateCustomTrack(parentTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: true,
        attachedPointTracks: [...(track.attachedPointTracks ?? []), nextPointTrack],
      }) as CustomTrack);
    }
    applySelection({ type: "attached-point-track", id: nextPointTrack.id, parentTrackId });
  }

  function toggleAttachedPointTracks(parentTrackId: string) {
    const currentProject = projectRef.current;
    if (currentProject.builtinTracks.some((track) => track.id === parentTrackId)) {
      updateBuiltinTrack(parentTrackId as BuiltinTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: !track.attachedPointTracksExpanded,
      }));
      return;
    }
    if (currentProject.customTracks.some((track) => track.id === parentTrackId)) {
      updateCustomTrack(parentTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: !track.attachedPointTracksExpanded,
      }) as CustomTrack);
    }
  }

  function moveTrack(trackId: string, direction: "up" | "down") {
    const currentProject = projectRef.current;
    const currentIndex = currentProject.activeTrackOrder.findIndex((id) => id === trackId);
    if (currentIndex === -1) {
      return;
    }
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= currentProject.activeTrackOrder.length) {
      return;
    }
    const nextOrder = [...currentProject.activeTrackOrder];
    const [movedId] = nextOrder.splice(currentIndex, 1);
    nextOrder.splice(targetIndex, 0, movedId);
    commitProject({
      ...currentProject,
      activeTrackOrder: nextOrder,
    });
  }

  function reorderTrack(trackId: string, insertionIndex: number) {
    const currentProject = projectRef.current;
    const currentIndex = currentProject.activeTrackOrder.findIndex((id) => id === trackId);
    if (currentIndex === -1) {
      return;
    }
    const nextOrder = [...currentProject.activeTrackOrder];
    const [movedId] = nextOrder.splice(currentIndex, 1);
    const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, nextOrder.length));
    if (normalizedInsertionIndex === currentIndex) {
      return;
    }
    nextOrder.splice(normalizedInsertionIndex, 0, movedId);
    commitProject({
      ...currentProject,
      activeTrackOrder: nextOrder,
    });
  }

  function updateCustomBlock(
    trackId: string,
    blockId: string,
    changes: {
      startTime?: number;
      endTime?: number;
      text?: string;
      type?: string;
    },
    recordHistory = true,
  ) {
    updateCustomTrack(
      trackId,
      (track) => ({
        ...track,
        blocks: track.blocks.map((block) =>
          block.id === blockId ? { ...block, ...changes } : block,
        ) as CustomTrack["blocks"],
      }) as CustomTrack,
      recordHistory,
    );
  }

  function startCustomTextEdit(trackId: string, blockId: string) {
    const currentBlock = findCustomBlock(projectRef.current.customTracks, trackId, blockId);
    if (!currentBlock || currentBlock.trackType !== "text") {
      return;
    }
    applySelection({ type: "custom-block", trackId, id: blockId });
    setEditingCustomTextBlock({ trackId, id: blockId });
    setEditingCustomTextValue(currentBlock.text ?? "");
  }

  function cancelCustomTextEdit() {
    setEditingCustomTextBlock(null);
    setEditingCustomTextValue("");
  }

  function commitCustomTextEdit(trackId: string, blockId: string) {
    const currentBlock = findCustomBlock(projectRef.current.customTracks, trackId, blockId);
    if (!currentBlock || currentBlock.trackType !== "text") {
      cancelCustomTextEdit();
      return;
    }
    const normalizedText = editingCustomTextValue.trim();
    if (!normalizedText) {
      window.alert("文字 block 的内容不能为空。");
      return;
    }
    if (normalizedText === currentBlock.text) {
      cancelCustomTextEdit();
      return;
    }
    updateCustomBlock(trackId, blockId, { text: normalizedText });
    cancelCustomTextEdit();
  }

  function updateAction(id: string, changes: Partial<ActionAnnotation>, recordHistory = true) {
    const currentProject = projectRef.current;
    const nextProject = {
      ...currentProject,
      actionAnnotations: currentProject.actionAnnotations.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    };
    if (recordHistory) {
      commitProject(nextProject);
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function applyCharacterSingingStyle(id: string, singingStyle: CharacterAnnotation["singingStyle"]) {
    updateCharacter(id, { singingStyle });
  }

  function applyActionLabel(id: string, label: string) {
    updateAction(id, { label });
  }

  function applyCustomBlockType(trackId: string, blockId: string, type: string) {
    updateCustomBlock(trackId, blockId, { type });
  }

  function getCopyableTimelineSelection(currentProject: ProjectData) {
    const explicitSelection: TimelineSelectionItem[] = selectedTimelineItems.length > 0
      ? selectedTimelineItems
      : selectedItem?.type === "character" || selectedItem?.type === "action"
        ? [{ type: selectedItem.type, id: selectedItem.id }]
        : selectedItem?.type === "attached-point"
          ? [{
              type: "attached-point",
              id: selectedItem.id,
              trackId: selectedItem.trackId,
              parentTrackId: selectedItem.parentTrackId,
            }]
        : selectedItem?.type === "custom-block"
          ? [{ type: "custom-block", id: selectedItem.id, trackId: selectedItem.trackId }]
          : [];

    return explicitSelection
      .map((item) => resolveTimelineSelectionItem(currentProject, item))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) =>
        left.startTime - right.startTime ||
        left.endTime - right.endTime ||
        left.trackId.localeCompare(right.trackId) ||
        left.id.localeCompare(right.id),
      );
  }

  function copyTimelineSelection() {
    const selection = getCopyableTimelineSelection(projectRef.current);
    if (selection.length === 0) {
      return false;
    }

    const baseTime = Math.min(...selection.map((item) => item.startTime));
    const clipboardItems: TimelineClipboardItem[] = selection.map((item) => {
      if (item.type === "character") {
        return {
          type: "character",
          sourceTrackId: "character-track",
          sourceLineId: item.lineId,
          char: item.char,
          singingStyle: item.singingStyle,
          startOffset: item.startTime - baseTime,
          endOffset: item.endTime - baseTime,
        };
      }
      if (item.type === "action") {
        return {
          type: "action",
          sourceTrackId: item.trackId,
          label: item.label,
          startOffset: item.startTime - baseTime,
          endOffset: item.endTime - baseTime,
        };
      }
      if (item.type === "attached-point") {
        return {
          type: "attached-point",
          sourceTrackId: item.trackId,
          parentTrackId: item.parentTrackId,
          label: item.label,
          timeOffset: item.startTime - baseTime,
        };
      }
      return {
        type: "custom-block",
        sourceTrackId: item.trackId,
        trackType: item.trackType,
        blockType: item.typeValue,
        text: item.text,
        startOffset: item.startTime - baseTime,
        endOffset: item.endTime - baseTime,
      };
    });

    setTimelineClipboard({
      items: clipboardItems,
      baseTime,
      primaryTrackId: selection[0]?.trackId ?? null,
      sourceTrackIds: Array.from(new Set(selection.map((item) => item.trackId))),
    });
    return true;
  }

  function cutTimelineSelection() {
    if (!copyTimelineSelection()) {
      return;
    }
    deleteSelected();
    closeTimelineContextMenu();
  }

  function pasteTimelineClipboard() {
    const clipboard = timelineClipboard;
    if (!clipboard || clipboard.items.length === 0) {
      return;
    }

    const currentProject = projectRef.current;
    const pasteTarget = resolveTimelinePasteTarget(
      currentProject,
      clipboard,
      timelinePasteTargetRef.current,
      currentTime,
    );
    if (!pasteTarget) {
      window.alert("当前没有可用的粘贴目标。请先在时间轴上点击或右键目标轨道位置。");
      return;
    }

    const preparedItems = buildPreparedPasteItems(currentProject, clipboard, pasteTarget);
    if (preparedItems.length === 0) {
      window.alert("当前剪贴板内容无法粘贴到该轨道。请检查目标轨道类型是否兼容。");
      return;
    }

    const conflicts = detectPasteConflicts(currentProject, preparedItems);
    if (conflicts.length > 0) {
      setPendingPasteState({ preparedItems, conflicts });
      closeTimelineContextMenu();
      return;
    }

    applyPreparedPaste(preparedItems, "overwrite");
    closeTimelineContextMenu();
  }

  function applyPendingPasteResolution(resolution: PasteConflictResolution) {
    const pendingPaste = pendingPasteState;
    setPendingPasteState(null);
    if (!pendingPaste || resolution === "cancel") {
      return;
    }
    applyPreparedPaste(pendingPaste.preparedItems, resolution);
  }

  function applyPreparedPaste(
    preparedItems: PreparedPasteItem[],
    resolution: Exclude<PasteConflictResolution, "cancel">,
  ) {
    const currentProject = projectRef.current;
    const conflicts = detectPasteConflicts(currentProject, preparedItems);
    const conflictingKeys = new Set(conflicts.flatMap((conflict) => conflict.existingKeys));
    const safeItems = resolution === "keep-original"
      ? preparedItems.filter((item) => !findConflictingKeysForPreparedItem(currentProject, item).length)
      : preparedItems;

    if (safeItems.length === 0) {
      return;
    }

    const sourceLineIds = Array.from(
      new Set(
        safeItems.flatMap((item) => (item.type === "character" ? [item.sourceLineId] : [])),
      ),
    );
    const newLineIdMap = new Map(
      sourceLineIds.map((sourceLineId) => [sourceLineId, `line-${crypto.randomUUID()}`]),
    );

    const insertedCharacters = safeItems.flatMap((item) =>
      item.type === "character"
        ? [{
            id: `char-${crypto.randomUUID()}`,
            lineId: newLineIdMap.get(item.sourceLineId) ?? `line-${crypto.randomUUID()}`,
            char: item.char,
            startTime: item.startTime,
            endTime: item.endTime,
            singingStyle: item.singingStyle,
          }]
        : [],
    );
    const insertedActions = safeItems.flatMap((item) =>
      item.type === "action"
        ? [{
            id: `${item.targetTrackId}-${crypto.randomUUID()}`,
            trackId: item.targetTrackId,
            label: item.label,
            startTime: item.startTime,
            endTime: item.endTime,
          }]
        : [],
    );
    const insertedPointsByTrack = new Map<string, AttachedPointAnnotation[]>();
    for (const item of safeItems) {
      if (item.type !== "attached-point") {
        continue;
      }
      const points = insertedPointsByTrack.get(item.targetTrackId) ?? [];
      points.push({
        id: `point-${crypto.randomUUID()}`,
        time: item.time,
        label: item.label,
      });
      insertedPointsByTrack.set(item.targetTrackId, points);
    }
    const insertedCustomBlocksByTrack = new Map<string, Array<CustomTrack["blocks"][number]>>();
    for (const item of safeItems) {
      if (item.type !== "custom-block") {
        continue;
      }
      const blocks: Array<CustomTrack["blocks"][number]> = insertedCustomBlocksByTrack.get(item.targetTrackId) ?? [];
      blocks.push(
        item.trackType === "text"
          ? {
              id: `custom-block-${crypto.randomUUID()}`,
              startTime: item.startTime,
              endTime: item.endTime,
              text: item.text ?? DEFAULT_CUSTOM_TEXT,
              type: item.blockType,
            }
          : {
              id: `custom-block-${crypto.randomUUID()}`,
              startTime: item.startTime,
              endTime: item.endTime,
              type: item.blockType,
            },
      );
      insertedCustomBlocksByTrack.set(item.targetTrackId, blocks);
    }

    const nextCharacterAnnotations = currentProject.characterAnnotations
      .filter((item) => !(resolution === "replace" && conflictingKeys.has(`character:${item.id}`)))
      .concat(insertedCharacters);

    const nextActionAnnotations = currentProject.actionAnnotations
      .filter((item) => !(resolution === "replace" && conflictingKeys.has(`action:${item.id}`)))
      .concat(insertedActions);

    const nextCustomTracks = currentProject.customTracks.map((track) => ({
      ...track,
      attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) =>
        ({
          ...pointTrack,
          points: [
            ...pointTrack.points.filter((point) => !(resolution === "replace" && conflictingKeys.has(`attached-point:${pointTrack.id}:${point.id}`))),
            ...(insertedPointsByTrack.get(pointTrack.id) ?? []),
          ].sort((left, right) => left.time - right.time),
        })
      ),
      blocks: [
        ...(resolution === "replace"
          ? track.blocks.filter((block) => !conflictingKeys.has(`custom-block:${track.id}:${block.id}`))
          : track.blocks),
        ...(insertedCustomBlocksByTrack.get(track.id) ?? []),
      ] as CustomTrack["blocks"],
    })) as CustomTrack[];
    const nextBuiltinTracks = currentProject.builtinTracks.map((track) => ({
      ...track,
      attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
        ...pointTrack,
        points: [
          ...pointTrack.points.filter((point) => !(resolution === "replace" && conflictingKeys.has(`attached-point:${pointTrack.id}:${point.id}`))),
          ...(insertedPointsByTrack.get(pointTrack.id) ?? []),
        ].sort((left, right) => left.time - right.time),
      })),
    }));

    const affectedLineIds = new Set<string>([
      ...currentProject.characterAnnotations
        .filter((item) => resolution === "replace" && conflictingKeys.has(`character:${item.id}`))
        .map((item) => item.lineId),
      ...Array.from(newLineIdMap.values()),
    ]);

    const nextProject = syncSubtitleLines(
      {
        ...currentProject,
        characterAnnotations: nextCharacterAnnotations,
        actionAnnotations: nextActionAnnotations,
        builtinTracks: nextBuiltinTracks,
        customTracks: nextCustomTracks,
      },
      Array.from(affectedLineIds),
    );

    const nextSelectedItems: TimelineSelectionItem[] = [
      ...insertedCharacters.map((annotation) => ({ type: "character" as const, id: annotation.id })),
      ...insertedActions.map((annotation) => ({ type: "action" as const, id: annotation.id })),
      ...Array.from(insertedPointsByTrack.entries()).flatMap(([trackId, points]) =>
        points.map((point) => ({
          type: "attached-point" as const,
          id: point.id,
          trackId,
          parentTrackId: findPointTrackLocation(nextProject, trackId)?.parentTrack.id ?? "",
        })),
      ),
      ...Array.from(insertedCustomBlocksByTrack.entries()).flatMap(([trackId, blocks]) =>
        blocks.map((block) => ({ type: "custom-block" as const, id: block.id, trackId })),
      ),
    ];

    commitProject(nextProject);
    if (nextSelectedItems.length > 0) {
      const primaryItem = nextSelectedItems[0];
      applySelection(
        primaryItem.type === "custom-block"
          ? { type: "custom-block", id: primaryItem.id, trackId: primaryItem.trackId }
          : primaryItem.type === "attached-point"
            ? {
                type: "attached-point",
                id: primaryItem.id,
                trackId: primaryItem.trackId,
                parentTrackId: primaryItem.parentTrackId,
              }
          : { type: primaryItem.type, id: primaryItem.id },
        nextSelectedItems,
      );
    }
  }

  function getBuiltinTrackDefaultOption(trackId: BuiltinTrackId) {
    const currentProject = projectRef.current;
    const options = getBuiltinTrackOptions(currentProject.builtinTracks, trackId);
    return options[0] ?? getDefaultFixedActionLabel(trackId);
  }

  function updateTimelineSelectionBatch(items: TimelineBatchMoveItem[], recordHistory = true) {
    if (items.length === 0) {
      return;
    }

    const currentProject = projectRef.current;
    const characterUpdates = new Map(
      items
        .filter((item): item is TimelineBatchMoveItem & { type: "character" } => item.type === "character")
        .map((item) => [item.id, item]),
    );
    const actionUpdates = new Map(
      items
        .filter((item): item is TimelineBatchMoveItem & { type: "action" } => item.type === "action")
        .map((item) => [item.id, item]),
    );
    const attachedPointUpdates = new Map(
      items
        .filter(
          (item): item is TimelineBatchMoveItem & { type: "attached-point"; trackId: string } =>
            item.type === "attached-point",
        )
        .map((item) => [`${item.trackId}:${item.id}`, item]),
    );
    const customBlockUpdates = new Map(
      items
        .filter(
          (item): item is TimelineBatchMoveItem & { type: "custom-block"; trackId: string } =>
            item.type === "custom-block",
        )
        .map((item) => [`${item.trackId}:${item.id}`, item]),
    );
    const affectedLineIds = new Set<string>();

    const nextProject = {
      ...currentProject,
      characterAnnotations: currentProject.characterAnnotations.map((item) => {
        const update = characterUpdates.get(item.id);
        if (!update) {
          return item;
        }
        affectedLineIds.add(item.lineId);
        return {
          ...item,
          startTime: update.startTime,
          endTime: update.endTime,
        };
      }),
      actionAnnotations: currentProject.actionAnnotations.map((item) => {
        const update = actionUpdates.get(item.id);
        if (!update) {
          return item;
        }
        return {
          ...item,
          startTime: update.startTime,
          endTime: update.endTime,
        };
      }),
      builtinTracks: currentProject.builtinTracks.map((track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
          ...pointTrack,
          points: pointTrack.points.map((point) => {
            const update = attachedPointUpdates.get(`${pointTrack.id}:${point.id}`);
            if (!update) {
              return point;
            }
            return {
              ...point,
              time: update.startTime,
            };
          }),
        })),
      })),
      customTracks: currentProject.customTracks.map((track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
          ...pointTrack,
          points: pointTrack.points.map((point) => {
            const update = attachedPointUpdates.get(`${pointTrack.id}:${point.id}`);
            if (!update) {
              return point;
            }
            return {
              ...point,
              time: update.startTime,
            };
          }),
        })),
        blocks: track.blocks.map((block) => {
          const update = customBlockUpdates.get(`${track.id}:${block.id}`);
          if (!update) {
            return block;
          }
          return {
            ...block,
            startTime: update.startTime,
            endTime: update.endTime,
          };
        }) as CustomTrack["blocks"],
      })) as CustomTrack[],
    };

    const synchronizedProject = affectedLineIds.size > 0
      ? syncSubtitleLines(nextProject, Array.from(affectedLineIds))
      : nextProject;

    if (recordHistory) {
      commitProject(synchronizedProject);
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function createCharacterAtTime(time: number, explicitEndTime?: number) {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === "character-track")) {
      return;
    }
    const normalizedTime = Math.max(0, time);
    const requestedRange = normalizeCharacterCreationRequest(normalizedTime, explicitEndTime);
    const target = findCharacterCreationTarget(currentProject.subtitleLines, normalizedTime);
    const characterId = `char-${crypto.randomUUID()}`;
    const char = "新";
    let nextProject: ProjectData;

    if (target) {
      const range = getCharacterCreationRange(target.line, target.position, requestedRange);
      nextProject = syncSubtitleLine({
        ...currentProject,
        characterAnnotations: [
          ...currentProject.characterAnnotations,
          {
            id: characterId,
            lineId: target.line.id,
            char,
            startTime: range.startTime,
            endTime: range.endTime,
            singingStyle: "普通唱",
          },
        ],
      }, target.line.id);
    } else {
      const lineId = `line-${crypto.randomUUID()}`;
      const startTime = requestedRange.startTime;
      const endTime = requestedRange.endTime;
      nextProject = {
        ...currentProject,
        subtitleLines: sortSubtitleLines([
          ...currentProject.subtitleLines,
          {
            id: lineId,
            text: char,
            startTime,
            endTime,
          },
        ]),
        characterAnnotations: [
          ...currentProject.characterAnnotations,
          {
            id: characterId,
            lineId,
            char,
            startTime,
            endTime,
            singingStyle: "普通唱",
          },
        ],
      };
    }

    commitProject(nextProject);
    preferredCharacterEditLocationRef.current = "timeline";
    applySelection({ type: "character", id: characterId });
    setEditingCharacterId(characterId);
    setEditingCharacterLocation("timeline");
    setEditingCharacterValue(char);
  }

  function createActionAtTime(trackId: string, startTime: number) {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === trackId)) {
      return;
    }
    const safeStartTime = Math.max(0, startTime);
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: getBuiltinTrackDefaultOption(trackId as BuiltinTrackId),
          startTime: safeStartTime,
          endTime: safeStartTime + DEFAULT_ACTION_DURATION,
        },
      ],
    });
  }

  function addBuiltinTrack(trackId: BuiltinTrackId) {
    const currentProject = projectRef.current;
    if (currentProject.builtinTracks.some((track) => track.id === trackId)) {
      return;
    }
    commitProject({
      ...currentProject,
      builtinTracks: [...currentProject.builtinTracks, getBuiltinTrackDefinition(trackId)],
      activeTrackOrder: [...currentProject.activeTrackOrder, trackId],
    });
  }

  function deleteBuiltinTrack(trackId: BuiltinTrackId) {
    const currentProject = projectRef.current;
    const targetTrack = currentProject.builtinTracks.find((track) => track.id === trackId);
    if (!targetTrack) {
      return;
    }
    const affectedCharacterCount = trackId === "character-track"
      ? currentProject.characterAnnotations.length
      : 0;
    const affectedActionCount = trackId === "character-track"
      ? 0
      : currentProject.actionAnnotations.filter((item) => item.trackId === trackId).length;
    const affectedPointCount = (targetTrack.attachedPointTracks ?? []).reduce(
      (sum, pointTrack) => sum + pointTrack.points.length,
      0,
    );
    const affectedCount = affectedCharacterCount + affectedActionCount + affectedPointCount;
    const confirmed = window.confirm(
      `确定要删除轨道“${targetTrack.name}”吗？` +
        `\n删除轨道会同时删除轨道上的全部标注` +
        (affectedCount > 0 ? `（当前共 ${affectedCount} 条）` : "") +
        `。`,
    );
    if (!confirmed) {
      return;
    }

    const nextProject = trackId === "character-track"
      ? {
          ...currentProject,
          builtinTracks: currentProject.builtinTracks.filter((track) => track.id !== trackId),
          activeTrackOrder: currentProject.activeTrackOrder.filter((id) => id !== trackId),
          characterAnnotations: [],
        }
      : {
          ...currentProject,
          builtinTracks: currentProject.builtinTracks.filter((track) => track.id !== trackId),
          activeTrackOrder: currentProject.activeTrackOrder.filter((id) => id !== trackId),
          actionAnnotations: currentProject.actionAnnotations.filter((item) => item.trackId !== trackId),
        };

    if (trackId === "character-track") {
      cancelCharacterTextEdit();
      if (
        selectedItem?.type === "character" ||
        (selectedItem?.type === "builtin-track" && selectedItem.id === trackId) ||
        (selectedItem?.type === "attached-point-track" && selectedItem.parentTrackId === trackId) ||
        (selectedItem?.type === "attached-point" && selectedItem.parentTrackId === trackId)
      ) {
        applySelection(null);
      } else {
        setSelectedTimelineItems((current) => current.filter((item) => item.type !== "character"));
      }
    } else {
      if (
        (selectedItem?.type === "builtin-track" && selectedItem.id === trackId) ||
        (selectedItem?.type === "attached-point-track" && selectedItem.parentTrackId === trackId) ||
        (selectedItem?.type === "attached-point" && selectedItem.parentTrackId === trackId)
      ) {
        applySelection(null);
      } else if (selectedItem?.type === "action" && selectedItem.id) {
        const selectedAction = currentProject.actionAnnotations.find((item) => item.id === selectedItem.id);
        if (selectedAction?.trackId === trackId) {
          applySelection(null);
        } else {
          setSelectedTimelineItems((current) =>
            current.filter((item) => item.type !== "action" || currentProject.actionAnnotations.find((action) => action.id === item.id)?.trackId !== trackId),
          );
        }
      } else {
        setSelectedTimelineItems((current) =>
          current.filter((item) => item.type !== "action" || currentProject.actionAnnotations.find((action) => action.id === item.id)?.trackId !== trackId),
        );
      }
    }

    commitProject(nextProject);
  }

  function addCustomTrack(trackType: CustomTrackType) {
    const currentProject = projectRef.current;
    const nextTrack: CustomTrack = trackType === "text"
      ? {
          id: `custom-track-${crypto.randomUUID()}`,
          name: getDefaultCustomTrackName(currentProject.customTracks, trackType),
          trackType,
          typeOptions: getDefaultCustomTrackTypeOptions(),
          blocks: [],
          attachedPointTracks: [],
          attachedPointTracksExpanded: false,
        }
      : {
          id: `custom-track-${crypto.randomUUID()}`,
          name: getDefaultCustomTrackName(currentProject.customTracks, trackType),
          trackType,
          typeOptions: getDefaultCustomTrackTypeOptions(),
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: false,
      };

    commitProject({
      ...currentProject,
      customTracks: [...currentProject.customTracks, nextTrack] as CustomTrack[],
      activeTrackOrder: [...currentProject.activeTrackOrder, nextTrack.id],
    });
    applySelection({ type: "custom-track", id: nextTrack.id });
  }

  function createAttachedPoint(pointTrackId: string, time: number) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const nextPoint: AttachedPointAnnotation = {
      id: `point-${crypto.randomUUID()}`,
      time: Math.max(0, time),
      label: location.pointTrack.typeOptions[0] ?? "标记 1",
    };
    updateAttachedPointTrack(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      points: [...pointTrack.points, nextPoint].sort((left, right) => left.time - right.time),
    }));
    applySelection({
      type: "attached-point",
      id: nextPoint.id,
      trackId: pointTrackId,
      parentTrackId: location.parentTrack.id,
    });
  }

  function createCustomBlock(
    trackId: string,
    startTime: number,
    explicitEndTime?: number,
  ) {
    const currentProject = projectRef.current;
    const targetTrack = currentProject.customTracks.find((track) => track.id === trackId);
    if (!targetTrack) {
      return;
    }
    const safeStartTime = Math.max(0, startTime);
    const endTime = explicitEndTime === undefined
      ? safeStartTime + DEFAULT_ACTION_DURATION
      : Math.max(safeStartTime + MIN_CHARACTER_DURATION, explicitEndTime);
    const defaultType = targetTrack.typeOptions[0] ?? "类型 1";
    const nextBlock = targetTrack.trackType === "text"
      ? {
          id: `custom-block-${crypto.randomUUID()}`,
          startTime: safeStartTime,
          endTime,
          text: DEFAULT_CUSTOM_TEXT,
          type: defaultType,
        }
      : {
          id: `custom-block-${crypto.randomUUID()}`,
          startTime: safeStartTime,
          endTime,
          type: defaultType,
        };

    commitProject({
      ...currentProject,
      customTracks: currentProject.customTracks.map((track) =>
        track.id === trackId
          ? {
              ...track,
              blocks: [...track.blocks, nextBlock] as CustomTrack["blocks"],
            }
          : track,
      ) as CustomTrack[],
    });

    applySelection({ type: "custom-block", trackId, id: nextBlock.id });
    if (targetTrack.trackType === "text") {
      setEditingCustomTextBlock({ trackId, id: nextBlock.id });
      setEditingCustomTextValue(DEFAULT_CUSTOM_TEXT);
    }
  }

  function applyCharacterLineAction(id: string, action: CharacterLineAction) {
    const currentProject = projectRef.current;
    const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      return;
    }

    const sortedLines = sortSubtitleLines(currentProject.subtitleLines);
    const currentLineIndex = sortedLines.findIndex((line) => line.id === currentCharacter.lineId);
    const lineCharacters = sortCharactersByTime(
      currentProject.characterAnnotations.filter((item) => item.lineId === currentCharacter.lineId),
    );
    const characterIndex = lineCharacters.findIndex((item) => item.id === id);

    if (currentLineIndex === -1 || characterIndex === -1) {
      return;
    }

    if (action === "split-block") {
      const splitCharacters = getSplittableCharacters(currentCharacter.char);
      if (splitCharacters.length <= 1) {
        return;
      }
      const sliceDuration = (currentCharacter.endTime - currentCharacter.startTime) / splitCharacters.length;
      const splitAnnotations = splitCharacters.map((char, index) => ({
        ...currentCharacter,
        id: index === 0 ? currentCharacter.id : `char-${crypto.randomUUID()}`,
        char,
        startTime: currentCharacter.startTime + sliceDuration * index,
        endTime: index === splitCharacters.length - 1
          ? currentCharacter.endTime
          : currentCharacter.startTime + sliceDuration * (index + 1),
      }));
      const splitProject = syncSubtitleLine(
        {
          ...currentProject,
          characterAnnotations: [
            ...currentProject.characterAnnotations.filter((item) => item.id !== currentCharacter.id),
            ...splitAnnotations,
          ],
        },
        currentCharacter.lineId,
      );
      commitProject(splitProject);
      applySelection({ type: "character", id: splitAnnotations[0].id });
      return;
    }

    if (action === "merge-prev-line" || action === "merge-next-line") {
      const adjacentLine = action === "merge-prev-line"
        ? sortedLines[currentLineIndex - 1]
        : sortedLines[currentLineIndex + 1];
      if (!adjacentLine) {
        return;
      }
      const mergedProject = syncSubtitleLines(
        {
          ...currentProject,
          characterAnnotations: currentProject.characterAnnotations.map((item) =>
            item.id === id ? { ...item, lineId: adjacentLine.id } : item,
          ),
        },
        [currentCharacter.lineId, adjacentLine.id],
      );
      commitProject(mergedProject);
      return;
    }

    if (action === "set-line-start") {
      if (characterIndex === 0) {
        return;
      }
      const movedCharacters = new Set(lineCharacters.slice(0, characterIndex).map((item) => item.id));
      const newLineId = `line-${crypto.randomUUID()}`;
      const splitProject = syncSubtitleLines(
        {
          ...currentProject,
          subtitleLines: [
            ...currentProject.subtitleLines,
            {
              id: newLineId,
              text: "",
              startTime: lineCharacters[0].startTime,
              endTime: lineCharacters[characterIndex - 1].endTime,
            },
          ],
          characterAnnotations: currentProject.characterAnnotations.map((item) =>
            movedCharacters.has(item.id) ? { ...item, lineId: newLineId } : item,
          ),
        },
        [newLineId, currentCharacter.lineId],
      );
      commitProject(splitProject);
      return;
    }

    if (characterIndex === lineCharacters.length - 1) {
      return;
    }
    const movedCharacters = new Set(lineCharacters.slice(characterIndex + 1).map((item) => item.id));
    const newLineId = `line-${crypto.randomUUID()}`;
    const splitProject = syncSubtitleLines(
      {
        ...currentProject,
        subtitleLines: [
          ...currentProject.subtitleLines,
          {
            id: newLineId,
            text: "",
            startTime: lineCharacters[characterIndex + 1].startTime,
            endTime: lineCharacters[lineCharacters.length - 1].endTime,
          },
        ],
        characterAnnotations: currentProject.characterAnnotations.map((item) =>
          movedCharacters.has(item.id) ? { ...item, lineId: newLineId } : item,
        ),
      },
      [newLineId, currentCharacter.lineId],
    );
    commitProject(splitProject);
  }

  function deleteSelected() {
    const currentProject = projectRef.current;
    const timelineSelection = selectedTimelineItems.length > 0
      ? selectedTimelineItems
      : selectedItem?.type === "character" || selectedItem?.type === "action"
        ? [{ type: selectedItem.type, id: selectedItem.id }]
        : selectedItem?.type === "attached-point"
          ? [{
              type: "attached-point",
              id: selectedItem.id,
              trackId: selectedItem.trackId,
              parentTrackId: selectedItem.parentTrackId,
            }]
        : selectedItem?.type === "custom-block"
          ? [{ type: "custom-block", id: selectedItem.id, trackId: selectedItem.trackId }]
        : [];

    if (timelineSelection.length > 0) {
      if (timelineSelection.length > 10) {
        const confirmed = window.confirm(`当前将删除 ${timelineSelection.length} 个已选中的时间轴项目。是否继续？`);
        if (!confirmed) {
          return;
        }
      }

      const characterIds = new Set(
        timelineSelection
          .filter((item): item is TimelineSelectionItem & { type: "character" } => item.type === "character")
          .map((item) => item.id),
      );
      const actionIds = new Set(
        timelineSelection
          .filter((item): item is TimelineSelectionItem & { type: "action" } => item.type === "action")
          .map((item) => item.id),
      );
      const customBlockKeys = new Set(
        timelineSelection
          .filter(
            (item): item is TimelineSelectionItem & { type: "custom-block"; trackId: string } =>
              item.type === "custom-block",
          )
          .map((item) => `${item.trackId}:${item.id}`),
      );
      const attachedPointKeys = new Set(
        timelineSelection
          .filter(
            (item): item is TimelineSelectionItem & { type: "attached-point"; trackId: string } =>
              item.type === "attached-point",
          )
          .map((item) => `${item.trackId}:${item.id}`),
      );
      const affectedLineIds = new Set(
        currentProject.characterAnnotations
          .filter((item) => characterIds.has(item.id))
          .map((item) => item.lineId),
      );

      const nextProject = syncSubtitleLines(
        {
          ...currentProject,
          characterAnnotations: currentProject.characterAnnotations.filter((item) => !characterIds.has(item.id)),
          actionAnnotations: currentProject.actionAnnotations.filter((item) => !actionIds.has(item.id)),
          builtinTracks: currentProject.builtinTracks.map((track) => ({
            ...track,
            attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
              ...pointTrack,
              points: pointTrack.points.filter((point) => !attachedPointKeys.has(`${pointTrack.id}:${point.id}`)),
            })),
          })),
          customTracks: currentProject.customTracks.map((track) => ({
            ...track,
            attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
              ...pointTrack,
              points: pointTrack.points.filter((point) => !attachedPointKeys.has(`${pointTrack.id}:${point.id}`)),
            })),
            blocks: track.blocks.filter((block) => !customBlockKeys.has(`${track.id}:${block.id}`)) as CustomTrack["blocks"],
          })) as CustomTrack[],
        },
        Array.from(affectedLineIds),
      );

      if (editingCharacterId && characterIds.has(editingCharacterId)) {
        cancelCharacterTextEdit();
      }
      if (
        editingCustomTextBlock &&
        customBlockKeys.has(`${editingCustomTextBlock.trackId}:${editingCustomTextBlock.id}`)
      ) {
        cancelCustomTextEdit();
      }
      commitProject(nextProject);
      applySelection(null);
      return;
    }

    if (!selectedItem) {
      return;
    }
    if (selectedItem.type === "character") {
      const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === selectedItem.id);
      if (!currentCharacter) {
        return;
      }
      const nextProject = syncSubtitleLine({
        ...currentProject,
        characterAnnotations: currentProject.characterAnnotations.filter((item) => item.id !== selectedItem.id),
      }, currentCharacter.lineId);
      commitProject(nextProject);
      if (editingCharacterId === selectedItem.id) {
        cancelCharacterTextEdit();
      }
      applySelection(null);
    }
    if (selectedItem.type === "action") {
      commitProject({
        ...currentProject,
        actionAnnotations: currentProject.actionAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      applySelection(null);
    }
    if (selectedItem.type === "custom-block") {
      commitProject({
        ...currentProject,
        customTracks: currentProject.customTracks.map((track) =>
          track.id === selectedItem.trackId
            ? {
                ...track,
                blocks: track.blocks.filter((block) => block.id !== selectedItem.id) as CustomTrack["blocks"],
              }
            : track,
        ) as CustomTrack[],
      });
      if (
        editingCustomTextBlock?.trackId === selectedItem.trackId &&
        editingCustomTextBlock.id === selectedItem.id
      ) {
        cancelCustomTextEdit();
      }
      applySelection(null);
    }
    if (selectedItem.type === "attached-point") {
      const location = findPointTrackLocation(currentProject, selectedItem.trackId);
      if (!location) {
        return;
      }
      updateAttachedPointTrack(selectedItem.trackId, (pointTrack) => ({
        ...pointTrack,
        points: pointTrack.points.filter((point) => point.id !== selectedItem.id),
      }));
      applySelection(null);
    }
    if (selectedItem.type === "attached-point-track") {
      deleteAttachedPointTrack(selectedItem.id);
    }
    if (selectedItem.type === "builtin-track") {
      deleteBuiltinTrack(selectedItem.id);
    }
    if (selectedItem.type === "custom-track") {
      deleteCustomTrack(selectedItem.id);
    }
  }

  function selectAllTimelineItems() {
    const currentProject = projectRef.current;
    const items: TimelineSelectionItem[] = [
      ...currentProject.characterAnnotations.map((item) => ({ type: "character" as const, id: item.id })),
      ...currentProject.actionAnnotations.map((item) => ({ type: "action" as const, id: item.id })),
      ...currentProject.builtinTracks.flatMap((track) =>
        (track.attachedPointTracks ?? []).flatMap((pointTrack) =>
          pointTrack.points.map((point) => ({
            type: "attached-point" as const,
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: track.id,
          })),
        ),
      ),
      ...currentProject.customTracks.flatMap((track) =>
        (track.attachedPointTracks ?? []).flatMap((pointTrack) =>
          pointTrack.points.map((point) => ({
            type: "attached-point" as const,
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: track.id,
          })),
        ),
      ),
      ...flattenCustomTrackBlocks(currentProject.customTracks).map((item) => ({
        type: "custom-block" as const,
        id: item.id,
        trackId: item.trackId,
      })),
    ];
    applySelection(items[0] ?? null, items);
  }

  function addAction(trackId: "hand-action" | "body-action") {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === trackId)) {
      return;
    }
    const startTime = currentTime;
    const endTime = Math.min(duration, startTime + DEFAULT_ACTION_DURATION);
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: getBuiltinTrackDefaultOption(trackId),
          startTime,
          endTime,
        },
      ],
    });
  }

  function createAction(trackId: string, startTime: number, endTime: number) {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === trackId)) {
      return;
    }
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: getBuiltinTrackDefaultOption(trackId as BuiltinTrackId),
          startTime,
          endTime,
        },
      ],
    });
  }

  function renameCustomTrack(trackId: string, name: string) {
    const normalizedName = name.trimStart();
    updateCustomTrack(trackId, (track) => ({
      ...track,
      name: normalizedName.length > 0 ? normalizedName : track.name,
    }) as CustomTrack);
  }

  function renameBuiltinTrack(trackId: BuiltinTrackId, name: string) {
    const normalizedName = name.trimStart();
    updateBuiltinTrack(trackId, (track) => ({
      ...track,
      name: normalizedName.length > 0 ? normalizedName : track.name,
    }));
  }

  function renameAttachedPointTrack(pointTrackId: string, name: string) {
    const normalizedName = name.trimStart();
    updateAttachedPointTrack(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      name: normalizedName.length > 0 ? normalizedName : pointTrack.name,
    }));
  }

  function updateTrackWaveformSnap(trackId: string, enabled: boolean) {
    const builtinTrack = projectRef.current.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      updateBuiltinTrack(trackId as BuiltinTrackId, (track) => ({
        ...track,
        snapToWaveformKeypoints: enabled,
      }));
      return;
    }

    const customTrack = projectRef.current.customTracks.find((track) => track.id === trackId);
    if (customTrack) {
      updateCustomTrack(trackId, (track) => ({
        ...track,
        snapToWaveformKeypoints: enabled,
      }) as CustomTrack);
      return;
    }

    updateAttachedPointTrack(trackId, (pointTrack) => ({
      ...pointTrack,
      snapToWaveformKeypoints: enabled,
    }));
  }

  function updateTrackAutoLoopRange(trackId: string, enabled: boolean) {
    const builtinTrack = projectRef.current.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      updateBuiltinTrack(trackId as BuiltinTrackId, (track) => ({
        ...track,
        autoSetLoopRangeOnSelect: enabled,
      }));
      return;
    }

    const customTrack = projectRef.current.customTracks.find((track) => track.id === trackId);
    if (customTrack) {
      updateCustomTrack(trackId, (track) => ({
        ...track,
        autoSetLoopRangeOnSelect: enabled,
      }) as CustomTrack);
      return;
    }

    updateAttachedPointTrack(trackId, (pointTrack) => ({
      ...pointTrack,
      autoSetLoopRangeOnSelect: enabled,
    }));
  }

  function updateAttachedPointTrackParentSnap(pointTrackId: string, enabled: boolean) {
    updateAttachedPointTrack(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      snapToParentBoundaries: enabled,
    }));
  }

  function moveCustomTrack(trackId: string, direction: "up" | "down") {
    moveTrack(trackId, direction);
  }

  function moveBuiltinTrack(trackId: BuiltinTrackId, direction: "up" | "down") {
    moveTrack(trackId, direction);
  }

  function reorderCustomTrack(trackId: string, insertionIndex: number) {
    reorderTrack(trackId, insertionIndex);
  }

  function reorderBuiltinTrack(trackId: BuiltinTrackId, insertionIndex: number) {
    reorderTrack(trackId, insertionIndex);
  }

  function updateCustomTrackTypeOption(trackId: string, index: number, value: string) {
    const normalizedValue = value.trimStart();
    updateCustomTrack(trackId, (track) => {
      const previousValue = track.typeOptions[index];
      const nextValue = normalizedValue.length > 0 ? normalizedValue : previousValue;
      const nextTypeOptions = track.typeOptions.map((option, optionIndex) =>
        optionIndex === index ? nextValue : option,
      );
      return {
        ...track,
        typeOptions: nextTypeOptions,
        blocks: track.blocks.map((block) =>
          block.type === previousValue ? { ...block, type: nextValue } : block,
        ) as CustomTrack["blocks"],
      } as CustomTrack;
    });
  }

  function updateBuiltinTrackTypeOption(trackId: BuiltinTrackId, index: number, value: string) {
    const normalizedValue = value.trimStart();
    const currentProject = projectRef.current;
    const targetTrack = currentProject.builtinTracks.find((track) => track.id === trackId);
    if (!targetTrack?.options || index < 0 || index >= targetTrack.options.length) {
      return;
    }
    const previousValue = targetTrack.options[index];
    const nextValue = normalizedValue.length > 0 ? normalizedValue : previousValue;
    const nextOptions = targetTrack.options.map((option, optionIndex) =>
      optionIndex === index ? nextValue : option,
    );
    const nextProject: ProjectData = {
      ...currentProject,
      builtinTracks: currentProject.builtinTracks.map((track) =>
        track.id === trackId ? { ...track, options: nextOptions } : track,
      ),
      characterAnnotations: trackId === "character-track"
        ? currentProject.characterAnnotations.map((item) =>
            item.singingStyle === previousValue ? { ...item, singingStyle: nextValue } : item
          )
        : currentProject.characterAnnotations,
      actionAnnotations: trackId !== "character-track"
        ? currentProject.actionAnnotations.map((item) =>
            item.trackId === trackId && item.label === previousValue ? { ...item, label: nextValue } : item
          )
        : currentProject.actionAnnotations,
    };
    commitProject(nextProject);
  }

  function updateAttachedPointTrackTypeOption(pointTrackId: string, index: number, value: string) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location || index < 0 || index >= location.pointTrack.typeOptions.length) {
      return;
    }
    const previousValue = location.pointTrack.typeOptions[index];
    const normalizedValue = value.trimStart();
    const nextValue = normalizedValue.length > 0 ? normalizedValue : previousValue;
    updateAttachedPointTrack(pointTrackId, (pointTrack) => {
      const nextTypeOptions = pointTrack.typeOptions.map((option, optionIndex) =>
        optionIndex === index ? nextValue : option,
      );
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
        points: pointTrack.points.map((point) =>
          point.label === previousValue ? { ...point, label: nextValue } : point,
        ),
      };
    });
  }

  function addCustomTrackTypeOption(trackId: string) {
    updateCustomTrack(trackId, (track) => ({
      ...track,
      typeOptions: [...track.typeOptions, getNextCustomTrackTypeOptionName(track.typeOptions)],
    }) as CustomTrack);
  }

  function addBuiltinTrackTypeOption(trackId: BuiltinTrackId) {
    updateBuiltinTrack(trackId, (track) => ({
      ...track,
      options: [...(track.options ?? []), getNextCustomTrackTypeOptionName(track.options ?? [])],
    }));
  }

  function addAttachedPointTrackTypeOption(pointTrackId: string) {
    updateAttachedPointTrack(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      typeOptions: [...pointTrack.typeOptions, getNextCustomTrackTypeOptionName(pointTrack.typeOptions)],
    }));
  }

  function moveCustomTrackTypeOption(trackId: string, index: number, direction: "up" | "down") {
    updateCustomTrack(trackId, (track) => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= track.typeOptions.length) {
        return track;
      }
      const nextTypeOptions = [...track.typeOptions];
      const [movedOption] = nextTypeOptions.splice(index, 1);
      nextTypeOptions.splice(targetIndex, 0, movedOption);
      return {
        ...track,
        typeOptions: nextTypeOptions,
      } as CustomTrack;
    });
  }

  function moveBuiltinTrackTypeOption(trackId: BuiltinTrackId, index: number, direction: "up" | "down") {
    updateBuiltinTrack(trackId, (track) => {
      const options = [...(track.options ?? [])];
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= options.length) {
        return track;
      }
      const [movedOption] = options.splice(index, 1);
      options.splice(targetIndex, 0, movedOption);
      return {
        ...track,
        options,
      };
    });
  }

  function moveAttachedPointTrackTypeOption(pointTrackId: string, index: number, direction: "up" | "down") {
    updateAttachedPointTrack(pointTrackId, (pointTrack) => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= pointTrack.typeOptions.length) {
        return pointTrack;
      }
      const nextTypeOptions = [...pointTrack.typeOptions];
      const [movedOption] = nextTypeOptions.splice(index, 1);
      nextTypeOptions.splice(targetIndex, 0, movedOption);
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
      };
    });
  }

  function reorderCustomTrackTypeOption(trackId: string, fromIndex: number, insertionIndex: number) {
    updateCustomTrack(trackId, (track) => {
      if (
        fromIndex < 0 ||
        fromIndex >= track.typeOptions.length ||
        insertionIndex < 0 ||
        insertionIndex > track.typeOptions.length - 1
      ) {
        return track;
      }
      const nextTypeOptions = [...track.typeOptions];
      const [movedOption] = nextTypeOptions.splice(fromIndex, 1);
      const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, nextTypeOptions.length));
      if (normalizedInsertionIndex === fromIndex) {
        return track;
      }
      nextTypeOptions.splice(normalizedInsertionIndex, 0, movedOption);
      return {
        ...track,
        typeOptions: nextTypeOptions,
      } as CustomTrack;
    });
  }

  function reorderBuiltinTrackTypeOption(trackId: BuiltinTrackId, fromIndex: number, insertionIndex: number) {
    updateBuiltinTrack(trackId, (track) => {
      const options = [...(track.options ?? [])];
      if (
        fromIndex < 0 ||
        fromIndex >= options.length ||
        insertionIndex < 0 ||
        insertionIndex > options.length - 1
      ) {
        return track;
      }
      const [movedOption] = options.splice(fromIndex, 1);
      const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, options.length));
      if (normalizedInsertionIndex === fromIndex) {
        return track;
      }
      options.splice(normalizedInsertionIndex, 0, movedOption);
      return {
        ...track,
        options,
      };
    });
  }

  function reorderAttachedPointTrackTypeOption(pointTrackId: string, fromIndex: number, insertionIndex: number) {
    updateAttachedPointTrack(pointTrackId, (pointTrack) => {
      if (
        fromIndex < 0 ||
        fromIndex >= pointTrack.typeOptions.length ||
        insertionIndex < 0 ||
        insertionIndex > pointTrack.typeOptions.length - 1
      ) {
        return pointTrack;
      }
      const nextTypeOptions = [...pointTrack.typeOptions];
      const [movedOption] = nextTypeOptions.splice(fromIndex, 1);
      const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, nextTypeOptions.length));
      if (normalizedInsertionIndex === fromIndex) {
        return pointTrack;
      }
      nextTypeOptions.splice(normalizedInsertionIndex, 0, movedOption);
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
      };
    });
  }

  function removeCustomTrackTypeOption(trackId: string, index: number) {
    updateCustomTrack(trackId, (track) => {
      if (track.typeOptions.length <= 1) {
        return track;
      }
      const removedValue = track.typeOptions[index];
      const nextTypeOptions = track.typeOptions.filter((_, optionIndex) => optionIndex !== index);
      const fallbackType = nextTypeOptions[0] ?? "类型 1";
      return {
        ...track,
        typeOptions: nextTypeOptions,
        blocks: track.blocks.map((block) =>
          block.type === removedValue ? { ...block, type: fallbackType } : block,
        ) as CustomTrack["blocks"],
      } as CustomTrack;
    });
  }

  function removeBuiltinTrackTypeOption(trackId: BuiltinTrackId, index: number) {
    const currentProject = projectRef.current;
    const targetTrack = currentProject.builtinTracks.find((track) => track.id === trackId);
    const options = targetTrack?.options ?? [];
    if (options.length <= 1 || index < 0 || index >= options.length) {
      return;
    }
    const removedValue = options[index];
    const nextOptions = options.filter((_, optionIndex) => optionIndex !== index);
    const fallbackOption = nextOptions[0] ?? "类型 1";
    commitProject({
      ...currentProject,
      builtinTracks: currentProject.builtinTracks.map((track) =>
        track.id === trackId ? { ...track, options: nextOptions } : track,
      ),
      characterAnnotations: trackId === "character-track"
        ? currentProject.characterAnnotations.map((item) =>
            item.singingStyle === removedValue ? { ...item, singingStyle: fallbackOption } : item
          )
        : currentProject.characterAnnotations,
      actionAnnotations: trackId !== "character-track"
        ? currentProject.actionAnnotations.map((item) =>
            item.trackId === trackId && item.label === removedValue ? { ...item, label: fallbackOption } : item
          )
        : currentProject.actionAnnotations,
    });
  }

  function removeAttachedPointTrackTypeOption(pointTrackId: string, index: number) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const options = location.pointTrack.typeOptions;
    if (options.length <= 1 || index < 0 || index >= options.length) {
      return;
    }
    const removedValue = options[index];
    const nextTypeOptions = options.filter((_, optionIndex) => optionIndex !== index);
    const fallbackOption = nextTypeOptions[0] ?? "标记 1";
    updateAttachedPointTrack(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      typeOptions: nextTypeOptions,
      points: pointTrack.points.map((point) =>
        point.label === removedValue ? { ...point, label: fallbackOption } : point,
      ),
    }));
  }

  function deleteCustomTrack(trackId: string) {
    const currentProject = projectRef.current;
    const track = currentProject.customTracks.find((item) => item.id === trackId);
    if (!track) {
      return;
    }
    const blockCount = track.blocks.length;
    const pointCount = (track.attachedPointTracks ?? []).reduce((sum, pointTrack) => sum + pointTrack.points.length, 0);
    const confirmed = window.confirm(
      `确定要删除轨道“${track.name}”吗？` +
        `\n删除轨道会同时删除轨道上的全部标注` +
        (blockCount + pointCount > 0 ? `（当前共 ${blockCount + pointCount} 条）` : "") +
        `，此操作会进入撤销历史。`,
    );
    if (!confirmed) {
      return;
    }
    const nextProject = {
      ...currentProject,
      activeTrackOrder: currentProject.activeTrackOrder.filter((id) => id !== trackId),
      customTracks: currentProject.customTracks.filter((item) => item.id !== trackId) as CustomTrack[],
    };
    if (editingCustomTextBlock?.trackId === trackId) {
      cancelCustomTextEdit();
    }
    commitProject(nextProject);
    if (
      (selectedItem?.type === "custom-track" && selectedItem.id === trackId) ||
      (selectedItem?.type === "custom-block" && selectedItem.trackId === trackId) ||
      (selectedItem?.type === "attached-point-track" && selectedItem.parentTrackId === trackId) ||
      (selectedItem?.type === "attached-point" && selectedItem.parentTrackId === trackId)
    ) {
      applySelection(null);
    }
  }

  function deleteAttachedPointTrack(pointTrackId: string) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const pointCount = location.pointTrack.points.length;
    const confirmed = window.confirm(
      `确定要删除附属打点轨“${location.pointTrack.name}”吗？` +
        `\n删除后会同时删除轨道上的全部打点` +
        (pointCount > 0 ? `（当前共 ${pointCount} 个）` : "") +
        `。`,
    );
    if (!confirmed) {
      return;
    }
    if (location.parentType === "builtin") {
      updateBuiltinTrack(location.parentTrack.id, (track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).filter((pointTrack) => pointTrack.id !== pointTrackId),
      }));
    } else {
      updateCustomTrack(location.parentTrack.id, (track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).filter((pointTrack) => pointTrack.id !== pointTrackId),
      }) as CustomTrack);
    }
    if (
      (selectedItem?.type === "attached-point-track" && selectedItem.id === pointTrackId) ||
      (selectedItem?.type === "attached-point" && selectedItem.trackId === pointTrackId)
    ) {
      applySelection(null);
    }
  }

  function undo() {
    undoProject((previousEntry: HistoryEntry) => {
      if (!requiresUndoConfirmation(previousEntry.action)) {
        return true;
      }
      return window.confirm(getUndoConfirmationMessage(previousEntry.action));
    });
  }

  function redo() {
    redoProject();
  }

  async function importSrtFile(file: File) {
    const text = await file.text();
    const lines = parseSrt(text);
    const nextProject = buildProjectFromLines(lines, projectRef.current.video);
    commitProject(nextProject, undefined, "import-srt");
    applySelection(lines[0] ? { type: "line", id: lines[0].id } : null);
    if (lines[0]) {
      seekTo(lines[0].startTime);
    }
  }

  async function handleVideoImport(file: File) {
    const playbackUrl = URL.createObjectURL(file);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setPreviewTime(null);
    setIsPlaying(false);
    setCurrentTime(0);
    commitProject({
      ...projectRef.current,
      video: {
        url: playbackUrl,
        name: file.name,
        source: "embedded",
        filePath: null,
        requiresManualImport: false,
      },
    }, undefined, "import-video");
  }

  async function importProjectFile(file: File) {
    try {
      if (hasUnsavedChanges) {
        const confirmed = window.confirm("当前项目还有未保存修改。确定要导入新项目并覆盖当前内容吗？");
        if (!confirmed) {
          return;
        }
      }
      const text = await file.text();
      const parsed = JSON.parse(text) as SavedProjectFile | ProjectData;
      const normalized = normalizeImportedProjectFile(parsed);
      const hydratedProject = normalized.project;
      const shouldManuallyImportVideo = shouldPromptForManualVideoImport(hydratedProject.video);
      const normalizedTrackSnapEnabled = getNormalizedTrackSnapEnabled(
        hydratedProject,
        normalized.uiState?.trackSnapEnabled,
      );
      commitProject(hydratedProject, undefined, "import-project");
      applyTrackSnapEnabledState(normalizedTrackSnapEnabled);
      setZoom(normalized.uiState?.zoom ?? 20);
      setPlaybackRate(normalized.uiState?.playbackRate ?? 1);
      setLoopPlaybackEnabled(Boolean(normalized.uiState?.loopPlaybackEnabled));
      setLoopPlaybackRange(normalized.uiState?.loopPlaybackRange ?? null);
      setPreviewTime(null);
      setLineFocusRequest(null);
      setBlockContextMenu(null);
      cancelCharacterTextEdit();
      cancelCustomTextEdit();
      applySelection(hydratedProject.subtitleLines[0] ? { type: "line", id: hydratedProject.subtitleLines[0].id } : null);
      seekTo(
        clampTime(
          normalized.uiState?.currentTime ?? hydratedProject.subtitleLines[0]?.startTime ?? 0,
          getProjectDuration(hydratedProject),
        ),
      );
      markProjectAsSaved(hydratedProject, normalizedTrackSnapEnabled);
      setCurrentProjectFileName(getNormalizedProjectFileName(file.name));
      if (shouldManuallyImportVideo) {
        setManualVideoRelinkPrompt(hydratedProject.video);
      } else {
        setManualVideoRelinkPrompt(null);
      }
    } catch {
      window.alert("导入项目失败。请选择由本工具导出的项目 JSON，或检查文件内容是否完整。");
    }
  }

  async function importAndMergeProjectFile(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SavedProjectFile | ProjectData;
      const normalized = normalizeImportedProjectFile(parsed);
      const sourceProject = normalized.project;
      const currentProject = projectRef.current;
      const mergeRows = buildInitialImportMergeRows(currentProject, sourceProject);
      if (mergeRows.length === 0) {
        window.alert("导入的项目里没有可整合的轨道内容。");
        return;
      }
      setPendingImportMergeState({
        fileName: file.name,
        sourceProject,
        rows: mergeRows,
        videoWarning: getImportMergeVideoWarning(currentProject, sourceProject),
      });
      setManualVideoRelinkPrompt(null);
    } catch {
      window.alert("导入整合失败。请选择由本工具导出的项目 JSON，或检查文件内容是否完整。");
    }
  }

  function updateImportMergeRow(rowKey: string, updates: Partial<Pick<ImportMergeRow, "targetChoice" | "mergeMode">>) {
    setPendingImportMergeState((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) =>
          row.key === rowKey
            ? {
                ...row,
                ...updates,
              }
            : row),
      };
    });
  }

  function applyImportMerge() {
    const pendingState = pendingImportMergeState;
    if (!pendingState) {
      return;
    }
    const currentProject = projectRef.current;
    const prepared = prepareImportMerge(currentProject, pendingState.sourceProject, pendingState.rows);
    if (prepared.skippedAll) {
      window.alert("当前整合设置没有可导入的轨道内容。请至少选择一条轨道进行替换或叠加。");
      return;
    }
    if (prepared.warnings.length > 0) {
      const confirmed = window.confirm(`整合前发现以下问题：\n\n${prepared.warnings.join("\n")}\n\n是否继续整合？`);
      if (!confirmed) {
        return;
      }
    }
    const nextProject = applyPreparedImportMerge(currentProject, pendingState.sourceProject, prepared.plans);
    commitProject(nextProject, undefined, "merge-project");
    setPendingImportMergeState(null);
  }

  async function saveProjectFile() {
    if (editingCharacterId) {
      commitCharacterTextEdit(editingCharacterId);
    }
    if (editingCustomTextBlock) {
      commitCustomTextEdit(editingCustomTextBlock.trackId, editingCustomTextBlock.id);
    }

    const projectToSave = projectRef.current;
    const persistableProject = getPersistableProjectData(projectToSave);
    const savePayload: SavedProjectFile = {
      version: PROJECT_FILE_VERSION,
      project: persistableProject,
      uiState: {
        zoom,
        currentTime,
        playbackRate,
        trackSnapEnabled: trackSnapEnabledRef.current,
        loopPlaybackEnabled,
        loopPlaybackRange,
      },
    };
    downloadBlob(
      JSON.stringify(savePayload, null, 2),
      getProjectFileName(projectToSave, currentProjectFileName),
      "application/json",
    );
    markProjectAsSaved(projectToSave, trackSnapEnabledRef.current);
  }

  function handleExport(kind: "character" | "singing" | "hand" | "body") {
    const fileMap = {
      character: {
        name: "character_track.srt",
        content: exportCharacterTrackToSrt(project.characterAnnotations),
      },
      singing: {
        name: "singing_style_track.srt",
        content: exportSingingStyleTrackToSrt(project.characterAnnotations),
      },
      hand: {
        name: "hand_action_track.srt",
        content: exportActionTrackToSrt(project.actionAnnotations, "hand-action"),
      },
      body: {
        name: "body_action_track.srt",
        content: exportActionTrackToSrt(project.actionAnnotations, "body-action"),
      },
    };
    const target = fileMap[kind];
    downloadBlob(target.content, target.name, "application/x-subrip");
  }

  function openDetachedWindow(
    title: string,
    name: string,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
  ) {
    const left = Math.max(0, Math.round(window.screenX + offsetX));
    const top = Math.max(0, Math.round(window.screenY + offsetY));
    const features = [
      "popup=yes",
      "resizable=yes",
      "scrollbars=no",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
    ].join(",");
    const popup = window.open("", name, features);
    if (!popup) {
      window.alert("浏览器阻止了弹出窗口。请允许本站点弹出窗口后再试。");
      return null;
    }
    popup.document.title = title;
    popup.focus();
    return popup;
  }

  function closePreviewDetachedWindow() {
    setPreviewDetachedWindow((currentWindow) => {
      if (currentWindow && !currentWindow.closed) {
        currentWindow.close();
      }
      return null;
    });
  }

  function closeTimelineDetachedWindow() {
    setTimelineDetachedWindow((currentWindow) => {
      if (currentWindow && !currentWindow.closed) {
        currentWindow.close();
      }
      return null;
    });
  }

  function togglePreviewDetachedWindow() {
    if (previewDetachedWindow && !previewDetachedWindow.closed) {
      closePreviewDetachedWindow();
      return;
    }
    const popup = openDetachedWindow("视频播放器", "xiqu-preview-window", 760, 480, 80, 80);
    if (popup) {
      setPreviewDetachedWindow(popup);
    }
  }

  function toggleTimelineDetachedWindow() {
    if (timelineDetachedWindow && !timelineDetachedWindow.closed) {
      closeTimelineDetachedWindow();
      return;
    }
    const popup = openDetachedWindow("多轨时间轴", "xiqu-timeline-window", 1180, 620, 120, 120);
    if (popup) {
      setTimelineDetachedWindow(popup);
    }
  }

  function renderPreviewWorkspace(detached: boolean) {
    return (
      <VideoPlayer
        ref={videoRef}
        videoUrl={project.video.url}
        playbackRate={playbackRate}
        currentTime={currentTime}
        previewTime={previewTime}
        isPlaying={isPlaying}
        isDetached={detached}
        onToggleDetached={togglePreviewDetachedWindow}
        onLoadedMetadata={(nextDuration) => setDuration(Math.max(nextDuration, getProjectDuration(project)))}
        onTimeUpdate={setCurrentTime}
        onPlayStateChange={setIsPlaying}
      />
    );
  }

  function renderTimelineWorkspace(detached: boolean) {
    return (
      <Timeline
        subtitleLines={project.subtitleLines}
        builtinTracks={project.builtinTracks}
        characterAnnotations={project.characterAnnotations}
        actionAnnotations={project.actionAnnotations}
        customTracks={project.customTracks}
        trackDefinitions={timelineTrackDefinitions}
        missingBuiltinTracks={missingBuiltinTracks}
        waveformData={waveformData}
        isWaveformLoading={isWaveformLoading}
        spectrogramData={spectrogramData}
        isSpectrogramLoading={isSpectrogramLoading}
        spectrogramSettings={spectrogramSettings}
        currentTime={currentTime}
        loopPlaybackRange={loopPlaybackRange}
        loopPlaybackEnabled={loopPlaybackEnabled}
        isDetached={detached}
        selectedItem={selectedItem}
        selectedTimelineItems={selectedTimelineItems}
        trackSnapEnabled={trackSnapEnabled}
        zoom={zoom}
        duration={duration}
        focusRange={focusRange}
        onFocusRangeHandled={() => setLineFocusRequest(null)}
        getProjectSnapshot={() => projectRef.current}
        onZoomChange={setZoom}
        onToggleTrackSnap={(trackId) => {
          applyTrackSnapEnabledState({
            ...trackSnapEnabledRef.current,
            [trackId]: !trackSnapEnabledRef.current[trackId],
          });
        }}
        onLoopPlaybackRangeChange={(range) => {
          setLoopPlaybackRange(range);
          setLoopPlaybackEnabled(Boolean(range));
        }}
        onLoopPlaybackEnabledChange={setLoopPlaybackEnabled}
        onToggleDetached={toggleTimelineDetachedWindow}
        onSeek={seekTo}
        onPreviewFrame={setPreviewTime}
        onSelectItem={(item) => {
          setLineFocusRequest(null);
          if (item?.type === "character") {
            preferredCharacterEditLocationRef.current = "timeline";
          }
          applySelection(item);
        }}
        onCloseContextMenu={closeTimelineContextMenu}
        onSelectTimelineItems={(items, primaryItem) => {
          setLineFocusRequest(null);
          if (primaryItem?.type === "character") {
            preferredCharacterEditLocationRef.current = "timeline";
          }
          applySelection(primaryItem, items);
        }}
        onSelectLineOverlay={(lineId) => {
          setLineFocusRequest(null);
          applySelection({ type: "line", id: lineId });
        }}
        editingCharacterId={editingCharacterId}
        editingCharacterLocation={editingCharacterLocation}
        editingCharacterValue={editingCharacterValue}
        editingCustomTextBlock={editingCustomTextBlock}
        editingCustomTextValue={editingCustomTextValue}
        onEditingCharacterValueChange={setEditingCharacterValue}
        onEditingCustomTextValueChange={setEditingCustomTextValue}
        onCommitCharacterTextEdit={commitCharacterTextEdit}
        onCommitCustomTextEdit={commitCustomTextEdit}
        onCancelCharacterTextEdit={cancelCharacterTextEdit}
        onCancelCustomTextEdit={cancelCustomTextEdit}
        onEditCharacterText={(id) => startCharacterTextEdit(id, "timeline")}
        onEditCustomTextBlock={startCustomTextEdit}
        onCreateCharacterAtTime={createCharacterAtTime}
        onCreateActionAtTime={createActionAtTime}
        onCreateCustomBlock={createCustomBlock}
        onAddCustomTrack={addCustomTrack}
        onUpdatePasteTarget={updateTimelinePasteTarget}
        onSelectBuiltinTrack={(trackId) => {
          setLineFocusRequest(null);
          applySelection({ type: "builtin-track", id: trackId });
        }}
        onAddBuiltinTrack={addBuiltinTrack}
        onSelectTrack={(trackId) => {
          setLineFocusRequest(null);
          applySelection(
            activeBuiltinTrackIds.has(trackId as BuiltinTrackId)
              ? { type: "builtin-track", id: trackId as BuiltinTrackId }
              : { type: "custom-track", id: trackId },
          );
        }}
        onSelectAttachedPointTrack={(trackId, parentTrackId) => {
          setLineFocusRequest(null);
          applySelection({ type: "attached-point-track", id: trackId, parentTrackId });
        }}
        onMoveTrack={(trackId, direction) => {
          if (activeBuiltinTrackIds.has(trackId as BuiltinTrackId)) {
            moveBuiltinTrack(trackId as BuiltinTrackId, direction);
          } else {
            moveCustomTrack(trackId, direction);
          }
        }}
        onReorderTrack={(trackId, insertionIndex) => {
          if (activeBuiltinTrackIds.has(trackId as BuiltinTrackId)) {
            reorderBuiltinTrack(trackId as BuiltinTrackId, insertionIndex);
          } else {
            reorderCustomTrack(trackId, insertionIndex);
          }
        }}
        onToggleAttachedPointTracks={toggleAttachedPointTracks}
        onDeleteBuiltinTrack={deleteBuiltinTrack}
        onDeleteCustomTrack={deleteCustomTrack}
        onOpenCharacterContextMenu={(id, time, x, y) => {
          preferredCharacterEditLocationRef.current = "timeline";
          updateTimelinePasteTarget("character-track", time);
          setBlockContextMenu({
            type: "character",
            id,
            trackId: "character-track",
            time,
            x,
            y,
          });
        }}
        onOpenActionContextMenu={(id, time, x, y) => {
          const action = projectRef.current.actionAnnotations.find((item) => item.id === id);
          updateTimelinePasteTarget(action?.trackId ?? "", time);
          setBlockContextMenu({
            type: "action",
            id,
            trackId: action?.trackId ?? "",
            time,
            x,
            y,
          });
        }}
        onOpenCustomBlockContextMenu={(trackId, id, time, x, y) => {
          updateTimelinePasteTarget(trackId, time);
          setBlockContextMenu({
            type: "custom-block",
            trackId,
            id,
            time,
            x,
            y,
          });
        }}
        onOpenLaneContextMenu={(trackId, time, x, y) => {
          updateTimelinePasteTarget(trackId, time);
          setBlockContextMenu({ type: "lane", trackId, time, x, y });
        }}
        onLineChange={(id, changes) => updateLinePosition(id, changes, false)}
        onLineCommit={(id, changes) => updateLinePosition(id, changes, true)}
        onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
        onCharacterCommit={(id, changes) => updateCharacter(id, changes, true)}
        onActionChange={(id, changes) => updateAction(id, changes, false)}
        onActionCommit={(id, changes) => updateAction(id, changes, true)}
        onAttachedPointChange={changeAttachedPoint}
        onAttachedPointCommit={commitAttachedPoint}
        onCustomBlockChange={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, false)}
        onCustomBlockCommit={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, true)}
        onBatchMoveChange={(items) => updateTimelineSelectionBatch(items, false)}
        onBatchMoveCommit={(items) => updateTimelineSelectionBatch(items, true)}
        onCreateAction={createAction}
        onCreateAttachedPoint={createAttachedPoint}
      />
    );
  }

  return (
    <AppShell
      menuBar={(
        <TopMenuBar
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          loopPlaybackEnabled={loopPlaybackEnabled}
          hasLoopPlaybackRange={Boolean(loopPlaybackRange)}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          syncStatus={syncState.status}
          localRevision={syncState.localRevision}
          savedRevision={syncState.savedRevision}
          pendingOperationCount={pendingOperations.length}
          activeBuiltinTrackIds={Array.from(activeBuiltinTrackIds)}
          videoFileInputRef={videoFileInputRef}
          srtFileInputRef={srtFileInputRef}
          projectFileInputRef={projectFileInputRef}
          mergeProjectFileInputRef={mergeProjectFileInputRef}
          onTogglePlay={togglePlay}
          onStep={(delta) => seekTo(currentTime + delta)}
          onPlaybackRateChange={setPlaybackRate}
          onToggleLoopPlayback={() => setLoopPlaybackEnabled((current) => !current)}
          onClearLoopPlaybackRange={() => {
            setLoopPlaybackRange(null);
            setLoopPlaybackEnabled(false);
          }}
          onVideoFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setManualVideoRelinkPrompt(null);
              void handleVideoImport(file);
            }
            event.target.value = "";
          }}
          onSrtFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importSrtFile(file);
            }
            event.target.value = "";
          }}
          onProjectFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importProjectFile(file);
            }
            event.target.value = "";
          }}
          onMergeProjectFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importAndMergeProjectFile(file);
            }
            event.target.value = "";
          }}
          onSaveProject={() => {
            void saveProjectFile();
          }}
          onExportTrack={handleExport}
          onUndo={undo}
          onRedo={redo}
          onAddAction={addAction}
        />
      )}
    >
      <ResizableSplitLayout
        orientation="horizontal"
        initialPrimarySize={0.74}
        minPrimarySize={760}
        minSecondarySize={320}
        storageKey="layout:main-workspace"
        className="workspace-shell"
        primaryClassName="workspace-region"
        secondaryClassName="workspace-region workspace-sidebar"
        primary={(
          <LeftWorkspace
            previewDetached={isPreviewDetached}
            timelineDetached={isTimelineDetached}
            previewPanel={(
              <PreviewPanel>
                {renderPreviewWorkspace(false)}
              </PreviewPanel>
            )}
            timelinePanel={(
              <TimelinePanel>
                {renderTimelineWorkspace(false)}
              </TimelinePanel>
            )}
          />
        )}
        secondary={(
          <ResizableSplitLayout
            orientation="vertical"
            initialPrimarySize={0.34}
            minPrimarySize={180}
            minSecondarySize={280}
            storageKey="layout:sidebar-workspace"
            className="sidebar-shell"
            primaryClassName="workspace-pane sidebar-pane"
            secondaryClassName="workspace-pane sidebar-pane"
            collapsedPrimary={isSubtitlePanelCollapsed}
            collapsedSize={42}
            primary={(
              <SubtitleList
                subtitleLines={project.subtitleLines}
                currentTime={currentTime}
                selectedLineId={selectedLineId}
                collapsed={isSubtitlePanelCollapsed}
                onToggleCollapse={toggleSubtitlePanelCollapsed}
                onSelectLine={(lineId) => {
                  setLineFocusRequest({ lineId, requestId: Date.now() });
                  applySelection({ type: "line", id: lineId });
                  const line = project.subtitleLines.find((item) => item.id === lineId);
                  if (line) {
                    seekTo(line.startTime);
                  }
                }}
              />
            )}
            secondary={(
              <ResizableSplitLayout
                orientation="vertical"
                initialPrimarySize={0.4}
                minPrimarySize={150}
                minSecondarySize={220}
                storageKey="layout:sidebar-detail"
                className="sidebar-stack"
                primaryClassName="workspace-pane sidebar-pane"
                secondaryClassName="workspace-pane sidebar-pane"
                collapsedPrimary={isSplitPanelCollapsed}
                collapsedSize={42}
                primary={(
                  <section className={["panel", "split-panel", isSplitPanelCollapsed ? "is-collapsed" : ""].join(" ")}>
                    <div className="panel-header">
                      <h2>当前句逐字拆分</h2>
                      <div className="panel-header-actions">
                        {!isSplitPanelCollapsed ? <span>{activeCharacters.length} 字</span> : null}
                        <button
                          type="button"
                          className="panel-collapse-button"
                          title={isSplitPanelCollapsed ? "展开面板" : "最小化面板"}
                          aria-label={isSplitPanelCollapsed ? "展开面板" : "最小化面板"}
                          onClick={toggleSplitPanelCollapsed}
                        >
                          {isSplitPanelCollapsed ? "▸" : "—"}
                        </button>
                      </div>
                    </div>
                    {!isSplitPanelCollapsed ? (
                      <div className="character-grid">
                      {activeCharacters.map((item) => {
                        const isEditing = editingCharacterId === item.id && editingCharacterLocation === "split-panel";
                        const className = [
                          "character-chip",
                          selectedItem?.type === "character" && selectedItem.id === item.id ? "selected" : "",
                          currentTime >= item.startTime && currentTime <= item.endTime ? "active" : "",
                          isEditing ? "editing" : "",
                        ].join(" ");

                        if (isEditing) {
                          return (
                            <div key={item.id} className={className}>
                              <input
                                className="character-chip-input"
                                value={editingCharacterValue}
                                autoFocus
                                onChange={(event) => setEditingCharacterValue(event.target.value)}
                                onBlur={() => commitCharacterTextEdit(item.id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitCharacterTextEdit(item.id);
                                  }
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelCharacterTextEdit();
                                  }
                                }}
                              />
                              <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                            </div>
                          );
                        }

                        return (
                          <button
                            key={item.id}
                            className={className}
                            onClick={() => {
                              preferredCharacterEditLocationRef.current = "split-panel";
                              applySelection({ type: "character", id: item.id });
                            }}
                            onDoubleClick={() => startCharacterTextEdit(item.id, "split-panel")}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              preferredCharacterEditLocationRef.current = "split-panel";
                              applySelection({ type: "character", id: item.id });
                              setBlockContextMenu({
                                type: "character",
                                id: item.id,
                                trackId: "character-track",
                                time: item.startTime,
                                x: event.clientX,
                                y: event.clientY,
                              });
                              updateTimelinePasteTarget("character-track", item.startTime);
                            }}
                          >
                            <span>{item.char}</span>
                            <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                          </button>
                        );
                      })}
                      </div>
                    ) : null}
                  </section>
                )}
                secondary={(
                  selectedItem?.type === "waveform-track" || selectedItem?.type === "spectrogram-track" ? (
                    <SpectrogramSettingsPanel
                      settings={spectrogramSettings}
                      isWaveformLoading={isWaveformLoading}
                      hasWaveformData={Boolean(waveformData)}
                      isLoading={isSpectrogramLoading}
                      hasData={Boolean(spectrogramData)}
                      onSettingsChange={setSpectrogramSettings}
                    />
                  ) : (
                    <InspectorPanel
                      selectedItem={selectedItem}
                      subtitleLines={project.subtitleLines}
                      characterAnnotations={project.characterAnnotations}
                      actionAnnotations={project.actionAnnotations}
                      builtinTracks={project.builtinTracks}
                      customTracks={project.customTracks}
                      trackDefinitions={timelineTrackDefinitions}
                      trackSnapEnabled={trackSnapEnabled}
                      onCharacterUpdate={updateCharacter}
                      onActionUpdate={updateAction}
                      onAttachedPointUpdate={commitAttachedPoint}
                      onTrackWaveformSnapChange={updateTrackWaveformSnap}
                      onTrackAutoLoopRangeChange={updateTrackAutoLoopRange}
                      onAttachedPointTrackParentSnapChange={updateAttachedPointTrackParentSnap}
                      onSelectParentTrack={(trackId) =>
                        applySelection(
                          activeBuiltinTrackIds.has(trackId as BuiltinTrackId)
                            ? { type: "builtin-track", id: trackId as BuiltinTrackId }
                            : { type: "custom-track", id: trackId },
                        )
                      }
                      onBuiltinTrackRename={renameBuiltinTrack}
                      onBuiltinTrackTypeOptionChange={updateBuiltinTrackTypeOption}
                      onAddBuiltinTrackTypeOption={addBuiltinTrackTypeOption}
                      onMoveBuiltinTrackTypeOption={moveBuiltinTrackTypeOption}
                      onReorderBuiltinTrackTypeOption={reorderBuiltinTrackTypeOption}
                      onRemoveBuiltinTrackTypeOption={removeBuiltinTrackTypeOption}
                      onDeleteBuiltinTrack={deleteBuiltinTrack}
                      onAddAttachedPointTrack={addAttachedPointTrack}
                      onToggleAttachedPointTracks={toggleAttachedPointTracks}
                      onSelectAttachedPointTrack={(trackId, parentTrackId) =>
                        applySelection({ type: "attached-point-track", id: trackId, parentTrackId })
                      }
                      onAttachedPointTrackRename={renameAttachedPointTrack}
                      onAttachedPointTrackTypeOptionChange={updateAttachedPointTrackTypeOption}
                      onAddAttachedPointTrackTypeOption={addAttachedPointTrackTypeOption}
                      onMoveAttachedPointTrackTypeOption={moveAttachedPointTrackTypeOption}
                      onReorderAttachedPointTrackTypeOption={reorderAttachedPointTrackTypeOption}
                      onRemoveAttachedPointTrackTypeOption={removeAttachedPointTrackTypeOption}
                      onDeleteAttachedPointTrack={deleteAttachedPointTrack}
                      onCustomTrackRename={renameCustomTrack}
                      onCustomTrackTypeOptionChange={updateCustomTrackTypeOption}
                      onAddCustomTrackTypeOption={addCustomTrackTypeOption}
                      onMoveCustomTrackTypeOption={moveCustomTrackTypeOption}
                      onReorderCustomTrackTypeOption={reorderCustomTrackTypeOption}
                      onRemoveCustomTrackTypeOption={removeCustomTrackTypeOption}
                      onDeleteCustomTrack={deleteCustomTrack}
                      onCustomBlockUpdate={updateCustomBlock}
                      onDeleteSelected={deleteSelected}
                    />
                  )
                )}
              />
            )}
          />
        )}
      />
      <div className="workspace-float-layer">
        {previewDetachedWindow && !previewDetachedWindow.closed ? (
          <FloatingPanelWindow
            title="视频播放器"
            targetWindow={previewDetachedWindow}
            onClose={closePreviewDetachedWindow}
          >
            {renderPreviewWorkspace(true)}
          </FloatingPanelWindow>
        ) : null}
        {timelineDetachedWindow && !timelineDetachedWindow.closed ? (
          <FloatingPanelWindow
            title="多轨时间轴"
            targetWindow={timelineDetachedWindow}
            onClose={closeTimelineDetachedWindow}
          >
            {renderTimelineWorkspace(true)}
          </FloatingPanelWindow>
        ) : null}
      </div>
      {blockContextMenu ? (
        <div
          ref={blockContextMenuRef}
          className="character-context-menu"
          style={{
            left: blockContextMenuPosition?.left ?? blockContextMenu.x + CONTEXT_MENU_GAP,
            top: blockContextMenuPosition?.top ?? blockContextMenu.y + CONTEXT_MENU_GAP,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {blockContextMenu.type === "lane" ? (
            <>
              <div className="character-context-menu-label">时间轴</div>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
            </>
          ) : null}
          {contextMenuCharacter ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              {contextMenuSplitCharacters.length > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    applyCharacterLineAction(contextMenuCharacter.id, "split-block");
                    setBlockContextMenu(null);
                  }}
                >
                  拆分
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  applyCharacterLineAction(contextMenuCharacter.id, "set-line-start");
                  setBlockContextMenu(null);
                }}
              >
                设为本句首字
              </button>
              <button
                type="button"
                onClick={() => {
                  applyCharacterLineAction(contextMenuCharacter.id, "set-line-end");
                  setBlockContextMenu(null);
                }}
              >
                设为本句末字
              </button>
              <button
                type="button"
                onClick={() => {
                  applyCharacterLineAction(contextMenuCharacter.id, "merge-prev-line");
                  setBlockContextMenu(null);
                }}
              >
                并入前一句
              </button>
              <button
                type="button"
                onClick={() => {
                  applyCharacterLineAction(contextMenuCharacter.id, "merge-next-line");
                  setBlockContextMenu(null);
                }}
              >
                并入后一句
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">唱腔类型</div>
              {(contextMenuCharacterTrack?.options ?? [contextMenuCharacter.singingStyle]).map((style) => (
                <button
                  key={style}
                  type="button"
                  className={contextMenuCharacter.singingStyle === style ? "menu-option-active" : ""}
                  onClick={() => {
                    applyCharacterSingingStyle(contextMenuCharacter.id, style);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuCharacter.singingStyle === style ? `✓ ${style}` : style}
                </button>
              ))}
            </>
          ) : null}
          {contextMenuAction ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">
                {contextMenuActionTrack?.name ?? "动作标签"}
              </div>
              {(contextMenuActionTrack?.options ?? ["其他"]).map((label) => (
                <button
                  key={label}
                  type="button"
                  className={contextMenuAction.label === label ? "menu-option-active" : ""}
                  onClick={() => {
                    applyActionLabel(contextMenuAction.id, label);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuAction.label === label ? `✓ ${label}` : label}
                </button>
              ))}
            </>
          ) : null}
          {contextMenuCustomBlock && contextMenuCustomTrack ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">
                {contextMenuCustomTrack.name}
              </div>
              {contextMenuCustomTrack.typeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={contextMenuCustomBlock.type === option ? "menu-option-active" : ""}
                  onClick={() => {
                    applyCustomBlockType(contextMenuCustomTrack.id, contextMenuCustomBlock.id, option);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuCustomBlock.type === option ? `✓ ${option}` : option}
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {pendingPasteState ? (
        <div className="app-modal-backdrop" onClick={() => applyPendingPasteResolution("cancel")}>
          <div className="app-modal" onClick={(event) => event.stopPropagation()}>
            <h2>检测到粘贴冲突</h2>
            <p>目标时间范围内已有现有块。请选择这次粘贴的处理方式。</p>
            <p>
              当前共有 {pendingPasteState.conflicts.length} 个冲突块，涉及{" "}
              {new Set(pendingPasteState.conflicts.map((conflict) => conflict.trackName)).size} 条轨道。
            </p>
            <div className="app-modal-actions">
              <button type="button" className="secondary" onClick={() => applyPendingPasteResolution("cancel")}>
                取消
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("overwrite")}>
                覆盖
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("replace")}>
                替换
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("keep-original")}>
                保留原块
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingImportMergeState ? (
        <div className="app-modal-backdrop" onClick={() => setPendingImportMergeState(null)}>
          <div className="app-modal import-merge-modal" onClick={(event) => event.stopPropagation()}>
            <h2>整合外部标注</h2>
            <p>已读取项目文件：{pendingImportMergeState.fileName}</p>
            {pendingImportMergeState.videoWarning ? (
              <p className="import-merge-warning">{pendingImportMergeState.videoWarning}</p>
            ) : (
              <p>已按轨道类型和名称给出一版默认对齐结果。你可以在确认后替换内容或叠加内容。</p>
            )}
            <div className="import-merge-list">
              {pendingImportMergeState.rows.map((row) => {
                const targetOptions = getImportMergeTargetOptions(project, pendingImportMergeState.rows, row);
                const normalizedTargetChoice = getNormalizedImportMergeTargetChoice(
                  project,
                  pendingImportMergeState.rows,
                  row,
                );
                const preview = importMergePreviews[row.key];
                const isDisabled = Boolean(preview?.disabledReason);
                return (
                  <div
                    key={row.key}
                    className={[
                      "import-merge-row",
                      row.kind === "attached-point-track" ? "is-attached" : "",
                      isDisabled ? "is-disabled" : "",
                    ].join(" ")}
                  >
                    <div className="import-merge-row-copy">
                      <strong>{row.sourceTrackName}</strong>
                      <span>
                        {getImportMergeRowTypeLabel(row)} · {row.importedCount} 项
                        {row.sourceParentTrackName ? ` · 附属于 ${row.sourceParentTrackName}` : ""}
                      </span>
                      {preview?.disabledReason ? (
                        <span className="import-merge-note">{preview.disabledReason}</span>
                      ) : normalizedTargetChoice === IMPORT_MERGE_SKIP ? (
                        <span className="import-merge-note">当前将跳过这条轨道。</span>
                      ) : row.mergeMode === "replace" ? (
                        <span className="import-merge-note">将替换目标轨当前的 {preview?.existingCount ?? 0} 项内容。</span>
                      ) : preview && preview.duplicateCount > 0 ? (
                        <span className="import-merge-note">
                          检测到 {preview.duplicateCount} 项重复内容，叠加时会自动跳过。
                        </span>
                      ) : (
                        <span className="import-merge-note">将把内容叠加到目标轨道。</span>
                      )}
                    </div>
                    <div className="import-merge-row-controls">
                      <label>
                        <span>目标轨道</span>
                        <select
                          value={normalizedTargetChoice}
                          onChange={(event) => updateImportMergeRow(row.key, { targetChoice: event.target.value })}
                        >
                          {targetOptions.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>导入方式</span>
                        <select
                          value={row.mergeMode}
                          disabled={isDisabled || normalizedTargetChoice === IMPORT_MERGE_SKIP}
                          onChange={(event) =>
                            updateImportMergeRow(row.key, { mergeMode: event.target.value as ImportMergeMode })}
                        >
                          <option value="overlay">叠加内容</option>
                          <option value="replace">替换内容</option>
                        </select>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="app-modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingImportMergeState(null)}>
                取消
              </button>
              <button type="button" onClick={applyImportMerge}>
                整合导入
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manualVideoRelinkPrompt ? (
        <div className="app-modal-backdrop" onClick={() => setManualVideoRelinkPrompt(null)}>
          <div className="app-modal" onClick={(event) => event.stopPropagation()}>
            <h2>需要重新导入视频</h2>
            {getManualVideoImportMessageLines(manualVideoRelinkPrompt).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <div className="app-modal-actions">
              <button
                type="button"
                onClick={() => {
                  videoFileInputRef.current?.click();
                }}
              >
                选择视频文件
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setManualVideoRelinkPrompt(null)}
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

type ResolvedClipboardSelectionItem =
  | {
      type: "character";
      id: string;
      trackId: "character-track";
      lineId: string;
      char: string;
      singingStyle: string;
      startTime: number;
      endTime: number;
    }
  | {
      type: "action";
      id: string;
      trackId: string;
      label: string;
      startTime: number;
      endTime: number;
    }
  | {
      type: "custom-block";
      id: string;
      trackId: string;
      trackType: CustomTrackType;
      typeValue: string;
      text?: string;
      startTime: number;
      endTime: number;
    }
  | {
      type: "attached-point";
      id: string;
      trackId: string;
      parentTrackId: string;
      label: string;
      startTime: number;
      endTime: number;
    };

function locatePointTrack(
  project: ProjectData,
  pointTrackId: string,
) {
  for (const track of project.builtinTracks) {
    const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
    if (pointTrack) {
      return {
        parentTrack: track,
        pointTrack,
      };
    }
  }
  for (const track of project.customTracks) {
    const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
    if (pointTrack) {
      return {
        parentTrack: track,
        pointTrack,
      };
    }
  }
  return null;
}

function buildInitialImportMergeRows(
  currentProject: ProjectData,
  sourceProject: ProjectData,
) {
  const rows: ImportMergeRow[] = [];
  const orderedSourceTrackIds = sourceProject.activeTrackOrder.length > 0
    ? sourceProject.activeTrackOrder
    : [
        ...sourceProject.builtinTracks.map((track) => track.id),
        ...sourceProject.customTracks.map((track) => track.id),
      ];

  for (const trackId of orderedSourceTrackIds) {
    const builtinTrack = sourceProject.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      const importedCount = getImportMergeBuiltinItemCount(sourceProject, builtinTrack.id);
      if (importedCount > 0 || builtinTrack.attachedPointTracks.length > 0) {
        rows.push({
          key: `builtin:${builtinTrack.id}`,
          kind: "builtin-track",
          sourceTrackId: builtinTrack.id,
          sourceTrackName: builtinTrack.name,
          sourceTrackType: builtinTrack.type,
          importedCount,
          targetChoice: currentProject.builtinTracks.some((track) => track.id === builtinTrack.id)
            ? builtinTrack.id
            : IMPORT_MERGE_NEW,
          mergeMode: "overlay",
        });
      }
      for (const pointTrack of builtinTrack.attachedPointTracks) {
        if (pointTrack.points.length === 0) {
          continue;
        }
        const targetBuiltinTrack = currentProject.builtinTracks.find((track) => track.id === builtinTrack.id);
        const matchedPointTrack = targetBuiltinTrack?.attachedPointTracks.find((track) => track.name === pointTrack.name);
        rows.push({
          key: `attached:${builtinTrack.id}:${pointTrack.id}`,
          kind: "attached-point-track",
          sourceTrackId: pointTrack.id,
          sourceTrackName: pointTrack.name,
          sourceTrackType: "attached-point",
          sourceParentKey: `builtin:${builtinTrack.id}`,
          sourceParentTrackId: builtinTrack.id,
          sourceParentTrackName: builtinTrack.name,
          importedCount: pointTrack.points.length,
          targetChoice: matchedPointTrack?.id ?? IMPORT_MERGE_NEW,
          mergeMode: "overlay",
        });
      }
      continue;
    }

    const customTrack = sourceProject.customTracks.find((track) => track.id === trackId);
    if (!customTrack) {
      continue;
    }
    const importedCount = customTrack.blocks.length;
    if (importedCount > 0 || customTrack.attachedPointTracks.length > 0) {
      const matchedTrack = currentProject.customTracks.find((track) =>
        track.trackType === customTrack.trackType && track.name === customTrack.name);
      rows.push({
        key: `custom:${customTrack.id}`,
        kind: "custom-track",
        sourceTrackId: customTrack.id,
        sourceTrackName: customTrack.name,
        sourceTrackType: customTrack.trackType === "text" ? "custom-text" : "custom-action",
        importedCount,
        targetChoice: matchedTrack?.id ?? IMPORT_MERGE_NEW,
        mergeMode: "overlay",
      });
    }
    for (const pointTrack of customTrack.attachedPointTracks) {
      if (pointTrack.points.length === 0) {
        continue;
      }
      const matchedTrack = currentProject.customTracks.find((track) =>
        track.trackType === customTrack.trackType && track.name === customTrack.name);
      const matchedPointTrack = matchedTrack?.attachedPointTracks.find((track) => track.name === pointTrack.name);
      rows.push({
        key: `attached:${customTrack.id}:${pointTrack.id}`,
        kind: "attached-point-track",
        sourceTrackId: pointTrack.id,
        sourceTrackName: pointTrack.name,
        sourceTrackType: "attached-point",
        sourceParentKey: `custom:${customTrack.id}`,
        sourceParentTrackId: customTrack.id,
        sourceParentTrackName: customTrack.name,
        importedCount: pointTrack.points.length,
        targetChoice: matchedPointTrack?.id ?? IMPORT_MERGE_NEW,
        mergeMode: "overlay",
      });
    }
  }

  return rows;
}

function getImportMergeVideoWarning(
  currentProject: ProjectData,
  sourceProject: ProjectData,
) {
  const currentVideoName = currentProject.video.name?.trim();
  const sourceVideoName = sourceProject.video.name?.trim();
  const currentVideoUrl = normalizeProjectVideoUrl(currentProject.video.url);
  const sourceVideoUrl = normalizeProjectVideoUrl(sourceProject.video.url);

  if (currentVideoName && sourceVideoName && currentVideoName !== sourceVideoName) {
    return `当前项目视频为“${currentVideoName}”，导入项目视频为“${sourceVideoName}”。请先确认它们对应的是同一视频。`;
  }
  if (currentVideoUrl && sourceVideoUrl && currentVideoUrl !== sourceVideoUrl) {
    return "当前项目与导入项目的视频链接不一致。请先确认它们对应的是同一视频。";
  }
  return null;
}

function getImportMergeTargetOptions(
  currentProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
): ImportMergeTargetOption[] {
  if (row.kind === "builtin-track") {
    const builtinTrack = currentProject.builtinTracks.find((track) => track.id === row.sourceTrackId);
    return [
      ...(builtinTrack ? [{ value: builtinTrack.id, label: `对齐到 ${builtinTrack.name}` }] : []),
      { value: IMPORT_MERGE_NEW, label: "新建对应内建轨" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }

  if (row.kind === "custom-track") {
    const compatibleTracks = currentProject.customTracks.filter((track) =>
      (row.sourceTrackType === "custom-text" && track.trackType === "text") ||
      (row.sourceTrackType === "custom-action" && track.trackType === "action"));
    return [
      ...compatibleTracks.map((track) => ({
        value: track.id,
        label: `对齐到 ${track.name}`,
      })),
      { value: IMPORT_MERGE_NEW, label: "新建同类轨道" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }

  const parentRow = rows.find((candidate) => candidate.key === row.sourceParentKey);
  if (!parentRow) {
    return [{ value: IMPORT_MERGE_SKIP, label: "跳过此轨道" }];
  }
  const normalizedParentChoice = getNormalizedImportMergeTargetChoice(currentProject, rows, parentRow);
  if (normalizedParentChoice === IMPORT_MERGE_SKIP) {
    return [{ value: IMPORT_MERGE_SKIP, label: "父轨道已跳过" }];
  }
  if (normalizedParentChoice === IMPORT_MERGE_NEW) {
    return [
      { value: IMPORT_MERGE_NEW, label: "在新父轨下新建打点轨" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }
  const parentTrack = findTopLevelTrackById(currentProject, normalizedParentChoice);
  const attachedPointTracks = parentTrack?.attachedPointTracks ?? [];
  return [
    ...attachedPointTracks.map((track) => ({
      value: track.id,
      label: `对齐到 ${track.name}`,
    })),
    { value: IMPORT_MERGE_NEW, label: "在父轨下新建打点轨" },
    { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
  ];
}

function getNormalizedImportMergeTargetChoice(
  currentProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
) {
  const options = getImportMergeTargetOptions(currentProject, rows, row);
  return options.some((option) => option.value === row.targetChoice)
    ? row.targetChoice
    : (options[0]?.value ?? IMPORT_MERGE_SKIP);
}

function getImportMergePreview(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
): ImportMergePreview {
  const targetOptions = getImportMergeTargetOptions(currentProject, rows, row);
  const normalizedTargetChoice = getNormalizedImportMergeTargetChoice(currentProject, rows, row);
  const targetLabel = targetOptions.find((option) => option.value === normalizedTargetChoice)?.label ?? "未选择";

  if (row.kind === "attached-point-track") {
    const parentRow = rows.find((candidate) => candidate.key === row.sourceParentKey);
    const normalizedParentChoice = parentRow
      ? getNormalizedImportMergeTargetChoice(currentProject, rows, parentRow)
      : IMPORT_MERGE_SKIP;
    if (!parentRow || normalizedParentChoice === IMPORT_MERGE_SKIP) {
      return {
        targetLabel,
        importedCount: row.importedCount,
        existingCount: 0,
        duplicateCount: 0,
        disabledReason: "父轨道当前设置为跳过，附属打点轨不会导入。",
      };
    }
  }

  if (normalizedTargetChoice === IMPORT_MERGE_SKIP || normalizedTargetChoice === IMPORT_MERGE_NEW) {
    return {
      targetLabel,
      importedCount: row.importedCount,
      existingCount: 0,
      duplicateCount: 0,
      disabledReason: null,
    };
  }

  return {
    targetLabel,
    importedCount: row.importedCount,
    existingCount: getExistingImportMergeItemCount(currentProject, normalizedTargetChoice, row),
    duplicateCount: countImportMergeDuplicates(currentProject, sourceProject, normalizedTargetChoice, row),
    disabledReason: null,
  };
}

function prepareImportMerge(
  currentProject: ProjectData,
  _sourceProject: ProjectData,
  rows: ImportMergeRow[],
) {
  const plans = rows.map((row) => ({
    ...row,
    targetChoice: getNormalizedImportMergeTargetChoice(currentProject, rows, row),
  }));
  return {
    plans,
    warnings: [] as string[],
    skippedAll: plans.every((row) => row.targetChoice === IMPORT_MERGE_SKIP),
  };
}

function applyPreparedImportMerge(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  plans: ImportMergeRow[],
) {
  let nextProject = cloneProjectForMerge(currentProject);
  const resolvedTargetIds = new Map<string, string | null>();

  for (const row of plans.filter((candidate) => candidate.kind !== "attached-point-track")) {
    if (row.targetChoice === IMPORT_MERGE_SKIP) {
      resolvedTargetIds.set(row.key, null);
      continue;
    }

    if (row.kind === "builtin-track") {
      const sourceTrack = sourceProject.builtinTracks.find((track) => track.id === row.sourceTrackId);
      if (!sourceTrack) {
        resolvedTargetIds.set(row.key, null);
        continue;
      }
      const targetTrackId: BuiltinTrackId = row.targetChoice === IMPORT_MERGE_NEW
        ? ensureBuiltinTrackForMerge(nextProject, sourceTrack)
        : row.targetChoice as BuiltinTrackId;
      resolvedTargetIds.set(row.key, targetTrackId);
      nextProject = mergeBuiltinTrackFromImport(nextProject, sourceProject, sourceTrack, targetTrackId, row.mergeMode);
      continue;
    }

    const sourceTrack = sourceProject.customTracks.find((track) => track.id === row.sourceTrackId);
    if (!sourceTrack) {
      resolvedTargetIds.set(row.key, null);
      continue;
    }
    const targetTrackId = row.targetChoice === IMPORT_MERGE_NEW
      ? createCustomTrackForMerge(nextProject, sourceTrack)
      : row.targetChoice;
    resolvedTargetIds.set(row.key, targetTrackId);
    nextProject = mergeCustomTrackFromImport(nextProject, sourceTrack, targetTrackId, row.mergeMode);
  }

  for (const row of plans.filter((candidate) => candidate.kind === "attached-point-track")) {
    if (row.targetChoice === IMPORT_MERGE_SKIP) {
      continue;
    }
    const parentTargetId = row.sourceParentKey ? resolvedTargetIds.get(row.sourceParentKey) : null;
    if (!parentTargetId) {
      continue;
    }
    const sourceTrack = findAttachedPointTrackInProject(sourceProject, row.sourceParentTrackId ?? "", row.sourceTrackId);
    if (!sourceTrack) {
      continue;
    }
    const targetTrackId = row.targetChoice === IMPORT_MERGE_NEW
      ? createAttachedPointTrackForMerge(nextProject, parentTargetId, sourceTrack)
      : row.targetChoice;
    nextProject = mergeAttachedPointTrackFromImport(
      nextProject,
      parentTargetId,
      sourceTrack,
      targetTrackId,
      row.mergeMode,
    );
  }

  return nextProject;
}

function getImportMergeRowTypeLabel(row: ImportMergeRow) {
  if (row.kind === "attached-point-track") {
    return "附属打点轨";
  }
  if (row.sourceTrackType === "character") {
    return "逐字轨";
  }
  if (row.sourceTrackType === "action") {
    return "动作轨";
  }
  if (row.sourceTrackType === "custom-text") {
    return "自定义文字轨";
  }
  return "自定义动作轨";
}

function getImportMergeBuiltinItemCount(project: ProjectData, trackId: string) {
  if (trackId === "character-track") {
    return project.characterAnnotations.length;
  }
  return project.actionAnnotations.filter((item) => item.trackId === trackId).length;
}

function getExistingImportMergeItemCount(
  project: ProjectData,
  targetTrackId: string,
  row: ImportMergeRow,
) {
  if (row.kind === "builtin-track") {
    if (row.sourceTrackType === "character") {
      return project.characterAnnotations.length;
    }
    return project.actionAnnotations.filter((item) => item.trackId === targetTrackId).length;
  }
  if (row.kind === "custom-track") {
    return project.customTracks.find((track) => track.id === targetTrackId)?.blocks.length ?? 0;
  }
  const parentTrack = findTopLevelTrackByAttachedPointTrackId(project, targetTrackId);
  return parentTrack?.attachedPointTracks.find((track) => track.id === targetTrackId)?.points.length ?? 0;
}

function countImportMergeDuplicates(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  targetTrackId: string,
  row: ImportMergeRow,
) {
  if (row.kind === "builtin-track") {
    if (row.sourceTrackType === "character") {
      return sourceProject.characterAnnotations.filter((sourceItem) =>
        currentProject.characterAnnotations.some((targetItem) => areCharactersEquivalent(sourceItem, targetItem))).length;
    }
    return sourceProject.actionAnnotations.filter((sourceItem) =>
      sourceItem.trackId === row.sourceTrackId &&
      currentProject.actionAnnotations.some((targetItem) =>
        targetItem.trackId === targetTrackId && areActionsEquivalent(sourceItem, targetItem))).length;
  }

  if (row.kind === "custom-track") {
    const sourceTrack = sourceProject.customTracks.find((track) => track.id === row.sourceTrackId);
    const targetTrack = currentProject.customTracks.find((track) => track.id === targetTrackId);
    if (!sourceTrack || !targetTrack) {
      return 0;
    }
    return sourceTrack.blocks.filter((sourceBlock) =>
      targetTrack.blocks.some((targetBlock) => areCustomBlocksEquivalent(sourceBlock, targetBlock, sourceTrack.trackType))).length;
  }

  const sourceTrack = findAttachedPointTrackInProject(sourceProject, row.sourceParentTrackId ?? "", row.sourceTrackId);
  const targetTrack = findAttachedPointTrackInProject(
    currentProject,
    findTopLevelTrackByAttachedPointTrackId(currentProject, targetTrackId)?.id ?? "",
    targetTrackId,
  );
  if (!sourceTrack || !targetTrack) {
    return 0;
  }
  return sourceTrack.points.filter((sourcePoint) =>
    targetTrack.points.some((targetPoint) => areAttachedPointsEquivalent(sourcePoint, targetPoint))).length;
}

function cloneProjectForMerge(project: ProjectData): ProjectData {
  return {
    ...project,
    subtitleLines: project.subtitleLines.map((line) => ({ ...line })),
    characterAnnotations: project.characterAnnotations.map((item) => ({ ...item })),
    actionAnnotations: project.actionAnnotations.map((item) => ({ ...item })),
    builtinTracks: project.builtinTracks.map((track) => ({
      ...track,
      options: track.options ? [...track.options] : undefined,
      attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
    })),
    customTracks: project.customTracks.map((track) =>
      track.trackType === "text"
        ? {
            ...track,
            typeOptions: [...track.typeOptions],
            blocks: track.blocks.map((block) => ({ ...block })),
            attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
          }
        : {
            ...track,
            typeOptions: [...track.typeOptions],
            blocks: track.blocks.map((block) => ({ ...block })),
            attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
          }),
    activeTrackOrder: [...project.activeTrackOrder],
  };
}

function cloneAttachedPointTrack(track: AttachedPointTrack): AttachedPointTrack {
  return {
    ...track,
    typeOptions: [...track.typeOptions],
    points: track.points.map((point) => ({ ...point })),
  };
}

function ensureBuiltinTrackForMerge(project: ProjectData, sourceTrack: BuiltinTrack) {
  if (project.builtinTracks.some((track) => track.id === sourceTrack.id)) {
    return sourceTrack.id;
  }
  const nextTrack: BuiltinTrack = {
    ...getBuiltinTrackDefinition(sourceTrack.id),
    name: sourceTrack.name,
    options: sourceTrack.options ? [...sourceTrack.options] : undefined,
    snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
  };
  project.builtinTracks.push(nextTrack);
  if (!project.activeTrackOrder.includes(nextTrack.id)) {
    project.activeTrackOrder.push(nextTrack.id);
  }
  return nextTrack.id;
}

function createCustomTrackForMerge(project: ProjectData, sourceTrack: CustomTrack) {
  const trackId = `custom-track-${crypto.randomUUID()}`;
  const nextTrack: CustomTrack = sourceTrack.trackType === "text"
    ? {
        id: trackId,
        name: sourceTrack.name,
        trackType: "text",
        typeOptions: [...sourceTrack.typeOptions],
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
      }
    : {
        id: trackId,
        name: sourceTrack.name,
        trackType: "action",
        typeOptions: [...sourceTrack.typeOptions],
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
      };
  project.customTracks.push(nextTrack);
  project.activeTrackOrder.push(nextTrack.id);
  return nextTrack.id;
}

function createAttachedPointTrackForMerge(
  project: ProjectData,
  parentTrackId: string,
  sourceTrack: AttachedPointTrack,
) {
  const trackId = `point-track-${crypto.randomUUID()}`;
  const nextTrack: AttachedPointTrack = {
    id: trackId,
    name: sourceTrack.name,
    typeOptions: [...sourceTrack.typeOptions],
    points: [],
    snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
    snapToParentBoundaries: Boolean(sourceTrack.snapToParentBoundaries),
  };
  return updateAttachedPointTrackCollection(project, parentTrackId, (tracks) => [...tracks, nextTrack]);
}

function mergeBuiltinTrackFromImport(
  project: ProjectData,
  sourceProject: ProjectData,
  sourceTrack: BuiltinTrack,
  targetTrackId: BuiltinTrackId,
  mergeMode: ImportMergeMode,
) {
  project.builtinTracks = project.builtinTracks.map((track) =>
    track.id === targetTrackId
      ? {
          ...track,
          options: mergeUniqueStrings(track.options ?? [], sourceTrack.options ?? []),
          snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
        }
      : track);

  if (sourceTrack.type === "character") {
    const sourceCharacters = sourceProject.characterAnnotations;
    const oldLineIds = project.characterAnnotations.map((item) => item.lineId);
    const incomingCharacters = sourceCharacters.map((item) => ({
      ...item,
      id: `char-${crypto.randomUUID()}`,
    }));
    const nonDuplicateCharacters = incomingCharacters.filter((item) =>
      !project.characterAnnotations.some((existing) => areCharactersEquivalent(item, existing)));
    project.characterAnnotations = mergeMode === "replace"
      ? incomingCharacters
      : [...project.characterAnnotations, ...nonDuplicateCharacters];
    return syncSubtitleLines(project, [
      ...oldLineIds,
      ...incomingCharacters.map((item) => item.lineId),
    ]);
  }

  const sourceActions = sourceProject.actionAnnotations.filter((item) => item.trackId === sourceTrack.id);
  const incomingActions = sourceActions.map((item) => ({
    ...item,
    id: `${targetTrackId}-${crypto.randomUUID()}`,
    trackId: targetTrackId,
  }));
  const nonDuplicateActions = incomingActions.filter((item) =>
    !project.actionAnnotations.some((existing) =>
      existing.trackId === targetTrackId && areActionsEquivalent(item, existing)));
  project.actionAnnotations = mergeMode === "replace"
    ? [
        ...project.actionAnnotations.filter((item) => item.trackId !== targetTrackId),
        ...incomingActions,
      ]
    : [...project.actionAnnotations, ...nonDuplicateActions];
  return project;
}

function mergeCustomTrackFromImport(
  project: ProjectData,
  sourceTrack: CustomTrack,
  targetTrackId: string,
  mergeMode: ImportMergeMode,
) {
  project.customTracks = project.customTracks.map((track) => {
    if (track.id !== targetTrackId || track.trackType !== sourceTrack.trackType) {
      return track;
    }
    const incomingBlocks = sourceTrack.blocks.map((block) => ({
      ...block,
      id: `custom-block-${crypto.randomUUID()}`,
    }));
    const nonDuplicateBlocks = incomingBlocks.filter((block) =>
      !track.blocks.some((existing) => areCustomBlocksEquivalent(block, existing, track.trackType)));
    return {
      ...track,
      typeOptions: mergeUniqueStrings(track.typeOptions, sourceTrack.typeOptions),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
      blocks: mergeMode === "replace"
        ? incomingBlocks
        : [...track.blocks, ...nonDuplicateBlocks],
    } as CustomTrack;
  });
  return project;
}

function mergeAttachedPointTrackFromImport(
  project: ProjectData,
  parentTrackId: string,
  sourceTrack: AttachedPointTrack,
  targetTrackId: string,
  mergeMode: ImportMergeMode,
) {
  updateAttachedPointTrackCollection(project, parentTrackId, (tracks) =>
    tracks.map((track) => {
      if (track.id !== targetTrackId) {
        return track;
      }
      const incomingPoints = sourceTrack.points.map((point) => ({
        ...point,
        id: `point-${crypto.randomUUID()}`,
      }));
      const nonDuplicatePoints = incomingPoints.filter((point) =>
        !track.points.some((existing) => areAttachedPointsEquivalent(point, existing)));
      return {
        ...track,
        typeOptions: mergeUniqueStrings(track.typeOptions, sourceTrack.typeOptions),
        snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
        snapToParentBoundaries: Boolean(track.snapToParentBoundaries || sourceTrack.snapToParentBoundaries),
        points: mergeMode === "replace"
          ? incomingPoints
          : [...track.points, ...nonDuplicatePoints],
      };
    }),
  );
  return project;
}

function updateAttachedPointTrackCollection(
  project: ProjectData,
  parentTrackId: string,
  updater: (tracks: AttachedPointTrack[]) => AttachedPointTrack[],
) {
  const builtinIndex = project.builtinTracks.findIndex((track) => track.id === parentTrackId);
  if (builtinIndex >= 0) {
    const nextTracks = updater(project.builtinTracks[builtinIndex].attachedPointTracks);
    project.builtinTracks[builtinIndex] = {
      ...project.builtinTracks[builtinIndex],
      attachedPointTracks: nextTracks,
    };
    return nextTracks[nextTracks.length - 1]?.id ?? "";
  }
  const customIndex = project.customTracks.findIndex((track) => track.id === parentTrackId);
  if (customIndex >= 0) {
    const nextTracks = updater(project.customTracks[customIndex].attachedPointTracks);
    project.customTracks[customIndex] = {
      ...project.customTracks[customIndex],
      attachedPointTracks: nextTracks,
    } as CustomTrack;
    return nextTracks[nextTracks.length - 1]?.id ?? "";
  }
  return "";
}

function findTopLevelTrackById(project: ProjectData, trackId: string) {
  return project.builtinTracks.find((track) => track.id === trackId) ??
    project.customTracks.find((track) => track.id === trackId) ??
    null;
}

function findTopLevelTrackByAttachedPointTrackId(project: ProjectData, trackId: string) {
  return project.builtinTracks.find((track) => track.attachedPointTracks.some((item) => item.id === trackId)) ??
    project.customTracks.find((track) => track.attachedPointTracks.some((item) => item.id === trackId)) ??
    null;
}

function findAttachedPointTrackInProject(
  project: ProjectData,
  parentTrackId: string,
  pointTrackId: string,
) {
  const parentTrack = findTopLevelTrackById(project, parentTrackId);
  return parentTrack?.attachedPointTracks.find((track) => track.id === pointTrackId) ?? null;
}

function mergeUniqueStrings(currentValues: string[], nextValues: string[]) {
  const result = [...currentValues];
  for (const value of nextValues) {
    if (!result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function areCharactersEquivalent(left: CharacterAnnotation, right: CharacterAnnotation) {
  return left.char === right.char &&
    left.singingStyle === right.singingStyle &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areActionsEquivalent(left: ActionAnnotation, right: ActionAnnotation) {
  return left.label === right.label &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areCustomBlocksEquivalent(
  left: CustomTrack["blocks"][number],
  right: CustomTrack["blocks"][number],
  trackType: CustomTrackType,
) {
  if (trackType === "text") {
    return "text" in left && "text" in right &&
      left.type === right.type &&
      left.text === right.text &&
      timesClose(left.startTime, right.startTime) &&
      timesClose(left.endTime, right.endTime);
  }
  return left.type === right.type &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areAttachedPointsEquivalent(left: AttachedPointAnnotation, right: AttachedPointAnnotation) {
  return left.label === right.label && timesClose(left.time, right.time);
}

function timesClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

function resolveTimelineSelectionItem(
  project: ProjectData,
  item: TimelineSelectionItem,
): ResolvedClipboardSelectionItem | null {
  if (item.type === "character") {
    const annotation = project.characterAnnotations.find((candidate) => candidate.id === item.id);
    return annotation
      ? {
          type: "character",
          id: annotation.id,
          trackId: "character-track",
          lineId: annotation.lineId,
          char: annotation.char,
          singingStyle: annotation.singingStyle,
          startTime: annotation.startTime,
          endTime: annotation.endTime,
        }
      : null;
  }
  if (item.type === "action") {
    const annotation = project.actionAnnotations.find((candidate) => candidate.id === item.id);
    return annotation
      ? {
          type: "action",
          id: annotation.id,
          trackId: annotation.trackId,
          label: annotation.label,
          startTime: annotation.startTime,
          endTime: annotation.endTime,
        }
      : null;
  }
  if (item.type === "attached-point") {
    const location = locatePointTrack(project, item.trackId);
    const point = location?.pointTrack.points.find((candidate) => candidate.id === item.id);
    return point && location
      ? {
          type: "attached-point",
          id: point.id,
          trackId: item.trackId,
          parentTrackId: item.parentTrackId,
          label: point.label,
          startTime: point.time,
          endTime: point.time,
        }
      : null;
  }
  const block = findCustomBlock(project.customTracks, item.trackId, item.id);
  return block
    ? {
        type: "custom-block",
        id: block.id,
        trackId: block.trackId,
        trackType: block.trackType,
        typeValue: block.type,
        text: block.text,
        startTime: block.startTime,
        endTime: block.endTime,
      }
    : null;
}

function resolveTimelinePasteTarget(
  project: ProjectData,
  clipboard: TimelineClipboard,
  explicitTarget: TimelinePasteTarget | null,
  fallbackTime: number,
) {
  if (explicitTarget) {
    return explicitTarget;
  }
  const fallbackTrackId = clipboard.primaryTrackId ?? clipboard.sourceTrackIds[0] ?? null;
  if (!fallbackTrackId) {
    return null;
  }
  return {
    trackId: resolveExistingPasteTrackId(project, fallbackTrackId) ?? fallbackTrackId,
    time: fallbackTime,
  };
}

function resolveExistingPasteTrackId(project: ProjectData, trackId: string) {
  if (trackId === "character-track") {
    return project.builtinTracks.some((track) => track.id === trackId) ? trackId : null;
  }
  if (project.builtinTracks.some((track) => track.id === trackId)) {
    return trackId;
  }
  if (project.customTracks.some((track) => track.id === trackId)) {
    return trackId;
  }
  return null;
}

function isCompatiblePasteTrack(
  project: ProjectData,
  item: TimelineClipboardItem,
  targetTrackId: string,
) {
  if (item.type === "character") {
    return targetTrackId === "character-track" &&
      project.builtinTracks.some((track) => track.id === "character-track");
  }
  if (item.type === "action") {
    return project.builtinTracks.some((track) => track.id === targetTrackId && track.type === "action");
  }
  if (item.type === "attached-point") {
    return Boolean(locatePointTrack(project, targetTrackId));
  }
  const targetTrack = project.customTracks.find((track) => track.id === targetTrackId);
  return Boolean(targetTrack && targetTrack.trackType === item.trackType);
}

function buildPreparedPasteItems(
  project: ProjectData,
  clipboard: TimelineClipboard,
  target: TimelinePasteTarget,
): PreparedPasteItem[] {
  const remapAllToTargetTrack =
    clipboard.sourceTrackIds.length === 1 &&
    clipboard.items.every((item) => isCompatiblePasteTrack(project, item, target.trackId));

  return clipboard.items.reduce<PreparedPasteItem[]>((items, item) => {
    const targetTrackId = remapAllToTargetTrack ? target.trackId : item.sourceTrackId;
    if (!isCompatiblePasteTrack(project, item, targetTrackId)) {
      return items;
    }
    if (item.type === "attached-point") {
      const pointTrackLocation = locatePointTrack(project, targetTrackId);
      items.push({
        type: "attached-point" as const,
        targetTrackId,
        parentTrackId: pointTrackLocation?.parentTrack.id ?? item.parentTrackId,
        time: Math.max(0, target.time + item.timeOffset),
        label: item.label,
      });
      return items;
    }
    const startTime = Math.max(0, target.time + item.startOffset);
    const duration = Math.max(MIN_CHARACTER_DURATION, item.endOffset - item.startOffset);
    const endTime = startTime + duration;
    if (item.type === "character") {
      items.push({
        type: "character" as const,
        targetTrackId: "character-track" as const,
        startTime,
        endTime,
        char: item.char,
        singingStyle: item.singingStyle,
        sourceLineId: item.sourceLineId,
      });
      return items;
    }
    if (item.type === "action") {
      items.push({
        type: "action" as const,
        targetTrackId,
        startTime,
        endTime,
        label: item.label,
      });
      return items;
    }
    items.push({
      type: "custom-block" as const,
      targetTrackId,
      trackType: item.trackType,
      startTime,
      endTime,
      blockType: item.blockType,
      text: item.text,
    });
    return items;
  }, []);
}

function detectPasteConflicts(project: ProjectData, preparedItems: PreparedPasteItem[]) {
  return preparedItems
    .map((item) => {
      const existingKeys = findConflictingKeysForPreparedItem(project, item);
      if (existingKeys.length === 0) {
        return null;
      }
      return {
        item,
        existingKeys,
        trackName: getTrackDisplayName(project, item.targetTrackId),
      };
    })
    .filter((item): item is PasteConflict => Boolean(item));
}

function findConflictingKeysForPreparedItem(project: ProjectData, item: PreparedPasteItem) {
  if (item.type === "character") {
    return project.characterAnnotations
      .filter((annotation) => rangesOverlap(annotation.startTime, annotation.endTime, item.startTime, item.endTime))
      .map((annotation) => `character:${annotation.id}`);
  }
  if (item.type === "action") {
    return project.actionAnnotations
      .filter((annotation) =>
        annotation.trackId === item.targetTrackId &&
        rangesOverlap(annotation.startTime, annotation.endTime, item.startTime, item.endTime),
      )
      .map((annotation) => `action:${annotation.id}`);
  }
  if (item.type === "attached-point") {
    return [];
  }
  const targetTrack = project.customTracks.find((track) => track.id === item.targetTrackId);
  return (targetTrack?.blocks ?? [])
    .filter((block) => rangesOverlap(block.startTime, block.endTime, item.startTime, item.endTime))
    .map((block) => `custom-block:${targetTrack?.id}:${block.id}`);
}

function getTrackDisplayName(project: ProjectData, trackId: string) {
  return project.builtinTracks.find((track) => track.id === trackId)?.name ??
    project.customTracks.find((track) => track.id === trackId)?.name ??
    trackId;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function findCustomBlock(
  customTracks: CustomTrack[],
  trackId: string,
  blockId: string,
): ResolvedCustomTrackBlock | null {
  const track = customTracks.find((item) => item.id === trackId);
  const block = track?.blocks.find((item) => item.id === blockId);
  if (!track || !block) {
    return null;
  }
  return {
    id: block.id,
    trackId: track.id,
    trackType: track.trackType,
    startTime: block.startTime,
    endTime: block.endTime,
    type: block.type,
    text: track.trackType === "text"
      ? getOptionalBlockText(block as unknown as { text?: string })
      : undefined,
  };
}

function getOptionalBlockText(block: { text?: string }) {
  return typeof block.text === "string" ? block.text : undefined;
}

function downloadBlob(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function serializeComparableProject(project: ProjectData) {
  const cached = comparableProjectSignatureCache.get(project);
  if (cached) {
    return cached;
  }
  const signature = JSON.stringify(getComparableProjectSnapshot(project));
  comparableProjectSignatureCache.set(project, signature);
  return signature;
}

function getComparableProjectSnapshot(project: ProjectData) {
  const serializableProject = project;
  return {
    ...serializableProject,
    video: {
      source: serializableProject.video.source,
      name: serializableProject.video.name,
      filePath: serializableProject.video.filePath ?? null,
      requiresManualImport: Boolean(serializableProject.video.requiresManualImport),
      token: getComparableVideoToken(serializableProject.video),
    },
  };
}

function getComparableVideoToken(video: ProjectData["video"]) {
  const url = video.url ?? "";
  const filePath = video.filePath ?? "";
  const importMode = video.requiresManualImport ? "manual" : "direct";
  if (!url) {
    return `${video.source}|${video.name ?? ""}|${importMode}|${filePath}`;
  }
  if (video.source === "embedded") {
    const head = url.slice(0, 48);
    const tail = url.slice(-48);
    return `${video.source}|${video.name ?? ""}|${importMode}|${filePath}|${url.length}|${head}|${tail}`;
  }
  return `${video.source}|${video.name ?? ""}|${importMode}|${filePath}|${url}`;
}

function trackSnapStatesEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
) {
  return getTrackSnapStateSignature(left) === getTrackSnapStateSignature(right);
}

function getTrackSnapStateSignature(trackSnapState: Record<string, boolean>) {
  const cached = trackSnapSignatureCache.get(trackSnapState);
  if (cached) {
    return cached;
  }
  const signature = JSON.stringify(
    Object.keys(trackSnapState)
      .sort()
      .map((key) => [key, trackSnapState[key]]),
  );
  trackSnapSignatureCache.set(trackSnapState, signature);
  return signature;
}

function requiresUndoConfirmation(action: HistoryAction) {
  return action === "import-video" || action === "import-srt" || action === "import-project" || action === "merge-project";
}

function getUndoConfirmationMessage(action: HistoryAction) {
  if (action === "import-video") {
    return "确定要撤销导入视频吗？当前视频将从项目中移除。";
  }
  if (action === "import-srt") {
    return "确定要撤销导入句级字幕吗？当前导入的字幕与逐字结果将回退到上一步状态。";
  }
  if (action === "import-project") {
    return "确定要撤销导入项目吗？当前导入的轨道、标注和项目设置将回退到上一步状态。";
  }
  if (action === "merge-project") {
    return "确定要撤销整合导入吗？当前合并进来的轨道内容与标注将回退到上一步状态。";
  }
  return "确定要执行撤销吗？";
}

function isSingleHanCharacter(value: string) {
  return /^[\p{Script=Han}]$/u.test(value);
}

function getSplittableCharacters(value: string) {
  return Array.from(value);
}

function sortCharactersByTime(characters: CharacterAnnotation[]) {
  return [...characters].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function sortSubtitleLines(lines: SubtitleLine[]) {
  return [...lines].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function syncSubtitleLine(project: ProjectData, lineId: string) {
  const lineCharacters = sortCharactersByTime(
    project.characterAnnotations.filter((item) => item.lineId === lineId),
  );
  const existingLine = project.subtitleLines.find((line) => line.id === lineId);

  if (lineCharacters.length === 0) {
    return {
      ...project,
      subtitleLines: project.subtitleLines.filter((line) => line.id !== lineId),
    };
  }

  const nextLine: SubtitleLine = {
    id: lineId,
    text: lineCharacters.map((item) => item.char).join(""),
    startTime: lineCharacters[0].startTime,
    endTime: lineCharacters[lineCharacters.length - 1].endTime,
  };

  const nextLines = existingLine
    ? project.subtitleLines.map((line) => (line.id === lineId ? nextLine : line))
    : [...project.subtitleLines, nextLine];

  return {
    ...project,
    subtitleLines: sortSubtitleLines(nextLines),
  };
}

function syncSubtitleLines(project: ProjectData, lineIds: string[]) {
  return Array.from(new Set(lineIds)).reduce(
    (nextProject, lineId) => syncSubtitleLine(nextProject, lineId),
    project,
  );
}

function findCharacterCreationTarget(lines: SubtitleLine[], time: number) {
  const candidates = lines.flatMap((line) => {
    const results: Array<{ line: SubtitleLine; position: "start" | "end"; distance: number }> = [];
    const distanceFromEnd = time - line.endTime;
    if (distanceFromEnd >= 0 && distanceFromEnd <= CHARACTER_CREATE_ATTACH_WINDOW) {
      results.push({ line, position: "end", distance: distanceFromEnd });
    }
    const distanceFromStart = line.startTime - time;
    if (distanceFromStart >= 0 && distanceFromStart <= CHARACTER_CREATE_ATTACH_WINDOW) {
      results.push({ line, position: "start", distance: distanceFromStart });
    }
    return results;
  });

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

function getCharacterCreationRange(
  line: SubtitleLine,
  position: "start" | "end",
  requestedRange: { startTime: number; endTime: number },
) {
  if (position === "end") {
    const startTime = Math.max(line.endTime, requestedRange.startTime);
    const endTime = Math.max(startTime + MIN_CHARACTER_DURATION, requestedRange.endTime);
    return {
      startTime,
      endTime,
    };
  }

  const endTime = Math.min(line.startTime, requestedRange.endTime);
  const startTime = Math.max(0, Math.min(requestedRange.startTime, endTime - MIN_CHARACTER_DURATION));
  return {
    startTime,
    endTime,
  };
}

function normalizeCharacterCreationRequest(startTime: number, explicitEndTime?: number) {
  const normalizedStart = Math.max(0, startTime);
  const normalizedEnd = explicitEndTime === undefined
    ? normalizedStart + DEFAULT_CHARACTER_DURATION
    : Math.max(normalizedStart + MIN_CHARACTER_DURATION, explicitEndTime);
  return {
    startTime: normalizedStart,
    endTime: normalizedEnd,
  };
}

function getDefaultTrackSnapEnabled(project: ProjectData) {
  return Object.fromEntries(
    buildTimelineTrackDefinitions(project.builtinTracks, project.customTracks, project.activeTrackOrder).map((track) => [track.id, true]),
  );
}

function getNormalizedTrackSnapEnabled(
  project: ProjectData,
  trackSnapEnabled?: Record<string, boolean>,
) {
  const nextDefinitions = buildTimelineTrackDefinitions(project.builtinTracks, project.customTracks, project.activeTrackOrder);
  return Object.fromEntries(
    nextDefinitions.map((track) => [track.id, trackSnapEnabled?.[track.id] ?? true]),
  );
}

function clampTime(time: number, maxDuration: number) {
  return Math.max(0, Math.min(time, maxDuration));
}

function getProjectFileName(project: ProjectData, importedProjectFileName?: string | null) {
  if (importedProjectFileName) {
    return getNormalizedProjectFileName(importedProjectFileName);
  }
  const baseName = (project.video.name ?? "xiqu_annotation_project").replace(/\.[^.]+$/, "");
  return `${baseName || "xiqu_annotation_project"}.annotation.json`;
}

function getNormalizedProjectFileName(fileName: string) {
  const normalized = fileName.trim();
  return normalized || "xiqu_annotation_project.annotation.json";
}

function normalizeImportedProjectFile(value: SavedProjectFile | ProjectData) {
  if ("project" in value && value.project) {
    return {
      version: PROJECT_FILE_VERSION,
      project: normalizeProjectData(value.project),
      uiState: value.uiState,
    } satisfies SavedProjectFile;
  }
  return {
    version: PROJECT_FILE_VERSION,
    project: normalizeProjectData(value as ProjectData),
  } satisfies SavedProjectFile;
}

function normalizeProjectData(value: ProjectData | (Partial<ProjectData> & { videoUrl?: string; videoName?: string | null })) {
  const builtinTracks = normalizeBuiltinTracks(value.builtinTracks);
  const customTracks = normalizeCustomTracks(value.customTracks);
  return {
    video: normalizeProjectVideo(value),
    subtitleLines: Array.isArray(value.subtitleLines) ? value.subtitleLines : [],
    characterAnnotations: Array.isArray(value.characterAnnotations) ? value.characterAnnotations : [],
    actionAnnotations: Array.isArray(value.actionAnnotations) ? value.actionAnnotations : [],
    builtinTracks,
    customTracks,
    activeTrackOrder: normalizeActiveTrackOrder(
      value.activeTrackOrder,
      builtinTracks,
      customTracks,
    ),
  } satisfies ProjectData;
}

function normalizeProjectVideo(
  value: Partial<ProjectData> & { videoUrl?: string; videoName?: string | null },
) {
  if (value.video && typeof value.video.url === "string") {
    const normalizedFilePath = normalizeProjectVideoFilePath(value.video.filePath);
    const normalizedUrl = normalizeProjectVideoUrl(value.video.url);
    return {
      url: normalizedUrl,
      name: value.video.name ?? null,
      source: value.video.source === "embedded" ? "embedded" : "url",
      filePath: normalizedFilePath,
      requiresManualImport:
        typeof value.video.requiresManualImport === "boolean"
          ? value.video.requiresManualImport
          : shouldFlagVideoForManualImport(
              value.video.source === "embedded" ? "embedded" : "url",
              normalizedUrl,
              normalizedFilePath,
            ),
    } satisfies ProjectData["video"];
  }
  const legacyUrl = typeof value.videoUrl === "string" ? value.videoUrl : "";
  const normalizedLegacyFilePath = normalizeProjectVideoFilePath(undefined);
  return {
    url: normalizeProjectVideoUrl(legacyUrl),
    name: value.videoName ?? null,
    source: legacyUrl.startsWith("data:") ? "embedded" : "url",
    filePath: normalizedLegacyFilePath,
    requiresManualImport: shouldFlagVideoForManualImport(
      legacyUrl.startsWith("data:") ? "embedded" : "url",
      normalizeProjectVideoUrl(legacyUrl),
      normalizedLegacyFilePath,
    ),
  } satisfies ProjectData["video"];
}

function getPersistableProjectData(project: ProjectData): ProjectData {
  return {
    ...project,
    video: getPersistableProjectVideo(project.video),
  };
}

function getPersistableProjectVideo(video: ProjectData["video"]): ProjectData["video"] {
  const filePath = normalizeProjectVideoFilePath(video.filePath);
  if (video.source === "embedded") {
    return {
      url: "",
      name: video.name ?? null,
      source: "embedded",
      filePath,
      requiresManualImport: true,
    };
  }
  return {
    url: video.url,
    name: video.name ?? null,
    source: "url",
    filePath,
    requiresManualImport: false,
  };
}

function normalizeProjectVideoFilePath(filePath: unknown) {
  return typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
}

function normalizeProjectVideoUrl(url: string) {
  if (url.startsWith("blob:")) {
    return "";
  }
  return url;
}

function shouldFlagVideoForManualImport(
  source: ProjectData["video"]["source"],
  url: string,
  filePath: string | null,
) {
  if (source === "embedded") {
    return !url || !url.startsWith("data:");
  }
  return url.startsWith("file:") || (!url && Boolean(filePath));
}

function shouldPromptForManualVideoImport(video: ProjectData["video"]) {
  return Boolean(video.requiresManualImport);
}

function getManualVideoImportMessageLines(video: ProjectData["video"]) {
  const lines = [
    "该项目关联的是本地视频，当前浏览器无法自动恢复磁盘文件。",
    "请手动重新导入视频以继续编辑。",
  ];
  if (video.name) {
    lines.push(`原视频文件名：${video.name}`);
  }
  if (video.filePath) {
    lines.push(`项目中已保留磁盘路径字段：${video.filePath}`);
  }
  return lines;
}

function normalizeBuiltinTracks(value: ProjectData["builtinTracks"] | undefined) {
  if (!Array.isArray(value) || value.length === 0) {
    return getDefaultBuiltinTracks();
  }
  const seenIds = new Set<string>();
  const tracks = value.flatMap((track) => {
    if (!track || seenIds.has(track.id)) {
      return [];
    }
    if (track.id !== "character-track" && track.id !== "hand-action" && track.id !== "body-action") {
      return [];
    }
    seenIds.add(track.id);
    const defaultTrack = getBuiltinTrackDefinition(track.id);
    return [{
      ...defaultTrack,
      name: typeof track.name === "string" && track.name.trim() ? track.name : defaultTrack.name,
      options: Array.isArray(track.options) && track.options.length > 0
        ? track.options
        : defaultTrack.options,
      attachedPointTracks: normalizeAttachedPointTracks(track.attachedPointTracks),
      attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
    }];
  });
  return tracks.length > 0 ? tracks : getDefaultBuiltinTracks();
}

function normalizeCustomTracks(value: ProjectData["customTracks"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((track) => {
    if (!track || typeof track.id !== "string" || (track.trackType !== "text" && track.trackType !== "action")) {
      return [];
    }
    return [{
      ...track,
      name: typeof track.name === "string" && track.name.trim() ? track.name : "自定义轨道",
      typeOptions: Array.isArray(track.typeOptions) && track.typeOptions.length > 0
        ? track.typeOptions
        : getDefaultCustomTrackTypeOptions(),
      blocks: Array.isArray(track.blocks) ? track.blocks : [],
      attachedPointTracks: normalizeAttachedPointTracks(track.attachedPointTracks),
      attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
    }] as CustomTrack[];
  });
}

function normalizeAttachedPointTracks(value: AttachedPointTrack[] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((track) => {
    if (!track || typeof track.id !== "string") {
      return [];
    }
    return [{
      id: track.id,
      name: typeof track.name === "string" && track.name.trim() ? track.name : "打点轨",
      typeOptions: Array.isArray(track.typeOptions) && track.typeOptions.length > 0
        ? track.typeOptions
        : getDefaultAttachedPointTypeOptions(),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
      snapToParentBoundaries:
        typeof track.snapToParentBoundaries === "boolean"
          ? track.snapToParentBoundaries
          : true,
      points: Array.isArray(track.points)
        ? track.points
            .filter((point) => point && typeof point.id === "string")
            .map((point) => ({
              id: point.id,
              time: typeof point.time === "number" ? point.time : 0,
              label: typeof point.label === "string" && point.label.trim()
                ? point.label
                : (Array.isArray(track.typeOptions) && track.typeOptions[0]) || "标记 1",
            }))
        : [],
    }] satisfies AttachedPointTrack[];
  });
}

function normalizeActiveTrackOrder(
  value: ProjectData["activeTrackOrder"] | undefined,
  builtinTracks: ProjectData["builtinTracks"],
  customTracks: ProjectData["customTracks"],
) {
  const availableIds = new Set([
    ...builtinTracks.map((track) => track.id),
    ...customTracks.map((track) => track.id),
  ]);
  const nextOrder = Array.isArray(value)
    ? value.filter((trackId) => availableIds.has(trackId))
    : [];
  for (const track of builtinTracks) {
    if (!nextOrder.includes(track.id)) {
      nextOrder.push(track.id);
    }
  }
  for (const track of customTracks) {
    if (!nextOrder.includes(track.id)) {
      nextOrder.push(track.id);
    }
  }
  return nextOrder;
}

async function buildWaveformData(videoUrl: string): Promise<WaveformData | null> {
  const AudioContextCtor = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  if (!AudioContextCtor) {
    return null;
  }

  const response = await fetch(videoUrl);
  const buffer = await response.arrayBuffer();
  const audioContext = new AudioContextCtor();

  try {
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    const mixedChannel = mixAudioBufferChannels(audioBuffer);
    return {
      samples: mixedChannel,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      keypoints: detectWaveformKeypoints(mixedChannel, audioBuffer.sampleRate, audioBuffer.duration),
    };
  } finally {
    void audioContext.close();
  }
}

function mixAudioBufferChannels(audioBuffer: AudioBuffer) {
  const length = audioBuffer.length;
  const mixed = new Float32Array(length);

  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      mixed[sampleIndex] += channelData[sampleIndex] / audioBuffer.numberOfChannels;
    }
  }

  return mixed;
}

function detectWaveformKeypoints(
  samples: Float32Array,
  sampleRate: number,
  duration: number,
) {
  if (samples.length === 0 || sampleRate <= 0 || duration <= 0) {
    return [];
  }

  const frameSize = Math.max(64, Math.round(sampleRate * WAVEFORM_KEYPOINT_FRAME_DURATION_SECONDS));
  const hopSize = Math.max(32, Math.round(frameSize / 2));
  const envelopeLength = Math.max(1, Math.ceil(samples.length / hopSize));
  const envelope = new Float32Array(envelopeLength);

  for (let frameIndex = 0; frameIndex < envelopeLength; frameIndex += 1) {
    const start = frameIndex * hopSize;
    const end = Math.min(samples.length, start + frameSize);
    let rmsSum = 0;
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = samples[sampleIndex] ?? 0;
      const absValue = Math.abs(value);
      peak = Math.max(peak, absValue);
      rmsSum += value * value;
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(rmsSum / count);
    envelope[frameIndex] = peak * 0.55 + rms * 0.85;
  }

  const smoothed = new Float32Array(envelopeLength);
  for (let index = 0; index < envelopeLength; index += 1) {
    const previous = envelope[Math.max(0, index - 1)] ?? envelope[index] ?? 0;
    const current = envelope[index] ?? 0;
    const next = envelope[Math.min(envelopeLength - 1, index + 1)] ?? current;
    smoothed[index] = previous * 0.25 + current * 0.5 + next * 0.25;
  }

  let averageLevel = 0;
  const positiveDiffs: number[] = [];
  for (let index = 0; index < smoothed.length; index += 1) {
    averageLevel += smoothed[index] ?? 0;
    if (index === 0) {
      continue;
    }
    const diff = (smoothed[index] ?? 0) - (smoothed[index - 1] ?? 0);
    if (diff > 0) {
      positiveDiffs.push(diff);
    }
  }
  averageLevel /= Math.max(smoothed.length, 1);
  const averagePositiveDiff = positiveDiffs.length > 0
    ? positiveDiffs.reduce((sum, value) => sum + value, 0) / positiveDiffs.length
    : 0;
  const onsetThreshold = Math.max(averagePositiveDiff * 1.8, averageLevel * 0.18, 0.01);
  const levelThreshold = Math.max(averageLevel * 0.6, 0.025);
  const keypoints: number[] = [];

  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const current = smoothed[index] ?? 0;
    const previous = smoothed[index - 1] ?? 0;
    const next = smoothed[index + 1] ?? 0;
    const diff = current - previous;
    if (current < levelThreshold || diff < onsetThreshold || current < next) {
      continue;
    }

    const time = Math.min(duration, (index * hopSize) / sampleRate);
    const previousTime = keypoints[keypoints.length - 1];
    if (previousTime !== undefined && time - previousTime < WAVEFORM_KEYPOINT_MIN_SPACING_SECONDS) {
      continue;
    }
    keypoints.push(time);
    if (keypoints.length >= WAVEFORM_KEYPOINT_MAX_COUNT) {
      break;
    }
  }

  return keypoints;
}

export default App;
