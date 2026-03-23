import type { ProjectData } from "./types";
import { buildProjectFromLines } from "./utils/project";

const mockLines = [
  {
    id: "line-1",
    text: "春江花月夜",
    startTime: 12.4,
    endTime: 16.8,
  },
  {
    id: "line-2",
    text: "良辰美景天",
    startTime: 17.2,
    endTime: 20.5,
  },
  {
    id: "line-3",
    text: "水袖轻翻意未歇",
    startTime: 21.1,
    endTime: 25.9,
  },
];

export const mockProject: ProjectData = {
  ...buildProjectFromLines(
    mockLines,
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  ),
  actionAnnotations: [
    {
      id: "hand-1",
      trackId: "hand-action",
      label: "抬手",
      startTime: 13.2,
      endTime: 14.1,
    },
    {
      id: "hand-2",
      trackId: "hand-action",
      label: "翻腕",
      startTime: 14.3,
      endTime: 15.0,
    },
    {
      id: "body-1",
      trackId: "body-action",
      label: "转身",
      startTime: 18.0,
      endTime: 19.1,
    },
  ],
};
