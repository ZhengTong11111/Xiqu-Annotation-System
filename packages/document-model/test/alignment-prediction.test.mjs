import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAlignmentPredictionArtifact,
  parseAlignmentPredictionArtifact,
} from "../dist/alignmentPrediction.js";

const projection = {
  version: 1,
  sentences: [{
    sentenceId: "sentence-1",
    text: "寻梦",
    startMicros: 1_000_000,
    endMicros: 3_000_000,
    deliveryMode: "sung",
    roleTypes: ["闺门旦"],
    characters: [
      { characterId: "char-1", text: "寻" },
      { characterId: "char-2", text: "梦" },
    ],
  }],
};

function output() {
  return {
    version: 1,
    sentences: [{
      sentenceId: "sentence-1",
      startMicros: 1_000_000,
      endMicros: 3_000_000,
      confidence: 0.9,
      characters: [
        {
          characterId: "char-1",
          startMicros: 1_000_000,
          endMicros: 2_000_000,
          confidence: 0.8,
          candidates: [],
        },
        {
          characterId: "char-2",
          startMicros: 2_000_000,
          endMicros: 3_000_000,
          confidence: 0.85,
          candidates: [{ startMicros: 2_050_000, endMicros: 3_000_000, confidence: 0.7 }],
        },
      ],
    }],
  };
}

test("预测发布合同保留稳定身份并可严格回读", () => {
  const result = buildAlignmentPredictionArtifact({
    runId: "run-1",
    inputRevision: 7,
    inputTextFingerprint: "a".repeat(64),
    audioOffsetMicros: 10_000,
    projection,
    executorOutput: output(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    parseAlignmentPredictionArtifact(JSON.parse(JSON.stringify(result.prediction))),
    result.prediction,
  );
  assert.equal("text" in result.prediction.sentences[0], false);
});

test("预测拒绝实体换序、重叠边界、越界候选和未知字段", () => {
  const cases = [
    (() => { const value = output(); value.sentences[0].characters.reverse(); return value; })(),
    (() => { const value = output(); value.sentences[0].characters[1].startMicros = 1_500_000; return value; })(),
    (() => { const value = output(); value.sentences[0].characters[0].candidates = [{ startMicros: 0, endMicros: 1, confidence: 1 }]; return value; })(),
    { ...output(), unexpected: true },
  ];
  for (const executorOutput of cases) {
    const result = buildAlignmentPredictionArtifact({
      runId: "run-1",
      inputRevision: 7,
      inputTextFingerprint: "a".repeat(64),
      audioOffsetMicros: 0,
      projection,
      executorOutput,
    });
    assert.equal(result.ok, false);
  }
});
