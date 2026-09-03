import { createHash } from "node:crypto";
import {
  validateBanyanGongcheReferences,
  validateProjectAnnotationReferences,
  validateTrackContainerIntegrity,
  type ProjectData,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import { getPersistableProjectData, normalizeImportedProjectFile } from "../src/utils/projectFile.js";
import { prepareProjectForServer } from "../src/platform/platformProjectPayload.js";

export const PLATFORM_V0902_MERGE_PLAN_VERSION = 2;
export const PLATFORM_V0902_MERGE_STATE_VERSION = 2;
export const MAX_PLATFORM_V0902_SCAN_RESOURCES = 20_000;
export const MAX_REPORTED_MERGE_PATHS = 200;
export const PLATFORM_GONGCHE_CHANGED_SKIP_REASON =
  "平台工尺标注相对原始 v0901 已修改；按保守策略整折跳过。";

const MISSING = Symbol("missing");
type Missing = typeof MISSING;

export type MergeDecisionKind =
  | "platform"
  | "incoming"
  | "unchanged";

export type MergeDecisionSummary = {
  platform: number;
  incoming: number;
  unchanged: number;
  platformPaths: string[];
  incomingPaths: string[];
  truncatedPlatformPathCount: number;
  truncatedIncomingPathCount: number;
};

export type PlatformFirstMergeResult =
  | {
      ok: true;
      project: ProjectData;
      decisions: MergeDecisionSummary;
    }
  | {
      ok: false;
      disposition: "blocked" | "skipped";
      issues: string[];
      decisions: MergeDecisionSummary;
    };

export type PlatformV0902MergePlanRow = {
  resourceId: string;
  parentId: string;
  platformPath: string;
  currentName: string;
  targetName: string;
  sourceRelativePath: string;
  currentRevision: number;
  mediaResourceId: string | null;
  baseSnapshotId: string;
  baseHash: string;
  currentHash: string;
  incomingHash: string;
  mergedHash: string | null;
  action: "save_and_rename" | "rename_only" | "skipped" | "blocked";
  skipReason: string | null;
  decisions: MergeDecisionSummary | null;
  blockers: string[];
};

export type PlatformV0902MergePlan = {
  version: typeof PLATFORM_V0902_MERGE_PLAN_VERSION;
  generatedAt: string;
  baseUrl: string;
  sourceDirectory: string;
  rows: PlatformV0902MergePlanRow[];
  summary: {
    modifiedV0901Count: number;
    readyCount: number;
    saveCount: number;
    renameOnlyCount: number;
    skippedCount: number;
    blockedCount: number;
    unusedLocalJsonCount: number;
  };
  fingerprint: string;
};

export type PlatformV0902MergeStateRow = {
  resourceId: string;
  operationId: string;
  status: "pending" | "saved_pending_rename" | "completed";
  expectedBaseRevision: number;
  committedRevision?: number;
  mergedHash: string;
  targetName: string;
  completedAt?: string;
};

export type PlatformV0902MergeState = {
  version: typeof PLATFORM_V0902_MERGE_STATE_VERSION;
  planFingerprint: string;
  rows: Record<string, PlatformV0902MergeStateRow>;
};

export type PlatformV0902CurrentFileFacts = {
  name: string;
  parentId: string | null;
  mediaResourceId: string | null;
  revision: number;
  projectHash: string;
  committedRevisionProjectHash?: string;
};

type MutableDecisionSummary = {
  platform: number;
  incoming: number;
  unchanged: number;
  platformPaths: string[];
  incomingPaths: string[];
  truncatedPlatformPathCount: number;
  truncatedIncomingPathCount: number;
};

type MergeContext = {
  decisions: MutableDecisionSummary;
  issues: string[];
};

export function normalizePlatformProjectPayload(value: unknown): ProjectData {
  let candidate: unknown = value;
  let previous: ProjectData | null = null;
  // v2 的内建动作轨会在第一轮迁移成自定义轨，第二轮才补齐当前自定义轨默认字段。
  // 运维哈希必须取迁移固定点，否则同一正文重复读取会产生不同 fingerprint。
  for (let pass = 0; pass < 4; pass += 1) {
    const normalized = prepareProjectForServer(getPersistableProjectData(
      normalizeImportedProjectFile(candidate).project,
    ));
    if (previous && stableStringify(normalized) === stableStringify(previous)) return normalized;
    previous = normalized;
    candidate = normalized;
  }
  throw new Error("项目 JSON 在 4 次迁移后仍未达到稳定格式。");
}

/**
 * 三方优先级固定为 platform > incoming(v0902) > base(v0901)。
 * 平台相对 base 改过的最小字段保留平台值；其余字段采用 incoming。
 */
export function mergeProjectPlatformFirst(input: {
  base: unknown;
  platform: unknown;
  incoming: unknown;
}): PlatformFirstMergeResult {
  let base: ProjectData;
  let platform: ProjectData;
  try {
    base = normalizePlatformProjectPayload(input.base);
    platform = normalizePlatformProjectPayload(input.platform);
  } catch (error) {
    return {
      ok: false,
      disposition: "blocked",
      issues: [error instanceof Error ? error.message : "项目 JSON 无法规范化。"],
      decisions: emptyDecisionSummary(),
    };
  }

  // 工尺跳过只依赖服务器的 base/current 两方事实。本地 v0902 即使缺失或损坏，
  // 也不能把本应留在原处的折目升级成阻断整批的合并错误。
  if (hasPlatformGongcheChanges(base, platform)) {
    return {
      ok: false,
      disposition: "skipped",
      issues: [PLATFORM_GONGCHE_CHANGED_SKIP_REASON],
      decisions: emptyDecisionSummary(),
    };
  }

  let incoming: ProjectData;
  try {
    incoming = normalizePlatformProjectPayload(input.incoming);
  } catch (error) {
    return {
      ok: false,
      disposition: "blocked",
      issues: [error instanceof Error ? error.message : "项目 JSON 无法规范化。"],
      decisions: emptyDecisionSummary(),
    };
  }

  const duplicateIssues = [
    ...findDuplicateStableIds(base, "base"),
    ...findDuplicateStableIds(platform, "platform"),
    ...findDuplicateStableIds(incoming, "incoming"),
  ];
  if (duplicateIssues.length > 0) {
    return {
      ok: false,
      disposition: "blocked",
      issues: duplicateIssues,
      decisions: emptyDecisionSummary(),
    };
  }

  const decisions = emptyDecisionSummary();
  const issues: string[] = [];
  const mergedValue = mergeValue(base, platform, incoming, [], { decisions, issues });
  if (issues.length > 0) {
    return { ok: false, disposition: "blocked", issues: [...new Set(issues)], decisions };
  }
  if (mergedValue === MISSING || !isRecord(mergedValue)) {
    return {
      ok: false,
      disposition: "blocked",
      issues: ["三方合并没有生成项目对象。"],
      decisions,
    };
  }

  // 媒体正文与数据库媒体外键属于平台上下文，不能由离线 JSON 改写。
  mergedValue.video = cloneValue(platform.video);
  const parsed = parseCurrentProjectData(mergedValue);
  if (!parsed.success) {
    return {
      ok: false,
      disposition: "blocked",
      issues: parsed.issues.slice(0, 100).map((issue) =>
        `${jsonPointer(issue.path)}：${issue.message}`),
      decisions,
    };
  }
  const project = parsed.data;
  const referenceIssues = findProjectIntegrityIssues(project);
  if (!validateProjectAnnotationReferences(project) &&
    !referenceIssues.some((issue) => issue.startsWith("标注引用："))) {
    referenceIssues.push("标注引用：存在未分类的重复 ID 或悬空引用。");
  }
  if (!validateTrackContainerIntegrity(project) &&
    !referenceIssues.some((issue) => issue.startsWith("轨道容器："))) {
    referenceIssues.push("轨道容器：附属点轨或活动轨道顺序不完整。");
  }
  if (!validateBanyanGongcheReferences(project) &&
    !referenceIssues.some((issue) => issue.startsWith("板眼引用："))) {
    referenceIssues.push("板眼引用：存在未分类的重复 ID 或悬空引用。");
  }
  if (referenceIssues.length > 0) {
    return {
      ok: false,
      disposition: "blocked",
      issues: [...new Set(referenceIssues)],
      decisions,
    };
  }
  return { ok: true, project, decisions };
}

export function hasPlatformGongcheChanges(base: ProjectData, platform: ProjectData) {
  return !valuesEqual(platform.gongcheAnnotations, base.gongcheAnnotations);
}

export function findProjectIntegrityIssues(project: ProjectData): string[] {
  const issues: string[] = [];
  const duplicates = (ids: string[]) =>
    [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  const reportDuplicates = (prefix: string, ids: string[], category = "标注引用") => {
    const found = duplicates(ids);
    if (found.length > 0) issues.push(`${category}：${prefix} 存在重复 ID：${found.join("、")}`);
  };

  reportDuplicates("角色选项", project.sentenceAnnotationConfig.roleOptions);
  const validRoles = new Set(project.sentenceAnnotationConfig.roleOptions);
  for (const line of project.subtitleLines) {
    reportDuplicates(`句 ${line.id} 的角色`, line.roleTypes);
    const invalidRoles = line.roleTypes.filter((role) => !validRoles.has(role));
    if (invalidRoles.length > 0) {
      issues.push(`标注引用：句 ${line.id} 引用不存在的角色：${invalidRoles.join("、")}`);
    }
    const canonical = project.sentenceAnnotationConfig.roleOptions.filter((role) => line.roleTypes.includes(role));
    if (!arraysEqual(canonical, line.roleTypes)) issues.push(`标注引用：句 ${line.id} 的角色顺序非规范。`);
  }

  reportDuplicates("字幕句", project.subtitleLines.map(({ id }) => id));
  reportDuplicates("字级标注", project.characterAnnotations.map(({ id }) => id));
  const lineIds = new Set(project.subtitleLines.map(({ id }) => id));
  for (const character of project.characterAnnotations) {
    if (!lineIds.has(character.lineId)) {
      issues.push(`标注引用：字 ${character.id} 引用不存在的句 ${character.lineId}。`);
    }
  }

  reportDuplicates("工尺块", project.gongcheAnnotations.map(({ id }) => id));
  const characterIds = new Set(project.characterAnnotations.map(({ id }) => id));
  const customTracks = new Map(project.customTracks.map((track) => [track.id, track]));
  for (const block of project.gongcheAnnotations) {
    reportDuplicates(`工尺块 ${block.id} 的符号`, block.symbols.map(({ id }) => id));
    const parentExists = block.parentTrackId === "character-track"
      ? characterIds.has(block.parentBlockId)
      : Boolean(customTracks.get(block.parentTrackId)?.blocks.some(({ id }) => id === block.parentBlockId));
    if (!parentExists) {
      issues.push(
        `标注引用：工尺块 ${block.id} 引用不存在的父块 ` +
        `${block.parentTrackId}/${block.parentBlockId}。`,
      );
    }
  }

  const allTracks = [...project.builtinTracks, ...project.customTracks];
  const allTrackIds = allTracks.map(({ id }) => id);
  reportDuplicates("轨道", allTrackIds, "轨道容器");
  reportDuplicates("活动轨道顺序", project.activeTrackOrder, "轨道容器");
  if (project.activeTrackOrder.length !== allTrackIds.length) {
    issues.push(
      `轨道容器：活动轨道数量 ${project.activeTrackOrder.length} 与轨道数量 ${allTrackIds.length} 不同。`,
    );
  }
  for (const trackId of allTrackIds) {
    const count = project.activeTrackOrder.filter((id) => id === trackId).length;
    if (count !== 1) issues.push(`轨道容器：轨道 ${trackId} 在活动顺序中出现 ${count} 次。`);
  }
  reportDuplicates(
    "附属点轨",
    allTracks.flatMap((track) => track.attachedPointTracks.map(({ id }) => id)),
    "轨道容器",
  );
  for (const track of allTracks) {
    for (const pointTrack of track.attachedPointTracks) {
      reportDuplicates(
        `点轨 ${pointTrack.id} 的点`,
        pointTrack.points.map(({ id }) => id),
        "轨道容器",
      );
    }
    if ("blocks" in track) {
      reportDuplicates(`轨道 ${track.id} 的块`, track.blocks.map(({ id }) => id), "轨道容器");
    }
  }

  reportDuplicates("板眼段", project.banyanSections.map(({ id }) => id), "板眼引用");
  reportDuplicates("板眼点", project.banyanMarks.map(({ id }) => id), "板眼引用");
  const sectionIds = new Set(project.banyanSections.map(({ id }) => id));
  const gongcheSymbols = new Map(project.gongcheAnnotations.map((block) => [
    block.id,
    new Set(block.symbols.map(({ id }) => id)),
  ]));
  for (const mark of project.banyanMarks) {
    if (mark.sectionId && !sectionIds.has(mark.sectionId)) {
      issues.push(`板眼引用：板眼点 ${mark.id} 引用不存在的段 ${mark.sectionId}。`);
    }
    if (!mark.linkedGongcheAnnotationId) {
      if (mark.linkedGongcheSymbolId || (mark.linkedGongcheSymbolIds?.length ?? 0) > 0) {
        issues.push(`板眼引用：板眼点 ${mark.id} 有符号引用但没有工尺块引用。`);
      }
      continue;
    }
    const symbolIds = gongcheSymbols.get(mark.linkedGongcheAnnotationId);
    if (!symbolIds) {
      issues.push(
        `板眼引用：板眼点 ${mark.id} 引用不存在的工尺块 ${mark.linkedGongcheAnnotationId}。`,
      );
      continue;
    }
    const linkedIds = [
      ...(mark.linkedGongcheSymbolId ? [mark.linkedGongcheSymbolId] : []),
      ...(mark.linkedGongcheSymbolIds ?? []),
    ];
    const missing = linkedIds.filter((id) => !symbolIds.has(id));
    if (missing.length > 0) {
      issues.push(`板眼引用：板眼点 ${mark.id} 引用不存在的工尺符号：${missing.join("、")}`);
    }
  }
  return [...new Set(issues)];
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

export function buildPlatformV0902PlanFingerprint(
  plan: Omit<PlatformV0902MergePlan, "fingerprint">,
): string {
  return hashJson(plan);
}

export function parsePlatformV0902MergePlan(value: unknown): PlatformV0902MergePlan {
  if (!isRecord(value) || value.version !== PLATFORM_V0902_MERGE_PLAN_VERSION ||
    typeof value.generatedAt !== "string" || typeof value.baseUrl !== "string" ||
    typeof value.sourceDirectory !== "string" || !Array.isArray(value.rows) ||
    !isRecord(value.summary) || typeof value.fingerprint !== "string") {
    throw new Error("计划文件格式无效。");
  }
  const plan = value as unknown as PlatformV0902MergePlan;
  const { fingerprint, ...unsigned } = plan;
  if (buildPlatformV0902PlanFingerprint(unsigned) !== fingerprint) {
    throw new Error("计划文件 fingerprint 校验失败。");
  }
  return plan;
}

export function parsePlatformV0902MergeState(
  value: unknown,
  plan: PlatformV0902MergePlan,
): PlatformV0902MergeState {
  if (!isRecord(value) || value.version !== PLATFORM_V0902_MERGE_STATE_VERSION ||
    value.planFingerprint !== plan.fingerprint || !isRecord(value.rows) ||
    !hasExactKeys(value, ["version", "planFingerprint", "rows"])) {
    throw new Error("状态文件格式无效或不属于当前计划。");
  }
  const plannedRows = plan.rows.filter(({ action }) =>
    action === "save_and_rename" || action === "rename_only");
  const plannedById = new Map(plannedRows.map((row) => [row.resourceId, row]));
  if (plannedById.size !== plannedRows.length) throw new Error("计划包含重复资源 ID。");
  const stateResourceIds = Object.keys(value.rows).sort();
  const plannedResourceIds = [...plannedById.keys()].sort();
  if (!arraysEqual(stateResourceIds, plannedResourceIds)) {
    throw new Error("状态文件资源集合与计划不一致。");
  }

  const rows: Record<string, PlatformV0902MergeStateRow> = {};
  for (const resourceId of plannedResourceIds) {
    const planned = plannedById.get(resourceId)!;
    const candidate = value.rows[resourceId];
    if (!isRecord(candidate) || candidate.resourceId !== resourceId ||
      candidate.expectedBaseRevision !== planned.currentRevision ||
      candidate.mergedHash !== planned.mergedHash || candidate.targetName !== planned.targetName ||
      typeof candidate.operationId !== "string" || !isUuid(candidate.operationId) ||
      (candidate.status !== "pending" && candidate.status !== "saved_pending_rename" &&
        candidate.status !== "completed")) {
      throw new Error(`状态文件资源 ${resourceId} 与计划不一致。`);
    }
    const expectedCommittedRevision = planned.currentRevision +
      (planned.action === "save_and_rename" ? 1 : 0);
    if (candidate.status === "pending") {
      if (!hasExactKeys(candidate, [
        "resourceId", "operationId", "status", "expectedBaseRevision", "mergedHash", "targetName",
      ])) throw new Error(`状态文件资源 ${resourceId} 的 pending 字段无效。`);
    } else if (candidate.status === "saved_pending_rename") {
      if (planned.action !== "save_and_rename" ||
        candidate.committedRevision !== expectedCommittedRevision ||
        !hasExactKeys(candidate, [
          "resourceId", "operationId", "status", "expectedBaseRevision", "committedRevision",
          "mergedHash", "targetName",
        ])) {
        throw new Error(`状态文件资源 ${resourceId} 的 saved_pending_rename 字段无效。`);
      }
    } else if (candidate.committedRevision !== expectedCommittedRevision ||
      typeof candidate.completedAt !== "string" || !isIsoTimestamp(candidate.completedAt) ||
      !hasExactKeys(candidate, [
        "resourceId", "operationId", "status", "expectedBaseRevision", "committedRevision",
        "mergedHash", "targetName", "completedAt",
      ])) {
      throw new Error(`状态文件资源 ${resourceId} 的 completed 字段无效。`);
    }
    rows[resourceId] = candidate as unknown as PlatformV0902MergeStateRow;
  }
  return {
    version: PLATFORM_V0902_MERGE_STATE_VERSION,
    planFingerprint: plan.fingerprint,
    rows,
  };
}

export function findCompletedPlatformV0902StateIssues(
  planRow: PlatformV0902MergePlanRow,
  stateRow: PlatformV0902MergeStateRow,
  current: PlatformV0902CurrentFileFacts,
): string[] {
  const issues: string[] = [];
  if (stateRow.status !== "completed" || stateRow.committedRevision === undefined) {
    return ["状态文件未完成"];
  }
  if (current.name !== planRow.targetName) issues.push("名称不是目标 v0902");
  if (current.parentId !== planRow.parentId) issues.push("父级发生变化");
  if (current.mediaResourceId !== planRow.mediaResourceId) issues.push("媒体绑定发生变化");
  if (current.revision < stateRow.committedRevision) issues.push("当前 revision 低于已提交 revision");
  if (current.revision === stateRow.committedRevision && current.projectHash !== planRow.mergedHash) {
    issues.push("提交 revision 的正文哈希不一致");
  }
  if (current.revision > stateRow.committedRevision &&
    current.committedRevisionProjectHash !== planRow.mergedHash) {
    issues.push("无法证明已提交 revision 的正文等于计划合并结果");
  }
  return issues;
}

export function findSkippedPlatformV0902StateIssues(
  planRow: PlatformV0902MergePlanRow,
  current: PlatformV0902CurrentFileFacts,
): string[] {
  const issues: string[] = [];
  if (planRow.action !== "skipped") return ["计划行不是 skipped"];
  if (current.name !== planRow.currentName) issues.push("跳过文件名称发生变化");
  if (current.parentId !== planRow.parentId) issues.push("跳过文件父级发生变化");
  if (current.mediaResourceId !== planRow.mediaResourceId) issues.push("跳过文件媒体绑定发生变化");
  if (current.revision !== planRow.currentRevision) issues.push("跳过文件 revision 发生变化");
  if (current.projectHash !== planRow.currentHash) issues.push("跳过文件正文哈希发生变化");
  return issues;
}

function mergeValue(
  base: unknown | Missing,
  platform: unknown | Missing,
  incoming: unknown | Missing,
  path: Array<string | number>,
  context: MergeContext,
): unknown | Missing {
  const { decisions } = context;
  if (valuesEqual(platform, base)) {
    if (valuesEqual(incoming, base)) recordDecision(decisions, "unchanged", path);
    else recordDecision(decisions, "incoming", path);
    return cloneMaybeMissing(incoming);
  }
  if (valuesEqual(incoming, base) || valuesEqual(platform, incoming)) {
    recordDecision(decisions, "platform", path);
    return cloneMaybeMissing(platform);
  }
  if (platform === MISSING) {
    recordDecision(decisions, "platform", path);
    return MISSING;
  }
  if (incoming === MISSING) {
    recordDecision(decisions, "platform", path);
    return cloneValue(platform);
  }
  if (base === MISSING) {
    recordDecision(decisions, "platform", path);
    return cloneValue(platform);
  }

  if (isRecord(base) && isRecord(platform) && isRecord(incoming)) {
    const discriminatorConflict = findDiscriminatorConflict(base, platform, incoming);
    if (discriminatorConflict) {
      context.issues.push(
        `${jsonPointer([...path, discriminatorConflict])}：平台与 v0902 在不同对象结构上同时有修改，` +
        "无法在不丢失字段的前提下自动合并。",
      );
      return cloneValue(platform);
    }
    const platformChangedTimeRange = hasTimeRange(base) && hasTimeRange(platform) &&
      (!valuesEqual(platform.startTime, base.startTime) ||
        !valuesEqual(platform.endTime, base.endTime));
    const result: Record<string, unknown> = {};
    const keys = [...new Set([
      ...Object.keys(base),
      ...Object.keys(platform),
      ...Object.keys(incoming),
    ])].sort();
    for (const key of keys) {
      // start/end 是一个不可拆分的时间区间。平台改过任意一端时，两端都保留平台当前值，
      // 避免将平台 start 与 v0902 end（或反过来）拼成一个从未存在过、甚至倒置的区间。
      if (platformChangedTimeRange && (key === "startTime" || key === "endTime")) {
        recordDecision(decisions, "platform", [...path, key]);
        result[key] = cloneValue(platform[key]);
        continue;
      }
      const merged = mergeValue(
        hasOwn(base, key) ? base[key] : MISSING,
        hasOwn(platform, key) ? platform[key] : MISSING,
        hasOwn(incoming, key) ? incoming[key] : MISSING,
        [...path, key],
        context,
      );
      if (merged !== MISSING) result[key] = merged;
    }
    return result;
  }

  if (Array.isArray(base) && Array.isArray(platform) && Array.isArray(incoming) &&
    isStableIdCollection(base, platform, incoming)) {
    return mergeStableIdCollection(base, platform, incoming, path, context);
  }

  // 普通数组和无法递归的标量都视为一个字段；双方都改动时平台胜出。
  recordDecision(decisions, "platform", path);
  return cloneValue(platform);
}

function hasTimeRange(value: Record<string, unknown>): value is Record<string, unknown> & {
  startTime: number;
  endTime: number;
} {
  return typeof value.startTime === "number" && typeof value.endTime === "number";
}

function mergeStableIdCollection(
  base: Array<Record<string, unknown>>,
  platform: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
  path: Array<string | number>,
  context: MergeContext,
): unknown[] {
  if (isTopLevelCharacterCollection(path) &&
    base.length > 0 && platform.length > 0 && platform.length !== base.length &&
    countSharedIds(base, platform) === 0) {
    // 平台已将整个字级集合重建（ID 全变且字数改变）时，它不再是可与 v0901
    // 逐字对应的局部修改。按明确的平台优先规则，整套字级结构和字段均保留平台。
    recordDecision(context.decisions, "platform", [...path, "{platform-rebuilt-collection}"]);
    return cloneValue(platform);
  }
  const platformAlignment = alignCollectionToBase(base, platform, path, "platform", context);
  const incomingAlignment = alignCollectionToBase(base, incoming, path, "v0902", context);
  if (!platformAlignment || !incomingAlignment) return [];

  const mergedBaseSlots = new Map<number, unknown>();
  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    const platformIndex = platformAlignment.baseToSide.get(baseIndex);
    const incomingIndex = incomingAlignment.baseToSide.get(baseIndex);
    const baseItem = base[baseIndex]!;
    const value = mergeValue(
      baseItem,
      platformIndex === undefined ? MISSING : platform[platformIndex]!,
      incomingIndex === undefined ? MISSING : incoming[incomingIndex]!,
      [...path, collectionItemPath(baseItem, baseIndex)],
      context,
    );
    if (value !== MISSING) mergedBaseSlots.set(baseIndex, value);
  }

  const additions = mergeCollectionAdditions(
    platform,
    incoming,
    platformAlignment.unmatchedSide,
    incomingAlignment.unmatchedSide,
    path,
    context,
  );
  const platformStructureChanged = collectionStructureChanged(base, platformAlignment);
  const primaryAlignment = platformStructureChanged ? platformAlignment : incomingAlignment;
  const secondaryAlignment = platformStructureChanged ? incomingAlignment : platformAlignment;
  const result: unknown[] = [];
  const emittedBase = new Set<number>();
  const emittedAddition = new Set<string>();

  const emitFromAlignment = (alignment: CollectionAlignment) => {
    for (const sideIndex of alignment.sideOrder) {
      const baseIndex = alignment.sideToBase.get(sideIndex);
      if (baseIndex !== undefined) {
        if (!emittedBase.has(baseIndex) && mergedBaseSlots.has(baseIndex)) {
          result.push(mergedBaseSlots.get(baseIndex));
          emittedBase.add(baseIndex);
        }
        continue;
      }
      const additionKey = alignment.side === "platform"
        ? `platform:${sideIndex}`
        : `v0902:${sideIndex}`;
      const canonicalKey = additions.aliases.get(additionKey) ?? additionKey;
      if (!emittedAddition.has(canonicalKey) && additions.values.has(canonicalKey)) {
        result.push(additions.values.get(canonicalKey));
        emittedAddition.add(canonicalKey);
      }
    }
  };
  emitFromAlignment(primaryAlignment);
  emitFromAlignment(secondaryAlignment);
  for (const baseIndex of [...mergedBaseSlots.keys()].sort((left, right) => left - right)) {
    if (!emittedBase.has(baseIndex)) result.push(mergedBaseSlots.get(baseIndex));
  }
  for (const [key, value] of additions.values) {
    if (!emittedAddition.has(key)) result.push(value);
  }
  return result;
}

function isTopLevelCharacterCollection(path: Array<string | number>) {
  return path.length === 1 && path[0] === "characterAnnotations";
}

function countSharedIds(
  left: Array<Record<string, unknown>>,
  right: Array<Record<string, unknown>>,
) {
  const leftIds = new Set(left.map(({ id }) => String(id)));
  return right.filter(({ id }) => leftIds.has(String(id))).length;
}

type CollectionSide = "platform" | "v0902";

type CollectionAlignment = {
  side: CollectionSide;
  baseToSide: Map<number, number>;
  sideToBase: Map<number, number>;
  unmatchedSide: number[];
  sideOrder: number[];
};

function alignCollectionToBase(
  base: Array<Record<string, unknown>>,
  sideItems: Array<Record<string, unknown>>,
  path: Array<string | number>,
  side: CollectionSide,
  context: MergeContext,
): CollectionAlignment | null {
  const baseById = new Map(base.map((item, index) => [String(item.id), index]));
  const sideById = new Map(sideItems.map((item, index) => [String(item.id), index]));
  const baseToSide = new Map<number, number>();
  const sideToBase = new Map<number, number>();
  for (const [id, baseIndex] of baseById) {
    const sideIndex = sideById.get(id);
    if (sideIndex === undefined) continue;
    baseToSide.set(baseIndex, sideIndex);
    sideToBase.set(sideIndex, baseIndex);
  }

  const unmatchedBase = base.map((_, index) => index).filter((index) => !baseToSide.has(index));
  const unmatchedSide = sideItems.map((_, index) => index).filter((index) => !sideToBase.has(index));
  if (unmatchedBase.length > 0 && unmatchedSide.length > 0) {
    const baseTimed = unmatchedBase.every((index) => getTimelineKey(base[index]!) !== null);
    const sideTimed = unmatchedSide.every((index) => getTimelineKey(sideItems[index]!) !== null);
    if (!baseTimed || !sideTimed) {
      // 非时间线结构只能依赖稳定 ID，不用数组位置猜测轨道、分支等身份。
      if (baseToSide.size === 0 && base.length === sideItems.length) {
        context.issues.push(
          `${jsonPointer(path)}：${side} 的非时间线元素 ID 全部变化，无法无歧义对应。`,
        );
        return null;
      }
    } else if (unmatchedBase.length === unmatchedSide.length) {
      const baseGroups = groupTimelineIndexesByScope(base, unmatchedBase);
      const sideGroups = groupTimelineIndexesByScope(sideItems, unmatchedSide);
      const scopes = new Set([...baseGroups.keys(), ...sideGroups.keys()]);
      for (const scope of scopes) {
        const baseGroup = baseGroups.get(scope) ?? [];
        const sideGroup = sideGroups.get(scope) ?? [];
        if (baseGroup.length !== sideGroup.length) {
          context.issues.push(
            `${jsonPointer(path)}：${side} 在父级 ${scope} 下的时间线元素数量与 v0901 不同` +
            `（${sideGroup.length} / ${baseGroup.length}），ID 变化后无法无歧义对应。`,
          );
          return null;
        }
        const sortedBase = sortTimelineIndexes(base, baseGroup, path, `v0901:${scope}`, context);
        const sortedSide = sortTimelineIndexes(sideItems, sideGroup, path, `${side}:${scope}`, context);
        if (!sortedBase || !sortedSide) return null;
        for (let ordinal = 0; ordinal < sortedBase.length; ordinal += 1) {
          const baseIndex = sortedBase[ordinal]!;
          const sideIndex = sortedSide[ordinal]!;
          baseToSide.set(baseIndex, sideIndex);
          sideToBase.set(sideIndex, baseIndex);
        }
      }
    } else if (baseToSide.size === 0) {
      context.issues.push(
        `${jsonPointer(path)}：${side} 与 v0901 的时间线元素 ID 无交集且数量不同` +
        `（${sideItems.length} / ${base.length}），无法无歧义对应。`,
      );
      return null;
    }
  }

  return {
    side,
    baseToSide,
    sideToBase,
    unmatchedSide: sideItems.map((_, index) => index).filter((index) => !sideToBase.has(index)),
    sideOrder: sideItems.map((_, index) => index),
  };
}

function mergeCollectionAdditions(
  platform: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
  platformIndexes: number[],
  incomingIndexes: number[],
  path: Array<string | number>,
  context: MergeContext,
) {
  const values = new Map<string, unknown>();
  const aliases = new Map<string, string>();
  const incomingById = new Map(incomingIndexes.map((index) => [String(incoming[index]!.id), index]));
  const matchedIncoming = new Set<number>();
  for (const platformIndex of platformIndexes) {
    const platformItem = platform[platformIndex]!;
    const incomingIndex = incomingById.get(String(platformItem.id));
    const key = `platform:${platformIndex}`;
    aliases.set(key, key);
    if (incomingIndex === undefined) {
      recordDecision(context.decisions, "platform", [...path, `{new-platform-id=${String(platformItem.id)}}`]);
      values.set(key, cloneValue(platformItem));
      continue;
    }
    // base 不存在的同 ID 新元素无法再做字段级归因，按平台优先整体取平台。
    recordDecision(context.decisions, "platform", [...path, `{new-id=${String(platformItem.id)}}`]);
    values.set(key, cloneValue(platformItem));
    aliases.set(`v0902:${incomingIndex}`, key);
    matchedIncoming.add(incomingIndex);
  }
  for (const incomingIndex of incomingIndexes) {
    if (matchedIncoming.has(incomingIndex)) continue;
    const incomingItem = incoming[incomingIndex]!;
    const key = `v0902:${incomingIndex}`;
    aliases.set(key, key);
    recordDecision(context.decisions, "incoming", [...path, `{new-v0902-id=${String(incomingItem.id)}}`]);
    values.set(key, cloneValue(incomingItem));
  }
  return { values, aliases };
}

function collectionStructureChanged(
  base: Array<Record<string, unknown>>,
  alignment: CollectionAlignment,
) {
  if (alignment.unmatchedSide.length > 0 || alignment.baseToSide.size !== base.length) return true;
  const mappedOrder = alignment.sideOrder.map((index) => alignment.sideToBase.get(index));
  return mappedOrder.some((baseIndex, index) => baseIndex !== index);
}

function sortTimelineIndexes(
  items: Array<Record<string, unknown>>,
  indexes: number[],
  path: Array<string | number>,
  side: string,
  context: MergeContext,
): number[] | null {
  const keyed = indexes.map((index) => ({ index, key: getTimelineKey(items[index]!)! }));
  const duplicate = keyed.find(({ key }, index) =>
    keyed.findIndex((candidate) => arraysEqual(candidate.key, key)) !== index);
  if (duplicate) {
    context.issues.push(
      `${jsonPointer(path)}：${side} 存在完全相同的时间位置 ${duplicate.key.join("/")}，` +
      "ID 变化后无法无歧义按时间线对应。",
    );
    return null;
  }
  return keyed.sort((left, right) => compareNumberArrays(left.key, right.key)).map(({ index }) => index);
}

function getTimelineKey(item: Record<string, unknown>): number[] | null {
  if (typeof item.startTime === "number" && typeof item.endTime === "number") {
    return [item.startTime, item.endTime];
  }
  if (typeof item.time === "number") return [item.time];
  return null;
}

function groupTimelineIndexesByScope(
  items: Array<Record<string, unknown>>,
  indexes: number[],
) {
  const groups = new Map<string, number[]>();
  for (const index of indexes) {
    const scope = timelineScopeKey(items[index]!);
    const group = groups.get(scope) ?? [];
    group.push(index);
    groups.set(scope, group);
  }
  return groups;
}

function timelineScopeKey(item: Record<string, unknown>): string {
  const entries = ["lineId", "trackId", "parentTrackId", "parentBlockId", "sectionId"]
    .filter((key) => hasOwn(item, key))
    .map((key) => [key, item[key]]);
  return entries.length === 0 ? "<collection>" : stableStringify(entries);
}

function compareNumberArrays(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function collectionItemPath(item: Record<string, unknown>, index: number) {
  return typeof item.id === "string" ? `{id=${item.id}}` : index;
}

function findDiscriminatorConflict(
  base: Record<string, unknown>,
  platform: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string | null {
  for (const key of ["trackType", "mode"] as const) {
    if (!hasOwn(base, key) && !hasOwn(platform, key) && !hasOwn(incoming, key)) continue;
    const platformChanged = !valuesEqual(platform[key], base[key]);
    const incomingChanged = !valuesEqual(incoming[key], base[key]);
    if ((platformChanged || incomingChanged) && !valuesEqual(platform[key], incoming[key])) return key;
  }
  return null;
}

function findDuplicateStableIds(project: ProjectData, side: string): string[] {
  const issues: string[] = [];
  const inspect = (items: unknown[], path: string) => {
    const ids = items.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length > 0) issues.push(`${side}:${path} 存在重复稳定 ID：${duplicates.join("、")}`);
  };
  inspect(project.subtitleLines, "subtitleLines");
  inspect(project.characterAnnotations, "characterAnnotations");
  inspect(project.gongcheAnnotations, "gongcheAnnotations");
  inspect(project.banyanSections, "banyanSections");
  inspect(project.banyanMarks, "banyanMarks");
  inspect(project.actionAnnotations, "actionAnnotations");
  inspect(project.builtinTracks, "builtinTracks");
  inspect(project.customTracks, "customTracks");
  for (const track of [...project.builtinTracks, ...project.customTracks]) {
    inspect(track.attachedPointTracks, `track:${track.id}:attachedPointTracks`);
    for (const pointTrack of track.attachedPointTracks) {
      inspect(pointTrack.points, `track:${track.id}:pointTrack:${pointTrack.id}:points`);
    }
    if ("blocks" in track) inspect(track.blocks, `track:${track.id}:blocks`);
  }
  for (const gongche of project.gongcheAnnotations) {
    inspect(gongche.symbols, `gongche:${gongche.id}:symbols`);
  }
  return issues;
}

function isStableIdCollection(...arrays: unknown[][]): arrays is Array<Array<Record<string, unknown>>> {
  const combined = arrays.flat();
  return combined.length > 0 && combined.every((item) =>
    isRecord(item) && typeof item.id === "string" && item.id.length > 0);
}

function recordDecision(
  summary: MutableDecisionSummary,
  kind: MergeDecisionKind,
  path: Array<string | number>,
) {
  summary[kind] += 1;
  if (kind === "unchanged") return;
  const key = kind === "platform" ? "platformPaths" : "incomingPaths";
  const truncatedKey = kind === "platform"
    ? "truncatedPlatformPathCount"
    : "truncatedIncomingPathCount";
  if (summary[key].length < MAX_REPORTED_MERGE_PATHS) summary[key].push(jsonPointer(path));
  else summary[truncatedKey] += 1;
}

function emptyDecisionSummary(): MutableDecisionSummary {
  return {
    platform: 0,
    incoming: 0,
    unchanged: 0,
    platformPaths: [],
    incomingPaths: [],
    truncatedPlatformPathCount: 0,
    truncatedIncomingPathCount: 0,
  };
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}

function jsonPointer(path: Array<string | number>): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}

function valuesEqual(left: unknown | Missing, right: unknown | Missing): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return stableStringify(left) === stableStringify(right);
}

function arraysEqual<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneMaybeMissing<T>(value: T | Missing): T | Missing {
  return value === MISSING ? MISSING : cloneValue(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  return arraysEqual(Object.keys(value).sort(), [...expected].sort());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isIsoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
