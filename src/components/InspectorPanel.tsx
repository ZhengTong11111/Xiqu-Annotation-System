import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  CharacterAnnotation,
  CustomTrack,
  SelectedItem,
  SubtitleLine,
  TrackDefinition,
} from "../types";
import { singingStyleOptions } from "../utils/project";

const REORDER_ACTIVATION_PX = 6;

type InspectorPanelProps = {
  selectedItem: SelectedItem;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onCustomTrackRename: (trackId: string, name: string) => void;
  onCustomTrackTypeOptionChange: (trackId: string, index: number, value: string) => void;
  onAddCustomTrackTypeOption: (trackId: string) => void;
  onMoveCustomTrackTypeOption: (trackId: string, index: number, direction: "up" | "down") => void;
  onReorderCustomTrackTypeOption: (trackId: string, fromIndex: number, toIndex: number) => void;
  onRemoveCustomTrackTypeOption: (trackId: string, index: number) => void;
  onDeleteCustomTrack: (trackId: string) => void;
  onCustomBlockUpdate: (
    trackId: string,
    blockId: string,
    changes: {
      startTime?: number;
      endTime?: number;
      text?: string;
      type?: string;
    },
  ) => void;
  onDeleteSelected: () => void;
};

export function InspectorPanel({
  selectedItem,
  subtitleLines,
  characterAnnotations,
  actionAnnotations,
  customTracks,
  trackDefinitions,
  onCharacterUpdate,
  onActionUpdate,
  onCustomTrackRename,
  onCustomTrackTypeOptionChange,
  onAddCustomTrackTypeOption,
  onMoveCustomTrackTypeOption,
  onReorderCustomTrackTypeOption,
  onRemoveCustomTrackTypeOption,
  onDeleteCustomTrack,
  onCustomBlockUpdate,
  onDeleteSelected,
}: InspectorPanelProps) {
  const [draggedOptionIndex, setDraggedOptionIndex] = useState<number | null>(null);
  const [optionDropInsertionIndex, setOptionDropInsertionIndex] = useState<number | null>(null);
  const [recentlyMovedOptionIndex, setRecentlyMovedOptionIndex] = useState<number | null>(null);
  const [optionReorderDrag, setOptionReorderDrag] = useState<{
    index: number;
    startY: number;
    currentY: number;
  } | null>(null);
  const moveOptionHighlightTimerRef = useRef<number | null>(null);
  const draggedOptionIndexRef = useRef<number | null>(null);
  const optionRowRefs = useRef(new Map<string, HTMLDivElement>());
  const previousOptionRowPositionsRef = useRef(new Map<string, number>());
  const previousTypeOptionKeysRef = useRef<string[]>([]);
  const selectedCustomTrack = selectedItem?.type === "custom-track"
    ? customTracks.find((item) => item.id === selectedItem.id) ?? null
    : null;
  const typeOptionKeys = useMemo(
    () => buildTypeOptionKeys(selectedCustomTrack?.typeOptions ?? []),
    [selectedCustomTrack?.typeOptions],
  );
  const remainingTypeOptionKeys = useMemo(
    () => typeOptionKeys.filter((_, index) => index !== draggedOptionIndex),
    [draggedOptionIndex, typeOptionKeys],
  );
  const optionDropBeforeKey = optionDropInsertionIndex !== null &&
    optionDropInsertionIndex < remainingTypeOptionKeys.length
    ? remainingTypeOptionKeys[optionDropInsertionIndex]
    : null;
  const optionDropAfterKey = optionDropInsertionIndex !== null &&
    optionDropInsertionIndex === remainingTypeOptionKeys.length &&
    remainingTypeOptionKeys.length > 0
    ? remainingTypeOptionKeys[remainingTypeOptionKeys.length - 1]
    : null;

  useEffect(() => {
    return () => {
      if (moveOptionHighlightTimerRef.current !== null) {
        window.clearTimeout(moveOptionHighlightTimerRef.current);
      }
    };
  }, []);

  function flashMovedOption(index: number) {
    setRecentlyMovedOptionIndex(index);
    if (moveOptionHighlightTimerRef.current !== null) {
      window.clearTimeout(moveOptionHighlightTimerRef.current);
    }
    moveOptionHighlightTimerRef.current = window.setTimeout(() => {
      setRecentlyMovedOptionIndex((current) => (current === index ? null : current));
      moveOptionHighlightTimerRef.current = null;
    }, 360);
  }

  useEffect(() => {
    setDraggedOptionIndex(null);
    draggedOptionIndexRef.current = null;
    setOptionDropInsertionIndex(null);
    setRecentlyMovedOptionIndex(null);
    setOptionReorderDrag(null);
  }, [selectedItem]);

  useLayoutEffect(() => {
    if (!selectedCustomTrack) {
      previousOptionRowPositionsRef.current = new Map();
      previousTypeOptionKeysRef.current = [];
      return;
    }
    const previousKeys = previousTypeOptionKeysRef.current;
    const hasSameOptionSet = previousKeys.length === typeOptionKeys.length &&
      previousKeys.every((key) => typeOptionKeys.includes(key)) &&
      typeOptionKeys.every((key) => previousKeys.includes(key));
    const orderChanged = hasSameOptionSet &&
      previousKeys.some((key, index) => typeOptionKeys[index] !== key);
    const nextPositions = new Map<string, number>();
    typeOptionKeys.forEach((key) => {
      const element = optionRowRefs.current.get(key);
      if (!element) {
        return;
      }
      const top = element.offsetTop;
      nextPositions.set(key, top);
      const previousTop = previousOptionRowPositionsRef.current.get(key);
      if (previousTop === undefined) {
        return;
      }
      const delta = previousTop - top;
      if (!orderChanged || Math.abs(delta) < 1) {
        return;
      }
      element.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: 220,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      );
    });
    previousOptionRowPositionsRef.current = nextPositions;
    previousTypeOptionKeysRef.current = typeOptionKeys;
  }, [selectedCustomTrack, typeOptionKeys]);

  useEffect(() => {
    if (!optionReorderDrag || !selectedCustomTrack) {
      return;
    }

    const getDropInsertionIndex = (clientY: number) => {
      if (remainingTypeOptionKeys.length === 0) {
        return null;
      }
      for (let index = 0; index < remainingTypeOptionKeys.length; index += 1) {
        const key = remainingTypeOptionKeys[index];
        const element = optionRowRefs.current.get(key);
        if (!element) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        if (clientY < centerY) {
          return index;
        }
      }
      return remainingTypeOptionKeys.length;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nextCurrentY = event.clientY;
      const isActive = Math.abs(nextCurrentY - optionReorderDrag.startY) >= REORDER_ACTIVATION_PX;
      setOptionReorderDrag((current) =>
        current
          ? {
              ...current,
              currentY: nextCurrentY,
            }
          : current,
      );
      setOptionDropInsertionIndex(isActive ? getDropInsertionIndex(nextCurrentY) : null);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const isActive = Math.abs(event.clientY - optionReorderDrag.startY) >= REORDER_ACTIVATION_PX;
      const insertionIndex = isActive ? getDropInsertionIndex(event.clientY) : null;
      if (insertionIndex !== null && insertionIndex !== optionReorderDrag.index) {
        onReorderCustomTrackTypeOption(selectedCustomTrack.id, optionReorderDrag.index, insertionIndex);
        flashMovedOption(Math.min(insertionIndex, selectedCustomTrack.typeOptions.length - 1));
      }
      draggedOptionIndexRef.current = null;
      setDraggedOptionIndex(null);
      setOptionDropInsertionIndex(null);
      setOptionReorderDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    onReorderCustomTrackTypeOption,
    optionReorderDrag,
    remainingTypeOptionKeys,
    selectedCustomTrack,
  ]);

  if (!selectedItem) {
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>属性面板</h2>
        </div>
        <p className="empty-state">选择一句字幕、一个 block、或一条自定义轨道后可在这里编辑属性。</p>
      </section>
    );
  }

  if (selectedItem.type === "line") {
    const line = subtitleLines.find((item) => item.id === selectedItem.id);
    if (!line) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>句子属性</h2>
        </div>
        <div className="inspector-field">
          <label>文本</label>
          <div className="inspector-value">{line.text}</div>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <div className="inspector-value">{line.startTime.toFixed(3)}s</div>
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <div className="inspector-value">{line.endTime.toFixed(3)}s</div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "custom-track") {
    const track = selectedCustomTrack;
    if (!track) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>轨道设置</h2>
          <button onClick={() => onDeleteCustomTrack(track.id)}>删除轨道</button>
        </div>
        <div className="inspector-field">
          <label>轨道名称</label>
          <input
            value={track.name}
            onChange={(event) => onCustomTrackRename(track.id, event.target.value)}
          />
        </div>
        <div className="inspector-field">
          <label>轨道类型</label>
          <div className="inspector-value">
            {track.trackType === "text" ? "文字类轨道" : "动作类轨道"}
          </div>
        </div>
        <div className="inspector-field">
          <label>类型列表</label>
          <div className="track-option-list">
            {track.typeOptions.map((option, index) => (
              <div
                key={typeOptionKeys[index] ?? `${track.id}-${index}-${option}`}
                className={[
                  "track-option-row",
                  draggedOptionIndex === index ? "dragging" : "",
                  optionDropBeforeKey === (typeOptionKeys[index] ?? `${track.id}-${index}-${option}`)
                    ? "drop-target-before"
                    : "",
                  optionDropAfterKey === (typeOptionKeys[index] ?? `${track.id}-${index}-${option}`)
                    ? "drop-target-after"
                    : "",
                  recentlyMovedOptionIndex === index ? "recently-moved" : "",
                ].join(" ")}
                style={
                  draggedOptionIndex === index &&
                    optionReorderDrag &&
                    Math.abs(optionReorderDrag.currentY - optionReorderDrag.startY) >= REORDER_ACTIVATION_PX
                    ? {
                        transform: `translateY(${optionReorderDrag.currentY - optionReorderDrag.startY}px)`,
                        zIndex: 2,
                      }
                    : undefined
                }
                ref={(node) => {
                  const key = typeOptionKeys[index] ?? `${track.id}-${index}-${option}`;
                  if (node) {
                    optionRowRefs.current.set(key, node);
                  } else {
                    optionRowRefs.current.delete(key);
                  }
                }}
              >
                <input
                  value={option}
                  onChange={(event) =>
                    onCustomTrackTypeOptionChange(track.id, index, event.target.value)
                  }
                />
                <div className="track-option-actions">
                  <div
                    className="track-option-drag-handle"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      draggedOptionIndexRef.current = index;
                      setDraggedOptionIndex(index);
                      setOptionDropInsertionIndex(null);
                      setOptionReorderDrag({
                        index,
                        startY: event.clientY,
                        currentY: event.clientY,
                      });
                    }}
                    title="拖动调整类型顺序"
                  >
                    ⋮⋮
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onMoveCustomTrackTypeOption(track.id, index, "up");
                      flashMovedOption(Math.max(0, index - 1));
                    }}
                    disabled={index === 0}
                    title="上移类型"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onMoveCustomTrackTypeOption(track.id, index, "down");
                      flashMovedOption(Math.min(track.typeOptions.length - 1, index + 1));
                    }}
                    disabled={index === track.typeOptions.length - 1}
                    title="下移类型"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveCustomTrackTypeOption(track.id, index)}
                    disabled={track.typeOptions.length <= 1}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => onAddCustomTrackTypeOption(track.id)}>
              新增类型
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "character") {
    const item = characterAnnotations.find((annotation) => annotation.id === selectedItem.id);
    if (!item) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>逐字属性</h2>
          <button onClick={onDeleteSelected}>删除</button>
        </div>
        <div className="inspector-field">
          <label>字</label>
          <div className="inspector-value character-preview">{item.char}</div>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <input
            type="number"
            step="0.001"
            value={item.startTime}
            onChange={(event) =>
              onCharacterUpdate(item.id, { startTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <input
            type="number"
            step="0.001"
            value={item.endTime}
            onChange={(event) =>
              onCharacterUpdate(item.id, { endTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>唱腔类型</label>
          <select
            value={item.singingStyle}
            onChange={(event) =>
              onCharacterUpdate(item.id, {
                singingStyle: event.target.value as CharacterAnnotation["singingStyle"],
              })
            }
          >
            {singingStyleOptions.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "custom-block") {
    const track = customTracks.find((item) => item.id === selectedItem.trackId);
    const block = track?.blocks.find((item) => item.id === selectedItem.id);
    if (!track || !block) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>{track.trackType === "text" ? "文字 block" : "动作 block"}</h2>
          <button onClick={onDeleteSelected}>删除</button>
        </div>
        <div className="inspector-field">
          <label>轨道</label>
          <div className="inspector-value">{track.name}</div>
        </div>
        {track.trackType === "text" ? (
          <div className="inspector-field">
            <label>文本内容</label>
            <input
              value={getOptionalBlockText(block as unknown as { text?: string })}
              onChange={(event) =>
                onCustomBlockUpdate(track.id, block.id, { text: event.target.value })
              }
            />
          </div>
        ) : null}
        <div className="inspector-field">
          <label>类型</label>
          <select
            value={block.type}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { type: event.target.value })
            }
          >
            {track.typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <input
            type="number"
            step="0.001"
            value={block.startTime}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { startTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <input
            type="number"
            step="0.001"
            value={block.endTime}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { endTime: Number(event.target.value) })
            }
          />
        </div>
      </section>
    );
  }

  const action = actionAnnotations.find((annotation) => annotation.id === selectedItem.id);
  if (!action) {
    return null;
  }
  const track = trackDefinitions.find((item) => item.id === action.trackId);
  return (
    <section className="panel inspector-panel">
      <div className="panel-header">
        <h2>动作属性</h2>
        <button onClick={onDeleteSelected}>删除</button>
      </div>
      <div className="inspector-field">
        <label>轨道</label>
        <div className="inspector-value">{track?.name ?? action.trackId}</div>
      </div>
      <div className="inspector-field">
        <label>标签</label>
        <select
          value={action.label}
          onChange={(event) => onActionUpdate(action.id, { label: event.target.value })}
        >
          {(track?.options ?? ["其他"]).map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="inspector-field">
        <label>开始时间</label>
        <input
          type="number"
          step="0.001"
          value={action.startTime}
          onChange={(event) => onActionUpdate(action.id, { startTime: Number(event.target.value) })}
        />
      </div>
      <div className="inspector-field">
        <label>结束时间</label>
        <input
          type="number"
          step="0.001"
          value={action.endTime}
          onChange={(event) => onActionUpdate(action.id, { endTime: Number(event.target.value) })}
        />
      </div>
    </section>
  );
}

function getOptionalBlockText(block: { text?: string }) {
  return typeof block.text === "string" ? block.text : "";
}

function buildTypeOptionKeys(typeOptions: string[]) {
  const counts = new Map<string, number>();
  return typeOptions.map((option) => {
    const nextCount = (counts.get(option) ?? 0) + 1;
    counts.set(option, nextCount);
    return `${option}__${nextCount}`;
  });
}
