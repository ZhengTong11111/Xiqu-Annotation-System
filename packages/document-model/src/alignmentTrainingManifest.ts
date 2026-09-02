import { z } from "zod";
import {
  ALIGNMENT_QUALITY_ISSUE_CODES,
  ALIGNMENT_TRAINING_CANDIDATE_SIGNALS,
  type AlignmentQualityIssueCode,
  type AlignmentTrainingCandidateSignal,
} from "@xiqu/shared";
import { ALIGNMENT_PREDICTION_FORMAT_VERSION } from "./alignmentPrediction.js";

export const ALIGNMENT_TRAINING_MANIFEST_FORMAT = "xiqu-alignment-training-manifest";
export const ALIGNMENT_TRAINING_MANIFEST_VERSION = 1;
export const ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS = 10_000;
export const ALIGNMENT_TRAINING_MANIFEST_MAX_GROUPS_PER_ITEM = 32;
export const ALIGNMENT_TRAINING_MANIFEST_MAX_ASSESSMENTS_PER_ITEM = 500;
export const ALIGNMENT_TRAINING_SPLITS = ["train", "validation", "test"] as const;
export const ALIGNMENT_TRAINING_GROUP_KINDS = ["work", "performer"] as const;
export const DEFAULT_ALIGNMENT_TRAINING_SPLIT_RATIOS = {
  train: 8_000,
  validation: 1_000,
  test: 1_000,
} as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_BUCKET_COUNT = 10_000n;
const UINT64_RANGE = 1n << 64n;
const UINT64_REJECTION_LIMIT = UINT64_RANGE - (UINT64_RANGE % HASH_BUCKET_COUNT);

export type AlignmentTrainingSplit = typeof ALIGNMENT_TRAINING_SPLITS[number];
export type AlignmentTrainingGroupKind = typeof ALIGNMENT_TRAINING_GROUP_KINDS[number];
export type AlignmentTrainingTargetMode = "prediction" | "manual_revision";
export type AlignmentTrainingSha256Hex = (input: string) => string;

export type AlignmentTrainingSplitRatios = {
  train: number;
  validation: number;
  test: number;
};

export type AlignmentTrainingGroupReference = {
  kind: AlignmentTrainingGroupKind;
  id: string;
};

export type AlignmentTrainingSampleDraft = {
  alignmentApplicationId: string;
  alignmentRunId: string;
  alignmentArtifactId: string;
  annotationFileId: string;
  baseRevision: number;
  committedRevision: number;
  observationEndRevision: number;
  artifact: {
    checksum: string;
    size: number;
    formatVersion: number;
  };
  predictionSummaryState: "ready" | "missing" | "invalid";
  evidenceState: "complete" | "partial" | "invalid";
  unrated: boolean;
  manualTiming: {
    operationCount: number;
    editedCharacterCount: number;
    totalBoundaryDeltaMicros: number;
    maxBoundaryDeltaMicros: number;
  };
  quality: {
    verdict: "correct" | "needs_adjustment" | "unusable";
    issueCodes: AlignmentQualityIssueCode[];
    assessmentIds: string[];
  };
  signals: AlignmentTrainingCandidateSignal[];
  groupReferences: AlignmentTrainingGroupReference[];
};

export type AlignmentTrainingManifestItem = {
  alignmentApplicationId: string;
  alignmentRunId: string;
  alignmentArtifactId: string;
  annotationFileId: string;
  baseRevision: number;
  committedRevision: number;
  observationEndRevision: number;
  artifact: {
    checksum: string;
    size: number;
    formatVersion: number;
  };
  predictionSummaryState: "ready" | "missing";
  target: {
    mode: AlignmentTrainingTargetMode;
    revision: number;
  };
  manualTiming: AlignmentTrainingSampleDraft["manualTiming"];
  quality: {
    verdict: "correct" | "needs_adjustment";
    issueCodes: AlignmentQualityIssueCode[];
    assessmentIds: string[];
  };
  signals: AlignmentTrainingCandidateSignal[];
  groupComponentHash: string;
  split: AlignmentTrainingSplit;
};

type AlignmentTrainingSplitCount = {
  items: number;
  components: number;
};

export type AlignmentTrainingManifestV1 = {
  format: typeof ALIGNMENT_TRAINING_MANIFEST_FORMAT;
  version: typeof ALIGNMENT_TRAINING_MANIFEST_VERSION;
  checksum: string;
  splitSeedHash: string;
  splitRatios: AlignmentTrainingSplitRatios;
  sampleCount: number;
  componentCount: number;
  splitCounts: Record<AlignmentTrainingSplit, AlignmentTrainingSplitCount>;
  items: AlignmentTrainingManifestItem[];
};

export type AlignmentTrainingManifestResult =
  | { ok: true; manifest: AlignmentTrainingManifestV1; canonicalJson: string }
  | { ok: false; issues: string[] };

export type AlignmentTrainingManifestParseResult =
  | { ok: true; value: AlignmentTrainingManifestV1; canonicalJson: string }
  | { ok: false; issues: string[] };

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuidSchema = z.string().regex(UUID_PATTERN, "必须是规范小写 UUID。");
const sha256Schema = z.string().regex(SHA256_PATTERN, "必须是小写 SHA-256。");
const splitRatiosSchema = z.object({
  train: z.number().int().nonnegative().max(10_000),
  validation: z.number().int().nonnegative().max(10_000),
  test: z.number().int().nonnegative().max(10_000),
}).strict();
const manualTimingSchema = z.object({
  operationCount: nonNegativeSafeIntegerSchema,
  editedCharacterCount: nonNegativeSafeIntegerSchema,
  totalBoundaryDeltaMicros: nonNegativeSafeIntegerSchema,
  maxBoundaryDeltaMicros: nonNegativeSafeIntegerSchema,
}).strict();
const qualitySchema = z.object({
  verdict: z.enum(["correct", "needs_adjustment"]),
  issueCodes: z.array(z.enum(ALIGNMENT_QUALITY_ISSUE_CODES)),
  assessmentIds: z.array(uuidSchema)
    .min(1)
    .max(ALIGNMENT_TRAINING_MANIFEST_MAX_ASSESSMENTS_PER_ITEM),
}).strict();
const targetSchema = z.object({
  mode: z.enum(["prediction", "manual_revision"]),
  revision: positiveSafeIntegerSchema,
}).strict();
const manifestItemSchema = z.object({
  alignmentApplicationId: uuidSchema,
  alignmentRunId: uuidSchema,
  alignmentArtifactId: uuidSchema,
  annotationFileId: uuidSchema,
  baseRevision: nonNegativeSafeIntegerSchema,
  committedRevision: positiveSafeIntegerSchema,
  observationEndRevision: positiveSafeIntegerSchema,
  artifact: z.object({
    checksum: sha256Schema,
    size: positiveSafeIntegerSchema,
    formatVersion: z.literal(ALIGNMENT_PREDICTION_FORMAT_VERSION),
  }).strict(),
  predictionSummaryState: z.enum(["ready", "missing"]),
  target: targetSchema,
  manualTiming: manualTimingSchema,
  quality: qualitySchema,
  signals: z.array(z.enum(ALIGNMENT_TRAINING_CANDIDATE_SIGNALS)),
  groupComponentHash: sha256Schema,
  split: z.enum(ALIGNMENT_TRAINING_SPLITS),
}).strict();
const splitCountSchema = z.object({
  items: nonNegativeSafeIntegerSchema,
  components: nonNegativeSafeIntegerSchema,
}).strict();
const manifestSchema = z.object({
  format: z.literal(ALIGNMENT_TRAINING_MANIFEST_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_MANIFEST_VERSION),
  checksum: sha256Schema,
  splitSeedHash: sha256Schema,
  splitRatios: splitRatiosSchema,
  sampleCount: positiveSafeIntegerSchema.max(ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS),
  componentCount: positiveSafeIntegerSchema.max(ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS),
  splitCounts: z.object({
    train: splitCountSchema,
    validation: splitCountSchema,
    test: splitCountSchema,
  }).strict(),
  items: z.array(manifestItemSchema)
    .min(1)
    .max(ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS),
}).strict();

const draftSchema = z.object({
  alignmentApplicationId: uuidSchema,
  alignmentRunId: uuidSchema,
  alignmentArtifactId: uuidSchema,
  annotationFileId: uuidSchema,
  baseRevision: nonNegativeSafeIntegerSchema,
  committedRevision: positiveSafeIntegerSchema,
  observationEndRevision: positiveSafeIntegerSchema,
  artifact: z.object({
    checksum: sha256Schema,
    size: positiveSafeIntegerSchema,
    formatVersion: z.literal(ALIGNMENT_PREDICTION_FORMAT_VERSION),
  }).strict(),
  predictionSummaryState: z.enum(["ready", "missing", "invalid"]),
  evidenceState: z.enum(["complete", "partial", "invalid"]),
  unrated: z.boolean(),
  manualTiming: manualTimingSchema,
  quality: z.object({
    verdict: z.enum(["correct", "needs_adjustment", "unusable"]),
    issueCodes: z.array(z.enum(ALIGNMENT_QUALITY_ISSUE_CODES)),
    assessmentIds: z.array(uuidSchema)
      .min(1)
      .max(ALIGNMENT_TRAINING_MANIFEST_MAX_ASSESSMENTS_PER_ITEM),
  }).strict(),
  signals: z.array(z.enum(ALIGNMENT_TRAINING_CANDIDATE_SIGNALS)),
  groupReferences: z.array(z.object({
    kind: z.enum(ALIGNMENT_TRAINING_GROUP_KINDS),
    id: uuidSchema,
  }).strict()).min(1).max(ALIGNMENT_TRAINING_MANIFEST_MAX_GROUPS_PER_ITEM),
}).strict();

/**
 * 纯 planner 接收已经由未来服务端事务复核的冻结事实。哈希函数由调用边界注入，
 * document-model 因此不依赖 Node crypto，也不会为了浏览器兼容手写密码学实现。
 */
export function buildAlignmentTrainingManifest(
  input: {
    splitSeedHash: string;
    splitRatios?: AlignmentTrainingSplitRatios;
    samples: AlignmentTrainingSampleDraft[];
  },
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingManifestResult {
  const issues: string[] = [];
  if (!SHA256_PATTERN.test(input.splitSeedHash)) {
    issues.push("splitSeedHash 必须是小写 SHA-256。");
  }
  const ratios = input.splitRatios ?? DEFAULT_ALIGNMENT_TRAINING_SPLIT_RATIOS;
  const parsedRatios = splitRatiosSchema.safeParse(ratios);
  if (!parsedRatios.success || sumRatios(parsedRatios.data) !== 10_000) {
    issues.push("splitRatios 必须是总和为 10000 的非负整数。");
  }
  if (
    !Array.isArray(input.samples) ||
    input.samples.length < 1 ||
    input.samples.length > ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS
  ) {
    issues.push(`训练 manifest 必须包含 1 到 ${ALIGNMENT_TRAINING_MANIFEST_MAX_ITEMS} 个样本。`);
  }

  const samples: AlignmentTrainingSampleDraft[] = [];
  for (const [index, value] of (Array.isArray(input.samples) ? input.samples : []).entries()) {
    const parsed = draftSchema.safeParse(value);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.slice(0, 10).map((issue) =>
        `samples.${index}.${issue.path.join(".")}: ${issue.message}`));
      continue;
    }
    samples.push(parsed.data as AlignmentTrainingSampleDraft);
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 50) };

  const applicationIds = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    validateDraftSemantics(sample, index, applicationIds, issues);
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 50) };

  const parent = samples.map((_, index) => index);
  const firstSampleByGroup = new Map<string, number>();
  for (const [sampleIndex, sample] of samples.entries()) {
    for (const group of sample.groupReferences) {
      const key = groupKey(group);
      const first = firstSampleByGroup.get(key);
      if (first === undefined) firstSampleByGroup.set(key, sampleIndex);
      else union(parent, first, sampleIndex);
    }
  }

  // 先完成全部 union，再按最终根收集样本；共享分组的传递闭包因此不会被输入顺序拆散。
  const samplesByRoot = new Map<number, number[]>();
  for (const sampleIndex of samples.keys()) {
    const root = find(parent, sampleIndex);
    const members = samplesByRoot.get(root) ?? [];
    members.push(sampleIndex);
    samplesByRoot.set(root, members);
  }

  const components = [...samplesByRoot.values()].map((memberIndexes) => {
    const componentGroups = [...new Set(memberIndexes.flatMap((index) =>
      samples[index]!.groupReferences.map(groupKey)))].sort();
    // 分量身份只依赖稳定研究分组。以后同一分组增补样本时，不应因为 application 集合变化而跳到另一 split。
    const componentHash = checkedSha256Hex(
      canonicalAlignmentTrainingJson({
        version: 1,
        groupReferences: componentGroups,
      }),
      sha256Hex,
      "groupComponentHash",
      issues,
    );
    const split = componentHash
      ? chooseSplit(input.splitSeedHash, componentHash, ratios, sha256Hex, issues)
      : null;
    return { memberIndexes, componentHash, split };
  });
  if (issues.length > 0 || components.some(({ componentHash, split }) => !componentHash || !split)) {
    return { ok: false, issues: issues.slice(0, 50) };
  }

  const items: AlignmentTrainingManifestItem[] = [];
  for (const component of components) {
    for (const sampleIndex of component.memberIndexes) {
      const sample = samples[sampleIndex]!;
      const item = toManifestItem(
        sample,
        component.componentHash!,
        component.split!,
      );
      if (item) items.push(item);
      else issues.push(`samples.${sampleIndex} 未通过训练目标收敛。`);
    }
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 50) };
  items.sort(compareManifestItems);
  const splitCounts = buildSplitCounts(items);
  const manifestWithoutChecksum: Omit<AlignmentTrainingManifestV1, "checksum"> = {
    format: ALIGNMENT_TRAINING_MANIFEST_FORMAT,
    version: ALIGNMENT_TRAINING_MANIFEST_VERSION,
    splitSeedHash: input.splitSeedHash,
    splitRatios: { ...ratios },
    sampleCount: items.length,
    componentCount: components.length,
    splitCounts,
    items,
  };
  const checksum = checkedSha256Hex(
    canonicalAlignmentTrainingJson(manifestWithoutChecksum),
    sha256Hex,
    "manifest checksum",
    issues,
  );
  if (!checksum) return { ok: false, issues: issues.slice(0, 50) };
  const manifest: AlignmentTrainingManifestV1 = { ...manifestWithoutChecksum, checksum };
  return { ok: true, manifest, canonicalJson: canonicalAlignmentTrainingJson(manifest) };
}

/** unknown 入口同时验证 exact keys、聚合、排序、目标语义和注入的 SHA-256。 */
export function parseAlignmentTrainingManifest(
  value: unknown,
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingManifestParseResult {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 50).map((issue) =>
        `${issue.path.join(".") || "manifest"}: ${issue.message}`),
    };
  }
  const manifest = parsed.data as AlignmentTrainingManifestV1;
  const issues = validateManifestSemantics(manifest);
  const expectedChecksum = checkedSha256Hex(
    buildAlignmentTrainingManifestChecksumInput(manifest),
    sha256Hex,
    "manifest checksum",
    issues,
  );
  if (expectedChecksum && expectedChecksum !== manifest.checksum) {
    issues.push("manifest checksum 与规范内容不一致。");
  }
  return issues.length > 0
    ? { ok: false, issues: issues.slice(0, 50) }
    : { ok: true, value: manifest, canonicalJson: canonicalAlignmentTrainingJson(manifest) };
}

/** checksum 明确排除自身；API/worker 只能对这一份 canonical 输入计算 SHA-256。 */
export function buildAlignmentTrainingManifestChecksumInput(
  manifest: AlignmentTrainingManifestV1,
) {
  const { checksum: _checksum, ...content } = manifest;
  return canonicalAlignmentTrainingJson(content);
}

function validateDraftSemantics(
  sample: AlignmentTrainingSampleDraft,
  index: number,
  applicationIds: Set<string>,
  issues: string[],
) {
  const prefix = `samples.${index}`;
  if (applicationIds.has(sample.alignmentApplicationId)) {
    issues.push(`${prefix}.alignmentApplicationId 重复。`);
  }
  applicationIds.add(sample.alignmentApplicationId);
  if (sample.committedRevision !== sample.baseRevision + 1) {
    issues.push(`${prefix} 的 application revision 不连续。`);
  }
  if (sample.observationEndRevision < sample.committedRevision) {
    issues.push(`${prefix}.observationEndRevision 早于 application revision。`);
  }
  if (sample.evidenceState !== "complete" || sample.unrated) {
    issues.push(`${prefix} 尚无完整且已评价的训练证据。`);
  }
  if (sample.predictionSummaryState === "invalid") {
    issues.push(`${prefix} 的 prediction summary 已损坏。`);
  }
  validateUniqueValues(sample.signals, `${prefix}.signals`, issues);
  validateUniqueValues(sample.quality.issueCodes, `${prefix}.quality.issueCodes`, issues);
  validateUniqueValues(sample.quality.assessmentIds, `${prefix}.quality.assessmentIds`, issues);
  validateUniqueGroupReferences(sample.groupReferences, prefix, issues);
  validateManualTiming(sample.manualTiming, prefix, issues);

  const hasManualSignal = sample.signals.includes("manual_timing_adjustment");
  const hasNegativeSignal = sample.signals.includes("negative_quality_assessment");
  if (sample.quality.verdict === "unusable") {
    issues.push(`${prefix} 的不可用结果不能进入训练 manifest。`);
  } else if (sample.quality.verdict === "correct") {
    if (sample.quality.issueCodes.length > 0 || hasNegativeSignal || hasManualSignal ||
        sample.manualTiming.editedCharacterCount > 0) {
      issues.push(`${prefix} 的正确结论与人工修改或异常证据冲突。`);
    }
  } else if (
    sample.quality.issueCodes.length < 1 ||
    !hasNegativeSignal ||
    !hasManualSignal ||
    sample.manualTiming.editedCharacterCount < 1
  ) {
    issues.push(`${prefix} 的需修改结论必须同时具有异常原因和人工 timing 修订。`);
  }
}

function validateManifestSemantics(manifest: AlignmentTrainingManifestV1) {
  const issues: string[] = [];
  if (sumRatios(manifest.splitRatios) !== 10_000) {
    issues.push("splitRatios 总和必须为 10000。");
  }
  if (manifest.sampleCount !== manifest.items.length) {
    issues.push("sampleCount 与 items 数量不一致。");
  }
  const applicationIds = new Set<string>();
  const splitByComponent = new Map<string, AlignmentTrainingSplit>();
  for (const [index, item] of manifest.items.entries()) {
    if (applicationIds.has(item.alignmentApplicationId)) {
      issues.push(`items.${index}.alignmentApplicationId 重复。`);
    }
    applicationIds.add(item.alignmentApplicationId);
    const previousSplit = splitByComponent.get(item.groupComponentHash);
    if (previousSplit && previousSplit !== item.split) {
      issues.push(`items.${index}.groupComponentHash 被拆分到多个 split。`);
    }
    splitByComponent.set(item.groupComponentHash, item.split);
    if (item.committedRevision !== item.baseRevision + 1 ||
        item.observationEndRevision < item.committedRevision) {
      issues.push(`items.${index} 的 revision 关系不正确。`);
    }
    validateUniqueCanonicalValues(item.signals, ALIGNMENT_TRAINING_CANDIDATE_SIGNALS, `items.${index}.signals`, issues);
    validateUniqueCanonicalValues(item.quality.issueCodes, ALIGNMENT_QUALITY_ISSUE_CODES, `items.${index}.quality.issueCodes`, issues);
    validateUniqueSortedValues(item.quality.assessmentIds, `items.${index}.quality.assessmentIds`, issues);
    validateManualTiming(item.manualTiming, `items.${index}`, issues);
    if (item.target.mode === "prediction") {
      if (item.target.revision !== item.committedRevision || item.quality.verdict !== "correct" ||
          item.quality.issueCodes.length > 0 || item.manualTiming.editedCharacterCount > 0 ||
          item.signals.includes("negative_quality_assessment") ||
          item.signals.includes("manual_timing_adjustment")) {
        issues.push(`items.${index} 的 prediction target 与正确结论不一致。`);
      }
    } else if (
      item.target.revision !== item.observationEndRevision ||
      item.quality.verdict !== "needs_adjustment" ||
      item.quality.issueCodes.length < 1 ||
      item.manualTiming.editedCharacterCount < 1 ||
      !item.signals.includes("negative_quality_assessment") ||
      !item.signals.includes("manual_timing_adjustment")
    ) {
      issues.push(`items.${index} 的 manual target 与人工修订证据不一致。`);
    }
  }
  if (manifest.componentCount !== splitByComponent.size) {
    issues.push("componentCount 与分量数量不一致。");
  }
  const expectedCounts = buildSplitCounts(manifest.items);
  if (canonicalAlignmentTrainingJson(expectedCounts) !== canonicalAlignmentTrainingJson(manifest.splitCounts)) {
    issues.push("splitCounts 与 items 不一致。");
  }
  const sorted = [...manifest.items].sort(compareManifestItems);
  if (sorted.some((item, index) => item.alignmentApplicationId !== manifest.items[index]?.alignmentApplicationId)) {
    issues.push("items 未按规范 split/component/application 顺序排列。");
  }
  return issues;
}

function validateManualTiming(
  timing: AlignmentTrainingSampleDraft["manualTiming"],
  prefix: string,
  issues: string[],
) {
  const empty = timing.operationCount === 0 &&
    timing.editedCharacterCount === 0 &&
    timing.totalBoundaryDeltaMicros === 0 &&
    timing.maxBoundaryDeltaMicros === 0;
  const populated = timing.operationCount > 0 &&
    timing.editedCharacterCount > 0 &&
    timing.totalBoundaryDeltaMicros > 0 &&
    timing.maxBoundaryDeltaMicros > 0 &&
    timing.maxBoundaryDeltaMicros <= timing.totalBoundaryDeltaMicros;
  if (!empty && !populated) issues.push(`${prefix}.manualTiming 计数与边界改变量不自洽。`);
}

function validateUniqueGroupReferences(
  groups: AlignmentTrainingGroupReference[],
  prefix: string,
  issues: string[],
) {
  const keys = groups.map(groupKey);
  if (new Set(keys).size !== keys.length) issues.push(`${prefix}.groupReferences 包含重复分组。`);
}

function validateUniqueValues(
  values: readonly string[],
  prefix: string,
  issues: string[],
) {
  if (new Set(values).size !== values.length) issues.push(`${prefix} 包含重复值。`);
}

function validateUniqueSortedValues(
  values: readonly string[],
  prefix: string,
  issues: string[],
) {
  validateUniqueValues(values, prefix, issues);
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    issues.push(`${prefix} 必须按字典序排列。`);
  }
}

function validateUniqueCanonicalValues<T extends string>(
  values: readonly T[],
  order: readonly T[],
  prefix: string,
  issues: string[],
) {
  if (new Set(values).size !== values.length) issues.push(`${prefix} 包含重复值。`);
  const rank = new Map(order.map((value, index) => [value, index]));
  if (values.some((value, index) => index > 0 && rank.get(value)! <= rank.get(values[index - 1]!)!)) {
    issues.push(`${prefix} 未按固定枚举顺序排列。`);
  }
}

function toManifestItem(
  sample: AlignmentTrainingSampleDraft,
  groupComponentHash: string,
  split: AlignmentTrainingSplit,
): AlignmentTrainingManifestItem | null {
  if (sample.predictionSummaryState === "invalid" || sample.quality.verdict === "unusable") {
    return null;
  }
  const needsAdjustment = sample.quality.verdict === "needs_adjustment";
  return {
    alignmentApplicationId: sample.alignmentApplicationId,
    alignmentRunId: sample.alignmentRunId,
    alignmentArtifactId: sample.alignmentArtifactId,
    annotationFileId: sample.annotationFileId,
    baseRevision: sample.baseRevision,
    committedRevision: sample.committedRevision,
    observationEndRevision: sample.observationEndRevision,
    artifact: { ...sample.artifact },
    predictionSummaryState: sample.predictionSummaryState,
    target: {
      mode: needsAdjustment ? "manual_revision" : "prediction",
      revision: needsAdjustment ? sample.observationEndRevision : sample.committedRevision,
    },
    manualTiming: { ...sample.manualTiming },
    quality: {
      verdict: needsAdjustment ? "needs_adjustment" : "correct",
      issueCodes: sortByFixedOrder(sample.quality.issueCodes, ALIGNMENT_QUALITY_ISSUE_CODES),
      assessmentIds: [...sample.quality.assessmentIds].sort(),
    },
    signals: sortByFixedOrder(sample.signals, ALIGNMENT_TRAINING_CANDIDATE_SIGNALS),
    groupComponentHash,
    split,
  };
}

function buildSplitCounts(items: readonly AlignmentTrainingManifestItem[]) {
  const componentSets = new Map<AlignmentTrainingSplit, Set<string>>(
    ALIGNMENT_TRAINING_SPLITS.map((split) => [split, new Set<string>()]),
  );
  const counts: Record<AlignmentTrainingSplit, AlignmentTrainingSplitCount> = {
    train: { items: 0, components: 0 },
    validation: { items: 0, components: 0 },
    test: { items: 0, components: 0 },
  };
  for (const item of items) {
    counts[item.split].items += 1;
    componentSets.get(item.split)!.add(item.groupComponentHash);
  }
  for (const split of ALIGNMENT_TRAINING_SPLITS) {
    counts[split].components = componentSets.get(split)!.size;
  }
  return counts;
}

function chooseSplit(
  splitSeedHash: string,
  componentHash: string,
  ratios: AlignmentTrainingSplitRatios,
  sha256Hex: AlignmentTrainingSha256Hex,
  issues: string[],
): AlignmentTrainingSplit | null {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const digest = checkedSha256Hex(
      `xiqu:alignment-training-split:v1:${splitSeedHash}:${componentHash}:${attempt}`,
      sha256Hex,
      "split hash",
      issues,
    );
    if (!digest) return null;
    const value = BigInt(`0x${digest.slice(0, 16)}`);
    // 拒绝 2^64 除以 10000 的余数区间，避免简单取模给少数 bucket 轻微额外权重。
    if (value >= UINT64_REJECTION_LIMIT) continue;
    const bucket = Number(value % HASH_BUCKET_COUNT);
    if (bucket < ratios.train) return "train";
    if (bucket < ratios.train + ratios.validation) return "validation";
    return "test";
  }
  issues.push("split hash 连续落入拒绝区间，无法稳定分配。");
  return null;
}

/** 草案允许数据库以任意顺序返回有限枚举；只有 manifest 的规范数组顺序参与 checksum。 */
function sortByFixedOrder<T extends string>(values: readonly T[], order: readonly T[]) {
  const rank = new Map(order.map((value, index) => [value, index]));
  return [...values].sort((left, right) => rank.get(left)! - rank.get(right)!);
}

function checkedSha256Hex(
  input: string,
  sha256Hex: AlignmentTrainingSha256Hex,
  label: string,
  issues: string[],
) {
  try {
    const digest = sha256Hex(input);
    if (!SHA256_PATTERN.test(digest)) throw new Error();
    return digest;
  } catch {
    issues.push(`${label} 函数没有返回规范小写 SHA-256。`);
    return null;
  }
}

function compareManifestItems(
  left: AlignmentTrainingManifestItem,
  right: AlignmentTrainingManifestItem,
) {
  return ALIGNMENT_TRAINING_SPLITS.indexOf(left.split) - ALIGNMENT_TRAINING_SPLITS.indexOf(right.split) ||
    left.groupComponentHash.localeCompare(right.groupComponentHash) ||
    left.alignmentApplicationId.localeCompare(right.alignmentApplicationId);
}

function groupKey(group: AlignmentTrainingGroupReference) {
  return `${group.kind}:${group.id}`;
}

function find(parent: number[], value: number): number {
  const next = parent[value]!;
  if (next === value) return value;
  parent[value] = find(parent, next);
  return parent[value]!;
}

function union(parent: number[], left: number, right: number) {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  // 根使用较小输入索引只影响内部表示；最终摘要和排序完全由稳定身份决定。
  parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
}

function sumRatios(ratios: AlignmentTrainingSplitRatios) {
  return ratios.train + ratios.validation + ratios.test;
}

/** 训练 manifest、输入计划和快照 checksum 共用这一份规范 JSON，避免跨阶段出现哈希漂移。 */
export function canonicalAlignmentTrainingJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAlignmentTrainingJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalAlignmentTrainingJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
