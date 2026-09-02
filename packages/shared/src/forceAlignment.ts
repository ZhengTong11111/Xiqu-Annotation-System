import type { ProcessingJobStatus } from "./platform.js";

export const FORCE_ALIGNMENT_MODEL_PRESETS = ["kunqu_character_v1"] as const;
export type ForceAlignmentModelPreset = typeof FORCE_ALIGNMENT_MODEL_PRESETS[number];

export const FORCE_ALIGNMENT_MODEL_PRESET_LABELS: Record<ForceAlignmentModelPreset, string> = {
  kunqu_character_v1: "昆曲逐字对齐 v1",
};

export type CreateAlignmentRunRequest = {
  clientRequestId: string;
  modelPreset: ForceAlignmentModelPreset;
};

export type AlignmentRunSummary = {
  id: string;
  status: ProcessingJobStatus;
  progress: number;
  errorCode: string | null;
  inputRevision: number;
  inputSentenceCount: number;
  inputCharacterCount: number;
  modelPreset: ForceAlignmentModelPreset | "unknown";
  modelLabel: string;
  matchesCurrentInput: boolean;
  canApplyToCurrentDocument: boolean;
  artifactAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AlignmentRunPage = {
  items: AlignmentRunSummary[];
  nextCursor: string | null;
};

export type AlignmentRunDetail = AlignmentRunSummary & {
  audioTrackId: string | null;
  requestActive: boolean;
};

export type ListAlignmentRunsOptions = {
  cursor?: string;
  limit?: number;
};

export type CreateAlignmentRunValidationResult =
  | { success: true; data: CreateAlignmentRunRequest }
  | { success: false; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ApplyAlignmentRunRequest = {
  clientActionId: string;
  baseRevision: number;
};

export type AlignmentApplicationSummary = {
  id: string;
  alignmentRunId: string;
  baseRevision: number;
  committedRevision: number;
  operationCount: number;
  appliedCharacterCount: number;
  operationCursor: string;
  createdAt: string;
};

export type AlignmentApplicationHistoryItem = AlignmentApplicationSummary & {
  actorUserId: string;
  modelPreset: ForceAlignmentModelPreset | "unknown";
  modelLabel: string;
  currentAssessmentCount: number;
};

export type AlignmentApplicationPage = {
  items: AlignmentApplicationHistoryItem[];
  nextCursor: string | null;
};

export type ListAlignmentApplicationsOptions = {
  cursor?: string;
  limit?: number;
};

export const ALIGNMENT_QUALITY_ASSESSMENT_SCOPES = ["editor", "reviewer"] as const;
export type AlignmentQualityAssessmentScope =
  typeof ALIGNMENT_QUALITY_ASSESSMENT_SCOPES[number];

export const ALIGNMENT_QUALITY_VERDICTS = [
  "correct",
  "needs_adjustment",
  "unusable",
] as const;
export type AlignmentQualityVerdict = typeof ALIGNMENT_QUALITY_VERDICTS[number];

export const ALIGNMENT_QUALITY_ISSUE_CODES = [
  "lyric_mismatch",
  "missing_character",
  "duplicate_character",
  "filler_character",
  "overlapping_voices",
  "unclear_audio",
  "audio_desync",
  "source_separation_artifact",
  "boundary_offset",
  "other",
] as const;
export type AlignmentQualityIssueCode = typeof ALIGNMENT_QUALITY_ISSUE_CODES[number];

export type UpsertAlignmentQualityAssessmentRequest = {
  clientActionId: string;
  scope: AlignmentQualityAssessmentScope;
  verdict: AlignmentQualityVerdict;
  issueCodes: AlignmentQualityIssueCode[];
};

export type AlignmentQualityAssessmentSummary = {
  id: string;
  alignmentApplicationId: string;
  assessorUserId: string;
  scope: AlignmentQualityAssessmentScope;
  verdict: AlignmentQualityVerdict;
  issueCodes: AlignmentQualityIssueCode[];
  isCurrent: boolean;
  createdAt: string;
  supersededAt: string | null;
};

export type AlignmentQualityAssessmentList = {
  items: AlignmentQualityAssessmentSummary[];
  isPartial: boolean;
};

export type ApplyAlignmentRunValidationResult =
  | { success: true; data: ApplyAlignmentRunRequest }
  | { success: false; message: string };

export type UpsertAlignmentQualityAssessmentValidationResult =
  | { success: true; data: UpsertAlignmentQualityAssessmentRequest }
  | { success: false; message: string };

/** 创建请求只允许选择服务端预设；正文、revision、音轨、来源与模型配置均不能由浏览器自报。 */
export function parseCreateAlignmentRunRequest(value: unknown): CreateAlignmentRunValidationResult {
  if (!isPlainObject(value)) return { success: false, message: "强制对齐请求格式不正确。" };
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("clientRequestId") || !keys.includes("modelPreset")) {
    return { success: false, message: "强制对齐请求包含缺失或未支持的字段。" };
  }
  if (typeof value.clientRequestId !== "string" || !UUID_PATTERN.test(value.clientRequestId)) {
    return { success: false, message: "clientRequestId 必须是有效的 UUID。" };
  }
  if (!FORCE_ALIGNMENT_MODEL_PRESETS.includes(value.modelPreset as ForceAlignmentModelPreset)) {
    return { success: false, message: "强制对齐模型预设不受支持。" };
  }
  return {
    success: true,
    data: {
      clientRequestId: value.clientRequestId,
      modelPreset: value.modelPreset as ForceAlignmentModelPreset,
    },
  };
}

/** 应用请求只声明一次逻辑动作及浏览器当前 revision；预测、命令和目标边界全部由服务端权威生成。 */
export function parseApplyAlignmentRunRequest(value: unknown): ApplyAlignmentRunValidationResult {
  if (!isPlainObject(value)) return { success: false, message: "强制对齐应用请求格式不正确。" };
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("clientActionId") || !keys.includes("baseRevision")) {
    return { success: false, message: "强制对齐应用请求包含缺失或未支持的字段。" };
  }
  if (typeof value.clientActionId !== "string" || !UUID_PATTERN.test(value.clientActionId)) {
    return { success: false, message: "clientActionId 必须是有效的 UUID。" };
  }
  if (!Number.isInteger(value.baseRevision) ||
      (value.baseRevision as number) < 1 ||
      (value.baseRevision as number) >= 2_147_483_647) {
    return { success: false, message: "baseRevision 必须是有效的正整数。" };
  }
  return {
    success: true,
    data: {
      clientActionId: value.clientActionId,
      baseRevision: value.baseRevision as number,
    },
  };
}

/**
 * 质量评价只接收有限枚举，不允许自由文本或客户端自报模型、正文和 revision。
 * 原因按固定顺序规范化，保证同一逻辑请求在多端重试时生成完全一致的 request hash。
 */
export function parseUpsertAlignmentQualityAssessmentRequest(
  value: unknown,
): UpsertAlignmentQualityAssessmentValidationResult {
  if (!isPlainObject(value)) return { success: false, message: "强制对齐质量评价格式不正确。" };
  const keys = Object.keys(value);
  const expectedKeys = ["clientActionId", "scope", "verdict", "issueCodes"];
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    return { success: false, message: "强制对齐质量评价包含缺失或未支持的字段。" };
  }
  if (typeof value.clientActionId !== "string" || !UUID_PATTERN.test(value.clientActionId)) {
    return { success: false, message: "clientActionId 必须是有效的 UUID。" };
  }
  if (!ALIGNMENT_QUALITY_ASSESSMENT_SCOPES.includes(
    value.scope as AlignmentQualityAssessmentScope,
  )) {
    return { success: false, message: "质量评价 scope 不受支持。" };
  }
  if (!ALIGNMENT_QUALITY_VERDICTS.includes(value.verdict as AlignmentQualityVerdict)) {
    return { success: false, message: "质量评价 verdict 不受支持。" };
  }
  if (!Array.isArray(value.issueCodes)) {
    return { success: false, message: "质量评价 issueCodes 必须是数组。" };
  }
  const issueCodes = value.issueCodes as unknown[];
  if (issueCodes.some((code) =>
    typeof code !== "string" ||
    !ALIGNMENT_QUALITY_ISSUE_CODES.includes(code as AlignmentQualityIssueCode))) {
    return { success: false, message: "质量评价包含未知的异常原因。" };
  }
  if (new Set(issueCodes).size !== issueCodes.length) {
    return { success: false, message: "质量评价的异常原因不能重复。" };
  }
  const verdict = value.verdict as AlignmentQualityVerdict;
  if (verdict === "correct" && issueCodes.length > 0) {
    return { success: false, message: "评价为正确时不能同时选择异常原因。" };
  }
  if (verdict !== "correct" && issueCodes.length === 0) {
    return { success: false, message: "评价为需修改或不可用时至少选择一个异常原因。" };
  }
  const canonicalIssues = ALIGNMENT_QUALITY_ISSUE_CODES.filter((code) =>
    issueCodes.includes(code));
  return {
    success: true,
    data: {
      clientActionId: value.clientActionId,
      scope: value.scope as AlignmentQualityAssessmentScope,
      verdict,
      issueCodes: canonicalIssues,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
