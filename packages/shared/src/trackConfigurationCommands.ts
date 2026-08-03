export const TRACK_ORDER_UPDATE_COMMAND = "annotation.track.order.update" as const;
export const BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND = "annotation.builtin-track.structure.update" as const;
export const ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND =
  "annotation.attached-point-track.structure.update" as const;

const MAX_COMMAND_ITEMS = 500;
const MAX_TEXT_LENGTH = 2_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type TrackOrderUpdateCommand = {
  type: typeof TRACK_ORDER_UPDATE_COMMAND;
  before: string[];
  after: string[];
};

export type TrackOrderCommandEnvelope = {
  version: 1;
  command: TrackOrderUpdateCommand;
};

export type BuiltinTrackStructureSnapshot = {
  id: string;
  trackType: "character" | "action";
  name: string;
  options: string[] | null;
  attachedPointTracksExpanded: boolean | null;
  snapToWaveformKeypoints: boolean | null;
  autoSetLoopRangeOnSelect: boolean | null;
};

export type BuiltinTrackStructureUpdateItem = {
  trackId: string;
  before: BuiltinTrackStructureSnapshot;
  after: BuiltinTrackStructureSnapshot;
};

export type BuiltinTrackStructureUpdateCommand = {
  type: typeof BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND;
  items: BuiltinTrackStructureUpdateItem[];
};

export type BuiltinTrackStructureCommandEnvelope = {
  version: 1;
  command: BuiltinTrackStructureUpdateCommand;
};

export type AttachedPointTrackParentType = "builtin" | "custom";

export type AttachedPointTrackStructureSnapshot = {
  id: string;
  name: string;
  typeOptions: string[];
  snapToWaveformKeypoints: boolean | null;
  snapToParentBoundaries: boolean | null;
  autoSetLoopRangeOnSelect: boolean | null;
};

export type AttachedPointTrackStructureUpdateItem = {
  parentTrackType: AttachedPointTrackParentType;
  parentTrackId: string;
  pointTrackId: string;
  before: AttachedPointTrackStructureSnapshot;
  after: AttachedPointTrackStructureSnapshot;
};

export type AttachedPointTrackStructureUpdateCommand = {
  type: typeof ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND;
  items: AttachedPointTrackStructureUpdateItem[];
};

export type AttachedPointTrackStructureCommandEnvelope = {
  version: 1;
  command: AttachedPointTrackStructureUpdateCommand;
};

export type TrackConfigurationChildCommand =
  | TrackOrderUpdateCommand
  | BuiltinTrackStructureUpdateCommand
  | AttachedPointTrackStructureUpdateCommand;

export type TrackConfigurationCommandEnvelope =
  | TrackOrderCommandEnvelope
  | BuiltinTrackStructureCommandEnvelope
  | AttachedPointTrackStructureCommandEnvelope;

// 轨道顺序只能重排同一组稳定身份，不能借 reorder 命令隐式创建或删除轨道。
export function buildTrackOrderUpdateEnvelope(
  before: readonly string[],
  after: readonly string[],
): TrackOrderCommandEnvelope | null {
  return parseTrackOrderCommandEnvelope({
    version: 1,
    command: { type: TRACK_ORDER_UPDATE_COMMAND, before: [...before], after: [...after] },
  });
}

export function parseTrackOrderCommandEnvelope(value: unknown): TrackOrderCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "before", "after"]) ||
    value.command.type !== TRACK_ORDER_UPDATE_COMMAND) return null;
  const before = parseStableIdArray(value.command.before);
  const after = parseStableIdArray(value.command.after);
  if (!before || !after || before.length === 0 || before.length > MAX_COMMAND_ITEMS ||
    haveSameOrder(before, after) || !haveSameIdSet(before, after)) return null;
  return { version: 1, command: { type: TRACK_ORDER_UPDATE_COMMAND, before, after } };
}

export function buildBuiltinTrackStructureUpdateEnvelope(
  items: readonly BuiltinTrackStructureUpdateItem[],
): BuiltinTrackStructureCommandEnvelope | null {
  const changed = items
    .filter((item) => !areValuesEqual(item.before, item.after))
    .map((item) => structuredClone(item))
    .sort((left, right) => compareIds(left.trackId, right.trackId));
  if (changed.length === 0) return null;
  return parseBuiltinTrackStructureCommandEnvelope({
    version: 1,
    command: { type: BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND, items: changed },
  });
}

export function parseBuiltinTrackStructureCommandEnvelope(
  value: unknown,
): BuiltinTrackStructureCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0 ||
    value.command.items.length > MAX_COMMAND_ITEMS) return null;
  const items: BuiltinTrackStructureUpdateItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.command.items) {
    if (!isExactRecord(raw, ["trackId", "before", "after"]) || !isSafeId(raw.trackId)) return null;
    const before = parseBuiltinSnapshot(raw.before);
    const after = parseBuiltinSnapshot(raw.after);
    if (!before || !after || before.id !== raw.trackId || after.id !== raw.trackId ||
      before.trackType !== after.trackType || ids.has(raw.trackId) || areValuesEqual(before, after)) return null;
    ids.add(raw.trackId);
    items.push({ trackId: raw.trackId, before, after });
  }
  return { version: 1, command: { type: BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND, items } };
}

export function buildAttachedPointTrackStructureUpdateEnvelope(
  items: readonly AttachedPointTrackStructureUpdateItem[],
): AttachedPointTrackStructureCommandEnvelope | null {
  const changed = items
    .filter((item) => !areValuesEqual(item.before, item.after))
    .map((item) => structuredClone(item))
    .sort((left, right) => compareIds(getPointTargetKey(left), getPointTargetKey(right)));
  if (changed.length === 0) return null;
  return parseAttachedPointTrackStructureCommandEnvelope({
    version: 1,
    command: { type: ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND, items: changed },
  });
}

export function parseAttachedPointTrackStructureCommandEnvelope(
  value: unknown,
): AttachedPointTrackStructureCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0 ||
    value.command.items.length > MAX_COMMAND_ITEMS) return null;
  const items: AttachedPointTrackStructureUpdateItem[] = [];
  const pointTrackIds = new Set<string>();
  for (const raw of value.command.items) {
    if (!isExactRecord(raw, ["parentTrackType", "parentTrackId", "pointTrackId", "before", "after"]) ||
      (raw.parentTrackType !== "builtin" && raw.parentTrackType !== "custom") ||
      !isSafeId(raw.parentTrackId) || !isSafeId(raw.pointTrackId)) return null;
    const before = parsePointSnapshot(raw.before);
    const after = parsePointSnapshot(raw.after);
    if (!before || !after || before.id !== raw.pointTrackId || after.id !== raw.pointTrackId ||
      pointTrackIds.has(raw.pointTrackId) || areValuesEqual(before, after)) return null;
    // ProjectData 要求点轨 id 跨所有父轨唯一，命令层也不能用不同 parent 伪装两个目标。
    pointTrackIds.add(raw.pointTrackId);
    items.push({
      parentTrackType: raw.parentTrackType,
      parentTrackId: raw.parentTrackId,
      pointTrackId: raw.pointTrackId,
      before,
      after,
    });
  }
  return { version: 1, command: { type: ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND, items } };
}

// 所有配置叶命令的 inverse 只交换严格快照，不引入第二套恢复语义。
export function invertTrackConfigurationCommandEnvelope(value: unknown): TrackConfigurationCommandEnvelope | null {
  if (!isRecord(value) || !isRecord(value.command)) return null;
  if (value.command.type === TRACK_ORDER_UPDATE_COMMAND) {
    const parsed = parseTrackOrderCommandEnvelope(value);
    return parsed ? buildTrackOrderUpdateEnvelope(parsed.command.after, parsed.command.before) : null;
  }
  if (value.command.type === BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND) {
    const parsed = parseBuiltinTrackStructureCommandEnvelope(value);
    return parsed ? buildBuiltinTrackStructureUpdateEnvelope(parsed.command.items.map((item) => ({
      ...item,
      before: item.after,
      after: item.before,
    }))) : null;
  }
  if (value.command.type === ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND) {
    const parsed = parseAttachedPointTrackStructureCommandEnvelope(value);
    return parsed ? buildAttachedPointTrackStructureUpdateEnvelope(parsed.command.items.map((item) => ({
      ...item,
      before: item.after,
      after: item.before,
    }))) : null;
  }
  return null;
}

export function getTrackConfigurationCommandCost(command: TrackConfigurationChildCommand) {
  return command.type === TRACK_ORDER_UPDATE_COMMAND
    ? Math.max(command.before.length, command.after.length)
    : command.items.length;
}

function parseBuiltinSnapshot(value: unknown): BuiltinTrackStructureSnapshot | null {
  if (!isExactRecord(value, [
    "id", "trackType", "name", "options", "attachedPointTracksExpanded",
    "snapToWaveformKeypoints", "autoSetLoopRangeOnSelect",
  ]) || !isSafeId(value.id) || (value.trackType !== "character" && value.trackType !== "action") ||
    !isBoundedText(value.name) || !isNullableStringArray(value.options) ||
    !isNullableBoolean(value.attachedPointTracksExpanded) ||
    !isNullableBoolean(value.snapToWaveformKeypoints) ||
    !isNullableBoolean(value.autoSetLoopRangeOnSelect)) return null;
  return {
    id: value.id,
    trackType: value.trackType,
    name: value.name,
    options: value.options === null ? null : [...value.options],
    attachedPointTracksExpanded: value.attachedPointTracksExpanded,
    snapToWaveformKeypoints: value.snapToWaveformKeypoints,
    autoSetLoopRangeOnSelect: value.autoSetLoopRangeOnSelect,
  };
}

function parsePointSnapshot(value: unknown): AttachedPointTrackStructureSnapshot | null {
  if (!isExactRecord(value, [
    "id", "name", "typeOptions", "snapToWaveformKeypoints", "snapToParentBoundaries",
    "autoSetLoopRangeOnSelect",
  ]) || !isSafeId(value.id) || !isBoundedText(value.name) ||
    !isStringArray(value.typeOptions) || !isNullableBoolean(value.snapToWaveformKeypoints) ||
    !isNullableBoolean(value.snapToParentBoundaries) ||
    !isNullableBoolean(value.autoSetLoopRangeOnSelect)) return null;
  return {
    id: value.id,
    name: value.name,
    typeOptions: [...value.typeOptions],
    snapToWaveformKeypoints: value.snapToWaveformKeypoints,
    snapToParentBoundaries: value.snapToParentBoundaries,
    autoSetLoopRangeOnSelect: value.autoSetLoopRangeOnSelect,
  };
}

function parseStableIdArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => !isSafeId(item))) return null;
  const result = value as string[];
  return new Set(result).size === result.length ? [...result] : null;
}

function isNullableStringArray(value: unknown): value is string[] | null {
  return value === null || isStringArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_COMMAND_ITEMS && value.every(isBoundedText);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function haveSameOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => right[index] === id);
}

function haveSameIdSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function getPointTargetKey(item: Pick<AttachedPointTrackStructureUpdateItem,
  "parentTrackType" | "parentTrackId" | "pointTrackId">) {
  return `${item.parentTrackType}:${item.parentTrackId}:${item.pointTrackId}`;
}

function compareIds(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function areValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
