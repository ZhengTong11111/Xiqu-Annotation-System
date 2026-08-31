import {
  ANNOTATION_REVIEW_DOMAINS,
  type AnnotationConfirmationDraft,
  type AnnotationConfirmationFreshness,
  type AnnotationConfirmationLifecycle,
  type AnnotationConfirmationRecord,
  type AnnotationConfirmationTargets,
  type AnnotationReviewScope,
} from "@xiqu/shared";

const MAX_CONFIRMATION_NOTE_LENGTH = 2_000;
const MAX_CONFIRMATION_ID_LENGTH = 200;
const REVIEW_DOMAIN_SET = new Set<string>(ANNOTATION_REVIEW_DOMAINS);

export type AnnotationConfirmationIssueCode =
  | "invalid_file_id"
  | "invalid_revision"
  | "invalid_time_range"
  | "invalid_targets"
  | "unknown_domain"
  | "invalid_track_id"
  | "unknown_track_id"
  | "unrecognized_track_payload"
  | "note_too_long"
  | "body_required"
  | "body_too_long"
  | "invalid_kind"
  | "invalid_revocation"
  | "revision_regressed";

export type AnnotationConfirmationIssue = {
  code: AnnotationConfirmationIssueCode;
  field: string;
  message: string;
};

export type AnnotationConfirmationValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      issues: AnnotationConfirmationIssue[];
    };

export type AnnotationConfirmationPermissionDecision = {
  allowed: boolean;
  reason:
    | "allowed"
    | "read_required"
    | "review_required"
    | "creator_or_manager_required";
};

export type AnnotationConfirmationReviewContext = {
  actorUserId: string;
  canRead: boolean;
  canReview: boolean;
  isAdminOrOwner: boolean;
};

// 规范化作用域只处理可独立判定的格式；真实轨道归属由另一个显式校验入口处理。
export function normalizeAnnotationReviewScope(
  scope: AnnotationReviewScope,
): AnnotationConfirmationValidationResult<AnnotationReviewScope> {
  const issues: AnnotationConfirmationIssue[] = [];

  // 确认范围采用半开区间，首尾相接的相邻范围不会被误判为重叠。
  if (
    !Number.isFinite(scope.startTime) ||
    !Number.isFinite(scope.endTime) ||
    scope.startTime < 0 ||
    scope.endTime <= scope.startTime
  ) {
    issues.push({
      code: "invalid_time_range",
      field: "scope",
      message: "确认时间范围必须是非负、有限且结束时间晚于开始时间的半开区间。",
    });
  }

  const normalizedTargets = normalizeConfirmationTargets(scope.targets, issues);
  if (issues.length || !normalizedTargets) return { ok: false, issues };
  return {
    ok: true,
    value: {
      startTime: scope.startTime,
      endTime: scope.endTime,
      targets: normalizedTargets,
    },
  };
}

// 草稿校验集中处理文件、revision、作用域和备注，API 以后必须复用而不是重新拼条件。
export function validateAnnotationConfirmationDraft(
  draft: AnnotationConfirmationDraft,
): AnnotationConfirmationValidationResult<AnnotationConfirmationDraft> {
  const issues: AnnotationConfirmationIssue[] = [];
  const annotationFileId = normalizeIdentifier(draft.annotationFileId);
  if (!annotationFileId) {
    issues.push({
      code: "invalid_file_id",
      field: "annotationFileId",
      message: "标注文件标识不能为空或超过允许长度。",
    });
  }
  if (!Number.isInteger(draft.confirmedRevision) || draft.confirmedRevision < 1) {
    issues.push({
      code: "invalid_revision",
      field: "confirmedRevision",
      message: "被审核修订必须是正整数。",
    });
  }

  const normalizedScope = normalizeAnnotationReviewScope(draft.scope);
  if (!normalizedScope.ok) issues.push(...normalizedScope.issues);
  const note = normalizeOptionalText(draft.note);
  if (note && note.length > MAX_CONFIRMATION_NOTE_LENGTH) {
    issues.push({
      code: "note_too_long",
      field: "note",
      message: `审核备注不能超过 ${MAX_CONFIRMATION_NOTE_LENGTH} 个字符。`,
    });
  }
  if (issues.length || !annotationFileId || !normalizedScope.ok) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      annotationFileId,
      confirmedRevision: draft.confirmedRevision,
      scope: normalizedScope.value,
      note,
    },
  };
}

// 项目相关校验由调用方提供真实持久轨道 id，避免根据命名猜测附属轨或递归伪轨。
export function validateAnnotationReviewTracks(
  scope: AnnotationReviewScope,
  persistedTrackIds: ReadonlySet<string>,
): AnnotationConfirmationValidationResult<AnnotationReviewScope> {
  const normalized = normalizeAnnotationReviewScope(scope);
  if (!normalized.ok || normalized.value.targets.mode !== "tracks") return normalized;
  const unknownTrackIds = normalized.value.targets.trackIds.filter((trackId) =>
    !persistedTrackIds.has(trackId));
  if (!unknownTrackIds.length) return normalized;
  return {
    ok: false,
    issues: unknownTrackIds.map((trackId) => ({
      code: "unknown_track_id" as const,
      field: "scope.targets.trackIds",
      message: `轨道“${trackId}”不是该项目的持久轨道。`,
    })),
  };
}

// 服务端只从当前格式 payload 的真实顶层轨道定义提取 id，不把可视伪轨或 activeTrackOrder 当作事实。
export function extractPersistedAnnotationReviewTrackIds(
  payload: unknown,
): AnnotationConfirmationValidationResult<string[]> {
  if (!isPlainObject(payload)) return unrecognizedTrackPayload();
  const builtinTracks = payload.builtinTracks;
  const customTracks = payload.customTracks;
  if (!Array.isArray(builtinTracks) || !Array.isArray(customTracks)) {
    return unrecognizedTrackPayload();
  }
  const trackIds = new Set<string>();

  // 当前唯一持久内建轨是逐字轨；旧动作内建轨和其他未知 id 不应重新进入新审核合同。
  for (const track of builtinTracks) {
    if (isPlainObject(track) && track.id === "character-track") {
      trackIds.add("character-track");
    }
  }

  // 自定义轨只读取顶层定义 id，branching/attachedPointTracks 内部 id 刻意不参与。
  for (const track of customTracks) {
    if (!isPlainObject(track) || typeof track.id !== "string") continue;
    const trackId = normalizeIdentifier(track.id);
    if (trackId) trackIds.add(trackId);
  }
  return {
    ok: true,
    value: [...trackIds].sort((left, right) => left.localeCompare(right)),
  };
}

// 生命周期严格要求撤销主体和时间成组出现，防止半截撤销记录被展示为有效事实。
export function getAnnotationConfirmationLifecycle(
  record: AnnotationConfirmationRecord,
): AnnotationConfirmationValidationResult<AnnotationConfirmationLifecycle> {
  const hasRevokedAt = typeof record.revokedAt === "string" && record.revokedAt.length > 0;
  const hasValidRevokedAt = hasRevokedAt && Number.isFinite(Date.parse(record.revokedAt!));
  const hasRevokedBy = Boolean(record.revokedBy?.id);
  const hasRevokeReason = Boolean(normalizeOptionalText(record.revokeReason));
  if (
    hasRevokedAt !== hasRevokedBy ||
    (hasRevokedAt && !hasValidRevokedAt) ||
    (!hasRevokedAt && hasRevokeReason)
  ) {
    return {
      ok: false,
      issues: [{
        code: "invalid_revocation",
        field: "revocation",
        message: "撤销时间和撤销账号必须同时存在。",
      }],
    };
  }
  return { ok: true, value: hasRevokedAt ? "revoked" : "active" };
}

// freshness 只比较服务器 revision；跨修订局部内容未验证时一律保守标记 stale。
export function getAnnotationConfirmationFreshness(
  confirmedRevision: number,
  currentRevision: number,
): AnnotationConfirmationValidationResult<AnnotationConfirmationFreshness> {
  if (!Number.isInteger(confirmedRevision) || confirmedRevision < 1) {
    return {
      ok: false,
      issues: [{
        code: "invalid_revision",
        field: "confirmedRevision",
        message: "确认记录绑定的修订必须是正整数。",
      }],
    };
  }
  if (!Number.isInteger(currentRevision) || currentRevision < confirmedRevision) {
    return {
      ok: false,
      issues: [{
        code: "revision_regressed",
        field: "currentRevision",
        message: "当前修订不能早于确认记录绑定的修订。",
      }],
    };
  }
  return {
    ok: true,
    value: currentRevision === confirmedRevision ? "current" : "stale",
  };
}

// 两个确认范围先判断半开时间交集，再判断同一作用域维度是否真正相交。
export function annotationReviewScopesOverlap(
  left: AnnotationReviewScope,
  right: AnnotationReviewScope,
) {
  if (left.startTime >= right.endTime || right.startTime >= left.endTime) return false;
  if (left.targets.mode === "all" || right.targets.mode === "all") return true;
  if (left.targets.mode !== right.targets.mode) return false;
  if (left.targets.mode === "domains" && right.targets.mode === "domains") {
    const rightDomains = new Set(right.targets.domains);
    return left.targets.domains.some((domain) => rightDomains.has(domain));
  }
  if (left.targets.mode === "tracks" && right.targets.mode === "tracks") {
    const rightTrackIds = new Set(right.targets.trackIds);
    return left.targets.trackIds.some((trackId) => rightTrackIds.has(trackId));
  }
  return false;
}

// 创建确认同时要求读取和独立审核能力；普通 write 或权限管理能力不能替代 review。
export function canCreateAnnotationReviewFact(
  context: AnnotationConfirmationReviewContext,
): AnnotationConfirmationPermissionDecision {
  if (!context.canRead) return { allowed: false, reason: "read_required" };
  if (!context.canReview) return { allowed: false, reason: "review_required" };
  return { allowed: true, reason: "allowed" };
}

// 撤销保留作者边界：审核者可撤销自己记录，管理员或 owner 可撤销任意记录。
export function canWithdrawAnnotationReviewFact(
  context: AnnotationConfirmationReviewContext,
  creatorUserId: string,
): AnnotationConfirmationPermissionDecision {
  const createDecision = canCreateAnnotationReviewFact(context);
  if (!createDecision.allowed) return createDecision;
  if (!context.isAdminOrOwner && context.actorUserId !== creatorUserId) {
    return { allowed: false, reason: "creator_or_manager_required" };
  }
  return { allowed: true, reason: "allowed" };
}

// 旧确认入口保留为兼容别名；确认与评论必须共享同一套范围、轨道和权限规则。
export const normalizeAnnotationConfirmationScope = normalizeAnnotationReviewScope;
export const validateAnnotationConfirmationTracks = validateAnnotationReviewTracks;
export const extractPersistedAnnotationTrackIds = extractPersistedAnnotationReviewTrackIds;
export const annotationConfirmationScopesOverlap = annotationReviewScopesOverlap;
export const canCreateAnnotationConfirmation = canCreateAnnotationReviewFact;
export const canRevokeAnnotationConfirmation = canWithdrawAnnotationReviewFact;

// 目标规范化保持领域共享顺序和轨道字典序，保证重复请求得到确定结果。
function normalizeConfirmationTargets(
  targets: AnnotationConfirmationTargets,
  issues: AnnotationConfirmationIssue[],
): AnnotationConfirmationTargets | null {
  if (targets.mode === "all") return { mode: "all" };
  if (targets.mode === "domains") {
    const unknownDomains = targets.domains.filter((domain) =>
      !REVIEW_DOMAIN_SET.has(domain));
    if (unknownDomains.length) {
      issues.push(...unknownDomains.map((domain) => ({
        code: "unknown_domain" as const,
        field: "scope.targets.domains",
        message: `未知确认领域“${domain}”。`,
      })));
    }
    const selected = new Set(targets.domains);
    const domains = ANNOTATION_REVIEW_DOMAINS.filter((domain) => selected.has(domain));
    if (!domains.length) {
      issues.push({
        code: "invalid_targets",
        field: "scope.targets.domains",
        message: "领域作用域至少需要一个有效领域。",
      });
    }
    return issues.length ? null : { mode: "domains", domains: [...domains] };
  }
  if (targets.mode === "tracks") {
    const trackIds = [...new Set(targets.trackIds.map(normalizeIdentifier).filter(
      (trackId): trackId is string => Boolean(trackId),
    ))].sort((left, right) => left.localeCompare(right));
    if (trackIds.length !== targets.trackIds.length) {
      const hasInvalidId = targets.trackIds.some((trackId) => !normalizeIdentifier(trackId));
      if (hasInvalidId) {
        issues.push({
          code: "invalid_track_id",
          field: "scope.targets.trackIds",
          message: "轨道标识不能为空或超过允许长度。",
        });
      }
    }
    if (!trackIds.length) {
      issues.push({
        code: "invalid_targets",
        field: "scope.targets.trackIds",
        message: "轨道作用域至少需要一个持久轨道。",
      });
    }
    return issues.length ? null : { mode: "tracks", trackIds };
  }
  issues.push({
    code: "invalid_targets",
    field: "scope.targets",
    message: "不支持的确认作用域模式。",
  });
  return null;
}

// 标识规范化只移除首尾空白并限制长度，不改变大小写或内部字符。
function normalizeIdentifier(value: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= MAX_CONFIRMATION_ID_LENGTH
    ? normalized
    : null;
}

// 可选说明的空白文本统一为 null，避免数据库同时出现 null、空串和纯空格三种状态。
function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

// unknown payload 的对象判断集中处理，避免轨道提取阶段使用类型断言绕过运行时边界。
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 无法识别当前轨道结构时保守拒绝 tracks 确认，不尝试复制前端项目迁移逻辑。
function unrecognizedTrackPayload(): AnnotationConfirmationValidationResult<string[]> {
  return {
    ok: false,
    issues: [{
      code: "unrecognized_track_payload",
      field: "payload",
      message: "当前标注内容没有可验证的持久轨道结构，请先在编辑器中正常保存。",
    }],
  };
}
