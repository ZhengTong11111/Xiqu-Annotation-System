import { createHash } from "node:crypto";
import type { AnnotationRevisionEvent } from "./annotationCollaborationHub.js";

const EVENT_VERSION = 1 as const;
const EVENT_TYPE = "annotation.revision.advanced" as const;
const MAX_EVENT_BYTES = 7_000;
const MAX_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2_048;

export type AnnotationRevisionEventEnvelope = AnnotationRevisionEvent & {
  version: typeof EVENT_VERSION;
  type: typeof EVENT_TYPE;
  sourceInstanceId: string;
};

const EVENT_KEYS = [
  "version",
  "type",
  "sourceInstanceId",
  "annotationFileId",
  "revision",
  "operationCursor",
] as const;

/**
 * 生成 schema 隔离的固定 PostgreSQL channel。
 *
 * PostgreSQL 标识符最长 63 字节；使用摘要既避免超长 schema 截断碰撞，也避免把外部字符串拼入 LISTEN SQL。
 */
export function createAnnotationRevisionChannel(schema: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`无法为非法 PostgreSQL schema“${schema}”创建协作通知 channel。`);
  }
  const digest = createHash("sha256").update(schema).digest("hex").slice(0, 16);
  return `xiqu_annotation_revision_${digest}`;
}

/**
 * 内部事件同样经过严格序列化边界。NOTIFY 是有损提示，不值得冒险接收任意 JSON 或逼近 8 KiB 硬上限。
 */
export function serializeAnnotationRevisionEventEnvelope(
  sourceInstanceId: string,
  event: AnnotationRevisionEvent,
) {
  const envelope: AnnotationRevisionEventEnvelope = {
    version: EVENT_VERSION,
    type: EVENT_TYPE,
    sourceInstanceId,
    ...event,
  };
  const parsed = parseAnnotationRevisionEventEnvelope(envelope);
  if (!parsed) throw new Error("revision 通知事件不符合内部协议。");
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("revision 通知事件超过 PostgreSQL NOTIFY 安全字节预算。");
  }
  return serialized;
}

export function parseAnnotationRevisionEventEnvelope(
  input: unknown,
): AnnotationRevisionEventEnvelope | null {
  if (
    !isRecord(input) ||
    input.version !== EVENT_VERSION ||
    input.type !== EVENT_TYPE ||
    !hasExactKeys(input, EVENT_KEYS) ||
    !isStableId(input.sourceInstanceId) ||
    !isStableId(input.annotationFileId) ||
    !Number.isInteger(input.revision) ||
    Number(input.revision) <= 0 ||
    !isBoundedString(input.operationCursor, 1, MAX_CURSOR_LENGTH)
  ) return null;
  return {
    version: EVENT_VERSION,
    type: EVENT_TYPE,
    sourceInstanceId: input.sourceInstanceId,
    annotationFileId: input.annotationFileId,
    revision: Number(input.revision),
    operationCursor: input.operationCursor,
  };
}

export function parseSerializedAnnotationRevisionEventEnvelope(
  payload: string | undefined,
) {
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) return null;
  try {
    return parseAnnotationRevisionEventEnvelope(JSON.parse(payload));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isStableId(value: unknown): value is string {
  return isBoundedString(value, 1, MAX_ID_LENGTH) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum;
}
