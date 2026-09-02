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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
