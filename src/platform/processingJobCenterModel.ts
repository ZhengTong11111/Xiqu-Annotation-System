import type {
  PlatformUser,
  ProcessingJobRequestListItem,
  ProcessingJobStatus,
  ProcessingJobSummary,
  ProcessingJobType,
} from "@xiqu/shared";
import { hasFullPlatformResourceAccess } from "@xiqu/shared";

const ACTIVE_STATUSES = new Set<ProcessingJobStatus>([
  "queued",
  "running",
  "cancelling",
]);

export const PROCESSING_JOB_STATUS_LABELS: Record<ProcessingJobStatus, string> = {
  queued: "等待中",
  running: "运行中",
  cancelling: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
};

export const PROCESSING_JOB_TYPE_LABELS: Record<ProcessingJobType, string> = {
  pitch_extraction: "音高提取",
  spectrogram_generation: "频谱生成",
  staff_notation_render: "五线谱渲染",
  gongche_render: "工尺谱渲染",
  pose_estimation: "姿态估计",
  video_transcode: "视频转码",
  audio_extract: "音频提取",
  annotation_export: "标注导出",
  media_analysis: "媒体分析",
  force_alignment: "强制对齐",
};

export function isProcessingJobActive(status: ProcessingJobStatus) {
  return ACTIVE_STATUSES.has(status);
}

export function getActiveProcessingJobCount(summary: ProcessingJobSummary | null) {
  return summary?.activeRequestCount ?? 0;
}

export function getProcessingJobPollInterval(open: boolean, activeCount: number) {
  if (!open) return 15_000;
  return activeCount > 0 ? 2_000 : 8_000;
}

export function canCancelProcessingJobRequest(
  item: ProcessingJobRequestListItem,
  user: PlatformUser,
) {
  return item.requester.id === user.id &&
    item.cancelledAt === null &&
    isProcessingJobActive(item.job.status);
}

export function canRetryProcessingJobRequest(
  item: ProcessingJobRequestListItem,
  user: PlatformUser,
) {
  // 后端当前只实现媒体分析重试；对齐任务要等 D2b 接入同一命令服务后才能开放按钮。
  return item.job.type === "media_analysis" &&
    (item.requester.id === user.id || hasFullPlatformResourceAccess(user.roles)) &&
    (item.job.status === "failed" || item.job.status === "cancelled");
}

export function canForceCancelProcessingJob(
  item: ProcessingJobRequestListItem,
  user: PlatformUser,
) {
  return hasFullPlatformResourceAccess(user.roles) && isProcessingJobActive(item.job.status);
}

export function formatProcessingJobProgress(progress: number) {
  if (!Number.isFinite(progress)) return "0%";
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

export function formatProcessingJobTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}
