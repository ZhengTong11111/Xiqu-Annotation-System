export type SingingStyle =
  | "普通唱"
  | "拖腔"
  | "顿音"
  | "装饰音"
  | "念白式"
  | "其他";

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

export type TrackDefinition = {
  id: string;
  name: string;
  type: "character" | "action";
  labels?: string[];
};

export type ProjectData = {
  videoUrl: string;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
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
  | null;

export type TimelineSelectionItem = {
  type: "character" | "action";
  id: string;
};

export type TimelineBatchMoveItem = TimelineSelectionItem & {
  startTime: number;
  endTime: number;
};
