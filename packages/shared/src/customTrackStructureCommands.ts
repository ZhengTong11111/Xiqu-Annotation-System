export const CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND = "annotation.track.structure.update" as const;
export const MAX_CUSTOM_TRACK_BRANCH_DEPTH = 12;
const MAX_COMMAND_ITEMS = 500;
const MAX_TEXT_LENGTH = 2_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CustomTrackStructureBranchScope =
  | { mode: "root" }
  | { mode: "lanes"; laneIds: string[] };

export type CustomTrackStructureBranchLane = {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  children: CustomTrackStructureBranchLane[];
};

export type CustomTrackStructureBranching = {
  enabled: boolean;
  rootLabel: string | null;
  displayMode: "merged" | "expanded";
  lanes: CustomTrackStructureBranchLane[];
};

export type CustomTrackBlockStructureSnapshot = {
  id: string;
  branchScope: CustomTrackStructureBranchScope | null;
  branchGroupId: string | null;
  branchParentBlockId: string | null;
};

// 结构快照刻意不含块文本、类型、时间和附属点内容；这些字段有各自的内容/时间/生命周期合同。
export type CustomTrackStructureSnapshot = {
  id: string;
  trackType: "text" | "action";
  name: string;
  color: string | null;
  typeOptions: string[];
  attachedPointTracksExpanded: boolean | null;
  snapToWaveformKeypoints: boolean | null;
  autoSetLoopRangeOnSelect: boolean | null;
  branching: CustomTrackStructureBranching | null;
  blocks: CustomTrackBlockStructureSnapshot[];
};

export type CustomTrackStructureUpdateItem = {
  trackId: string;
  before: CustomTrackStructureSnapshot;
  after: CustomTrackStructureSnapshot;
};

export type CustomTrackStructureUpdateCommand = {
  type: typeof CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND;
  items: CustomTrackStructureUpdateItem[];
};

export type CustomTrackStructureCommandEnvelope = {
  version: 1;
  command: CustomTrackStructureUpdateCommand;
};

// builder 先切断调用方引用并稳定排序，再回送严格 parser；不允许构造出 parser 自己无法读取的命令。
export function buildCustomTrackStructureUpdateEnvelope(
  items: readonly CustomTrackStructureUpdateItem[],
): CustomTrackStructureCommandEnvelope | null {
  const changed = items
    .filter((item) => !areStructureValuesEqual(item.before, item.after))
    .map((item) => structuredClone(item))
    .sort((left, right) => compareStableIds(left.trackId, right.trackId));
  if (changed.length === 0) return null;
  return parseCustomTrackStructureCommandEnvelope({
    version: 1,
    command: { type: CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND, items: changed },
  });
}

// unknown 输入必须完整满足递归树、lane 引用和预算约束，不能依靠 ProjectData 导入归一化来修坏命令。
export function parseCustomTrackStructureCommandEnvelope(
  value: unknown,
): CustomTrackStructureCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "items"]) ||
    value.command.type !== CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND ||
    !Array.isArray(value.command.items) || value.command.items.length === 0) return null;

  const items: CustomTrackStructureUpdateItem[] = [];
  const trackIds = new Set<string>();
  let totalCost = 0;
  for (const rawItem of value.command.items) {
    const item = parseStructureItem(rawItem);
    if (!item || trackIds.has(item.trackId) || areStructureValuesEqual(item.before, item.after)) return null;
    trackIds.add(item.trackId);
    // before/after 表达同一批结构身份，预算按两侧较大值计一次，防止单侧异常膨胀绕过 500 项上限。
    totalCost += Math.max(
      getCustomTrackStructureSnapshotCost(item.before),
      getCustomTrackStructureSnapshotCost(item.after),
    );
    if (totalCost > MAX_COMMAND_ITEMS) return null;
    items.push(item);
  }
  return {
    version: 1,
    command: { type: CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND, items },
  };
}

export function invertCustomTrackStructureCommandEnvelope(
  value: unknown,
): CustomTrackStructureCommandEnvelope | null {
  const envelope = parseCustomTrackStructureCommandEnvelope(value);
  return envelope
    ? buildCustomTrackStructureUpdateEnvelope(envelope.command.items.map((item) => ({
        trackId: item.trackId,
        before: item.after,
        after: item.before,
      })))
    : null;
}

export function getCustomTrackStructureTargetKey(item: Pick<CustomTrackStructureUpdateItem, "trackId">) {
  return JSON.stringify([CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND, item.trackId]);
}

function parseStructureItem(value: unknown): CustomTrackStructureUpdateItem | null {
  if (!isExactRecord(value, ["trackId", "before", "after"]) || !isSafeId(value.trackId)) return null;
  const before = parseCustomTrackStructureSnapshot(value.before);
  const after = parseCustomTrackStructureSnapshot(value.after);
  if (!before || !after || before.id !== value.trackId || after.id !== value.trackId ||
    before.trackType !== after.trackType ||
    !haveSameStableIds(before.blocks, after.blocks)) return null;
  return { trackId: value.trackId, before, after };
}

export function parseCustomTrackStructureSnapshot(value: unknown): CustomTrackStructureSnapshot | null {
  if (!isExactRecord(value, [
    "id",
    "trackType",
    "name",
    "color",
    "typeOptions",
    "attachedPointTracksExpanded",
    "snapToWaveformKeypoints",
    "autoSetLoopRangeOnSelect",
    "branching",
    "blocks",
  ]) || !isSafeId(value.id) || (value.trackType !== "text" && value.trackType !== "action") ||
    typeof value.name !== "string" || value.name.length > MAX_TEXT_LENGTH ||
    !isNullableHexColor(value.color) || !Array.isArray(value.typeOptions) ||
    value.typeOptions.length > MAX_COMMAND_ITEMS ||
    value.typeOptions.some((option) => typeof option !== "string" || option.length > MAX_TEXT_LENGTH) ||
    !isNullableBoolean(value.attachedPointTracksExpanded) ||
    !isNullableBoolean(value.snapToWaveformKeypoints) ||
    !isNullableBoolean(value.autoSetLoopRangeOnSelect) || !Array.isArray(value.blocks)) return null;

  const branching = parseBranching(value.branching);
  if (value.branching !== null && !branching) return null;
  const laneIds = new Set<string>();
  if (branching && !collectLaneIds(branching.lanes, laneIds)) return null;

  const blocks = value.blocks.map((block) => parseBlockSnapshot(block, laneIds));
  if (blocks.some((block) => !block)) return null;
  const completeBlocks = blocks as CustomTrackBlockStructureSnapshot[];
  if (new Set(completeBlocks.map((block) => block.id)).size !== completeBlocks.length ||
    !isStrictlySorted(completeBlocks.map((block) => block.id))) return null;
  const blockIds = new Set(completeBlocks.map((block) => block.id));
  if (completeBlocks.some((block) => block.branchParentBlockId !== null &&
    (block.branchParentBlockId === block.id || !blockIds.has(block.branchParentBlockId))) ||
    hasBlockParentCycle(completeBlocks)) return null;

  return {
    id: value.id,
    trackType: value.trackType,
    name: value.name,
    color: value.color,
    typeOptions: [...value.typeOptions] as string[],
    attachedPointTracksExpanded: value.attachedPointTracksExpanded,
    snapToWaveformKeypoints: value.snapToWaveformKeypoints,
    autoSetLoopRangeOnSelect: value.autoSetLoopRangeOnSelect,
    branching,
    blocks: completeBlocks,
  };
}

function parseBranching(value: unknown): CustomTrackStructureBranching | null {
  if (value === null) return null;
  if (!isExactRecord(value, ["enabled", "rootLabel", "displayMode", "lanes"]) ||
    typeof value.enabled !== "boolean" ||
    (value.rootLabel !== null && (typeof value.rootLabel !== "string" || value.rootLabel.length > MAX_TEXT_LENGTH)) ||
    (value.displayMode !== "merged" && value.displayMode !== "expanded") ||
    !Array.isArray(value.lanes)) return null;
  const lanes = parseBranchLanes(value.lanes, null, 0);
  return lanes ? {
    enabled: value.enabled,
    rootLabel: value.rootLabel,
    displayMode: value.displayMode,
    lanes,
  } : null;
}

function parseBranchLanes(
  values: unknown[],
  parentId: string | null,
  depth: number,
): CustomTrackStructureBranchLane[] | null {
  if (depth > MAX_CUSTOM_TRACK_BRANCH_DEPTH || values.length > MAX_COMMAND_ITEMS) return null;
  const lanes: CustomTrackStructureBranchLane[] = [];
  for (const value of values) {
    if (!isExactRecord(value, ["id", "name", "parentId", "color", "children"]) ||
      !isSafeId(value.id) || typeof value.name !== "string" || value.name.length > MAX_TEXT_LENGTH ||
      value.parentId !== parentId || !isNullableHexColor(value.color) || !Array.isArray(value.children)) return null;
    const children = parseBranchLanes(value.children, value.id, depth + 1);
    if (!children) return null;
    lanes.push({ id: value.id, name: value.name, parentId, color: value.color, children });
  }
  return lanes;
}

function parseBlockSnapshot(
  value: unknown,
  laneIds: ReadonlySet<string>,
): CustomTrackBlockStructureSnapshot | null {
  if (!isExactRecord(value, ["id", "branchScope", "branchGroupId", "branchParentBlockId"]) ||
    !isSafeId(value.id) || (value.branchGroupId !== null && !isSafeId(value.branchGroupId)) ||
    (value.branchParentBlockId !== null && !isSafeId(value.branchParentBlockId))) return null;
  const branchScope = parseBranchScope(value.branchScope, laneIds);
  if (value.branchScope !== null && !branchScope) return null;
  return {
    id: value.id,
    branchScope,
    branchGroupId: value.branchGroupId,
    branchParentBlockId: value.branchParentBlockId,
  };
}

function parseBranchScope(
  value: unknown,
  laneIds: ReadonlySet<string>,
): CustomTrackStructureBranchScope | null {
  if (value === null) return null;
  if (isExactRecord(value, ["mode"]) && value.mode === "root") return { mode: "root" };
  if (!isExactRecord(value, ["mode", "laneIds"]) || value.mode !== "lanes" ||
    !Array.isArray(value.laneIds) || value.laneIds.length === 0) return null;
  const ids = value.laneIds.filter(isSafeId);
  if (ids.length !== value.laneIds.length || new Set(ids).size !== ids.length ||
    !isStrictlySorted(ids) || ids.some((id) => !laneIds.has(id))) return null;
  return { mode: "lanes", laneIds: [...ids] };
}

function hasBlockParentCycle(blocks: readonly CustomTrackBlockStructureSnapshot[]) {
  const parentById = new Map(blocks.map((block) => [block.id, block.branchParentBlockId]));
  for (const block of blocks) {
    const path = new Set<string>();
    let currentId: string | null = block.id;
    while (currentId !== null) {
      if (path.has(currentId)) return true;
      path.add(currentId);
      currentId = parentById.get(currentId) ?? null;
    }
  }
  return false;
}

function haveSameStableIds(
  left: readonly CustomTrackBlockStructureSnapshot[],
  right: readonly CustomTrackBlockStructureSnapshot[],
) {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

function collectLaneIds(lanes: readonly CustomTrackStructureBranchLane[], ids: Set<string>): boolean {
  for (const lane of lanes) {
    if (ids.has(lane.id)) return false;
    ids.add(lane.id);
    if (!collectLaneIds(lane.children, ids)) return false;
  }
  return true;
}

export function getCustomTrackStructureSnapshotCost(snapshot: CustomTrackStructureSnapshot) {
  return 1 + countLanes(snapshot.branching?.lanes ?? []) + snapshot.blocks.length;
}

function countLanes(lanes: readonly CustomTrackStructureBranchLane[]): number {
  return lanes.reduce((count, lane) => count + 1 + countLanes(lane.children), 0);
}

function areStructureValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStableIds(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isStrictlySorted(values: readonly string[]) {
  return values.every((value, index) => index === 0 || compareStableIds(values[index - 1], value) < 0);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isNullableHexColor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^#[0-9a-f]{6}$/.test(value));
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
