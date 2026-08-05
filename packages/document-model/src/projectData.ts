// 本模块只描述可写入本地 JSON 或平台标注文件 payload 的领域数据。
// React 选择状态、波形/频谱缓存和平台 revision/ACL 必须留在各自运行时边界，不能反向进入持久文档。

// 《韵学骊珠》四声阴阳体系以八类为主；上声另保留原书“阴阳通用”等细分信息。
export type SingingStyle = string;
export type ToneBase = "ping" | "shang" | "qu" | "ru";
export type ToneYinYang = "yin" | "yang";
export type ToneClass =
  | "yin_ping"
  | "yang_ping"
  | "yin_shang"
  | "yang_shang"
  | "yin_qu"
  | "yang_qu"
  | "yin_ru"
  | "yang_ru";
export type YxlzShangSubtype = "yin_shang" | "yang_shang" | "yinyang_tongyong";

export type CharacterToneInfo = {
  toneClass: ToneClass;
  // 非上声不应保存该字段；导入归一化负责清除历史残留值。
  yxlzShangSubtype?: YxlzShangSubtype;
};

// 轨道分叉使用递归树和“根轨/多个分支共有”作用域，支持多层分叉和跨分支共有块。
export type BuiltinTrackId = "character-track";
export type CustomTrackType = "text" | "action";
export type BuiltinTrackType = "character" | "action";

export type BranchScope =
  | { mode: "root" }
  | {
      mode: "lanes";
      laneIds: string[];
    };

export type BranchLane = {
  id: string;
  name: string;
  parentId: string | null;
  color?: string;
  children?: BranchLane[];
};

export type TrackBranchDisplayMode = "merged" | "expanded";

export type TrackBranching = {
  enabled: boolean;
  rootLabel?: string;
  displayMode: TrackBranchDisplayMode;
  lanes: BranchLane[];
};

// 附属打点轨和字幕/逐字标注是多个领域轨道共同引用的基础实体。
export type AttachedPointAnnotation = {
  id: string;
  time: number;
  label: string;
};

export type AttachedPointTrack = {
  id: string;
  name: string;
  typeOptions: string[];
  points: AttachedPointAnnotation[];
  snapToWaveformKeypoints?: boolean;
  snapToParentBoundaries?: boolean;
  autoSetLoopRangeOnSelect?: boolean;
};

export type SubtitleLine = {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
};

export type CharacterAnnotation = {
  id: string;
  lineId: string;
  char: string;
  startTime: number;
  endTime: number;
  singingStyle: SingingStyle;
  // null 表示明确未标注；旧文件缺少字段时由导入归一化补为 null。
  tone?: CharacterToneInfo | null;
};

// 工尺块保存原始记谱信息、稳定符号身份和可选未来字形资源引用。
export type GongcheSymbol = {
  id: string;
  label: string;
  notation?: string;
  rawText?: string;
  parenthesized?: boolean;
  startTime: number;
  endTime: number;
  assetUrl?: string | null;
};

export type GongcheAnnotation = {
  id: string;
  parentTrackId: string;
  parentBlockId: string;
  startTime: number;
  endTime: number;
  symbols: GongcheSymbol[];
};

// 板眼模型同时保存乐理分类、来源定位和人工校正信息，供自动解析后继续审校。
export type BanyanCycleType =
  | "sanban"
  | "liushuiban"
  | "yi_ban_yi_yan"
  | "yi_ban_yi_yan_zeng"
  | "yi_ban_san_yan"
  | "yi_ban_san_yan_zeng"
  | "custom";

export type BanyanRole = "ban" | "yan" | "auxiliary";

export type BanyanSubtype =
  | "mainBan"
  | "headBan"
  | "waistBan"
  | "bottomBan"
  | "zengBan"
  | "waistZengBan"
  | "middleEye"
  | "smallEye"
  | "sideHeadTailEye"
  | "sideMiddleEye"
  | "phraseBoundary"
  | "unknown";

export type BanyanSegment = "main" | "zeng" | "free" | "unknown";
export type BanyanAttachment = "on_note" | "in_between" | "at_phrase_end" | "unknown";
export type BanyanConfidence = "auto" | "reviewed" | "manual";

export type BanyanSection = {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  cycleType: BanyanCycleType;
  freeRhythm: boolean;
  beatCount?: number;
  hasZengBan?: boolean;
  source?: string;
  comment?: string;
};

export type BanyanMark = {
  id: string;
  sectionId?: string | null;
  time: number;
  estimatedTime: number;
  sourceSymbol: string;
  sourceTokenIndex?: number;
  sourceKey?: string;
  role: BanyanRole;
  subtype: BanyanSubtype;
  segment: BanyanSegment;
  beatIndex?: number | null;
  cycleIndex?: number | null;
  strength?: "strong" | "medium" | "weak" | "unknown";
  attachment: BanyanAttachment;
  linkedGongcheAnnotationId?: string | null;
  linkedGongcheSymbolId?: string | null;
  linkedGongcheSymbolIds?: string[];
  confidence: BanyanConfidence;
  manualOffset?: number;
  durationHint?: string | null;
  orphaned?: boolean;
  comment?: string;
};

// 动作和自定义轨道块保持现有平面实体格式；递归归属由 branchScope 连接到轨道分叉树。
export type ActionAnnotation = {
  id: string;
  trackId: string;
  label: string;
  startTime: number;
  endTime: number;
};

export type CustomTextTrackBlock = {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  type: string;
  branchScope?: BranchScope;
  branchGroupId?: string;
  branchParentBlockId?: string;
};

export type CustomActionTrackBlock = {
  id: string;
  startTime: number;
  endTime: number;
  type: string;
  branchScope?: BranchScope;
  branchGroupId?: string;
  branchParentBlockId?: string;
};

export type CustomTextTrack = {
  id: string;
  name: string;
  trackType: "text";
  color?: string;
  typeOptions: string[];
  blocks: CustomTextTrackBlock[];
  attachedPointTracks: AttachedPointTrack[];
  branching?: TrackBranching;
  attachedPointTracksExpanded?: boolean;
  snapToWaveformKeypoints?: boolean;
  autoSetLoopRangeOnSelect?: boolean;
};

export type CustomActionTrack = {
  id: string;
  name: string;
  trackType: "action";
  color?: string;
  typeOptions: string[];
  blocks: CustomActionTrackBlock[];
  attachedPointTracks: AttachedPointTrack[];
  branching?: TrackBranching;
  attachedPointTracksExpanded?: boolean;
  snapToWaveformKeypoints?: boolean;
  autoSetLoopRangeOnSelect?: boolean;
};

export type CustomTrack = CustomTextTrack | CustomActionTrack;

export type BuiltinTrack = {
  id: BuiltinTrackId;
  name: string;
  type: BuiltinTrackType;
  options?: string[];
  attachedPointTracks: AttachedPointTrack[];
  attachedPointTracksExpanded?: boolean;
  snapToWaveformKeypoints?: boolean;
  autoSetLoopRangeOnSelect?: boolean;
};

// ProjectData 是本地编辑器和平台标注文件共同使用的权威内容模型，不包含服务器治理元数据。
export type ProjectVideo = {
  url: string;
  name: string | null;
  source: "url" | "embedded";
  filePath?: string | null;
  requiresManualImport?: boolean;
};

export type ProjectData = {
  video: ProjectVideo;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  gongcheAnnotations: GongcheAnnotation[];
  banyanSections: BanyanSection[];
  banyanMarks: BanyanMark[];
  actionAnnotations: ActionAnnotation[];
  builtinTracks: BuiltinTrack[];
  customTracks: CustomTrack[];
  activeTrackOrder: string[];
};

// SavedProjectFile 是本地 JSON 外层；uiState 只保存可恢复的编辑视图偏好，不代表平台 revision。
export type SavedProjectFile = {
  version: 1 | 2 | 3 | 4 | 5;
  project: ProjectData;
  uiState?: {
    zoom?: number;
    currentTime?: number;
    playbackRate?: number;
    trackSnapEnabled?: Record<string, boolean>;
    loopPlaybackEnabled?: boolean;
    loopPlaybackRange?: { start: number; end: number } | null;
  };
};
