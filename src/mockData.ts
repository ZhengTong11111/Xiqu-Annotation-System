import type { ProjectData, SubtitleLine } from "./types";
import { buildProjectFromLines } from "./utils/project";

const MOCK_TIMELINE_STRETCH = 8;

const baseMockLines: SubtitleLine[] = [
  {
    id: "line-1",
    text: "春江花月夜",
    startTime: 12.4,
    endTime: 16.8,
    deliveryMode: "sung",
    roleType: "闺门旦",
  },
  {
    id: "line-2",
    text: "良辰美景天",
    startTime: 17.2,
    endTime: 20.5,
    deliveryMode: "spoken",
    roleType: "巾生",
  },
  {
    id: "line-3",
    text: "水袖轻翻意未歇",
    startTime: 21.1,
    endTime: 25.9,
    deliveryMode: null,
    roleType: null,
  },
];

const baseMockActions = [
  {
    id: "hand-1",
    trackId: "custom-track-demo-hand",
    label: "抬手",
    startTime: 13.2,
    endTime: 14.1,
  },
  {
    id: "hand-2",
    trackId: "custom-track-demo-hand",
    label: "翻腕",
    startTime: 14.3,
    endTime: 15.0,
  },
  {
    id: "body-1",
    trackId: "custom-track-demo-body",
    label: "转身",
    startTime: 18.0,
    endTime: 19.1,
  },
];

const mockAnchorTime = baseMockLines[0]?.startTime ?? 0;

function stretchTime(time: number) {
  return mockAnchorTime + (time - mockAnchorTime) * MOCK_TIMELINE_STRETCH;
}

const mockLines = baseMockLines.map((line) => ({
  ...line,
  startTime: stretchTime(line.startTime),
  endTime: stretchTime(line.endTime),
}));

const mockActions = baseMockActions.map((action) => ({
  ...action,
  startTime: stretchTime(action.startTime),
  endTime: stretchTime(action.endTime),
}));

export const mockProject: ProjectData = {
  ...buildProjectFromLines(
    mockLines,
    {
      url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      name: "flower.mp4",
      source: "url",
    },
  ),
  sentenceAnnotationConfig: { roleOptions: ["闺门旦", "巾生"] },
  customTracks: [
    {
      id: "custom-track-demo-hand",
      name: "手部动作轨",
      trackType: "action",
      typeOptions: ["抬手", "落手", "指向", "翻腕", "水袖动作", "其他"],
      blocks: mockActions
        .filter((action) => action.trackId === "custom-track-demo-hand")
        .map((action) => ({
          id: action.id,
          startTime: action.startTime,
          endTime: action.endTime,
          type: action.label,
        })),
      attachedPointTracks: [],
      attachedPointTracksExpanded: false,
      snapToWaveformKeypoints: false,
      autoSetLoopRangeOnSelect: false,
    },
    {
      id: "custom-track-demo-body",
      name: "肢体动作轨",
      trackType: "action",
      typeOptions: ["转身", "移步", "屈伸", "亮相", "前倾", "后仰", "其他"],
      blocks: mockActions
        .filter((action) => action.trackId === "custom-track-demo-body")
        .map((action) => ({
          id: action.id,
          startTime: action.startTime,
          endTime: action.endTime,
          type: action.label,
        })),
      attachedPointTracks: [],
      attachedPointTracksExpanded: false,
      snapToWaveformKeypoints: false,
      autoSetLoopRangeOnSelect: false,
    },
  ],
  activeTrackOrder: [
    "character-track",
    "custom-track-demo-hand",
    "custom-track-demo-body",
  ],
};
