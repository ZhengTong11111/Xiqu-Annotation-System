import { createSchemaIsolatedCollaborationChannel } from "./postgresCollaborationChannel.js";

const EVENT_VERSION = 1 as const;
const EVENT_TYPE = "annotation.presence.changed" as const;
const MAX_EVENT_BYTES = 1_000;
const MAX_ID_LENGTH = 200;

export type AnnotationPresenceChangedEvent = {
  annotationFileId: string;
};

export type AnnotationPresenceEventEnvelope = AnnotationPresenceChangedEvent & {
  version: typeof EVENT_VERSION;
  type: typeof EVENT_TYPE;
  sourceInstanceId: string;
};

const EVENT_KEYS = [
  "version",
  "type",
  "sourceInstanceId",
  "annotationFileId",
] as const;

export function createAnnotationPresenceChannel(schema: string) {
  return createSchemaIsolatedCollaborationChannel("presence", schema);
}

// Presence 的 PostgreSQL 消息只是一条文件级失效提示，禁止携带成员身份或运行时状态。
export function serializeAnnotationPresenceEventEnvelope(
  sourceInstanceId: string,
  event: AnnotationPresenceChangedEvent,
) {
  const envelope: AnnotationPresenceEventEnvelope = {
    version: EVENT_VERSION,
    type: EVENT_TYPE,
    sourceInstanceId,
    ...event,
  };
  const parsed = parseAnnotationPresenceEventEnvelope(envelope);
  if (!parsed) throw new Error("presence 通知事件不符合内部协议。");
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("presence 通知事件超过 PostgreSQL NOTIFY 安全字节预算。");
  }
  return serialized;
}

export function parseSerializedAnnotationPresenceEventEnvelope(
  payload: string | undefined,
): AnnotationPresenceChangedEvent | null {
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) return null;
  try {
    const input: unknown = JSON.parse(payload);
    const parsed = parseAnnotationPresenceEventEnvelope(input);
    return parsed ? { annotationFileId: parsed.annotationFileId } : null;
  } catch {
    return null;
  }
}

export function parseAnnotationPresenceEventEnvelope(
  input: unknown,
): AnnotationPresenceEventEnvelope | null {
  if (
    !isRecord(input) ||
    input.version !== EVENT_VERSION ||
    input.type !== EVENT_TYPE ||
    !hasExactKeys(input, EVENT_KEYS) ||
    !isStableId(input.sourceInstanceId) ||
    !isStableId(input.annotationFileId)
  ) return null;
  return {
    version: EVENT_VERSION,
    type: EVENT_TYPE,
    sourceInstanceId: input.sourceInstanceId,
    annotationFileId: input.annotationFileId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
