import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildAlignmentTrainingManifest,
  buildAlignmentTrainingManifestChecksumInput,
  parseAlignmentTrainingManifest,
} from "../dist/index.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const splitSeedHash = sha256("xiqu-training-dataset-seed-v1");

test("输入和有限数组乱序不改变规范 manifest 与 checksum", () => {
  const samples = createConnectedSamples();
  const first = buildAlignmentTrainingManifest({ splitSeedHash, samples }, sha256);
  assert.equal(first.ok, true);

  const shuffled = samples.toReversed().map((sample) => ({
    ...structuredClone(sample),
    signals: sample.signals.toReversed(),
    quality: {
      ...structuredClone(sample.quality),
      issueCodes: sample.quality.issueCodes.toReversed(),
      assessmentIds: sample.quality.assessmentIds.toReversed(),
    },
    groupReferences: sample.groupReferences.toReversed(),
  }));
  const second = buildAlignmentTrainingManifest({ splitSeedHash, samples: shuffled }, sha256);
  assert.equal(second.ok, true);
  assert.equal(second.canonicalJson, first.canonicalJson);
  assert.equal(second.manifest.checksum, first.manifest.checksum);
});

test("剧目与演员的传递连通分量不会跨 split", () => {
  const result = buildAlignmentTrainingManifest({
    splitSeedHash,
    samples: createConnectedSamples(),
  }, sha256);
  assert.equal(result.ok, true);

  const byApplication = new Map(result.manifest.items.map((item) => [item.alignmentApplicationId, item]));
  const connected = [1, 2, 3].map((index) => byApplication.get(uuid(index)));
  assert.equal(new Set(connected.map((item) => item.groupComponentHash)).size, 1);
  assert.equal(new Set(connected.map((item) => item.split)).size, 1);
  assert.notEqual(byApplication.get(uuid(4)).groupComponentHash, connected[0].groupComponentHash);
  assert.equal(result.manifest.componentCount, 2);
});

test("同一稳定分组后续补充样本不会改变既有分量摘要和 split", () => {
  const original = buildAlignmentTrainingManifest({
    splitSeedHash,
    samples: [makeCorrectSample(1, [group("work", 101)])],
  }, sha256);
  const extended = buildAlignmentTrainingManifest({
    splitSeedHash,
    samples: [
      makeCorrectSample(1, [group("work", 101)]),
      makeCorrectSample(2, [group("work", 101)]),
    ],
  }, sha256);
  assert.equal(original.ok, true);
  assert.equal(extended.ok, true);
  assert.equal(original.manifest.items[0].groupComponentHash, extended.manifest.items[0].groupComponentHash);
  assert.equal(original.manifest.items[0].split, extended.manifest.items[0].split);
});

test("自定义比例不拆分分量并如实统计极端失衡", () => {
  const result = buildAlignmentTrainingManifest({
    splitSeedHash,
    splitRatios: { train: 10_000, validation: 0, test: 0 },
    samples: createConnectedSamples(),
  }, sha256);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.splitCounts, {
    train: { items: 4, components: 2 },
    validation: { items: 0, components: 0 },
    test: { items: 0, components: 0 },
  });
});

test("正确预测和人工修订使用不同冻结目标并可严格 round trip", () => {
  const result = buildAlignmentTrainingManifest({
    splitSeedHash,
    samples: [
      makeCorrectSample(1, [group("work", 101)]),
      makeAdjustedSample(2, [group("work", 102)]),
    ],
  }, sha256);
  assert.equal(result.ok, true);
  const correct = result.manifest.items.find((item) => item.alignmentApplicationId === uuid(1));
  const adjusted = result.manifest.items.find((item) => item.alignmentApplicationId === uuid(2));
  assert.deepEqual(correct.target, { mode: "prediction", revision: correct.committedRevision });
  assert.deepEqual(adjusted.target, { mode: "manual_revision", revision: adjusted.observationEndRevision });

  const parsed = parseAlignmentTrainingManifest(JSON.parse(result.canonicalJson), sha256);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.canonicalJson, result.canonicalJson);
  assert.equal(
    buildAlignmentTrainingManifestChecksumInput(parsed.value),
    buildAlignmentTrainingManifestChecksumInput(result.manifest),
  );

  // 训练合同只保留稳定身份和有限摘要，不能夹带正文、对象位置或账号显示事实。
  for (const forbidden of ["唱词正文", "ProjectData", "operationPayload", "https://media", "storage/key", "张三"]) {
    assert.equal(result.canonicalJson.includes(forbidden), false);
  }
});

test("不完整、未评价、不可用和缺人工证据的草案全部 fail closed", () => {
  const cases = [
    { evidenceState: "partial" },
    { evidenceState: "invalid" },
    { unrated: true },
    { quality: { verdict: "unusable", issueCodes: ["unclear_audio"], assessmentIds: [uuid(901)] } },
    {
      quality: { verdict: "needs_adjustment", issueCodes: ["boundary_offset"], assessmentIds: [uuid(902)] },
      signals: ["negative_quality_assessment"],
    },
    { groupReferences: [] },
  ];
  for (const [index, overrides] of cases.entries()) {
    const sample = makeCorrectSample(index + 1, [group("work", index + 100)]);
    const result = buildAlignmentTrainingManifest({
      splitSeedHash,
      samples: [{ ...sample, ...overrides }],
    }, sha256);
    assert.equal(result.ok, false, `case ${index} should fail`);
  }
});

test("重复 application、分组、评价或有限枚举值都会被拒绝", () => {
  const duplicateApplication = makeCorrectSample(1, [group("work", 101)]);
  assert.equal(buildAlignmentTrainingManifest({
    splitSeedHash,
    samples: [duplicateApplication, structuredClone(duplicateApplication)],
  }, sha256).ok, false);

  const duplicateGroup = makeCorrectSample(2, [group("work", 102), group("work", 102)]);
  assert.equal(buildAlignmentTrainingManifest({ splitSeedHash, samples: [duplicateGroup] }, sha256).ok, false);

  const duplicateAssessment = makeCorrectSample(3, [group("work", 103)]);
  duplicateAssessment.quality.assessmentIds.push(duplicateAssessment.quality.assessmentIds[0]);
  assert.equal(buildAlignmentTrainingManifest({ splitSeedHash, samples: [duplicateAssessment] }, sha256).ok, false);

  const duplicateSignal = makeCorrectSample(4, [group("work", 104)]);
  duplicateSignal.signals.push(duplicateSignal.signals[0]);
  assert.equal(buildAlignmentTrainingManifest({ splitSeedHash, samples: [duplicateSignal] }, sha256).ok, false);
});

test("parser 拒绝 checksum、计数、目标语义、排序和额外字段篡改", () => {
  const built = buildAlignmentTrainingManifest({
    splitSeedHash,
    splitRatios: { train: 10_000, validation: 0, test: 0 },
    samples: [
      makeCorrectSample(1, [group("work", 101)]),
      makeAdjustedSample(2, [group("work", 102)]),
    ],
  }, sha256);
  assert.equal(built.ok, true);

  const tamperedChecksum = structuredClone(built.manifest);
  tamperedChecksum.checksum = "0".repeat(64);
  assert.equal(parseAlignmentTrainingManifest(tamperedChecksum, sha256).ok, false);

  for (const mutate of [
    (manifest) => { manifest.sampleCount += 1; },
    (manifest) => { manifest.splitCounts.train.items -= 1; },
    (manifest) => { manifest.items.reverse(); },
    (manifest) => { manifest.items[0].unexpected = true; },
    (manifest) => {
      const item = manifest.items.find(({ target }) => target.mode === "manual_revision");
      item.signals = item.signals.filter((signal) => signal !== "manual_timing_adjustment");
    },
    (manifest) => {
      const item = manifest.items.find(({ target }) => target.mode === "prediction");
      item.signals.push("manual_timing_adjustment");
    },
  ]) {
    const value = structuredClone(built.manifest);
    mutate(value);
    resign(value);
    assert.equal(parseAlignmentTrainingManifest(value, sha256).ok, false);
  }
});

test("哈希边界异常时不生成未经校验的 manifest", () => {
  const sample = makeCorrectSample(1, [group("work", 101)]);
  assert.equal(buildAlignmentTrainingManifest({ splitSeedHash, samples: [sample] }, () => "bad").ok, false);
  assert.equal(parseAlignmentTrainingManifest({ unexpected: true }, sha256).ok, false);
});

function createConnectedSamples() {
  return [
    makeCorrectSample(1, [group("work", 101), group("performer", 201)]),
    makeAdjustedSample(2, [group("work", 102), group("performer", 201)]),
    makeCorrectSample(3, [group("work", 102), group("performer", 202)]),
    makeAdjustedSample(4, [group("work", 103), group("performer", 203)]),
  ];
}

function makeCorrectSample(index, groupReferences) {
  return makeSample(index, groupReferences, {
    predictionSummaryState: "ready",
    manualTiming: emptyManualTiming(),
    quality: {
      verdict: "correct",
      issueCodes: [],
      assessmentIds: [uuid(900 + index), uuid(800 + index)],
    },
    signals: ["document_changed", "ambiguous_prediction", "low_prediction_confidence"],
  });
}

function makeAdjustedSample(index, groupReferences) {
  return makeSample(index, groupReferences, {
    predictionSummaryState: "missing",
    manualTiming: {
      operationCount: 2,
      editedCharacterCount: 3,
      totalBoundaryDeltaMicros: 20_000,
      maxBoundaryDeltaMicros: 10_000,
    },
    quality: {
      verdict: "needs_adjustment",
      issueCodes: ["unclear_audio", "boundary_offset"],
      assessmentIds: [uuid(900 + index), uuid(800 + index)],
    },
    signals: [
      "negative_quality_assessment",
      "manual_timing_adjustment",
      "low_prediction_confidence",
    ],
  });
}

function makeSample(index, groupReferences, overrides) {
  const baseRevision = index * 10;
  return {
    alignmentApplicationId: uuid(index),
    alignmentRunId: uuid(100 + index),
    alignmentArtifactId: uuid(200 + index),
    annotationFileId: uuid(300 + index),
    baseRevision,
    committedRevision: baseRevision + 1,
    observationEndRevision: baseRevision + 5,
    artifact: {
      checksum: sha256(`artifact-${index}`),
      size: 1_024 + index,
      formatVersion: 1,
    },
    evidenceState: "complete",
    unrated: false,
    groupReferences,
    ...overrides,
  };
}

function emptyManualTiming() {
  return {
    operationCount: 0,
    editedCharacterCount: 0,
    totalBoundaryDeltaMicros: 0,
    maxBoundaryDeltaMicros: 0,
  };
}

function group(kind, id) {
  return { kind, id: uuid(id) };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function resign(manifest) {
  manifest.checksum = sha256(buildAlignmentTrainingManifestChecksumInput(manifest));
}
