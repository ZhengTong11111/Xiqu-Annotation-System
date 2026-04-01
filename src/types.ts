export type SingingStyle =
  | "普通唱"
  | "拖腔"
  | "顿音"
  | "装饰音"
  | "念白式"
  | "其他";

export type CustomTrackType = "text" | "action";

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

export type TrackDefinition = {
  id: string;
  name: string;
  type: "character" | "action" | "custom-text" | "custom-action";
  options?: string[];
  isCustom?: boolean;
};

export type ProjectData = {
  videoUrl: string;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  customTracks: CustomTrack[];
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
