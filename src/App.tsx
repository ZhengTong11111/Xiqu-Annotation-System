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

function App() {
  const [project, setProject] = useState<ProjectData>(mockProject);
  const [currentTime, setCurrentTime] = useState(12.4);
  const [duration, setDuration] = useState(getProjectDuration(mockProject));
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({
    type: "line",
    id: "line-1",
  });
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [undoStack, setUndoStack] = useState<ProjectData[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectData[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const projectRef = useRef(project);
  const transientProjectRef = useRef<ProjectData | null>(null);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);

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

  function applyUndoStackState(nextUndoStack: ProjectData[]) {
    undoStackRef.current = nextUndoStack;
    setUndoStack(nextUndoStack);
  }

  function applyRedoStackState(nextRedoStack: ProjectData[]) {
    redoStackRef.current = nextRedoStack;
    setRedoStack(nextRedoStack);
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
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedItem?.type === "character" || selectedItem?.type === "action") {
          event.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentTime, selectedItem, undoStack, redoStack, project]);

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
    return project.characterAnnotations.filter((item) => item.lineId === selectedLineId);
  }, [project.characterAnnotations, selectedLineId]);

  function projectsEqual(left: ProjectData, right: ProjectData) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function commitProject(nextProject: ProjectData, baseProject = transientProjectRef.current ?? projectRef.current) {
    if (projectsEqual(baseProject, nextProject)) {
      transientProjectRef.current = null;
      applyProjectState(nextProject);
      return;
    }
    applyUndoStackState([...undoStackRef.current.slice(-49), baseProject]);
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
    setCurrentTime(safeTime);
    if (videoRef.current) {
      videoRef.current.currentTime = safeTime;
    }
  }

  function togglePlay() {
    if (!videoRef.current) {
      return;
    }
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  }

  function updateCharacter(id: string, changes: Partial<CharacterAnnotation>, recordHistory = true) {
    const currentProject = projectRef.current;
    const nextProject = {
      ...currentProject,
      characterAnnotations: currentProject.characterAnnotations.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    };
    if (recordHistory) {
      commitProject(nextProject);
    } else {
      applyProjectWithoutHistory(nextProject);
    }
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

  function deleteSelected() {
    const currentProject = projectRef.current;
    if (!selectedItem) {
      return;
    }
    if (selectedItem.type === "character") {
      commitProject({
        ...currentProject,
        characterAnnotations: currentProject.characterAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      setSelectedItem(null);
    }
    if (selectedItem.type === "action") {
      commitProject({
        ...currentProject,
        actionAnnotations: currentProject.actionAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      setSelectedItem(null);
    }
  }

  function addAction(trackId: "hand-action" | "body-action") {
    const currentProject = projectRef.current;
    const startTime = currentTime;
    const endTime = Math.min(duration, startTime + 0.8);
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
    const previous = currentUndoStack[currentUndoStack.length - 1];
    if (!previous) {
      return;
    }
    applyRedoStackState([...redoStackRef.current, projectRef.current]);
    applyUndoStackState(currentUndoStack.slice(0, -1));
    applyProjectState(previous);
  }

  function redo() {
    const currentRedoStack = redoStackRef.current;
    const next = currentRedoStack[currentRedoStack.length - 1];
    if (!next) {
      return;
    }
    applyUndoStackState([...undoStackRef.current, projectRef.current]);
    applyRedoStackState(currentRedoStack.slice(0, -1));
    applyProjectState(next);
  }

  async function importSrtFile(file: File) {
    const text = await file.text();
    const lines = parseSrt(text);
    const nextProject = buildProjectFromLines(lines, projectRef.current.videoUrl);
    commitProject(nextProject);
    setSelectedItem(lines[0] ? { type: "line", id: lines[0].id } : null);
    if (lines[0]) {
      seekTo(lines[0].startTime);
    }
  }

  async function handleVideoImport(file: File) {
    const url = URL.createObjectURL(file);
    commitProject({ ...projectRef.current, videoUrl: url });
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
            currentTime={currentTime}
            selectedItem={selectedItem}
            zoom={zoom}
            duration={duration}
            focusRange={focusRange}
            getProjectSnapshot={() => projectRef.current}
            onZoomChange={setZoom}
            onSeek={seekTo}
            onSelectItem={setSelectedItem}
            onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
            onCharacterCommit={(id, changes) => updateCharacter(id, changes, true)}
            onActionChange={(id, changes) => updateAction(id, changes, false)}
            onActionCommit={(id, changes) => updateAction(id, changes, true)}
            onCreateAction={createAction}
          />
        </div>

        <div className="side-column">
          <SubtitleList
            subtitleLines={project.subtitleLines}
            currentTime={currentTime}
            selectedLineId={selectedLineId}
            onSelectLine={(lineId) => {
              setSelectedItem({ type: "line", id: lineId });
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
              {activeCharacters.map((item) => (
                <button
                  key={item.id}
                  className={[
                    "character-chip",
                    selectedItem?.type === "character" && selectedItem.id === item.id ? "selected" : "",
                    currentTime >= item.startTime && currentTime <= item.endTime ? "active" : "",
                  ].join(" ")}
                  onClick={() => setSelectedItem({ type: "character", id: item.id })}
                >
                  <span>{item.char}</span>
                  <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                </button>
              ))}
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

export default App;
