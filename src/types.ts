import type {
  BranchScope,
  BuiltinTrackId,
  CustomTrackType,
  TrackBranching,
} from "@xiqu/document-model";

// 兼容现有 Web 导入路径：持久化领域类型的唯一实现位于 document-model，本文件不再复制定义。
export type {
  ActionAnnotation,
  AttachedPointAnnotation,
  AttachedPointTrack,
  BanyanAttachment,
  BanyanConfidence,
  BanyanCycleType,
  BanyanMark,
  BanyanRole,
  BanyanSection,
  BanyanSegment,
  BanyanSubtype,
  BranchLane,
  BranchScope,
  BuiltinTrack,
  BuiltinTrackId,
  BuiltinTrackType,
  CharacterAnnotation,
  CharacterToneInfo,
  CustomActionTrack,
  CustomActionTrackBlock,
  CustomTextTrack,
  CustomTextTrackBlock,
  CustomTrack,
  CustomTrackType,
  GongcheAnnotation,
  GongcheSymbol,
  ProjectData,
  ProjectVideo,
  SavedProjectFile,
  SingingStyle,
  SubtitleLine,
  ToneBase,
  ToneClass,
  ToneYinYang,
  TrackBranchDisplayMode,
  TrackBranching,
  YxlzShangSubtype,
} from "@xiqu/document-model";

// 聚焦目标覆盖右侧「属性 / 轨道设置」列的两个面板：InspectorPanel 的轨道字段和
// SpectrogramSettingsPanel 的音频分析分组。右键菜单和顶栏搜索共用同一套目标标识，
// 避免为「跳到某个设置项」再写第二套导航机制。
export type InspectorFocusTarget =
  // InspectorPanel：块级与轨道级设置字段
  | "track-branching"
  | "block-branch-scope"
  | "track-name"
  | "track-color"
  | "track-waveform-snap"
  | "track-auto-loop-range"
  | "track-parent-boundary-snap"
  | "track-type-options"
  | "track-attached-point-tracks"
  | "track-gongche-import"
  // SpectrogramSettingsPanel：音频波形 / 频谱 / 分析设置分组
  | "audio-analysis-source"
  | "audio-waveform-visible"
  | "audio-spectrogram-visible"
  | "audio-pitch-contour"
  | "audio-frequency-scale"
  | "audio-frequency-preset"
  | "audio-analysis-preset";

// Inspector 聚焦请求只服务当前 React 会话，不属于可保存项目内容。
export type InspectorFocusRequest = {
  target: InspectorFocusTarget;
  requestId: number;
};

// 时间轴派生模型把持久块补充为可直接渲染的轨道上下文，但不回写项目文件。
export type ResolvedCustomTrackBlock = {
  id: string;
  trackId: string;
  trackType: CustomTrackType;
  startTime: number;
  endTime: number;
  type: string;
  text?: string;
  branchScope?: BranchScope;
  branchGroupId?: string;
  branchParentBlockId?: string;
};

export type TrackDefinition = {
  id: string;
  name: string;
  type: "character" | "action" | "custom-text" | "custom-action" | "attached-point" | "gongche-attached" | "branch-lane";
  options?: string[];
  isCustom?: boolean;
  isBuiltin?: boolean;
  isAttachedPointTrack?: boolean;
  isGongcheTrack?: boolean;
  isBranchLaneTrack?: boolean;
  parentTrackId?: string;
  parentTrackName?: string;
  branchLaneId?: string;
  branchDepth?: number;
  branchTrackType?: CustomTrackType;
  branching?: TrackBranching;
  color?: string;
};

// 波形与频谱数据是浏览器分析缓存，体积大且可重算，不能进入 ProjectData 或平台 payload。
export type WaveformData = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  keypoints: number[];
  timeOffset?: number;
};

export type SpectrogramFrequencyScale = "linear" | "log" | "mel";
export type SpectrogramFrequencyPreset = "full-vocal" | "vocal-2000" | "vocal-1500";
export type SpectrogramAnalysisPreset = "time-detail" | "frequency-detail";

export type SpectrogramSettings = {
  visible: boolean;
  showPitchContour: boolean;
  frequencyScale: SpectrogramFrequencyScale;
  frequencyPreset: SpectrogramFrequencyPreset;
  analysisPreset: SpectrogramAnalysisPreset;
};

export type SpectrogramAnalysisConfig = {
  analysisPreset: SpectrogramAnalysisPreset;
  fftSize: number;
  hopLength: number;
  windowType: "hann";
  minFrequency: number;
  maxFrequency: number;
  dynamicRangeDb: number;
  analysisSampleRate: number;
  outputFrequencyBinCount: number;
};

export type PitchFrame = {
  time: number;
  frequency: number;
  confidence: number;
  voiced: boolean;
};

export type SpectrogramData = {
  magnitudes: Uint8Array;
  frequencyBins: Float32Array;
  frameCount: number;
  frequencyBinCount: number;
  sampleRate: number;
  duration: number;
  timeOffset?: number;
  hopLength: number;
  fftSize: number;
  minFrequency: number;
  maxFrequency: number;
  dbMin: number;
  dbMax: number;
  analysisPreset: SpectrogramAnalysisPreset;
  pitchFrames?: PitchFrame[];
};

// 选择类型只描述当前编辑器交互；分叉 lane 上下文尤其不能持久化回块的 branchScope。
export type SelectedItem =
  | { type: "line"; id: string }
  | { type: "character"; id: string }
  | { type: "action"; id: string }
  | { type: "builtin-track"; id: BuiltinTrackId }
  | { type: "custom-track"; id: string }
  | { type: "attached-point-track"; id: string; parentTrackId: string }
  | { type: "gongche-track"; parentTrackId: string }
  | { type: "banyan-track" }
  | { type: "banyan-section"; id: string }
  | { type: "banyan-mark"; id: string }
  | { type: "waveform-track" }
  | { type: "spectrogram-track" }
  | { type: "custom-block"; id: string; trackId: string; branchLaneId?: string }
  | { type: "gongche-block"; id: string }
  | { type: "attached-point"; id: string; trackId: string; parentTrackId: string }
  | null;

export type TimelineSelectionItem =
  | { type: "character"; id: string }
  | { type: "action"; id: string }
  | { type: "attached-point"; id: string; trackId: string; parentTrackId: string }
  | { type: "custom-block"; id: string; trackId: string; branchLaneId?: string }
  | { type: "banyan-mark"; id: string };

export type TimelineBatchMoveItem = TimelineSelectionItem & {
  startTime: number;
  endTime: number;
};
