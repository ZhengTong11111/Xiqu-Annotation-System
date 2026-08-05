import type { ProjectData } from "../types";
import {
  isRecognizableProjectPayload,
  normalizeImportedProjectFile,
  PROJECT_FILE_VERSION,
} from "../utils/projectFile";

// 预览摘要只保存可快速检查的结构统计，不把历史 payload 复制进 React 展示状态。
export type RecoverySnapshotProjectSummary = {
  normalizedFileVersion: number;
  videoName: string | null;
  requiresManualVideoImport: boolean;
  subtitleLineCount: number;
  characterAnnotationCount: number;
  gongcheAnnotationCount: number;
  gongcheSymbolCount: number;
  banyanSectionCount: number;
  banyanMarkCount: number;
  customTrackCount: number;
  customTextTrackCount: number;
  customActionTrackCount: number;
  customBlockCount: number;
  attachedPointCount: number;
};

// 调用方通过判别字段处理坏历史数据，避免异常越过对话框错误边界。
export type RecoverySnapshotPreviewResult =
  | {
      ok: true;
      summary: RecoverySnapshotProjectSummary;
    }
  | {
      ok: false;
      message: string;
    };

// 汇总内建轨和自定义轨的附属点，确保历史检查能反映呼吸等点状标注是否存在。
function countAttachedPoints(project: ProjectData): number {
  const builtinCount = project.builtinTracks.reduce(
    (total, track) => total + track.attachedPointTracks.reduce(
      (trackTotal, pointTrack) => trackTotal + pointTrack.points.length,
      0,
    ),
    0,
  );
  const customCount = project.customTracks.reduce(
    (total, track) => total + track.attachedPointTracks.reduce(
      (trackTotal, pointTrack) => trackTotal + pointTrack.points.length,
      0,
    ),
    0,
  );
  return builtinCount + customCount;
}

// 把未知快照 payload 安全迁移到当前格式，再生成不含原始标注内容的只读摘要。
export function buildRecoverySnapshotPreview(
  payload: unknown,
): RecoverySnapshotPreviewResult {
  if (!isRecognizableProjectPayload(payload)) {
    return {
      ok: false,
      message: "快照不包含可识别的戏曲标注项目结构。",
    };
  }

  try {
    // 所有本地/平台项目都复用同一迁移入口，避免历史预览另写一套旧格式兼容规则。
    const normalized = normalizeImportedProjectFile(payload);
    const project = normalized.project;
    const customTextTrackCount = project.customTracks.filter(
      ({ trackType }) => trackType === "text",
    ).length;
    const customActionTrackCount = project.customTracks.length -
      customTextTrackCount;
    return {
      ok: true,
      summary: {
        normalizedFileVersion: PROJECT_FILE_VERSION,
        videoName: project.video.name,
        requiresManualVideoImport: Boolean(project.video.requiresManualImport),
        subtitleLineCount: project.subtitleLines.length,
        characterAnnotationCount: project.characterAnnotations.length,
        gongcheAnnotationCount: project.gongcheAnnotations.length,
        gongcheSymbolCount: project.gongcheAnnotations.reduce(
          (total, annotation) => total + annotation.symbols.length,
          0,
        ),
        banyanSectionCount: project.banyanSections.length,
        banyanMarkCount: project.banyanMarks.length,
        customTrackCount: project.customTracks.length,
        customTextTrackCount,
        customActionTrackCount,
        customBlockCount: project.customTracks.reduce(
          (total, track) => total + track.blocks.length,
          0,
        ),
        attachedPointCount: countAttachedPoints(project),
      },
    };
  } catch {
    // 历史数据可能来自损坏导入；预览失败不能影响资源 Inspector 或当前编辑会话。
    return {
      ok: false,
      message: "快照格式无法迁移到当前项目结构。",
    };
  }
}
