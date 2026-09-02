import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAlignmentPredictionQualitySummary,
  parseAlignmentPredictionQualitySummary,
} from "../dist/alignmentPredictionQualitySummary.js";

const prediction = {
  version: 1,
  runId: "run-1",
  inputRevision: 3,
  inputTextFingerprint: "a".repeat(64),
  audioOffsetMicros: 0,
  sentences: [
    {
      sentenceId: "sentence-1",
      startMicros: 0,
      endMicros: 2_000_000,
      confidence: 0.9,
      characters: [
        {
          characterId: "char-1",
          startMicros: 0,
          endMicros: 1_000_000,
          confidence: 0.55,
          candidates: [{ startMicros: 10_000, endMicros: 1_000_000, confidence: 0.5 }],
        },
        {
          characterId: "char-2",
          startMicros: 1_000_000,
          endMicros: 2_000_000,
          confidence: 0.8,
          candidates: [],
        },
      ],
    },
    {
      sentenceId: "sentence-2",
      startMicros: 2_000_000,
      endMicros: 3_000_000,
      confidence: 0.7,
      characters: [{
        characterId: "char-3",
        startMicros: 2_000_000,
        endMicros: 3_000_000,
        confidence: 0.65,
        candidates: [{ startMicros: 2_200_000, endMicros: 3_000_000, confidence: 0.2 }],
      }],
    },
  ],
};

test("预测质量摘要使用固定整数统计且不复制实体身份", () => {
  const summary = buildAlignmentPredictionQualitySummary(prediction);
  assert.deepEqual(summary, {
    version: 1,
    sentenceCount: 2,
    characterCount: 3,
    sentenceConfidenceMeanPpm: 800_000,
    sentenceConfidenceMinPpm: 700_000,
    characterConfidenceMeanPpm: 666_667,
    characterConfidenceMinPpm: 550_000,
    lowConfidenceCharacterCount: 1,
    alternativeCandidateCharacterCount: 2,
    closeAlternativeCharacterCount: 1,
    maxAlternativeBoundaryDeltaMicros: 200_000,
  });
  assert.deepEqual(parseAlignmentPredictionQualitySummary(summary), summary);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("sentence-1"), false);
  assert.equal(serialized.includes("char-1"), false);
});

test("空预测使用 null 表示无置信度，不把空集合伪装成零分", () => {
  const summary = buildAlignmentPredictionQualitySummary({ ...prediction, sentences: [] });
  assert.equal(summary.sentenceConfidenceMeanPpm, null);
  assert.equal(summary.characterConfidenceMinPpm, null);
  assert.deepEqual(parseAlignmentPredictionQualitySummary(summary), summary);
});

test("摘要解析拒绝额外字段、浮点、越界和不可能组合", () => {
  const valid = buildAlignmentPredictionQualitySummary(prediction);
  const invalid = [
    { ...valid, unexpected: true },
    { ...valid, characterConfidenceMeanPpm: 0.5 },
    { ...valid, sentenceConfidenceMinPpm: 1_000_001 },
    { ...valid, closeAlternativeCharacterCount: 3 },
    { ...valid, alternativeCandidateCharacterCount: 0, maxAlternativeBoundaryDeltaMicros: 1 },
    { ...valid, sentenceCount: 0 },
  ];
  for (const value of invalid) assert.equal(parseAlignmentPredictionQualitySummary(value), null);
});
