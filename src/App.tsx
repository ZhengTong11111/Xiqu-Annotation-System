import { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import { InspectorPanel } from "./components/InspectorPanel";
import { SubtitleList } from "./components/SubtitleList";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { VideoPlayer } from "./components/VideoPlayer";
import { mockProject } from "./mockData";
import type {
  ActionAnnotation,
  CharacterAnnotation,
  ProjectData,
  SelectedItem,
  SubtitleLine,
  TimelineBatchMoveItem,
  TimelineSelectionItem,
  WaveformData,
} from "./types";
import {
  buildProjectFromLines,
  getProjectDuration,
  trackDefinitions,
} from "./utils/project";
import {
  exportActionTrackToSrt,
  exportCharacterTrackToSrt,
  exportSingingStyleTrackToSrt,
  parseSrt,
} from "./utils/srt";

type HistoryAction = "edit" | "import-video" | "import-srt";

type HistoryEntry = {
  project: ProjectData;
  action: HistoryAction;
};

type CharacterEditLocation = "timeline" | "split-panel";
type CharacterLineAction = "set-line-start" | "set-line-end" | "merge-prev-line" | "merge-next-line";

const CHARACTER_CREATE_ATTACH_WINDOW = 1;
const DEFAULT_CHARACTER_DURATION = 1.05;
const MIN_CHARACTER_DURATION = 0.04;
const DEFAULT_ACTION_DURATION = 0.8;

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
  const [characterContextMenu, setCharacterContextMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const projectRef = useRef(project);
  const transientProjectRef = useRef<ProjectData | null>(null);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const waveformRequestIdRef = useRef(0);
  const preferredCharacterEditLocationRef = useRef<CharacterEditLocation>("timeline");

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);

  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);

  function applyProjectState(nextProject: ProjectData) {
    projectRef.current = nextProject;
    setProject(nextProject);
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
    setSelectedTimelineItems([]);
  }

  const selectedLineId = selectedItem?.type === "line"
    ? selectedItem.id
    : selectedItem?.type === "character"
      ? project.characterAnnotations.find((item) => item.id === selectedItem.id)?.lineId ?? null
      : null;

  const focusRange = useMemo(() => {
    if (selectedItem?.type !== "line") {
      return null;
    }
    const focusedLineId = selectedItem.id;
    if (!focusedLineId) {
      return null;
    }
    const line = project.subtitleLines.find((item) => item.id === focusedLineId);
    if (!line) {
      return null;
    }
    return {
      start: Math.max(0, line.startTime - 1.5),
      end: line.endTime + 1.5,
    };
  }, [project.subtitleLines, selectedItem]);

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
    const videoUrl = project.videoUrl;
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
  }, [project.videoUrl]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
      if (event.key === "Enter" && selectedItem?.type === "character" && !editingCharacterId) {
        event.preventDefault();
        startCharacterTextEdit(selectedItem.id, preferredCharacterEditLocationRef.current);
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
          selectedItem?.type === "action"
        ) {
          event.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentTime, editingCharacterId, previewTime, selectedItem, selectedTimelineItems, undoStack, redoStack, project]);

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
    if (!characterContextMenu) {
      return;
    }

    const handleClose = () => {
      setCharacterContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCharacterContextMenu(null);
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
  }, [characterContextMenu]);

  function projectsEqual(left: ProjectData, right: ProjectData) {
    return JSON.stringify(left) === JSON.stringify(right);
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
    const safeStartTime = Math.max(0, startTime);
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: trackId === "hand-action" ? "抬手" : "转身",
          startTime: safeStartTime,
          endTime: safeStartTime + DEFAULT_ACTION_DURATION,
        },
      ],
    });
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
        },
        Array.from(affectedLineIds),
      );

      if (editingCharacterId && characterIds.has(editingCharacterId)) {
        cancelCharacterTextEdit();
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
  }

  function selectAllTimelineItems() {
    const currentProject = projectRef.current;
    const items: TimelineSelectionItem[] = [
      ...currentProject.characterAnnotations.map((item) => ({ type: "character" as const, id: item.id })),
      ...currentProject.actionAnnotations.map((item) => ({ type: "action" as const, id: item.id })),
    ];
    applySelection(items[0] ?? null, items);
  }

  function addAction(trackId: "hand-action" | "body-action") {
    const currentProject = projectRef.current;
    const startTime = currentTime;
    const endTime = Math.min(duration, startTime + DEFAULT_ACTION_DURATION);
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: trackId === "hand-action" ? "抬手" : "转身",
          startTime,
          endTime,
        },
      ],
    });
  }

  function createAction(trackId: string, startTime: number, endTime: number) {
    const currentProject = projectRef.current;
    commitProject({
      ...currentProject,
      actionAnnotations: [
        ...currentProject.actionAnnotations,
        {
          id: `${trackId}-${crypto.randomUUID()}`,
          trackId,
          label: trackId === "hand-action" ? "抬手" : "转身",
          startTime,
          endTime,
        },
      ],
    });
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
    const nextProject = buildProjectFromLines(lines, projectRef.current.videoUrl);
    commitProject(nextProject, undefined, "import-srt");
    applySelection(lines[0] ? { type: "line", id: lines[0].id } : null);
    if (lines[0]) {
      seekTo(lines[0].startTime);
    }
  }

  async function handleVideoImport(file: File) {
    const url = URL.createObjectURL(file);
    commitProject({ ...projectRef.current, videoUrl: url }, undefined, "import-video");
  }

  function handleExport(kind: "character" | "singing" | "hand" | "body" | "project") {
    if (kind === "project") {
      downloadBlob(
        JSON.stringify(project, null, 2),
        "project_data.json",
        "application/json",
      );
      return;
    }

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
        onTogglePlay={togglePlay}
        onStep={(delta) => seekTo(currentTime + delta)}
        onPlaybackRateChange={setPlaybackRate}
        onVideoFileChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
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
        onExportTrack={handleExport}
        onUndo={undo}
        onRedo={redo}
        onAddAction={addAction}
      />

      <main className="workspace-grid">
        <div className="main-column">
          <VideoPlayer
            ref={videoRef}
            videoUrl={project.videoUrl}
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
            trackDefinitions={trackDefinitions}
            waveformData={waveformData}
            isWaveformLoading={isWaveformLoading}
            currentTime={currentTime}
            selectedItem={selectedItem}
            selectedTimelineItems={selectedTimelineItems}
            zoom={zoom}
            duration={duration}
            focusRange={focusRange}
            getProjectSnapshot={() => projectRef.current}
            onZoomChange={setZoom}
            onSeek={seekTo}
            onPreviewFrame={setPreviewTime}
            onSelectItem={(item) => {
              if (item?.type === "character") {
                preferredCharacterEditLocationRef.current = "timeline";
              }
              applySelection(item);
            }}
            onSelectTimelineItems={(items, primaryItem) => {
              if (primaryItem?.type === "character") {
                preferredCharacterEditLocationRef.current = "timeline";
              }
              applySelection(primaryItem, items);
            }}
            editingCharacterId={editingCharacterId}
            editingCharacterLocation={editingCharacterLocation}
            editingCharacterValue={editingCharacterValue}
            onEditingCharacterValueChange={setEditingCharacterValue}
            onCommitCharacterTextEdit={commitCharacterTextEdit}
            onCancelCharacterTextEdit={cancelCharacterTextEdit}
            onEditCharacterText={(id) => startCharacterTextEdit(id, "timeline")}
            onCreateCharacterAtTime={createCharacterAtTime}
            onCreateActionAtTime={createActionAtTime}
            onOpenCharacterContextMenu={(id, x, y) => {
              preferredCharacterEditLocationRef.current = "timeline";
              applySelection({ type: "character", id });
              setCharacterContextMenu({ id, x, y });
            }}
            onLineChange={(id, changes) => updateLinePosition(id, changes, false)}
            onLineCommit={(id, changes) => updateLinePosition(id, changes, true)}
            onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
            onCharacterCommit={(id, changes) => updateCharacter(id, changes, true)}
            onActionChange={(id, changes) => updateAction(id, changes, false)}
            onActionCommit={(id, changes) => updateAction(id, changes, true)}
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
                      setCharacterContextMenu({
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
            trackDefinitions={trackDefinitions}
            onCharacterUpdate={updateCharacter}
            onActionUpdate={updateAction}
            onDeleteSelected={deleteSelected}
          />
        </div>
      </main>
      {characterContextMenu ? (
        <div
          className="character-context-menu"
          style={{ left: characterContextMenu.x, top: characterContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              applyCharacterLineAction(characterContextMenu.id, "set-line-start");
              setCharacterContextMenu(null);
            }}
          >
            设为本句首字
          </button>
          <button
            type="button"
            onClick={() => {
              applyCharacterLineAction(characterContextMenu.id, "set-line-end");
              setCharacterContextMenu(null);
            }}
          >
            设为本句末字
          </button>
          <button
            type="button"
            onClick={() => {
              applyCharacterLineAction(characterContextMenu.id, "merge-prev-line");
              setCharacterContextMenu(null);
            }}
          >
            并入前一句
          </button>
          <button
            type="button"
            onClick={() => {
              applyCharacterLineAction(characterContextMenu.id, "merge-next-line");
              setCharacterContextMenu(null);
            }}
          >
            并入后一句
          </button>
        </div>
      ) : null}
    </div>
  );
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

function requiresUndoConfirmation(action: HistoryAction) {
  return action === "import-video" || action === "import-srt";
}

function getUndoConfirmationMessage(action: HistoryAction) {
  if (action === "import-video") {
    return "确定要撤销导入视频吗？当前视频将从项目中移除。";
  }
  if (action === "import-srt") {
    return "确定要撤销导入句级字幕吗？当前导入的字幕与逐字结果将回退到上一步状态。";
  }
  return "确定要执行撤销吗？";
}

function isSingleHanCharacter(value: string) {
  return /^[\p{Script=Han}]$/u.test(value);
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
