import { createHash } from "node:crypto";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_RESOURCE_ID_LENGTH = 200;
const MAX_VERSION_LENGTH = 128;
const MAX_ALIGNMENT_CONFIG_BYTES = 12 * 1024;
const MAX_INPUT_REVISION = 2_147_483_647;
const MAX_SENTENCE_COUNT = 100_000;
const MAX_CHARACTER_COUNT = 1_000_000;
const MAX_AUDIO_OFFSET_MICROS = 86_400_000_000n;
const FORBIDDEN_CONFIG_KEY_PATTERN = /(?:access.?key|credential|password|play.?auth|secret|token|url)/iu;
const URL_VALUE_PATTERN = /(?:https?|wss?):\/\//iu;

const ALIGNMENT_IDENTITY_KEYS = new Set([
  "annotationFileId",
  "inputRevision",
  "inputTextFingerprint",
  "inputSentenceCount",
  "inputCharacterCount",
  "sourceMediaResourceId",
  "sourceFingerprint",
  "mediaAudioTrackId",
  "audioOffsetMicros",
  "mediaAnalysisFingerprint",
  "modelName",
  "modelVersion",
  "dictionaryVersion",
  "codeVersion",
  "config",
]);

export type AlignmentRunIdentityInput = {
  annotationFileId: string;
  inputRevision: number;
  inputTextFingerprint: string;
  inputSentenceCount: number;
  inputCharacterCount: number;
  sourceMediaResourceId: string;
  sourceFingerprint: string;
  mediaAudioTrackId: string;
  audioOffsetMicros: bigint;
  mediaAnalysisFingerprint: string | null;
  modelName: string;
  modelVersion: string;
  dictionaryVersion: string;
  codeVersion: string;
  config: unknown;
};

export type AlignmentJsonValue =
  | string
  | number
  | boolean
  | null
  | AlignmentJsonValue[]
  | { [key: string]: AlignmentJsonValue };

export type PreparedAlignmentRunIdentity = {
  config: { [key: string]: AlignmentJsonValue };
  configHash: string;
  identityHash: string;
  deduplicationKey: string;
};

/**
 * 对齐执行身份只接收会改变预测结果的稳定事实。调用账号、显示名、clientRequestId、正文、临时媒体 URL 与凭据
 * 不属于该合同；D2b 创建服务只能把经过当前文件/音轨重读后得到的事实传入这里。
 */
export function createAlignmentRunIdentity(input: unknown): PreparedAlignmentRunIdentity {
  assertExactIdentityObject(input);
  assertBoundedText(input.annotationFileId, "annotationFileId", MAX_RESOURCE_ID_LENGTH);
  assertBoundedInteger(input.inputRevision, "inputRevision", 1, MAX_INPUT_REVISION);
  assertSha256(input.inputTextFingerprint, "inputTextFingerprint");
  assertBoundedInteger(input.inputSentenceCount, "inputSentenceCount", 0, MAX_SENTENCE_COUNT);
  assertBoundedInteger(input.inputCharacterCount, "inputCharacterCount", 0, MAX_CHARACTER_COUNT);
  assertBoundedText(input.sourceMediaResourceId, "sourceMediaResourceId", MAX_RESOURCE_ID_LENGTH);
  assertSha256(input.sourceFingerprint, "sourceFingerprint");
  assertBoundedText(input.mediaAudioTrackId, "mediaAudioTrackId", MAX_RESOURCE_ID_LENGTH);
  assertAudioOffset(input.audioOffsetMicros);
  if (input.mediaAnalysisFingerprint !== null) {
    assertSha256(input.mediaAnalysisFingerprint, "mediaAnalysisFingerprint");
  }
  assertBoundedText(input.modelName, "modelName", MAX_VERSION_LENGTH);
  assertBoundedText(input.modelVersion, "modelVersion", MAX_VERSION_LENGTH);
  assertBoundedText(input.dictionaryVersion, "dictionaryVersion", MAX_VERSION_LENGTH);
  assertBoundedText(input.codeVersion, "codeVersion", MAX_VERSION_LENGTH);

  const config = normalizeConfig(input.config);
  const configJson = stableJsonStringify(config);
  const configHash = sha256(configJson);
  // BigInt 先转十进制字符串进入 canonical JSON，避免精度丢失，也与 PostgreSQL BIGINT 身份一致。
  const identityJson = stableJsonStringify({
    version: 1,
    annotationFileId: input.annotationFileId,
    inputRevision: input.inputRevision,
    inputTextFingerprint: input.inputTextFingerprint,
    inputSentenceCount: input.inputSentenceCount,
    inputCharacterCount: input.inputCharacterCount,
    sourceMediaResourceId: input.sourceMediaResourceId,
    sourceFingerprint: input.sourceFingerprint,
    mediaAudioTrackId: input.mediaAudioTrackId,
    audioOffsetMicros: input.audioOffsetMicros.toString(),
    mediaAnalysisFingerprint: input.mediaAnalysisFingerprint,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    dictionaryVersion: input.dictionaryVersion,
    codeVersion: input.codeVersion,
    configHash,
  });
  const identityHash = sha256(identityJson);
  return {
    config,
    configHash,
    identityHash,
    deduplicationKey: `force-alignment:v1:${identityHash}`,
  };
}

function assertExactIdentityObject(value: unknown): asserts value is AlignmentRunIdentityInput {
  if (!isPlainObject(value)) throw new Error("对齐执行身份必须是普通对象。");
  const keys = Object.keys(value);
  if (keys.length !== ALIGNMENT_IDENTITY_KEYS.size || keys.some((key) => !ALIGNMENT_IDENTITY_KEYS.has(key))) {
    throw new Error("对齐执行身份包含缺失或未支持的字段。");
  }
}

function assertBoundedText(value: unknown, field: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`对齐执行身份字段 ${field} 不合法。`);
  }
}

function assertBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`对齐执行身份字段 ${field} 不合法。`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`对齐执行身份字段 ${field} 必须是小写 SHA-256。`);
  }
}

function assertAudioOffset(value: unknown): asserts value is bigint {
  if (
    typeof value !== "bigint" ||
    value < -MAX_AUDIO_OFFSET_MICROS ||
    value > MAX_AUDIO_OFFSET_MICROS
  ) {
    throw new Error("对齐音轨偏移必须是一天范围内的整数微秒。");
  }
}

function normalizeConfig(value: unknown): { [key: string]: AlignmentJsonValue } {
  if (!isPlainObject(value)) throw new Error("对齐配置必须是普通 JSON 对象。");
  assertConfigContainsNoProtectedValues(value, []);
  let serialized: string;
  try {
    serialized = stableJsonStringify(value);
  } catch (error) {
    throw new Error("对齐配置只能包含有限大小的普通 JSON 值。", { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ALIGNMENT_CONFIG_BYTES) {
    throw new Error("对齐配置超过容量上限。");
  }
  // round-trip 生成脱离调用方引用的规范 JSON，后续异步持久化不能被外部突变。
  return JSON.parse(serialized) as { [key: string]: AlignmentJsonValue };
}

function assertConfigContainsNoProtectedValues(value: unknown, path: string[]) {
  if (typeof value === "string" && URL_VALUE_PATTERN.test(value)) {
    throw new Error(`对齐配置不能保存 URL（${path.join(".") || "config"}）。`);
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConfigContainsNoProtectedValues(item, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEY_PATTERN.test(key)) {
      throw new Error(`对齐配置不能保存凭据或临时 URL 字段（${[...path, key].join(".")}）。`);
    }
    assertConfigContainsNoProtectedValues(child, [...path, key]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
