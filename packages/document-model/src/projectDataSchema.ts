import { z } from "zod";
import type {
  BranchLane,
  CharacterToneInfo,
  CustomTrack,
  ProjectData,
} from "./projectData.js";

// 当前格式的身份字段必须非空；业务命令依赖这些稳定 id，不能让空字符串进入权威 apply 边界。
const stableIdSchema = z.string().min(1);
const finiteNumberSchema = z.number();
const timeRangeShape = {
  startTime: finiteNumberSchema,
  endTime: finiteNumberSchema,
};

// 区间校验集中复用，避免句、字、工尺和块各自形成略有差异的时间规则。
function withOrderedTimeRange<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({ ...shape, ...timeRangeShape }).refine(
    (value) => {
      // Zod 4 对泛型 object shape 的 refine 输入保留了条件类型；字段本身已由同一 schema 校验为 number。
      const range = value as unknown as { startTime: number; endTime: number };
      return range.endTime >= range.startTime;
    },
    { message: "结束时间不能早于开始时间。", path: ["endTime"] },
  );
}

// 四声附加 subtype 只在上声有意义；运行时边界同时约束主类与原书细分的组合关系。
const characterToneSchema = z.strictObject({
  toneClass: z.enum([
    "yin_ping",
    "yang_ping",
    "yin_shang",
    "yang_shang",
    "yin_qu",
    "yang_qu",
    "yin_ru",
    "yang_ru",
  ]),
  yxlzShangSubtype: z.enum([
    "yin_shang",
    "yang_shang",
    "yinyang_tongyong",
  ]).optional(),
}).superRefine((tone, context) => {
  const isShang = tone.toneClass === "yin_shang" || tone.toneClass === "yang_shang";
  if (!isShang && tone.yxlzShangSubtype !== undefined) {
    context.addIssue({
      code: "custom",
      message: "非上声不能保存《韵学骊珠》上声细分。",
      path: ["yxlzShangSubtype"],
    });
  }
  if (tone.toneClass === "yin_shang" && tone.yxlzShangSubtype !== undefined &&
      tone.yxlzShangSubtype !== "yin_shang") {
    context.addIssue({
      code: "custom",
      message: "阴上只能使用阴上细分。",
      path: ["yxlzShangSubtype"],
    });
  }
  if (tone.toneClass === "yang_shang" && tone.yxlzShangSubtype === "yin_shang") {
    context.addIssue({
      code: "custom",
      message: "阳上不能使用阴上细分。",
      path: ["yxlzShangSubtype"],
    });
  }
}) satisfies z.ZodType<CharacterToneInfo>;

// 递归分叉 schema 使用 lazy 自引用；每一层仍是 strict object，未知字段不会被静默剥离。
const branchLaneSchema: z.ZodType<BranchLane> = z.lazy(() => z.strictObject({
  id: stableIdSchema,
  name: z.string(),
  parentId: stableIdSchema.nullable(),
  color: z.string().optional(),
  children: z.array(branchLaneSchema).optional(),
}));

const branchScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("root") }),
  z.strictObject({
    mode: z.literal("lanes"),
    laneIds: z.array(stableIdSchema).min(1).refine(
      (ids) => new Set(ids).size === ids.length,
      "分叉归属不能包含重复 lane id。",
    ),
  }),
]);

const trackBranchingSchema = z.strictObject({
  enabled: z.boolean(),
  rootLabel: z.string().optional(),
  displayMode: z.enum(["merged", "expanded"]),
  lanes: z.array(branchLaneSchema),
});

const attachedPointSchema = z.strictObject({
  id: stableIdSchema,
  time: finiteNumberSchema,
  label: z.string(),
});

const attachedPointTrackSchema = z.strictObject({
  id: stableIdSchema,
  name: z.string(),
  typeOptions: z.array(z.string()),
  points: z.array(attachedPointSchema),
  snapToWaveformKeypoints: z.boolean().optional(),
  snapToParentBoundaries: z.boolean().optional(),
  autoSetLoopRangeOnSelect: z.boolean().optional(),
});

const subtitleLineSchema = withOrderedTimeRange({
  id: stableIdSchema,
  text: z.string(),
});

const characterAnnotationSchema = withOrderedTimeRange({
  id: stableIdSchema,
  lineId: stableIdSchema,
  char: z.string(),
  singingStyle: z.string(),
  tone: characterToneSchema.nullable().optional(),
});

const gongcheSymbolSchema = withOrderedTimeRange({
  id: stableIdSchema,
  label: z.string(),
  notation: z.string().optional(),
  rawText: z.string().optional(),
  parenthesized: z.boolean().optional(),
  assetUrl: z.string().nullable().optional(),
});

const gongcheAnnotationSchema = withOrderedTimeRange({
  id: stableIdSchema,
  parentTrackId: stableIdSchema,
  parentBlockId: stableIdSchema,
  symbols: z.array(gongcheSymbolSchema),
});

const banyanSectionSchema = withOrderedTimeRange({
  id: stableIdSchema,
  name: z.string(),
  cycleType: z.enum([
    "sanban",
    "liushuiban",
    "yi_ban_yi_yan",
    "yi_ban_yi_yan_zeng",
    "yi_ban_san_yan",
    "yi_ban_san_yan_zeng",
    "custom",
  ]),
  freeRhythm: z.boolean(),
  beatCount: z.number().int().nonnegative().optional(),
  hasZengBan: z.boolean().optional(),
  source: z.string().optional(),
  comment: z.string().optional(),
});

const banyanMarkSchema = z.strictObject({
  id: stableIdSchema,
  sectionId: stableIdSchema.nullable().optional(),
  time: finiteNumberSchema,
  estimatedTime: finiteNumberSchema,
  sourceSymbol: z.string(),
  sourceTokenIndex: z.number().int().nonnegative().optional(),
  sourceKey: z.string().optional(),
  role: z.enum(["ban", "yan", "auxiliary"]),
  subtype: z.enum([
    "mainBan",
    "headBan",
    "waistBan",
    "bottomBan",
    "zengBan",
    "waistZengBan",
    "middleEye",
    "smallEye",
    "sideHeadTailEye",
    "sideMiddleEye",
    "phraseBoundary",
    "unknown",
  ]),
  segment: z.enum(["main", "zeng", "free", "unknown"]),
  beatIndex: z.number().int().nullable().optional(),
  cycleIndex: z.number().int().nullable().optional(),
  strength: z.enum(["strong", "medium", "weak", "unknown"]).optional(),
  attachment: z.enum(["on_note", "in_between", "at_phrase_end", "unknown"]),
  linkedGongcheAnnotationId: stableIdSchema.nullable().optional(),
  linkedGongcheSymbolId: stableIdSchema.nullable().optional(),
  linkedGongcheSymbolIds: z.array(stableIdSchema).optional(),
  confidence: z.enum(["auto", "reviewed", "manual"]),
  manualOffset: finiteNumberSchema.optional(),
  durationHint: z.string().nullable().optional(),
  orphaned: z.boolean().optional(),
  comment: z.string().optional(),
});

const actionAnnotationSchema = withOrderedTimeRange({
  id: stableIdSchema,
  trackId: stableIdSchema,
  label: z.string(),
});

const customTextBlockSchema = withOrderedTimeRange({
  id: stableIdSchema,
  text: z.string(),
  type: z.string(),
  branchScope: branchScopeSchema.optional(),
  branchGroupId: z.string().optional(),
  branchParentBlockId: z.string().optional(),
});

const customActionBlockSchema = withOrderedTimeRange({
  id: stableIdSchema,
  type: z.string(),
  branchScope: branchScopeSchema.optional(),
  branchGroupId: z.string().optional(),
  branchParentBlockId: z.string().optional(),
});

// 自定义文字轨和动作轨共享配置，但块结构保持 discriminated union，防止动作块混入 text 字段。
const customTrackCommonShape = {
  id: stableIdSchema,
  name: z.string(),
  color: z.string().optional(),
  typeOptions: z.array(z.string()),
  attachedPointTracks: z.array(attachedPointTrackSchema),
  branching: trackBranchingSchema.optional(),
  attachedPointTracksExpanded: z.boolean().optional(),
  snapToWaveformKeypoints: z.boolean().optional(),
  autoSetLoopRangeOnSelect: z.boolean().optional(),
};
const customTrackSchema = z.discriminatedUnion("trackType", [
  z.strictObject({
    ...customTrackCommonShape,
    trackType: z.literal("text"),
    blocks: z.array(customTextBlockSchema),
  }),
  z.strictObject({
    ...customTrackCommonShape,
    trackType: z.literal("action"),
    blocks: z.array(customActionBlockSchema),
  }),
]) satisfies z.ZodType<CustomTrack>;

const builtinTrackSchema = z.strictObject({
  id: z.literal("character-track"),
  name: z.string(),
  type: z.enum(["character", "action"]),
  options: z.array(z.string()).optional(),
  attachedPointTracks: z.array(attachedPointTrackSchema),
  attachedPointTracksExpanded: z.boolean().optional(),
  snapToWaveformKeypoints: z.boolean().optional(),
  autoSetLoopRangeOnSelect: z.boolean().optional(),
});

// 顶层 schema 是平台命令执行前的权威当前格式门禁，不承担旧文件迁移或业务引用修复。
export const currentProjectDataSchema = z.strictObject({
  video: z.strictObject({
    url: z.string(),
    name: z.string().nullable(),
    source: z.enum(["url", "embedded"]),
    filePath: z.string().nullable().optional(),
    requiresManualImport: z.boolean().optional(),
  }),
  subtitleLines: z.array(subtitleLineSchema),
  characterAnnotations: z.array(characterAnnotationSchema),
  gongcheAnnotations: z.array(gongcheAnnotationSchema),
  banyanSections: z.array(banyanSectionSchema),
  banyanMarks: z.array(banyanMarkSchema),
  actionAnnotations: z.array(actionAnnotationSchema),
  builtinTracks: z.array(builtinTrackSchema),
  customTracks: z.array(customTrackSchema),
  activeTrackOrder: z.array(stableIdSchema),
}).superRefine((project, context) => {
  // 分叉树的 parentId 与实际嵌套位置必须一致，lane id 也必须在单轨内唯一。
  for (const [trackIndex, track] of project.customTracks.entries()) {
    if (!track.branching) continue;
    const laneIds = new Set<string>();
    const stack = track.branching.lanes.map((lane, laneIndex) => ({
      lane,
      expectedParentId: null as string | null,
      path: ["customTracks", trackIndex, "branching", "lanes", laneIndex] as Array<string | number>,
    }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      if (current.lane.parentId !== current.expectedParentId) {
        context.addIssue({
          code: "custom",
          message: "分叉 parentId 与递归嵌套位置不一致。",
          path: [...current.path, "parentId"],
        });
      }
      if (laneIds.has(current.lane.id)) {
        context.addIssue({
          code: "custom",
          message: "同一轨道的分叉 lane id 不能重复。",
          path: [...current.path, "id"],
        });
      }
      laneIds.add(current.lane.id);
      for (const [childIndex, child] of (current.lane.children ?? []).entries()) {
        stack.push({
          lane: child,
          expectedParentId: current.lane.id,
          path: [...current.path, "children", childIndex],
        });
      }
    }
    // lanes 作用域只允许引用当前轨道真实分叉，避免命令 resolver 在不存在的 lane 上形成幽灵归属。
    for (const [blockIndex, block] of track.blocks.entries()) {
      if (block.branchScope?.mode !== "lanes") continue;
      for (const [laneIdIndex, laneId] of block.branchScope.laneIds.entries()) {
        if (!laneIds.has(laneId)) {
          context.addIssue({
            code: "custom",
            message: "块的分叉归属引用了不存在的 lane id。",
            path: ["customTracks", trackIndex, "blocks", blockIndex, "branchScope", "laneIds", laneIdIndex],
          });
        }
      }
    }
  }
}) satisfies z.ZodType<ProjectData>;

export type ProjectDataValidationIssue = {
  path: Array<string | number>;
  code: string;
  message: string;
};

export type ProjectDataValidationResult =
  | { success: true; data: ProjectData }
  | { success: false; issues: ProjectDataValidationIssue[] };

// API 只消费精简、可序列化的问题信息，不能把 Zod 实例或完整数据库 payload 放入错误响应。
export function parseCurrentProjectData(value: unknown): ProjectDataValidationResult {
  // 先用迭代扫描限制通用 JSON 深度，避免恶意递归对象在 Zod lazy schema 中耗尽调用栈。
  if (!hasBoundedObjectDepth(value, 64)) {
    return {
      success: false,
      issues: [{ path: [], code: "too_deep", message: "项目文档嵌套层级超过 64 层。" }],
    };
  }
  const result = currentProjectDataSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => typeof segment === "symbol" ? String(segment) : segment),
      code: issue.code,
      message: issue.message,
    })),
  };
}

// 数据库 JSON 不会包含循环引用，但该公开 parser 也会被测试和服务层直接调用，因此循环对象同样 fail closed。
function hasBoundedObjectDepth(value: unknown, maxDepth: number) {
  const stack: Array<{ value: unknown; depth: number; ancestors: Set<object> }> = [{
    value,
    depth: 0,
    ancestors: new Set(),
  }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.value === null || typeof current.value !== "object") continue;
    if (current.depth > maxDepth || current.ancestors.has(current.value)) return false;
    const nextAncestors = new Set(current.ancestors);
    nextAncestors.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1, ancestors: nextAncestors });
    }
  }
  return true;
}
