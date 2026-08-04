import type {
  AnnotationPresenceMember,
  AnnotationRemotePlayheadMessage,
} from "@xiqu/shared";

export const REMOTE_PLAYHEAD_STALE_MS = 6_000;
export const REMOTE_PLAYHEAD_VIEW_LIMIT = 32;

export type RemotePlayheadEntry = {
  activitySessionId: string;
  userId: string;
  sequence: number;
  observedAt: string;
  receivedAtMs: number;
  time: number;
  playing: boolean;
};

export type RemotePlayheadRegistry = ReadonlyMap<string, RemotePlayheadEntry>;

export type RemotePlayheadView = RemotePlayheadEntry & {
  displayName: string;
  color: string;
};

// Registry 以连接为粒度执行 sequence/clear；账号聚合只发生在最终展示阶段。
export function applyRemotePlayheadMessage(
  registry: RemotePlayheadRegistry,
  message: AnnotationRemotePlayheadMessage,
  receivedAtMs: number,
): RemotePlayheadRegistry {
  const previous = registry.get(message.activitySessionId);
  if (previous && message.sequence <= previous.sequence) return registry;
  const next = new Map(registry);
  if (message.playhead === null) {
    next.delete(message.activitySessionId);
    return next;
  }
  next.set(message.activitySessionId, {
    activitySessionId: message.activitySessionId,
    userId: message.userId,
    sequence: message.sequence,
    observedAt: message.observedAt,
    receivedAtMs,
    time: message.playhead.time,
    playing: message.playhead.playing,
  });
  return next;
}

export function pruneRemotePlayheadRegistry(
  registry: RemotePlayheadRegistry,
  nowMs: number,
): RemotePlayheadRegistry {
  const next = new Map(
    [...registry].filter(([, entry]) => nowMs - entry.receivedAtMs <= REMOTE_PLAYHEAD_STALE_MS),
  );
  return next.size === registry.size ? registry : next;
}

export function buildRemotePlayheadView(
  registry: RemotePlayheadRegistry,
  members: AnnotationPresenceMember[],
  currentUserId: string | null,
  nowMs: number,
): RemotePlayheadView[] {
  const memberByUserId = new Map(members.map((member) => [member.userId, member]));
  const latestByUserId = new Map<string, RemotePlayheadEntry>();
  for (const entry of registry.values()) {
    if (
      entry.userId === currentUserId ||
      nowMs - entry.receivedAtMs > REMOTE_PLAYHEAD_STALE_MS ||
      !memberByUserId.has(entry.userId)
    ) continue;
    const previous = latestByUserId.get(entry.userId);
    if (
      !previous ||
      entry.receivedAtMs > previous.receivedAtMs ||
      (entry.receivedAtMs === previous.receivedAtMs &&
        entry.activitySessionId.localeCompare(previous.activitySessionId) > 0)
    ) latestByUserId.set(entry.userId, entry);
  }
  return [...latestByUserId.values()]
    .sort((left, right) => right.receivedAtMs - left.receivedAtMs || left.userId.localeCompare(right.userId))
    .slice(0, REMOTE_PLAYHEAD_VIEW_LIMIT)
    .map((entry) => ({
      ...entry,
      displayName: memberByUserId.get(entry.userId)?.displayName ?? "协作者",
      color: getRemotePlayheadColor(entry.userId),
    }));
}

// 颜色只由账号 id 稳定推导，不进入文件格式，也不覆盖用户自定义轨道颜色。
function getRemotePlayheadColor(userId: string) {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 72% 46%)`;
}
