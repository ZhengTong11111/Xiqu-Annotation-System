import type {
  AnnotationPresenceMember,
  AnnotationRemoteTimelineActivityMessage,
  AnnotationTimelineActivity,
} from "@xiqu/shared";

export const REMOTE_ACTIVITY_STALE_MS = 6_000;
export const REMOTE_ACTIVITY_VIEW_LIMIT = 32;
export const REMOTE_SELECTION_VIEW_LIMIT = 12;

export type RemoteTimelineActivityEntry = {
  activitySessionId: string;
  userId: string;
  sequence: number;
  observedAt: string;
  receivedAtMs: number;
  activity: AnnotationTimelineActivity;
};

export type RemoteTimelineActivityRegistry = ReadonlyMap<string, RemoteTimelineActivityEntry>;

export type RemoteTimelineActivityView = RemoteTimelineActivityEntry & {
  displayName: string;
  color: string;
  showSelection: boolean;
};

// Registry 以连接为粒度执行 sequence/clear；账号多窗口只在最终展示阶段聚合。
export function applyRemoteTimelineActivityMessage(
  registry: RemoteTimelineActivityRegistry,
  message: AnnotationRemoteTimelineActivityMessage,
  receivedAtMs: number,
): RemoteTimelineActivityRegistry {
  const previous = registry.get(message.activitySessionId);
  if (previous && message.sequence <= previous.sequence) return registry;
  const next = new Map(registry);
  if (message.activity === null) {
    next.delete(message.activitySessionId);
    return next;
  }
  next.set(message.activitySessionId, {
    activitySessionId: message.activitySessionId,
    userId: message.userId,
    sequence: message.sequence,
    observedAt: message.observedAt,
    receivedAtMs,
    activity: cloneActivity(message.activity),
  });
  return next;
}

export function pruneRemoteTimelineActivityRegistry(
  registry: RemoteTimelineActivityRegistry,
  nowMs: number,
): RemoteTimelineActivityRegistry {
  const next = new Map(
    [...registry].filter(([, entry]) => nowMs - entry.receivedAtMs <= REMOTE_ACTIVITY_STALE_MS),
  );
  return next.size === registry.size ? registry : next;
}

export function buildRemoteTimelineActivityView(
  registry: RemoteTimelineActivityRegistry,
  members: AnnotationPresenceMember[],
  currentUserId: string | null,
  nowMs: number,
): RemoteTimelineActivityView[] {
  const memberByUserId = new Map(members.map((member) => [member.userId, member]));
  const latestByUserId = new Map<string, RemoteTimelineActivityEntry>();
  for (const entry of registry.values()) {
    if (
      entry.userId === currentUserId ||
      nowMs - entry.receivedAtMs > REMOTE_ACTIVITY_STALE_MS ||
      !memberByUserId.has(entry.userId)
    ) continue;
    const previous = latestByUserId.get(entry.userId);
    if (
      !previous || entry.receivedAtMs > previous.receivedAtMs ||
      (entry.receivedAtMs === previous.receivedAtMs &&
        entry.activitySessionId.localeCompare(previous.activitySessionId) > 0)
    ) latestByUserId.set(entry.userId, entry);
  }
  return [...latestByUserId.values()]
    .sort((left, right) => right.receivedAtMs - left.receivedAtMs || left.userId.localeCompare(right.userId))
    .slice(0, REMOTE_ACTIVITY_VIEW_LIMIT)
    .map((entry, index) => ({
      ...entry,
      displayName: memberByUserId.get(entry.userId)?.displayName ?? "协作者",
      color: getRemoteActivityColor(entry.userId),
      showSelection: Boolean(entry.activity.selection) && index < REMOTE_SELECTION_VIEW_LIMIT,
    }));
}

function cloneActivity(activity: AnnotationTimelineActivity): AnnotationTimelineActivity {
  return {
    playhead: activity.playhead ? { ...activity.playhead } : null,
    pointer: activity.pointer ? { ...activity.pointer } : null,
    selection: activity.selection
      ? { ...activity.selection, kinds: [...activity.selection.kinds] }
      : null,
  };
}

// 颜色只由账号 id 稳定推导，不进入文件格式，也不覆盖用户自定义轨道颜色。
function getRemoteActivityColor(userId: string) {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 72% 46%)`;
}
