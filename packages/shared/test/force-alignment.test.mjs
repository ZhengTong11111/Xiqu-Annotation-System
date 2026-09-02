import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApplyAlignmentRunRequest,
  parseCreateAlignmentRunRequest,
  parseCreateAlignmentResearchGroupRequest,
  parseReplaceProjectAlignmentResearchGroupsRequest,
  parseUpsertAlignmentQualityAssessmentRequest,
} from "../dist/index.js";

test("强制对齐创建请求只接受规范 UUID 与固定模型预设", () => {
  const input = {
    clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelPreset: "kunqu_character_v1",
  };
  assert.deepEqual(parseCreateAlignmentRunRequest(input), { success: true, data: input });
  assert.equal(parseCreateAlignmentRunRequest({ ...input, inputRevision: 7 }).success, false);
  assert.equal(parseCreateAlignmentRunRequest({ ...input, clientRequestId: "client-1" }).success, false);
  assert.equal(parseCreateAlignmentRunRequest({ ...input, modelPreset: "custom" }).success, false);
});

test("强制对齐应用请求只接受一次动作 UUID 与正 revision", () => {
  const input = {
    clientActionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    baseRevision: 7,
  };
  assert.deepEqual(parseApplyAlignmentRunRequest(input), { success: true, data: input });
  assert.equal(parseApplyAlignmentRunRequest({ ...input, runId: "server-owned" }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, clientActionId: "action-1" }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, baseRevision: 0 }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, baseRevision: 2_147_483_647 }).success, false);
});

test("质量评价使用有限结论、规范原因顺序和严格组合", () => {
  const input = {
    clientActionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    scope: "editor",
    verdict: "needs_adjustment",
    issueCodes: ["boundary_offset", "lyric_mismatch"],
  };
  assert.deepEqual(parseUpsertAlignmentQualityAssessmentRequest(input), {
    success: true,
    data: {
      ...input,
      issueCodes: ["lyric_mismatch", "boundary_offset"],
    },
  });
  assert.equal(parseUpsertAlignmentQualityAssessmentRequest({
    ...input,
    verdict: "correct",
  }).success, false);
  assert.equal(parseUpsertAlignmentQualityAssessmentRequest({
    ...input,
    verdict: "unusable",
    issueCodes: [],
  }).success, false);
  assert.equal(parseUpsertAlignmentQualityAssessmentRequest({
    ...input,
    issueCodes: ["boundary_offset", "boundary_offset"],
  }).success, false);
  assert.equal(parseUpsertAlignmentQualityAssessmentRequest({
    ...input,
    note: "禁止自由文本",
  }).success, false);
});

test("研究分组创建严格区分稳定 UUID、有限 kind 与规范显示名", () => {
  const input = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    kind: "performer",
    displayName: "  俞振飞\u0301  ",
  };
  const parsed = parseCreateAlignmentResearchGroupRequest(input);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.displayName, "俞振飞́");
  assert.equal(parseCreateAlignmentResearchGroupRequest({ ...input, id: input.id.toUpperCase() }).success, false);
  assert.equal(parseCreateAlignmentResearchGroupRequest({ ...input, kind: "role" }).success, false);
  assert.equal(parseCreateAlignmentResearchGroupRequest({ ...input, displayName: "bad\nname" }).success, false);
  assert.equal(parseCreateAlignmentResearchGroupRequest({ ...input, note: "禁止自由字段" }).success, false);
});

test("项目研究分组完整集合要求 revision、规范 UUID、去重和固定排序", () => {
  const input = {
    expectedRevision: 3,
    groupIds: [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ],
  };
  assert.deepEqual(parseReplaceProjectAlignmentResearchGroupsRequest(input), {
    success: true,
    data: {
      expectedRevision: 3,
      groupIds: input.groupIds.toSorted(),
    },
  });
  assert.equal(parseReplaceProjectAlignmentResearchGroupsRequest({ ...input, expectedRevision: -1 }).success, false);
  assert.equal(parseReplaceProjectAlignmentResearchGroupsRequest({
    ...input,
    groupIds: [input.groupIds[0], input.groupIds[0]],
  }).success, false);
  assert.equal(parseReplaceProjectAlignmentResearchGroupsRequest({ ...input, mode: "merge" }).success, false);
});
