import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyProjectData } from "./project";
import { isProjectDataLike, normalizeImportedProjectFile } from "./projectFile";

test("空白标注工程只包含可立即编辑的默认逐字轨", () => {
  const project = createEmptyProjectData();

  assert.deepEqual(project.video, {
    url: "",
    name: null,
    source: "url",
    filePath: null,
    requiresManualImport: false,
  });
  assert.deepEqual(project.subtitleLines, []);
  assert.deepEqual(project.characterAnnotations, []);
  assert.deepEqual(project.gongcheAnnotations, []);
  assert.deepEqual(project.banyanSections, []);
  assert.deepEqual(project.banyanMarks, []);
  assert.deepEqual(project.actionAnnotations, []);
  assert.deepEqual(project.customTracks, []);
  assert.deepEqual(project.builtinTracks.map((track) => track.id), ["character-track"]);
  assert.deepEqual(project.activeTrackOrder, ["character-track"]);
  assert.equal(isProjectDataLike(project), true);
  assert.deepEqual(normalizeImportedProjectFile(project).project, project);
});

test("每次创建空白标注工程都会返回独立的轨道和数组", () => {
  const first = createEmptyProjectData();
  const second = createEmptyProjectData();

  assert.notStrictEqual(first.subtitleLines, second.subtitleLines);
  assert.notStrictEqual(first.builtinTracks, second.builtinTracks);
  assert.notStrictEqual(first.builtinTracks[0], second.builtinTracks[0]);
  assert.notStrictEqual(first.builtinTracks[0]?.options, second.builtinTracks[0]?.options);

  first.subtitleLines.push({
    id: "line-1",
    text: "测试",
    startTime: 0,
    endTime: 1,
  });
  first.builtinTracks[0]!.name = "已修改";
  assert.equal(second.subtitleLines.length, 0);
  assert.equal(second.builtinTracks[0]?.name, "逐字文字轨");
});
