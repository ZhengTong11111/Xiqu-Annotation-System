import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectData } from "@xiqu/document-model";
import {
  PLATFORM_GONGCHE_CHANGED_SKIP_REASON,
  PLATFORM_V0902_MERGE_PLAN_VERSION,
  PLATFORM_V0902_MERGE_STATE_VERSION,
  buildPlatformV0902PlanFingerprint,
  findCompletedPlatformV0902StateIssues,
  findSkippedPlatformV0902StateIssues,
  hashJson,
  mergeProjectPlatformFirst,
  normalizePlatformProjectPayload,
  parsePlatformV0902MergePlan,
  parsePlatformV0902MergeState,
  type PlatformV0902MergePlan,
} from "./platformV0902MergeCore.js";

test("三方合并遵守 platform > v0902 > v0901 的字段优先级", () => {
  const base = fixture();
  const platform = clone(base);
  const incoming = clone(base);
  platform.subtitleLines[0]!.text = "平台文字";
  incoming.subtitleLines[0]!.text = "v0902文字";
  incoming.subtitleLines[0]!.endTime = 3;

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  if (!result.ok) return;
  assert.equal(result.project.subtitleLines[0]!.text, "平台文字");
  assert.equal(result.project.subtitleLines[0]!.endTime, 3);
  assert.ok(result.decisions.platformPaths.some((path) => path.endsWith("/text")));
  assert.ok(result.decisions.incomingPaths.some((path) => path.endsWith("/endTime")));
});

test("平台删除胜过 v0902 修改，v0902 删除在平台未改时生效", () => {
  const base = fixture();
  base.subtitleLines.push(line("line-2", "二", 2, 3));
  const platform = clone(base);
  const incoming = clone(base);
  platform.subtitleLines = platform.subtitleLines.filter(({ id }) => id !== "line-1");
  incoming.subtitleLines[0]!.text = "v0902仍修改被平台删除的句子";
  incoming.subtitleLines = incoming.subtitleLines.filter(({ id }) => id !== "line-2");

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.subtitleLines, []);
});

test("双方不同 ID 的新增均保留，同 ID 新增由平台完整胜出", () => {
  const base = fixture();
  const platform = clone(base);
  const incoming = clone(base);
  platform.subtitleLines.push(line("platform-only", "平台新增", 3, 4));
  incoming.subtitleLines.push(line("incoming-only", "v0902新增", 4, 5));
  platform.subtitleLines.push(line("same-new", "平台同ID", 5, 6));
  incoming.subtitleLines.push(line("same-new", "v0902同ID", 5, 8));

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.subtitleLines.map(({ id }) => id), [
    "line-1",
    "platform-only",
    "same-new",
    "incoming-only",
  ]);
  assert.equal(result.project.subtitleLines.find(({ id }) => id === "same-new")!.text, "平台同ID");
  assert.equal(result.project.subtitleLines.find(({ id }) => id === "same-new")!.endTime, 6);
});

test("平台未改工尺时，嵌套轨道块、附属点和 v0902 工尺字段继续合并", () => {
  const base = fixtureWithNestedAnnotations();
  const platform = clone(base);
  const incoming = clone(base);
  platform.customTracks[0]!.blocks[0]!.startTime = 0.25;
  incoming.customTracks[0]!.blocks[0]!.type = "v0902类型";
  platform.customTracks[0]!.attachedPointTracks[0]!.points[0]!.label = "平台点";
  incoming.customTracks[0]!.attachedPointTracks[0]!.points[0]!.time = 0.75;
  incoming.gongcheAnnotations[0]!.symbols[0]!.notation = "v0902-notation";

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const track = result.project.customTracks[0]!;
  assert.equal(track.blocks[0]!.startTime, 0.25);
  assert.equal(track.blocks[0]!.type, "v0902类型");
  assert.equal(track.attachedPointTracks[0]!.points[0]!.label, "平台点");
  assert.equal(track.attachedPointTracks[0]!.points[0]!.time, 0.75);
  assert.equal(result.project.gongcheAnnotations[0]!.symbols[0]!.label, "上");
  assert.equal(result.project.gongcheAnnotations[0]!.symbols[0]!.notation, "v0902-notation");
});

test("平台新增、删除或修改工尺时整折标记为跳过", async (t) => {
  const edits: Array<[string, (project: ProjectData) => void]> = [
    ["新增", (project) => project.gongcheAnnotations.push({
      id: "gongche-2",
      parentTrackId: "text-track",
      parentBlockId: "block-1",
      startTime: 0,
      endTime: 1,
      symbols: [],
    })],
    ["删除", (project) => { project.gongcheAnnotations = []; }],
    ["修改子字段", (project) => { project.gongcheAnnotations[0]!.symbols[0]!.label = "平台修改"; }],
  ];
  for (const [name, edit] of edits) {
    await t.test(name, () => {
      const base = fixtureWithNestedAnnotations();
      const platform = clone(base);
      const incoming = clone(base);
      edit(platform);
      incoming.subtitleLines[0]!.endTime = 3;

      const result = mergeProjectPlatformFirst({ base, platform, incoming });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.disposition, "skipped");
      assert.deepEqual(result.issues, [PLATFORM_GONGCHE_CHANGED_SKIP_REASON]);
      assert.equal(result.decisions.platform, 0);
      assert.equal(result.decisions.incoming, 0);
    });
  }
});

test("平台改过工尺时不因 v0902 重复 ID 改为整批阻断", () => {
  const base = fixtureWithNestedAnnotations();
  const platform = clone(base);
  const incoming = clone(base);
  platform.gongcheAnnotations[0]!.symbols[0]!.label = "平台修改";
  incoming.subtitleLines.push(clone(incoming.subtitleLines[0]!));

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.disposition, "skipped");
  assert.deepEqual(result.issues, [PLATFORM_GONGCHE_CHANGED_SKIP_REASON]);
});

test("平台媒体正文始终保留，普通数组冲突也采用平台", () => {
  const base = fixture();
  const platform = clone(base);
  const incoming = clone(base);
  platform.video.name = "平台VOD.mp4";
  incoming.video.name = "本地文件.mp4";
  platform.sentenceAnnotationConfig.roleOptions = ["平台角色"];
  incoming.sentenceAnnotationConfig.roleOptions = ["v0902角色"];

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.video.name, "平台VOD.mp4");
  assert.deepEqual(result.project.sentenceAnnotationConfig.roleOptions, ["平台角色"]);
});

test("平台改过时间区间任意一端时 start/end 整对取平台", () => {
  const base = fixture();
  base.characterAnnotations = [character("char-1", "字", 0, 2)];
  const platform = clone(base);
  const incoming = clone(base);
  platform.characterAnnotations[0]!.startTime = 0.5;
  incoming.characterAnnotations[0]!.endTime = 0.25;
  incoming.characterAnnotations[0]!.tone = { toneClass: "yin_ping" };

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    [result.project.characterAnnotations[0]!.startTime, result.project.characterAnnotations[0]!.endTime],
    [0.5, 2],
  );
  assert.deepEqual(result.project.characterAnnotations[0]!.tone, { toneClass: "yin_ping" });
});

test("结构判别字段分歧且另一方也有修改时阻断，不整对象丢字段", () => {
  const base = fixtureWithNestedAnnotations();
  base.customTracks[0]!.branching = {
    enabled: true,
    displayMode: "expanded",
    lanes: [
      { id: "lane-1", name: "分支一", parentId: null },
      { id: "lane-2", name: "分支二", parentId: null },
    ],
  };
  base.customTracks[0]!.blocks[0]!.branchScope = { mode: "lanes", laneIds: ["lane-1"] };
  const platform = clone(base);
  const incoming = clone(base);
  platform.customTracks[0]!.blocks[0]!.branchScope = { mode: "root" };
  incoming.customTracks[0]!.blocks[0]!.branchScope = { mode: "lanes", laneIds: ["lane-2"] };

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("/mode")));
});

test("平台删除父实体而 v0902 新增子引用时整体阻断", () => {
  const base = fixture();
  const platform = clone(base);
  const incoming = clone(base);
  platform.subtitleLines = [];
  incoming.characterAnnotations.push({
    id: "char-new",
    lineId: "line-1",
    char: "新",
    startTime: 0,
    endTime: 1,
    tone: null,
  });
  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("引用不存在的句")));
});

test("重复稳定 ID 和非法计划 fingerprint 均被拒绝", () => {
  const base = fixture();
  base.subtitleLines.push(clone(base.subtitleLines[0]!));
  const result = mergeProjectPlatformFirst({ base, platform: base, incoming: base });
  assert.equal(result.ok, false);

  const unsigned = {
    version: PLATFORM_V0902_MERGE_PLAN_VERSION,
    generatedAt: "2026-09-03T00:00:00.000Z",
    baseUrl: "https://example.test/api",
    sourceDirectory: "/tmp/source",
    rows: [],
    summary: {
      modifiedV0901Count: 0,
      readyCount: 0,
      saveCount: 0,
      renameOnlyCount: 0,
      skippedCount: 0,
      blockedCount: 0,
      unusedLocalJsonCount: 0,
    },
  };
  const fingerprint = buildPlatformV0902PlanFingerprint(unsigned);
  assert.equal(parsePlatformV0902MergePlan({ ...unsigned, fingerprint }).fingerprint, fingerprint);
  assert.throws(() => parsePlatformV0902MergePlan({ ...unsigned, fingerprint: hashJson("wrong") }));
});

test("执行状态逐行绑定计划并严格校验 completed 提交事实", () => {
  const plan = planFixture();
  const operationId = "12345678-1234-4234-8234-123456789abc";
  const pending = {
    version: PLATFORM_V0902_MERGE_STATE_VERSION,
    planFingerprint: plan.fingerprint,
    rows: {
      "resource-1": {
        resourceId: "resource-1",
        operationId,
        status: "pending",
        expectedBaseRevision: 7,
        mergedHash: "merged-hash",
        targetName: "001_v0902_test.json",
      },
    },
  };
  assert.equal(parsePlatformV0902MergeState(pending, plan).rows["resource-1"]!.status, "pending");
  assert.throws(() => parsePlatformV0902MergeState({
    ...pending,
    rows: { ...pending.rows, unexpected: pending.rows["resource-1"] },
  }, plan), /资源集合/u);
  assert.throws(() => parsePlatformV0902MergeState({
    ...pending,
    rows: {
      "resource-1": { ...pending.rows["resource-1"], expectedBaseRevision: 8 },
    },
  }, plan), /与计划不一致/u);
  assert.throws(() => parsePlatformV0902MergeState({
    ...pending,
    rows: {
      "resource-1": { ...pending.rows["resource-1"], status: "completed" },
    },
  }, plan), /completed 字段无效/u);

  const completed = {
    ...pending,
    rows: {
      "resource-1": {
        ...pending.rows["resource-1"],
        status: "completed",
        committedRevision: 8,
        completedAt: "2026-09-04T00:00:00.000Z",
      },
    },
  };
  const parsed = parsePlatformV0902MergeState(completed, plan);
  const stateRow = parsed.rows["resource-1"]!;
  assert.deepEqual(findCompletedPlatformV0902StateIssues(plan.rows[0]!, stateRow, {
    name: "001_v0902_test.json",
    parentId: "project-1",
    mediaResourceId: "media-1",
    revision: 8,
    projectHash: "merged-hash",
  }), []);
  assert.ok(findCompletedPlatformV0902StateIssues(plan.rows[0]!, stateRow, {
    name: "001_v0902_test.json",
    parentId: "project-1",
    mediaResourceId: "media-1",
    revision: 8,
    projectHash: "wrong-hash",
  }).includes("提交 revision 的正文哈希不一致"));
  assert.deepEqual(findCompletedPlatformV0902StateIssues(plan.rows[0]!, stateRow, {
    name: "001_v0902_test.json",
    parentId: "project-1",
    mediaResourceId: "media-1",
    revision: 9,
    projectHash: "后续用户修改允许不同哈希",
    committedRevisionProjectHash: "merged-hash",
  }), []);
  assert.ok(findCompletedPlatformV0902StateIssues(plan.rows[0]!, stateRow, {
    name: "001_v0902_test.json",
    parentId: "project-1",
    mediaResourceId: "media-1",
    revision: 9,
    projectHash: "后续用户修改",
  }).includes("无法证明已提交 revision 的正文等于计划合并结果"));
});

test("跳过行验证名称、父级、媒体、revision 和正文均保持计划原值", () => {
  const executable = planFixture().rows[0]!;
  const skipped = {
    ...executable,
    currentName: "001_v0901_test.json",
    currentHash: "platform-hash",
    mergedHash: null,
    action: "skipped" as const,
    skipReason: PLATFORM_GONGCHE_CHANGED_SKIP_REASON,
  };
  assert.deepEqual(findSkippedPlatformV0902StateIssues(skipped, {
    name: skipped.currentName,
    parentId: skipped.parentId,
    mediaResourceId: skipped.mediaResourceId,
    revision: skipped.currentRevision,
    projectHash: skipped.currentHash,
  }), []);
  assert.deepEqual(findSkippedPlatformV0902StateIssues(skipped, {
    name: "001_v0902_test.json",
    parentId: "other-project",
    mediaResourceId: "other-media",
    revision: skipped.currentRevision + 1,
    projectHash: "changed",
  }), [
    "跳过文件名称发生变化",
    "跳过文件父级发生变化",
    "跳过文件媒体绑定发生变化",
    "跳过文件 revision 发生变化",
    "跳过文件正文哈希发生变化",
  ]);
});

test("合并不修改输入且结果哈希确定", () => {
  const base = fixtureWithNestedAnnotations();
  const platform = clone(base);
  const incoming = clone(base);
  incoming.subtitleLines[0]!.endTime = 4;
  const before = JSON.stringify({ base, platform, incoming });
  const first = mergeProjectPlatformFirst({ base, platform, incoming });
  const second = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(JSON.stringify({ base, platform, incoming }), before);
  assert.deepEqual(first, second);
  if (first.ok && second.ok) assert.equal(hashJson(first.project), hashJson(second.project));
});

test("旧版内建动作轨迁移达到确定性固定点", () => {
  const raw = fixture() as unknown as Record<string, unknown>;
  raw.builtinTracks = [
    ...(raw.builtinTracks as unknown[]),
    { id: "hand-action", name: "手部动作轨", type: "action", attachedPointTracks: [] },
  ];
  raw.actionAnnotations = [{
    id: "action-1",
    trackId: "hand-action",
    label: "抬手",
    startTime: 0,
    endTime: 1,
  }];
  const first = normalizePlatformProjectPayload(raw);
  const second = normalizePlatformProjectPayload(first);
  assert.deepEqual(second, first);
  assert.equal(first.customTracks[0]?.color, "#0ea5e9");
});

test("字符 ID 整体变化时按句内序位逐字段合并且不重复字符", () => {
  const base = fixture();
  base.characterAnnotations = [
    character("base-1", "苦", 0, 1),
    character("base-2", "哇", 1, 2),
  ];
  const platform = clone(base);
  platform.characterAnnotations = [
    character("base-1", "苦", 0, 0.8),
    character("base-2", "吓", 0.8, 2),
  ];
  const incoming = clone(base);
  incoming.characterAnnotations = [
    character("v0902-1", "苦", 0.1, 1),
    character("v0902-2", "哇", 1, 1.9),
  ];

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.project.characterAnnotations.length, 2);
  assert.deepEqual(result.project.characterAnnotations.map(({ id }) => id), ["v0902-1", "v0902-2"]);
  assert.deepEqual(result.project.characterAnnotations.map(({ char }) => char), ["苦", "吓"]);
  assert.deepEqual(
    result.project.characterAnnotations.map(({ startTime, endTime }) => [startTime, endTime]),
    [[0, 0.8], [0.8, 2]],
  );
});

test("平台保留旧字身份并新增字时，结构优先但旧字仍逐字段合并", () => {
  const base = fixture();
  base.characterAnnotations = [character("base-1", "苦", 0, 1)];
  const platform = clone(base);
  platform.characterAnnotations = [
    character("base-1", "苦", 0, 0.5),
    character("platform-2", "哇", 0.5, 1),
  ];
  const incoming = clone(base);
  incoming.characterAnnotations = [character("v0902-1", "苦", 0.1, 0.9)];
  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.project.characterAnnotations.map(({ id, char }) => [id, char]),
    [["v0902-1", "苦"], ["platform-2", "哇"]],
  );
  assert.deepEqual(
    result.project.characterAnnotations.map(({ startTime, endTime }) => [startTime, endTime]),
    [[0, 0.5], [0.5, 1]],
  );
});

test("所有时间线集合在 v0902 ID 重建时按时序对应并逐字段合并", () => {
  const base = fixtureWithNestedAnnotations();
  base.characterAnnotations = [character("char-old", "字", 0, 1)];
  base.customTracks[0]!.blocks.push({
    id: "block-2",
    startTime: 1,
    endTime: 2,
    text: "二",
    type: "初始类型",
  });
  base.customTracks[0]!.attachedPointTracks[0]!.points.push({ id: "point-2", time: 1.5, label: "二" });
  base.gongcheAnnotations[0]!.symbols.push({ id: "symbol-2", label: "尺", startTime: 0.5, endTime: 1 });
  const platform = clone(base);
  platform.subtitleLines[0]!.text = "平台句子";
  platform.characterAnnotations[0]!.char = "平";
  platform.customTracks[0]!.blocks[0]!.text = "平台块";
  platform.customTracks[0]!.attachedPointTracks[0]!.points[0]!.label = "平台点";

  const incoming = clone(base);
  incoming.subtitleLines[0] = { ...incoming.subtitleLines[0]!, endTime: 2.2 };
  incoming.characterAnnotations[0] = {
    ...incoming.characterAnnotations[0]!,
    id: "char-new",
    endTime: 0.9,
  };
  incoming.customTracks[0]!.blocks = incoming.customTracks[0]!.blocks.map((block, index) => ({
    ...block,
    id: `block-new-${index + 1}`,
    endTime: block.endTime - 0.1,
  }));
  incoming.gongcheAnnotations[0]!.parentBlockId = "block-new-1";
  incoming.customTracks[0]!.attachedPointTracks[0]!.points =
    incoming.customTracks[0]!.attachedPointTracks[0]!.points.map((point, index) => ({
      ...point,
      id: `point-new-${index + 1}`,
      time: point.time + 0.1,
    }));
  incoming.gongcheAnnotations[0]!.symbols = incoming.gongcheAnnotations[0]!.symbols.map((symbol, index) => ({
    ...symbol,
    id: `symbol-new-${index + 1}`,
    notation: `v0902-${index + 1}`,
  }));

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  if (!result.ok) return;
  assert.deepEqual(result.project.subtitleLines[0], {
    ...incoming.subtitleLines[0],
    text: "平台句子",
  });
  assert.deepEqual(result.project.characterAnnotations[0], {
    ...incoming.characterAnnotations[0],
    char: "平",
  });
  assert.deepEqual(result.project.customTracks[0]!.blocks.map((block) =>
    [block.id, "text" in block ? block.text : undefined, block.endTime]), [
    ["block-new-1", "平台块", 0.9],
    ["block-new-2", "二", 1.9],
  ]);
  assert.deepEqual(
    result.project.customTracks[0]!.attachedPointTracks[0]!.points.map(({ id, label, time }) => [id, label, time]),
    [["point-new-1", "平台点", 0.6], ["point-new-2", "二", 1.6]],
  );
  assert.deepEqual(
    result.project.gongcheAnnotations[0]!.symbols.map(({ id, label, notation }) => [id, label, notation]),
    [["symbol-new-1", "上", "v0902-1"], ["symbol-new-2", "尺", "v0902-2"]],
  );
});

test("平台字级 ID 全变且数量改变时整套保留平台字级标注", () => {
  const base = fixture();
  base.characterAnnotations = [character("base-1", "苦", 0, 1)];
  const platform = clone(base);
  platform.characterAnnotations = [
    character("platform-1", "苦", 0, 0.5),
    character("platform-2", "哇", 0.5, 1),
  ];
  const incoming = clone(base);
  incoming.characterAnnotations = [character("v0902-1", "苦", 0.1, 0.9)];
  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.characterAnnotations, platform.characterAnnotations);
  assert.ok(result.decisions.platformPaths.some((path) => path.includes("platform-rebuilt-collection")));
});

test("非字级时间线 ID 全变且数量不同仍阻断", () => {
  const base = fixtureWithNestedAnnotations();
  base.gongcheAnnotations = [];
  const platform = clone(base);
  platform.customTracks[0]!.blocks = [
    { id: "platform-1", startTime: 0, endTime: 0.5, text: "一", type: "初始类型" },
    { id: "platform-2", startTime: 0.5, endTime: 1, text: "二", type: "初始类型" },
  ];
  const incoming = clone(base);
  incoming.customTracks[0]!.blocks[0]!.endTime = 0.9;
  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes("无法无歧义对应")));
});

test("平台换句依靠稳定 ID 保留，v0902 跨父级又重建 ID 则阻断", () => {
  const base = fixture();
  base.subtitleLines.push(line("line-2", "二", 2, 3));
  base.characterAnnotations = [character("base-1", "苦", 0, 1)];
  const platform = clone(base);
  platform.characterAnnotations[0]!.lineId = "line-2";
  platform.characterAnnotations[0]!.endTime = 0.8;
  const incoming = clone(base);
  incoming.characterAnnotations = [character("v0902-1", "苦", 0.1, 0.9)];

  const result = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.characterAnnotations[0], {
    ...incoming.characterAnnotations[0],
    lineId: "line-2",
    startTime: 0,
    endTime: 0.8,
  });

  incoming.characterAnnotations[0]!.lineId = "line-2";
  const ambiguous = mergeProjectPlatformFirst({ base, platform, incoming });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.ok(ambiguous.issues.some((issue) => issue.includes("父级")));
});

function fixture(): ProjectData {
  return {
    video: { url: "", name: "base.mp4", source: "embedded", filePath: null, requiresManualImport: true },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [line("line-1", "初始", 0, 2)],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{ id: "character-track", name: "逐字文字轨", type: "character", attachedPointTracks: [] }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}

function fixtureWithNestedAnnotations(): ProjectData {
  const project = fixture();
  project.customTracks.push({
    id: "text-track",
    name: "唱腔",
    trackType: "text",
    typeOptions: ["初始类型", "v0902类型"],
    blocks: [{ id: "block-1", startTime: 0, endTime: 1, text: "字", type: "初始类型" }],
    attachedPointTracks: [{
      id: "point-track",
      name: "呼吸",
      typeOptions: ["换气"],
      points: [{ id: "point-1", time: 0.5, label: "初始点" }],
    }],
  });
  project.activeTrackOrder.push("text-track");
  project.gongcheAnnotations.push({
    id: "gongche-1",
    parentTrackId: "text-track",
    parentBlockId: "block-1",
    startTime: 0,
    endTime: 1,
    symbols: [{ id: "symbol-1", label: "上", startTime: 0, endTime: 1 }],
  });
  return project;
}

function line(id: string, text: string, startTime: number, endTime: number) {
  return { id, text, startTime, endTime, deliveryMode: null, roleTypes: [] } as const;
}

function character(id: string, char: string, startTime: number, endTime: number) {
  return { id, lineId: "line-1", char, startTime, endTime, tone: null };
}

function planFixture(): PlatformV0902MergePlan {
  const unsigned = {
    version: PLATFORM_V0902_MERGE_PLAN_VERSION,
    generatedAt: "2026-09-04T00:00:00.000Z",
    baseUrl: "https://example.test/api",
    sourceDirectory: "/tmp/source",
    rows: [{
      resourceId: "resource-1",
      parentId: "project-1",
      platformPath: "项目 / 001_v0901_test.json",
      currentName: "001_v0901_test.json",
      targetName: "001_v0902_test.json",
      sourceRelativePath: "001_v0902_test.json",
      currentRevision: 7,
      mediaResourceId: "media-1",
      baseSnapshotId: "snapshot-1",
      baseHash: "base-hash",
      currentHash: "current-hash",
      incomingHash: "incoming-hash",
      mergedHash: "merged-hash",
      action: "save_and_rename" as const,
      skipReason: null,
      decisions: null,
      blockers: [],
    }],
    summary: {
      modifiedV0901Count: 1,
      readyCount: 1,
      saveCount: 1,
      renameOnlyCount: 0,
      skippedCount: 0,
      blockedCount: 0,
      unusedLocalJsonCount: 0,
    },
  } satisfies Omit<PlatformV0902MergePlan, "fingerprint">;
  return { ...unsigned, fingerprint: buildPlatformV0902PlanFingerprint(unsigned) };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
