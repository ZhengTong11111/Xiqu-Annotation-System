import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ALIGNMENT_APPLICATION_CHARACTERS,
  buildAlignmentPredictionApplicationPlan,
} from "../dist/index.js";

test("对齐应用只生成逐字 timing 命令并保持句级时间不变", () => {
  const project = createProject(2);
  const prediction = createPrediction(project, 1_200_000, 2_800_000);
  const result = buildAlignmentPredictionApplicationPlan(project, prediction);
  assert.equal(result.status, "ready");
  assert.equal(result.plan.appliedCharacterCount, 2);
  assert.equal(result.plan.commands.length, 1);
  assert.deepEqual(
    result.plan.commands[0].command.items.map((item) => item.entityType),
    ["character", "character"],
  );
  assert.equal(result.plan.commands[0].command.items[0].after.startTime, 1.2);
  assert.equal(result.plan.commands[0].command.items[1].after.endTime, 2.8);
  assert.deepEqual(project.subtitleLines[0], {
    id: "line-1",
    text: "字".repeat(2),
    startTime: 1,
    endTime: 3,
    deliveryMode: "sung",
    roleTypes: ["闺门旦"],
  });
});

test("对齐应用按 500 项稳定分块，并在完全一致时返回 no_changes", () => {
  const project = createProject(501);
  const prediction = createPrediction(project, 1_000_000, 3_000_000);
  const ready = buildAlignmentPredictionApplicationPlan(project, prediction);
  assert.equal(ready.status, "ready");
  assert.equal(ready.plan.commands.length, 2);
  assert.equal(ready.plan.commands[0].command.items.length, 500);
  assert.equal(ready.plan.commands[1].command.items.length, 1);

  const applied = structuredClone(project);
  for (const sentence of prediction.sentences) {
    for (const predicted of sentence.characters) {
      const character = applied.characterAnnotations.find(({ id }) => id === predicted.characterId);
      character.startTime = predicted.startMicros / 1_000_000;
      character.endTime = predicted.endMicros / 1_000_000;
    }
  }
  assert.equal(buildAlignmentPredictionApplicationPlan(applied, prediction).status, "no_changes");
});

test("对齐应用拒绝字符身份漂移并保留明确总容量", () => {
  const project = createProject(2);
  const prediction = createPrediction(project, 1_000_000, 3_000_000);
  prediction.sentences[0].characters[1].characterId = "other-char";
  const mismatch = buildAlignmentPredictionApplicationPlan(project, prediction);
  assert.deepEqual(mismatch, { status: "identity_mismatch", entityId: "char-2" });
  assert.equal(MAX_ALIGNMENT_APPLICATION_CHARACTERS, 50_000);
});

function createProject(characterCount) {
  const duration = 2 / characterCount;
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [{
      id: "line-1",
      text: "字".repeat(characterCount),
      startTime: 1,
      endTime: 3,
      deliveryMode: "sung",
      roleTypes: ["闺门旦"],
    }],
    characterAnnotations: Array.from({ length: characterCount }, (_, index) => ({
      id: `char-${index + 1}`,
      lineId: "line-1",
      char: "字",
      startTime: 1 + index * duration,
      endTime: 1 + (index + 1) * duration,
    })),
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [],
    customTracks: [],
    activeTrackOrder: [],
  };
}

function createPrediction(project, startMicros, endMicros) {
  const characters = project.characterAnnotations;
  const duration = (endMicros - startMicros) / characters.length;
  return {
    version: 1,
    runId: "run-1",
    inputRevision: 1,
    inputTextFingerprint: "a".repeat(64),
    audioOffsetMicros: 0,
    sentences: [{
      sentenceId: "line-1",
      startMicros: 1_000_000,
      endMicros: 3_000_000,
      confidence: 0.9,
      characters: characters.map((character, index) => ({
        characterId: character.id,
        startMicros: Math.round(startMicros + index * duration),
        endMicros: Math.round(startMicros + (index + 1) * duration),
        confidence: 0.8,
        candidates: [],
      })),
    }],
  };
}
