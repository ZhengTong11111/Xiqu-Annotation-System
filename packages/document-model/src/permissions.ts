import type {
  EffectiveWorkspacePermission,
  MutationScopeViolation,
  ProjectMutation,
  TimeRangeScope,
} from "@xiqu/shared";

export type {
  EffectiveWorkspacePermission,
  MutationScopeViolation,
  ProjectMutation,
} from "@xiqu/shared";

export type ProjectScopeValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

type RecordValue = Record<string, unknown>;
type TimeRange = { startTime: number; endTime: number };
type MutationCollector = { add: (mutation: ProjectMutation) => void };

const KNOWN_PROJECT_KEYS = new Set([
  "video",
  "subtitleLines",
  "characterAnnotations",
  "gongcheAnnotations",
  "banyanSections",
  "banyanMarks",
  "actionAnnotations",
  "builtinTracks",
  "customTracks",
  "activeTrackOrder",
]);

const CUSTOM_TRACK_CONTENT_KEYS = new Set(["blocks", "attachedPointTracks"]);
const BUILTIN_TRACK_CONTENT_KEYS = new Set(["attachedPointTracks"]);

export function isMembershipActive(
  membership: { expiresAt?: string | null },
  now = Date.now(),
) {
  if (!membership.expiresAt) {
    return true;
  }
  const expiresAt = Date.parse(membership.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function validateProjectScope(
  scope: unknown,
): ProjectScopeValidationResult {
  if (!isRecord(scope)) {
    return { valid: false, reason: "scope 必须是对象。" };
  }
  const allowedKeys = new Set(["timeRange", "trackScope"]);
  if (Object.keys(scope).some((key) => !allowedKeys.has(key))) {
    return { valid: false, reason: "scope 包含不支持的字段。" };
  }
  if (scope.timeRange !== undefined) {
    if (!isRecord(scope.timeRange)) {
      return { valid: false, reason: "timeRange 必须是对象。" };
    }
    const { startTime, endTime } = scope.timeRange;
    if (
      !isFiniteNumber(startTime) ||
      !isFiniteNumber(endTime) ||
      startTime < 0 ||
      endTime <= startTime
    ) {
      return {
        valid: false,
        reason: "时间范围必须满足 0 <= startTime < endTime。",
      };
    }
  }
  if (scope.trackScope !== undefined) {
    if (!isRecord(scope.trackScope) || !Array.isArray(scope.trackScope.trackIds)) {
      return { valid: false, reason: "trackScope.trackIds 必须是字符串数组。" };
    }
    const trackIds = scope.trackScope.trackIds;
    if (
      trackIds.some((trackId) => typeof trackId !== "string" || !trackId.trim()) ||
      new Set(trackIds).size !== trackIds.length
    ) {
      return {
        valid: false,
        reason: "trackIds 必须由不重复的非空字符串组成。",
      };
    }
  }
  return { valid: true };
}

export function isProjectScopeAuthorized(
  allowedTrackIds: string[],
  allowedTimeRange: TimeRangeScope | null | undefined,
  trackIds: string[],
  timeRange: TimeRange | undefined,
) {
  // 无法映射到具体轨道/时间的结构性 mutation，只允许完全不受限的成员执行。
  if (trackIds.length === 0 && allowedTrackIds.length > 0) {
    return false;
  }
  const tracksAllowed = trackIds.every((trackId) =>
    allowedTrackIds.length === 0 ||
    allowedTrackIds.some((allowedTrackId) =>
      doesGrantedTrackCover(allowedTrackId, trackId),
    ),
  );
  if (!tracksAllowed) {
    return false;
  }
  if (!allowedTimeRange) {
    return true;
  }
  return Boolean(timeRange && containsTimeRange(allowedTimeRange, timeRange));
}

export function isMutationScopeAuthorized(
  permission: EffectiveWorkspacePermission,
  trackIds: string[],
  timeRange: TimeRange | undefined,
  requiresManage: boolean,
) {
  if (requiresManage) {
    return permission.canManage &&
      isProjectScopeAuthorized(
        permission.trackIds,
        permission.timeRange,
        trackIds,
        timeRange,
      );
  }
  return permission.canEdit &&
    isProjectScopeAuthorized(
      permission.trackIds,
      permission.timeRange,
      trackIds,
      timeRange,
    );
}

export function authorizeProjectMutations(
  mutations: ProjectMutation[],
  permission: EffectiveWorkspacePermission,
) {
  const violations: MutationScopeViolation[] = [];
  for (const mutation of mutations) {
    if (
      !isMutationScopeAuthorized(
        permission,
        mutation.trackIds,
        mutation.timeRange,
        mutation.requiresManage,
      )
    ) {
      violations.push({
        kind: mutation.kind,
        trackIds: mutation.trackIds,
        timeRange: mutation.timeRange,
      });
    }
  }
  return {
    allowed: violations.length === 0,
    violations,
    totalViolationCount: violations.length,
  };
}

export function collectProjectMutations(
  beforePayload: unknown,
  afterPayload: unknown,
): ProjectMutation[] {
  if (!isRecord(beforePayload) || !isRecord(afterPayload)) {
    return [manageMutation("project.payload", [], "项目数据不是可分析的对象。")];
  }
  const mutations: ProjectMutation[] = [];
  const collector: MutationCollector = {
    add: (mutation) => mutations.push(mutation),
  };

  for (const key of new Set([
    ...Object.keys(beforePayload),
    ...Object.keys(afterPayload),
  ])) {
    if (
      !KNOWN_PROJECT_KEYS.has(key) &&
      !areValuesEqual(beforePayload[key], afterPayload[key])
    ) {
      collector.add(manageMutation(
        "unknown-field.change",
        [],
        `未知字段 ${key} 发生变化。`,
      ));
    }
  }

  if (!areValuesEqual(beforePayload.video, afterPayload.video)) {
    collector.add(manageMutation("video.structure", [], "媒体关联发生变化。"));
  }

  collectTimedEntities(
    "line",
    "character-track",
    beforePayload.subtitleLines,
    afterPayload.subtitleLines,
    collector,
  );
  collectTimedEntities(
    "character",
    "character-track",
    beforePayload.characterAnnotations,
    afterPayload.characterAnnotations,
    collector,
  );
  collectDynamicTrackEntities(
    "action",
    beforePayload.actionAnnotations,
    afterPayload.actionAnnotations,
    (item) => getString(item.trackId),
    collector,
  );
  collectDynamicTrackEntities(
    "gongche-block",
    beforePayload.gongcheAnnotations,
    afterPayload.gongcheAnnotations,
    (item) => getString(item.parentTrackId),
    collector,
    getGongcheRange,
  );
  collectTimedEntities(
    "banyan-section",
    "banyan",
    beforePayload.banyanSections,
    afterPayload.banyanSections,
    collector,
  );
  collectPointEntities(
    "banyan-mark",
    "banyan",
    beforePayload.banyanMarks,
    afterPayload.banyanMarks,
    collector,
  );

  collectBuiltinTracks(
    beforePayload.builtinTracks,
    afterPayload.builtinTracks,
    collector,
  );
  collectCustomTracks(
    beforePayload.customTracks,
    afterPayload.customTracks,
    collector,
  );

  if (!areValuesEqual(beforePayload.activeTrackOrder, afterPayload.activeTrackOrder)) {
    collector.add(manageMutation(
      "active-track-order.structure",
      [],
      "轨道顺序发生变化。",
    ));
  }
  return mutations;
}

export function collectPersistedPermissionTrackIds(payload: unknown) {
  if (!isRecord(payload)) {
    return new Set<string>();
  }
  const trackIds = new Set<string>(["character-track", "banyan"]);
  for (const annotation of asRecords(payload.actionAnnotations)) {
    addString(trackIds, annotation.trackId);
  }
  for (const annotation of asRecords(payload.gongcheAnnotations)) {
    addString(trackIds, annotation.parentTrackId);
  }
  for (const track of [
    ...asRecords(payload.builtinTracks),
    ...asRecords(payload.customTracks),
  ]) {
    const parentTrackId = getString(track.id);
    if (!parentTrackId) {
      continue;
    }
    trackIds.add(parentTrackId);
    for (const pointTrack of asRecords(track.attachedPointTracks)) {
      const pointTrackId = getString(pointTrack.id);
      if (pointTrackId) {
        trackIds.add(getPointTrackScopeId(parentTrackId, pointTrackId));
      }
    }
    collectBranchTrackIds(track.branching, parentTrackId, trackIds);
  }
  return trackIds;
}

function collectBuiltinTracks(
  beforeValue: unknown,
  afterValue: unknown,
  collector: MutationCollector,
) {
  collectTrackContainers(
    "builtin-track",
    beforeValue,
    afterValue,
    BUILTIN_TRACK_CONTENT_KEYS,
    collector,
    false,
  );
}

function collectCustomTracks(
  beforeValue: unknown,
  afterValue: unknown,
  collector: MutationCollector,
) {
  collectTrackContainers(
    "custom-track",
    beforeValue,
    afterValue,
    CUSTOM_TRACK_CONTENT_KEYS,
    collector,
    true,
  );
}

function collectTrackContainers(
  kind: string,
  beforeValue: unknown,
  afterValue: unknown,
  contentKeys: Set<string>,
  collector: MutationCollector,
  collectBlocks: boolean,
) {
  const index = buildIdIndex(beforeValue, afterValue);
  if (!index.valid) {
    collector.add(manageMutation(`${kind}.malformed`, [], "轨道集合结构无效。"));
    return;
  }
  for (const id of index.removedIds) {
    collector.add(manageMutation(`${kind}.delete`, [id], `删除轨道 ${id}。`));
  }
  for (const id of index.addedIds) {
    collector.add(manageMutation(`${kind}.create`, [id], `新增轨道 ${id}。`));
  }
  for (const id of index.commonIds) {
    const beforeTrack = index.oldMap.get(id);
    const afterTrack = index.newMap.get(id);
    if (!beforeTrack || !afterTrack) {
      continue;
    }
    if (!areRecordsEqualWithoutKeys(beforeTrack, afterTrack, contentKeys)) {
      collector.add(manageMutation(
        `${kind}.structure`,
        [id],
        `轨道 ${id} 的配置发生变化。`,
      ));
    }
    if (collectBlocks) {
      collectCustomBlocks(
        id,
        beforeTrack.blocks,
        afterTrack.blocks,
        collectBranchLaneIds(beforeTrack.branching),
        collectBranchLaneIds(afterTrack.branching),
        collector,
      );
    }
    collectAttachedPointTracks(
      id,
      beforeTrack.attachedPointTracks,
      afterTrack.attachedPointTracks,
      collector,
    );
  }
}

function collectCustomBlocks(
  parentTrackId: string,
  beforeValue: unknown,
  afterValue: unknown,
  beforeLaneIds: Set<string>,
  afterLaneIds: Set<string>,
  collector: MutationCollector,
) {
  collectDynamicTrackEntities(
    "custom-block",
    beforeValue,
    afterValue,
    (item) => getBranchScopeTrackIds(parentTrackId, item),
    collector,
    getTimeRange,
    (beforeItem, afterItem) =>
      Boolean(
        (beforeItem &&
          hasInvalidBranchScope(beforeItem.branchScope, beforeLaneIds)) ||
        (afterItem &&
          hasInvalidBranchScope(afterItem.branchScope, afterLaneIds)) ||
        (beforeItem &&
          afterItem &&
          !areValuesEqual(beforeItem.branchScope, afterItem.branchScope)),
      ),
  );
}

function collectAttachedPointTracks(
  parentTrackId: string,
  beforeValue: unknown,
  afterValue: unknown,
  collector: MutationCollector,
) {
  const index = buildIdIndex(beforeValue, afterValue);
  if (!index.valid) {
    collector.add(manageMutation(
      "attached-point-track.malformed",
      [parentTrackId],
      "附属打点轨结构无效。",
    ));
    return;
  }
  for (const id of index.removedIds) {
    collector.add(manageMutation(
      "attached-point-track.delete",
      [getPointTrackScopeId(parentTrackId, id)],
      `删除附属打点轨 ${id}。`,
    ));
  }
  for (const id of index.addedIds) {
    collector.add(manageMutation(
      "attached-point-track.create",
      [getPointTrackScopeId(parentTrackId, id)],
      `新增附属打点轨 ${id}。`,
    ));
  }
  for (const id of index.commonIds) {
    const beforeTrack = index.oldMap.get(id);
    const afterTrack = index.newMap.get(id);
    if (!beforeTrack || !afterTrack) {
      continue;
    }
    if (!areRecordsEqualWithoutKeys(beforeTrack, afterTrack, new Set(["points"]))) {
      collector.add(manageMutation(
        "attached-point-track.structure",
        [getPointTrackScopeId(parentTrackId, id)],
        `附属打点轨 ${id} 的配置发生变化。`,
      ));
    }
    collectPointEntities(
      "attached-point",
      getPointTrackScopeId(parentTrackId, id),
      beforeTrack.points,
      afterTrack.points,
      collector,
    );
  }
}

function collectTimedEntities(
  kind: string,
  trackId: string,
  beforeValue: unknown,
  afterValue: unknown,
  collector: MutationCollector,
) {
  collectDynamicTrackEntities(
    kind,
    beforeValue,
    afterValue,
    () => trackId,
    collector,
  );
}

function collectPointEntities(
  kind: string,
  trackId: string,
  beforeValue: unknown,
  afterValue: unknown,
  collector: MutationCollector,
) {
  collectDynamicTrackEntities(
    kind,
    beforeValue,
    afterValue,
    () => trackId,
    collector,
    getPointRange,
  );
}

function collectDynamicTrackEntities(
  kind: string,
  beforeValue: unknown,
  afterValue: unknown,
  resolveTrackIds: (item: RecordValue) => string | string[] | undefined,
  collector: MutationCollector,
  resolveRange: (item: RecordValue | undefined) => TimeRange | undefined = getTimeRange,
  requiresManageUpdate: (
    beforeItem: RecordValue | undefined,
    afterItem: RecordValue | undefined,
  ) => boolean = () => false,
) {
  const index = buildIdIndex(beforeValue, afterValue);
  if (!index.valid) {
    collector.add(manageMutation(`${kind}.malformed`, [], `${kind} 集合结构无效。`));
    return;
  }
  const addEntityMutation = (
    id: string,
    action: ProjectMutation["action"],
    beforeItem: RecordValue | undefined,
    afterItem: RecordValue | undefined,
  ) => {
    const trackIds = normalizeTrackIds([
      ...toTrackIds(beforeItem ? resolveTrackIds(beforeItem) : undefined),
      ...toTrackIds(afterItem ? resolveTrackIds(afterItem) : undefined),
    ]);
    const beforeRange = resolveRange(beforeItem);
    const afterRange = resolveRange(afterItem);
    const range = unionRanges(beforeRange, afterRange);
    const isMove = Boolean(
      beforeRange &&
      afterRange &&
      (beforeRange.startTime !== afterRange.startTime ||
        beforeRange.endTime !== afterRange.endTime),
    );
    collector.add({
      kind: `${kind}.${action === "update" && isMove ? "move" : action}`,
      action: action === "update" && isMove ? "move" : action,
      trackIds,
      timeRange: range,
      requiresManage:
        trackIds.length === 0 ||
        !range ||
        requiresManageUpdate(beforeItem, afterItem),
      entityId: id,
    });
  };

  for (const id of index.removedIds) {
    addEntityMutation(id, "delete", index.oldMap.get(id), undefined);
  }
  for (const id of index.addedIds) {
    addEntityMutation(id, "create", undefined, index.newMap.get(id));
  }
  for (const id of index.commonIds) {
    const beforeItem = index.oldMap.get(id);
    const afterItem = index.newMap.get(id);
    if (!areValuesEqual(beforeItem, afterItem)) {
      addEntityMutation(id, "update", beforeItem, afterItem);
    }
  }
}

function getBranchScopeTrackIds(parentTrackId: string, item: RecordValue) {
  const branchScope = item.branchScope;
  if (
    !isRecord(branchScope) ||
    branchScope.mode !== "lanes" ||
    !Array.isArray(branchScope.laneIds) ||
    branchScope.laneIds.length === 0
  ) {
    return [parentTrackId];
  }
  const laneIds = branchScope.laneIds.filter(
    (laneId): laneId is string => typeof laneId === "string" && Boolean(laneId),
  );
  return laneIds.length
    ? laneIds.map((laneId) => getBranchTrackScopeId(parentTrackId, laneId))
    : [parentTrackId];
}

function getTimeRange(item: RecordValue | undefined) {
  if (!item) {
    return undefined;
  }
  return normalizeRange(item.startTime, item.endTime);
}

function getPointRange(item: RecordValue | undefined) {
  if (!item || !isFiniteNumber(item.time)) {
    return undefined;
  }
  return { startTime: item.time, endTime: item.time };
}

function getGongcheRange(item: RecordValue | undefined) {
  if (!item) {
    return undefined;
  }
  let range = getTimeRange(item);
  for (const symbol of asRecords(item.symbols)) {
    range = unionRanges(range, getTimeRange(symbol));
  }
  return range;
}

function buildIdIndex(beforeValue: unknown, afterValue: unknown) {
  const beforeItems = asRecords(beforeValue);
  const afterItems = asRecords(afterValue);
  const beforeMalformed =
    !Array.isArray(beforeValue) ||
    beforeItems.length !== beforeValue.length ||
    beforeItems.some((item) => !getString(item.id));
  const afterMalformed =
    !Array.isArray(afterValue) ||
    afterItems.length !== afterValue.length ||
    afterItems.some((item) => !getString(item.id));
  const oldMap = new Map(beforeItems.map((item) => [getString(item.id) ?? "", item]));
  const newMap = new Map(afterItems.map((item) => [getString(item.id) ?? "", item]));
  const valid =
    !beforeMalformed &&
    !afterMalformed &&
    oldMap.size === beforeItems.length &&
    newMap.size === afterItems.length;
  return {
    valid,
    oldMap,
    newMap,
    removedIds: [...oldMap.keys()].filter((id) => !newMap.has(id)),
    addedIds: [...newMap.keys()].filter((id) => !oldMap.has(id)),
    commonIds: [...oldMap.keys()].filter((id) => newMap.has(id)),
  };
}

function manageMutation(kind: string, trackIds: string[], summary: string): ProjectMutation {
  return {
    kind,
    action: "structure",
    trackIds,
    requiresManage: true,
    summary,
  };
}

function containsTimeRange(granted: TimeRangeScope, requested: TimeRangeScope) {
  return granted.startTime <= requested.startTime &&
    granted.endTime >= requested.endTime;
}

function doesGrantedTrackCover(grantedTrackId: string, requestedTrackId: string) {
  return requestedTrackId === grantedTrackId ||
    requestedTrackId.startsWith(`${grantedTrackId}#`);
}

function normalizeRange(startTime: unknown, endTime: unknown) {
  if (
    !isFiniteNumber(startTime) ||
    !isFiniteNumber(endTime) ||
    startTime < 0 ||
    endTime < startTime
  ) {
    return undefined;
  }
  return { startTime, endTime };
}

function unionRanges(
  left: TimeRange | undefined,
  right: TimeRange | undefined,
) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    startTime: Math.min(left.startTime, right.startTime),
    endTime: Math.max(left.endTime, right.endTime),
  };
}

function getBranchTrackScopeId(parentTrackId: string, laneId: string) {
  return `${parentTrackId}#branch:${laneId}`;
}

function getPointTrackScopeId(parentTrackId: string, pointTrackId: string) {
  return `${parentTrackId}#point:${pointTrackId}`;
}

function collectBranchTrackIds(
  branching: unknown,
  parentTrackId: string,
  output: Set<string>,
) {
  if (!isRecord(branching)) {
    return;
  }
  const roots = [
    ...asRecords(branching.lanes),
    ...asRecords(branching.branches),
    ...asRecords(branching.children),
  ];
  const visit = (lane: RecordValue) => {
    const laneId = getString(lane.id);
    if (laneId) {
      output.add(getBranchTrackScopeId(parentTrackId, laneId));
    }
    for (const child of [
      ...asRecords(lane.children),
      ...asRecords(lane.branches),
      ...asRecords(lane.lanes),
    ]) {
      visit(child);
    }
  };
  roots.forEach(visit);
}

function collectBranchLaneIds(branching: unknown) {
  const laneIds = new Set<string>();
  if (!isRecord(branching)) {
    return laneIds;
  }
  const visit = (lane: RecordValue) => {
    const laneId = getString(lane.id);
    if (laneId) {
      laneIds.add(laneId);
    }
    asRecords(lane.children).forEach(visit);
  };
  asRecords(branching.lanes).forEach(visit);
  return laneIds;
}

function hasInvalidBranchScope(
  branchScope: unknown,
  knownLaneIds: Set<string>,
) {
  if (branchScope === undefined) {
    return false;
  }
  if (!isRecord(branchScope)) {
    return true;
  }
  if (branchScope.mode === "root") {
    return Object.keys(branchScope).some((key) => key !== "mode");
  }
  if (
    branchScope.mode !== "lanes" ||
    !Array.isArray(branchScope.laneIds) ||
    branchScope.laneIds.length === 0
  ) {
    return true;
  }
  return branchScope.laneIds.some((laneId) =>
    typeof laneId !== "string" ||
    !knownLaneIds.has(laneId),
  );
}

function areRecordsEqualWithoutKeys(
  left: RecordValue,
  right: RecordValue,
  ignoredKeys: Set<string>,
) {
  return areValuesEqual(
    Object.fromEntries(Object.entries(left).filter(([key]) => !ignoredKeys.has(key))),
    Object.fromEntries(Object.entries(right).filter(([key]) => !ignoredKeys.has(key))),
  );
}

function areValuesEqual(left: unknown, right: unknown) {
  return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecords(value: unknown): RecordValue[] {
  return Array.isArray(value)
    ? value.filter(isRecord)
    : [];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function addString(output: Set<string>, value: unknown) {
  const normalized = getString(value);
  if (normalized) {
    output.add(normalized);
  }
}

function toTrackIds(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function normalizeTrackIds(trackIds: string[]) {
  return [...new Set(trackIds.filter(Boolean))];
}
