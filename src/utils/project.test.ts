import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyProjectData } from "./project";
import {
  PROJECT_FILE_VERSION,
  isProjectDataLike,
  normalizeImportedProjectFile,
} from "./projectFile";

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
  assert.deepEqual(project.sentenceAnnotationConfig, { roleOptions: [] });
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
  assert.notStrictEqual(first.sentenceAnnotationConfig, second.sentenceAnnotationConfig);

  first.subtitleLines.push({
    id: "line-1",
    text: "测试",
    startTime: 0,
    endTime: 1,
    deliveryMode: null,
    roleTypes: [],
  });
  first.builtinTracks[0]!.name = "已修改";
  assert.equal(second.subtitleLines.length, 0);
  assert.equal(second.builtinTracks[0]?.name, "逐字文字轨");
});

test("项目归一化保留逐字轨的选中块循环范围设置", () => {
  const project = createEmptyProjectData();
  project.builtinTracks[0]!.autoSetLoopRangeOnSelect = true;

  const normalized = normalizeImportedProjectFile(project).project;

  // 平台文件每次打开都会经过该边界；这里丢值会让前端提交与服务器当前值冲突的重复命令。
  assert.equal(normalized.builtinTracks[0]?.autoSetLoopRangeOnSelect, true);
});

test("v1-v5 项目升级为 v7 时明确清除旧唱腔字段并补未完成句级分类", () => {
  const legacy = {
    version: 5,
    project: {
      video: { url: "", name: "旧项目.mp4", source: "url" },
      subtitleLines: [{ id: "line-1", text: "原句", startTime: 0, endTime: 2 }],
      characterAnnotations: [{
        id: "char-1",
        lineId: "line-1",
        char: "原",
        startTime: 0,
        endTime: 1,
        singingStyle: "普通唱",
      }],
      builtinTracks: [{
        id: "character-track",
        name: "逐字文字轨",
        type: "character",
        options: ["普通唱", "念白"],
        attachedPointTracks: [],
      }],
      customTracks: [],
      activeTrackOrder: ["character-track"],
    },
  };

  const normalized = normalizeImportedProjectFile(legacy);

  assert.equal(normalized.version, PROJECT_FILE_VERSION);
  assert.deepEqual(normalized.project.sentenceAnnotationConfig, { roleOptions: [] });
  assert.deepEqual(normalized.project.subtitleLines[0], {
    id: "line-1",
    text: "原句",
    startTime: 0,
    endTime: 2,
    deliveryMode: null,
    roleTypes: [],
  });
  assert.equal("singingStyle" in normalized.project.characterAnnotations[0]!, false);
  assert.equal("options" in normalized.project.builtinTracks[0]!, false);
});

test("v6 迁移保留合法分类并清除悬空角色", () => {
  const base = createEmptyProjectData();
  const normalized = normalizeImportedProjectFile({
    ...base,
    sentenceAnnotationConfig: { roleOptions: [" 闺门旦 ", "闺门旦", "小生"] },
    subtitleLines: [{
      id: "line-valid",
      text: "有效",
      startTime: 0,
      endTime: 1,
      deliveryMode: "sung",
      roleType: "闺门旦",
    }, {
      id: "line-dangling",
      text: "悬空",
      startTime: 1,
      endTime: 2,
      deliveryMode: "spoken",
      roleType: "未定义行当",
    }],
  });

  assert.deepEqual(normalized.project.sentenceAnnotationConfig.roleOptions, ["闺门旦", "小生"]);
  assert.deepEqual(normalized.project.subtitleLines[0]?.roleTypes, ["闺门旦"]);
  assert.equal(normalized.project.subtitleLines[1]?.deliveryMode, "spoken");
  assert.deepEqual(normalized.project.subtitleLines[1]?.roleTypes, []);
});

test("v7 角色数组优先于遗留单值，并按项目角色顺序去重和过滤", () => {
  const base = createEmptyProjectData();
  const normalized = normalizeImportedProjectFile({
    version: 7,
    project: {
      ...base,
      sentenceAnnotationConfig: { roleOptions: ["杜丽娘", "柳梦梅", "春香"] },
      subtitleLines: [{
        id: "line-multi",
        text: "合说",
        startTime: 0,
        endTime: 1,
        deliveryMode: "spoken",
        roleTypes: ["春香", "杜丽娘", "春香", "悬空"],
        roleType: "柳梦梅",
      }],
    },
  });

  assert.deepEqual(normalized.project.subtitleLines[0]?.roleTypes, ["杜丽娘", "春香"]);
  assert.equal("roleType" in normalized.project.subtitleLines[0]!, false);

  const explicitEmpty = normalizeImportedProjectFile({
    ...base,
    sentenceAnnotationConfig: { roleOptions: ["杜丽娘"] },
    subtitleLines: [{
      id: "line-empty",
      text: "未标",
      startTime: 0,
      endTime: 1,
      deliveryMode: null,
      roleTypes: [],
      roleType: "杜丽娘",
    }],
  });
  assert.deepEqual(explicitEmpty.project.subtitleLines[0]?.roleTypes, []);
});
