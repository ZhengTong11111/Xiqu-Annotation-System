import {
  parseAnnotationCollaborationServerMessage,
  type AnnotationRemotePlayheadMessage,
} from "@xiqu/shared";
import { createSchemaIsolatedCollaborationChannel } from "./postgresCollaborationChannel.js";

const MAX_EVENT_BYTES = 1_500;
const ENVELOPE_KEYS = ["sourceInstanceId", "message"] as const;

export type AnnotationRemoteActivityEvent = Omit<
  AnnotationRemotePlayheadMessage,
  "version" | "type"
>;

type AnnotationRemoteActivityEventEnvelope = {
  sourceInstanceId: string;
  message: AnnotationRemotePlayheadMessage;
};

export function createAnnotationRemoteActivityChannel(schema: string) {
  return createSchemaIsolatedCollaborationChannel("activity", schema);
}

// PostgreSQL 通知只携带最小运行时坐标，不包含账号显示名、权限或标注正文。
export function serializeAnnotationRemoteActivityEventEnvelope(
  sourceInstanceId: string,
  event: AnnotationRemoteActivityEvent,
) {
  const serialized = JSON.stringify({
    sourceInstanceId,
    message: {
      version: 1,
      type: "presence.playhead.changed",
      ...event,
    },
  } satisfies AnnotationRemoteActivityEventEnvelope);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("远端活动通知超过 PostgreSQL 安全字节上限。");
  }
  return serialized;
}

export function parseSerializedAnnotationRemoteActivityEventEnvelope(
  payload: string | undefined,
): AnnotationRemoteActivityEvent | null {
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) return null;
  try {
    const input: unknown = JSON.parse(payload);
    if (!isRecord(input) || !hasExactKeys(input, ENVELOPE_KEYS) || !isStableId(input.sourceInstanceId)) {
      return null;
    }
    const message = parseAnnotationCollaborationServerMessage(input.message);
    if (!message || message.type !== "presence.playhead.changed") return null;
    const { version: _version, type: _type, ...event } = message;
    return event;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
