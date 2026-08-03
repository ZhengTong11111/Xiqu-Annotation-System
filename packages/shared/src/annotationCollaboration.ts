export const ANNOTATION_COLLABORATION_PROTOCOL_VERSION = 1 as const;

export const ANNOTATION_COLLABORATION_HEARTBEAT_MS = 20_000;
export const ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL = "xiqu-collaboration-v1";
export const ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX = "xiqu-ticket.";

export type AnnotationCollaborationTicket = {
  ticket: string;
  expiresAt: string;
  websocketPath: string;
};

export type AnnotationCollaborationSessionReadyMessage = {
  version: typeof ANNOTATION_COLLABORATION_PROTOCOL_VERSION;
  type: "session.ready";
  annotationFileId: string;
  revision: number;
  operationCursor: string;
  heartbeatIntervalMs: number;
};

export type AnnotationRevisionAdvancedMessage = {
  version: typeof ANNOTATION_COLLABORATION_PROTOCOL_VERSION;
  type: "annotation.revision.advanced";
  annotationFileId: string;
  revision: number;
  operationCursor: string;
};

export type AnnotationCollaborationServerMessage =
  | AnnotationCollaborationSessionReadyMessage
  | AnnotationRevisionAdvancedMessage;

const MESSAGE_KEYS = {
  "session.ready": [
    "version",
    "type",
    "annotationFileId",
    "revision",
    "operationCursor",
    "heartbeatIntervalMs",
  ],
  "annotation.revision.advanced": [
    "version",
    "type",
    "annotationFileId",
    "revision",
    "operationCursor",
  ],
} as const;

// WebSocket 是不可信输入边界；严格 parser 防止未知协议消息进入同步状态机。
export function parseAnnotationCollaborationServerMessage(
  input: unknown,
): AnnotationCollaborationServerMessage | null {
  if (!isRecord(input) || input.version !== ANNOTATION_COLLABORATION_PROTOCOL_VERSION) {
    return null;
  }
  if (input.type !== "session.ready" && input.type !== "annotation.revision.advanced") {
    return null;
  }
  if (!hasExactKeys(input, MESSAGE_KEYS[input.type])) return null;
  if (
    !isStableId(input.annotationFileId) ||
    !isPositiveInteger(input.revision) ||
    !isBoundedString(input.operationCursor, 1, 2_048)
  ) {
    return null;
  }
  if (input.type === "session.ready") {
    if (!isIntegerInRange(input.heartbeatIntervalMs, 1_000, 120_000)) {
      return null;
    }
    return {
      version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
      type: input.type,
      annotationFileId: input.annotationFileId,
      revision: input.revision,
      operationCursor: input.operationCursor,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
    };
  }
  return {
    version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
    type: input.type,
    annotationFileId: input.annotationFileId,
    revision: input.revision,
    operationCursor: input.operationCursor,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isStableId(value: unknown): value is string {
  return isBoundedString(value, 1, 200) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  return typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
