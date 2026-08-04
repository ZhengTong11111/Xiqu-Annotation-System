import { areProjectValuesEqual } from "@xiqu/document-model";
import type { ProjectData } from "../types";

// 编辑器比较忽略不可持久化的媒体运行时细节，但不能缓存可被后续规范化的项目对象签名。
export function areEditorProjectsEqual(left: ProjectData, right: ProjectData) {
  if (Object.is(left, right)) return true;
  return areProjectValuesEqual(
    getComparableProjectSnapshot(left),
    getComparableProjectSnapshot(right),
  );
}

function getComparableProjectSnapshot(project: ProjectData) {
  return {
    ...project,
    video: {
      source: project.video.source,
      name: project.video.name,
      filePath: project.video.filePath ?? null,
      requiresManualImport: Boolean(project.video.requiresManualImport),
      token: getComparableVideoToken(project.video),
    },
  };
}

// data URL 只比较稳定摘要，避免复制整段媒体；普通 URL 仍按完整地址区分真实资源。
function getComparableVideoToken(video: ProjectData["video"]) {
  const url = video.url ?? "";
  const filePath = video.filePath ?? "";
  const importMode = video.requiresManualImport ? "manual" : "direct";
  if (!url) return `${video.source}|${video.name ?? ""}|${importMode}|${filePath}`;
  if (video.source === "embedded") {
    return [
      video.source,
      video.name ?? "",
      importMode,
      filePath,
      url.length,
      url.slice(0, 48),
      url.slice(-48),
    ].join("|");
  }
  return `${video.source}|${video.name ?? ""}|${importMode}|${filePath}|${url}`;
}
