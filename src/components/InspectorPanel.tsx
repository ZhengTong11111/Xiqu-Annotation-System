import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import type {
  ActionAnnotation,
  AttachedPointTrack,
  BranchScope,
  BanyanMark,
  BanyanSection,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  GongcheAnnotation,
  GongcheSymbol,
  InspectorFocusRequest,
  InspectorFocusTarget,
  SentenceAnnotationConfig,
  SelectedItem,
  SubtitleLine,
  TrackBranchDisplayMode,
  TrackDefinition,
} from "../types";
import { SENTENCE_DELIVERY_MODE_OPTIONS } from "../utils/sentenceClassification";
import { GongcheCharacterRenderer } from "./GongcheCharacterRenderer";
import { ToggleRow } from "./SpectrogramSettingsPanel";
import {
  getBanyanConfidenceLabel,
  getBanyanRoleLabel,
  getBanyanSubtypeLabel,
} from "../utils/banyan";
import { flattenBranchLanes, getTrackBranchSummary } from "../utils/project";
import {
  createDefaultGongcheSymbol,
  reconcileGongcheSymbolLabels,
  redistributeGongcheSymbolSequence,
} from "../utils/gongcheSymbols";
import {
  DEFAULT_TRACK_COLORS,
  getBranchLaneColor,
  normalizeHexColor,
  QUICK_TRACK_COLOR_PALETTE,
  resolveCustomTrackColor,
  STANDARD_TRACK_COLORS,
} from "../utils/trackColors";
import {
  TONE_SELECT_OPTIONS,
  buildLineTonePreview,
  getToneInfoForSelectValue,
  getToneSelectValue,
} from "../utils/tone";

const REORDER_ACTIVATION_PX = 6;

const BANYAN_BAN_SUBTYPE_OPTIONS: BanyanMark["subtype"][] = [
  "mainBan",
  "headBan",
  "waistBan",
  "bottomBan",
  "zengBan",
  "waistZengBan",
];

const BANYAN_YAN_SUBTYPE_OPTIONS: BanyanMark["subtype"][] = [
  "middleEye",
  "smallEye",
  "sideHeadTailEye",
  "sideMiddleEye",
];

const BANYAN_AUXILIARY_SUBTYPE_OPTIONS: BanyanMark["subtype"][] = [
  "phraseBoundary",
  "unknown",
];

function getBanyanSubtypeOptionsForRole(role: BanyanMark["role"]) {
  if (role === "ban") {
    return BANYAN_BAN_SUBTYPE_OPTIONS;
  }
  if (role === "yan") {
    return BANYAN_YAN_SUBTYPE_OPTIONS;
  }
  return BANYAN_AUXILIARY_SUBTYPE_OPTIONS;
}

function getDefaultBanyanSubtypeForRole(role: BanyanMark["role"]) {
  return getBanyanSubtypeOptionsForRole(role)[0] ?? "unknown";
}

type InspectorPanelProps = {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  selectedItem: SelectedItem;
  subtitleLines: SubtitleLine[];
  sentenceAnnotationConfig: SentenceAnnotationConfig;
  characterAnnotations: CharacterAnnotation[];
  gongcheAnnotations: GongcheAnnotation[];
  banyanSections: BanyanSection[];
  banyanMarks: BanyanMark[];
  banyanGridVisible: boolean;
  banyanTrackVisible: boolean;
  actionAnnotations: ActionAnnotation[];
  builtinTracks: BuiltinTrack[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  trackSnapEnabled: Record<string, boolean>;
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onLineClassificationChange: (
    id: string,
    changes: Partial<Pick<SubtitleLine, "deliveryMode" | "roleType">>,
  ) => void;
  onOpenSentenceAnnotationSettings: () => void;
  onCreateGongcheBlock: (parentTrackId: string, parentBlockId: string) => void;
  onGongcheBlockUpdate: (
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) => void;
  onImportGongcheText: (
    parentTrackId: string,
    sourceText: string,
  ) => Promise<{ parsed: number; imported: number; updated: number; unmatched: number } | null>;
  onGenerateBanyanFromGongche: () => Promise<{
    created: number;
    updated: number;
    preserved: number;
    orphaned: number;
    sectionCreated: boolean;
  } | null>;
  onBanyanGridVisibleChange: (visible: boolean) => void;
  onBanyanTrackVisibleChange: (visible: boolean) => void;
  onBanyanMarkUpdate: (id: string, changes: Partial<BanyanMark>) => void;
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onAttachedPointUpdate: (trackId: string, pointId: string, changes: { time?: number; label?: string }) => void;
  onTrackWaveformSnapChange: (trackId: string, enabled: boolean) => void;
  onTrackAutoLoopRangeChange: (trackId: string, enabled: boolean) => void;
  onAttachedPointTrackParentSnapChange: (trackId: string, enabled: boolean) => void;
  onSelectParentTrack: (trackId: string) => void;
  onBuiltinTrackRename: (trackId: BuiltinTrackId, name: string) => void;
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
  onCustomTrackColorChange: (trackId: string, color: string) => void;
  onCustomTrackTypeOptionChange: (trackId: string, index: number, value: string) => void;
  onAddCustomTrackTypeOption: (trackId: string) => void;
  onMoveCustomTrackTypeOption: (trackId: string, index: number, direction: "up" | "down") => void;
  onReorderCustomTrackTypeOption: (trackId: string, fromIndex: number, toIndex: number) => void;
  onRemoveCustomTrackTypeOption: (trackId: string, index: number) => void;
  onDeleteCustomTrack: (trackId: string) => void;
  onCustomTrackBranchingEnabledChange: (trackId: string, enabled: boolean) => void;
  onCustomTrackBranchDisplayModeChange: (trackId: string, displayMode: TrackBranchDisplayMode) => void;
  onAddCustomTrackBranchLane: (trackId: string, parentLaneId: string | null) => void;
  onCustomTrackBranchLaneRename: (trackId: string, laneId: string, name: string) => void;
  onCustomTrackBranchLaneColorChange: (trackId: string, laneId: string, color: string) => void;
  onDeleteCustomTrackBranchLane: (trackId: string, laneId: string) => void;
  inspectorFocusRequest?: InspectorFocusRequest | null;
  onCustomBlockUpdate: (
    trackId: string,
    blockId: string,
    changes: {
      startTime?: number;
      endTime?: number;
      text?: string;
      type?: string;
      branchScope?: BranchScope;
    },
  ) => void;
  onDeleteSelected: () => void;
};

export function InspectorPanel({
  collapsed = false,
  onToggleCollapse,
  selectedItem,
  subtitleLines,
  sentenceAnnotationConfig,
  characterAnnotations,
  gongcheAnnotations,
  banyanSections,
  banyanMarks,
  banyanGridVisible,
  banyanTrackVisible,
  actionAnnotations,
  builtinTracks,
  customTracks,
  trackDefinitions,
  trackSnapEnabled,
  onCharacterUpdate,
  onLineClassificationChange,
  onOpenSentenceAnnotationSettings,
  onCreateGongcheBlock,
  onGongcheBlockUpdate,
  onImportGongcheText,
  onGenerateBanyanFromGongche,
  onBanyanGridVisibleChange,
  onBanyanTrackVisibleChange,
  onBanyanMarkUpdate,
  onActionUpdate,
  onAttachedPointUpdate,
  onTrackWaveformSnapChange,
  onTrackAutoLoopRangeChange,
  onAttachedPointTrackParentSnapChange,
  onSelectParentTrack,
  onBuiltinTrackRename,
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
  onCustomTrackColorChange,
  onCustomTrackTypeOptionChange,
  onAddCustomTrackTypeOption,
  onMoveCustomTrackTypeOption,
  onReorderCustomTrackTypeOption,
  onRemoveCustomTrackTypeOption,
  onDeleteCustomTrack,
  onCustomTrackBranchingEnabledChange,
  onCustomTrackBranchDisplayModeChange,
  onAddCustomTrackBranchLane,
  onCustomTrackBranchLaneRename,
  onCustomTrackBranchLaneColorChange,
  onDeleteCustomTrackBranchLane,
  inspectorFocusRequest,
  onCustomBlockUpdate,
  onDeleteSelected,
}: InspectorPanelProps) {
  const [trackNameDraft, setTrackNameDraft] = useState("");
  const [gongcheImportDraft, setGongcheImportDraft] = useState("");
  const [gongcheImportResult, setGongcheImportResult] = useState<string | null>(null);
  const [banyanGenerateResult, setBanyanGenerateResult] = useState<string | null>(null);
  const [gongcheImportPending, setGongcheImportPending] = useState(false);
  const [banyanGeneratePending, setBanyanGeneratePending] = useState(false);
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
  // 聚焦目标 → 真实 DOM 节点的注册表。右键菜单和顶栏搜索共用同一套目标标识，
  // 新增一个可跳转字段只需在 JSX 上挂 registerFocusField，不必再声明独立 ref。
  const focusFieldNodesRef = useRef(new Map<InspectorFocusTarget, HTMLElement>());
  const focusFieldSettersRef = useRef(new Map<InspectorFocusTarget, (element: HTMLElement | null) => void>());
  const [highlightedFocusTarget, setHighlightedFocusTarget] = useState<InspectorFocusRequest["target"] | null>(null);
  const inspectorFocusTimerRef = useRef<number | null>(null);
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
      selectedCustomTrack?.typeOptions ?? selectedAttachedPointTrack?.track.typeOptions ?? [],
    ),
    [selectedCustomTrack?.typeOptions, selectedAttachedPointTrack?.track.typeOptions],
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
  }, [selectedEditableTrack?.id, selectedCustomTrack?.typeOptions, selectedAttachedPointTrack?.track.typeOptions]);

  useEffect(() => {
    return () => {
      if (moveOptionHighlightTimerRef.current !== null) {
        window.clearTimeout(moveOptionHighlightTimerRef.current);
      }
      if (inspectorFocusTimerRef.current !== null) {
        window.clearTimeout(inspectorFocusTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!inspectorFocusRequest) {
      return;
    }
    const targetElement = focusFieldNodesRef.current.get(inspectorFocusRequest.target) ?? null;
    if (!targetElement) {
      return;
    }
    // 右键菜单和顶栏搜索都只负责把用户带到对应设置区；实际编辑仍交给 Inspector，避免复制一套表单。
    targetElement.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedFocusTarget(inspectorFocusRequest.target);
    if (inspectorFocusTimerRef.current !== null) {
      window.clearTimeout(inspectorFocusTimerRef.current);
    }
    inspectorFocusTimerRef.current = window.setTimeout(() => {
      setHighlightedFocusTarget((current) =>
        current === inspectorFocusRequest.target ? null : current,
      );
      inspectorFocusTimerRef.current = null;
    }, 1200);
  }, [inspectorFocusRequest]);

  // 为某个聚焦目标返回一个身份稳定的 ref 回调：缓存起来避免每次渲染都触发 detach/attach，
  // 在时间轴拖拽等高频重渲染场景下不产生额外开销。
  function registerFocusField(target: InspectorFocusTarget) {
    const cached = focusFieldSettersRef.current.get(target);
    if (cached) {
      return cached;
    }
    const setter = (element: HTMLElement | null) => {
      if (element) {
        focusFieldNodesRef.current.set(target, element);
      } else {
        focusFieldNodesRef.current.delete(target);
      }
    };
    focusFieldSettersRef.current.set(target, setter);
    return setter;
  }

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
    setBanyanGenerateResult(null);
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
        if (selectedCustomTrack) {
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

  if (selectedItem.type === "banyan-track") {
    return (
      <section className="panel inspector-panel banyan-settings-panel">
        <div className="panel-header">
          <div className="panel-header-copy">
            <h2>板眼设置</h2>
            <span>{banyanMarks.length} 个板眼点 · {banyanSections.length} 个区段</span>
          </div>
          {collapseButton ? <div className="panel-header-actions">{collapseButton}</div> : null}
        </div>
        <div className="spectrogram-settings-body banyan-settings-body">
          <div className="spectrogram-setting-group">
            <div className="spectrogram-setting-heading">
              <strong>显示</strong>
              <span>{banyanTrackVisible ? "板眼轨显示" : "板眼轨隐藏"}</span>
            </div>
            <ToggleRow
              label="板眼轨"
              description="关闭后从时间轴中移除；也可在音频波形设置中重新打开。"
              checked={banyanTrackVisible}
              onChange={onBanyanTrackVisibleChange}
            />
            <ToggleRow
              label="全局板眼纵线"
              description="在所有轨道背景中显示板眼参考线，用于对照波形、频谱和文字。"
              checked={banyanGridVisible}
              onChange={onBanyanGridVisibleChange}
            />
          </div>

          <div className="spectrogram-setting-group">
            <div className="spectrogram-setting-heading">
              <strong>从工尺谱生成</strong>
              <span>{gongcheAnnotations.length} 个工尺谱块</span>
            </div>
            <div className="banyan-generate-card">
              <div>
                <strong>板眼初稿</strong>
                <span>使用工尺谱符号中的 1/2/3/4 生成初稿，手动微调过的位置会保留。</span>
              </div>
              <button
                type="button"
                className="banyan-primary-button"
                onClick={async () => {
                  setBanyanGeneratePending(true);
                  try {
                    const result = await onGenerateBanyanFromGongche();
                    if (result) {
                      setBanyanGenerateResult(
                        `新增 ${result.created}，更新 ${result.updated}，保留手动 ${result.preserved}，失去来源 ${result.orphaned}`,
                      );
                    }
                  } finally {
                    setBanyanGeneratePending(false);
                  }
                }}
                disabled={gongcheAnnotations.length === 0 || banyanGeneratePending}
              >
                {banyanGeneratePending ? "生成中..." : "生成 / 重新生成"}
              </button>
            </div>
            {banyanGenerateResult ? (
              <div className="spectrogram-static-row banyan-result-row">
                <strong>生成结果</strong>
                <span>{banyanGenerateResult}</span>
              </div>
            ) : null}
          </div>

          <div className="spectrogram-setting-group">
            <div className="spectrogram-setting-heading">
              <strong>当前解释</strong>
              <span>一板三眼带赠板</span>
            </div>
            <div className="banyan-code-grid">
              <div><strong>1</strong><span>板</span></div>
              <div><strong>2</strong><span>小眼（头末眼）</span></div>
              <div><strong>3</strong><span>中眼</span></div>
              <div><strong>4</strong><span>赠板</span></div>
              <div><strong>5</strong><span>底板</span></div>
              <div><strong>6</strong><span>侧头末眼</span></div>
              <div><strong>7</strong><span>侧中眼</span></div>
              <div><strong>8</strong><span>腰赠板</span></div>
            </div>
            <p className="spectrogram-setting-help">生成结果只是初稿，可根据实际演奏继续拖动微调。</p>
          </div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "banyan-section") {
    const section = banyanSections.find((item) => item.id === selectedItem.id);
    if (!section) {
      return null;
    }
    return (
      <section className="panel inspector-panel banyan-settings-panel">
        <div className="panel-header">
          <div className="panel-header-copy">
            <h2>板眼区段</h2>
            <span>{section.name}</span>
          </div>
          {collapseButton ? <div className="panel-header-actions">{collapseButton}</div> : null}
        </div>
        <div className="spectrogram-settings-body banyan-settings-body">
          <div className="spectrogram-setting-group">
            <div className="spectrogram-setting-heading">
              <strong>区段信息</strong>
              <span>{section.cycleType}</span>
            </div>
            <div className="spectrogram-static-row">
              <strong>{section.name}</strong>
              <span>{section.startTime.toFixed(3)}s - {section.endTime.toFixed(3)}s</span>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "banyan-mark") {
    const mark = banyanMarks.find((item) => item.id === selectedItem.id);
    if (!mark) {
      return null;
    }
    const linkedGongcheBlock = mark.linkedGongcheAnnotationId
      ? gongcheAnnotations.find((item) => item.id === mark.linkedGongcheAnnotationId)
      : null;
    const linkedGongcheSymbol = mark.linkedGongcheSymbolId
      ? linkedGongcheBlock?.symbols.find((symbol) => symbol.id === mark.linkedGongcheSymbolId)
      : null;
    const section = mark.sectionId
      ? banyanSections.find((item) => item.id === mark.sectionId)
      : null;
    const subtypeOptions = getBanyanSubtypeOptionsForRole(mark.role);
    const selectedSubtype = subtypeOptions.includes(mark.subtype)
      ? mark.subtype
      : getDefaultBanyanSubtypeForRole(mark.role);

    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <div>
            <h2>板眼编辑</h2>
            <span>{getBanyanSubtypeLabel(mark.subtype)} · {getBanyanConfidenceLabel(mark.confidence)}</span>
          </div>
          <div className="panel-header-actions">
            {collapseButton}
            <button type="button" onClick={onDeleteSelected}>删除</button>
          </div>
        </div>
        <div className="inspector-field">
          <label>时间</label>
          <input
            type="number"
            step="0.001"
            value={mark.time}
            onChange={(event) => onBanyanMarkUpdate(mark.id, {
              time: Number(event.target.value),
              confidence: "manual",
            })}
          />
        </div>
        <div className="inspector-field">
          <label>原始估计</label>
          <div className="inspector-value">
            {mark.estimatedTime.toFixed(3)}s · 偏移 {(mark.time - mark.estimatedTime).toFixed(3)}s
          </div>
        </div>
        <div className="inspector-field">
          <label>角色</label>
          <select
            value={mark.role}
            onChange={(event) => {
              const nextRole = event.target.value as BanyanMark["role"];
              const nextSubtypeOptions = getBanyanSubtypeOptionsForRole(nextRole);
              onBanyanMarkUpdate(mark.id, {
                role: nextRole,
                subtype: nextSubtypeOptions.includes(mark.subtype)
                  ? mark.subtype
                  : getDefaultBanyanSubtypeForRole(nextRole),
                confidence: "manual",
              });
            }}
          >
            <option value="ban">板</option>
            <option value="yan">眼</option>
            <option value="auxiliary">辅助</option>
          </select>
        </div>
        <div className="inspector-field">
          <label>类型</label>
          <select
            value={selectedSubtype}
            onChange={(event) => onBanyanMarkUpdate(mark.id, {
              subtype: event.target.value as BanyanMark["subtype"],
              confidence: "manual",
            })}
          >
            {subtypeOptions.map((subtype) => (
              <option key={subtype} value={subtype}>{getBanyanSubtypeLabel(subtype)}</option>
            ))}
          </select>
        </div>
        <div className="inspector-field">
          <label>状态</label>
          <select
            value={mark.confidence}
            onChange={(event) => onBanyanMarkUpdate(mark.id, { confidence: event.target.value as BanyanMark["confidence"] })}
          >
            <option value="auto">自动</option>
            <option value="reviewed">已检查</option>
            <option value="manual">手动</option>
          </select>
        </div>
        <div className="inspector-field">
          <label>来源</label>
          <div className="inspector-value">
            {mark.sourceSymbol ? `源码 ${mark.sourceSymbol}` : "手动创建"}
            {linkedGongcheSymbol ? ` · ${linkedGongcheSymbol.rawText ?? linkedGongcheSymbol.label}` : ""}
            {mark.orphaned ? " · 来源已失效" : ""}
          </div>
        </div>
        <div className="inspector-field">
          <label>区段</label>
          <div className="inspector-value">{section?.name ?? "未绑定区段"}</div>
        </div>
        <div className="inspector-field">
          <label>备注</label>
          <textarea
            value={mark.comment ?? ""}
            onChange={(event) => onBanyanMarkUpdate(mark.id, { comment: event.target.value })}
          />
        </div>
        <div className="inspector-field">
          <label>摘要</label>
          <div className="inspector-value">
            {getBanyanRoleLabel(mark.role)} / {getBanyanSubtypeLabel(mark.subtype)} / {mark.segment}
          </div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "line") {
    const line = subtitleLines.find((item) => item.id === selectedItem.id);
    if (!line) {
      return null;
    }
    // 句级四声预览从该句下属逐字块派生，不复制存储，避免逐字编辑时产生同步问题。
    const tonePreview = buildLineTonePreview(line, characterAnnotations);
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
        <div className="inspector-field">
          <label>发声方式</label>
          <select
            value={line.deliveryMode ?? ""}
            onChange={(event) => onLineClassificationChange(line.id, {
              deliveryMode: event.target.value === "spoken" || event.target.value === "sung"
                ? event.target.value
                : null,
            })}
          >
            <option value="">未选择</option>
            {SENTENCE_DELIVERY_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="inspector-field">
          <label>角色行当</label>
          <select
            value={line.roleType ?? ""}
            onChange={(event) => onLineClassificationChange(line.id, {
              roleType: event.target.value || null,
            })}
          >
            <option value="">未选择</option>
            {sentenceAnnotationConfig.roleOptions.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={onOpenSentenceAnnotationSettings}>
            管理角色行当
          </button>
        </div>
        <div className="inspector-field">
          <label>四声预览</label>
          <div className="inspector-value tone-preview">
            {tonePreview.length === 0
              ? "该句暂无逐字块"
              : tonePreview.map((item, index) => (
                <span key={`${line.id}-${index}-${item.char}`} className="tone-preview-chip">
                  <span className="tone-preview-char">{item.char}</span>
                  <span className="tone-preview-label">{item.label}</span>
                </span>
              ))}
          </div>
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
    const trackOptions = "typeOptions" in track ? track.typeOptions : [];
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
    const isCustomTrack = selectedItem.type === "custom-track" && selectedCustomTrack !== null;
    const branchSummary = selectedCustomTrack ? getTrackBranchSummary(selectedCustomTrack) : null;
    const branchLanes = selectedCustomTrack?.branching?.lanes ?? [];
    const flattenedBranchLanes = flattenBranchLanes(branchLanes);
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
        <div
          ref={registerFocusField("track-name")}
          className={`inspector-field ${highlightedFocusTarget === "track-name" ? "inspector-field-focused" : ""}`.trim()}
        >
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
        {isBuiltinTrack && track.id === "character-track" ? (
          <div className="inspector-field">
            <label>句级角色行当</label>
            <button type="button" onClick={onOpenSentenceAnnotationSettings}>管理角色行当列表</button>
          </div>
        ) : null}
        {isCustomTrack && selectedCustomTrack ? (
          <div
            ref={registerFocusField("track-color")}
            className={`inspector-field ${highlightedFocusTarget === "track-color" ? "inspector-field-focused" : ""}`.trim()}
          >
            <label>轨道颜色</label>
            <TrackColorControl
              value={resolveCustomTrackColor(selectedCustomTrack)}
              onChange={(color) => onCustomTrackColorChange(selectedCustomTrack.id, color)}
            />
          </div>
        ) : null}
        {isCustomTrack && selectedCustomTrack ? (
          <div
            ref={registerFocusField("track-branching")}
            className={`inspector-field ${highlightedFocusTarget === "track-branching" ? "inspector-field-focused" : ""}`.trim()}
          >
            <label>递归分叉</label>
            <div className="branching-editor">
              <div className="inspector-toggle-row">
                <div className="inspector-toggle-copy">
                  <strong>启用轨道内分叉</strong>
                  <span>
                    {branchSummary
                      ? branchSummary.label
                      : "用于同一轨道内的层级标注，例如手/扇/身段等可自定义结构"}
                  </span>
                </div>
                <label className="inspector-switch">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedCustomTrack.branching?.enabled)}
                    onChange={(event) =>
                      onCustomTrackBranchingEnabledChange(selectedCustomTrack.id, event.target.checked)
                    }
                  />
                  <span className="inspector-switch-slider" />
                </label>
              </div>
              {selectedCustomTrack.branching?.enabled ? (
                <>
                  <div className="branching-mode-row">
                    <span>显示方式</span>
                    <select
                      value={selectedCustomTrack.branching.displayMode}
                      onChange={(event) =>
                        onCustomTrackBranchDisplayModeChange(
                          selectedCustomTrack.id,
                          event.target.value as TrackBranchDisplayMode,
                        )
                      }
                    >
                      <option value="merged">合并显示</option>
                      <option value="expanded">展开显示</option>
                    </select>
                  </div>
                  <div className="branching-tree">
                    {flattenedBranchLanes.length > 0 ? (
                      flattenedBranchLanes.map((lane) => (
                        <div
                          key={lane.id}
                          className="branching-lane-row"
                          style={{ "--branch-depth": lane.depth } as CSSProperties}
                        >
                          <TrackColorControl
                            value={normalizeHexColor(lane.color) ??
                              getBranchLaneColor(resolveCustomTrackColor(selectedCustomTrack), branchLanes, lane.parentId)}
                            compact
                            onChange={(color) =>
                              onCustomTrackBranchLaneColorChange(selectedCustomTrack.id, lane.id, color)
                            }
                          />
                          <input
                            defaultValue={lane.name}
                            onBlur={(event) =>
                              onCustomTrackBranchLaneRename(selectedCustomTrack.id, lane.id, event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                onCustomTrackBranchLaneRename(selectedCustomTrack.id, lane.id, event.currentTarget.value);
                                event.currentTarget.blur();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.value = lane.name;
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="branching-lane-action-button"
                            onClick={() => onAddCustomTrackBranchLane(selectedCustomTrack.id, lane.id)}
                          >
                            子分叉
                          </button>
                          <button
                            type="button"
                            className="branching-lane-action-button branching-danger-button"
                            onClick={() => {
                              const confirmed = window.confirm(`删除“${lane.name}”及其子分叉？相关标注会回到根轨。`);
                              if (confirmed) {
                                onDeleteCustomTrackBranchLane(selectedCustomTrack.id, lane.id);
                              }
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="branching-empty">
                        还没有分叉。新增时请按当前标注对象命名，不会默认假设为左右手。
                      </div>
                    )}
                  </div>
                  <div className="branching-actions">
                    <button
                      type="button"
                      onClick={() => onAddCustomTrackBranchLane(selectedCustomTrack.id, null)}
                    >
                      新增顶层分叉
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        <div
          ref={registerFocusField("track-waveform-snap")}
          className={`inspector-field ${highlightedFocusTarget === "track-waveform-snap" ? "inspector-field-focused" : ""}`.trim()}
        >
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
          <div
            ref={registerFocusField("track-auto-loop-range")}
            className={`inspector-field ${highlightedFocusTarget === "track-auto-loop-range" ? "inspector-field-focused" : ""}`.trim()}
          >
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
          <div
            ref={registerFocusField("track-parent-boundary-snap")}
            className={`inspector-field ${highlightedFocusTarget === "track-parent-boundary-snap" ? "inspector-field-focused" : ""}`.trim()}
          >
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
          <div
            ref={registerFocusField("track-attached-point-tracks")}
            className={`inspector-field ${highlightedFocusTarget === "track-attached-point-tracks" ? "inspector-field-focused" : ""}`.trim()}
          >
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
          <div
            ref={registerFocusField("track-gongche-import")}
            className={`inspector-field ${highlightedFocusTarget === "track-gongche-import" ? "inspector-field-focused" : ""}`.trim()}
          >
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
                  onClick={async () => {
                    setGongcheImportPending(true);
                    try {
                      const result = await onImportGongcheText(track.id, gongcheImportDraft);
                      if (result) {
                        setGongcheImportResult(
                          `解析 ${result.parsed} 条，导入 ${result.imported} 条，更新 ${result.updated} 条，未匹配 ${result.unmatched} 条。`,
                        );
                      }
                    } finally {
                      setGongcheImportPending(false);
                    }
                  }}
                  disabled={!gongcheImportDraft.trim() || gongcheImportPending}
                >
                  {gongcheImportPending ? "导入中..." : "导入到工尺谱附属轨"}
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
        {!isBuiltinTrack ? <div
          ref={registerFocusField("track-type-options")}
          className={`inspector-field ${highlightedFocusTarget === "track-type-options" ? "inspector-field-focused" : ""}`.trim()}
        >
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
                      if (isAttachedPointTrack) {
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
                      if (isAttachedPointTrack) {
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
                      if (isAttachedPointTrack) {
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
              if (isAttachedPointTrack) {
                onAddAttachedPointTrackTypeOption(track.id);
              } else {
                onAddCustomTrackTypeOption(track.id);
              }
            }}>
              新增类型
            </button>
          </div>
        </div> : null}
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
          <label>四声信息</label>
          <select
            value={getToneSelectValue(item.tone)}
            onChange={(event) =>
              onCharacterUpdate(item.id, {
                tone: getToneInfoForSelectValue(event.target.value),
              })
            }
          >
            {TONE_SELECT_OPTIONS.map((option) => (
              <option key={option.value || "none"} value={option.value}>
                {option.label}
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
    const previewSymbols = block.symbols.length > 0
      ? block.symbols
      : [{
          id: `${block.id}-preview-empty`,
          label: "工",
          startTime: block.startTime,
          endTime: block.endTime,
          assetUrl: null,
        }];
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
        symbols: redistributeGongcheSymbolSequence(
          block.symbols.filter((symbol) => symbol.id !== symbolId),
          block.startTime,
          block.endTime,
        ),
      });
    };
    const addSymbol = () => {
      onGongcheBlockUpdate(block.id, {
        symbols: redistributeGongcheSymbolSequence(
          [...block.symbols, createDefaultGongcheSymbol(block.startTime, block.endTime)],
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
          <label>单字渲染预览</label>
          <div className="gongche-render-preview">
            <GongcheCharacterRenderer
              character={parent?.label ?? "字"}
              symbols={previewSymbols}
              startTime={block.startTime}
              endTime={block.endTime}
            />
          </div>
        </div>
        <div className="inspector-field">
          <label>快速输入</label>
          <input
            value={symbolsText}
            onChange={(event) =>
              onGongcheBlockUpdate(block.id, {
                symbols: reconcileGongcheSymbolLabels(
                  block.symbols,
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
    const blockBranchLanes = track.branching?.enabled ? flattenBranchLanes(track.branching.lanes) : [];
    const blockBranchScope = block.branchScope ?? { mode: "root" as const };
    const selectedBranchLaneIds = blockBranchScope.mode === "lanes" ? blockBranchScope.laneIds : [];
    const updateBlockBranchLane = (laneId: string, checked: boolean) => {
      const nextLaneIds = checked
        ? Array.from(new Set([...selectedBranchLaneIds, laneId]))
        : selectedBranchLaneIds.filter((id) => id !== laneId);
      onCustomBlockUpdate(track.id, block.id, {
        branchScope: nextLaneIds.length > 0 ? { mode: "lanes", laneIds: nextLaneIds } : { mode: "root" },
      });
    };
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
        {track.branching?.enabled ? (
          <div
            ref={registerFocusField("block-branch-scope")}
            className={`inspector-field ${highlightedFocusTarget === "block-branch-scope" ? "inspector-field-focused" : ""}`.trim()}
          >
            <label>分叉归属</label>
            <div className="branch-scope-editor">
              <label className="branch-scope-option branch-scope-root">
                <input
                  type="radio"
                  checked={blockBranchScope.mode === "root"}
                  onChange={() => onCustomBlockUpdate(track.id, block.id, { branchScope: { mode: "root" } })}
                />
                <span className="branch-scope-option-label">{track.branching.rootLabel ?? "全轨"} / 未细分</span>
              </label>
              {blockBranchLanes.length > 0 ? (
                <div className="branch-scope-lane-list">
                  {blockBranchLanes.map((lane) => (
                    <label
                      key={lane.id}
                      className="branch-scope-option branch-scope-lane"
                      style={{ "--branch-depth": lane.depth } as CSSProperties}
                    >
                      <input
                        type="checkbox"
                        checked={selectedBranchLaneIds.includes(lane.id)}
                        onChange={(event) => updateBlockBranchLane(lane.id, event.target.checked)}
                      />
                      <span className="branch-scope-option-label">{lane.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="branching-empty">
                  当前轨道已启用分叉，但还没有分支。请先在轨道设置中新增分叉。
                </div>
              )}
              <p className="branch-scope-help">
                勾选多个分叉表示该标注块由这些分叉共有；选择根轨则表示暂不细分。
              </p>
            </div>
          </div>
        ) : null}
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
          {[action.label].map((label) => (
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
  return "typeOptions" in track ? track.typeOptions : [];
}

type TrackColorControlProps = {
  value: string;
  compact?: boolean;
  onChange: (color: string) => void;
};

type TrackColorPickerMode = "quick" | "custom";

function TrackColorControl({ value, compact = false, onChange }: TrackColorControlProps) {
  const normalizedValue = normalizeHexColor(value) ?? DEFAULT_TRACK_COLORS[0];
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<TrackColorPickerMode>("quick");
  useDismissiblePopover(rootRef, isOpen, () => setIsOpen(false));

  const commitColor = (color: string) => {
    const normalizedColor = normalizeHexColor(color) ?? normalizeHexColor(`#${color}`);
    if (normalizedColor) {
      onChange(normalizedColor);
    }
  };

  const commitQuickColor = (color: string) => {
    commitColor(color);
    setIsOpen(false);
  };

  return (
    <div ref={rootRef} className={`track-color-control ${compact ? "compact" : ""}`}>
      <div className="track-color-picker">
        <button
          type="button"
          className="track-color-trigger"
          title="调整颜色"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
        >
          <span
            className="track-color-swatch"
            style={{ background: normalizedValue }}
          />
        </button>
        {isOpen ? (
          <div className="track-color-picker-popover" role="dialog" aria-label="轨道颜色选择">
            <div className="track-color-picker-tabs" role="tablist" aria-label="颜色选择方式">
              <button
                type="button"
                className={pickerMode === "quick" ? "active" : ""}
                onClick={() => setPickerMode("quick")}
              >
                快速
              </button>
              <button
                type="button"
                className={pickerMode === "custom" ? "active" : ""}
                onClick={() => setPickerMode("custom")}
              >
                自定义
              </button>
            </div>
            {pickerMode === "quick" ? (
              <TrackQuickColorPalette
                value={normalizedValue}
                onChange={commitQuickColor}
              />
            ) : (
              <div className="track-color-custom-panel">
                <HexColorPicker color={normalizedValue} onChange={commitColor} />
                <HexColorInput
                  className="track-color-input popover-input"
                  color={normalizedValue}
                  prefixed
                  onChange={commitColor}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
      <HexColorInput
        className="track-color-input"
        color={normalizedValue}
        prefixed
        onChange={commitColor}
      />
    </div>
  );
}

function useDismissiblePopover(
  rootRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const rootElement = rootRef.current;
      // 颜色面板内部需要支持拖动色盘和连续点击色块；只有真正点到外部才关闭。
      if (!rootElement || !rootElement.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onDismiss, rootRef]);
}

function TrackQuickColorPalette({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="track-color-quick-panel">
      <div className="track-color-palette-title">主题颜色</div>
      <div className="track-color-theme-grid">
        {QUICK_TRACK_COLOR_PALETTE.map((row, rowIndex) =>
          row.map((color, columnIndex) => (
            <button
              key={`${rowIndex}-${columnIndex}-${color}`}
              type="button"
              className={color === value ? "active" : ""}
              style={{ background: color }}
              title={color}
              aria-label={`使用主题颜色 ${color}`}
              onClick={() => onChange(color)}
            />
          ))
        )}
      </div>
      <div className="track-color-palette-title">标准颜色</div>
      <div className="track-color-standard-grid">
        {STANDARD_TRACK_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={color === value ? "active" : ""}
            style={{ background: color }}
            title={color}
            aria-label={`使用标准颜色 ${color}`}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
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
