import {
  getAnnotationConfirmationFreshness,
  getAnnotationConfirmationLifecycle,
} from "@xiqu/document-model";
import type {
  AnnotationConfirmationDomain,
  AnnotationConfirmationRecord,
  AnnotationConfirmationTargets,
  PlatformRole,
} from "@xiqu/shared";
import type { ProjectData } from "../types";

// 确认领域标签只在一处维护，确保创建表单、历史列表和时间轴摘要使用同一套术语。
export const ANNOTATION_CONFIRMATION_DOMAIN_LABELS: Record<
  AnnotationConfirmationDomain,
  string
> = {
  subtitle_lines: "句级字幕",
  character_annotations: "逐字标注",
  gongche_annotations: "工尺谱",
  banyan_sections: "板眼段落",
  banyan_marks: "板眼标记",
  custom_tracks: "自定义轨道",
  custom_blocks: "自定义标注块",
  attached_points: "附属打点",
};

// 视图层只保存真实持久轨道的稳定 id 与当前名称，不携带 Timeline 派生轨结构。
export type AnnotationConfirmationTrackOption = {
  id: string;
  label: string;
};

// 服务端事实经领域 helper 派生后形成可安全渲染的状态，异常历史也保留明确原因。
export type AnnotationConfirmationViewRecord = {
  record: AnnotationConfirmationRecord;
  lifecycle: "active" | "revoked";
  freshness: "current" | "stale";
  targetLabel: string;
  invalidReason: string | null;
};

// 时间轴布局只为视图记录附加层号，不修改确认事实本身。
export type AnnotationConfirmationTimelineItem = AnnotationConfirmationViewRecord & {
  lane: number;
};

// 创建阻断原因保持为确定联合，便于面板提供对应的可操作提示。
export type AnnotationConfirmationCreateBlocker =
  | "review_required"
  | "range_required"
  | "unsaved_changes"
  | "revision_mismatch"
  | "loading";

// 轨道作用域只能引用项目中真实保存的顶层轨道，派生的工尺谱、分叉和附属打点轨不在这里出现。
export function getAnnotationConfirmationTrackOptions(
  project: ProjectData,
): AnnotationConfirmationTrackOption[] {
  const builtin = project.builtinTracks
    .filter((track) => track.id === "character-track")
    .map((track) => ({ id: track.id, label: track.name }));
  const custom = project.customTracks.map((track) => ({
    id: track.id,
    label: track.name,
  }));
  return [...builtin, ...custom];
}

// 作用域摘要优先展示人能理解的名称，未知轨道仍保留 id，避免历史事实被静默隐藏。
export function formatAnnotationConfirmationTargets(
  targets: AnnotationConfirmationTargets,
  trackLabels: ReadonlyMap<string, string>,
): string {
  if (targets.mode === "all") return "全部标注";
  if (targets.mode === "domains") {
    return targets.domains
      .map((domain) => ANNOTATION_CONFIRMATION_DOMAIN_LABELS[domain] ?? domain)
      .join("、");
  }
  return targets.trackIds
    .map((trackId) => trackLabels.get(trackId) ?? `已移除轨道 ${trackId}`)
    .join("、");
}

// 服务端记录先经过共享领域 helper 校验；异常历史保守显示为过期，并把原因交给 UI 明示。
export function buildAnnotationConfirmationViewRecords(
  records: AnnotationConfirmationRecord[],
  currentRevision: number,
  trackOptions: AnnotationConfirmationTrackOption[],
): AnnotationConfirmationViewRecord[] {
  const trackLabels = new Map(trackOptions.map((track) => [track.id, track.label]));
  return records.map((record) => {
    const lifecycle = getAnnotationConfirmationLifecycle(record);
    const freshness = getAnnotationConfirmationFreshness(
      record.confirmedRevision,
      currentRevision,
    );
    const issues = [
      ...(lifecycle.ok ? [] : lifecycle.issues),
      ...(freshness.ok ? [] : freshness.issues),
    ];
    return {
      record,
      lifecycle: lifecycle.ok ? lifecycle.value : "revoked",
      freshness: freshness.ok ? freshness.value : "stale",
      targetLabel: formatAnnotationConfirmationTargets(record.scope.targets, trackLabels),
      invalidReason: issues.length > 0
        ? issues.map((issue) => issue.message).join("；")
        : null,
    };
  });
}

// 时间轴采用半开区间着色：首尾相接可以复用同一层，真正重叠的记录才新增层。
export function layoutAnnotationConfirmationTimelineItems(
  records: AnnotationConfirmationViewRecord[],
): AnnotationConfirmationTimelineItem[] {
  const sorted = [...records].sort((left, right) =>
    left.record.scope.startTime - right.record.scope.startTime ||
    left.record.scope.endTime - right.record.scope.endTime ||
    left.record.id.localeCompare(right.record.id));
  const laneEndTimes: number[] = [];
  return sorted.map((item) => {
    const reusableLane = laneEndTimes.findIndex(
      (endTime) => endTime <= item.record.scope.startTime,
    );
    const lane = reusableLane >= 0 ? reusableLane : laneEndTimes.length;
    laneEndTimes[lane] = item.record.scope.endTime;
    return { ...item, lane };
  });
}

// 创建禁用原因按最需要用户处理的顺序返回，面板无需复制一组互相冲突的判断。
export function getAnnotationConfirmationCreateBlocker(input: {
  canReview: boolean;
  hasRange: boolean;
  hasUnsavedChanges: boolean;
  editorRevision: number;
  serverRevision: number | null;
  loading: boolean;
}): AnnotationConfirmationCreateBlocker | null {
  if (!input.canReview) return "review_required";
  if (input.loading) return "loading";
  if (!input.hasRange) return "range_required";
  if (input.hasUnsavedChanges) return "unsaved_changes";
  if (
    input.serverRevision === null ||
    input.serverRevision !== input.editorRevision
  ) {
    return "revision_mismatch";
  }
  return null;
}

// 撤销入口只做前端可见性判断；服务端仍会在事务内重新验证创建者和 owner/admin 边界。
export function canShowAnnotationConfirmationRevoke(input: {
  record: AnnotationConfirmationViewRecord;
  canReview: boolean;
  currentUserId: string;
  currentUserRoles: PlatformRole[];
  hasOwnerAuthority: boolean;
}): boolean {
  if (!input.canReview || input.record.lifecycle === "revoked") return false;
  const isAdmin = input.currentUserRoles.some(
    (role) => role === "admin" || role === "super_admin",
  );
  return input.record.record.createdBy.id === input.currentUserId || input.hasOwnerAuthority || isAdmin;
}

// 创建禁用提示保持具体可操作，不把服务端权限或 revision 错误简化成泛化失败。
export function getAnnotationConfirmationBlockerMessage(
  blocker: AnnotationConfirmationCreateBlocker | null,
): string | null {
  if (blocker === "review_required") return "当前账号没有此文件的审核权限。";
  if (blocker === "loading") return "正在读取服务器确认记录。";
  if (blocker === "range_required") return "请先在时间轴循环栏拖出需要确认的时间范围。";
  if (blocker === "unsaved_changes") return "请先保存当前标注，再确认服务器上的最新修订。";
  if (blocker === "revision_mismatch") return "服务器修订已变化，请刷新或重新打开文件后再确认。";
  return null;
}
