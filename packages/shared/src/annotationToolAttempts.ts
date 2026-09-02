export const ANNOTATION_TOOL_EVENT_NAMES = ["sentence_character_even_timing_reset"] as const;
export const ANNOTATION_TOOL_ATTEMPT_ENTRY_POINTS = ["sentence_list", "timeline_context_menu"] as const;
export const ANNOTATION_TOOL_ATTEMPT_OUTCOMES = [
  "cancelled",
  "no_change",
  "blocked",
  "failed",
  "committed",
] as const;
export const ANNOTATION_TOOL_ATTEMPT_EXTERNAL_OUTCOMES = [
  "cancelled",
  "no_change",
  "blocked",
  "failed",
] as const;
export const ANNOTATION_TOOL_ATTEMPT_REASON_CODES = [
  "user_cancelled",
  "no_character_annotations",
  "no_timing_change",
  "invalid_sentence_range",
  "editing_blocked",
  "command_rejected",
  "unexpected_error",
] as const;
export const MAX_ANNOTATION_TOOL_ATTEMPT_BATCH_SIZE = 100;
export const MAX_ANNOTATION_TOOL_ATTEMPT_DETAILS_BYTES = 2_048;

export type AnnotationToolEventName = typeof ANNOTATION_TOOL_EVENT_NAMES[number];
export type AnnotationToolAttemptEntryPoint = typeof ANNOTATION_TOOL_ATTEMPT_ENTRY_POINTS[number];
export type AnnotationToolAttemptOutcome = typeof ANNOTATION_TOOL_ATTEMPT_OUTCOMES[number];
export type AnnotationToolAttemptExternalOutcome = typeof ANNOTATION_TOOL_ATTEMPT_EXTERNAL_OUTCOMES[number];
export type AnnotationToolAttemptReasonCode = typeof ANNOTATION_TOOL_ATTEMPT_REASON_CODES[number];

export type AnnotationToolAttemptDetails = { reasonCode?: AnnotationToolAttemptReasonCode };

export type AnnotationToolAttemptState = {
  id: string;
  eventName: AnnotationToolEventName;
  annotationFileId: string;
  sentenceId: string;
  entryPoint: AnnotationToolAttemptEntryPoint;
  invokedAt: string;
  confirmedAt?: string | null;
  finishedAt?: string | null;
  outcome?: AnnotationToolAttemptExternalOutcome | null;
  suppressPrompt: boolean;
  characterCount: number;
  sentenceDurationMs: number;
  details?: AnnotationToolAttemptDetails | null;
};

export type SubmitAnnotationToolAttemptBatchRequest = { attempts: AnnotationToolAttemptState[] };
export type AnnotationToolAttemptRecord = Omit<AnnotationToolAttemptState, "annotationFileId" | "outcome"> & {
  actorUserId: string | null;
  annotationFileId: string | null;
  outcome: AnnotationToolAttemptOutcome | null;
  committedRevision: number | null;
  createdAt: string;
  updatedAt: string;
};
export type SubmitAnnotationToolAttemptBatchResponse = { attempts: AnnotationToolAttemptRecord[] };
export type AnnotationToolAttemptSummary = {
  from: string;
  to: string;
  total: number;
  byEventName: Record<AnnotationToolEventName, number>;
  byEntryPoint: Record<AnnotationToolAttemptEntryPoint, number>;
  byOutcome: Record<"pending" | AnnotationToolAttemptOutcome, number>;
};

export type AnnotationToolAttemptBatchValidationResult =
  | { success: true; data: SubmitAnnotationToolAttemptBatchRequest }
  | { success: false; code: "invalid_request" | "invalid_batch" | "invalid_attempt"; attemptIndex?: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_NAMES = new Set<string>(ANNOTATION_TOOL_EVENT_NAMES);
const ENTRY_POINTS = new Set<string>(ANNOTATION_TOOL_ATTEMPT_ENTRY_POINTS);
const EXTERNAL_OUTCOMES = new Set<string>(ANNOTATION_TOOL_ATTEMPT_EXTERNAL_OUTCOMES);
const REASON_CODES = new Set<string>(ANNOTATION_TOOL_ATTEMPT_REASON_CODES);

/** 批量状态快照使用 exact-key parser，外部输入在类型层和运行时都不能自报 committed。 */
export function parseAnnotationToolAttemptBatchRequest(
  value: unknown,
): AnnotationToolAttemptBatchValidationResult {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["attempts"])) {
    return { success: false, code: "invalid_request" };
  }
  if (!Array.isArray(value.attempts) || value.attempts.length < 1 ||
    value.attempts.length > MAX_ANNOTATION_TOOL_ATTEMPT_BATCH_SIZE) {
    return { success: false, code: "invalid_batch" };
  }
  const ids = new Set<string>();
  const attempts: AnnotationToolAttemptState[] = [];
  for (const [attemptIndex, raw] of value.attempts.entries()) {
    const attempt = parseAttempt(raw);
    if (!attempt || ids.has(attempt.id)) {
      return { success: false, code: "invalid_attempt", attemptIndex };
    }
    ids.add(attempt.id);
    attempts.push(attempt);
  }
  return { success: true, data: { attempts } };
}

function parseAttempt(value: unknown): AnnotationToolAttemptState | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, [
    "id", "eventName", "annotationFileId", "sentenceId", "entryPoint", "invokedAt",
    "confirmedAt", "finishedAt", "outcome", "suppressPrompt", "characterCount",
    "sentenceDurationMs", "details",
  ])) return null;
  if (!isStringInSet(value.eventName, EVENT_NAMES) || !isStringInSet(value.entryPoint, ENTRY_POINTS)) {
    return null;
  }
  const outcome = value.outcome === undefined || value.outcome === null
    ? null
    : isStringInSet(value.outcome, EXTERNAL_OUTCOMES) ? value.outcome : null;
  if (value.outcome !== undefined && value.outcome !== null && outcome === null) return null;
  const invokedAt = parseCanonicalTimestamp(value.invokedAt);
  const confirmedAt = parseOptionalTimestamp(value.confirmedAt);
  const finishedAt = parseOptionalTimestamp(value.finishedAt);
  if (!invokedAt || confirmedAt === undefined || finishedAt === undefined) return null;
  if ((outcome === null) !== (finishedAt === null)) return null;
  if ((confirmedAt && confirmedAt < invokedAt) || (finishedAt && finishedAt < (confirmedAt ?? invokedAt))) return null;
  const details = parseDetails(value.details);
  if (details === undefined) return null;
  if (
    typeof value.id !== "string" || !UUID_PATTERN.test(value.id) ||
    !isBoundedId(value.annotationFileId) || !isBoundedId(value.sentenceId) ||
    typeof value.suppressPrompt !== "boolean" ||
    !isBoundedInteger(value.characterCount, 0, 10_000) ||
    !isBoundedInteger(value.sentenceDurationMs, 0, 86_400_000)
  ) return null;
  return {
    id: value.id,
    eventName: value.eventName as AnnotationToolEventName,
    annotationFileId: value.annotationFileId,
    sentenceId: value.sentenceId,
    entryPoint: value.entryPoint as AnnotationToolAttemptEntryPoint,
    invokedAt,
    confirmedAt,
    finishedAt,
    outcome: outcome as AnnotationToolAttemptExternalOutcome | null,
    suppressPrompt: value.suppressPrompt,
    characterCount: value.characterCount,
    sentenceDurationMs: value.sentenceDurationMs,
    details,
  };
}

function parseDetails(value: unknown): AnnotationToolAttemptDetails | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["reasonCode"])) return undefined;
  if (value.reasonCode !== undefined && !isStringInSet(value.reasonCode, REASON_CODES)) return undefined;
  const details = value.reasonCode === undefined
    ? {}
    : { reasonCode: value.reasonCode as AnnotationToolAttemptReasonCode };
  return new TextEncoder().encode(JSON.stringify(details)).byteLength <= MAX_ANNOTATION_TOOL_ATTEMPT_DETAILS_BYTES
    ? details
    : undefined;
}

function parseOptionalTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return parseCanonicalTimestamp(value) ?? undefined;
}

function parseCanonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && value.trim() === value;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isStringInSet(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === "string" && values.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
