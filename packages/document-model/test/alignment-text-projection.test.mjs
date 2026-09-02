import assert from "node:assert/strict";
import test from "node:test";
import { buildAlignmentTextProjection } from "../dist/index.js";

test("对齐投影按时间和 ID 稳定排序并排除待预测的逐字时间", () => {
  const project = createProject();
  const first = buildAlignmentTextProjection(project);
  const reordered = buildAlignmentTextProjection({
    ...project,
    subtitleLines: [...project.subtitleLines].reverse(),
    characterAnnotations: [...project.characterAnnotations].reverse().map((item) => ({
      ...item,
      startTime: item.startTime + 0.3,
      endTime: item.endTime + 0.3,
    })),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(reordered, first);
  assert.deepEqual(first.projection.sentences[0], {
    sentenceId: "line-1",
    text: "寻梦",
    startMicros: 1_250_000,
    endMicros: 3_750_000,
    deliveryMode: "sung",
    roleTypes: ["闺门旦"],
    characters: [
      { characterId: "char-1", text: "寻" },
      { characterId: "char-2", text: "梦" },
    ],
  });
  assert.equal(first.sentenceCount, 2);
  assert.equal(first.characterCount, 3);
});

test("对齐投影拒绝缺逐字、悬空逐字和异常输入", () => {
  const project = createProject();
  assert.deepEqual(buildAlignmentTextProjection({ ...project, characterAnnotations: [] }), {
    ok: false,
    code: "alignment_sentence_without_characters",
    entityId: "line-1",
  });
  assert.deepEqual(buildAlignmentTextProjection({
    ...project,
    characterAnnotations: [{ ...project.characterAnnotations[0], lineId: "missing" }],
  }), {
    ok: false,
    code: "alignment_character_orphaned",
    entityId: "char-3",
  });
  assert.equal(buildAlignmentTextProjection({
    ...project,
    subtitleLines: [{ ...project.subtitleLines[0], startTime: -1 }],
    characterAnnotations: [project.characterAnnotations[0]],
  }).code, "alignment_input_invalid");
});

function createProject() {
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦", "巾生"] },
    subtitleLines: [
      { id: "line-2", text: "惊梦", startTime: 4, endTime: 6, deliveryMode: "spoken", roleTypes: ["巾生"] },
      { id: "line-1", text: "寻梦", startTime: 1.25, endTime: 3.75, deliveryMode: "sung", roleTypes: ["闺门旦"] },
    ],
    characterAnnotations: [
      { id: "char-3", lineId: "line-2", char: "惊", startTime: 4, endTime: 6 },
      { id: "char-2", lineId: "line-1", char: "梦", startTime: 2.4, endTime: 3.7 },
      { id: "char-1", lineId: "line-1", char: "寻", startTime: 1.3, endTime: 2.4 },
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
