export type SingingStyle = string;

export type BuiltinTrackId = "character-track";
export type CustomTrackType = "text" | "action";
export type BuiltinTrackType = "character" | "action";

// 分叉归属刻意用“根轨/多个分支”表达，而不是单一 branchId：
// 有些标注块属于整条轨道，有些标注块可能由多个下层分叉共同拥有。
export type BranchScope =
  | {
      mode: "root";
    }
  | {
      mode: "lanes";
      laneIds: string[];
    };

// BranchLane 是递归树节点。parentId 便于扁平化渲染和未来局部展开，
// children 保留完整层级关系，支持“手 -> 扇 -> 扇面”等继续细分。
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
};

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
  typeOptions: string[];
  blocks: CustomActionTrackBlock[];
  attachedPointTracks: AttachedPointTrack[];
  branching?: TrackBranching;
  attachedPointTracksExpanded?: boolean;
  snapToWaveformKeypoints?: boolean;
  autoSetLoopRangeOnSelect?: boolean;
};

export type CustomTrack = CustomTextTrack | CustomActionTrack;

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
};

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

export type SavedProjectFile = {
  version: 1 | 2 | 3 | 4;
  project: ProjectData;
  uiState?: {
    zoom?: number;
    currentTime?: number;
    playbackRate?: number;
    trackSnapEnabled?: Record<string, boolean>;
    loopPlaybackEnabled?: boolean;
    loopPlaybackRange?: {
      start: number;
      end: number;
    } | null;
  };
};

export type WaveformData = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  keypoints: number[];
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
  hopLength: number;
  fftSize: number;
  minFrequency: number;
  maxFrequency: number;
  dbMin: number;
  dbMax: number;
  analysisPreset: SpectrogramAnalysisPreset;
  pitchFrames?: PitchFrame[];
};

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
  | { type: "custom-block"; id: string; trackId: string }
  | { type: "gongche-block"; id: string }
  | { type: "attached-point"; id: string; trackId: string; parentTrackId: string }
  | null;

export type TimelineSelectionItem =
  | {
      type: "character";
      id: string;
    }
  | {
      type: "action";
      id: string;
    }
  | {
      type: "attached-point";
      id: string;
      trackId: string;
      parentTrackId: string;
    }
  | {
      type: "custom-block";
      id: string;
      trackId: string;
    }
  | {
      type: "banyan-mark";
      id: string;
    };

export type TimelineBatchMoveItem = TimelineSelectionItem & {
  startTime: number;
  endTime: number;
};
