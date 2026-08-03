// 本模块定义前后端共享的首版标注领域命令；任何网络或 IndexedDB unknown 输入都必须从这里校验。
export const ANNOTATION_COMMAND_ENVELOPE_VERSION = 1 as const;
export const TIMELINE_TIMING_UPDATE_COMMAND = "timeline.items.timing.update" as const;
export const ANNOTATION_CONTENT_UPDATE_COMMAND = "annotation.items.content.update" as const;
// 所有持久化边界复用这一份领域 action 表；新增命令时不能让草稿/API 各维护一套名单。
export const ANNOTATION_DOMAIN_COMMAND_TYPES = [
  TIMELINE_TIMING_UPDATE_COMMAND,
  ANNOTATION_CONTENT_UPDATE_COMMAND,
] as const;
export const MAX_ANNOTATION_COMMAND_ITEMS = 500;
// 保留既有 timing 常量名作为公开合同别名，调用方无需因命令联合扩展而迁移。
export const MAX_TIMELINE_COMMAND_ITEMS = MAX_ANNOTATION_COMMAND_ITEMS;
export const MAX_ANNOTATION_CONTENT_LENGTH = 2_000;
export const TIMELINE_TIMING_COMPARISON_EPSILON = 0.0005;

// 首批协作目标覆盖已有时间轴可拖拽实体；后续新增类型必须同步扩 validator 与 apply 语义。
export const TIMELINE_ENTITY_TYPES = [
  "sentence",
  "character",
  "action",
  "custom-block",
  "attached-point",
  "gongche-block",
  "banyan-mark",
] as const;

export type TimelineEntityType = typeof TIMELINE_ENTITY_TYPES[number];

// 时间命令统一使用区间；点状实体由 validator 约束为 startTime === endTime。
export type TimelineTimingValue = {
  startTime: number;
  endTime: number;
};

export type TimelineTimingUpdateItem = {
  entityType: TimelineEntityType;
  entityId: string;
  trackId?: string;
  before: TimelineTimingValue;
  after: TimelineTimingValue;
};

export type TimelineItemsTimingUpdateCommand = {
  type: typeof TIMELINE_TIMING_UPDATE_COMMAND;
  items: TimelineTimingUpdateItem[];
};

// 内容字段按实体类型固定，避免客户端用任意 field 字符串改写未纳入协议的结构数据。
export type AnnotationContentUpdateItem =
  | ContentUpdateItem<"sentence", "text">
  | ContentUpdateItem<"character", "char">
  | ContentUpdateItem<"action", "label", string>
  | ContentUpdateItem<"custom-block", "text" | "type", string>
  | ContentUpdateItem<"attached-point", "label", string>;

type ContentUpdateItem<
  TEntity extends string,
  TField extends string,
  TTrackId extends string | undefined = undefined,
> = {
  entityType: TEntity;
  entityId: string;
  field: TField;
  before: string;
  after: string;
} & (TTrackId extends string ? { trackId: string } : { trackId?: never });

export type AnnotationItemsContentUpdateCommand = {
  type: typeof ANNOTATION_CONTENT_UPDATE_COMMAND;
  items: AnnotationContentUpdateItem[];
};

export type AnnotationDomainCommand =
  | TimelineItemsTimingUpdateCommand
  | AnnotationItemsContentUpdateCommand;

export type TimelineTimingCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: TimelineItemsTimingUpdateCommand;
};

export type AnnotationContentCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: AnnotationItemsContentUpdateCommand;
};

export type AnnotationCommandEnvelope =
  | TimelineTimingCommandEnvelope
  | AnnotationContentCommandEnvelope;

// 调用者提供的当前时间快照与命令目标使用同一稳定身份，不把 ProjectData 结构泄漏到 shared。
export type TimelineTimingActual = Pick<
  TimelineTimingUpdateItem,
  "entityType" | "entityId" | "trackId"
> & {
  current: TimelineTimingValue;
};

export type TimelineTimingPreconditionIssue =
  | {
      code: "target_missing";
      targetKey: string;
      expected: TimelineTimingValue;
    }
  | {
      code: "before_mismatch";
      targetKey: string;
      expected: TimelineTimingValue;
      actual: TimelineTimingValue;
    };

export type TimelineTimingExecutionAssessment =
  | { status: "invalid_command" }
  | {
      status: "blocked";
      envelope: TimelineTimingCommandEnvelope;
      issues: TimelineTimingPreconditionIssue[];
    }
  | {
      status: "ready";
      envelope: TimelineTimingCommandEnvelope;
    };

// 尚未迁移的 operation 仅保留这一组显式 action，不能继续接受任意字符串。
export const LEGACY_ANNOTATION_OPERATION_ACTIONS = [
  "project.commit",
  "project.undo",
  "project.redo",
  "track-snap.update",
] as const;

export type LegacyAnnotationOperationAction =
  typeof LEGACY_ANNOTATION_OPERATION_ACTIONS[number];

const TIMELINE_ENTITY_TYPE_SET = new Set<string>(TIMELINE_ENTITY_TYPES);
const LEGACY_OPERATION_ACTION_SET = new Set<string>(LEGACY_ANNOTATION_OPERATION_ACTIONS);
// 轨道内实体必须连同轨道 id 寻址；句、逐字和板眼在项目内使用全局稳定 id。
const TRACK_SCOPED_ENTITY_TYPES = new Set<TimelineEntityType>([
  "action",
  "custom-block",
  "attached-point",
  "gongche-block",
]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// builder 去掉 no-op、复制输入并按稳定目标排序；无有效变化时不伪造空命令。
export function buildTimelineTimingUpdateEnvelope(
  items: readonly TimelineTimingUpdateItem[],
): TimelineTimingCommandEnvelope | null {
  const changedItems = items
    .filter((item) => !areTimingValuesEqual(item.before, item.after))
    .map(cloneTimingItem)
    .sort((left, right) => compareStableKeys(
      getTimelineTimingTargetKey(left),
      getTimelineTimingTargetKey(right),
    ));
  if (changedItems.length === 0 || changedItems.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const envelope: TimelineTimingCommandEnvelope = {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: {
      type: TIMELINE_TIMING_UPDATE_COMMAND,
      items: changedItems,
    },
  };
  // 旧文件若含有新协议不能表达的 id，安全回退到 snapshot commit，不能让一次 pointer-up 崩溃。
  return parseTimelineTimingCommandEnvelope(envelope);
}

// timing unknown 输入保持原有严格合同；通用 parser 只负责按 type 分派，不放宽任何字段。
export function parseTimelineTimingCommandEnvelope(value: unknown): TimelineTimingCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) ||
    value.version !== ANNOTATION_COMMAND_ENVELOPE_VERSION ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== TIMELINE_TIMING_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) ||
    value.command.items.length === 0 ||
    value.command.items.length > MAX_ANNOTATION_COMMAND_ITEMS) {
    return null;
  }

  const items: TimelineTimingUpdateItem[] = [];
  const targetKeys = new Set<string>();
  for (const rawItem of value.command.items) {
    const item = parseTimelineTimingItem(rawItem);
    if (!item || areTimingValuesEqual(item.before, item.after)) return null;
    const targetKey = getTimelineTimingTargetKey(item);
    if (targetKeys.has(targetKey)) return null;
    targetKeys.add(targetKey);
    items.push(item);
  }
  return {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: {
      type: TIMELINE_TIMING_UPDATE_COMMAND,
      items,
    },
  };
}

// 内容 builder 去除 no-op、确定排序并返回独立字符串快照。
export function buildAnnotationContentUpdateEnvelope(
  items: readonly AnnotationContentUpdateItem[],
): AnnotationContentCommandEnvelope | null {
  const changedItems = items
    .filter((item) => item.before !== item.after)
    .map((item) => ({ ...item }))
    .sort((left, right) => compareStableKeys(
      getAnnotationContentTargetKey(left),
      getAnnotationContentTargetKey(right),
    ));
  if (changedItems.length === 0 || changedItems.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  return parseAnnotationContentCommandEnvelope({
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_CONTENT_UPDATE_COMMAND, items: changedItems },
  });
}

// 内容 parser 严格约束实体、字段、track scope、字符串长度和重复目标。
export function parseAnnotationContentCommandEnvelope(
  value: unknown,
): AnnotationContentCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) ||
    value.version !== ANNOTATION_COMMAND_ENVELOPE_VERSION ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== ANNOTATION_CONTENT_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) ||
    value.command.items.length === 0 ||
    value.command.items.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const items: AnnotationContentUpdateItem[] = [];
  const keys = new Set<string>();
  for (const rawItem of value.command.items) {
    const item = parseContentUpdateItem(rawItem);
    if (!item || item.before === item.after) return null;
    const key = getAnnotationContentTargetKey(item);
    if (keys.has(key)) return null;
    keys.add(key);
    items.push(item);
  }
  return {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_CONTENT_UPDATE_COMMAND, items },
  };
}

// 通用入口先读取判别字段，再交给单域 parser；未知命令不能落入某个宽松默认分支。
export function parseAnnotationCommandEnvelope(value: unknown): AnnotationCommandEnvelope | null {
  if (!isRecord(value) || !isRecord(value.command)) return null;
  if (value.command.type === TIMELINE_TIMING_UPDATE_COMMAND) {
    return parseTimelineTimingCommandEnvelope(value);
  }
  if (value.command.type === ANNOTATION_CONTENT_UPDATE_COMMAND) {
    return parseAnnotationContentCommandEnvelope(value);
  }
  return null;
}

// 反向命令只交换 before/after；仍经 builder 重新校验、复制和确定排序。
export function invertAnnotationCommandEnvelope(
  value: unknown,
): AnnotationCommandEnvelope | null {
  const envelope = parseAnnotationCommandEnvelope(value);
  if (!envelope) return null;
  return envelope.command.type === TIMELINE_TIMING_UPDATE_COMMAND
    ? buildTimelineTimingUpdateEnvelope(envelope.command.items.map((item) => ({
        ...item,
        before: item.after,
        after: item.before,
      })))
    : buildAnnotationContentUpdateEnvelope(envelope.command.items.map((item) => ({
        ...item,
        before: item.after,
        after: item.before,
      })));
}

// 执行前一次性检查全部目标；返回 ready 之前调用者不得修改项目，确保批量命令原子应用。
export function assessTimelineTimingExecution(
  value: unknown,
  actuals: readonly TimelineTimingActual[],
): TimelineTimingExecutionAssessment {
  const envelope = parseTimelineTimingCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actualByTarget = new Map<string, TimelineTimingValue>();
  const duplicateTargets = new Set<string>();
  for (const actual of actuals) {
    const key = getTimelineTimingTargetKey(actual);
    // 重复 actual 代表调用者自身寻址含糊，按缺失处理而不是随机采用最后一个值。
    if (actualByTarget.has(key) || duplicateTargets.has(key)) {
      actualByTarget.delete(key);
      duplicateTargets.add(key);
    } else {
      actualByTarget.set(key, { ...actual.current });
    }
  }
  const issues: TimelineTimingPreconditionIssue[] = [];
  for (const item of envelope.command.items) {
    const targetKey = getTimelineTimingTargetKey(item);
    const actual = actualByTarget.get(targetKey);
    if (!actual) {
      issues.push({ code: "target_missing", targetKey, expected: { ...item.before } });
      continue;
    }
    if (!areTimelineTimingValuesEqual(actual, item.before)) {
      issues.push({
        code: "before_mismatch",
        targetKey,
        expected: { ...item.before },
        actual: { ...actual },
      });
    }
  }
  return issues.length > 0
    ? { status: "blocked", envelope, issues }
    : { status: "ready", envelope };
}

export type AnnotationContentActual = AnnotationContentUpdateItem extends infer TItem
  ? TItem extends AnnotationContentUpdateItem
    ? Omit<TItem, "before" | "after"> & { current: string }
    : never
  : never;

export type AnnotationContentPreconditionIssue =
  | { code: "target_missing"; targetKey: string; expected: string }
  | { code: "before_mismatch"; targetKey: string; expected: string; actual: string };

// 内容命令同样先检查全部稳定目标；任一缺失或 before 不匹配都阻断整批应用。
export function assessAnnotationContentExecution(
  value: unknown,
  actuals: readonly AnnotationContentActual[],
):
  | { status: "invalid_command" }
  | { status: "blocked"; envelope: AnnotationContentCommandEnvelope; issues: AnnotationContentPreconditionIssue[] }
  | { status: "ready"; envelope: AnnotationContentCommandEnvelope } {
  const envelope = parseAnnotationContentCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actualByKey = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const actual of actuals) {
    const key = getAnnotationContentTargetKey(actual);
    if (actualByKey.has(key) || duplicates.has(key)) {
      actualByKey.delete(key);
      duplicates.add(key);
    } else actualByKey.set(key, actual.current);
  }
  const issues: AnnotationContentPreconditionIssue[] = [];
  for (const item of envelope.command.items) {
    const key = getAnnotationContentTargetKey(item);
    const actual = actualByKey.get(key);
    if (actual === undefined) issues.push({ code: "target_missing", targetKey: key, expected: item.before });
    else if (actual !== item.before) {
      issues.push({ code: "before_mismatch", targetKey: key, expected: item.before, actual });
    }
  }
  return issues.length > 0
    ? { status: "blocked", envelope, issues }
    : { status: "ready", envelope };
}

// API 只接受显式 legacy action 或 action/envelope 一致的已知领域命令。
export function isValidAnnotationOperationPayload(action: unknown, payload: unknown): boolean {
  if (typeof action !== "string") return false;
  // legacy payload 可保留既有摘要，但不得夹带 command envelope 规避 action/type 一致性校验。
  if (LEGACY_OPERATION_ACTION_SET.has(action)) return !looksLikeCommandEnvelope(payload);
  const envelope = parseAnnotationCommandEnvelope(payload);
  return envelope?.command.type === action;
}

// 稳定 target key 同时用于去重、确定性排序和未来服务端实体锁定。
export function getTimelineTimingTargetKey(
  item: Pick<TimelineTimingUpdateItem, "entityType" | "entityId" | "trackId">,
) {
  return `${item.entityType}:${item.trackId ?? ""}:${item.entityId}`;
}

// 内容目标 key 包含字段，允许同一实体在未来一次命令中更新多个彼此独立的内容字段。
export function getAnnotationContentTargetKey(
  item: Pick<AnnotationContentUpdateItem, "entityType" | "entityId" | "field" | "trackId">,
) {
  return `${item.entityType}:${item.trackId ?? ""}:${item.entityId}:${item.field}`;
}

// 逐项解析按 entity/field 配对决定 trackId 是否必需，禁止借内容命令改任意字段。
function parseContentUpdateItem(value: unknown): AnnotationContentUpdateItem | null {
  if (!isRecord(value)) return null;
  const hasTrack = value.trackId !== undefined;
  const keys = hasTrack
    ? ["entityType", "entityId", "trackId", "field", "before", "after"]
    : ["entityType", "entityId", "field", "before", "after"];
  if (!isExactRecord(value, keys) ||
    !isSafeId(value.entityId) ||
    typeof value.before !== "string" ||
    typeof value.after !== "string" ||
    value.before.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    value.after.length > MAX_ANNOTATION_CONTENT_LENGTH) return null;
  const globalValid =
    (value.entityType === "sentence" && value.field === "text") ||
    (value.entityType === "character" && value.field === "char");
  const scopedValid =
    (value.entityType === "action" && value.field === "label") ||
    (value.entityType === "custom-block" && (value.field === "text" || value.field === "type")) ||
    (value.entityType === "attached-point" && value.field === "label");
  if (globalValid && !hasTrack) return { ...value } as AnnotationContentUpdateItem;
  if (scopedValid && hasTrack && isSafeId(value.trackId)) return { ...value } as AnnotationContentUpdateItem;
  return null;
}

// 单项解析同时执行 track scope 与时间范围约束，点状实体必须使用零长度区间。
function parseTimelineTimingItem(value: unknown): TimelineTimingUpdateItem | null {
  if (!isRecord(value)) return null;
  const allowedKeys = value.trackId === undefined
    ? ["entityType", "entityId", "before", "after"]
    : ["entityType", "entityId", "trackId", "before", "after"];
  if (!hasExactKeys(value, allowedKeys) ||
    typeof value.entityType !== "string" ||
    !TIMELINE_ENTITY_TYPE_SET.has(value.entityType) ||
    !isSafeId(value.entityId) ||
    (value.trackId !== undefined && !isSafeId(value.trackId))) {
    return null;
  }
  const entityType = value.entityType as TimelineEntityType;
  if (TRACK_SCOPED_ENTITY_TYPES.has(entityType) && !isSafeId(value.trackId)) return null;
  const before = parseTimingValue(value.before);
  const after = parseTimingValue(value.after);
  if (!before || !after) return null;
  if (isPointEntity(entityType) &&
    (before.startTime !== before.endTime || after.startTime !== after.endTime)) return null;
  return {
    entityType,
    entityId: value.entityId,
    ...(value.trackId === undefined ? {} : { trackId: value.trackId }),
    before,
    after,
  };
}

// 时间值仅接受有限非负数和正向区间，拒绝 NaN、Infinity 与倒置范围。
function parseTimingValue(value: unknown): TimelineTimingValue | null {
  if (!isExactRecord(value, ["startTime", "endTime"]) ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) ||
    value.endTime < value.startTime) return null;
  return { startTime: value.startTime, endTime: value.endTime };
}

// 点状目标没有持续时间，统一以 start=end 编码而不是引入第二套命令结构。
function isPointEntity(entityType: TimelineEntityType) {
  return entityType === "attached-point" || entityType === "banyan-mark";
}

// 克隆防止 builder 返回值与调用者后续修改共享对象引用。
function cloneTimingItem(item: TimelineTimingUpdateItem): TimelineTimingUpdateItem {
  return {
    entityType: item.entityType,
    entityId: item.entityId,
    ...(item.trackId === undefined ? {} : { trackId: item.trackId }),
    before: { ...item.before },
    after: { ...item.after },
  };
}

function areTimingValuesEqual(left: TimelineTimingValue, right: TimelineTimingValue) {
  return left.startTime === right.startTime && left.endTime === right.endTime;
}

// 前置条件允许半毫秒浮点误差，但命令 builder 的 no-op 判断仍保持精确，避免吞掉真实微调。
export function areTimelineTimingValuesEqual(
  left: TimelineTimingValue,
  right: TimelineTimingValue,
) {
  return Math.abs(left.startTime - right.startTime) <= TIMELINE_TIMING_COMPARISON_EPSILON &&
    Math.abs(left.endTime - right.endTime) <= TIMELINE_TIMING_COMPARISON_EPSILON;
}

// 协作命令排序不能依赖浏览器语言环境；简单代码点顺序在各端产生相同结果。
function compareStableKeys(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function looksLikeCommandEnvelope(value: unknown) {
  return isRecord(value) && ("version" in value || "command" in value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}
