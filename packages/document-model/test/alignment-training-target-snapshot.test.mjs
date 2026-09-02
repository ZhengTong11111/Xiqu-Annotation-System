import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAlignmentTrainingTargetSnapshot,
  parseAlignmentTrainingTargetSnapshot,
} from "../dist/index.js";

const fingerprint = "a".repeat(64);

test("目标快照只保留稳定身份和微秒时间并可严格 round trip", () => {
  const project = createProject();
  const built = buildAlignmentTrainingTargetSnapshot(project, fingerprint);
  assert.equal(built.ok, true);
  assert.deepEqual(built.snapshot.sentences.map(({ sentenceId }) => sentenceId), ["sentence-1", "sentence-2"]);
  assert.deepEqual(
    built.snapshot.sentences[0].characters.map(({ characterId }) => characterId),
    ["character-1", "character-2"],
  );
  assert.equal(built.snapshot.sentences[0].characters[0].startMicros, 100_000);
  assert.equal(parseAlignmentTrainingTargetSnapshot(structuredClone(built.snapshot)).ok, true);
  for (const forbidden of ["第一句", "甲", "ProjectData", "https://media", "storage/key"]) {
    assert.equal(JSON.stringify(built.snapshot).includes(forbidden), false);
  }
});

test("builder 拒绝重复身份、坏时间与错误指纹", () => {
  const duplicate = createProject();
  duplicate.characterAnnotations[1].id = duplicate.characterAnnotations[0].id;
  assert.deepEqual(buildAlignmentTrainingTargetSnapshot(duplicate, fingerprint), {
    ok: false,
    code: "target_identity_invalid",
  });

  const badTiming = createProject();
  badTiming.characterAnnotations[0].endTime = -1;
  assert.equal(buildAlignmentTrainingTargetSnapshot(badTiming, fingerprint).ok, false);
  assert.equal(buildAlignmentTrainingTargetSnapshot(createProject(), "A".repeat(64)).ok, false);
});

test("parser 拒绝额外字段、计数、重复身份、反向时间和乱序篡改", () => {
  const built = buildAlignmentTrainingTargetSnapshot(createProject(), fingerprint);
  assert.equal(built.ok, true);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.characterCount += 1; },
    (value) => { value.sentences[1].sentenceId = value.sentences[0].sentenceId; },
    (value) => { value.sentences[0].characters[0].endMicros = 1; },
    (value) => { value.sentences.reverse(); },
    (value) => { value.sentences[0].characters.reverse(); },
  ]) {
    const value = structuredClone(built.snapshot);
    mutate(value);
    assert.equal(parseAlignmentTrainingTargetSnapshot(value).ok, false);
  }
});

function createProject() {
  return {
    version: 7,
    projectName: "训练目标测试",
    duration: 10,
    sentenceAnnotationConfig: { roleOptions: ["生"] },
    subtitleLines: [
      {
        id: "sentence-2",
        text: "第二句",
        startTime: 4,
        endTime: 6,
        deliveryMode: "sung",
        roleTypes: ["生"],
      },
      {
        id: "sentence-1",
        text: "第一句",
        startTime: 0,
        endTime: 3,
        deliveryMode: "spoken",
        roleTypes: ["生"],
      },
    ],
    characterAnnotations: [
      { id: "character-2", lineId: "sentence-1", char: "乙", startTime: 1.1, endTime: 2.8 },
      { id: "character-3", lineId: "sentence-2", char: "丙", startTime: 4.2, endTime: 5.8 },
      { id: "character-1", lineId: "sentence-1", char: "甲", startTime: 0.1, endTime: 1 },
    ],
    actionAnnotations: [],
    attachedPointTracks: [],
    customTracks: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
  };
}
