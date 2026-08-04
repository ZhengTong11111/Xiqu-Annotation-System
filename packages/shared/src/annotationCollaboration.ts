export const ANNOTATION_COLLABORATION_PROTOCOL_VERSION = 1 as const;

export const ANNOTATION_COLLABORATION_HEARTBEAT_MS = 20_000;
export const ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL = "xiqu-collaboration-v1";
export const ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX = "xiqu-ticket.";
export const ANNOTATION_COLLABORATION_CLIENT_MESSAGE_MAX_BYTES = 1_024;
export const ANNOTATION_REMOTE_PLAYHEAD_MAX_SECONDS = 604_800;

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

export type AnnotationPresenceMember = {
  userId: string;
  accountName: string;
  displayName: string;
  connectionCount: number;
  lastSeenAt: string;
};

export type AnnotationPresenceSnapshotMessage = {
  version: typeof ANNOTATION_COLLABORATION_PROTOCOL_VERSION;
  type: "presence.snapshot";
  annotationFileId: string;
  generatedAt: string;
  members: AnnotationPresenceMember[];
};

export type AnnotationPlayheadUpdateMessage = {
  version: typeof ANNOTATION_COLLABORATION_PROTOCOL_VERSION;
  type: "presence.playhead.update";
  sequence: number;
  time: number;
  playing: boolean;
};

export type AnnotationCollaborationClientMessage = AnnotationPlayheadUpdateMessage;

export type AnnotationRemotePlayheadMessage = {
  version: typeof ANNOTATION_COLLABORATION_PROTOCOL_VERSION;
  type: "presence.playhead.changed";
  annotationFileId: string;
  activitySessionId: string;
  userId: string;
  sequence: number;
  observedAt: string;
  playhead: { time: number; playing: boolean } | null;
};

export type AnnotationCollaborationServerMessage =
  | AnnotationCollaborationSessionReadyMessage
  | AnnotationRevisionAdvancedMessage
  | AnnotationPresenceSnapshotMessage
  | AnnotationRemotePlayheadMessage;

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
  "presence.snapshot": [
    "version",
    "type",
    "annotationFileId",
    "generatedAt",
    "members",
  ],
  "presence.playhead.changed": [
    "version",
    "type",
    "annotationFileId",
    "activitySessionId",
    "userId",
    "sequence",
    "observedAt",
    "playhead",
  ],
} as const;

const CLIENT_MESSAGE_KEYS = {
  "presence.playhead.update": ["version", "type", "sequence", "time", "playing"],
} as const;
const PLAYHEAD_KEYS = ["time", "playing"] as const;

const PRESENCE_MEMBER_KEYS = [
  "userId",
  "accountName",
  "displayName",
  "connectionCount",
  "lastSeenAt",
] as const;
const MAX_PRESENCE_MEMBERS = 200;
const MAX_CONNECTIONS_PER_MEMBER = 100;

// WebSocket 是不可信输入边界；严格 parser 防止未知协议消息进入同步状态机。
export function parseAnnotationCollaborationServerMessage(
  input: unknown,
): AnnotationCollaborationServerMessage | null {
  if (!isRecord(input) || input.version !== ANNOTATION_COLLABORATION_PROTOCOL_VERSION) {
    return null;
  }
  if (
    input.type !== "session.ready" &&
    input.type !== "annotation.revision.advanced" &&
    input.type !== "presence.snapshot" &&
    input.type !== "presence.playhead.changed"
  ) {
    return null;
  }
  if (!hasExactKeys(input, MESSAGE_KEYS[input.type])) return null;
  if (input.type === "presence.playhead.changed") {
    if (
      !isStableId(input.annotationFileId) ||
      !isStableId(input.activitySessionId) ||
      !isStableId(input.userId) ||
      !isSafePositiveInteger(input.sequence) ||
      !isIsoTimestamp(input.observedAt) ||
      (input.playhead !== null && !isValidPlayhead(input.playhead))
    ) return null;
    return {
      version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
      type: input.type,
      annotationFileId: input.annotationFileId,
      activitySessionId: input.activitySessionId,
      userId: input.userId,
      sequence: input.sequence,
      observedAt: input.observedAt,
      playhead: input.playhead === null
        ? null
        : { time: input.playhead.time, playing: input.playhead.playing },
    };
  }
  if (input.type === "presence.snapshot") {
    if (
      !isStableId(input.annotationFileId) ||
      !isIsoTimestamp(input.generatedAt) ||
      !Array.isArray(input.members) ||
      input.members.length > MAX_PRESENCE_MEMBERS
    ) return null;
    const members: AnnotationPresenceMember[] = [];
    const userIds = new Set<string>();
    for (const member of input.members) {
      if (
        !isRecord(member) ||
        !hasExactKeys(member, PRESENCE_MEMBER_KEYS) ||
        !isStableId(member.userId) ||
        !isBoundedString(member.accountName, 1, 200) ||
        !isBoundedString(member.displayName, 1, 200) ||
        !isIntegerInRange(member.connectionCount, 1, MAX_CONNECTIONS_PER_MEMBER) ||
        !isIsoTimestamp(member.lastSeenAt) ||
        userIds.has(member.userId)
      ) return null;
      userIds.add(member.userId);
      members.push({
        userId: member.userId,
        accountName: member.accountName,
        displayName: member.displayName,
        connectionCount: member.connectionCount,
        lastSeenAt: member.lastSeenAt,
      });
    }
    return {
      version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
      type: input.type,
      annotationFileId: input.annotationFileId,
      generatedAt: input.generatedAt,
      members,
    };
  }
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

// 客户端业务帧使用独立 parser，避免服务端消息合同被误当作可接受的上行命令。
export function parseAnnotationCollaborationClientMessage(
  input: unknown,
): AnnotationCollaborationClientMessage | null {
  if (
    !isRecord(input) ||
    input.version !== ANNOTATION_COLLABORATION_PROTOCOL_VERSION ||
    input.type !== "presence.playhead.update" ||
    !hasExactKeys(input, CLIENT_MESSAGE_KEYS[input.type]) ||
    !isSafePositiveInteger(input.sequence) ||
    !isFiniteNumberInRange(input.time, 0, ANNOTATION_REMOTE_PLAYHEAD_MAX_SECONDS) ||
    typeof input.playing !== "boolean"
  ) return null;
  return {
    version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
    type: input.type,
    sequence: input.sequence,
    time: input.time,
    playing: input.playing,
  };
}

function isValidPlayhead(value: unknown): value is { time: number; playing: boolean } {
  return isRecord(value) &&
    hasExactKeys(value, PLAYHEAD_KEYS) &&
    isFiniteNumberInRange(value.time, 0, ANNOTATION_REMOTE_PLAYHEAD_MAX_SECONDS) &&
    typeof value.playing === "boolean";
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

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 20, 40)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
