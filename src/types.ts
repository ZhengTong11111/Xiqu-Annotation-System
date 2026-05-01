export type SingingStyle = string;

export type BuiltinTrackId = "character-track" | "hand-action" | "body-action";
export type CustomTrackType = "text" | "action";
export type BuiltinTrackType = "character" | "action";

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
};

export type CustomActionTrackBlock = {
  id: string;
  startTime: number;
  endTime: number;
  type: string;
};

export type CustomTextTrack = {
  id: string;
  name: string;
  trackType: "text";
  typeOptions: string[];
  blocks: CustomTextTrackBlock[];
  attachedPointTracks: AttachedPointTrack[];
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
  type: "character" | "action" | "custom-text" | "custom-action" | "attached-point" | "gongche-attached";
  options?: string[];
  isCustom?: boolean;
  isBuiltin?: boolean;
  isAttachedPointTrack?: boolean;
  isGongcheTrack?: boolean;
  parentTrackId?: string;
  parentTrackName?: string;
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
  actionAnnotations: ActionAnnotation[];
  builtinTracks: BuiltinTrack[];
  customTracks: CustomTrack[];
  activeTrackOrder: string[];
};

export type SavedProjectFile = {
  version: 1 | 2;
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
    };

export type TimelineBatchMoveItem = TimelineSelectionItem & {
  startTime: number;
  endTime: number;
};
