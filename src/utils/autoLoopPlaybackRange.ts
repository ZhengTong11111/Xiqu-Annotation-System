import type { ProjectData, SelectedItem } from "../types";

export type AutoLoopPlaybackRange = {
  start: number;
  end: number;
};

function createValidLoopRange(start: number, end: number): AutoLoopPlaybackRange | null {
  return end - start > 0.001 ? { start, end } : null;
}

// 只读取当前选中项和对应轨道设置，不修改项目数据，也不处理循环播放开关。
// 选中事件与项目时间变化都调用这个函数，避免两条路径各自维护一套查找逻辑。
export function getAutoLoopPlaybackRangeForSelection(
  project: ProjectData,
  selectedItem: SelectedItem,
): AutoLoopPlaybackRange | null {
  if (!selectedItem) return null;

  if (selectedItem.type === "line") {
    const line = project.subtitleLines.find((item) => item.id === selectedItem.id);
    return line ? createValidLoopRange(line.startTime, line.endTime) : null;
  }

  if (selectedItem.type === "character") {
    const track = project.builtinTracks.find((item) => item.id === "character-track");
    const character = project.characterAnnotations.find((item) => item.id === selectedItem.id);
    return track?.autoSetLoopRangeOnSelect && character
      ? { start: character.startTime, end: character.endTime }
      : null;
  }

  if (selectedItem.type === "action") {
    const action = project.actionAnnotations.find((item) => item.id === selectedItem.id);
    const track = action
      ? project.builtinTracks.find((item) => item.id === action.trackId)
      : null;
    return track?.autoSetLoopRangeOnSelect && action
      ? { start: action.startTime, end: action.endTime }
      : null;
  }

  if (selectedItem.type === "custom-block") {
    const track = project.customTracks.find((item) => item.id === selectedItem.trackId);
    const block = track?.blocks.find((item) => item.id === selectedItem.id);
    return track?.autoSetLoopRangeOnSelect && block
      ? { start: block.startTime, end: block.endTime }
      : null;
  }

  if (selectedItem.type === "gongche-block") {
    const block = project.gongcheAnnotations.find((item) => item.id === selectedItem.id);
    const parentTrack = block
      ? project.builtinTracks.find((item) => item.id === block.parentTrackId) ??
        project.customTracks.find((item) => item.id === block.parentTrackId)
      : null;
    return parentTrack?.autoSetLoopRangeOnSelect && block
      ? { start: block.startTime, end: block.endTime }
      : null;
  }

  // 轨道本身、波形、板眼等选择项没有“块范围”，保持原有循环范围不变。
  return null;
}
