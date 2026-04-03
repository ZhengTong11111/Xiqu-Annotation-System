export type SingingStyle = string;

export type BuiltinTrackId = "character-track" | "hand-action" | "body-action";
export type CustomTrackType = "text" | "action";
export type BuiltinTrackType = "character" | "action";

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
};

export type CustomActionTrack = {
  id: string;
  name: string;
  trackType: "action";
  typeOptions: string[];
  blocks: CustomActionTrackBlock[];
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
};

export type TrackDefinition = {
  id: string;
  name: string;
  type: "character" | "action" | "custom-text" | "custom-action";
  options?: string[];
  isCustom?: boolean;
  isBuiltin?: boolean;
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
  };
};

export type WaveformData = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
};

export type SelectedItem =
  | { type: "line"; id: string }
  | { type: "character"; id: string }
  | { type: "action"; id: string }
  | { type: "builtin-track"; id: BuiltinTrackId }
  | { type: "custom-track"; id: string }
  | { type: "custom-block"; id: string; trackId: string }
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
      type: "custom-block";
      id: string;
      trackId: string;
    };

export type TimelineBatchMoveItem = TimelineSelectionItem & {
  startTime: number;
  endTime: number;
};
