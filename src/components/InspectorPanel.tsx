import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  SelectedItem,
  SubtitleLine,
  TrackDefinition,
} from "../types";

const REORDER_ACTIVATION_PX = 6;

type InspectorPanelProps = {
  selectedItem: SelectedItem;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  builtinTracks: BuiltinTrack[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onBuiltinTrackRename: (trackId: BuiltinTrackId, name: string) => void;
  onBuiltinTrackTypeOptionChange: (trackId: BuiltinTrackId, index: number, value: string) => void;
  onAddBuiltinTrackTypeOption: (trackId: BuiltinTrackId) => void;
  onMoveBuiltinTrackTypeOption: (trackId: BuiltinTrackId, index: number, direction: "up" | "down") => void;
  onReorderBuiltinTrackTypeOption: (trackId: BuiltinTrackId, fromIndex: number, toIndex: number) => void;
  onRemoveBuiltinTrackTypeOption: (trackId: BuiltinTrackId, index: number) => void;
  onDeleteBuiltinTrack: (trackId: BuiltinTrackId) => void;
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
  builtinTracks,
  customTracks,
  trackDefinitions,
  onCharacterUpdate,
  onActionUpdate,
  onBuiltinTrackRename,
  onBuiltinTrackTypeOptionChange,
  onAddBuiltinTrackTypeOption,
  onMoveBuiltinTrackTypeOption,
  onReorderBuiltinTrackTypeOption,
  onRemoveBuiltinTrackTypeOption,
  onDeleteBuiltinTrack,
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
  const [trackNameDraft, setTrackNameDraft] = useState("");
  const [typeOptionDrafts, setTypeOptionDrafts] = useState<string[]>([]);
  const [isTrackNameComposing, setIsTrackNameComposing] = useState(false);
  const [composingOptionIndexes, setComposingOptionIndexes] = useState<Record<number, boolean>>({});
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
  const selectedBuiltinTrack = selectedItem?.type === "builtin-track"
    ? builtinTracks.find((item) => item.id === selectedItem.id) ?? null
    : null;
  const selectedCustomTrack = selectedItem?.type === "custom-track"
    ? customTracks.find((item) => item.id === selectedItem.id) ?? null
    : null;
  const selectedEditableTrack = selectedBuiltinTrack ?? selectedCustomTrack;
  const typeOptionKeys = useMemo(
    () => buildTypeOptionKeys(
      selectedBuiltinTrack?.options ?? selectedCustomTrack?.typeOptions ?? [],
    ),
    [selectedBuiltinTrack?.options, selectedCustomTrack?.typeOptions],
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
    setTrackNameDraft(selectedEditableTrack?.name ?? "");
  }, [selectedEditableTrack?.id, selectedEditableTrack?.name]);

  useEffect(() => {
    setTypeOptionDrafts(trackOptionsFromTrack(selectedEditableTrack));
    setComposingOptionIndexes({});
  }, [selectedEditableTrack?.id, selectedBuiltinTrack?.options, selectedCustomTrack?.typeOptions]);

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
    setIsTrackNameComposing(false);
    setComposingOptionIndexes({});
  }, [selectedItem]);

  function commitTrackName(nextName: string) {
    if (!selectedEditableTrack || nextName === selectedEditableTrack.name) {
      return;
    }
    if (selectedBuiltinTrack) {
      onBuiltinTrackRename(selectedBuiltinTrack.id, nextName);
      return;
    }
    if (selectedCustomTrack) {
      onCustomTrackRename(selectedCustomTrack.id, nextName);
    }
  }

  function commitTrackTypeOption(index: number, nextValue: string) {
    if (!selectedEditableTrack) {
      return;
    }
    const currentOptions = trackOptionsFromTrack(selectedEditableTrack);
    if (currentOptions[index] === nextValue) {
      return;
    }
    if (selectedBuiltinTrack) {
      onBuiltinTrackTypeOptionChange(selectedBuiltinTrack.id, index, nextValue);
      return;
    }
    if (selectedCustomTrack) {
      onCustomTrackTypeOptionChange(selectedCustomTrack.id, index, nextValue);
    }
  }

  useLayoutEffect(() => {
    if (!selectedEditableTrack) {
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
  }, [selectedEditableTrack, typeOptionKeys]);

  useEffect(() => {
    if (!optionReorderDrag || !selectedEditableTrack) {
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
        if (selectedBuiltinTrack) {
          onReorderBuiltinTrackTypeOption(selectedBuiltinTrack.id, optionReorderDrag.index, insertionIndex);
          flashMovedOption(Math.min(insertionIndex, (selectedBuiltinTrack.options?.length ?? 1) - 1));
        } else if (selectedCustomTrack) {
          onReorderCustomTrackTypeOption(selectedCustomTrack.id, optionReorderDrag.index, insertionIndex);
          flashMovedOption(Math.min(insertionIndex, selectedCustomTrack.typeOptions.length - 1));
        }
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
    onReorderBuiltinTrackTypeOption,
    optionReorderDrag,
    remainingTypeOptionKeys,
    selectedBuiltinTrack,
    selectedEditableTrack,
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

  if (selectedItem.type === "custom-track" || selectedItem.type === "builtin-track") {
    const track = selectedEditableTrack;
    if (!track) {
      return null;
    }
    const trackOptions = "typeOptions" in track ? track.typeOptions : (track.options ?? []);
    const isBuiltinTrack = selectedItem.type === "builtin-track";
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>轨道设置</h2>
          <button onClick={() => {
            if (isBuiltinTrack) {
              onDeleteBuiltinTrack(track.id as BuiltinTrackId);
            } else {
              onDeleteCustomTrack(track.id);
            }
          }}>删除轨道</button>
        </div>
        <div className="inspector-field">
          <label>轨道名称</label>
          <input
            value={trackNameDraft}
            onChange={(event) => {
              setTrackNameDraft(event.target.value);
            }}
            onCompositionStart={() => setIsTrackNameComposing(true)}
            onCompositionEnd={(event) => {
              setIsTrackNameComposing(false);
              setTrackNameDraft(event.currentTarget.value);
            }}
            onBlur={() => commitTrackName(trackNameDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const isComposing = isTrackNameComposing ||
                  (event.nativeEvent as KeyboardEvent & { isComposing?: boolean }).isComposing === true;
                if (isComposing) {
                  return;
                }
                event.preventDefault();
                commitTrackName(trackNameDraft);
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTrackNameDraft(track.name);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <div className="inspector-field">
          <label>轨道类型</label>
          <div className="inspector-value">
            {"trackType" in track
              ? track.trackType === "text" ? "文字类轨道" : "动作类轨道"
              : track.type === "character" ? "文字类轨道" : "动作类轨道"}
          </div>
        </div>
        <div className="inspector-field">
          <label>类型列表</label>
          <div className="track-option-list">
            {trackOptions.map((option, index) => (
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
                  value={typeOptionDrafts[index] ?? option}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setTypeOptionDrafts((current) => {
                      const next = [...current];
                      next[index] = nextValue;
                      return next;
                    });
                  }}
                  onCompositionStart={() => {
                    setComposingOptionIndexes((current) => ({ ...current, [index]: true }));
                  }}
                  onCompositionEnd={(event) => {
                    const nextValue = event.currentTarget.value;
                    setComposingOptionIndexes((current) => ({ ...current, [index]: false }));
                    setTypeOptionDrafts((current) => {
                      const next = [...current];
                      next[index] = nextValue;
                      return next;
                    });
                  }}
                  onBlur={() => {
                    commitTrackTypeOption(index, typeOptionDrafts[index] ?? option);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      const isComposing = composingOptionIndexes[index] ||
                        (event.nativeEvent as KeyboardEvent & { isComposing?: boolean }).isComposing === true;
                      if (isComposing) {
                        return;
                      }
                      event.preventDefault();
                      commitTrackTypeOption(index, typeOptionDrafts[index] ?? option);
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setTypeOptionDrafts((current) => {
                        const next = [...current];
                        next[index] = option;
                        return next;
                      });
                      event.currentTarget.blur();
                    }
                  }}
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
                      if (isBuiltinTrack) {
                        onMoveBuiltinTrackTypeOption(track.id as BuiltinTrackId, index, "up");
                      } else {
                        onMoveCustomTrackTypeOption(track.id, index, "up");
                      }
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
                      if (isBuiltinTrack) {
                        onMoveBuiltinTrackTypeOption(track.id as BuiltinTrackId, index, "down");
                      } else {
                        onMoveCustomTrackTypeOption(track.id, index, "down");
                      }
                      flashMovedOption(Math.min(trackOptions.length - 1, index + 1));
                    }}
                    disabled={index === trackOptions.length - 1}
                    title="下移类型"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isBuiltinTrack) {
                        onRemoveBuiltinTrackTypeOption(track.id as BuiltinTrackId, index);
                      } else {
                        onRemoveCustomTrackTypeOption(track.id, index);
                      }
                    }}
                    disabled={trackOptions.length <= 1}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={() => {
              if (isBuiltinTrack) {
                onAddBuiltinTrackTypeOption(track.id as BuiltinTrackId);
              } else {
                onAddCustomTrackTypeOption(track.id);
              }
            }}>
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
            {(trackDefinitions.find((track) => track.id === "character-track")?.options ?? [item.singingStyle]).map((style) => (
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

function trackOptionsFromTrack(track: BuiltinTrack | CustomTrack | null) {
  if (!track) {
    return [];
  }
  return "typeOptions" in track ? track.typeOptions : (track.options ?? []);
}
