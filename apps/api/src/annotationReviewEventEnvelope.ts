import type { AnnotationReviewEvent } from "./annotationCollaborationHub.js";
import { createSchemaIsolatedCollaborationChannel } from "./postgresCollaborationChannel.js";

const EVENT_KEYS = [
  "version", "type", "sourceInstanceId", "annotationFileId", "eventId", "occurredAt",
] as const;

export function createAnnotationReviewChannel(schema: string) {
  return createSchemaIsolatedCollaborationChannel("review", schema);
}

export function serializeAnnotationReviewEventEnvelope(
  sourceInstanceId: string,
  event: AnnotationReviewEvent,
) {
  const envelope = {
    version: 1,
    type: "annotation.review.changed",
    sourceInstanceId,
    ...event,
  };
  if (!parseAnnotationReviewEventEnvelope(envelope)) {
    throw new Error("审核失效通知不符合内部协议。");
  }
  return JSON.stringify(envelope);
}

export function parseSerializedAnnotationReviewEventEnvelope(payload: string | undefined) {
  if (!payload || Buffer.byteLength(payload, "utf8") > 2_048) return null;
  try {
    return parseAnnotationReviewEventEnvelope(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function parseAnnotationReviewEventEnvelope(input: unknown) {
  if (!isRecord(input) || !hasExactKeys(input, EVENT_KEYS)) return null;
  if (
    input.version !== 1 ||
    input.type !== "annotation.review.changed" ||
    !isStableId(input.sourceInstanceId) ||
    !isStableId(input.annotationFileId) ||
    !isStableId(input.eventId) ||
    typeof input.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(input.occurredAt))
  ) return null;
  return input as typeof input & {
    sourceInstanceId: string;
    annotationFileId: string;
    eventId: string;
    occurredAt: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
