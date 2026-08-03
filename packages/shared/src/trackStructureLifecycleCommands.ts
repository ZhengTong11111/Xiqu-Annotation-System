import {
  getCustomTrackStructureSnapshotCost,
  parseCustomTrackStructureSnapshot,
  type CustomTrackStructureSnapshot,
} from "./customTrackStructureCommands.js";

export const CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND = "annotation.custom-track.lifecycle.update" as const;
export const ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND =
  "annotation.attached-point-track.lifecycle.update" as const;
export const BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND = "annotation.builtin-track.lifecycle.update" as const;

const MAX_STRUCTURE_ENTITIES = 500;
const MAX_TEXT_LENGTH = 2_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type TrackStructureCollectionPosition = {
  index: number;
  collectionLength: number;
  previousEntityId: string | null;
  nextEntityId: string | null;
};

export type CustomTrackOwnedBlockSnapshot = {
  id: string;
  startTime: number;
  endTime: number;
  text: string | null;
  type: string;
};

export type AttachedPointTrackPointSnapshot = {
  id: string;
  time: number;
  label: string;
};

export type AttachedPointTrackSnapshot = {
  id: string;
  name: string;
  typeOptions: string[];
  points: AttachedPointTrackPointSnapshot[];
  snapToWaveformKeypoints: boolean | null;
  snapToParentBoundaries: boolean | null;
  autoSetLoopRangeOnSelect: boolean | null;
};

export type CustomTrackLifecycleSnapshot = {
  structure: CustomTrackStructureSnapshot;
  blocks: CustomTrackOwnedBlockSnapshot[];
  attachedPointTracks: AttachedPointTrackSnapshot[];
};

export type CustomTrackLifecycleState = {
  entity: CustomTrackLifecycleSnapshot;
  customTrackPosition: TrackStructureCollectionPosition;
  activeTrackPosition: TrackStructureCollectionPosition;
};

export type CustomTrackLifecycleUpdateItem = {
  trackId: string;
  before: CustomTrackLifecycleState | null;
  after: CustomTrackLifecycleState | null;
};

export type CustomTrackLifecycleUpdateCommand = {
  type: typeof CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND;
  items: CustomTrackLifecycleUpdateItem[];
};

export type CustomTrackLifecycleCommandEnvelope = {
  version: 1;
  command: CustomTrackLifecycleUpdateCommand;
};

export type AttachedPointTrackLifecycleEntityState = {
  entity: AttachedPointTrackSnapshot;
  position: TrackStructureCollectionPosition;
};

// 父轨展开状态在点轨不存在的一侧仍然有意义，因此与可空 entity 分开保存。
export type AttachedPointTrackLifecycleContext = {
  entity: AttachedPointTrackLifecycleEntityState | null;
  parentAttachedPointTracksExpanded: boolean | null;
};

export type AttachedPointTrackLifecycleUpdateItem = {
  pointTrackId: string;
  parentTrackId: string;
  parentTrackType: "builtin" | "custom";
  before: AttachedPointTrackLifecycleContext;
  after: AttachedPointTrackLifecycleContext;
};

export type AttachedPointTrackLifecycleUpdateCommand = {
  type: typeof ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND;
  items: AttachedPointTrackLifecycleUpdateItem[];
};

export type AttachedPointTrackLifecycleCommandEnvelope = {
  version: 1;
  command: AttachedPointTrackLifecycleUpdateCommand;
};

export type BuiltinTrackLifecycleSnapshot = {
  id: "character-track";
  name: string;
  trackType: "character";
  options: string[] | null;
  attachedPointTracks: AttachedPointTrackSnapshot[];
  attachedPointTracksExpanded: boolean | null;
  snapToWaveformKeypoints: boolean | null;
  autoSetLoopRangeOnSelect: boolean | null;
};

export type BuiltinTrackLifecycleState = {
  entity: BuiltinTrackLifecycleSnapshot;
  builtinTrackPosition: TrackStructureCollectionPosition;
  activeTrackPosition: TrackStructureCollectionPosition;
};

export type BuiltinTrackLifecycleUpdateItem = {
  trackId: string;
  before: BuiltinTrackLifecycleState | null;
  after: BuiltinTrackLifecycleState | null;
};

export type BuiltinTrackLifecycleUpdateCommand = {
  type: typeof BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND;
  items: BuiltinTrackLifecycleUpdateItem[];
};

export type BuiltinTrackLifecycleCommandEnvelope = {
  version: 1;
  command: BuiltinTrackLifecycleUpdateCommand;
};

export type TrackStructureLifecycleChildCommand =
  | CustomTrackLifecycleUpdateCommand
  | AttachedPointTrackLifecycleUpdateCommand
  | BuiltinTrackLifecycleUpdateCommand;

export type TrackStructureLifecycleCommandEnvelope =
  | CustomTrackLifecycleCommandEnvelope
  | AttachedPointTrackLifecycleCommandEnvelope
  | BuiltinTrackLifecycleCommandEnvelope;

// builder 一律回送严格 parser；调用方不能构造 parser 自己无法接受的内存特例。
export function buildCustomTrackLifecycleUpdateEnvelope(
  items: readonly CustomTrackLifecycleUpdateItem[],
): CustomTrackLifecycleCommandEnvelope | null {
  return parseCustomTrackLifecycleCommandEnvelope({
    version: 1,
    command: {
      type: CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND,
      items: [...items]
        .map((item) => structuredClone(item))
        .sort((left, right) => compareIds(left.trackId, right.trackId)),
    },
  });
}

export function parseCustomTrackLifecycleCommandEnvelope(
  value: unknown,
): CustomTrackLifecycleCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0) return null;
  const items: CustomTrackLifecycleUpdateItem[] = [];
  const ids = new Set<string>();
  let totalCost = 0;
  for (const rawItem of value.command.items) {
    const item = parseCustomTrackLifecycleItem(rawItem);
    if (!item || ids.has(item.trackId)) return null;
    ids.add(item.trackId);
    totalCost += getCustomTrackLifecycleItemCost(item);
    if (totalCost > MAX_STRUCTURE_ENTITIES) return null;
    items.push(item);
  }
  return { version: 1, command: { type: CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND, items } };
}

export function buildAttachedPointTrackLifecycleUpdateEnvelope(
  items: readonly AttachedPointTrackLifecycleUpdateItem[],
): AttachedPointTrackLifecycleCommandEnvelope | null {
  return parseAttachedPointTrackLifecycleCommandEnvelope({
    version: 1,
    command: {
      type: ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND,
      items: [...items]
        .map((item) => structuredClone(item))
        .sort((left, right) => compareIds(left.pointTrackId, right.pointTrackId)),
    },
  });
}

export function parseAttachedPointTrackLifecycleCommandEnvelope(
  value: unknown,
): AttachedPointTrackLifecycleCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0) return null;
  const items: AttachedPointTrackLifecycleUpdateItem[] = [];
  const ids = new Set<string>();
  let totalCost = 0;
  for (const rawItem of value.command.items) {
    const item = parseAttachedPointTrackLifecycleItem(rawItem);
    if (!item || ids.has(item.pointTrackId)) return null;
    ids.add(item.pointTrackId);
    totalCost += getAttachedPointTrackLifecycleItemCost(item);
    if (totalCost > MAX_STRUCTURE_ENTITIES) return null;
    items.push(item);
  }
  return { version: 1, command: { type: ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND, items } };
}

export function buildBuiltinTrackLifecycleUpdateEnvelope(
  items: readonly BuiltinTrackLifecycleUpdateItem[],
): BuiltinTrackLifecycleCommandEnvelope | null {
  return parseBuiltinTrackLifecycleCommandEnvelope({
    version: 1,
    command: {
      type: BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND,
      items: [...items]
        .map((item) => structuredClone(item))
        .sort((left, right) => compareIds(left.trackId, right.trackId)),
    },
  });
}

export function parseBuiltinTrackLifecycleCommandEnvelope(
  value: unknown,
): BuiltinTrackLifecycleCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0) return null;
  const items: BuiltinTrackLifecycleUpdateItem[] = [];
  const ids = new Set<string>();
  let totalCost = 0;
  for (const rawItem of value.command.items) {
    const item = parseBuiltinTrackLifecycleItem(rawItem);
    if (!item || ids.has(item.trackId)) return null;
    ids.add(item.trackId);
    totalCost += getBuiltinTrackLifecycleItemCost(item);
    if (totalCost > MAX_STRUCTURE_ENTITIES) return null;
    items.push(item);
  }
  return { version: 1, command: { type: BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND, items } };
}

export function invertTrackStructureLifecycleCommandEnvelope(
  value: unknown,
): TrackStructureLifecycleCommandEnvelope | null {
  const custom = parseCustomTrackLifecycleCommandEnvelope(value);
  if (custom) {
    return buildCustomTrackLifecycleUpdateEnvelope(custom.command.items.map((item) => ({
      trackId: item.trackId,
      before: item.after,
      after: item.before,
    })));
  }
  const point = parseAttachedPointTrackLifecycleCommandEnvelope(value);
  if (point) {
    return buildAttachedPointTrackLifecycleUpdateEnvelope(point.command.items.map((item) => ({
        ...item,
        before: item.after,
        after: item.before,
      })));
  }
  const builtin = parseBuiltinTrackLifecycleCommandEnvelope(value);
  return builtin
    ? buildBuiltinTrackLifecycleUpdateEnvelope(builtin.command.items.map((item) => ({
        trackId: item.trackId,
        before: item.after,
        after: item.before,
      })))
    : null;
}

export function getCustomTrackLifecycleItemCost(item: CustomTrackLifecycleUpdateItem) {
  const snapshot = item.before?.entity ?? item.after?.entity;
  return snapshot
    ? getCustomTrackStructureSnapshotCost(snapshot.structure) +
      snapshot.attachedPointTracks.reduce((total, track) => total + 1 + track.points.length, 0)
    : MAX_STRUCTURE_ENTITIES + 1;
}

export function getAttachedPointTrackLifecycleItemCost(item: AttachedPointTrackLifecycleUpdateItem) {
  const snapshot = item.before.entity?.entity ?? item.after.entity?.entity;
  return snapshot ? 1 + snapshot.points.length : MAX_STRUCTURE_ENTITIES + 1;
}

export function getBuiltinTrackLifecycleItemCost(item: BuiltinTrackLifecycleUpdateItem) {
  const snapshot = item.before?.entity ?? item.after?.entity;
  return snapshot
    ? 1 + snapshot.attachedPointTracks.reduce((total, track) => total + 1 + track.points.length, 0)
    : MAX_STRUCTURE_ENTITIES + 1;
}

export function getTrackStructureLifecycleTargetKey(
  item: CustomTrackLifecycleUpdateItem | AttachedPointTrackLifecycleUpdateItem | BuiltinTrackLifecycleUpdateItem,
) {
  if ("pointTrackId" in item) {
    return JSON.stringify([ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND, item.parentTrackId, item.pointTrackId]);
  }
  const state = item.before ?? item.after;
  const type = state && "structure" in state.entity
    ? CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND
    : BUILTIN_TRACK_LIFECYCLE_UPDATE_COMMAND;
  return JSON.stringify([type, item.trackId]);
}

function parseCustomTrackLifecycleItem(value: unknown): CustomTrackLifecycleUpdateItem | null {
  if (!isExactRecord(value, ["trackId", "before", "after"]) || !isSafeId(value.trackId) ||
    (value.before === null) === (value.after === null)) return null;
  const before = parseCustomTrackLifecycleState(value.before);
  const after = parseCustomTrackLifecycleState(value.after);
  if ((value.before !== null && !before) || (value.after !== null && !after)) return null;
  const state = before ?? after;
  if (!state || state.entity.structure.id !== value.trackId) return null;
  return { trackId: value.trackId, before, after };
}

function parseCustomTrackLifecycleState(value: unknown): CustomTrackLifecycleState | null {
  if (value === null) return null;
  if (!isExactRecord(value, ["entity", "customTrackPosition", "activeTrackPosition"])) return null;
  const entity = parseCustomTrackLifecycleSnapshot(value.entity);
  const customTrackPosition = parseCollectionPosition(value.customTrackPosition);
  const activeTrackPosition = parseCollectionPosition(value.activeTrackPosition);
  return entity && customTrackPosition && activeTrackPosition
    ? { entity, customTrackPosition, activeTrackPosition }
    : null;
}

function parseCustomTrackLifecycleSnapshot(value: unknown): CustomTrackLifecycleSnapshot | null {
  if (!isExactRecord(value, ["structure", "blocks", "attachedPointTracks"]) ||
    !Array.isArray(value.blocks) || !Array.isArray(value.attachedPointTracks)) return null;
  const structure = parseCustomTrackStructureSnapshot(value.structure);
  const blocks = value.blocks.map(parseOwnedBlockSnapshot);
  const attachedPointTracks = value.attachedPointTracks.map(parseAttachedPointTrackSnapshot);
  if (!structure || blocks.some((block) => !block) || attachedPointTracks.some((track) => !track)) return null;
  const completeBlocks = blocks as CustomTrackOwnedBlockSnapshot[];
  const completePointTracks = attachedPointTracks as AttachedPointTrackSnapshot[];
  const structureIds = structure.blocks.map((block) => block.id).sort(compareIds);
  const payloadIds = completeBlocks.map((block) => block.id).sort(compareIds);
  if (!sameIds(structureIds, payloadIds) || hasDuplicateIds(completeBlocks) || hasDuplicateIds(completePointTracks)) {
    return null;
  }
  if (structure.trackType === "text" && completeBlocks.some((block) => block.text === null) ||
    structure.trackType === "action" && completeBlocks.some((block) => block.text !== null)) return null;
  return { structure, blocks: completeBlocks, attachedPointTracks: completePointTracks };
}

function parseAttachedPointTrackLifecycleItem(value: unknown): AttachedPointTrackLifecycleUpdateItem | null {
  if (!isExactRecord(value, ["pointTrackId", "parentTrackId", "parentTrackType", "before", "after"]) ||
    !isSafeId(value.pointTrackId) || !isSafeId(value.parentTrackId) ||
    (value.parentTrackType !== "builtin" && value.parentTrackType !== "custom")) return null;
  const before = parseAttachedPointTrackLifecycleContext(value.before);
  const after = parseAttachedPointTrackLifecycleContext(value.after);
  if (!before || !after || (before.entity === null) === (after.entity === null)) return null;
  const entity = before.entity ?? after.entity;
  if (!entity || entity.entity.id !== value.pointTrackId) return null;
  return {
    pointTrackId: value.pointTrackId,
    parentTrackId: value.parentTrackId,
    parentTrackType: value.parentTrackType,
    before,
    after,
  };
}

function parseAttachedPointTrackLifecycleContext(value: unknown): AttachedPointTrackLifecycleContext | null {
  if (!isExactRecord(value, ["entity", "parentAttachedPointTracksExpanded"]) ||
    !isNullableBoolean(value.parentAttachedPointTracksExpanded)) return null;
  if (value.entity === null) {
    return { entity: null, parentAttachedPointTracksExpanded: value.parentAttachedPointTracksExpanded };
  }
  if (!isExactRecord(value.entity, ["entity", "position"])) return null;
  const entity = parseAttachedPointTrackSnapshot(value.entity.entity);
  const position = parseCollectionPosition(value.entity.position);
  return entity && position
    ? {
        entity: { entity, position },
        parentAttachedPointTracksExpanded: value.parentAttachedPointTracksExpanded,
      }
    : null;
}

function parseBuiltinTrackLifecycleItem(value: unknown): BuiltinTrackLifecycleUpdateItem | null {
  if (!isExactRecord(value, ["trackId", "before", "after"]) || !isSafeId(value.trackId) ||
    (value.before === null) === (value.after === null)) return null;
  const before = parseBuiltinTrackLifecycleState(value.before);
  const after = parseBuiltinTrackLifecycleState(value.after);
  if ((value.before !== null && !before) || (value.after !== null && !after)) return null;
  const state = before ?? after;
  return state?.entity.id === value.trackId ? { trackId: value.trackId, before, after } : null;
}

function parseBuiltinTrackLifecycleState(value: unknown): BuiltinTrackLifecycleState | null {
  if (value === null || !isExactRecord(value, ["entity", "builtinTrackPosition", "activeTrackPosition"])) return null;
  const entity = parseBuiltinTrackLifecycleSnapshot(value.entity);
  const builtinTrackPosition = parseCollectionPosition(value.builtinTrackPosition);
  const activeTrackPosition = parseCollectionPosition(value.activeTrackPosition);
  return entity && builtinTrackPosition && activeTrackPosition
    ? { entity, builtinTrackPosition, activeTrackPosition }
    : null;
}

function parseBuiltinTrackLifecycleSnapshot(value: unknown): BuiltinTrackLifecycleSnapshot | null {
  if (!isExactRecord(value, [
    "id", "name", "trackType", "options", "attachedPointTracks", "attachedPointTracksExpanded",
    "snapToWaveformKeypoints", "autoSetLoopRangeOnSelect",
  ]) || value.id !== "character-track" || typeof value.name !== "string" || value.name.length > MAX_TEXT_LENGTH ||
    value.trackType !== "character" ||
    !(value.options === null || Array.isArray(value.options)) ||
    (Array.isArray(value.options) && (value.options.length > MAX_STRUCTURE_ENTITIES ||
      value.options.some((option) => typeof option !== "string" || option.length > MAX_TEXT_LENGTH))) ||
    !Array.isArray(value.attachedPointTracks) || !isNullableBoolean(value.attachedPointTracksExpanded) ||
    !isNullableBoolean(value.snapToWaveformKeypoints) ||
    !isNullableBoolean(value.autoSetLoopRangeOnSelect)) return null;
  const attachedPointTracks = value.attachedPointTracks.map(parseAttachedPointTrackSnapshot);
  if (attachedPointTracks.some((track) => !track) ||
    hasDuplicateIds(attachedPointTracks as AttachedPointTrackSnapshot[])) return null;
  return {
    id: value.id,
    name: value.name,
    trackType: value.trackType,
    options: value.options === null ? null : [...value.options] as string[],
    attachedPointTracks: attachedPointTracks as AttachedPointTrackSnapshot[],
    attachedPointTracksExpanded: value.attachedPointTracksExpanded,
    snapToWaveformKeypoints: value.snapToWaveformKeypoints,
    autoSetLoopRangeOnSelect: value.autoSetLoopRangeOnSelect,
  };
}

function parseAttachedPointTrackSnapshot(value: unknown): AttachedPointTrackSnapshot | null {
  if (!isExactRecord(value, [
    "id", "name", "typeOptions", "points", "snapToWaveformKeypoints", "snapToParentBoundaries",
    "autoSetLoopRangeOnSelect",
  ]) || !isSafeId(value.id) || typeof value.name !== "string" || value.name.length > MAX_TEXT_LENGTH ||
    !Array.isArray(value.typeOptions) || value.typeOptions.length > MAX_STRUCTURE_ENTITIES ||
    value.typeOptions.some((option) => typeof option !== "string" || option.length > MAX_TEXT_LENGTH) ||
    !Array.isArray(value.points) || !isNullableBoolean(value.snapToWaveformKeypoints) ||
    !isNullableBoolean(value.snapToParentBoundaries) || !isNullableBoolean(value.autoSetLoopRangeOnSelect)) return null;
  const points = value.points.map(parsePointSnapshot);
  if (points.some((point) => !point) || hasDuplicateIds(points as AttachedPointTrackPointSnapshot[])) return null;
  return {
    id: value.id,
    name: value.name,
    typeOptions: [...value.typeOptions] as string[],
    points: points as AttachedPointTrackPointSnapshot[],
    snapToWaveformKeypoints: value.snapToWaveformKeypoints,
    snapToParentBoundaries: value.snapToParentBoundaries,
    autoSetLoopRangeOnSelect: value.autoSetLoopRangeOnSelect,
  };
}

function parseOwnedBlockSnapshot(value: unknown): CustomTrackOwnedBlockSnapshot | null {
  if (!isExactRecord(value, ["id", "startTime", "endTime", "text", "type"]) || !isSafeId(value.id) ||
    !isNonNegativeFiniteNumber(value.startTime) || !isNonNegativeFiniteNumber(value.endTime) ||
    value.endTime < value.startTime ||
    (value.text !== null && (typeof value.text !== "string" || value.text.length > MAX_TEXT_LENGTH)) ||
    typeof value.type !== "string" || value.type.length > MAX_TEXT_LENGTH) return null;
  return {
    id: value.id,
    startTime: value.startTime,
    endTime: value.endTime,
    text: value.text,
    type: value.type,
  };
}

function parsePointSnapshot(value: unknown): AttachedPointTrackPointSnapshot | null {
  if (!isExactRecord(value, ["id", "time", "label"]) || !isSafeId(value.id) ||
    !isNonNegativeFiniteNumber(value.time) || typeof value.label !== "string" ||
    value.label.length > MAX_TEXT_LENGTH) return null;
  return { id: value.id, time: value.time, label: value.label };
}

// 位置同时校验索引、集合长度和相邻锚点，inverse 才能恢复而不是粗略 append。
function parseCollectionPosition(value: unknown): TrackStructureCollectionPosition | null {
  if (!isExactRecord(value, ["index", "collectionLength", "previousEntityId", "nextEntityId"]) ||
    !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.collectionLength) ||
    (value.index as number) < 0 || (value.collectionLength as number) <= 0 ||
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

function hasDuplicateIds(items: readonly { id: string }[]) {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareIds(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}
