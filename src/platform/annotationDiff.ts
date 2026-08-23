import type {
  AttachedPointTrack,
  BanyanMark,
  BanyanSection,
  BranchLane,
  CharacterAnnotation,
  CustomTrack,
  GongcheAnnotation,
  ProjectData,
  SubtitleLine,
} from "../types";
import {
  isRecognizableProjectPayload,
  normalizeImportedProjectFile,
} from "../utils/projectFile";

// 比较结果使用固定领域和变化类型，UI 只负责展示，不再自行推断业务差异。
export type AnnotationDiffChangeType =
  | "added"
  | "removed"
  | "modified"
  | "unchanged";

export type AnnotationDiffDomain =
  | "project"
  | "subtitle_lines"
  | "characters"
  | "gongche"
  | "banyan_sections"
  | "banyan_marks"
  | "custom_tracks"
  | "custom_blocks"
  | "attached_points";

export type AnnotationDiffTimeRange = {
  start: number;
  end: number;
};

export type AnnotationDiffCounts = Record<AnnotationDiffChangeType, number>;

export type AnnotationDiffEntry = {
  domain: AnnotationDiffDomain;
  changeType: AnnotationDiffChangeType;
  identity: string;
  label: string;
  leftTimeRange: AnnotationDiffTimeRange | null;
  rightTimeRange: AnnotationDiffTimeRange | null;
  changedFields: string[];
};

export type AnnotationDiffGroup = {
  domain: AnnotationDiffDomain;
  label: string;
  counts: AnnotationDiffCounts;
  entries: AnnotationDiffEntry[];
};

export type AnnotationDiffSideSummary = {
  videoName: string | null;
  subtitleLineCount: number;
  characterCount: number;
  gongcheCount: number;
  banyanMarkCount: number;
  customTrackCount: number;
  customBlockCount: number;
  attachedPointCount: number;
};

export type AnnotationDiffResult = {
  counts: AnnotationDiffCounts;
  groups: AnnotationDiffGroup[];
  hasDifferences: boolean;
  leftSummary: AnnotationDiffSideSummary;
  rightSummary: AnnotationDiffSideSummary;
  warnings: string[];
  hasDuplicateIdentities: boolean;
};

// 单侧迁移错误由普通文件和恢复快照比较共享，调用方可以保持左右错误隔离。
export type AnnotationDiffBuildError = {
  side: "left" | "right";
  message: string;
};

export type AnnotationDiffBuildResult =
  | {
      ok: true;
      diff: AnnotationDiffResult;
      // 规范化项目只属于当前比较会话，供后续只读分析复用，不能写回原始文件。
      leftProject: ProjectData;
      rightProject: ProjectData;
    }
  | {
      ok: false;
      errors: AnnotationDiffBuildError[];
    };

type DiffCandidate = {
  identity: string;
  label: string;
  timeRange: AnnotationDiffTimeRange | null;
  fields: Record<string, unknown>;
  fieldLabels: Record<string, string>;
};

type DomainDefinition = {
  domain: AnnotationDiffDomain;
  label: string;
  left: DiffCandidate[];
  right: DiffCandidate[];
};

const CHANGE_TYPES: AnnotationDiffChangeType[] = [
  "added",
  "removed",
  "modified",
  "unchanged",
];

// 主入口先分别验证和迁移两侧 payload，任何一侧失败都返回带方向的错误，不伪造空项目。
export function buildAnnotationDiff(
  leftPayload: unknown,
  rightPayload: unknown,
): AnnotationDiffBuildResult {
  const left = normalizeDiffSide(leftPayload, "left");
  const right = normalizeDiffSide(rightPayload, "right");
  if (!left.ok || !right.ok) {
    return {
      ok: false,
      errors: [
        ...(!left.ok ? [left.error] : []),
        ...(!right.ok ? [right.error] : []),
      ],
    };
  }

  const leftProject = left.project;
  const rightProject = right.project;
  const definitions = buildDomainDefinitions(leftProject, rightProject);
  const groups = definitions.map(buildDiffGroup);
  const duplicateIdentityWarnings = buildDuplicateIdentityWarnings(definitions);
  const counts = groups.reduce(
    (total, group) => addCounts(total, group.counts),
    emptyCounts(),
  );

  return {
    ok: true,
    diff: {
      counts,
      groups,
      hasDifferences:
        counts.added + counts.removed + counts.modified > 0,
      leftSummary: summarizeProject(leftProject),
      rightSummary: summarizeProject(rightProject),
      warnings: [
        ...buildDiffWarnings(leftProject, rightProject),
        ...duplicateIdentityWarnings,
      ],
      // 重复稳定标识会令后续局部整合无法唯一定位实体，因此提供结构化阻断标记，避免调用方解析提示文案。
      hasDuplicateIdentities: duplicateIdentityWarnings.length > 0,
    },
    leftProject,
    rightProject,
  };
}

// 重复稳定 id 会让 Map 匹配丢失实体；比较仍可展示，但必须明确警告数据需要修复。
function buildDuplicateIdentityWarnings(
  definitions: DomainDefinition[],
): string[] {
  const warnings: string[] = [];
  for (const definition of definitions) {
    for (const [sideLabel, candidates] of [
      ["左侧", definition.left],
      ["右侧", definition.right],
    ] as const) {
      const counts = new Map<string, number>();
      for (const item of candidates) {
        counts.set(item.identity, (counts.get(item.identity) ?? 0) + 1);
      }
      const duplicateCount = [...counts.values()].filter((count) =>
        count > 1).length;
      if (duplicateCount > 0) {
        warnings.push(
          `${sideLabel}${definition.label}存在 ${duplicateCount} 个重复标识；` +
          "对应条目可能无法一一匹配，请先修复文件标识。",
        );
      }
    }
  }
  return warnings;
}

// 空对象不是合法项目；先用正式识别器守住边界，再复用唯一项目迁移入口。
function normalizeDiffSide(
  payload: unknown,
  side: "left" | "right",
):
  | { ok: true; project: ProjectData }
  | { ok: false; error: { side: "left" | "right"; message: string } } {
  if (!isRecognizableProjectPayload(payload)) {
    return {
      ok: false,
      error: { side, message: "文件不包含可识别的戏曲标注项目结构。" },
    };
  }
  try {
    return {
      ok: true,
      project: normalizeImportedProjectFile(payload).project,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        side,
        message: error instanceof Error
          ? error.message
          : "标注项目迁移失败。",
      },
    };
  }
}

// 各领域候选项在一处组装，保证分组顺序、身份规则和字段选择不会散落到 React 组件。
function buildDomainDefinitions(
  left: ProjectData,
  right: ProjectData,
): DomainDefinition[] {
  return [
    {
      domain: "project",
      label: "项目与媒体",
      left: [projectCandidate(left)],
      right: [projectCandidate(right)],
    },
    {
      domain: "subtitle_lines",
      label: "句级字幕",
      left: left.subtitleLines.map(subtitleCandidate),
      right: right.subtitleLines.map(subtitleCandidate),
    },
    {
      domain: "characters",
      label: "逐字标注",
      left: left.characterAnnotations.map(characterCandidate),
      right: right.characterAnnotations.map(characterCandidate),
    },
    {
      domain: "gongche",
      label: "工尺谱",
      left: left.gongcheAnnotations.map(gongcheCandidate),
      right: right.gongcheAnnotations.map(gongcheCandidate),
    },
    {
      domain: "banyan_sections",
      label: "板眼区段",
      left: left.banyanSections.map(banyanSectionCandidate),
      right: right.banyanSections.map(banyanSectionCandidate),
    },
    {
      domain: "banyan_marks",
      label: "板眼标记",
      left: left.banyanMarks.map(banyanMarkCandidate),
      right: right.banyanMarks.map(banyanMarkCandidate),
    },
    {
      domain: "custom_tracks",
      label: "自定义轨道",
      left: left.customTracks.map(customTrackCandidate),
      right: right.customTracks.map(customTrackCandidate),
    },
    {
      domain: "custom_blocks",
      label: "自定义标注块",
      left: customBlockCandidates(left.customTracks),
      right: customBlockCandidates(right.customTracks),
    },
    {
      domain: "attached_points",
      label: "附属打点",
      left: attachedPointCandidates(left),
      right: attachedPointCandidates(right),
    },
  ];
}

// 一个领域按稳定 id 建索引；数组换序不会制造差异，输出再按时间和名称稳定排序。
function buildDiffGroup(definition: DomainDefinition): AnnotationDiffGroup {
  const leftById = new Map(definition.left.map((item) => [item.identity, item]));
  const rightById = new Map(definition.right.map((item) => [item.identity, item]));
  const identities = [...new Set([...leftById.keys(), ...rightById.keys()])];
  const entries = identities.map((identity) => buildDiffEntry(
    definition.domain,
    identity,
    leftById.get(identity),
    rightById.get(identity),
  )).sort(compareDiffEntries);
  return {
    domain: definition.domain,
    label: definition.label,
    counts: countEntries(entries),
    entries,
  };
}

// 增删改查由候选项是否存在和窄字段集合决定，完整对象中的 UI 瞬态不会参与判断。
function buildDiffEntry(
  domain: AnnotationDiffDomain,
  identity: string,
  left: DiffCandidate | undefined,
  right: DiffCandidate | undefined,
): AnnotationDiffEntry {
  if (!left && right) {
    return {
      domain,
      identity,
      changeType: "added",
      label: right.label,
      leftTimeRange: null,
      rightTimeRange: right.timeRange,
      changedFields: [],
    };
  }
  if (left && !right) {
    return {
      domain,
      identity,
      changeType: "removed",
      label: left.label,
      leftTimeRange: left.timeRange,
      rightTimeRange: null,
      changedFields: [],
    };
  }
  const leftItem = left!;
  const rightItem = right!;
  const fieldKeys = [...new Set([
    ...Object.keys(leftItem.fields),
    ...Object.keys(rightItem.fields),
  ])];
  const changedFields = fieldKeys
    .filter((key) => !sameComparableValue(
      leftItem.fields[key],
      rightItem.fields[key],
    ))
    .map((key) =>
      rightItem.fieldLabels[key] ?? leftItem.fieldLabels[key] ?? key);
  return {
    domain,
    identity,
    changeType: changedFields.length > 0 ? "modified" : "unchanged",
    label: rightItem.label || leftItem.label,
    leftTimeRange: leftItem.timeRange,
    rightTimeRange: rightItem.timeRange,
    changedFields,
  };
}

// 项目级候选只选择持久业务字段；内建轨道设置属于项目配置，附属点由独立领域比较。
function projectCandidate(project: ProjectData): DiffCandidate {
  return candidate("project", project.video.name ?? "未命名项目", null, {
    videoName: project.video.name,
    videoUrl: project.video.url,
    videoSource: project.video.source,
    videoFilePath: project.video.filePath ?? null,
    requiresManualImport: Boolean(project.video.requiresManualImport),
    sentenceRoleOptions: project.sentenceAnnotationConfig.roleOptions,
    activeTrackOrder: project.activeTrackOrder,
    builtinTracks: project.builtinTracks.map((track) => ({
      id: track.id,
      name: track.name,
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
      autoSetLoopRangeOnSelect: Boolean(track.autoSetLoopRangeOnSelect),
    })),
  }, {
    videoName: "视频名称",
    videoUrl: "视频来源",
    videoSource: "视频类型",
    videoFilePath: "本地视频路径",
    requiresManualImport: "视频重关联状态",
    sentenceRoleOptions: "角色行当列表",
    activeTrackOrder: "轨道顺序",
    builtinTracks: "内建轨道设置",
  });
}

// 句级字幕以保存 id 匹配；文本、时间和两项分类共同构成当前研究标注。
function subtitleCandidate(line: SubtitleLine): DiffCandidate {
  return candidate(line.id, line.text || "空句", range(
    line.startTime,
    line.endTime,
  ), {
    text: line.text,
    startTime: line.startTime,
    endTime: line.endTime,
    deliveryMode: line.deliveryMode,
    roleType: line.roleType,
  }, {
    text: "文本",
    startTime: "开始时间",
    endTime: "结束时间",
    deliveryMode: "念白/唱",
    roleType: "角色行当",
  });
}

// 逐字比较保留句归属和四声，字符插入不会影响其他稳定 id 的匹配。
function characterCandidate(item: CharacterAnnotation): DiffCandidate {
  return candidate(item.id, item.char || "空字", range(
    item.startTime,
    item.endTime,
  ), {
    lineId: item.lineId,
    char: item.char,
    startTime: item.startTime,
    endTime: item.endTime,
    tone: item.tone ?? null,
  }, {
    lineId: "句级归属",
    char: "文字",
    startTime: "开始时间",
    endTime: "结束时间",
    tone: "四声",
  });
}

// 工尺符号比较语义序列而不比较 fallback symbol id，避免空符号旧数据每次迁移产生假差异。
function gongcheCandidate(item: GongcheAnnotation): DiffCandidate {
  const label = item.symbols.map((symbol) => symbol.label).join("") || "空工尺谱";
  return candidate(item.id, label, range(item.startTime, item.endTime), {
    parentTrackId: item.parentTrackId,
    parentBlockId: item.parentBlockId,
    startTime: item.startTime,
    endTime: item.endTime,
    symbols: item.symbols.map((symbol) => ({
      label: symbol.label,
      notation: symbol.notation ?? "",
      rawText: symbol.rawText ?? "",
      parenthesized: Boolean(symbol.parenthesized),
      startTime: symbol.startTime,
      endTime: symbol.endTime,
      assetUrl: symbol.assetUrl ?? null,
    })),
  }, {
    parentTrackId: "父轨道",
    parentBlockId: "父文字块",
    startTime: "开始时间",
    endTime: "结束时间",
    symbols: "工尺符号",
  });
}

// 板眼区段比较节奏结构、来源和人工说明，时间范围直接用于后续可视定位。
function banyanSectionCandidate(item: BanyanSection): DiffCandidate {
  return candidate(item.id, item.name, range(item.startTime, item.endTime), {
    name: item.name,
    startTime: item.startTime,
    endTime: item.endTime,
    cycleType: item.cycleType,
    freeRhythm: item.freeRhythm,
    beatCount: item.beatCount ?? null,
    hasZengBan: item.hasZengBan ?? null,
    source: item.source ?? null,
    comment: item.comment ?? null,
  }, {
    name: "名称",
    startTime: "开始时间",
    endTime: "结束时间",
    cycleType: "板式",
    freeRhythm: "自由节奏",
    beatCount: "拍数",
    hasZengBan: "赠板",
    source: "来源",
    comment: "说明",
  });
}

// 板眼点以实际时间定位，并保留自动估计、工尺关联和人工校正等可追溯字段。
function banyanMarkCandidate(item: BanyanMark): DiffCandidate {
  return candidate(item.id, item.sourceSymbol || item.subtype, range(
    item.time,
    item.time,
  ), {
    sectionId: item.sectionId ?? null,
    time: item.time,
    estimatedTime: item.estimatedTime,
    sourceSymbol: item.sourceSymbol,
    sourceTokenIndex: item.sourceTokenIndex ?? null,
    sourceKey: item.sourceKey ?? null,
    role: item.role,
    subtype: item.subtype,
    segment: item.segment,
    beatIndex: item.beatIndex ?? null,
    cycleIndex: item.cycleIndex ?? null,
    strength: item.strength ?? null,
    attachment: item.attachment,
    linkedGongcheAnnotationId: item.linkedGongcheAnnotationId ?? null,
    linkedGongcheSymbolId: item.linkedGongcheSymbolId ?? null,
    linkedGongcheSymbolIds: [...(item.linkedGongcheSymbolIds ?? [])].sort(),
    confidence: item.confidence,
    manualOffset: item.manualOffset ?? null,
    durationHint: item.durationHint ?? null,
    orphaned: Boolean(item.orphaned),
    comment: item.comment ?? null,
  }, {
    sectionId: "板眼区段",
    time: "实际时间",
    estimatedTime: "估计时间",
    sourceSymbol: "来源符号",
    sourceTokenIndex: "来源位置",
    sourceKey: "来源键",
    role: "角色",
    subtype: "类型",
    segment: "节奏段",
    beatIndex: "拍序",
    cycleIndex: "循环序",
    strength: "强弱",
    attachment: "附着关系",
    linkedGongcheAnnotationId: "工尺块关联",
    linkedGongcheSymbolId: "工尺符号关联",
    linkedGongcheSymbolIds: "工尺符号集合",
    confidence: "置信状态",
    manualOffset: "人工偏移",
    durationHint: "时值提示",
    orphaned: "孤立状态",
    comment: "说明",
  });
}

// 自定义轨道比较定义与递归分叉树；块和附属点另行计数，避免同一变化重复出现。
function customTrackCandidate(track: CustomTrack): DiffCandidate {
  return candidate(track.id, track.name, null, {
    name: track.name,
    trackType: track.trackType,
    color: track.color ?? null,
    typeOptions: track.typeOptions,
    branching: track.branching
      ? {
          enabled: track.branching.enabled,
          rootLabel: track.branching.rootLabel ?? null,
          displayMode: track.branching.displayMode,
          lanes: track.branching.lanes.map(canonicalBranchLane),
        }
      : null,
    attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
    snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
    autoSetLoopRangeOnSelect: Boolean(track.autoSetLoopRangeOnSelect),
  }, {
    name: "轨道名称",
    trackType: "轨道类型",
    color: "轨道颜色",
    typeOptions: "类型选项",
    branching: "递归分叉",
    attachedPointTracksExpanded: "附属轨展开状态",
    snapToWaveformKeypoints: "波形吸附",
    autoSetLoopRangeOnSelect: "自动循环范围",
  });
}

// 递归分支保留父子关系和显示顺序；它是保存结构，不展开成时间轴伪轨道。
function canonicalBranchLane(lane: BranchLane): Record<string, unknown> {
  return {
    id: lane.id,
    name: lane.name,
    parentId: lane.parentId,
    color: lane.color ?? null,
    children: (lane.children ?? []).map(canonicalBranchLane),
  };
}

// 自定义块身份包含父轨道，避免不同轨道恰好复用块 id 时发生碰撞。
function customBlockCandidates(tracks: CustomTrack[]): DiffCandidate[] {
  return tracks.flatMap((track) => {
    // 在轨道判别分支内映射块，保留 TypeScript 对文字/动作块联合类型的准确收窄。
    if (track.trackType === "text") {
      return track.blocks.map((block) => customBlockCandidate(
        track.id,
        block,
        block.text,
      ));
    }
    return track.blocks.map((block) => customBlockCandidate(
      track.id,
      block,
      null,
    ));
  });
}

// 文字和动作块除 text 外共享比较字段，集中构造避免两套分叉归属规则分叉。
function customBlockCandidate(
  trackId: string,
  block: CustomTrack["blocks"][number],
  text: string | null,
): DiffCandidate {
  return candidate(
    `${trackId}:${block.id}`,
    text || block.type,
    range(block.startTime, block.endTime),
    {
      trackId,
      startTime: block.startTime,
      endTime: block.endTime,
      type: block.type,
      text,
      branchScope: block.branchScope?.mode === "lanes"
        ? { mode: "lanes", laneIds: [...block.branchScope.laneIds].sort() }
        : block.branchScope ?? null,
      branchGroupId: block.branchGroupId ?? null,
      branchParentBlockId: block.branchParentBlockId ?? null,
    },
    {
      trackId: "所属轨道",
      startTime: "开始时间",
      endTime: "结束时间",
      type: "类型",
      text: "文本",
      branchScope: "分叉归属",
      branchGroupId: "分叉组",
      branchParentBlockId: "父分叉块",
    },
  );
}

// 附属打点领域同时比较轨道定义和点；前缀区分定义与点，避免 id 空间互相碰撞。
function attachedPointCandidates(project: ProjectData): DiffCandidate[] {
  const parentTracks = [
    ...project.builtinTracks.map((track) => ({
      id: track.id,
      pointTracks: track.attachedPointTracks,
    })),
    ...project.customTracks.map((track) => ({
      id: track.id,
      pointTracks: track.attachedPointTracks,
    })),
  ];
  return parentTracks.flatMap((parent) =>
    parent.pointTracks.flatMap((track) => [
      attachedPointTrackCandidate(parent.id, track),
      ...track.points.map((point) => candidate(
        `point:${parent.id}:${track.id}:${point.id}`,
        point.label,
        range(point.time, point.time),
        {
          parentTrackId: parent.id,
          pointTrackId: track.id,
          time: point.time,
          label: point.label,
        },
        {
          parentTrackId: "父轨道",
          pointTrackId: "附属轨道",
          time: "时间",
          label: "类型",
        },
      )),
    ]),
  );
}

// 附属轨定义变化会单独显示，不会被误报成所有点同时修改。
function attachedPointTrackCandidate(
  parentTrackId: string,
  track: AttachedPointTrack,
): DiffCandidate {
  return candidate(
    `point-track:${parentTrackId}:${track.id}`,
    `${track.name}（轨道设置）`,
    null,
    {
      parentTrackId,
      name: track.name,
      typeOptions: track.typeOptions,
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
      snapToParentBoundaries: Boolean(track.snapToParentBoundaries),
      autoSetLoopRangeOnSelect: Boolean(track.autoSetLoopRangeOnSelect),
    },
    {
      parentTrackId: "父轨道",
      name: "轨道名称",
      typeOptions: "类型选项",
      snapToWaveformKeypoints: "波形吸附",
      snapToParentBoundaries: "父边界吸附",
      autoSetLoopRangeOnSelect: "自动循环范围",
    },
  );
}

// 候选项构造器保持所有领域的形状一致，减少比较核心中的分支判断。
function candidate(
  identity: string,
  label: string,
  timeRange: AnnotationDiffTimeRange | null,
  fields: Record<string, unknown>,
  fieldLabels: Record<string, string>,
): DiffCandidate {
  return { identity, label, timeRange, fields, fieldLabels };
}

// 时间范围保持保存精度；本阶段不偷偷引入模糊阈值。
function range(start: number, end: number): AnnotationDiffTimeRange {
  return { start, end };
}

// 手工选择后的对象字段顺序稳定，JSON 序列化在这里仅比较窄值，不比较完整业务对象。
function sameComparableValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// 差异行优先按可定位时间排序，无时间对象再按标签和 id 稳定排序。
function compareDiffEntries(left: AnnotationDiffEntry, right: AnnotationDiffEntry) {
  const leftTime = left.rightTimeRange?.start ?? left.leftTimeRange?.start;
  const rightTime = right.rightTimeRange?.start ?? right.leftTimeRange?.start;
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime !== undefined && rightTime === undefined) return -1;
  if (leftTime === undefined && rightTime !== undefined) return 1;
  return left.label.localeCompare(right.label, "zh-CN") ||
    left.identity.localeCompare(right.identity);
}

// 计数 helper 统一四种变化类型，避免新增领域时漏掉统计字段。
function emptyCounts(): AnnotationDiffCounts {
  return { added: 0, removed: 0, modified: 0, unchanged: 0 };
}

function countEntries(entries: AnnotationDiffEntry[]): AnnotationDiffCounts {
  const counts = emptyCounts();
  for (const entry of entries) {
    counts[entry.changeType] += 1;
  }
  return counts;
}

function addCounts(
  left: AnnotationDiffCounts,
  right: AnnotationDiffCounts,
): AnnotationDiffCounts {
  return Object.fromEntries(CHANGE_TYPES.map((type) => [
    type,
    left[type] + right[type],
  ])) as AnnotationDiffCounts;
}

// 两侧摘要只为头部扫描提供计数，不把完整 ProjectData 再复制进 React state。
function summarizeProject(project: ProjectData): AnnotationDiffSideSummary {
  return {
    videoName: project.video.name,
    subtitleLineCount: project.subtitleLines.length,
    characterCount: project.characterAnnotations.length,
    gongcheCount: project.gongcheAnnotations.length,
    banyanMarkCount: project.banyanMarks.length,
    customTrackCount: project.customTracks.length,
    customBlockCount: project.customTracks.reduce(
      (count, track) => count + track.blocks.length,
      0,
    ),
    attachedPointCount: [
      ...project.builtinTracks,
      ...project.customTracks,
    ].reduce((count, track) => count + track.attachedPointTracks.reduce(
      (trackCount, pointTrack) => trackCount + pointTrack.points.length,
      0,
    ), 0),
  };
}

// 本地视频路径会影响跨设备解释，比较结果应主动提醒而不是把路径当成可移植媒体。
function buildDiffWarnings(left: ProjectData, right: ProjectData): string[] {
  if (
    left.video.requiresManualImport ||
    right.video.requiresManualImport ||
    left.video.filePath ||
    right.video.filePath
  ) {
    return ["至少一侧项目关联本地视频；比较结果不代表媒体文件本身一致。"];
  }
  return [];
}
