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

  const selectedLineId = selectedItem?.type === "line"
    ? selectedItem.id
    : selectedItem?.type === "character"
      ? project.characterAnnotations.find((item) => item.id === selectedItem.id)?.lineId ?? null
      : null;

  const focusRange = useMemo(() => {
    if (!selectedLineId) {
      return null;
    }
    const line = project.subtitleLines.find((item) => item.id === selectedLineId);
    if (!line) {
      return null;
    }
    return {
      start: Math.max(0, line.startTime - 1.5),
      end: line.endTime + 1.5,
    };
  }, [project.subtitleLines, selectedLineId]);

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
  }, [currentTime, selectedItem, undoStack, redoStack]);

  const activeCharacters = useMemo(() => {
    if (!selectedLineId) {
      return [];
    }
    return project.characterAnnotations.filter((item) => item.lineId === selectedLineId);
  }, [project.characterAnnotations, selectedLineId]);

  function commitProject(nextProject: ProjectData) {
    setUndoStack((prev) => [...prev.slice(-49), project]);
    setRedoStack([]);
    setProject(nextProject);
  }

  function applyProjectWithoutHistory(nextProject: ProjectData) {
    setProject(nextProject);
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
    const nextProject = {
      ...project,
      characterAnnotations: project.characterAnnotations.map((item) =>
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
    const nextProject = {
      ...project,
      actionAnnotations: project.actionAnnotations.map((item) =>
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
    if (!selectedItem) {
      return;
    }
    if (selectedItem.type === "character") {
      commitProject({
        ...project,
        characterAnnotations: project.characterAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      setSelectedItem(null);
    }
    if (selectedItem.type === "action") {
      commitProject({
        ...project,
        actionAnnotations: project.actionAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      setSelectedItem(null);
    }
  }

  function addAction(trackId: "hand-action" | "body-action") {
    const startTime = currentTime;
    const endTime = Math.min(duration, startTime + 0.8);
    commitProject({
      ...project,
      actionAnnotations: [
        ...project.actionAnnotations,
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
    commitProject({
      ...project,
      actionAnnotations: [
        ...project.actionAnnotations,
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
    const previous = undoStack[undoStack.length - 1];
    if (!previous) {
      return;
    }
    setRedoStack((prev) => [...prev, project]);
    setUndoStack((prev) => prev.slice(0, -1));
    setProject(previous);
  }

  function redo() {
    const next = redoStack[redoStack.length - 1];
    if (!next) {
      return;
    }
    setUndoStack((prev) => [...prev, project]);
    setRedoStack((prev) => prev.slice(0, -1));
    setProject(next);
  }

  async function importSrtFile(file: File) {
    const text = await file.text();
    const lines = parseSrt(text);
    const nextProject = buildProjectFromLines(lines, project.videoUrl);
    commitProject(nextProject);
    setSelectedItem(lines[0] ? { type: "line", id: lines[0].id } : null);
    if (lines[0]) {
      seekTo(lines[0].startTime);
    }
  }

  async function handleVideoImport(file: File) {
    const url = URL.createObjectURL(file);
    commitProject({ ...project, videoUrl: url });
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
        zoom={zoom}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onTogglePlay={togglePlay}
        onStep={(delta) => seekTo(currentTime + delta)}
        onPlaybackRateChange={setPlaybackRate}
        onZoomChange={setZoom}
        onVideoFileChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleVideoImport(file);
          }
        }}
        onSrtFileChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importSrtFile(file);
          }
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
            onSeek={seekTo}
            onSelectItem={setSelectedItem}
            onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
            onActionChange={(id, changes) => updateAction(id, changes, false)}
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
