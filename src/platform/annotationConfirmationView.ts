import {
  getAnnotationConfirmationFreshness,
  getAnnotationConfirmationLifecycle,
  getAnnotationRangeCommentFreshness,
  getAnnotationRangeCommentLifecycle,
  canWithdrawAnnotationRangeComment,
} from "@xiqu/document-model";
import type {
  AnnotationConfirmationDomain,
  AnnotationConfirmationRecord,
  AnnotationConfirmationTargets,
  AnnotationRangeCommentRecord,
  AnnotationReviewLinkRecord,
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

export type AnnotationRangeCommentViewRecord = {
  record: AnnotationRangeCommentRecord;
  lifecycle: "active" | "withdrawn";
  freshness: "current" | "stale";
  targetLabel: string;
  invalidReason: string | null;
};

export type AnnotationReviewTimelineItem = {
  id: string;
  recordId: string;
  recordType: "confirmation" | "range_record" | "linked_record";
  linkId?: string;
  kind: "confirmation" | "comment" | "feedback";
  startTime: number;
  endTime: number;
  label: string;
  lane: number;
  lifecycle: "active" | "revoked" | "withdrawn";
  freshness: "current" | "stale";
};

// 创建阻断原因保持为确定联合，便于面板提供对应的可操作提示。
export type AnnotationReviewCreateBlocker =
  | "permission_required"
  | "range_required"
  | "unsaved_changes"
  | "revision_mismatch"
  | "loading";

export type AnnotationReviewCreateMode = "confirmation" | "comment" | "feedback";

// 右键快捷菜单和审核面板共享同一份模式权限映射，避免入口显示与面板实际能力不一致。
export function getAvailableAnnotationReviewCreateModes(input: {
  canReview: boolean;
  canWrite: boolean;
}): AnnotationReviewCreateMode[] {
  return [
    ...(input.canReview ? ["confirmation" as const, "comment" as const] : []),
    ...(input.canWrite ? ["feedback" as const] : []),
  ];
}

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

export function buildAnnotationRangeCommentViewRecords(
  records: AnnotationRangeCommentRecord[],
  currentRevision: number,
  trackOptions: AnnotationConfirmationTrackOption[],
): AnnotationRangeCommentViewRecord[] {
  const trackLabels = new Map(trackOptions.map((track) => [track.id, track.label]));
  return records.map((record) => {
    const lifecycle = getAnnotationRangeCommentLifecycle(record);
    const freshness = getAnnotationRangeCommentFreshness(record.commentedRevision, currentRevision);
    const issues = [
      ...(lifecycle.ok ? [] : lifecycle.issues),
      ...(freshness.ok ? [] : freshness.issues),
    ];
    return {
      record,
      lifecycle: lifecycle.ok ? lifecycle.value : "withdrawn",
      freshness: freshness.ok ? freshness.value : "stale",
      targetLabel: formatAnnotationConfirmationTargets(record.scope.targets, trackLabels),
      invalidReason: issues.length ? issues.map((issue) => issue.message).join("；") : null,
    };
  });
}

// 三类范围事实共用层分配，确保同一时间的确认、评论和反馈不会在只读栏中互相覆盖。
export function layoutAnnotationReviewTimelineItems(input: {
  confirmations: AnnotationConfirmationViewRecord[];
  comments: AnnotationRangeCommentViewRecord[];
  links?: AnnotationReviewLinkRecord[];
  trackOptions?: AnnotationConfirmationTrackOption[];
}): AnnotationReviewTimelineItem[] {
  const trackLabels = new Map(
    (input.trackOptions ?? []).map((track) => [track.id, track.label]),
  );
  for (const record of [...input.confirmations, ...input.comments]) {
    if (record.record.scope.targets.mode !== "tracks") continue;
    for (const trackId of record.record.scope.targets.trackIds) {
      if (!trackLabels.has(trackId)) trackLabels.set(trackId, trackId);
    }
  }
  const candidates: Omit<AnnotationReviewTimelineItem, "lane">[] = [
    ...input.confirmations
      .filter((item) => item.lifecycle === "active")
      .map((item) => ({
        id: `confirmation:${item.record.id}`,
        recordId: item.record.id,
        recordType: "confirmation" as const,
        kind: "confirmation" as const,
        startTime: item.record.scope.startTime,
        endTime: item.record.scope.endTime,
        label: `确认 · ${item.targetLabel}`,
        lifecycle: item.lifecycle,
        freshness: item.freshness,
      })),
    ...input.comments
      .filter((item) => item.lifecycle === "active")
      .map((item) => ({
        id: `range-record:${item.record.id}`,
        recordId: item.record.id,
        recordType: "range_record" as const,
        kind: item.record.kind === "editor_feedback" ? "feedback" as const : "comment" as const,
        startTime: item.record.scope.startTime,
        endTime: item.record.scope.endTime,
        label: `${item.record.kind === "editor_feedback" ? "反馈" : "评论"} · ${item.targetLabel}`,
        lifecycle: item.lifecycle,
        freshness: item.freshness,
      })),
    // 关联包事实使用独立身份并保守标为 stale；不同文件的 revision 数字没有可比较语义。
    ...(input.links ?? []).flatMap((link) => {
      if (link.revokedAt) return [];
      const prefix = `关联 · ${link.source.annotationFileName}`;
      return [
        ...link.reviewPackage.records.confirmations
          .filter((record) => !record.revokedAt)
          .map((record) => ({
            id: `link:${link.id}:confirmation:${record.id}`,
            recordId: record.id,
            recordType: "linked_record" as const,
            linkId: link.id,
            kind: "confirmation" as const,
            startTime: record.scope.startTime,
            endTime: record.scope.endTime,
            label: `${prefix} · 确认 · ${formatAnnotationConfirmationTargets(record.scope.targets, trackLabels)}`,
            lifecycle: "active" as const,
            freshness: "stale" as const,
          })),
        ...link.reviewPackage.records.rangeRecords
          .filter((record) => !record.withdrawnAt)
          .map((record) => ({
            id: `link:${link.id}:range-record:${record.id}`,
            recordId: record.id,
            recordType: "linked_record" as const,
            linkId: link.id,
            kind: record.kind === "editor_feedback" ? "feedback" as const : "comment" as const,
            startTime: record.scope.startTime,
            endTime: record.scope.endTime,
            label: `${prefix} · ${record.kind === "editor_feedback" ? "反馈" : "评论"} · ${formatAnnotationConfirmationTargets(record.scope.targets, trackLabels)}`,
            lifecycle: "active" as const,
            freshness: "stale" as const,
          })),
      ];
    }),
  ].sort((left, right) =>
    left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id));
  const laneEndTimes: number[] = [];
  return candidates.map((item) => {
    const reusableLane = laneEndTimes.findIndex((endTime) => endTime <= item.startTime);
    const lane = reusableLane >= 0 ? reusableLane : laneEndTimes.length;
    laneEndTimes[lane] = item.endTime;
    return { ...item, lane };
  });
}

// 创建禁用原因按最需要用户处理的顺序返回，面板无需复制一组互相冲突的判断。
export function getAnnotationReviewCreateBlocker(input: {
  canCreate: boolean;
  hasRange: boolean;
  hasUnsavedChanges: boolean;
  editorRevision: number;
  serverRevision: number | null;
  loading: boolean;
}): AnnotationReviewCreateBlocker | null {
  if (!input.canCreate) return "permission_required";
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

export function canShowAnnotationRangeCommentWithdraw(input: {
  record: AnnotationRangeCommentViewRecord;
  canReview: boolean;
  canWrite: boolean;
  currentUserId: string;
  currentUserRoles: PlatformRole[];
  hasOwnerAuthority: boolean;
}): boolean {
  if (input.record.lifecycle === "withdrawn") return false;
  const isAdmin = input.currentUserRoles.some(
    (role) => role === "admin" || role === "super_admin",
  );
  return canWithdrawAnnotationRangeComment({
    actorUserId: input.currentUserId,
    canRead: true,
    canReview: input.canReview,
    canWrite: input.canWrite,
    isAdminOrOwner: input.hasOwnerAuthority || isAdmin,
  }, input.record.record.kind, input.record.record.createdBy.id).allowed;
}

// 创建禁用提示保持具体可操作，不把服务端权限或 revision 错误简化成泛化失败。
export function getAnnotationReviewBlockerMessage(
  blocker: AnnotationReviewCreateBlocker | null,
): string | null {
  if (blocker === "permission_required") return "当前账号没有此文件的审核或编辑权限。";
  if (blocker === "loading") return "正在读取服务器范围记录。";
  if (blocker === "range_required") return "请先在时间轴循环栏拖出需要处理的时间范围。";
  if (blocker === "unsaved_changes") return "请先保存当前标注，再基于服务器最新修订提交范围记录。";
  if (blocker === "revision_mismatch") return "服务器修订已变化，请刷新或重新打开文件后再提交。";
  return null;
}
