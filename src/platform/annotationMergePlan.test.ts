import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectData } from "../types";
import { buildAnnotationDiff, type AnnotationDiffResult } from "./annotationDiff";
import {
  buildAnnotationMergePlan,
  type AnnotationMergeDirection,
  type AnnotationMergePlan,
} from "./annotationMergePlan";

// 基础新增必须使用方向后的真实 source/target；added/removed 不能被误当成固定复制方向。
test("双向新增按真实来源侧判断", () => {
  const left = emptyProject();
  const right = emptyProject();
  left.subtitleLines.push(line("left-line", "左"));
  right.subtitleLines.push(line("right-line", "右"));
  const diff = diffFor(left, right);

  const leftPlan = planFor(left, right, diff, "left-to-right", [
    "subtitle_lines:left-line",
  ]);
  assert.deepEqual(leftPlan.items.map(itemSummary), [
    "subtitle_lines:left-line:selected:add",
  ]);

  const rightPlan = planFor(left, right, diff, "right-to-left", [
    "subtitle_lines:right-line",
  ]);
  assert.equal(rightPlan.sourceSide, "right");
  assert.equal(rightPlan.targetSide, "left");
  assert.deepEqual(rightPlan.items.map(itemSummary), [
    "subtitle_lines:right-line:selected:add",
  ]);
});

// 逐字依赖句级字幕；目标句是否缺失、相同或不同应分别形成 add、already-equal 和 conflict。
test("逐字依赖根据目标状态形成三种动作", () => {
  const source = richProject();

  const missingTarget = emptyProject();
  const missingPlan = planFromProjects(source, missingTarget, ["characters:char-1"]);
  assert.deepEqual(missingPlan.items.map(itemSummary), [
    "subtitle_lines:line-1:dependency:add",
    "characters:char-1:selected:add",
  ]);

  const equalTarget = emptyProject();
  equalTarget.subtitleLines.push(clone(source.subtitleLines[0]!));
  const equalPlan = planFromProjects(source, equalTarget, ["characters:char-1"]);
  assert.equal(findItem(equalPlan, "subtitle_lines:line-1").action, "already-equal");

  const conflictTarget = clone(equalTarget);
  conflictTarget.subtitleLines[0]!.text = "冲突句";
  const conflictPlan = planFromProjects(source, conflictTarget, ["characters:char-1"]);
  assert.equal(
    findItem(conflictPlan, "subtitle_lines:line-1").action,
    "replace-conflict",
  );
});

// 内建逐字工尺形成 句级 → 逐字 → 工尺 的严格拓扑闭包。
test("工尺谱自动闭包到内建逐字与句级字幕", () => {
  const plan = planFromProjects(richProject(), emptyProject(), ["gongche:gongche-char"]);
  assert.deepEqual(plan.items.map(({ entryKey }) => entryKey), [
    "subtitle_lines:line-1",
    "characters:char-1",
    "gongche:gongche-char",
  ]);
  assert.equal(findItem(plan, "gongche:gongche-char").role, "selected");
  assert.deepEqual(findItem(plan, "characters:char-1").requiredBy, [
    "gongche:gongche-char",
  ]);
});

// 自定义文字工尺必须同时携带轨道、递归父块与实际父文字块。
test("自定义文字工尺闭包包含轨道和递归父块", () => {
  const plan = planFromProjects(richProject(), emptyProject(), ["gongche:gongche-custom"]);
  assert.deepEqual(plan.items.map(({ entryKey }) => entryKey), [
    "custom_tracks:text-track",
    "custom_blocks:text-track:root-block",
    "custom_blocks:text-track:child-block",
    "gongche:gongche-custom",
  ]);
});

// 板眼标记同时引用区段和工尺时，两条依赖链都必须进入同一确定计划。
test("板眼标记闭包包含区段和关联工尺链", () => {
  const plan = planFromProjects(richProject(), emptyProject(), ["banyan_marks:mark-1"]);
  assert.deepEqual(plan.items.map(({ entryKey }) => entryKey), [
    "subtitle_lines:line-1",
    "characters:char-1",
    "gongche:gongche-char",
    "banyan_sections:section-1",
    "banyan_marks:mark-1",
  ]);
});

// 递归块只向上吸入父块和轨道，不反向扩大到兄弟块或全部轨道内容。
test("递归自定义块只加入必要祖先", () => {
  const plan = planFromProjects(richProject(), emptyProject(), [
    "custom_blocks:text-track:child-block",
  ]);
  assert.deepEqual(plan.items.map(({ entryKey }) => entryKey), [
    "custom_tracks:text-track",
    "custom_blocks:text-track:root-block",
    "custom_blocks:text-track:child-block",
  ]);
  assert.equal(plan.items.some(({ entryKey }) => entryKey.includes("action-track")), false);
});

// 自定义附属点依赖定义和父轨，内建附属点只依赖定义，不制造不支持的 project 项。
test("附属点按父轨类型构造闭包", () => {
  const source = richProject();
  const customPlan = planFromProjects(source, emptyProject(), [
    "attached_points:point:text-track:point-track-custom:point-custom",
  ]);
  assert.deepEqual(customPlan.items.map(({ entryKey }) => entryKey), [
    "custom_tracks:text-track",
    "attached_points:point-track:text-track:point-track-custom",
    "attached_points:point:text-track:point-track-custom:point-custom",
  ]);

  const builtinPlan = planFromProjects(source, emptyProject(), [
    "attached_points:point:character-track:point-track-builtin:point-builtin",
  ]);
  assert.deepEqual(builtinPlan.items.map(({ entryKey }) => entryKey), [
    "attached_points:point-track:character-track:point-track-builtin",
    "attached_points:point:character-track:point-track-builtin:point-builtin",
  ]);
  assert.equal(builtinPlan.items.some(({ domain }) => domain === "project"), false);
});

// 缺句、非法工尺父轨和父块循环都属于结构错误，不能交给后续应用阶段猜测。
test("坏引用和循环产生结构化阻断问题", () => {
  const missingLineSource = richProject();
  missingLineSource.subtitleLines = [];
  const missingLinePlan = planFromProjects(missingLineSource, emptyProject(), [
    "characters:char-1",
  ]);
  assert.equal(missingLinePlan.canApply, false);
  assert.ok(missingLinePlan.issues.some(({ code, entryKey }) =>
    code === "missing-dependency" && entryKey === "subtitle_lines:line-1"));

  const invalidGongcheSource = richProject();
  invalidGongcheSource.gongcheAnnotations.push({
    id: "gongche-invalid",
    parentTrackId: "action-track",
    parentBlockId: "action-block",
    startTime: 2,
    endTime: 3,
    symbols: [],
  });
  const invalidGongchePlan = planFromProjects(invalidGongcheSource, emptyProject(), [
    "gongche:gongche-invalid",
  ]);
  assert.equal(invalidGongchePlan.canApply, false);
  assert.ok(invalidGongchePlan.issues.some(({ message }) =>
    message.includes("不是文字轨")));

  const cycleSource = richProject();
  const textTrack = cycleSource.customTracks.find(({ id }) => id === "text-track")!;
  textTrack.blocks[0]!.branchParentBlockId = "child-block";
  const cyclePlan = planFromProjects(cycleSource, emptyProject(), [
    "custom_blocks:text-track:child-block",
  ]);
  assert.equal(cyclePlan.canApply, false);
  assert.ok(cyclePlan.issues.some(({ code }) => code === "cyclic-dependency"));
});

// project 领域、未知 key 和错误方向都要给出可机器判定的问题，而不是静默返回空计划。
test("不支持、未知与来源缺失分别报告", () => {
  const source = richProject();
  const target = emptyProject();
  const diff = diffFor(source, target);
  const plan = planFor(source, target, diff, "left-to-right", [
    "project:project",
    "characters:not-found",
  ]);
  assert.deepEqual(plan.issues.map(({ code }) => code), [
    "unknown-entry",
    "unsupported-domain",
  ]);

  const wrongDirection = planFor(source, target, diff, "right-to-left", [
    "characters:char-1",
  ]);
  assert.deepEqual(wrongDirection.issues.map(({ code }) => code), [
    "missing-source-entity",
  ]);
});

// 重复和乱序选择必须得到同一输出，同时不得修改项目、diff 或调用方选择数组。
test("计划确定且不修改输入", () => {
  const left = richProject();
  const right = emptyProject();
  const diff = diffFor(left, right);
  const selection = ["gongche:gongche-char", "characters:char-1"];
  const before = JSON.stringify({ left, right, diff, selection });

  const first = planFor(left, right, diff, "left-to-right", selection);
  const second = planFor(left, right, diff, "left-to-right", [
    "characters:char-1",
    "gongche:gongche-char",
    "characters:char-1",
  ]);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify({ left, right, diff, selection }), before);
  assert.equal(first.counts.selected, 2);
  assert.equal(first.counts.dependencies, 1);
});

// 摘要同时统计新增、冲突和无需复制项，给下一轮 UI 提供唯一数据源。
test("计划摘要准确统计角色和目标动作", () => {
  const source = richProject();
  const target = emptyProject();
  target.subtitleLines.push(clone(source.subtitleLines[0]!));
  target.characterAnnotations.push({
    ...clone(source.characterAnnotations[0]!),
    char: "改",
  });
  const plan = planFromProjects(source, target, [
    "characters:char-1",
    "banyan_sections:section-1",
  ]);

  assert.deepEqual(plan.counts, {
    selected: 2,
    dependencies: 1,
    additions: 1,
    conflicts: 1,
    alreadyEqual: 1,
  });
});

// 测试辅助函数统一从正式 diff 生成计划，避免手写假 entry 掩盖 identity 漂移。
function planFromProjects(
  left: ProjectData,
  right: ProjectData,
  selectedEntryKeys: string[],
) {
  return planFor(
    left,
    right,
    diffFor(left, right),
    "left-to-right",
    selectedEntryKeys,
  );
}

function planFor(
  leftProject: ProjectData,
  rightProject: ProjectData,
  diff: AnnotationDiffResult,
  direction: AnnotationMergeDirection,
  selectedEntryKeys: string[],
) {
  return buildAnnotationMergePlan({
    leftProject,
    rightProject,
    diff,
    direction,
    selectedEntryKeys,
  });
}

function diffFor(left: ProjectData, right: ProjectData): AnnotationDiffResult {
  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("测试项目应当可生成结构化差异。");
  return result.diff;
}

function itemSummary(item: AnnotationMergePlan["items"][number]) {
  return `${item.entryKey}:${item.role}:${item.action}`;
}

function findItem(plan: AnnotationMergePlan, entryKey: string) {
  const item = plan.items.find((candidate) => candidate.entryKey === entryKey);
  assert.ok(item, `计划缺少 ${entryKey}`);
  return item;
}

// 丰富 fixture 覆盖本轮全部引用关系；时间内容仅用于正式 diff，不参与计划的图规则。
function richProject(): ProjectData {
  return {
    ...emptyProject(),
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [{
        id: "point-track-builtin",
        name: "换气",
        typeOptions: ["换气"],
        points: [{ id: "point-builtin", time: 0.4, label: "换气" }],
      }],
    }],
    subtitleLines: [line("line-1", "那一答")],
    characterAnnotations: [{
      id: "char-1",
      lineId: "line-1",
      char: "那",
      startTime: 0,
      endTime: 0.5,
      tone: null,
    }],
    gongcheAnnotations: [
      {
        id: "gongche-char",
        parentTrackId: "character-track",
        parentBlockId: "char-1",
        startTime: 0,
        endTime: 0.5,
        symbols: [],
      },
      {
        id: "gongche-custom",
        parentTrackId: "text-track",
        parentBlockId: "child-block",
        startTime: 1,
        endTime: 2,
        symbols: [],
      },
    ],
    banyanSections: [{
      id: "section-1",
      name: "忒忒令",
      startTime: 0,
      endTime: 4,
      cycleType: "yi_ban_san_yan",
      freeRhythm: false,
    }],
    banyanMarks: [{
      id: "mark-1",
      sectionId: "section-1",
      time: 0.25,
      estimatedTime: 0.25,
      sourceSymbol: "4",
      role: "yan",
      subtype: "middleEye",
      segment: "main",
      attachment: "on_note",
      linkedGongcheAnnotationId: "gongche-char",
      confidence: "manual",
    }],
    customTracks: [
      {
        id: "text-track",
        name: "唱词校订",
        trackType: "text",
        typeOptions: ["唱词"],
        blocks: [
          {
            id: "root-block",
            startTime: 0,
            endTime: 2,
            text: "父块",
            type: "唱词",
          },
          {
            id: "child-block",
            startTime: 1,
            endTime: 2,
            text: "子块",
            type: "唱词",
            branchParentBlockId: "root-block",
          },
        ],
        attachedPointTracks: [{
          id: "point-track-custom",
          name: "呼吸",
          typeOptions: ["呼吸"],
          points: [{ id: "point-custom", time: 1.5, label: "呼吸" }],
        }],
      },
      {
        id: "action-track",
        name: "身段",
        trackType: "action",
        typeOptions: ["动作"],
        blocks: [{
          id: "action-block",
          startTime: 2,
          endTime: 3,
          type: "动作",
        }],
        attachedPointTracks: [],
      },
    ],
    activeTrackOrder: ["character-track", "text-track", "action-track"],
  };
}

// 空项目仍保留正式内建逐字轨，便于测试内建附属点不依赖 project 领域。
function emptyProject(): ProjectData {
  return {
    video: { url: "video.mp4", name: "测试.mp4", source: "url" },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [{
        id: "point-track-builtin",
        name: "换气",
        typeOptions: ["换气"],
        points: [],
      }],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}

function line(id: string, text: string) {
  return { id, text, startTime: 0, endTime: 1, deliveryMode: null, roleTypes: [] };
}

// JSON 克隆对应保存文件语义，也使输入不变断言不受运行时 structuredClone 差异影响。
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
