import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  AttachedPointTrack,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  GongcheAnnotation,
  GongcheSymbol,
  SelectedItem,
  SubtitleLine,
  TrackDefinition,
} from "../types";

const REORDER_ACTIVATION_PX = 6;

type InspectorPanelProps = {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  selectedItem: SelectedItem;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  gongcheAnnotations: GongcheAnnotation[];
  actionAnnotations: ActionAnnotation[];
  builtinTracks: BuiltinTrack[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  trackSnapEnabled: Record<string, boolean>;
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onCreateGongcheBlock: (parentTrackId: string, parentBlockId: string) => void;
  onGongcheBlockUpdate: (
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) => void;
  onImportGongcheText: (
    parentTrackId: string,
    sourceText: string,
  ) => { parsed: number; imported: number; updated: number; unmatched: number };
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onAttachedPointUpdate: (trackId: string, pointId: string, changes: { time?: number; label?: string }) => void;
  onTrackWaveformSnapChange: (trackId: string, enabled: boolean) => void;
  onTrackAutoLoopRangeChange: (trackId: string, enabled: boolean) => void;
  onAttachedPointTrackParentSnapChange: (trackId: string, enabled: boolean) => void;
  onSelectParentTrack: (trackId: string) => void;
  onBuiltinTrackRename: (trackId: BuiltinTrackId, name: string) => void;
  onBuiltinTrackTypeOptionChange: (trackId: BuiltinTrackId, index: number, value: string) => void;
  onAddBuiltinTrackTypeOption: (trackId: BuiltinTrackId) => void;
  onMoveBuiltinTrackTypeOption: (trackId: BuiltinTrackId, index: number, direction: "up" | "down") => void;
  onReorderBuiltinTrackTypeOption: (trackId: BuiltinTrackId, fromIndex: number, toIndex: number) => void;
  onRemoveBuiltinTrackTypeOption: (trackId: BuiltinTrackId, index: number) => void;
  onDeleteBuiltinTrack: (trackId: BuiltinTrackId) => void;
  onAddAttachedPointTrack: (parentTrackId: string) => void;
  onToggleAttachedPointTracks: (parentTrackId: string) => void;
  onSelectAttachedPointTrack: (trackId: string, parentTrackId: string) => void;
  onAttachedPointTrackRename: (trackId: string, name: string) => void;
  onAttachedPointTrackTypeOptionChange: (trackId: string, index: number, value: string) => void;
  onAddAttachedPointTrackTypeOption: (trackId: string) => void;
  onMoveAttachedPointTrackTypeOption: (trackId: string, index: number, direction: "up" | "down") => void;
  onReorderAttachedPointTrackTypeOption: (trackId: string, fromIndex: number, toIndex: number) => void;
  onRemoveAttachedPointTrackTypeOption: (trackId: string, index: number) => void;
  onDeleteAttachedPointTrack: (trackId: string) => void;
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
  collapsed = false,
  onToggleCollapse,
  selectedItem,
  subtitleLines,
  characterAnnotations,
  gongcheAnnotations,
  actionAnnotations,
  builtinTracks,
  customTracks,
  trackDefinitions,
  trackSnapEnabled,
  onCharacterUpdate,
  onCreateGongcheBlock,
  onGongcheBlockUpdate,
  onImportGongcheText,
  onActionUpdate,
  onAttachedPointUpdate,
  onTrackWaveformSnapChange,
  onTrackAutoLoopRangeChange,
  onAttachedPointTrackParentSnapChange,
  onSelectParentTrack,
  onBuiltinTrackRename,
  onBuiltinTrackTypeOptionChange,
  onAddBuiltinTrackTypeOption,
  onMoveBuiltinTrackTypeOption,
  onReorderBuiltinTrackTypeOption,
  onRemoveBuiltinTrackTypeOption,
  onDeleteBuiltinTrack,
  onAddAttachedPointTrack,
  onToggleAttachedPointTracks,
  onSelectAttachedPointTrack,
  onAttachedPointTrackRename,
  onAttachedPointTrackTypeOptionChange,
  onAddAttachedPointTrackTypeOption,
  onMoveAttachedPointTrackTypeOption,
  onReorderAttachedPointTrackTypeOption,
  onRemoveAttachedPointTrackTypeOption,
  onDeleteAttachedPointTrack,
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
  const [gongcheImportDraft, setGongcheImportDraft] = useState("");
  const [gongcheImportResult, setGongcheImportResult] = useState<string | null>(null);
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
  const selectedAttachedPointTrack = selectedItem?.type === "attached-point-track"
    ? findAttachedPointTrackInCollections(builtinTracks, customTracks, selectedItem.id, selectedItem.parentTrackId)
    : null;
  const selectedEditableTrack = selectedBuiltinTrack ?? selectedCustomTrack ?? selectedAttachedPointTrack?.track ?? null;
  const typeOptionKeys = useMemo(
    () => buildTypeOptionKeys(
      selectedBuiltinTrack?.options ?? selectedCustomTrack?.typeOptions ?? selectedAttachedPointTrack?.track.typeOptions ?? [],
    ),
    [selectedBuiltinTrack?.options, selectedCustomTrack?.typeOptions, selectedAttachedPointTrack?.track.typeOptions],
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
  const collapseButton = onToggleCollapse ? (
    <button
      type="button"
      className="panel-collapse-button"
      title={collapsed ? "展开面板" : "最小化面板"}
      aria-label={collapsed ? "展开面板" : "最小化面板"}
      onClick={onToggleCollapse}
    >
      {collapsed ? "▸" : "—"}
    </button>
  ) : null;

  if (collapsed) {
    return (
      <section className="panel inspector-panel is-collapsed">
        <div className="panel-header">
          <h2>属性 / 轨道设置</h2>
          {collapseButton ? <div className="panel-header-actions">{collapseButton}</div> : null}
        </div>
      </section>
    );
  }

  useEffect(() => {
    setTrackNameDraft(selectedEditableTrack?.name ?? "");
  }, [selectedEditableTrack?.id, selectedEditableTrack?.name]);

  useEffect(() => {
    setTypeOptionDrafts(trackOptionsFromTrack(selectedEditableTrack));
    setComposingOptionIndexes({});
  }, [selectedEditableTrack?.id, selectedBuiltinTrack?.options, selectedCustomTrack?.typeOptions, selectedAttachedPointTrack?.track.typeOptions]);

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
    setGongcheImportResult(null);
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
      return;
    }
    if (selectedAttachedPointTrack) {
      onAttachedPointTrackRename(selectedAttachedPointTrack.track.id, nextName);
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
      return;
    }
    if (selectedAttachedPointTrack) {
      onAttachedPointTrackTypeOptionChange(selectedAttachedPointTrack.track.id, index, nextValue);
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
        } else if (selectedAttachedPointTrack) {
          onReorderAttachedPointTrackTypeOption(selectedAttachedPointTrack.track.id, optionReorderDrag.index, insertionIndex);
          flashMovedOption(Math.min(insertionIndex, selectedAttachedPointTrack.track.typeOptions.length - 1));
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
    selectedAttachedPointTrack,
    onReorderAttachedPointTrackTypeOption,
  ]);

  if (!selectedItem) {
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>属性面板</h2>
          {collapseButton ? <div className="panel-header-actions">{collapseButton}</div> : null}
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
          {collapseButton ? <div className="panel-header-actions">{collapseButton}</div> : null}
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

  if (
    selectedItem.type === "custom-track" ||
    selectedItem.type === "builtin-track" ||
    selectedItem.type === "attached-point-track"
  ) {
    const track = selectedEditableTrack;
    if (!track) {
      return null;
    }
    const trackOptions = "typeOptions" in track ? track.typeOptions : (track.options ?? []);
    const isBuiltinTrack = selectedItem.type === "builtin-track";
    const isAttachedPointTrack = selectedItem.type === "attached-point-track";
    const attachedPointTracks = "attachedPointTracks" in track ? track.attachedPointTracks ?? [] : [];
    const attachedPointTracksExpanded =
      !isAttachedPointTrack && "attachedPointTracksExpanded" in track
        ? Boolean(track.attachedPointTracksExpanded)
        : false;
    const trackSnapOn = Boolean(trackSnapEnabled[track.id]);
    const waveformSnapOn = Boolean(track.snapToWaveformKeypoints);
    const autoLoopRangeOn = Boolean(track.autoSetLoopRangeOnSelect);
    const parentBoundarySnapOn = isAttachedPointTrack && selectedAttachedPointTrack
      ? Boolean(selectedAttachedPointTrack.track.snapToParentBoundaries)
      : false;
    const trackTypeLabel = isAttachedPointTrack
      ? "附属打点轨"
      : "trackType" in track
        ? (track.trackType === "text" ? "文字类轨道" : "动作类轨道")
        : ("type" in track && track.type === "character" ? "文字类轨道" : "动作类轨道");
    const supportsGongcheImport = !isAttachedPointTrack &&
      (("type" in track && track.type === "character") || ("trackType" in track && track.trackType === "text"));
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <div className="panel-header-copy">
            <h2>{isAttachedPointTrack ? "附属打点轨设置" : "轨道设置"}</h2>
            {isAttachedPointTrack && selectedAttachedPointTrack ? (
              <span>{selectedAttachedPointTrack.parentTrack.name}</span>
            ) : null}
          </div>
          <div className="panel-header-actions">
            {isAttachedPointTrack && selectedAttachedPointTrack ? (
              <button
                type="button"
                className="panel-header-secondary"
                onClick={() => onSelectParentTrack(selectedAttachedPointTrack.parentTrack.id)}
              >
                返回父轨道
              </button>
            ) : null}
            {collapseButton}
            <button onClick={() => {
              if (isBuiltinTrack) {
                onDeleteBuiltinTrack(track.id as BuiltinTrackId);
              } else if (isAttachedPointTrack) {
                onDeleteAttachedPointTrack(track.id);
              } else {
                onDeleteCustomTrack(track.id);
              }
            }}>删除轨道</button>
          </div>
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
          <div className="inspector-value">{trackTypeLabel}</div>
        </div>
        <div className="inspector-field">
          <label>音频关键点吸附</label>
          <div className={`inspector-toggle-row ${trackSnapOn ? "" : "disabled"}`.trim()}>
            <div className="inspector-toggle-copy">
              <strong>吸附到音频关键点</strong>
              <span>{trackSnapOn ? "拖动、缩放和创建时会参考波形关键点" : "请先在轨道头开启吸附"}</span>
            </div>
            <label className="inspector-switch">
              <input
                type="checkbox"
                checked={waveformSnapOn}
                disabled={!trackSnapOn}
                onChange={(event) => onTrackWaveformSnapChange(track.id, event.target.checked)}
              />
              <span className="inspector-switch-slider" />
            </label>
          </div>
        </div>
        {!isAttachedPointTrack ? (
          <div className="inspector-field">
            <label>选中块同步循环范围</label>
            <div className="inspector-toggle-row">
              <div className="inspector-toggle-copy">
                <strong>选中块时更新循环范围</strong>
                <span>选择该轨道上的块时，将循环范围同步到块的开始与结束时间，但不会自动开启循环播放。</span>
              </div>
              <label className="inspector-switch">
                <input
                  type="checkbox"
                  checked={autoLoopRangeOn}
                  onChange={(event) => onTrackAutoLoopRangeChange(track.id, event.target.checked)}
                />
                <span className="inspector-switch-slider" />
              </label>
            </div>
          </div>
        ) : null}
        {isAttachedPointTrack ? (
          <div className="inspector-field">
            <label>父轨道边界吸附</label>
            <div className={`inspector-toggle-row ${trackSnapOn ? "" : "disabled"}`.trim()}>
              <div className="inspector-toggle-copy">
                <strong>吸附到父轨道标注边界</strong>
                <span>{trackSnapOn ? "会参考父轨道标记块的开始与结束位置" : "请先在轨道头开启吸附"}</span>
              </div>
              <label className="inspector-switch">
                <input
                  type="checkbox"
                  checked={parentBoundarySnapOn}
                  disabled={!trackSnapOn}
                  onChange={(event) => onAttachedPointTrackParentSnapChange(track.id, event.target.checked)}
                />
                <span className="inspector-switch-slider" />
              </label>
            </div>
          </div>
        ) : null}
        {isAttachedPointTrack && selectedAttachedPointTrack ? (
          <div className="inspector-field">
            <label>父轨道</label>
            <div className="inspector-value">{selectedAttachedPointTrack.parentTrack.name}</div>
          </div>
        ) : null}
        {!isAttachedPointTrack ? (
          <div className="inspector-field">
            <label>附属打点轨</label>
            <div className="track-option-list attached-point-track-list">
              {attachedPointTracks.map((pointTrack) => (
                <div key={pointTrack.id} className="track-option-row attached-point-track-row">
                  <div className="attached-point-track-summary">
                    <strong>{pointTrack.name}</strong>
                    <span>{pointTrack.points.length} 个打点</span>
                  </div>
                  <div className="track-option-actions">
                    <button
                      type="button"
                      onClick={() => onSelectAttachedPointTrack(pointTrack.id, track.id)}
                    >
                      设置
                    </button>
                  </div>
                </div>
              ))}
              <div className="attached-point-track-actions">
                <button type="button" onClick={() => onAddAttachedPointTrack(track.id)}>
                  新增打点附属轨
                </button>
                {attachedPointTracks.length > 0 ? (
                  <button type="button" onClick={() => onToggleAttachedPointTracks(track.id)}>
                    {attachedPointTracksExpanded ? "隐藏附属打点轨" : "展开附属打点轨"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {supportsGongcheImport ? (
          <div className="inspector-field">
            <label>导入工尺谱</label>
            <div className="gongche-import-box">
              <textarea
                value={gongcheImportDraft}
                placeholder="粘贴如：字{工尺内容} 的曲谱文本"
                onChange={(event) => setGongcheImportDraft(event.target.value)}
              />
              <div className="gongche-import-actions">
                <button
                  type="button"
                  onClick={() => {
                    const result = onImportGongcheText(track.id, gongcheImportDraft);
                    setGongcheImportResult(
                      `解析 ${result.parsed} 条，导入 ${result.imported} 条，更新 ${result.updated} 条，未匹配 ${result.unmatched} 条。`,
                    );
                  }}
                  disabled={!gongcheImportDraft.trim()}
                >
                  导入到工尺谱附属轨
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setGongcheImportDraft("");
                    setGongcheImportResult(null);
                  }}
                  disabled={!gongcheImportDraft && !gongcheImportResult}
                >
                  清空
                </button>
              </div>
              {gongcheImportResult ? (
                <div className="inspector-value gongche-import-result">{gongcheImportResult}</div>
              ) : null}
            </div>
          </div>
        ) : null}
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
                      } else if (isAttachedPointTrack) {
                        onMoveAttachedPointTrackTypeOption(track.id, index, "up");
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
                      } else if (isAttachedPointTrack) {
                        onMoveAttachedPointTrackTypeOption(track.id, index, "down");
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
                      } else if (isAttachedPointTrack) {
                        onRemoveAttachedPointTrackTypeOption(track.id, index);
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
              } else if (isAttachedPointTrack) {
                onAddAttachedPointTrackTypeOption(track.id);
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
    const gongcheBlock = gongcheAnnotations.find((block) =>
      block.parentTrackId === "character-track" && block.parentBlockId === item.id,
    );
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>逐字属性</h2>
          <div className="panel-header-actions">
            {collapseButton}
            <button onClick={onDeleteSelected}>删除</button>
          </div>
        </div>
        <div className="inspector-field">
          <label>字</label>
          <div className="inspector-value character-preview">{item.char}</div>
        </div>
        <div className="inspector-field">
          <label>工尺谱</label>
          <div className="inspector-link-row">
            <div className="inspector-value">
              {gongcheBlock ? gongcheBlock.symbols.map((symbol) => symbol.label).join(" ") : "此字暂无工尺谱块"}
            </div>
            <button
              type="button"
              onClick={() => onCreateGongcheBlock("character-track", item.id)}
            >
              {gongcheBlock ? "打开" : "创建"}
            </button>
          </div>
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

  if (selectedItem.type === "gongche-block") {
    const block = gongcheAnnotations.find((item) => item.id === selectedItem.id);
    if (!block) {
      return null;
    }
    const parent = findGongcheInspectorParent(block, characterAnnotations, customTracks);
    const symbolsText = block.symbols.map((symbol) => symbol.label).join("");
    const updateSymbol = (symbolId: string, changes: Partial<GongcheSymbol>) => {
      onGongcheBlockUpdate(block.id, {
        symbols: block.symbols.map((symbol) =>
          symbol.id === symbolId ? { ...symbol, ...changes } : symbol,
        ),
      });
    };
    const removeSymbol = (symbolId: string) => {
      if (block.symbols.length <= 1) {
        return;
      }
      onGongcheBlockUpdate(block.id, {
        symbols: distributeGongcheSymbols(
          block.symbols.filter((symbol) => symbol.id !== symbolId).map((symbol) => symbol.label),
          block.startTime,
          block.endTime,
        ),
      });
    };
    const addSymbol = () => {
      onGongcheBlockUpdate(block.id, {
        symbols: distributeGongcheSymbols(
          [...block.symbols.map((symbol) => symbol.label), "合"],
          block.startTime,
          block.endTime,
        ),
      });
    };

    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>工尺谱编辑</h2>
          <div className="panel-header-actions">
            {collapseButton}
            <button onClick={onDeleteSelected}>删除</button>
          </div>
        </div>
        <div className="inspector-field">
          <label>对应文字</label>
          <div className="inspector-value character-preview">{parent?.label ?? "未知文字块"}</div>
        </div>
        <div className="inspector-field">
          <label>快速输入</label>
          <input
            value={symbolsText}
            onChange={(event) =>
              onGongcheBlockUpdate(block.id, {
                symbols: distributeGongcheSymbols(
                  Array.from(event.target.value).filter((char) => char.trim().length > 0),
                  block.startTime,
                  block.endTime,
                ),
              })
            }
          />
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <input
            type="number"
            step="0.001"
            value={block.startTime}
            onChange={(event) => onGongcheBlockUpdate(block.id, { startTime: Number(event.target.value) })}
          />
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <input
            type="number"
            step="0.001"
            value={block.endTime}
            onChange={(event) => onGongcheBlockUpdate(block.id, { endTime: Number(event.target.value) })}
          />
        </div>
        <div className="inspector-field">
          <label>工尺符号拆分</label>
          <div className="gongche-symbol-editor">
            {block.symbols.map((symbol, index) => (
              <div key={symbol.id} className="gongche-symbol-row">
                <strong>{index + 1}</strong>
                <input
                  value={symbol.label}
                  onChange={(event) => updateSymbol(symbol.id, { label: event.target.value })}
                  aria-label="工尺符号"
                />
                <input
                  value={symbol.notation ?? ""}
                  onChange={(event) => updateSymbol(symbol.id, {
                    notation: event.target.value,
                    rawText: `${symbol.parenthesized ? `（${symbol.label}）` : symbol.label}${event.target.value}`,
                  })}
                  aria-label="附加信息"
                  title={symbol.rawText ?? symbol.label}
                />
                <input
                  type="number"
                  step="0.001"
                  value={symbol.startTime}
                  onChange={(event) => updateSymbol(symbol.id, { startTime: Number(event.target.value) })}
                  aria-label="开始时间"
                />
                <input
                  type="number"
                  step="0.001"
                  value={symbol.endTime}
                  onChange={(event) => updateSymbol(symbol.id, { endTime: Number(event.target.value) })}
                  aria-label="结束时间"
                />
                <button type="button" onClick={() => removeSymbol(symbol.id)} disabled={block.symbols.length <= 1}>
                  删
                </button>
              </div>
            ))}
            <button type="button" onClick={addSymbol}>
              新增符号
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "attached-point") {
    const pointTrackInfo = findAttachedPointTrackInCollections(
      builtinTracks,
      customTracks,
      selectedItem.trackId,
      selectedItem.parentTrackId,
    );
    const point = pointTrackInfo?.track.points.find((item) => item.id === selectedItem.id) ?? null;
    if (!pointTrackInfo || !point) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>打点属性</h2>
          <div className="panel-header-actions">
            {collapseButton}
            <button onClick={onDeleteSelected}>删除</button>
          </div>
        </div>
        <div className="inspector-field">
          <label>附属轨</label>
          <div className="inspector-value">{pointTrackInfo.track.name}</div>
        </div>
        <div className="inspector-field">
          <label>父轨道</label>
          <div className="inspector-value">{pointTrackInfo.parentTrack.name}</div>
        </div>
        <div className="inspector-field">
          <label>打点含义</label>
          <select
            value={point.label}
            onChange={(event) =>
              onAttachedPointUpdate(pointTrackInfo.track.id, point.id, { label: event.target.value })
            }
          >
            {pointTrackInfo.track.typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="inspector-field">
          <label>时间</label>
          <input
            type="number"
            step="0.001"
            value={point.time}
            onChange={(event) =>
              onAttachedPointUpdate(pointTrackInfo.track.id, point.id, { time: Number(event.target.value) })
            }
          />
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
    const gongcheBlock = track.trackType === "text"
      ? gongcheAnnotations.find((item) => item.parentTrackId === track.id && item.parentBlockId === block.id) ?? null
      : null;
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>{track.trackType === "text" ? "文字 block" : "动作 block"}</h2>
          <div className="panel-header-actions">
            {collapseButton}
            <button onClick={onDeleteSelected}>删除</button>
          </div>
        </div>
        <div className="inspector-field">
          <label>轨道</label>
          <div className="inspector-value">{track.name}</div>
        </div>
        {track.trackType === "text" ? (
          <>
            <div className="inspector-field">
              <label>文本内容</label>
              <input
                value={getOptionalBlockText(block as unknown as { text?: string })}
                onChange={(event) =>
                  onCustomBlockUpdate(track.id, block.id, { text: event.target.value })
                }
              />
            </div>
            <div className="inspector-field">
              <label>工尺谱</label>
              <div className="inspector-link-row">
                <div className="inspector-value">
                  {gongcheBlock ? gongcheBlock.symbols.map((symbol) => symbol.label).join(" ") : "此文字块暂无工尺谱块"}
                </div>
                <button
                  type="button"
                  onClick={() => onCreateGongcheBlock(track.id, block.id)}
                >
                  {gongcheBlock ? "打开" : "创建"}
                </button>
              </div>
            </div>
          </>
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

  if (
    selectedItem.type === "waveform-track" ||
    selectedItem.type === "spectrogram-track" ||
    selectedItem.type === "gongche-track"
  ) {
    return null;
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
        <div className="panel-header-actions">
          {collapseButton}
          <button onClick={onDeleteSelected}>删除</button>
        </div>
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

function findGongcheInspectorParent(
  block: GongcheAnnotation,
  characterAnnotations: CharacterAnnotation[],
  customTracks: CustomTrack[],
) {
  if (block.parentTrackId === "character-track") {
    const character = characterAnnotations.find((item) => item.id === block.parentBlockId);
    return character
      ? {
          label: character.char,
          startTime: character.startTime,
          endTime: character.endTime,
        }
      : null;
  }
  const track = customTracks.find((item) => item.id === block.parentTrackId && item.trackType === "text");
  const parentBlock = track?.blocks.find((item) => item.id === block.parentBlockId);
  return parentBlock
    ? {
        label: "text" in parentBlock && typeof parentBlock.text === "string" ? parentBlock.text : parentBlock.type,
        startTime: parentBlock.startTime,
        endTime: parentBlock.endTime,
      }
    : null;
}

function distributeGongcheSymbols(labels: string[], startTime: number, endTime: number): GongcheSymbol[] {
  const normalizedLabels = labels.map((label) => label.trim()).filter(Boolean);
  const safeLabels = normalizedLabels.length > 0 ? normalizedLabels : ["合"];
  const duration = Math.max(endTime - startTime, 0.001);
  const step = duration / safeLabels.length;
  return safeLabels.map((label, index) => ({
    id: `gongche-symbol-${crypto.randomUUID()}`,
    label,
    notation: "",
    rawText: label,
    parenthesized: false,
    startTime: startTime + step * index,
    endTime: index === safeLabels.length - 1 ? endTime : startTime + step * (index + 1),
    assetUrl: null,
  }));
}

function buildTypeOptionKeys(typeOptions: string[]) {
  const counts = new Map<string, number>();
  return typeOptions.map((option) => {
    const nextCount = (counts.get(option) ?? 0) + 1;
    counts.set(option, nextCount);
    return `${option}__${nextCount}`;
  });
}

function trackOptionsFromTrack(track: BuiltinTrack | CustomTrack | AttachedPointTrack | null) {
  if (!track) {
    return [];
  }
  return "typeOptions" in track ? track.typeOptions : (track.options ?? []);
}

function findAttachedPointTrackInCollections(
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
  pointTrackId: string,
  parentTrackId: string,
) {
  const builtinParent = builtinTracks.find((track) => track.id === parentTrackId);
  if (builtinParent) {
    const track = (builtinParent.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
    return track ? { parentTrack: builtinParent, track } : null;
  }
  const customParent = customTracks.find((track) => track.id === parentTrackId);
  if (!customParent) {
    return null;
  }
  const track = (customParent.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
  return track ? { parentTrack: customParent, track } : null;
}
