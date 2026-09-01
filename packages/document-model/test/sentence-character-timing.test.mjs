import assert from "node:assert/strict";
import test from "node:test";
import { resetSentenceCharactersToEvenTiming } from "../dist/index.js";

function createProject() {
  return {
    video: { url: "", name: "", source: "url" },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [{
      id: "line-1",
      text: "甲乙丙",
      startTime: 10,
      endTime: 16,
      deliveryMode: null,
      roleTypes: [],
    }],
    characterAnnotations: [
      { id: "char-a", lineId: "line-1", char: "甲", startTime: 11, endTime: 13, tone: { toneClass: "yin_ping" } },
      { id: "char-b", lineId: "line-1", char: "乙", startTime: 11, endTime: 12, tone: null },
      { id: "char-c", lineId: "line-1", char: "丙", startTime: 15, endTime: 15.5, tone: null },
      { id: "foreign", lineId: "line-2", char: "外", startTime: 20, endTime: 21, tone: null },
    ],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [],
    customTracks: [],
    activeTrackOrder: [],
  };
}

test("按当前时间顺序平均铺满句级范围并保留逐字身份和内容", () => {
  const project = createProject();
  const result = resetSentenceCharactersToEvenTiming(project, "line-1");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // char-b 的结束更早，因此在同起点重叠时稳定排在 char-a 之前。
  assert.deepEqual(result.characterIds, ["char-b", "char-a", "char-c"]);
  assert.deepEqual(
    result.characterIds.map((id) => {
      const character = result.project.characterAnnotations.find((candidate) => candidate.id === id);
      return [character.startTime, character.endTime];
    }),
    [[10, 12], [12, 14], [14, 16]],
  );
  assert.deepEqual(result.project.characterAnnotations[0].tone, { toneClass: "yin_ping" });
  assert.deepEqual(result.project.characterAnnotations.find((item) => item.id === "foreign"), project.characterAnnotations[3]);
  assert.equal(result.project.subtitleLines[0], project.subtitleLines[0]);
});

test("单个逐字块铺满整句且重复执行不制造变化", () => {
  const project = createProject();
  project.characterAnnotations = [project.characterAnnotations[0]];
  const first = resetSentenceCharactersToEvenTiming(project, "line-1");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    [first.project.characterAnnotations[0].startTime, first.project.characterAnnotations[0].endTime],
    [10, 16],
  );
  const second = resetSentenceCharactersToEvenTiming(first.project, "line-1");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.changed, false);
  assert.equal(second.project, first.project);
});

test("缺句、无逐字和无效句级范围返回明确失败原因", () => {
  const project = createProject();
  assert.deepEqual(resetSentenceCharactersToEvenTiming(project, "missing"), {
    ok: false,
    issue: "sentence_not_found",
  });
  assert.deepEqual(resetSentenceCharactersToEvenTiming({ ...project, characterAnnotations: [] }, "line-1"), {
    ok: false,
    issue: "no_characters",
  });
  const invalid = structuredClone(project);
  invalid.subtitleLines[0].endTime = invalid.subtitleLines[0].startTime;
  assert.deepEqual(resetSentenceCharactersToEvenTiming(invalid, "line-1"), {
    ok: false,
    issue: "invalid_sentence_range",
  });
});
