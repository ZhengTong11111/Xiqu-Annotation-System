import type {
  AttachedPointAnnotation,
  AttachedPointTrack,
  CustomActionTrack,
  CustomActionTrackBlock,
  CustomTextTrack,
  CustomTextTrackBlock,
  CustomTrack,
  ProjectData,
} from "../types";
import type {
  AnnotationMergeConflictResolutions,
} from "./annotationMergeConflict";
import type {
  AnnotationMergePlan,
  AnnotationMergePlanItem,
} from "./annotationMergePlan";

export type AnnotationMergeApplyIssue = {
  entryKey: string;
  message: string;
};

export type AnnotationMergeApplyResult =
  | {
      ok: true;
      project: ProjectData;
      summary: {
        added: number;
        replaced: number;
        keptTarget: number;
        alreadyEqual: number;
      };
    }
  | {
      ok: false;
      issues: AnnotationMergeApplyIssue[];
    };

type MutableSummary = {
  added: number;
  replaced: number;
  keptTarget: number;
  alreadyEqual: number;
};

// 应用器只消费已复核计划，并在目标项目克隆上按拓扑顺序执行；任一问题都会丢弃整个结果。
export function applyAnnotationMergePlan(input: {
  sourceProject: ProjectData;
  targetProject: ProjectData;
  plan: AnnotationMergePlan;
  resolutions: AnnotationMergeConflictResolutions;
}): AnnotationMergeApplyResult {
  const issues: AnnotationMergeApplyIssue[] = input.plan.issues.map((issue) => ({
    entryKey: issue.entryKey,
    message: issue.message,
  }));
  const project = cloneValue(input.targetProject);
  const summary: MutableSummary = {
    added: 0,
    replaced: 0,
    keptTarget: 0,
    alreadyEqual: 0,
  };

  // 冲突必须先有显式决定；应用阶段绝不能代替用户选择默认覆盖方向。
  for (const item of input.plan.items) {
    if (item.action === "replace-conflict" && !input.resolutions[item.entryKey]) {
      issues.push({
        entryKey: item.entryKey,
        message: `冲突“${item.label}”尚未决定采用来源还是保留目标。`,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // 计划已经按依赖拓扑排序；轨道定义会先建立空容器，随后才写入被明确选择的块和点。
  for (const item of input.plan.items) {
    if (item.action === "already-equal") {
      summary.alreadyEqual += 1;
      continue;
    }
    if (
      item.action === "replace-conflict" &&
      input.resolutions[item.entryKey] === "keep-target"
    ) {
      summary.keptTarget += 1;
      continue;
    }
    const issue = applyPlanItem(project, input.sourceProject, item);
    if (issue) issues.push(issue);
    else if (item.action === "add") summary.added += 1;
    else summary.replaced += 1;
  }

  // 所有实体写入后统一排序和校验，避免部分成功项目逃出纯函数边界。
  normalizeMergedProjectOrder(project);
  issues.push(...validateMergedProject(project));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, project, summary };
}

// 领域分派只执行保存实体替换；项目与媒体配置不属于局部整合范围。
function applyPlanItem(
  target: ProjectData,
  source: ProjectData,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  switch (item.domain) {
    case "subtitle_lines":
      return applySubtitleLine(target, source, item);
    case "characters":
      return replaceArrayEntity(
        target.characterAnnotations,
        source.characterAnnotations,
        item,
      );
    case "gongche":
      return replaceArrayEntity(
        target.gongcheAnnotations,
        source.gongcheAnnotations,
        item,
      );
    case "banyan_sections":
      return replaceArrayEntity(target.banyanSections, source.banyanSections, item);
    case "banyan_marks":
      return replaceArrayEntity(target.banyanMarks, source.banyanMarks, item);
    case "custom_tracks":
      return applyCustomTrackDefinition(target, source, item);
    case "custom_blocks":
      return applyCustomTrackBlock(target, source, item);
    case "attached_points":
      return applyAttachedPointEntity(target, source, item);
    case "project":
      return issue(item, "项目与媒体设置不能通过局部整合写入。");
  }
}

// 句子携带多个角色引用；局部带入来源句子时同步补齐全部定义，避免生成悬空的 v7 项目。
function applySubtitleLine(
  target: ProjectData,
  source: ProjectData,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const sourceLine = source.subtitleLines.find(({ id }) => id === item.identity);
  if (!sourceLine) return issue(item, "来源侧缺少计划中的句级字幕。");
  const applyIssue = replaceArrayEntity(target.subtitleLines, source.subtitleLines, item);
  if (applyIssue) return applyIssue;
  for (const role of sourceLine.roleTypes) {
    if (!target.sentenceAnnotationConfig.roleOptions.includes(role)) {
      target.sentenceAnnotationConfig.roleOptions.push(role);
    }
  }
  return null;
}

// 普通数组实体按稳定 id 定位；add 与 replace 共用一个确定写入入口。
function replaceArrayEntity<T extends { id: string }>(
  target: T[],
  source: T[],
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const sourceEntity = source.find(({ id }) => id === item.identity);
  if (!sourceEntity) return issue(item, "来源侧缺少计划中的实体。");
  const targetIndex = target.findIndex(({ id }) => id === item.identity);
  if (item.action === "add" && targetIndex >= 0) {
    return issue(item, "计划要求新增，但目标侧已经存在同标识实体。");
  }
  if (item.action === "replace-conflict" && targetIndex < 0) {
    return issue(item, "计划要求替换，但目标侧实体已经不存在。");
  }
  if (targetIndex >= 0) target[targetIndex] = cloneValue(sourceEntity);
  else target.push(cloneValue(sourceEntity));
  return null;
}

// 轨道定义替换只更新设置字段，目标已有块和附属点集合必须原样保留。
function applyCustomTrackDefinition(
  target: ProjectData,
  source: ProjectData,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const sourceTrack = source.customTracks.find(({ id }) => id === item.identity);
  if (!sourceTrack) return issue(item, "来源侧缺少自定义轨道定义。");
  const targetIndex = target.customTracks.findIndex(({ id }) => id === item.identity);
  if (item.action === "add" && targetIndex >= 0) {
    return issue(item, "目标侧已经存在待新增的自定义轨道。");
  }
  if (item.action === "replace-conflict" && targetIndex < 0) {
    return issue(item, "目标侧缺少待替换的自定义轨道。");
  }
  if (targetIndex < 0) {
    target.customTracks.push(emptyCustomTrackContents(sourceTrack));
    if (!target.activeTrackOrder.includes(sourceTrack.id)) {
      target.activeTrackOrder.push(sourceTrack.id);
    }
    return null;
  }
  const targetTrack = target.customTracks[targetIndex]!;
  if (sourceTrack.trackType !== targetTrack.trackType) {
    return issue(item, "同标识轨道的文字/动作类型不一致，不能保留目标内容后替换定义。");
  }
  target.customTracks[targetIndex] = {
    ...cloneValue(sourceTrack),
    blocks: targetTrack.blocks,
    attachedPointTracks: targetTrack.attachedPointTracks,
  } as CustomTrack;
  return null;
}

// 块 identity 同时包含轨道和块 id，防止不同轨道中的同名块互相覆盖。
function applyCustomTrackBlock(
  target: ProjectData,
  source: ProjectData,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const location = findCustomBlock(source, item.identity);
  if (!location) return issue(item, "来源侧缺少自定义标注块。");
  const targetTrack = target.customTracks.find(({ id }) => id === location.track.id);
  if (!targetTrack) return issue(item, "目标侧尚未建立标注块所属轨道。");
  // 文字块和动作块分别进入同类型轨道，保持联合类型关联而无需类型断言绕过检查。
  if (targetTrack.trackType === "text" && location.kind === "text") {
    return replaceCustomBlock(targetTrack.blocks, location.block, item);
  }
  if (targetTrack.trackType === "action" && location.kind === "action") {
    return replaceCustomBlock(targetTrack.blocks, location.block, item);
  }
  return issue(item, "来源块与目标轨道类型不一致。");
}

// 同类型自定义块共用动作校验，但保留轨道与块之间的严格类型对应关系。
function replaceCustomBlock<T extends { id: string }>(
  targetBlocks: T[],
  sourceBlock: T,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const targetIndex = targetBlocks.findIndex(({ id }) => id === sourceBlock.id);
  if (item.action === "add" && targetIndex >= 0) {
    return issue(item, "目标轨道已经存在待新增的标注块。");
  }
  if (item.action === "replace-conflict" && targetIndex < 0) {
    return issue(item, "目标轨道缺少待替换的标注块。");
  }
  const nextBlock = cloneValue(sourceBlock);
  if (targetIndex >= 0) targetBlocks.splice(targetIndex, 1, nextBlock);
  else targetBlocks.push(nextBlock);
  return null;
}

// 附属点领域含“轨道定义”和“点”两种实体，按真实来源实体精确匹配 identity 后局部写入。
function applyAttachedPointEntity(
  target: ProjectData,
  source: ProjectData,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const sourceEntity = findAttachedPointEntity(source, item.identity);
  if (!sourceEntity) return issue(item, "来源侧缺少计划中的附属点实体。");
  if (sourceEntity.kind === "definition") {
    const targetParent = findPointTrackParent(target, sourceEntity.parentTrackId);
    if (!targetParent) return issue(item, "目标侧缺少附属点轨的父轨道。");
    const targetIndex = targetParent.findIndex(({ id }) => id === sourceEntity.track.id);
    if (item.action === "add" && targetIndex >= 0) {
      return issue(item, "目标侧已经存在待新增的附属点轨定义。");
    }
    if (item.action === "replace-conflict" && targetIndex < 0) {
      return issue(item, "目标侧缺少待替换的附属点轨定义。");
    }
    if (targetIndex >= 0) {
      targetParent[targetIndex] = {
        ...cloneValue(sourceEntity.track),
        points: targetParent[targetIndex]!.points,
      };
    } else {
      targetParent.push({ ...cloneValue(sourceEntity.track), points: [] });
    }
    return null;
  }

  const targetTrack = findAttachedPointTrack(
    target,
    sourceEntity.parentTrackId,
    sourceEntity.track.id,
  );
  if (!targetTrack) return issue(item, "目标侧尚未建立附属点轨定义。");
  return replacePoint(targetTrack.points, sourceEntity.point, item);
}

// 点写入遵守计划动作，避免最新复核和实际应用之间出现静默偏差。
function replacePoint(
  target: AttachedPointAnnotation[],
  source: AttachedPointAnnotation,
  item: AnnotationMergePlanItem,
): AnnotationMergeApplyIssue | null {
  const targetIndex = target.findIndex(({ id }) => id === source.id);
  if (item.action === "add" && targetIndex >= 0) {
    return issue(item, "目标附属点轨已经存在待新增的点。");
  }
  if (item.action === "replace-conflict" && targetIndex < 0) {
    return issue(item, "目标附属点轨缺少待替换的点。");
  }
  if (targetIndex >= 0) target[targetIndex] = cloneValue(source);
  else target.push(cloneValue(source));
  return null;
}

// 来源轨道新增时只建立定义容器，块和点必须由各自计划项明确写入。
function emptyCustomTrackContents(track: CustomTrack): CustomTrack {
  return {
    ...cloneValue(track),
    blocks: [],
    attachedPointTracks: [],
  } as CustomTrack;
}

// 自定义块定位不依赖分隔符反解析，直接从真实轨道构造相同稳定 identity。
type CustomBlockLocation =
  | { kind: "text"; track: CustomTextTrack; block: CustomTextTrackBlock }
  | { kind: "action"; track: CustomActionTrack; block: CustomActionTrackBlock };

function findCustomBlock(
  project: ProjectData,
  identity: string,
): CustomBlockLocation | null {
  for (const track of project.customTracks) {
    if (track.trackType === "text") {
      const block = track.blocks.find((candidate) =>
        `${track.id}:${candidate.id}` === identity);
      if (block) return { kind: "text", track, block };
    } else {
      const block = track.blocks.find((candidate) =>
        `${track.id}:${candidate.id}` === identity);
      if (block) return { kind: "action", track, block };
    }
  }
  return null;
}

type AttachedPointEntityLocation =
  | { kind: "definition"; parentTrackId: string; track: AttachedPointTrack }
  | {
      kind: "point";
      parentTrackId: string;
      track: AttachedPointTrack;
      point: AttachedPointAnnotation;
    };

// identity 允许包含任意合法 id 字符；通过逐实体构造完整 key 避免依赖分隔符反解析。
function findAttachedPointEntity(
  project: ProjectData,
  identity: string,
): AttachedPointEntityLocation | null {
  const parents = [
    ...project.builtinTracks.map((track) => ({ id: track.id, tracks: track.attachedPointTracks })),
    ...project.customTracks.map((track) => ({ id: track.id, tracks: track.attachedPointTracks })),
  ];
  for (const parent of parents) {
    for (const track of parent.tracks) {
      if (`point-track:${parent.id}:${track.id}` === identity) {
        return { kind: "definition", parentTrackId: parent.id, track };
      }
      const point = track.points.find((candidate) =>
        `point:${parent.id}:${track.id}:${candidate.id}` === identity);
      if (point) return { kind: "point", parentTrackId: parent.id, track, point };
    }
  }
  return null;
}

// 父轨定位同时覆盖内建轨和自定义轨，返回实际可变数组供定义写入。
function findPointTrackParent(
  project: ProjectData,
  parentTrackId: string,
): AttachedPointTrack[] | null {
  return project.builtinTracks.find(({ id }) => id === parentTrackId)
    ?.attachedPointTracks ?? project.customTracks.find(({ id }) =>
      id === parentTrackId)?.attachedPointTracks ?? null;
}

function findAttachedPointTrack(
  project: ProjectData,
  parentTrackId: string,
  pointTrackId: string,
) {
  return findPointTrackParent(project, parentTrackId)?.find(({ id }) =>
    id === pointTrackId) ?? null;
}

// 稳定排序只整理用户可见时间序列，不重排轨道和分支定义的人工顺序。
function normalizeMergedProjectOrder(project: ProjectData) {
  const byRange = <T extends { id: string; startTime: number; endTime: number }>(
    left: T,
    right: T,
  ) => left.startTime - right.startTime || left.endTime - right.endTime ||
    left.id.localeCompare(right.id);
  project.subtitleLines.sort(byRange);
  project.characterAnnotations.sort(byRange);
  project.gongcheAnnotations.sort(byRange);
  project.banyanSections.sort(byRange);
  project.banyanMarks.sort((left, right) =>
    left.time - right.time || left.id.localeCompare(right.id));
  for (const track of project.customTracks) track.blocks.sort(byRange);
  for (const pointTrack of allAttachedPointTracks(project)) {
    pointTrack.points.sort((left, right) =>
      left.time - right.time || left.id.localeCompare(right.id));
  }
}

// 最终验证覆盖稳定标识和跨领域强引用；错误结果不会交给编辑器形成半成品草稿。
function validateMergedProject(project: ProjectData): AnnotationMergeApplyIssue[] {
  const issues: AnnotationMergeApplyIssue[] = [];
  const lineIds = uniqueIds(project.subtitleLines, "句级字幕", issues);
  const characterIds = uniqueIds(project.characterAnnotations, "逐字标注", issues);
  const gongcheIds = uniqueIds(project.gongcheAnnotations, "工尺谱", issues);
  const sectionIds = uniqueIds(project.banyanSections, "板眼区段", issues);
  uniqueIds(project.banyanMarks, "板眼标记", issues);
  const customTrackIds = uniqueIds(project.customTracks, "自定义轨道", issues);

  // 角色配置是有序唯一列表，每个句级角色数组也必须唯一并只引用已有定义。
  if (new Set(project.sentenceAnnotationConfig.roleOptions).size !==
      project.sentenceAnnotationConfig.roleOptions.length) {
    issues.push({ entryKey: "project:sentence-role-options", message: "角色行当列表包含重复项。" });
  }
  const roleOptions = new Set(project.sentenceAnnotationConfig.roleOptions);
  for (const line of project.subtitleLines) {
    if (new Set(line.roleTypes).size !== line.roleTypes.length ||
      line.roleTypes.some((role) => !roleOptions.has(role))) {
      issues.push({ entryKey: `subtitle_lines:${line.id}`, message: "句级字幕引用了未定义的角色行当。" });
    }
  }

  // 内建轨和自定义轨都必须保证附属轨定义及点 id 在各自父集合内唯一。
  for (const track of project.builtinTracks) {
    uniqueIds(track.attachedPointTracks, `内建轨“${track.name}”附属轨`, issues);
    for (const pointTrack of track.attachedPointTracks) {
      uniqueIds(pointTrack.points, `附属点轨“${pointTrack.name}”`, issues);
    }
  }

  for (const character of project.characterAnnotations) {
    if (!lineIds.has(character.lineId)) {
      issues.push({ entryKey: `characters:${character.id}`, message: "逐字标注引用了不存在的句级字幕。" });
    }
  }
  for (const track of project.customTracks) validateCustomTrack(track, issues);
  for (const gongche of project.gongcheAnnotations) {
    uniqueIds(gongche.symbols, `工尺谱“${gongche.id}”符号`, issues);
    const parentValid = gongche.parentTrackId === "character-track"
      ? characterIds.has(gongche.parentBlockId)
      : project.customTracks.some((track) =>
        track.id === gongche.parentTrackId && track.trackType === "text" &&
        track.blocks.some(({ id }) => id === gongche.parentBlockId));
    if (!parentValid) {
      issues.push({ entryKey: `gongche:${gongche.id}`, message: "工尺谱引用了不存在或非文字类型的父块。" });
    }
  }
  for (const mark of project.banyanMarks) {
    if (mark.sectionId && !sectionIds.has(mark.sectionId)) {
      issues.push({ entryKey: `banyan_marks:${mark.id}`, message: "板眼标记引用了不存在的板眼区段。" });
    }
    if (mark.linkedGongcheAnnotationId && !gongcheIds.has(mark.linkedGongcheAnnotationId)) {
      issues.push({ entryKey: `banyan_marks:${mark.id}`, message: "板眼标记引用了不存在的工尺谱块。" });
    }
    const linkedGongche = mark.linkedGongcheAnnotationId
      ? project.gongcheAnnotations.find(({ id }) => id === mark.linkedGongcheAnnotationId)
      : null;
    const linkedSymbolIds = [
      ...(mark.linkedGongcheSymbolId ? [mark.linkedGongcheSymbolId] : []),
      ...(mark.linkedGongcheSymbolIds ?? []),
    ];
    if (linkedSymbolIds.length > 0 && !linkedGongche) {
      issues.push({ entryKey: `banyan_marks:${mark.id}`, message: "板眼标记含工尺符号引用，但未关联有效工尺谱块。" });
    } else if (linkedGongche) {
      const symbolIds = new Set(linkedGongche.symbols.map(({ id }) => id));
      if (linkedSymbolIds.some((symbolId) => !symbolIds.has(symbolId))) {
        issues.push({ entryKey: `banyan_marks:${mark.id}`, message: "板眼标记引用了关联工尺谱块中不存在的符号。" });
      }
    }
  }
  const validTrackIds = new Set([
    ...project.builtinTracks.map(({ id }) => id),
    ...customTrackIds,
  ]);
  for (const trackId of project.activeTrackOrder) {
    if (!validTrackIds.has(trackId)) {
      issues.push({ entryKey: `project:${trackId}`, message: "活动轨道顺序包含不存在的轨道。" });
    }
  }
  return issues;
}

// 单轨校验块 id、递归父块和分叉 lane 归属，递归环通过逐块向上追溯检测。
function validateCustomTrack(
  track: CustomTrack,
  issues: AnnotationMergeApplyIssue[],
) {
  const blockIds = uniqueIds(track.blocks, `轨道“${track.name}”标注块`, issues);
  uniqueIds(track.attachedPointTracks, `轨道“${track.name}”附属轨`, issues);
  const laneIds = collectBranchLaneIds(track.branching?.lanes ?? []);
  for (const block of track.blocks) {
    if (block.branchParentBlockId && !blockIds.has(block.branchParentBlockId)) {
      issues.push({ entryKey: `custom_blocks:${track.id}:${block.id}`, message: "自定义块引用了不存在的父块。" });
    }
    if (block.branchScope?.mode === "lanes") {
      for (const laneId of block.branchScope.laneIds) {
        if (!laneIds.has(laneId)) {
          issues.push({ entryKey: `custom_blocks:${track.id}:${block.id}`, message: "自定义块归属了不存在的分叉。" });
        }
      }
    }
    const visited = new Set([block.id]);
    let parentId = block.branchParentBlockId;
    while (parentId) {
      if (visited.has(parentId)) {
        issues.push({ entryKey: `custom_blocks:${track.id}:${block.id}`, message: "自定义块存在递归父块循环。" });
        break;
      }
      visited.add(parentId);
      parentId = track.blocks.find(({ id }) => id === parentId)?.branchParentBlockId;
    }
  }
  for (const pointTrack of track.attachedPointTracks) {
    uniqueIds(pointTrack.points, `附属点轨“${pointTrack.name}”`, issues);
  }
}

// 分叉树展开为 id 集合；保存顺序不变，只用于校验块归属。
function collectBranchLaneIds(
  lanes: NonNullable<CustomTrack["branching"]>["lanes"],
): Set<string> {
  const ids = new Set<string>();
  const visit = (items: typeof lanes) => {
    for (const lane of items) {
      ids.add(lane.id);
      visit(lane.children ?? []);
    }
  };
  visit(lanes);
  return ids;
}

// 重复标识集中生成结构化问题，调用者不需要依赖数组覆盖行为猜测坏数据。
function uniqueIds<T extends { id: string }>(
  values: readonly T[],
  label: string,
  issues: AnnotationMergeApplyIssue[],
): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      issues.push({ entryKey: `${label}:${value.id}`, message: `${label}存在重复稳定标识。` });
    }
    ids.add(value.id);
  }
  return ids;
}

function allAttachedPointTracks(project: ProjectData) {
  return [
    ...project.builtinTracks.flatMap(({ attachedPointTracks }) => attachedPointTracks),
    ...project.customTracks.flatMap(({ attachedPointTracks }) => attachedPointTracks),
  ];
}

function issue(
  item: AnnotationMergePlanItem,
  message: string,
): AnnotationMergeApplyIssue {
  return { entryKey: item.entryKey, message };
}

// 保存模型均为结构化可克隆数据；统一克隆入口保证应用器不修改来源或目标输入。
function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
