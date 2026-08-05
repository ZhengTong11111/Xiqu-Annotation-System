import type {
  AttachedPointTrack,
  CustomTrack,
  ProjectData,
} from "../types";
import type {
  AnnotationDiffDomain,
  AnnotationDiffEntry,
  AnnotationDiffResult,
} from "./annotationDiff";
import { getAnnotationDiffEntryKey } from "./annotationDiffTimeline";

// 整合方向只描述 source/target，不复用 added/removed 文案，交换左右后语义仍然明确。
export type AnnotationMergeDirection = "left-to-right" | "right-to-left";
export type AnnotationMergePlanItemRole = "selected" | "dependency";
export type AnnotationMergePlanItemAction =
  | "add"
  | "replace-conflict"
  | "already-equal";

export type AnnotationMergePlanItem = {
  entryKey: string;
  domain: AnnotationDiffDomain;
  identity: string;
  label: string;
  role: AnnotationMergePlanItemRole;
  action: AnnotationMergePlanItemAction;
  requiredBy: string[];
};

export type AnnotationMergePlanIssueCode =
  | "unsupported-domain"
  | "unknown-entry"
  | "missing-source-entity"
  | "missing-dependency"
  | "cyclic-dependency";

export type AnnotationMergePlanIssue = {
  code: AnnotationMergePlanIssueCode;
  entryKey: string;
  message: string;
};

export type AnnotationMergePlan = {
  direction: AnnotationMergeDirection;
  sourceSide: "left" | "right";
  targetSide: "left" | "right";
  items: AnnotationMergePlanItem[];
  issues: AnnotationMergePlanIssue[];
  canApply: boolean;
  counts: {
    selected: number;
    dependencies: number;
    additions: number;
    conflicts: number;
    alreadyEqual: number;
  };
};

type EntityReference = {
  domain: AnnotationDiffDomain;
  identity: string;
};

type IndexedEntity = EntityReference & {
  entryKey: string;
  dependencies: EntityReference[];
  dependencyIssues: string[];
};

type PlannedItemState = {
  entry: AnnotationDiffEntry;
  role: AnnotationMergePlanItemRole;
  action: AnnotationMergePlanItemAction;
  requiredBy: Set<string>;
};

// 固定领域顺序同时服务拓扑同层排序，不能依赖源文件数组顺序。
const DOMAIN_ORDER: AnnotationDiffDomain[] = [
  "subtitle_lines",
  "characters",
  "custom_tracks",
  "custom_blocks",
  "gongche",
  "banyan_sections",
  "banyan_marks",
  "attached_points",
  "project",
];

const DOMAIN_RANK = new Map(DOMAIN_ORDER.map((domain, index) => [domain, index]));

// 计划入口把选择转换为依赖闭包；只输出意图，不克隆实体、不生成 id，也不修改任一项目。
export function buildAnnotationMergePlan(input: {
  leftProject: ProjectData;
  rightProject: ProjectData;
  diff: AnnotationDiffResult;
  direction: AnnotationMergeDirection;
  selectedEntryKeys: readonly string[];
}): AnnotationMergePlan {
  const sourceSide = input.direction === "left-to-right" ? "left" : "right";
  const targetSide = sourceSide === "left" ? "right" : "left";
  const sourceProject = sourceSide === "left"
    ? input.leftProject
    : input.rightProject;
  const targetProject = targetSide === "left"
    ? input.leftProject
    : input.rightProject;
  const sourceIndex = buildProjectEntityIndex(sourceProject);
  const targetIndex = buildProjectEntityIndex(targetProject);
  const entries = new Map(input.diff.groups.flatMap((group) =>
    group.entries.map((entry) => [getAnnotationDiffEntryKey(entry), entry] as const)));
  const selectedKeys = [...new Set(input.selectedEntryKeys)].sort((left, right) =>
    compareEntryKeys(left, right, entries));
  const selectedKeySet = new Set(selectedKeys);
  const planned = new Map<string, PlannedItemState>();
  const issues = new Map<string, AnnotationMergePlanIssue>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const topologicalKeys: string[] = [];

  // 递归访问先处理依赖再写入当前实体，保证输出可以直接作为后续应用阶段的安全顺序。
  const visit = (
    entryKey: string,
    role: AnnotationMergePlanItemRole,
    requiredBy: string | null,
  ) => {
    const entry = entries.get(entryKey);
    if (!entry) {
      recordIssue(issues, {
        code: requiredBy ? "missing-dependency" : "unknown-entry",
        entryKey,
        message: requiredBy
          ? `“${requiredBy}”引用的依赖实体不存在于比较结果。`
          : `比较结果中不存在所选实体“${entryKey}”。`,
      });
      return;
    }
    if (entry.domain === "project") {
      recordIssue(issues, {
        code: "unsupported-domain",
        entryKey,
        message: "项目与媒体设置不能作为局部实体整合。",
      });
      return;
    }

    const sourceEntity = sourceIndex.get(entryKey);
    if (!sourceEntity) {
      recordIssue(issues, {
        code: requiredBy ? "missing-dependency" : "missing-source-entity",
        entryKey,
        message: requiredBy
          ? `源文件缺少“${requiredBy}”依赖的实体“${entryKey}”。`
          : `所选实体“${entry.label || entry.identity}”不存在于整合来源侧。`,
      });
      return;
    }

    // 数据内部已经违背领域关系时不能继续生成“看似可执行”的计划，例如工尺块挂到动作轨。
    for (const message of sourceEntity.dependencyIssues) {
      recordIssue(issues, {
        code: "missing-dependency",
        entryKey,
        message,
      });
    }

    // 同一实体既可能被用户选中又可能是别人的依赖；selected 优先且 requiredBy 必须完整保留。
    const current = planned.get(entryKey);
    if (current) {
      if (role === "selected") current.role = "selected";
      if (requiredBy) current.requiredBy.add(requiredBy);
    } else {
      planned.set(entryKey, {
        entry,
        role,
        action: getTargetAction(entry, targetIndex.has(entryKey)),
        requiredBy: new Set(requiredBy ? [requiredBy] : []),
      });
    }

    if (visiting.has(entryKey)) {
      recordIssue(issues, {
        code: "cyclic-dependency",
        entryKey,
        message: `实体“${entry.label || entry.identity}”存在循环引用。`,
      });
      return;
    }
    if (visited.has(entryKey)) return;

    visiting.add(entryKey);
    const dependencies = [...sourceEntity.dependencies].sort(compareEntityReferences);
    for (const dependency of dependencies) {
      visit(
        getAnnotationDiffEntryKey(dependency),
        selectedKeySet.has(getAnnotationDiffEntryKey(dependency))
          ? "selected"
          : "dependency",
        entryKey,
      );
    }
    visiting.delete(entryKey);
    visited.add(entryKey);
    topologicalKeys.push(entryKey);
  };

  // 用户选择先去重和稳定排序，选择顺序不会改变计划、摘要或测试快照。
  for (const entryKey of selectedKeys) {
    visit(entryKey, "selected", null);
  }

  const items = topologicalKeys
    .filter((entryKey, index, keys) => keys.indexOf(entryKey) === index)
    .map((entryKey) => {
      const state = planned.get(entryKey)!;
      return {
        entryKey,
        domain: state.entry.domain,
        identity: state.entry.identity,
        label: state.entry.label,
        role: state.role,
        action: state.action,
        requiredBy: [...state.requiredBy].sort(),
      };
    });
  const issueList = [...issues.values()].sort((left, right) =>
    left.entryKey.localeCompare(right.entryKey) || left.code.localeCompare(right.code));

  return {
    direction: input.direction,
    sourceSide,
    targetSide,
    items,
    issues: issueList,
    canApply: issueList.length === 0,
    counts: {
      selected: items.filter(({ role }) => role === "selected").length,
      dependencies: items.filter(({ role }) => role === "dependency").length,
      additions: items.filter(({ action }) => action === "add").length,
      conflicts: items.filter(({ action }) => action === "replace-conflict").length,
      alreadyEqual: items.filter(({ action }) => action === "already-equal").length,
    },
  };
}

// 项目索引把保存实体和强引用集中展开，后续图遍历不再反复扫描各领域数组。
function buildProjectEntityIndex(project: ProjectData): Map<string, IndexedEntity> {
  const index = new Map<string, IndexedEntity>();
  const add = (
    domain: AnnotationDiffDomain,
    identity: string,
    dependencies: EntityReference[] = [],
    dependencyIssues: string[] = [],
  ) => {
    const entryKey = getAnnotationDiffEntryKey({ domain, identity });
    index.set(entryKey, {
      domain,
      identity,
      entryKey,
      dependencies,
      dependencyIssues,
    });
  };

  for (const line of project.subtitleLines) add("subtitle_lines", line.id);
  for (const character of project.characterAnnotations) {
    add("characters", character.id, [reference("subtitle_lines", character.lineId)]);
  }
  for (const track of project.customTracks) {
    add("custom_tracks", track.id);
    indexCustomTrackBlocks(add, track);
  }
  for (const annotation of project.gongcheAnnotations) {
    const dependency = getGongcheDependencyState(project, annotation);
    add("gongche", annotation.id, dependency.references, dependency.issues);
  }
  for (const section of project.banyanSections) add("banyan_sections", section.id);
  for (const mark of project.banyanMarks) {
    const dependencies: EntityReference[] = [];
    if (mark.sectionId) dependencies.push(reference("banyan_sections", mark.sectionId));
    if (mark.linkedGongcheAnnotationId) {
      dependencies.push(reference("gongche", mark.linkedGongcheAnnotationId));
    }
    add("banyan_marks", mark.id, dependencies);
  }

  // 附属轨定义和点属于同一 diff domain，但使用不同 identity 前缀并形成定义 → parent、点 → 定义。
  const parentTracks = [
    ...project.builtinTracks.map((track) => ({ id: track.id, pointTracks: track.attachedPointTracks })),
    ...project.customTracks.map((track) => ({ id: track.id, pointTracks: track.attachedPointTracks })),
  ];
  for (const parent of parentTracks) {
    for (const pointTrack of parent.pointTracks) {
      indexAttachedPointTrack(add, project, parent.id, pointTrack);
    }
  }
  return index;
}

// 自定义块依赖轨道定义；递归父块保持同轨 identity，图遍历负责检测坏数据中的循环。
function indexCustomTrackBlocks(
  add: (
    domain: AnnotationDiffDomain,
    identity: string,
    dependencies?: EntityReference[],
    dependencyIssues?: string[],
  ) => void,
  track: CustomTrack,
) {
  for (const block of track.blocks) {
    const dependencies = [reference("custom_tracks", track.id)];
    if (block.branchParentBlockId) {
      dependencies.push(reference(
        "custom_blocks",
        `${track.id}:${block.branchParentBlockId}`,
      ));
    }
    add("custom_blocks", `${track.id}:${block.id}`, dependencies);
  }
}

// 工尺块必须跟随真实父文字块；内建逐字与自定义文字轨采用不同的稳定 identity。
function getGongcheDependencyState(
  project: ProjectData,
  annotation: ProjectData["gongcheAnnotations"][number],
): { references: EntityReference[]; issues: string[] } {
  if (annotation.parentTrackId === "character-track") {
    return {
      references: [reference("characters", annotation.parentBlockId)],
      issues: [],
    };
  }
  const parentTrack = project.customTracks.find(({ id }) =>
    id === annotation.parentTrackId);
  if (!parentTrack) {
    return {
      references: [reference("custom_tracks", annotation.parentTrackId)],
      issues: [],
    };
  }
  if (parentTrack.trackType !== "text") {
    return {
      references: [reference("custom_tracks", parentTrack.id)],
      issues: [
        `工尺块“${annotation.id}”的父轨道“${parentTrack.name}”不是文字轨。`,
      ],
    };
  }
  return {
    references: [
      reference("custom_tracks", parentTrack.id),
      reference("custom_blocks", `${parentTrack.id}:${annotation.parentBlockId}`),
    ],
    issues: [],
  };
}

// 附属点轨依赖自定义父轨；内建逐字父轨是项目基线，只验证存在而不制造 project 计划项。
function indexAttachedPointTrack(
  add: (
    domain: AnnotationDiffDomain,
    identity: string,
    dependencies?: EntityReference[],
    dependencyIssues?: string[],
  ) => void,
  project: ProjectData,
  parentTrackId: string,
  pointTrack: AttachedPointTrack,
) {
  const definitionIdentity = `point-track:${parentTrackId}:${pointTrack.id}`;
  const parentIsCustom = project.customTracks.some(({ id }) => id === parentTrackId);
  add(
    "attached_points",
    definitionIdentity,
    parentIsCustom ? [reference("custom_tracks", parentTrackId)] : [],
  );
  for (const point of pointTrack.points) {
    add(
      "attached_points",
      `point:${parentTrackId}:${pointTrack.id}:${point.id}`,
      [reference("attached_points", definitionIdentity)],
    );
  }
}

// 目标动作依据方向后的真实存在性和结构化 diff 判定，不把 added/removed 固定绑定为某一方向。
function getTargetAction(
  entry: AnnotationDiffEntry,
  targetExists: boolean,
): AnnotationMergePlanItemAction {
  if (!targetExists) return "add";
  return entry.changeType === "unchanged" ? "already-equal" : "replace-conflict";
}

// 引用构造和比较集中定义，避免各领域拼接 key 时产生静默漂移。
function reference(
  domain: AnnotationDiffDomain,
  identity: string,
): EntityReference {
  return { domain, identity };
}

function compareEntityReferences(left: EntityReference, right: EntityReference) {
  return (DOMAIN_RANK.get(left.domain) ?? Number.MAX_SAFE_INTEGER) -
      (DOMAIN_RANK.get(right.domain) ?? Number.MAX_SAFE_INTEGER) ||
    left.identity.localeCompare(right.identity);
}

// 选择根节点也按领域和 identity 排序，避免调用方 checkbox 顺序影响整份计划。
function compareEntryKeys(
  leftKey: string,
  rightKey: string,
  entries: Map<string, AnnotationDiffEntry>,
) {
  const left = entries.get(leftKey);
  const right = entries.get(rightKey);
  if (left && right) return compareEntityReferences(left, right);
  if (left) return -1;
  if (right) return 1;
  return leftKey.localeCompare(rightKey);
}

// 相同 issue 只记录一次，递归闭包中多个引用者不会淹没真正的数据错误。
function recordIssue(
  issues: Map<string, AnnotationMergePlanIssue>,
  issue: AnnotationMergePlanIssue,
) {
  issues.set(`${issue.code}:${issue.entryKey}`, issue);
}
