// 本模块定义前后端共享的首版标注领域命令；任何网络或 IndexedDB unknown 输入都必须从这里校验。
export const ANNOTATION_COMMAND_ENVELOPE_VERSION = 1 as const;
export const TIMELINE_TIMING_UPDATE_COMMAND = "timeline.items.timing.update" as const;
export const ANNOTATION_CONTENT_UPDATE_COMMAND = "annotation.items.content.update" as const;
export const ANNOTATION_LIFECYCLE_UPDATE_COMMAND = "annotation.items.lifecycle.update" as const;
export const ANNOTATION_STATE_UPDATE_COMMAND = "annotation.items.state.update" as const;
export const ANNOTATION_TRANSACTION_APPLY_COMMAND = "annotation.transaction.apply" as const;
// 所有持久化边界复用这一份领域 action 表；新增命令时不能让草稿/API 各维护一套名单。
export const ANNOTATION_DOMAIN_COMMAND_TYPES = [
  TIMELINE_TIMING_UPDATE_COMMAND,
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_LIFECYCLE_UPDATE_COMMAND,
  ANNOTATION_STATE_UPDATE_COMMAND,
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
] as const;
export const MAX_ANNOTATION_COMMAND_ITEMS = 500;
export const MAX_ANNOTATION_TRANSACTION_COMMANDS = 20;
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

// 生命周期位置同时保留索引、集合长度和相邻稳定 id；inverse 因此能恢复原顺序，而不只恢复实体内容。
export type AnnotationLifecyclePosition = {
  index: number;
  collectionLength: number;
  previousEntityId: string | null;
  nextEntityId: string | null;
};

export type AnnotationLifecycleBranchScope =
  | { mode: "root" }
  | { mode: "lanes"; laneIds: string[] };

// 可选字段统一编码为 null，避免“字段缺失”和“字段为空”在不同客户端产生两种命令摘要。
export type CustomBlockLifecycleSnapshot = {
  id: string;
  startTime: number;
  endTime: number;
  text: string | null;
  type: string;
  branchScope: AnnotationLifecycleBranchScope | null;
  branchGroupId: string | null;
  branchParentBlockId: string | null;
};

export type AttachedPointLifecycleSnapshot = {
  id: string;
  time: number;
  label: string;
};

export type SentenceLifecycleSnapshot = {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
};

export type CharacterToneLifecycleSnapshot = {
  toneClass: "yin_ping" | "yang_ping" | "yin_shang" | "yang_shang" | "yin_qu" | "yang_qu" | "yin_ru" | "yang_ru";
  yxlzShangSubtype: "yin_shang" | "yang_shang" | "yinyang_tongyong" | null;
};

export type CharacterLifecycleSnapshot = {
  id: string;
  lineId: string;
  char: string;
  startTime: number;
  endTime: number;
  singingStyle: string;
  tone: CharacterToneLifecycleSnapshot | null;
};

export type GongcheSymbolLifecycleSnapshot = {
  id: string;
  label: string;
  notation: string | null;
  rawText: string | null;
  parenthesized: boolean;
  startTime: number;
  endTime: number;
  assetUrl: string | null;
};

export type GongcheBlockLifecycleSnapshot = {
  id: string;
  parentTrackId: string;
  parentBlockId: string;
  startTime: number;
  endTime: number;
  symbols: GongcheSymbolLifecycleSnapshot[];
};

export type BanyanSectionStateSnapshot = {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  cycleType: "sanban" | "liushuiban" | "yi_ban_yi_yan" | "yi_ban_yi_yan_zeng" |
    "yi_ban_san_yan" | "yi_ban_san_yan_zeng" | "custom";
  freeRhythm: boolean;
  beatCount: number | null;
  hasZengBan: boolean | null;
  source: string | null;
  comment: string | null;
};

export type BanyanMarkStateSnapshot = {
  id: string;
  sectionId: string | null;
  time: number;
  estimatedTime: number;
  sourceSymbol: string;
  sourceTokenIndex: number | null;
  sourceKey: string | null;
  role: "ban" | "yan" | "auxiliary";
  subtype: "mainBan" | "headBan" | "waistBan" | "bottomBan" | "zengBan" | "waistZengBan" |
    "middleEye" | "smallEye" | "sideHeadTailEye" | "sideMiddleEye" | "phraseBoundary" | "unknown";
  segment: "main" | "zeng" | "free" | "unknown";
  beatIndex: number | null;
  cycleIndex: number | null;
  strength: "strong" | "medium" | "weak" | "unknown" | null;
  attachment: "on_note" | "in_between" | "at_phrase_end" | "unknown";
  linkedGongcheAnnotationId: string | null;
  linkedGongcheSymbolId: string | null;
  linkedGongcheSymbolIds: string[] | null;
  confidence: "auto" | "reviewed" | "manual";
  manualOffset: number | null;
  durationHint: string | null;
  orphaned: boolean;
  comment: string | null;
};

export type AnnotationLifecycleState<TEntity> = {
  entity: TEntity;
  position: AnnotationLifecyclePosition;
};

export type AnnotationLifecycleUpdateItem =
  | GlobalLifecycleUpdateItem<"sentence", SentenceLifecycleSnapshot>
  | GlobalLifecycleUpdateItem<"character", CharacterLifecycleSnapshot>
  | GlobalLifecycleUpdateItem<"banyan-section", BanyanSectionStateSnapshot>
  | GlobalLifecycleUpdateItem<"banyan-mark", BanyanMarkStateSnapshot>
  | LifecycleUpdateItem<"custom-block", CustomBlockLifecycleSnapshot>
  | LifecycleUpdateItem<"attached-point", AttachedPointLifecycleSnapshot>
  | LifecycleUpdateItem<"gongche-block", GongcheBlockLifecycleSnapshot>
  | LifecycleUpdateItem<"gongche-symbol", GongcheSymbolLifecycleSnapshot>;

type GlobalLifecycleUpdateItem<TEntityType extends string, TSnapshot> = {
  entityType: TEntityType;
  entityId: string;
  trackId?: never;
  before: AnnotationLifecycleState<TSnapshot> | null;
  after: AnnotationLifecycleState<TSnapshot> | null;
};

type LifecycleUpdateItem<TEntityType extends string, TSnapshot> = {
  entityType: TEntityType;
  entityId: string;
  trackId: string;
  before: AnnotationLifecycleState<TSnapshot> | null;
  after: AnnotationLifecycleState<TSnapshot> | null;
};

export type AnnotationItemsLifecycleUpdateCommand = {
  type: typeof ANNOTATION_LIFECYCLE_UPDATE_COMMAND;
  items: AnnotationLifecycleUpdateItem[];
};

// 复合实体状态命令替换同一稳定实体的完整快照，不承担创建、删除或跨父集合移动。
export type AnnotationStateUpdateItem =
  | GlobalStateUpdateItem<"banyan-section", BanyanSectionStateSnapshot>
  | GlobalStateUpdateItem<"banyan-mark", BanyanMarkStateSnapshot>
  | ScopedStateUpdateItem<"gongche-symbol", GongcheSymbolLifecycleSnapshot>;

type GlobalStateUpdateItem<TEntityType extends string, TSnapshot> = {
  entityType: TEntityType;
  entityId: string;
  trackId?: never;
  before: TSnapshot;
  after: TSnapshot;
};

type ScopedStateUpdateItem<TEntityType extends string, TSnapshot> = {
  entityType: TEntityType;
  entityId: string;
  trackId: string;
  before: TSnapshot;
  after: TSnapshot;
};

export type AnnotationItemsStateUpdateCommand = {
  type: typeof ANNOTATION_STATE_UPDATE_COMMAND;
  items: AnnotationStateUpdateItem[];
};

export type AnnotationTransactionChildCommand =
  | TimelineItemsTimingUpdateCommand
  | AnnotationItemsContentUpdateCommand
  | AnnotationItemsLifecycleUpdateCommand
  | AnnotationItemsStateUpdateCommand;

export type AnnotationTransactionApplyCommand = {
  type: typeof ANNOTATION_TRANSACTION_APPLY_COMMAND;
  commands: AnnotationTransactionChildCommand[];
};

export type AnnotationDomainCommand =
  | TimelineItemsTimingUpdateCommand
  | AnnotationItemsContentUpdateCommand
  | AnnotationItemsLifecycleUpdateCommand
  | AnnotationItemsStateUpdateCommand
  | AnnotationTransactionApplyCommand;

export type TimelineTimingCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: TimelineItemsTimingUpdateCommand;
};

export type AnnotationContentCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: AnnotationItemsContentUpdateCommand;
};

export type AnnotationLifecycleCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: AnnotationItemsLifecycleUpdateCommand;
};

export type AnnotationStateCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: AnnotationItemsStateUpdateCommand;
};

export type AnnotationTransactionCommandEnvelope = {
  version: typeof ANNOTATION_COMMAND_ENVELOPE_VERSION;
  command: AnnotationTransactionApplyCommand;
};

export type AnnotationCommandEnvelope =
  | TimelineTimingCommandEnvelope
  | AnnotationContentCommandEnvelope
  | AnnotationLifecycleCommandEnvelope
  | AnnotationStateCommandEnvelope
  | AnnotationTransactionCommandEnvelope;

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

// 生命周期 builder 只复制并稳定排序；实体快照、位置和批量集合不变量全部交回严格 parser 复核。
export function buildAnnotationLifecycleUpdateEnvelope(
  items: readonly AnnotationLifecycleUpdateItem[],
): AnnotationLifecycleCommandEnvelope | null {
  if (items.length === 0 || items.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const copiedItems = items
    .map(cloneLifecycleItem)
    .sort((left, right) => compareStableKeys(
      getAnnotationLifecycleTargetKey(left),
      getAnnotationLifecycleTargetKey(right),
    ));
  return parseAnnotationLifecycleCommandEnvelope({
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_LIFECYCLE_UPDATE_COMMAND, items: copiedItems },
  });
}

// 生命周期 unknown 输入拒绝宽松 CRUD：每项必须恰好表示一次创建或删除，并通过整组集合事实校验。
export function parseAnnotationLifecycleCommandEnvelope(
  value: unknown,
): AnnotationLifecycleCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) ||
    value.version !== ANNOTATION_COMMAND_ENVELOPE_VERSION ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== ANNOTATION_LIFECYCLE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) ||
    value.command.items.length === 0 ||
    value.command.items.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;

  const items: AnnotationLifecycleUpdateItem[] = [];
  const targets = new Set<string>();
  for (const rawItem of value.command.items) {
    const item = parseLifecycleItem(rawItem);
    if (!item) return null;
    const key = getAnnotationLifecycleTargetKey(item);
    if (targets.has(key)) return null;
    targets.add(key);
    items.push(item);
  }
  if (getAnnotationChildCommandItemCost({ type: ANNOTATION_LIFECYCLE_UPDATE_COMMAND, items }) >
    MAX_ANNOTATION_COMMAND_ITEMS) return null;
  if (!validateLifecycleCollectionFacts(items)) return null;
  return {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_LIFECYCLE_UPDATE_COMMAND, items },
  };
}

// 完整状态 builder 复制并稳定排序；before/after 的严格快照合同统一交回 unknown parser 复核。
export function buildAnnotationStateUpdateEnvelope(
  items: readonly AnnotationStateUpdateItem[],
): AnnotationStateCommandEnvelope | null {
  const changedItems = items
    .filter((item) => !areLifecycleValuesEqual(item.before, item.after))
    .map(cloneStateItem)
    .sort((left, right) => compareStableKeys(
      getAnnotationStateTargetKey(left),
      getAnnotationStateTargetKey(right),
    ));
  if (changedItems.length === 0 || changedItems.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  return parseAnnotationStateCommandEnvelope({
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_STATE_UPDATE_COMMAND, items: changedItems },
  });
}

// state 只能更新仍存在于同一父集合的实体；完整快照 id 必须与命令目标一致。
export function parseAnnotationStateCommandEnvelope(value: unknown): AnnotationStateCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) ||
    value.version !== ANNOTATION_COMMAND_ENVELOPE_VERSION ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== ANNOTATION_STATE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) ||
    value.command.items.length === 0 ||
    value.command.items.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const items: AnnotationStateUpdateItem[] = [];
  const keys = new Set<string>();
  for (const rawItem of value.command.items) {
    const item = parseStateItem(rawItem);
    if (!item || areLifecycleValuesEqual(item.before, item.after)) return null;
    const key = getAnnotationStateTargetKey(item);
    if (keys.has(key)) return null;
    keys.add(key);
    items.push(item);
  }
  if (items.reduce((total, item) => total + getAnnotationStateItemCost(item), 0) >
    MAX_ANNOTATION_COMMAND_ITEMS) return null;
  return {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_STATE_UPDATE_COMMAND, items },
  };
}

// 原子事务只组合已经通过严格单域 parser 的叶命令；禁止递归事务，避免产生两套嵌套语义。
export function buildAnnotationTransactionEnvelope(
  envelopes: readonly (
    | TimelineTimingCommandEnvelope
    | AnnotationContentCommandEnvelope
    | AnnotationLifecycleCommandEnvelope
    | AnnotationStateCommandEnvelope
  )[],
): AnnotationTransactionCommandEnvelope | null {
  if (envelopes.length === 0 || envelopes.length > MAX_ANNOTATION_TRANSACTION_COMMANDS) return null;
  return parseAnnotationTransactionCommandEnvelope({
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: {
      type: ANNOTATION_TRANSACTION_APPLY_COMMAND,
      commands: envelopes.map((envelope) => structuredClone(envelope.command)),
    },
  });
}

// transaction 的 unknown 输入逐项回送现有 parser，并额外限制总实体数，防止小命令绕过批量上限。
export function parseAnnotationTransactionCommandEnvelope(
  value: unknown,
): AnnotationTransactionCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) ||
    value.version !== ANNOTATION_COMMAND_ENVELOPE_VERSION ||
    !isExactRecord(value.command, ["type", "commands"]) ||
    value.command.type !== ANNOTATION_TRANSACTION_APPLY_COMMAND ||
    !Array.isArray(value.command.commands) ||
    value.command.commands.length === 0 ||
    value.command.commands.length > MAX_ANNOTATION_TRANSACTION_COMMANDS) return null;

  const commands: AnnotationTransactionChildCommand[] = [];
  let totalItems = 0;
  for (const rawCommand of value.command.commands) {
    if (!isRecord(rawCommand)) return null;
    const childEnvelope = parseLeafAnnotationCommandEnvelope({
      version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
      command: rawCommand,
    });
    if (!childEnvelope) return null;
    totalItems += getAnnotationChildCommandItemCost(childEnvelope.command);
    if (totalItems > MAX_ANNOTATION_COMMAND_ITEMS) return null;
    commands.push(structuredClone(childEnvelope.command));
  }
  return {
    version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
    command: { type: ANNOTATION_TRANSACTION_APPLY_COMMAND, commands },
  };
}

// 工尺块内的符号也是持久化实体；把它们计入总预算，避免少量外层 item 携带超大嵌套负载。
function getAnnotationChildCommandItemCost(command: AnnotationTransactionChildCommand) {
  if (command.type === ANNOTATION_STATE_UPDATE_COMMAND) {
    return command.items.reduce((total, item) => total + getAnnotationStateItemCost(item), 0);
  }
  if (command.type !== ANNOTATION_LIFECYCLE_UPDATE_COMMAND) return command.items.length;
  return command.items.reduce((total, item) => {
    if (item.entityType === "banyan-mark") {
      const state = item.before ?? item.after;
      return total + 1 + (state?.entity.linkedGongcheSymbolIds?.length ?? 0);
    }
    if (item.entityType !== "gongche-block") return total + 1;
    const state = item.before ?? item.after;
    return total + 1 + (state?.entity.symbols.length ?? 0);
  }, 0);
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
  if (value.command.type === ANNOTATION_LIFECYCLE_UPDATE_COMMAND) {
    return parseAnnotationLifecycleCommandEnvelope(value);
  }
  if (value.command.type === ANNOTATION_STATE_UPDATE_COMMAND) {
    return parseAnnotationStateCommandEnvelope(value);
  }
  if (value.command.type === ANNOTATION_TRANSACTION_APPLY_COMMAND) {
    return parseAnnotationTransactionCommandEnvelope(value);
  }
  return null;
}

// 事务 parser 使用不含 transaction 的私有入口，从结构上阻断递归事务。
function parseLeafAnnotationCommandEnvelope(value: unknown):
  | TimelineTimingCommandEnvelope
  | AnnotationContentCommandEnvelope
  | AnnotationLifecycleCommandEnvelope
  | AnnotationStateCommandEnvelope
  | null {
  if (!isRecord(value) || !isRecord(value.command)) return null;
  if (value.command.type === TIMELINE_TIMING_UPDATE_COMMAND) return parseTimelineTimingCommandEnvelope(value);
  if (value.command.type === ANNOTATION_CONTENT_UPDATE_COMMAND) return parseAnnotationContentCommandEnvelope(value);
  if (value.command.type === ANNOTATION_LIFECYCLE_UPDATE_COMMAND) return parseAnnotationLifecycleCommandEnvelope(value);
  if (value.command.type === ANNOTATION_STATE_UPDATE_COMMAND) return parseAnnotationStateCommandEnvelope(value);
  return null;
}

// 反向命令只交换 before/after；仍经 builder 重新校验、复制和确定排序。
export function invertAnnotationCommandEnvelope(
  value: unknown,
): AnnotationCommandEnvelope | null {
  const envelope = parseAnnotationCommandEnvelope(value);
  if (!envelope) return null;
  if (envelope.command.type === TIMELINE_TIMING_UPDATE_COMMAND) {
    return buildTimelineTimingUpdateEnvelope(envelope.command.items.map((item) => ({
      ...item,
      before: item.after,
      after: item.before,
    })));
  }
  if (envelope.command.type === ANNOTATION_CONTENT_UPDATE_COMMAND) {
    return buildAnnotationContentUpdateEnvelope(envelope.command.items.map((item) => ({
        ...item,
        before: item.after,
        after: item.before,
    })));
  }
  if (envelope.command.type === ANNOTATION_LIFECYCLE_UPDATE_COMMAND) {
    return buildAnnotationLifecycleUpdateEnvelope(envelope.command.items.map(invertLifecycleItem));
  }
  if (envelope.command.type === ANNOTATION_STATE_UPDATE_COMMAND) {
    return buildAnnotationStateUpdateEnvelope(envelope.command.items.map(invertStateItem));
  }
  const inverseChildren = [...envelope.command.commands]
    .reverse()
    .map((command) => invertAnnotationCommandEnvelope({
      version: ANNOTATION_COMMAND_ENVELOPE_VERSION,
      command,
    }));
  if (inverseChildren.some((child) => !child || child.command.type === ANNOTATION_TRANSACTION_APPLY_COMMAND)) return null;
  return buildAnnotationTransactionEnvelope(inverseChildren as Array<
    TimelineTimingCommandEnvelope | AnnotationContentCommandEnvelope | AnnotationLifecycleCommandEnvelope |
    AnnotationStateCommandEnvelope
  >);
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

export type AnnotationLifecycleActual = Pick<
  AnnotationLifecycleUpdateItem,
  "entityType" | "entityId" | "trackId"
> & {
  parentExists: boolean;
  current: AnnotationLifecycleUpdateItem["before"];
};

export type AnnotationLifecyclePreconditionIssue =
  | { code: "parent_missing"; targetKey: string }
  | { code: "target_presence_mismatch"; targetKey: string }
  | { code: "state_mismatch"; targetKey: string };

// 生命周期前置检查同时验证父容器、存在性、完整实体和集合位置，全部 ready 前不得重建任何集合。
export function assessAnnotationLifecycleExecution(
  value: unknown,
  actuals: readonly AnnotationLifecycleActual[],
):
  | { status: "invalid_command" }
  | { status: "blocked"; envelope: AnnotationLifecycleCommandEnvelope; issues: AnnotationLifecyclePreconditionIssue[] }
  | { status: "ready"; envelope: AnnotationLifecycleCommandEnvelope } {
  const envelope = parseAnnotationLifecycleCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actualByKey = new Map<string, AnnotationLifecycleActual>();
  const duplicates = new Set<string>();
  for (const actual of actuals) {
    const key = getAnnotationLifecycleTargetKey(actual);
    if (actualByKey.has(key) || duplicates.has(key)) {
      actualByKey.delete(key);
      duplicates.add(key);
    } else {
      actualByKey.set(key, actual);
    }
  }

  const issues: AnnotationLifecyclePreconditionIssue[] = [];
  for (const item of envelope.command.items) {
    const targetKey = getAnnotationLifecycleTargetKey(item);
    const actual = actualByKey.get(targetKey);
    if (!actual?.parentExists) {
      issues.push({ code: "parent_missing", targetKey });
      continue;
    }
    const expected = item.before;
    if ((actual.current === null) !== (expected === null)) {
      issues.push({ code: "target_presence_mismatch", targetKey });
      continue;
    }
    if (!areLifecycleValuesEqual(actual.current, expected)) {
      issues.push({ code: "state_mismatch", targetKey });
    }
  }
  return issues.length > 0
    ? { status: "blocked", envelope, issues }
    : { status: "ready", envelope };
}

export type AnnotationStateActual = AnnotationStateUpdateItem extends infer TItem
  ? TItem extends AnnotationStateUpdateItem
    ? Omit<TItem, "before" | "after"> & { current: TItem["before"] }
    : never
  : never;

export type AnnotationStatePreconditionIssue =
  | { code: "target_missing"; targetKey: string }
  | { code: "before_mismatch"; targetKey: string }
  | { code: "result_invalid"; targetKey: string };

// 复合状态命令先核对全部完整 before；调用者只能在 ready 后统一替换实体快照。
export function assessAnnotationStateExecution(
  value: unknown,
  actuals: readonly AnnotationStateActual[],
):
  | { status: "invalid_command" }
  | { status: "blocked"; envelope: AnnotationStateCommandEnvelope; issues: AnnotationStatePreconditionIssue[] }
  | { status: "ready"; envelope: AnnotationStateCommandEnvelope } {
  const envelope = parseAnnotationStateCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actualByKey = new Map<string, AnnotationStateActual>();
  const duplicates = new Set<string>();
  for (const actual of actuals) {
    const key = getAnnotationStateTargetKey(actual);
    if (actualByKey.has(key) || duplicates.has(key)) {
      actualByKey.delete(key);
      duplicates.add(key);
    } else actualByKey.set(key, actual);
  }
  const issues: AnnotationStatePreconditionIssue[] = [];
  for (const item of envelope.command.items) {
    const key = getAnnotationStateTargetKey(item);
    const actual = actualByKey.get(key);
    if (!actual) issues.push({ code: "target_missing", targetKey: key });
    else if (!areLifecycleValuesEqual(actual.current, item.before)) {
      issues.push({ code: "before_mismatch", targetKey: key });
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
  return buildStableTupleKey(item.entityType, item.trackId ?? null, item.entityId);
}

// 内容目标 key 包含字段，允许同一实体在未来一次命令中更新多个彼此独立的内容字段。
export function getAnnotationContentTargetKey(
  item: Pick<AnnotationContentUpdateItem, "entityType" | "entityId" | "field" | "trackId">,
) {
  return buildStableTupleKey(item.entityType, item.trackId ?? null, item.entityId, item.field);
}

// 生命周期目标只由实体类型、父集合和稳定 id 定位；状态与位置不参与身份。
export function getAnnotationLifecycleTargetKey(
  item: Pick<AnnotationLifecycleUpdateItem, "entityType" | "entityId" | "trackId">,
) {
  return buildStableTupleKey(item.entityType, item.trackId ?? null, item.entityId);
}

export function getAnnotationStateTargetKey(
  item: Pick<AnnotationStateUpdateItem, "entityType" | "entityId" | "trackId">,
) {
  return buildStableTupleKey(item.entityType, item.trackId ?? null, item.entityId);
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

// 生命周期按全局/轨道作用域接受固定字段；before/after 只能一侧非空，禁止借 create/delete 协议做实体更新。
function parseLifecycleItem(value: unknown): AnnotationLifecycleUpdateItem | null {
  if (!isRecord(value) || !isSafeId(value.entityId) ||
    (value.before === null) === (value.after === null)) return null;

  const isGlobal = value.entityType === "sentence" || value.entityType === "character" ||
    value.entityType === "banyan-section" || value.entityType === "banyan-mark";
  const isScoped = value.entityType === "custom-block" || value.entityType === "attached-point" ||
    value.entityType === "gongche-block" || value.entityType === "gongche-symbol";
  const keys = isGlobal
    ? ["entityType", "entityId", "before", "after"]
    : ["entityType", "entityId", "trackId", "before", "after"];
  if ((!isGlobal && !isScoped) || !isExactRecord(value, keys) || (isScoped && !isSafeId(value.trackId))) return null;

  if (value.entityType === "sentence") {
    return parseTypedLifecycleItem(value, "sentence", parseSentenceLifecycleSnapshot);
  }
  if (value.entityType === "character") {
    return parseTypedLifecycleItem(value, "character", parseCharacterLifecycleSnapshot);
  }
  if (value.entityType === "banyan-section") {
    return parseTypedLifecycleItem(value, "banyan-section", parseBanyanSectionStateSnapshot);
  }
  if (value.entityType === "banyan-mark") {
    return parseTypedLifecycleItem(value, "banyan-mark", parseBanyanMarkStateSnapshot);
  }

  if (value.entityType === "custom-block") {
    return parseTypedScopedLifecycleItem(value, "custom-block", parseCustomBlockLifecycleSnapshot);
  }
  if (value.entityType === "attached-point") {
    return parseTypedScopedLifecycleItem(value, "attached-point", parseAttachedPointLifecycleSnapshot);
  }
  if (value.entityType === "gongche-block") {
    const item = parseTypedScopedLifecycleItem(value, "gongche-block", parseGongcheBlockLifecycleSnapshot);
    const state = item?.before ?? item?.after;
    return item && state?.entity.parentTrackId === item.trackId ? item : null;
  }
  return parseTypedScopedLifecycleItem(value, "gongche-symbol", parseGongcheSymbolLifecycleSnapshot);
}

function parseTypedLifecycleItem<
  TEntityType extends "sentence" | "character" | "banyan-section" | "banyan-mark",
  TSnapshot extends { id: string },
>(
  value: Record<string, unknown>,
  entityType: TEntityType,
  parseSnapshot: (snapshot: unknown) => TSnapshot | null,
): Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }> | null {
  const before = parseLifecycleState(value.before, parseSnapshot);
  const after = parseLifecycleState(value.after, parseSnapshot);
  if ((value.before !== null && !before) || (value.after !== null && !after)) return null;
  const state = before ?? after;
  if (!state || state.entity.id !== value.entityId) return null;
  return {
    entityType,
    entityId: value.entityId as string,
    before,
    after,
  } as Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }>;
}

function parseTypedScopedLifecycleItem<
  TEntityType extends "custom-block" | "attached-point" | "gongche-block" | "gongche-symbol",
  TSnapshot extends { id: string },
>(
  value: Record<string, unknown>,
  entityType: TEntityType,
  parseSnapshot: (snapshot: unknown) => TSnapshot | null,
): Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }> | null {
  const before = parseLifecycleState(value.before, parseSnapshot);
  const after = parseLifecycleState(value.after, parseSnapshot);
  if ((value.before !== null && !before) || (value.after !== null && !after)) return null;
  const state = before ?? after;
  if (!state || state.entity.id !== value.entityId) return null;
  return {
    entityType,
    entityId: value.entityId as string,
    trackId: value.trackId as string,
    before,
    after,
  } as Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }>;
}

// 复合状态项与 lifecycle 共用快照 parser，但 before/after 必须同时存在且保持同一实体身份和父作用域。
function parseStateItem(value: unknown): AnnotationStateUpdateItem | null {
  if (!isRecord(value) || !isSafeId(value.entityId)) return null;
  const isScoped = value.entityType === "gongche-symbol";
  const isGlobal = value.entityType === "banyan-section" || value.entityType === "banyan-mark";
  const keys = isScoped
    ? ["entityType", "entityId", "trackId", "before", "after"]
    : ["entityType", "entityId", "before", "after"];
  if ((!isScoped && !isGlobal) || !isExactRecord(value, keys) || (isScoped && !isSafeId(value.trackId))) return null;

  if (value.entityType === "gongche-symbol") {
    return parseTypedScopedStateItem(value, "gongche-symbol", parseGongcheSymbolLifecycleSnapshot);
  }
  if (value.entityType === "banyan-section") {
    return parseTypedGlobalStateItem(value, "banyan-section", parseBanyanSectionStateSnapshot);
  }
  return parseTypedGlobalStateItem(value, "banyan-mark", parseBanyanMarkStateSnapshot);
}

function parseTypedGlobalStateItem<
  TEntityType extends "banyan-section" | "banyan-mark",
  TSnapshot extends { id: string },
>(
  value: Record<string, unknown>,
  entityType: TEntityType,
  parseSnapshot: (snapshot: unknown) => TSnapshot | null,
): Extract<AnnotationStateUpdateItem, { entityType: TEntityType }> | null {
  const before = parseSnapshot(value.before);
  const after = parseSnapshot(value.after);
  if (!before || !after || before.id !== value.entityId || after.id !== value.entityId) return null;
  return { entityType, entityId: value.entityId as string, before, after } as Extract<
    AnnotationStateUpdateItem,
    { entityType: TEntityType }
  >;
}

function parseTypedScopedStateItem<
  TEntityType extends "gongche-symbol",
  TSnapshot extends { id: string },
>(
  value: Record<string, unknown>,
  entityType: TEntityType,
  parseSnapshot: (snapshot: unknown) => TSnapshot | null,
): Extract<AnnotationStateUpdateItem, { entityType: TEntityType }> | null {
  const before = parseSnapshot(value.before);
  const after = parseSnapshot(value.after);
  if (!before || !after || before.id !== value.entityId || after.id !== value.entityId) return null;
  return {
    entityType,
    entityId: value.entityId as string,
    trackId: value.trackId as string,
    before,
    after,
  } as Extract<AnnotationStateUpdateItem, { entityType: TEntityType }>;
}

// null 是合法的不存在状态；非 null 状态必须同时通过实体和位置 parser。
function parseLifecycleState<TEntity>(
  value: unknown,
  parseEntity: (entity: unknown) => TEntity | null,
): AnnotationLifecycleState<TEntity> | null {
  if (value === null) return null;
  if (!isExactRecord(value, ["entity", "position"])) return null;
  const entity = parseEntity(value.entity);
  const position = parseLifecyclePosition(value.position);
  return entity && position ? { entity, position } : null;
}

// 位置边界必须自洽：首项没有前邻、末项没有后邻，中间项两侧都必须给出稳定 id。
function parseLifecyclePosition(value: unknown): AnnotationLifecyclePosition | null {
  if (!isExactRecord(value, ["index", "collectionLength", "previousEntityId", "nextEntityId"]) ||
    !Number.isSafeInteger(value.index) ||
    !Number.isSafeInteger(value.collectionLength) ||
    (value.index as number) < 0 ||
    (value.collectionLength as number) <= 0 ||
    (value.index as number) >= (value.collectionLength as number) ||
    (value.previousEntityId !== null && !isSafeId(value.previousEntityId)) ||
    (value.nextEntityId !== null && !isSafeId(value.nextEntityId))) return null;
  const index = value.index as number;
  const collectionLength = value.collectionLength as number;
  if ((index === 0) !== (value.previousEntityId === null) ||
    (index === collectionLength - 1) !== (value.nextEntityId === null)) return null;
  return {
    index,
    collectionLength,
    previousEntityId: value.previousEntityId,
    nextEntityId: value.nextEntityId,
  };
}

// 自定义块快照固定所有可选字段，防止借生命周期命令夹带未知块属性。
function parseCustomBlockLifecycleSnapshot(value: unknown): CustomBlockLifecycleSnapshot | null {
  if (!isExactRecord(value, [
    "id",
    "startTime",
    "endTime",
    "text",
    "type",
    "branchScope",
    "branchGroupId",
    "branchParentBlockId",
  ]) ||
    !isSafeId(value.id) ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) ||
    value.endTime < value.startTime ||
    (value.text !== null && (typeof value.text !== "string" || value.text.length > MAX_ANNOTATION_CONTENT_LENGTH)) ||
    typeof value.type !== "string" ||
    value.type.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    (value.branchGroupId !== null && !isSafeId(value.branchGroupId)) ||
    (value.branchParentBlockId !== null && !isSafeId(value.branchParentBlockId))) return null;
  const branchScope = parseLifecycleBranchScope(value.branchScope);
  if (value.branchScope !== null && !branchScope) return null;
  return {
    id: value.id,
    startTime: value.startTime,
    endTime: value.endTime,
    text: value.text,
    type: value.type,
    branchScope,
    branchGroupId: value.branchGroupId,
    branchParentBlockId: value.branchParentBlockId,
  };
}

// 分叉归属只接受根轨或非空且不重复的稳定 lane id 集合。
function parseLifecycleBranchScope(value: unknown): AnnotationLifecycleBranchScope | null {
  if (value === null) return null;
  if (isExactRecord(value, ["mode"]) && value.mode === "root") return { mode: "root" };
  if (!isExactRecord(value, ["mode", "laneIds"]) ||
    value.mode !== "lanes" ||
    !Array.isArray(value.laneIds) ||
    value.laneIds.length === 0 ||
    value.laneIds.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const laneIds = value.laneIds.filter(isSafeId);
  if (laneIds.length !== value.laneIds.length || new Set(laneIds).size !== laneIds.length) return null;
  return { mode: "lanes", laneIds: [...laneIds] };
}

// 附属点是最小叶实体，只接受稳定 id、有限非负时间和有界标签。
function parseAttachedPointLifecycleSnapshot(value: unknown): AttachedPointLifecycleSnapshot | null {
  if (!isExactRecord(value, ["id", "time", "label"]) ||
    !isSafeId(value.id) ||
    !isNonNegativeFiniteNumber(value.time) ||
    typeof value.label !== "string" ||
    value.label.length > MAX_ANNOTATION_CONTENT_LENGTH) return null;
  return { id: value.id, time: value.time, label: value.label };
}

function parseSentenceLifecycleSnapshot(value: unknown): SentenceLifecycleSnapshot | null {
  if (!isExactRecord(value, ["id", "text", "startTime", "endTime"]) ||
    !isSafeId(value.id) ||
    typeof value.text !== "string" ||
    value.text.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) || value.endTime < value.startTime) return null;
  return { id: value.id, text: value.text, startTime: value.startTime, endTime: value.endTime };
}

function parseCharacterLifecycleSnapshot(value: unknown): CharacterLifecycleSnapshot | null {
  if (!isExactRecord(value, ["id", "lineId", "char", "startTime", "endTime", "singingStyle", "tone"]) ||
    !isSafeId(value.id) || !isSafeId(value.lineId) ||
    typeof value.char !== "string" || value.char.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    typeof value.singingStyle !== "string" || value.singingStyle.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) || value.endTime < value.startTime) return null;
  const tone = parseCharacterToneLifecycleSnapshot(value.tone);
  if (value.tone !== null && !tone) return null;
  return {
    id: value.id,
    lineId: value.lineId,
    char: value.char,
    startTime: value.startTime,
    endTime: value.endTime,
    singingStyle: value.singingStyle,
    tone,
  };
}

const TONE_CLASS_SET = new Set([
  "yin_ping", "yang_ping", "yin_shang", "yang_shang",
  "yin_qu", "yang_qu", "yin_ru", "yang_ru",
]);
const SHANG_SUBTYPE_SET = new Set(["yin_shang", "yang_shang", "yinyang_tongyong"]);

function parseCharacterToneLifecycleSnapshot(value: unknown): CharacterToneLifecycleSnapshot | null {
  if (value === null) return null;
  if (!isExactRecord(value, ["toneClass", "yxlzShangSubtype"]) ||
    typeof value.toneClass !== "string" || !TONE_CLASS_SET.has(value.toneClass) ||
    (value.yxlzShangSubtype !== null &&
      (typeof value.yxlzShangSubtype !== "string" || !SHANG_SUBTYPE_SET.has(value.yxlzShangSubtype)))) return null;
  const isShang = value.toneClass === "yin_shang" || value.toneClass === "yang_shang";
  if (!isShang && value.yxlzShangSubtype !== null) return null;
  return value as CharacterToneLifecycleSnapshot;
}

function parseGongcheBlockLifecycleSnapshot(value: unknown): GongcheBlockLifecycleSnapshot | null {
  if (!isExactRecord(value, ["id", "parentTrackId", "parentBlockId", "startTime", "endTime", "symbols"]) ||
    !isSafeId(value.id) || !isSafeId(value.parentTrackId) || !isSafeId(value.parentBlockId) ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) || value.endTime < value.startTime ||
    !Array.isArray(value.symbols) || value.symbols.length > MAX_ANNOTATION_COMMAND_ITEMS) return null;
  const symbols = value.symbols.map(parseGongcheSymbolLifecycleSnapshot);
  if (symbols.some((symbol) => !symbol)) return null;
  const completeSymbols = symbols as GongcheSymbolLifecycleSnapshot[];
  if (new Set(completeSymbols.map((symbol) => symbol.id)).size !== completeSymbols.length) return null;
  return {
    id: value.id,
    parentTrackId: value.parentTrackId,
    parentBlockId: value.parentBlockId,
    startTime: value.startTime,
    endTime: value.endTime,
    symbols: completeSymbols,
  };
}

function parseGongcheSymbolLifecycleSnapshot(value: unknown): GongcheSymbolLifecycleSnapshot | null {
  if (!isExactRecord(value, [
    "id", "label", "notation", "rawText", "parenthesized", "startTime", "endTime", "assetUrl",
  ]) || !isSafeId(value.id) ||
    typeof value.label !== "string" || value.label.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    !isNullableBoundedString(value.notation) || !isNullableBoundedString(value.rawText) ||
    typeof value.parenthesized !== "boolean" ||
    !isNonNegativeFiniteNumber(value.startTime) ||
    !isNonNegativeFiniteNumber(value.endTime) || value.endTime < value.startTime ||
    !isNullableBoundedString(value.assetUrl)) return null;
  return value as GongcheSymbolLifecycleSnapshot;
}

const BANYAN_CYCLE_TYPE_SET = new Set([
  "sanban", "liushuiban", "yi_ban_yi_yan", "yi_ban_yi_yan_zeng",
  "yi_ban_san_yan", "yi_ban_san_yan_zeng", "custom",
]);
const BANYAN_ROLE_SET = new Set(["ban", "yan", "auxiliary"]);
const BANYAN_SUBTYPE_SET = new Set([
  "mainBan", "headBan", "waistBan", "bottomBan", "zengBan", "waistZengBan",
  "middleEye", "smallEye", "sideHeadTailEye", "sideMiddleEye", "phraseBoundary", "unknown",
]);
const BANYAN_SEGMENT_SET = new Set(["main", "zeng", "free", "unknown"]);
const BANYAN_STRENGTH_SET = new Set(["strong", "medium", "weak", "unknown"]);
const BANYAN_ATTACHMENT_SET = new Set(["on_note", "in_between", "at_phrase_end", "unknown"]);
const BANYAN_CONFIDENCE_SET = new Set(["auto", "reviewed", "manual"]);

function parseBanyanSectionStateSnapshot(value: unknown): BanyanSectionStateSnapshot | null {
  if (!isExactRecord(value, [
    "id", "name", "startTime", "endTime", "cycleType", "freeRhythm", "beatCount", "hasZengBan", "source", "comment",
  ]) || !isSafeId(value.id) ||
    typeof value.name !== "string" || value.name.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    !isNonNegativeFiniteNumber(value.startTime) || !isNonNegativeFiniteNumber(value.endTime) ||
    value.endTime < value.startTime || typeof value.cycleType !== "string" ||
    !BANYAN_CYCLE_TYPE_SET.has(value.cycleType) || typeof value.freeRhythm !== "boolean" ||
    !isNullableNonNegativeInteger(value.beatCount) ||
    (value.hasZengBan !== null && typeof value.hasZengBan !== "boolean") ||
    !isNullableBoundedString(value.source) || !isNullableBoundedString(value.comment)) return null;
  return value as BanyanSectionStateSnapshot;
}

function parseBanyanMarkStateSnapshot(value: unknown): BanyanMarkStateSnapshot | null {
  if (!isExactRecord(value, [
    "id", "sectionId", "time", "estimatedTime", "sourceSymbol", "sourceTokenIndex", "sourceKey", "role", "subtype",
    "segment", "beatIndex", "cycleIndex", "strength", "attachment", "linkedGongcheAnnotationId",
    "linkedGongcheSymbolId", "linkedGongcheSymbolIds", "confidence", "manualOffset", "durationHint", "orphaned", "comment",
  ]) || !isSafeId(value.id) || (value.sectionId !== null && !isSafeId(value.sectionId)) ||
    !isNonNegativeFiniteNumber(value.time) || !isNonNegativeFiniteNumber(value.estimatedTime) ||
    typeof value.sourceSymbol !== "string" || value.sourceSymbol.length > MAX_ANNOTATION_CONTENT_LENGTH ||
    !isNullableNonNegativeInteger(value.sourceTokenIndex) || !isNullableBoundedString(value.sourceKey) ||
    typeof value.role !== "string" || !BANYAN_ROLE_SET.has(value.role) ||
    typeof value.subtype !== "string" || !BANYAN_SUBTYPE_SET.has(value.subtype) ||
    typeof value.segment !== "string" || !BANYAN_SEGMENT_SET.has(value.segment) ||
    !isNullableNonNegativeInteger(value.beatIndex) || !isNullableNonNegativeInteger(value.cycleIndex) ||
    (value.strength !== null && (typeof value.strength !== "string" || !BANYAN_STRENGTH_SET.has(value.strength))) ||
    typeof value.attachment !== "string" || !BANYAN_ATTACHMENT_SET.has(value.attachment) ||
    (value.linkedGongcheAnnotationId !== null && !isSafeId(value.linkedGongcheAnnotationId)) ||
    (value.linkedGongcheSymbolId !== null && !isSafeId(value.linkedGongcheSymbolId)) ||
    (value.linkedGongcheSymbolIds !== null && (!Array.isArray(value.linkedGongcheSymbolIds) ||
      value.linkedGongcheSymbolIds.length > MAX_ANNOTATION_COMMAND_ITEMS ||
      value.linkedGongcheSymbolIds.some((id) => !isSafeId(id)) ||
      new Set(value.linkedGongcheSymbolIds).size !== value.linkedGongcheSymbolIds.length)) ||
    typeof value.confidence !== "string" || !BANYAN_CONFIDENCE_SET.has(value.confidence) ||
    !isNullableFiniteNumber(value.manualOffset) || !isNullableBoundedString(value.durationHint) ||
    typeof value.orphaned !== "boolean" || !isNullableBoundedString(value.comment)) return null;
  return {
    ...(value as BanyanMarkStateSnapshot),
    linkedGongcheSymbolIds: value.linkedGongcheSymbolIds === null
      ? null
      : [...value.linkedGongcheSymbolIds] as string[],
  };
}

// 同一父集合的状态必须声明一致长度和唯一索引；长度变化必须等于创建数减删除数。
function validateLifecycleCollectionFacts(items: readonly AnnotationLifecycleUpdateItem[]) {
  const groups = new Map<string, AnnotationLifecycleUpdateItem[]>();
  for (const item of items) {
    const key = getAnnotationLifecycleCollectionKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const beforeStates = group.flatMap((item) => item.before ? [item.before] : []);
    const afterStates = group.flatMap((item) => item.after ? [item.after] : []);
    const beforeLengths = new Set(beforeStates.map((state) => state.position.collectionLength));
    const afterLengths = new Set(afterStates.map((state) => state.position.collectionLength));
    if (beforeLengths.size > 1 || afterLengths.size > 1 ||
      new Set(beforeStates.map((state) => state.position.index)).size !== beforeStates.length ||
      new Set(afterStates.map((state) => state.position.index)).size !== afterStates.length) return false;
    const beforeLength = beforeStates[0]?.position.collectionLength;
    const afterLength = afterStates[0]?.position.collectionLength;
    if (beforeLength !== undefined && afterLength !== undefined &&
      afterLength !== beforeLength - beforeStates.length + afterStates.length) return false;
    if (beforeLength === undefined && afterLength !== undefined && afterLength < afterStates.length) return false;
    if (afterLength === undefined && beforeLength !== undefined && beforeLength < beforeStates.length) return false;
  }
  return true;
}

// 顶层实体按项目数组分组；只有真实嵌套集合按父 scope 分组，不能把工尺块的轨道引用当成物理集合。
function getAnnotationLifecycleCollectionKey(item: AnnotationLifecycleUpdateItem) {
  if (item.entityType === "custom-block" || item.entityType === "attached-point" ||
    item.entityType === "gongche-symbol") {
    return buildStableTupleKey(item.entityType, item.trackId);
  }
  return item.entityType;
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

// 生命周期快照包含 lane、symbol 和板眼链接数组；原生结构化克隆统一切断所有调用者引用。
function cloneLifecycleItem(item: AnnotationLifecycleUpdateItem): AnnotationLifecycleUpdateItem {
  return structuredClone(item);
}

function cloneStateItem(item: AnnotationStateUpdateItem): AnnotationStateUpdateItem {
  return structuredClone(item);
}

// 判别联合必须在 helper 内逐类交换，避免 TypeScript 把两种实体快照错误扩成可交叉联合。
function invertLifecycleItem(item: AnnotationLifecycleUpdateItem): AnnotationLifecycleUpdateItem {
  if (item.entityType === "sentence") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "character") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "banyan-section") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "banyan-mark") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "custom-block") {
    return { ...item, before: item.after, after: item.before };
  }
  if (item.entityType === "gongche-block") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "gongche-symbol") return { ...item, before: item.after, after: item.before };
  return { ...item, before: item.after, after: item.before };
}

function invertStateItem(item: AnnotationStateUpdateItem): AnnotationStateUpdateItem {
  if (item.entityType === "gongche-symbol") return { ...item, before: item.after, after: item.before };
  if (item.entityType === "banyan-section") return { ...item, before: item.after, after: item.before };
  return { ...item, before: item.after, after: item.before };
}

function getAnnotationStateItemCost(item: AnnotationStateUpdateItem) {
  if (item.entityType !== "banyan-mark") return 1;
  return 1 + Math.max(
    item.before.linkedGongcheSymbolIds?.length ?? 0,
    item.after.linkedGongcheSymbolIds?.length ?? 0,
  );
}

// shared 前置条件比较的是规范化纯数据，递归比较可覆盖 laneIds 而不依赖 JSON 属性顺序。
function areLifecycleValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => areLifecycleValuesEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areLifecycleValuesEqual(leftRecord[key], rightRecord[key]));
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

// 合法稳定 id 允许冒号；JSON 元组保留字段边界，避免拼接键在去重和前置检查中发生碰撞。
function buildStableTupleKey(...parts: readonly (string | null)[]) {
  return JSON.stringify(parts);
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

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= MAX_ANNOTATION_CONTENT_LENGTH);
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
