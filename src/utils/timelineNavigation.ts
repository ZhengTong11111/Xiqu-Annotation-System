import type {
  ActionAnnotation,
  CharacterAnnotation,
  GongcheAnnotation,
  ProjectData,
  SelectedItem,
  SubtitleLine,
} from "../types";

// 本轮「块导航」只覆盖有持续时间的标注块：句级字幕、逐字块、兼容 action block、
// 自定义文字/动作块、工尺谱块。附属打点和板眼点没有可用于循环播放的持续范围，
// 不纳入相邻块导航，避免把「相邻块」和「相邻点」混为同一快捷键语义。
export type NavigationDirection = "previous" | "next";

type NavigableItem = {
  selectedItem: SelectedItem;
  startTime: number;
  endTime: number;
  // 最终稳定排序键：startTime → endTime → id，不依赖数组存储顺序或 DOM 渲染顺序。
  id: string;
};

function isCustomBlockVisibleInNavigationLane(
  block: { branchScope?: { mode: "root" } | { mode: "lanes"; laneIds: string[] } },
  branchLaneId: string | undefined,
) {
  if (!branchLaneId) {
    return !block.branchScope || block.branchScope.mode === "root";
  }
  return block.branchScope?.mode === "lanes" && block.branchScope.laneIds.includes(branchLaneId);
}

function compareNavigableItems(left: NavigableItem, right: NavigableItem) {
  return (
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id)
  );
}

// 解析当前选中项所在「逻辑轨道」的可导航块列表（已稳定排序）。
// 返回 null 表示当前选中项不是可导航块（轨道头、波形/频谱轨、附属点、板眼点等）。
function resolveNavigableItems(
  project: ProjectData,
  selectedItem: SelectedItem,
): NavigableItem[] | null {
  if (!selectedItem) {
    return null;
  }

  if (selectedItem.type === "line") {
    // 句级字幕在整个句级集合内导航。
    return project.subtitleLines
      .map((line) => toLineNavigableItem(line))
      .sort(compareNavigableItems);
  }

  if (selectedItem.type === "character") {
    // 逐字块只在 character-track 内导航。
    return project.characterAnnotations
      .map((annotation) => toCharacterNavigableItem(annotation))
      .sort(compareNavigableItems);
  }

  if (selectedItem.type === "action") {
    // 兼容 action block：按其 trackId 分组。
    const current = project.actionAnnotations.find((item) => item.id === selectedItem.id);
    if (!current) {
      return null;
    }
    return project.actionAnnotations
      .filter((annotation) => annotation.trackId === current.trackId)
      .map((annotation) => toActionNavigableItem(annotation))
      .sort(compareNavigableItems);
  }

  if (selectedItem.type === "custom-block") {
    const track = project.customTracks.find((item) => item.id === selectedItem.trackId);
    if (!track) {
      return null;
    }
    const currentBlock = track.blocks.find((item) => item.id === selectedItem.id);
    if (!currentBlock) {
      return null;
    }
    if (!track.branching?.enabled || track.branching.displayMode !== "expanded") {
      return track.blocks
        .map((block) => toCustomBlockNavigableItem(block, track.id))
        .sort(compareNavigableItems);
    }
    // 展开显示时，以用户实际点击的派生 lane 为上下文。共有块会出现在每个 branchScope lane，
    // 因而从哪条可视轨点击，就沿哪条轨道导航；根轨只包含未细分块。
    const scopedLaneIds = currentBlock.branchScope?.mode === "lanes"
      ? currentBlock.branchScope.laneIds
      : [];
    const selectedLaneStillValid = selectedItem.branchLaneId && scopedLaneIds.includes(selectedItem.branchLaneId)
      ? selectedItem.branchLaneId
      : undefined;
    const currentLaneId = selectedLaneStillValid ?? (scopedLaneIds.length === 1 ? scopedLaneIds[0] : undefined);
    if (scopedLaneIds.length > 1 && !currentLaneId) {
      // 共有块在多个派生轨均有实例；若选择来自设置面板或显示模式切换而缺少点击 lane，
      // 无法可靠推断用户想沿哪一轨导航，保持当前选择比任意挑一条分支更安全。
      return null;
    }
    return track.blocks
      .filter((block) => isCustomBlockVisibleInNavigationLane(block, currentLaneId))
      .map((block) => toCustomBlockNavigableItem(block, track.id, currentLaneId))
      .sort(compareNavigableItems);
  }

  if (selectedItem.type === "gongche-block") {
    // 工尺谱块只在相同 parentTrackId 的工尺谱集合内导航，不跨父轨。
    const current = project.gongcheAnnotations.find((item) => item.id === selectedItem.id);
    if (!current) {
      return null;
    }
    return project.gongcheAnnotations
      .filter((annotation) => annotation.parentTrackId === current.parentTrackId)
      .map((annotation) => toGongcheNavigableItem(annotation))
      .sort(compareNavigableItems);
  }

  return null;
}

function toLineNavigableItem(line: SubtitleLine): NavigableItem {
  return {
    selectedItem: { type: "line", id: line.id },
    startTime: line.startTime,
    endTime: line.endTime,
    id: line.id,
  };
}

function toCharacterNavigableItem(annotation: CharacterAnnotation): NavigableItem {
  return {
    selectedItem: { type: "character", id: annotation.id },
    startTime: annotation.startTime,
    endTime: annotation.endTime,
    id: annotation.id,
  };
}

function toActionNavigableItem(annotation: ActionAnnotation): NavigableItem {
  return {
    selectedItem: { type: "action", id: annotation.id },
    startTime: annotation.startTime,
    endTime: annotation.endTime,
    id: annotation.id,
  };
}

function toCustomBlockNavigableItem(
  block: { id: string; startTime: number; endTime: number },
  trackId: string,
  branchLaneId?: string,
): NavigableItem {
  return {
    selectedItem: { type: "custom-block", id: block.id, trackId, branchLaneId },
    startTime: block.startTime,
    endTime: block.endTime,
    id: block.id,
  };
}

function toGongcheNavigableItem(annotation: GongcheAnnotation): NavigableItem {
  return {
    selectedItem: { type: "gongche-block", id: annotation.id },
    startTime: annotation.startTime,
    endTime: annotation.endTime,
    id: annotation.id,
  };
}

// 找当前选中项在逻辑轨道内的相邻可导航块。
// 边界：首/末块再按键保持当前选中（不循环）；当前项不可导航或已删除返回 null。
// 多选时以 selectedItem 主选中项为起点；调用方收敛为目标块单选。
export function findAdjacentNavigableBlock(
  project: ProjectData,
  selectedItem: SelectedItem,
  direction: NavigationDirection,
): SelectedItem | null {
  const items = resolveNavigableItems(project, selectedItem);
  if (!items || items.length === 0) {
    return null;
  }
  const currentIndex = items.findIndex((item) => selectedItemEquals(item.selectedItem, selectedItem));
  if (currentIndex === -1) {
    // 当前块在项目中找不到（可能被删除），保持状态稳定，不跳转。
    return null;
  }
  const nextIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return null;
  }
  return items[nextIndex].selectedItem;
}

function selectedItemEquals(left: SelectedItem, right: SelectedItem): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "custom-block" && right.type === "custom-block") {
    // 候选集合已经由当前 lane 过滤；比较块身份时忽略可能来自显示模式切换的旧 lane 上下文。
    return left.id === right.id && left.trackId === right.trackId;
  }
  // 可导航类型（line/character/action/gongche-block）都有 id；非可导航类型不会进入此比较。
  if ("id" in left && "id" in right) {
    return left.id === right.id;
  }
  return false;
}
