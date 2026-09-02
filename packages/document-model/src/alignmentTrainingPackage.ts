import { z } from "zod";
import {
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingManifest,
  type AlignmentTrainingManifestV1,
  type AlignmentTrainingSha256Hex,
} from "./alignmentTrainingManifest.js";
import {
  parseAlignmentTrainingInputManifest,
  parseAlignmentTrainingSourceSnapshot,
  type AlignmentTrainingInputManifest,
  type AlignmentTrainingSourceSnapshot,
} from "./alignmentTrainingInputManifest.js";
import {
  parseAlignmentTrainingTargetSnapshot,
} from "./alignmentTrainingTargetSnapshot.js";

export const ALIGNMENT_TRAINING_PACKAGE_PLAN_FORMAT = "xiqu-alignment-training-package-plan";
export const ALIGNMENT_TRAINING_PACKAGE_FORMAT = "xiqu-alignment-training-package";
export const ALIGNMENT_TRAINING_PACKAGE_VERSION = 1;
export const ALIGNMENT_TRAINING_PACKAGE_CONTAINER = "zip";
export const ALIGNMENT_TRAINING_PACKAGE_AUDIO_PROFILE = {
  codec: "flac",
  sampleRate: 16_000,
  channels: 1,
  sampleFormat: "s16",
} as const;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS = 200;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_PREDICTION_BYTES = 32 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_TARGET_BYTES = 16 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_PREDICTION_BYTES =
  ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS * ALIGNMENT_TRAINING_PACKAGE_MAX_PREDICTION_BYTES;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_TARGET_BYTES = 64 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_AUDIO_BYTES = 64 * 1024 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_BYTES = 72 * 1024 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();

export type AlignmentTrainingPackageInputSnapshot = {
  alignmentApplicationId: string;
  targetSnapshot: unknown;
  sourceSnapshot: unknown;
};

export type AlignmentTrainingPackageSample = {
  version: 1;
  alignmentApplicationId: string;
  alignmentRunId: string;
  alignmentArtifactId: string;
  annotationFileId: string;
  split: "train" | "validation" | "test";
  groupComponentHash: string;
  audioOffsetMicros: number;
  source: AlignmentTrainingSourceSnapshot;
  predictionChecksum: string;
  targetSnapshotChecksum: string;
};

export type AlignmentTrainingPackagePlanItem = {
  alignmentApplicationId: string;
  alignmentRunId: string;
  alignmentArtifactId: string;
  annotationFileId: string;
  split: "train" | "validation" | "test";
  groupComponentHash: string;
  audioOffsetMicros: number;
  sourceKind: "uploaded" | "aliyun_vod";
  sourceFingerprint: string;
  sourceSnapshotChecksum: string;
  prediction: { path: string; checksum: string; bytes: number };
  target: { path: string; checksum: string; bytes: number };
  audio: { path: string; maxBytes: number };
  sample: { path: string; checksum: string; bytes: number; content: AlignmentTrainingPackageSample };
};

export type AlignmentTrainingPackagePlan = {
  format: typeof ALIGNMENT_TRAINING_PACKAGE_PLAN_FORMAT;
  version: typeof ALIGNMENT_TRAINING_PACKAGE_VERSION;
  checksum: string;
  container: typeof ALIGNMENT_TRAINING_PACKAGE_CONTAINER;
  audioProfile: typeof ALIGNMENT_TRAINING_PACKAGE_AUDIO_PROFILE;
  exportId: string;
  provenanceManifestChecksum: string;
  inputManifestChecksum: string;
  itemCount: number;
  provenanceEntry: { path: "provenance-manifest.json"; checksum: string; bytes: number };
  inputEntry: { path: "input-manifest.json"; checksum: string; bytes: number };
  items: AlignmentTrainingPackagePlanItem[];
};

export type AlignmentTrainingPackageInventoryEntry = {
  path: string;
  kind: "provenance" | "input" | "prediction" | "target" | "audio" | "sample";
  checksum: string;
  bytes: number;
};

export type AlignmentTrainingPackageManifest = {
  format: typeof ALIGNMENT_TRAINING_PACKAGE_FORMAT;
  version: typeof ALIGNMENT_TRAINING_PACKAGE_VERSION;
  checksum: string;
  container: typeof ALIGNMENT_TRAINING_PACKAGE_CONTAINER;
  planChecksum: string;
  exportId: string;
  itemCount: number;
  totalBytes: number;
  inventory: AlignmentTrainingPackageInventoryEntry[];
};

export type AlignmentTrainingPackageResult<T> =
  | { ok: true; value: T; canonicalJson: string }
  | { ok: false; issues: string[] };

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const pathSchema = z.string().min(1).max(500).refine(isSafePackagePath, "包内路径不安全。");
const audioProfileSchema = z.object({
  codec: z.literal("flac"),
  sampleRate: z.literal(16_000),
  channels: z.literal(1),
  sampleFormat: z.literal("s16"),
}).strict();
const sampleContentSchema = z.object({
  version: z.literal(1),
  alignmentApplicationId: uuidSchema,
  alignmentRunId: uuidSchema,
  alignmentArtifactId: uuidSchema,
  annotationFileId: uuidSchema,
  split: z.enum(["train", "validation", "test"]),
  groupComponentHash: sha256Schema,
  audioOffsetMicros: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  // 来源快照由其唯一 parser 做 discriminated-union 校验，避免在包合同复制第二套来源 schema。
  source: z.unknown(),
  predictionChecksum: sha256Schema,
  targetSnapshotChecksum: sha256Schema,
}).strict();
const planItemSchema = z.object({
  alignmentApplicationId: uuidSchema,
  alignmentRunId: uuidSchema,
  alignmentArtifactId: uuidSchema,
  annotationFileId: uuidSchema,
  split: z.enum(["train", "validation", "test"]),
  groupComponentHash: sha256Schema,
  audioOffsetMicros: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  sourceKind: z.enum(["uploaded", "aliyun_vod"]),
  sourceFingerprint: sha256Schema,
  sourceSnapshotChecksum: sha256Schema,
  prediction: z.object({ path: pathSchema, checksum: sha256Schema, bytes: positiveSafeInteger }).strict(),
  target: z.object({ path: pathSchema, checksum: sha256Schema, bytes: positiveSafeInteger }).strict(),
  audio: z.object({ path: pathSchema, maxBytes: positiveSafeInteger }).strict(),
  sample: z.object({
    path: pathSchema,
    checksum: sha256Schema,
    bytes: positiveSafeInteger,
    content: sampleContentSchema,
  }).strict(),
}).strict();
const planSchema = z.object({
  format: z.literal(ALIGNMENT_TRAINING_PACKAGE_PLAN_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_PACKAGE_VERSION),
  checksum: sha256Schema,
  container: z.literal(ALIGNMENT_TRAINING_PACKAGE_CONTAINER),
  audioProfile: audioProfileSchema,
  exportId: uuidSchema,
  provenanceManifestChecksum: sha256Schema,
  inputManifestChecksum: sha256Schema,
  itemCount: positiveSafeInteger.max(ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS),
  provenanceEntry: z.object({
    path: z.literal("provenance-manifest.json"),
    checksum: sha256Schema,
    bytes: positiveSafeInteger,
  }).strict(),
  inputEntry: z.object({
    path: z.literal("input-manifest.json"),
    checksum: sha256Schema,
    bytes: positiveSafeInteger,
  }).strict(),
  items: z.array(planItemSchema).min(1).max(ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS),
}).strict();
const inventoryEntrySchema = z.object({
  path: pathSchema,
  kind: z.enum(["provenance", "input", "prediction", "target", "audio", "sample"]),
  checksum: sha256Schema,
  bytes: positiveSafeInteger,
}).strict();
const packageManifestSchema = z.object({
  format: z.literal(ALIGNMENT_TRAINING_PACKAGE_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_PACKAGE_VERSION),
  checksum: sha256Schema,
  container: z.literal(ALIGNMENT_TRAINING_PACKAGE_CONTAINER),
  planChecksum: sha256Schema,
  exportId: uuidSchema,
  itemCount: positiveSafeInteger.max(ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS),
  totalBytes: positiveSafeInteger.max(ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_BYTES),
  inventory: z.array(inventoryEntrySchema).min(1),
}).strict();

/** 构造确定性条目计划；所有正文和二进制仍留在原快照/对象中，不复制到 plan。 */
export function buildAlignmentTrainingPackagePlan(
  input: {
    exportId: string;
    provenanceManifest: AlignmentTrainingManifestV1;
    inputManifest: AlignmentTrainingInputManifest;
    snapshots: AlignmentTrainingPackageInputSnapshot[];
  },
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingPackageResult<AlignmentTrainingPackagePlan> {
  const provenance = parseAlignmentTrainingManifest(input.provenanceManifest, sha256Hex);
  const inputs = parseAlignmentTrainingInputManifest(input.inputManifest, sha256Hex);
  if (!UUID_PATTERN.test(input.exportId) || !provenance.ok || !inputs.ok) {
    return { ok: false, issues: ["训练包输入 manifest 或 export identity 无效。"] };
  }
  if (
    inputs.manifest.provenanceManifestChecksum !== provenance.value.checksum ||
    provenance.value.items.length !== inputs.manifest.items.length ||
    input.snapshots.length !== inputs.manifest.items.length ||
    inputs.manifest.items.length > ALIGNMENT_TRAINING_PACKAGE_MAX_ITEMS
  ) return { ok: false, issues: ["训练包输入集合不一致。"] };

  const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.alignmentApplicationId, snapshot]));
  if (snapshots.size !== input.snapshots.length) return { ok: false, issues: ["训练包输入快照 identity 重复。"] };
  const provenanceById = new Map(provenance.value.items.map((item) => [item.alignmentApplicationId, item]));
  const items: AlignmentTrainingPackagePlanItem[] = [];
  let predictionBytes = 0;
  let targetBytes = 0;

  for (const [index, manifestItem] of inputs.manifest.items.entries()) {
    const provenanceItem = provenanceById.get(manifestItem.alignmentApplicationId);
    const snapshot = snapshots.get(manifestItem.alignmentApplicationId);
    const target = parseAlignmentTrainingTargetSnapshot(snapshot?.targetSnapshot);
    const source = parseAlignmentTrainingSourceSnapshot(snapshot?.sourceSnapshot);
    if (!provenanceItem || !snapshot || !target.ok || !source.ok) {
      return { ok: false, issues: ["训练包逐项快照缺失或无效。"] };
    }
    const targetJson = canonicalAlignmentTrainingJson(target.value);
    const sourceChecksum = checkedSha256(canonicalAlignmentTrainingJson(source.value), sha256Hex);
    const targetChecksum = checkedSha256(targetJson, sha256Hex);
    const targetSize = utf8Bytes(targetJson);
    if (
      provenanceItem.alignmentArtifactId !== manifestItem.alignmentArtifactId ||
      provenanceItem.artifact.checksum !== manifestItem.artifactChecksum ||
      targetChecksum !== manifestItem.targetSnapshotChecksum ||
      sourceChecksum !== manifestItem.sourceSnapshotChecksum ||
      target.value.sentenceCount !== manifestItem.targetSentenceCount ||
      target.value.characterCount !== manifestItem.targetCharacterCount ||
      targetSize !== manifestItem.targetSnapshotBytes ||
      provenanceItem.artifact.size > ALIGNMENT_TRAINING_PACKAGE_MAX_PREDICTION_BYTES ||
      targetSize > ALIGNMENT_TRAINING_PACKAGE_MAX_TARGET_BYTES
    ) return { ok: false, issues: ["训练包逐项 checksum、计数或容量不一致。"] };

    const directory = `samples/${String(index + 1).padStart(4, "0")}_${manifestItem.alignmentApplicationId}`;
    const sampleContent: AlignmentTrainingPackageSample = {
      version: 1,
      alignmentApplicationId: manifestItem.alignmentApplicationId,
      alignmentRunId: provenanceItem.alignmentRunId,
      alignmentArtifactId: manifestItem.alignmentArtifactId,
      annotationFileId: provenanceItem.annotationFileId,
      split: provenanceItem.split,
      groupComponentHash: provenanceItem.groupComponentHash,
      audioOffsetMicros: source.value.audioOffsetMicros,
      source: source.value,
      predictionChecksum: manifestItem.artifactChecksum,
      targetSnapshotChecksum: manifestItem.targetSnapshotChecksum,
    };
    const sampleJson = canonicalAlignmentTrainingJson(sampleContent);
    const sampleChecksum = checkedSha256(sampleJson, sha256Hex);
    if (!sampleChecksum) return { ok: false, issues: ["训练包 sample checksum 计算失败。"] };
    items.push({
      alignmentApplicationId: manifestItem.alignmentApplicationId,
      alignmentRunId: provenanceItem.alignmentRunId,
      alignmentArtifactId: manifestItem.alignmentArtifactId,
      annotationFileId: provenanceItem.annotationFileId,
      split: provenanceItem.split,
      groupComponentHash: provenanceItem.groupComponentHash,
      audioOffsetMicros: source.value.audioOffsetMicros,
      sourceKind: source.value.kind,
      sourceFingerprint: source.value.sourceFingerprint,
      sourceSnapshotChecksum: manifestItem.sourceSnapshotChecksum,
      prediction: {
        path: `${directory}/prediction.json.gz`,
        checksum: manifestItem.artifactChecksum,
        bytes: provenanceItem.artifact.size,
      },
      target: {
        path: `${directory}/target.json`,
        checksum: manifestItem.targetSnapshotChecksum,
        bytes: targetSize,
      },
      audio: { path: `${directory}/audio.flac`, maxBytes: ALIGNMENT_TRAINING_PACKAGE_MAX_AUDIO_BYTES },
      sample: {
        path: `${directory}/sample.json`,
        checksum: sampleChecksum,
        bytes: utf8Bytes(sampleJson),
        content: sampleContent,
      },
    });
    const nextPredictionBytes = checkedAdd(predictionBytes, provenanceItem.artifact.size);
    const nextTargetBytes = checkedAdd(targetBytes, targetSize);
    if (nextPredictionBytes === null || nextTargetBytes === null) {
      return { ok: false, issues: ["训练包输入容量超出安全整数范围。"] };
    }
    predictionBytes = nextPredictionBytes;
    targetBytes = nextTargetBytes;
  }
  if (
    predictionBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_PREDICTION_BYTES ||
    targetBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_TARGET_BYTES
  ) return { ok: false, issues: ["训练包输入总容量超限。"] };

  const provenanceJson = canonicalAlignmentTrainingJson(provenance.value);
  const inputJson = canonicalAlignmentTrainingJson(inputs.manifest);
  // manifest 的业务 checksum 排除 checksum 字段；包内 entry 则必须校验完整文件字节，两者不可混用。
  const provenanceEntryChecksum = checkedSha256(provenanceJson, sha256Hex);
  const inputEntryChecksum = checkedSha256(inputJson, sha256Hex);
  if (!provenanceEntryChecksum || !inputEntryChecksum) {
    return { ok: false, issues: ["训练包顶层 manifest 文件 checksum 计算失败。"] };
  }
  const withoutChecksum: Omit<AlignmentTrainingPackagePlan, "checksum"> = {
    format: ALIGNMENT_TRAINING_PACKAGE_PLAN_FORMAT,
    version: ALIGNMENT_TRAINING_PACKAGE_VERSION,
    container: ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
    audioProfile: ALIGNMENT_TRAINING_PACKAGE_AUDIO_PROFILE,
    exportId: input.exportId,
    provenanceManifestChecksum: provenance.value.checksum,
    inputManifestChecksum: inputs.manifest.checksum,
    itemCount: items.length,
    provenanceEntry: {
      path: "provenance-manifest.json" as const,
      checksum: provenanceEntryChecksum,
      bytes: utf8Bytes(provenanceJson),
    },
    inputEntry: {
      path: "input-manifest.json" as const,
      checksum: inputEntryChecksum,
      bytes: utf8Bytes(inputJson),
    },
    items,
  };
  const checksum = checkedSha256(canonicalAlignmentTrainingJson(withoutChecksum), sha256Hex);
  if (!checksum) return { ok: false, issues: ["训练包 plan checksum 计算失败。"] };
  return parseAlignmentTrainingPackagePlan({ ...withoutChecksum, checksum }, sha256Hex);
}

export function parseAlignmentTrainingPackagePlan(
  value: unknown,
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingPackageResult<AlignmentTrainingPackagePlan> {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return zodFailure(parsed.error);
  const plan = parsed.data as AlignmentTrainingPackagePlan;
  const { checksum, ...withoutChecksum } = plan;
  const issues = validatePlanSemantics(plan, sha256Hex);
  if (checkedSha256(canonicalAlignmentTrainingJson(withoutChecksum), sha256Hex) !== checksum) {
    issues.push("训练包 plan checksum 不一致。");
  }
  return issues.length
    ? { ok: false, issues: issues.slice(0, 50) }
    : { ok: true, value: plan, canonicalJson: canonicalAlignmentTrainingJson(plan) };
}

/** 流式输出完成后用实际 inventory 形成最终 manifest；音频大小在这里执行总量门禁。 */
export function buildAlignmentTrainingPackageManifest(
  plan: AlignmentTrainingPackagePlan,
  inventory: AlignmentTrainingPackageInventoryEntry[],
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingPackageResult<AlignmentTrainingPackageManifest> {
  const parsedPlan = parseAlignmentTrainingPackagePlan(plan, sha256Hex);
  if (!parsedPlan.ok) return parsedPlan;
  const actual = [...inventory].sort((left, right) => left.path.localeCompare(right.path));
  const totals = validateInventory(parsedPlan.value, actual);
  if (!totals.ok) return { ok: false, issues: totals.issues };

  const withoutChecksum: Omit<AlignmentTrainingPackageManifest, "checksum"> = {
    format: ALIGNMENT_TRAINING_PACKAGE_FORMAT,
    version: ALIGNMENT_TRAINING_PACKAGE_VERSION,
    container: ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
    planChecksum: plan.checksum,
    exportId: plan.exportId,
    itemCount: plan.itemCount,
    totalBytes: totals.totalBytes,
    inventory: actual,
  };
  const checksum = checkedSha256(canonicalAlignmentTrainingJson(withoutChecksum), sha256Hex);
  if (!checksum) return { ok: false, issues: ["训练包 manifest checksum 计算失败。"] };
  return parseAlignmentTrainingPackageManifest(
    { ...withoutChecksum, checksum },
    parsedPlan.value,
    sha256Hex,
  );
}

/** 最终 manifest 必须同时通过自身 checksum 和原 plan 的精确 inventory 门禁。 */
export function parseAlignmentTrainingPackageManifest(
  value: unknown,
  plan: AlignmentTrainingPackagePlan,
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingPackageResult<AlignmentTrainingPackageManifest> {
  const parsedPlan = parseAlignmentTrainingPackagePlan(plan, sha256Hex);
  if (!parsedPlan.ok) return parsedPlan;
  const parsed = packageManifestSchema.safeParse(value);
  if (!parsed.success) return zodFailure(parsed.error);
  const manifest = parsed.data as AlignmentTrainingPackageManifest;
  const { checksum, ...withoutChecksum } = manifest;
  const issues: string[] = [];
  if (
    manifest.planChecksum !== parsedPlan.value.checksum ||
    manifest.exportId !== parsedPlan.value.exportId ||
    manifest.itemCount !== parsedPlan.value.itemCount
  ) issues.push("训练包最终 manifest 与 plan identity 不一致。");
  const canonicalChecksum = checkedSha256(
    canonicalAlignmentTrainingJson(withoutChecksum),
    sha256Hex,
  );
  if (canonicalChecksum !== checksum) issues.push("训练包最终 manifest checksum 不一致。");
  const totals = validateInventory(parsedPlan.value, manifest.inventory);
  if (!totals.ok) issues.push(...totals.issues);
  else if (totals.totalBytes !== manifest.totalBytes) issues.push("训练包 totalBytes 不一致。");
  return issues.length > 0
    ? { ok: false, issues: issues.slice(0, 50) }
    : { ok: true, value: manifest, canonicalJson: canonicalAlignmentTrainingJson(manifest) };
}

function validatePlanSemantics(
  plan: AlignmentTrainingPackagePlan,
  sha256Hex: AlignmentTrainingSha256Hex,
) {
  const issues: string[] = [];
  if (plan.itemCount !== plan.items.length) issues.push("训练包 itemCount 不一致。");
  const allPaths = [
    plan.provenanceEntry.path,
    plan.inputEntry.path,
    ...plan.items.flatMap((item) => [
      item.prediction.path,
      item.target.path,
      item.audio.path,
      item.sample.path,
    ]),
  ];
  if (new Set(allPaths).size !== allPaths.length) issues.push("训练包路径重复。");
  let predictionBytes = 0;
  let targetBytes = 0;
  for (const [index, item] of plan.items.entries()) {
    const directory = `samples/${String(index + 1).padStart(4, "0")}_${item.alignmentApplicationId}`;
    if (
      item.prediction.path !== `${directory}/prediction.json.gz` ||
      item.target.path !== `${directory}/target.json` ||
      item.audio.path !== `${directory}/audio.flac` ||
      item.sample.path !== `${directory}/sample.json` ||
      item.audio.maxBytes !== ALIGNMENT_TRAINING_PACKAGE_MAX_AUDIO_BYTES
    ) issues.push(`训练包第 ${index + 1} 项路径或上限不规范。`);
    if (index > 0 && item.alignmentApplicationId <= plan.items[index - 1]!.alignmentApplicationId) {
      issues.push("训练包 items 未按 applicationId 严格排序。");
    }
    const source = parseAlignmentTrainingSourceSnapshot(item.sample.content.source);
    const sampleJson = canonicalAlignmentTrainingJson(item.sample.content);
    const sourceChecksum = source.ok
      ? checkedSha256(canonicalAlignmentTrainingJson(source.value), sha256Hex)
      : null;
    const sampleChecksum = checkedSha256(sampleJson, sha256Hex);
    if (
      !source.ok ||
      item.sample.content.alignmentApplicationId !== item.alignmentApplicationId ||
      item.sample.content.alignmentRunId !== item.alignmentRunId ||
      item.sample.content.alignmentArtifactId !== item.alignmentArtifactId ||
      item.sample.content.annotationFileId !== item.annotationFileId ||
      item.sample.content.split !== item.split ||
      item.sample.content.groupComponentHash !== item.groupComponentHash ||
      item.sample.content.audioOffsetMicros !== item.audioOffsetMicros ||
      item.sample.content.predictionChecksum !== item.prediction.checksum ||
      item.sample.content.targetSnapshotChecksum !== item.target.checksum ||
      (source.ok && source.value.kind !== item.sourceKind) ||
      item.sourceFingerprint !== (source.ok ? source.value.sourceFingerprint : "") ||
      item.sourceSnapshotChecksum !== sourceChecksum ||
      item.sample.checksum !== sampleChecksum ||
      item.sample.bytes !== utf8Bytes(sampleJson) ||
      item.prediction.bytes > ALIGNMENT_TRAINING_PACKAGE_MAX_PREDICTION_BYTES ||
      item.target.bytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TARGET_BYTES
    ) issues.push(`训练包第 ${index + 1} 项 identity、sample 或容量不一致。`);
    const nextPrediction = checkedAdd(predictionBytes, item.prediction.bytes);
    const nextTarget = checkedAdd(targetBytes, item.target.bytes);
    if (nextPrediction === null || nextTarget === null) {
      issues.push("训练包输入容量超出安全整数范围。");
    } else {
      predictionBytes = nextPrediction;
      targetBytes = nextTarget;
    }
  }
  if (
    predictionBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_PREDICTION_BYTES ||
    targetBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_TARGET_BYTES
  ) issues.push("训练包输入总容量超限。");
  return issues;
}

function validateInventory(
  plan: AlignmentTrainingPackagePlan,
  inventory: readonly AlignmentTrainingPackageInventoryEntry[],
): { ok: true; totalBytes: number } | { ok: false; issues: string[] } {
  const parsed = z.array(inventoryEntrySchema).safeParse(inventory);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 50).map((issue) =>
        `${issue.path.join(".") || "inventory"}: ${issue.message}`),
    };
  }
  const actual = parsed.data as AlignmentTrainingPackageInventoryEntry[];
  const expected = expectedInventory(plan);
  if (
    actual.length !== expected.size ||
    new Set(actual.map(({ path }) => path)).size !== actual.length
  ) return { ok: false, issues: ["训练包 inventory 条目数量或路径重复。"] };
  let totalBytes = 0;
  let audioBytes = 0;
  for (const [index, entry] of actual.entries()) {
    if (index > 0 && entry.path <= actual[index - 1]!.path) {
      return { ok: false, issues: ["训练包 inventory 未按路径严格排序。"] };
    }
    const expectedEntry = expected.get(entry.path);
    if (
      !expectedEntry ||
      expectedEntry.kind !== entry.kind ||
      (expectedEntry.checksum !== null && expectedEntry.checksum !== entry.checksum) ||
      (expectedEntry.bytes !== null && expectedEntry.bytes !== entry.bytes) ||
      entry.bytes > expectedEntry.maxBytes
    ) return { ok: false, issues: [`训练包 inventory 条目 ${entry.path} 与计划不一致。`] };
    const nextTotal = checkedAdd(totalBytes, entry.bytes);
    const nextAudio = entry.kind === "audio" ? checkedAdd(audioBytes, entry.bytes) : audioBytes;
    if (nextTotal === null || nextAudio === null) {
      return { ok: false, issues: ["训练包实际输出容量超出安全整数范围。"] };
    }
    totalBytes = nextTotal;
    audioBytes = nextAudio;
  }
  if (
    audioBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_AUDIO_BYTES ||
    totalBytes > ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_BYTES
  ) return { ok: false, issues: ["训练包实际输出总容量超限。"] };
  return { ok: true, totalBytes };
}

function expectedInventory(plan: AlignmentTrainingPackagePlan) {
  const result = new Map<string, {
    kind: AlignmentTrainingPackageInventoryEntry["kind"];
    checksum: string | null;
    bytes: number | null;
    maxBytes: number;
  }>();
  result.set(plan.provenanceEntry.path, {
    kind: "provenance", checksum: plan.provenanceEntry.checksum,
    bytes: plan.provenanceEntry.bytes, maxBytes: plan.provenanceEntry.bytes,
  });
  result.set(plan.inputEntry.path, {
    kind: "input", checksum: plan.inputEntry.checksum,
    bytes: plan.inputEntry.bytes, maxBytes: plan.inputEntry.bytes,
  });
  for (const item of plan.items) {
    result.set(item.prediction.path, {
      kind: "prediction", checksum: item.prediction.checksum,
      bytes: item.prediction.bytes, maxBytes: item.prediction.bytes,
    });
    result.set(item.target.path, {
      kind: "target", checksum: item.target.checksum,
      bytes: item.target.bytes, maxBytes: item.target.bytes,
    });
    result.set(item.audio.path, {
      kind: "audio", checksum: null, bytes: null, maxBytes: item.audio.maxBytes,
    });
    result.set(item.sample.path, {
      kind: "sample", checksum: item.sample.checksum,
      bytes: item.sample.bytes, maxBytes: item.sample.bytes,
    });
  }
  return result;
}

function isSafePackagePath(value: string) {
  if (value !== value.normalize("NFC") || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." &&
    !/[\u0000-\u001f\u007f]/u.test(segment));
}

function checkedAdd(left: number, right: number) {
  const value = left + right;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkedSha256(value: string, sha256Hex: AlignmentTrainingSha256Hex) {
  try {
    const result = sha256Hex(value);
    return SHA256_PATTERN.test(result) ? result : null;
  } catch {
    return null;
  }
}

function utf8Bytes(value: string) {
  return encoder.encode(value).byteLength;
}

function zodFailure(error: z.ZodError): AlignmentTrainingPackageResult<never> {
  return {
    ok: false,
    issues: error.issues.slice(0, 50).map((issue) =>
      `${issue.path.join(".") || "package"}: ${issue.message}`),
  };
}
