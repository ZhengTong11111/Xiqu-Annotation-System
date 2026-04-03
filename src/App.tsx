import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import { InspectorPanel } from "./components/InspectorPanel";
import { SubtitleList } from "./components/SubtitleList";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { VideoPlayer } from "./components/VideoPlayer";
import { mockProject } from "./mockData";
import type {
  ActionAnnotation,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  CustomTrackType,
  ProjectData,
  ResolvedCustomTrackBlock,
  SavedProjectFile,
  SelectedItem,
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

type HistoryAction = "edit" | "import-video" | "import-srt" | "import-project";

type HistoryEntry = {
  project: ProjectData;
  action: HistoryAction;
};

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

const CHARACTER_CREATE_ATTACH_WINDOW = 1;
const DEFAULT_CHARACTER_DURATION = 1.05;
const MIN_CHARACTER_DURATION = 0.04;
const DEFAULT_ACTION_DURATION = 0.8;
const DEFAULT_CUSTOM_TEXT = "新标注";
const CONTEXT_MENU_GAP = 10;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;
const PROJECT_FILE_VERSION = 2;
const comparableProjectSignatureCache = new WeakMap<ProjectData, string>();
const trackSnapSignatureCache = new WeakMap<Record<string, boolean>, string>();

function App() {
  const [project, setProject] = useState<ProjectData>(mockProject);
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
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingCharacterLocation, setEditingCharacterLocation] = useState<CharacterEditLocation | null>(null);
  const [editingCharacterValue, setEditingCharacterValue] = useState("");
  const [editingCustomTextBlock, setEditingCustomTextBlock] = useState<{
    trackId: string;
    id: string;
  } | null>(null);
  const [editingCustomTextValue, setEditingCustomTextValue] = useState("");
  const [blockContextMenu, setBlockContextMenu] = useState<{
    type: "character" | "action" | "custom-block";
    id: string;
    trackId?: string;
    x: number;
    y: number;
  } | null>(null);
  const [zoom, setZoom] = useState(20);
  const [lineFocusRequest, setLineFocusRequest] = useState<LineFocusRequest | null>(null);
  const [trackSnapEnabled, setTrackSnapEnabled] = useState<Record<string, boolean>>(
    () => getDefaultTrackSnapEnabled(mockProject),
  );
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [manualVideoRelinkPrompt, setManualVideoRelinkPrompt] = useState<ProjectData["video"] | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  const savedProjectRef = useRef(project);
  const transientProjectRef = useRef<ProjectData | null>(null);
  const trackSnapEnabledRef = useRef(trackSnapEnabled);
  const savedTrackSnapEnabledRef = useRef(trackSnapEnabled);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const waveformRequestIdRef = useRef(0);
  const preferredCharacterEditLocationRef = useRef<CharacterEditLocation>("timeline");
  const blockContextMenuRef = useRef<HTMLDivElement>(null);
  const [blockContextMenuPosition, setBlockContextMenuPosition] = useState<{ left: number; top: number } | null>(null);
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

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);

  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);

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
      applyTrackSnapEnabledState(nextTrackSnapState);
    }
  }, [timelineTrackDefinitions]);

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

  function syncHasUnsavedChanges(
    nextProject = projectRef.current,
    nextTrackSnapState = trackSnapEnabledRef.current,
  ) {
    setHasUnsavedChanges(
      !projectsEqual(savedProjectRef.current, nextProject) ||
      !trackSnapStatesEqual(savedTrackSnapEnabledRef.current, nextTrackSnapState),
    );
  }

  function applyProjectState(nextProject: ProjectData) {
    projectRef.current = nextProject;
    setProject(nextProject);
    syncHasUnsavedChanges(nextProject, trackSnapEnabledRef.current);
  }

  function applyTrackSnapEnabledState(nextTrackSnapState: Record<string, boolean>) {
    trackSnapEnabledRef.current = nextTrackSnapState;
    setTrackSnapEnabled(nextTrackSnapState);
    syncHasUnsavedChanges(projectRef.current, nextTrackSnapState);
  }

  function markProjectAsSaved(
    projectToSave = projectRef.current,
    trackSnapState = trackSnapEnabledRef.current,
  ) {
    savedProjectRef.current = projectToSave;
    savedTrackSnapEnabledRef.current = trackSnapState;
    setHasUnsavedChanges(false);
  }

  function applyUndoStackState(nextUndoStack: HistoryEntry[]) {
    undoStackRef.current = nextUndoStack;
    setUndoStack(nextUndoStack);
  }

  function applyRedoStackState(nextRedoStack: HistoryEntry[]) {
    redoStackRef.current = nextRedoStack;
    setRedoStack(nextRedoStack);
  }

  function applySelection(nextSelectedItem: SelectedItem, timelineItems?: TimelineSelectionItem[]) {
    setSelectedItem(nextSelectedItem);
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
    setSelectedTimelineItems([]);
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
    const videoUrl = project.video.url;
    const requestId = waveformRequestIdRef.current + 1;
    waveformRequestIdRef.current = requestId;

    if (!videoUrl) {
      setWaveformData(null);
      setIsWaveformLoading(false);
      return;
    }

    let cancelled = false;
    setIsWaveformLoading(true);

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

  function commitProject(
    nextProject: ProjectData,
    baseProject = transientProjectRef.current ?? projectRef.current,
    action: HistoryAction = "edit",
  ) {
    if (projectsEqual(baseProject, nextProject)) {
      transientProjectRef.current = null;
      applyProjectState(nextProject);
      return;
    }
    applyUndoStackState([...undoStackRef.current.slice(-49), { project: baseProject, action }]);
    applyRedoStackState([]);
    transientProjectRef.current = null;
    applyProjectState(nextProject);
  }

  function applyProjectWithoutHistory(nextProject: ProjectData) {
    if (projectsEqual(projectRef.current, nextProject)) {
      return;
    }
    if (!transientProjectRef.current) {
      transientProjectRef.current = projectRef.current;
    }
    applyProjectState(nextProject);
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
    if (previewTime !== null) {
      videoRef.current.currentTime = currentTime;
      setPreviewTime(null);
    }
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
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
      customTracks: currentProject.customTracks.map((track) => ({
        ...track,
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
    const affectedCount = affectedCharacterCount + affectedActionCount;
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
      if (selectedItem?.type === "character" || (selectedItem?.type === "builtin-track" && selectedItem.id === trackId)) {
        applySelection(null);
      } else {
        setSelectedTimelineItems((current) => current.filter((item) => item.type !== "character"));
      }
    } else {
      if (selectedItem?.type === "builtin-track" && selectedItem.id === trackId) {
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
        }
      : {
          id: `custom-track-${crypto.randomUUID()}`,
          name: getDefaultCustomTrackName(currentProject.customTracks, trackType),
          trackType,
          typeOptions: getDefaultCustomTrackTypeOptions(),
          blocks: [],
        };

    commitProject({
      ...currentProject,
      customTracks: [...currentProject.customTracks, nextTrack] as CustomTrack[],
      activeTrackOrder: [...currentProject.activeTrackOrder, nextTrack.id],
    });
    applySelection({ type: "custom-track", id: nextTrack.id });
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
        : selectedItem?.type === "custom-block"
          ? [{ type: "custom-block", id: selectedItem.id, trackId: selectedItem.trackId }]
        : [];

    if (timelineSelection.length > 0) {
      if (timelineSelection.length > 10) {
        const confirmed = window.confirm(`当前将删除 ${timelineSelection.length} 个已选中的字块/动作块。是否继续？`);
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
          customTracks: currentProject.customTracks.map((track) => ({
            ...track,
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

  function deleteCustomTrack(trackId: string) {
    const currentProject = projectRef.current;
    const track = currentProject.customTracks.find((item) => item.id === trackId);
    if (!track) {
      return;
    }
    const blockCount = track.blocks.length;
    const confirmed = window.confirm(
      `确定要删除轨道“${track.name}”吗？` +
        `\n删除轨道会同时删除轨道上的全部标注` +
        (blockCount > 0 ? `（当前共 ${blockCount} 条）` : "") +
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
      (selectedItem?.type === "custom-block" && selectedItem.trackId === trackId)
    ) {
      applySelection(null);
    }
  }

  function undo() {
    if (transientProjectRef.current) {
      const transientProject = transientProjectRef.current;
      transientProjectRef.current = null;
      if (!projectsEqual(projectRef.current, transientProject)) {
        applyProjectState(transientProject);
      }
      return;
    }
    const currentUndoStack = undoStackRef.current;
    const previousEntry = currentUndoStack[currentUndoStack.length - 1];
    if (!previousEntry) {
      return;
    }
    if (requiresUndoConfirmation(previousEntry.action)) {
      const confirmed = window.confirm(getUndoConfirmationMessage(previousEntry.action));
      if (!confirmed) {
        return;
      }
    }
    applyRedoStackState([...redoStackRef.current, { project: projectRef.current, action: previousEntry.action }]);
    applyUndoStackState(currentUndoStack.slice(0, -1));
    applyProjectState(previousEntry.project);
  }

  function redo() {
    const currentRedoStack = redoStackRef.current;
    const nextEntry = currentRedoStack[currentRedoStack.length - 1];
    if (!nextEntry) {
      return;
    }
    applyUndoStackState([...undoStackRef.current, { project: projectRef.current, action: nextEntry.action }]);
    applyRedoStackState(currentRedoStack.slice(0, -1));
    applyProjectState(nextEntry.project);
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
      if (shouldManuallyImportVideo) {
        setManualVideoRelinkPrompt(hydratedProject.video);
      } else {
        setManualVideoRelinkPrompt(null);
      }
    } catch {
      window.alert("导入项目失败。请选择由本工具导出的项目 JSON，或检查文件内容是否完整。");
    }
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
      },
    };
    downloadBlob(
      JSON.stringify(savePayload, null, 2),
      getProjectFileName(projectToSave),
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

  return (
    <div className="app-shell">
      <Toolbar
        isPlaying={isPlaying}
        playbackRate={playbackRate}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        activeBuiltinTrackIds={Array.from(activeBuiltinTrackIds)}
        onTogglePlay={togglePlay}
        onStep={(delta) => seekTo(currentTime + delta)}
        onPlaybackRateChange={setPlaybackRate}
        videoFileInputRef={videoFileInputRef}
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
        onSaveProject={() => {
          void saveProjectFile();
        }}
        onExportTrack={handleExport}
        onUndo={undo}
        onRedo={redo}
        onAddAction={addAction}
      />

      <main className="workspace-grid">
        <div className="main-column">
          <VideoPlayer
            ref={videoRef}
            videoUrl={project.video.url}
            playbackRate={playbackRate}
            currentTime={currentTime}
            previewTime={previewTime}
            isPlaying={isPlaying}
            onLoadedMetadata={(nextDuration) => setDuration(Math.max(nextDuration, getProjectDuration(project)))}
            onTimeUpdate={setCurrentTime}
            onPlayStateChange={setIsPlaying}
          />
          <Timeline
            subtitleLines={project.subtitleLines}
            characterAnnotations={project.characterAnnotations}
            actionAnnotations={project.actionAnnotations}
            customTracks={project.customTracks}
            trackDefinitions={timelineTrackDefinitions}
            missingBuiltinTracks={missingBuiltinTracks}
            waveformData={waveformData}
            isWaveformLoading={isWaveformLoading}
            currentTime={currentTime}
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
            onSeek={seekTo}
            onPreviewFrame={setPreviewTime}
            onSelectItem={(item) => {
              setLineFocusRequest(null);
              if (item?.type === "character") {
                preferredCharacterEditLocationRef.current = "timeline";
              }
              applySelection(item);
            }}
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
            onDeleteBuiltinTrack={deleteBuiltinTrack}
            onDeleteCustomTrack={deleteCustomTrack}
            onOpenCharacterContextMenu={(id, x, y) => {
              preferredCharacterEditLocationRef.current = "timeline";
              applySelection({ type: "character", id });
              setBlockContextMenu({ type: "character", id, x, y });
            }}
            onOpenActionContextMenu={(id, x, y) => {
              applySelection({ type: "action", id });
              setBlockContextMenu({ type: "action", id, x, y });
            }}
            onOpenCustomBlockContextMenu={(trackId, id, x, y) => {
              applySelection({ type: "custom-block", trackId, id });
              setBlockContextMenu({ type: "custom-block", trackId, id, x, y });
            }}
            onLineChange={(id, changes) => updateLinePosition(id, changes, false)}
            onLineCommit={(id, changes) => updateLinePosition(id, changes, true)}
            onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
            onCharacterCommit={(id, changes) => updateCharacter(id, changes, true)}
            onActionChange={(id, changes) => updateAction(id, changes, false)}
            onActionCommit={(id, changes) => updateAction(id, changes, true)}
            onCustomBlockChange={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, false)}
            onCustomBlockCommit={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, true)}
            onBatchMoveChange={(items) => updateTimelineSelectionBatch(items, false)}
            onBatchMoveCommit={(items) => updateTimelineSelectionBatch(items, true)}
            onCreateAction={createAction}
          />
        </div>

        <div className="side-column">
          <SubtitleList
            subtitleLines={project.subtitleLines}
            currentTime={currentTime}
            selectedLineId={selectedLineId}
            onSelectLine={(lineId) => {
              setLineFocusRequest({ lineId, requestId: Date.now() });
              applySelection({ type: "line", id: lineId });
              const line = project.subtitleLines.find((item) => item.id === lineId);
              if (line) {
                seekTo(line.startTime);
              }
            }}
          />

          <section className="panel split-panel">
            <div className="panel-header">
              <h2>当前句逐字拆分</h2>
              <span>{activeCharacters.length} 字</span>
            </div>
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
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <span>{item.char}</span>
                    <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <InspectorPanel
            selectedItem={selectedItem}
            subtitleLines={project.subtitleLines}
            characterAnnotations={project.characterAnnotations}
            actionAnnotations={project.actionAnnotations}
            builtinTracks={project.builtinTracks}
            customTracks={project.customTracks}
            trackDefinitions={timelineTrackDefinitions}
            onCharacterUpdate={updateCharacter}
            onActionUpdate={updateAction}
            onBuiltinTrackRename={renameBuiltinTrack}
            onBuiltinTrackTypeOptionChange={updateBuiltinTrackTypeOption}
            onAddBuiltinTrackTypeOption={addBuiltinTrackTypeOption}
            onMoveBuiltinTrackTypeOption={moveBuiltinTrackTypeOption}
            onReorderBuiltinTrackTypeOption={reorderBuiltinTrackTypeOption}
            onRemoveBuiltinTrackTypeOption={removeBuiltinTrackTypeOption}
            onDeleteBuiltinTrack={deleteBuiltinTrack}
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
        </div>
      </main>
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
          {contextMenuCharacter ? (
            <>
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
    </div>
  );
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
  return action === "import-video" || action === "import-srt" || action === "import-project";
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

function getProjectFileName(project: ProjectData) {
  const baseName = (project.video.name ?? "xiqu_annotation_project").replace(/\.[^.]+$/, "");
  return `${baseName || "xiqu_annotation_project"}.annotation.json`;
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
  return {
    video: normalizeProjectVideo(value),
    subtitleLines: Array.isArray(value.subtitleLines) ? value.subtitleLines : [],
    characterAnnotations: Array.isArray(value.characterAnnotations) ? value.characterAnnotations : [],
    actionAnnotations: Array.isArray(value.actionAnnotations) ? value.actionAnnotations : [],
    builtinTracks,
    customTracks: Array.isArray(value.customTracks) ? value.customTracks : [],
    activeTrackOrder: normalizeActiveTrackOrder(
      value.activeTrackOrder,
      builtinTracks,
      Array.isArray(value.customTracks) ? value.customTracks : [],
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
    }];
  });
  return tracks.length > 0 ? tracks : getDefaultBuiltinTracks();
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

export default App;
