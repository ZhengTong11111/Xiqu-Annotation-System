import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationConfirmationScopesOverlap,
  canCreateAnnotationConfirmation,
  canRevokeAnnotationConfirmation,
  extractPersistedAnnotationTrackIds,
  getAnnotationConfirmationFreshness,
  getAnnotationConfirmationLifecycle,
  normalizeAnnotationConfirmationScope,
  validateAnnotationConfirmationDraft,
  validateAnnotationConfirmationTracks,
} from "../dist/index.js";

// 测试夹具保持最小审核事实，单项测试只覆盖自己关心的合同边界。
function scope(targets = { mode: "all" }, startTime = 10, endTime = 20) {
  return { startTime, endTime, targets };
}

function record(overrides = {}) {
  return {
    id: "confirmation-1",
    annotationFileId: "file-1",
    confirmedRevision: 3,
    scope: scope(),
    note: null,
    createdBy: {
      id: "reviewer-1",
      accountName: "reviewer",
      displayName: "审核员",
    },
    createdAt: "2026-08-02T10:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...overrides,
  };
}

// 三种作用域都应形成确定、不可变的规范化结果。
test("规范化 all、领域和轨道作用域且不修改输入", () => {
  const allInput = scope();
  const domainInput = scope({
    mode: "domains",
    domains: ["gongche_annotations", "subtitle_lines", "gongche_annotations"],
  });
  const trackInput = scope({
    mode: "tracks",
    trackIds: [" custom-b ", "character-track", "custom-b"],
  });
  const before = JSON.stringify({ allInput, domainInput, trackInput });

  assert.deepEqual(normalizeAnnotationConfirmationScope(allInput), {
    ok: true,
    value: scope(),
  });
  assert.deepEqual(normalizeAnnotationConfirmationScope(domainInput), {
    ok: true,
    value: scope({
      mode: "domains",
      domains: ["subtitle_lines", "gongche_annotations"],
    }),
  });
  assert.deepEqual(normalizeAnnotationConfirmationScope(trackInput), {
    ok: true,
    value: scope({
      mode: "tracks",
      trackIds: ["character-track", "custom-b"],
    }),
  });
  assert.equal(JSON.stringify({ allInput, domainInput, trackInput }), before);
});

// 时间、目标和未知领域错误必须显式报告，不能悄悄回退成全领域确认。
test("拒绝非法时间、空目标与未知领域", () => {
  for (const candidate of [
    scope({ mode: "all" }, -1, 2),
    scope({ mode: "all" }, 2, 2),
    scope({ mode: "all" }, 3, 2),
    scope({ mode: "all" }, Number.NaN, 2),
  ]) {
    const result = normalizeAnnotationConfirmationScope(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some(({ code }) => code === "invalid_time_range"));
  }

  const emptyDomains = normalizeAnnotationConfirmationScope(scope({ mode: "domains", domains: [] }));
  assert.equal(emptyDomains.ok, false);
  const emptyTracks = normalizeAnnotationConfirmationScope(scope({ mode: "tracks", trackIds: [] }));
  assert.equal(emptyTracks.ok, false);
  const unknownDomain = normalizeAnnotationConfirmationScope(scope({
    mode: "domains",
    domains: ["not_a_domain"],
  }));
  assert.equal(unknownDomain.ok, false);
  if (!unknownDomain.ok) {
    assert.ok(unknownDomain.issues.some(({ code }) => code === "unknown_domain"));
  }
});

// 草稿会 trim 文件标识与备注，并统一空白备注为 null。
test("校验并规范化确认草稿", () => {
  const valid = validateAnnotationConfirmationDraft({
    annotationFileId: " file-1 ",
    confirmedRevision: 4,
    scope: scope(),
    note: "  已核对唱段  ",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.annotationFileId, "file-1");
    assert.equal(valid.value.note, "已核对唱段");
  }

  const blankNote = validateAnnotationConfirmationDraft({
    annotationFileId: "file-1",
    confirmedRevision: 1,
    scope: scope(),
    note: "   ",
  });
  assert.equal(blankNote.ok, true);
  if (blankNote.ok) assert.equal(blankNote.value.note, null);
});

// 文件 id、revision、轨道 id 和备注长度分别形成机器可判定问题。
test("草稿坏输入返回结构化问题", () => {
  const result = validateAnnotationConfirmationDraft({
    annotationFileId: " ",
    confirmedRevision: 0,
    scope: scope({ mode: "tracks", trackIds: [" "] }),
    note: "x".repeat(2_001),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(new Set(result.issues.map(({ code }) => code)), new Set([
      "invalid_file_id",
      "invalid_revision",
      "invalid_track_id",
      "invalid_targets",
      "note_too_long",
    ]));
  }
});

// 轨道作用域必须对照当前项目真实持久轨道，派生伪轨和附属点不会仅凭字符串被接受。
test("轨道作用域按真实持久轨道集合校验", () => {
  const valid = validateAnnotationConfirmationTracks(
    scope({ mode: "tracks", trackIds: ["character-track", "custom-1"] }),
    new Set(["character-track", "custom-1"]),
  );
  assert.equal(valid.ok, true);

  const invalid = validateAnnotationConfirmationTracks(
    scope({ mode: "tracks", trackIds: ["branch-lane:custom-1:lane-1", "point-1"] }),
    new Set(["character-track", "custom-1"]),
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.issues.filter(({ code }) => code === "unknown_track_id").length, 2);
  }
});

// payload 轨道提取只接受顶层保存轨，明确排除工尺、分叉和附属点可视轨。
test("从当前 payload 保守提取持久轨道", () => {
  const payload = {
    builtinTracks: [{ id: "character-track" }, { id: "legacy-action" }],
    customTracks: [{
      id: "custom-1",
      branching: { lanes: [{ id: "branch-lane-1" }] },
      attachedPointTracks: [{ id: "point-track-1" }],
    }],
    activeTrackOrder: ["gongche:character-track", "branch-lane:custom-1:branch-lane-1"],
  };
  assert.deepEqual(extractPersistedAnnotationTrackIds(payload), {
    ok: true,
    value: ["character-track", "custom-1"],
  });
  const unrecognized = extractPersistedAnnotationTrackIds({ customTracks: [] });
  assert.equal(unrecognized.ok, false);
  if (!unrecognized.ok) {
    assert.equal(unrecognized.issues[0].code, "unrecognized_track_payload");
  }
});

// 撤销主体与时间必须成组出现，合法记录保持 active/revoked 两态。
test("确认生命周期严格校验撤销字段", () => {
  assert.deepEqual(getAnnotationConfirmationLifecycle(record()), {
    ok: true,
    value: "active",
  });
  assert.deepEqual(getAnnotationConfirmationLifecycle(record({
    revokedAt: "2026-08-02T11:00:00.000Z",
    revokedBy: {
      id: "reviewer-1",
      accountName: "reviewer",
      displayName: "审核员",
    },
  })), {
    ok: true,
    value: "revoked",
  });
  const incomplete = getAnnotationConfirmationLifecycle(record({
    revokedAt: "2026-08-02T11:00:00.000Z",
    revokedBy: null,
  }));
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.issues[0].code, "invalid_revocation");

  const reasonOnly = getAnnotationConfirmationLifecycle(record({
    revokeReason: "没有撤销主体",
  }));
  assert.equal(reasonOnly.ok, false);
  const invalidDate = getAnnotationConfirmationLifecycle(record({
    revokedAt: "not-a-date",
    revokedBy: {
      id: "reviewer-1",
      accountName: "reviewer",
      displayName: "审核员",
    },
  }));
  assert.equal(invalidDate.ok, false);
});

// revision 只允许 current 或向前变成 stale，数据库时间倒退属于错误。
test("确认 freshness 保守跟随服务器 revision", () => {
  assert.deepEqual(getAnnotationConfirmationFreshness(3, 3), {
    ok: true,
    value: "current",
  });
  assert.deepEqual(getAnnotationConfirmationFreshness(3, 4), {
    ok: true,
    value: "stale",
  });
  const regressed = getAnnotationConfirmationFreshness(3, 2);
  assert.equal(regressed.ok, false);
  if (!regressed.ok) assert.equal(regressed.issues[0].code, "revision_regressed");
  const invalidConfirmed = getAnnotationConfirmationFreshness(0, 2);
  assert.equal(invalidConfirmed.ok, false);
  if (!invalidConfirmed.ok) assert.equal(invalidConfirmed.issues[0].code, "invalid_revision");
});

// 半开区间首尾相接不重叠，all 覆盖任意维度，同类目标只有交集才重叠。
test("确认范围按时间和作用域维度判断重叠", () => {
  assert.equal(annotationConfirmationScopesOverlap(scope(), scope({ mode: "all" }, 20, 30)), false);
  assert.equal(annotationConfirmationScopesOverlap(scope(), scope({ mode: "all" }, 19, 30)), true);
  assert.equal(annotationConfirmationScopesOverlap(
    scope({ mode: "domains", domains: ["subtitle_lines"] }),
    scope({ mode: "domains", domains: ["subtitle_lines", "banyan_marks"] }),
  ), true);
  assert.equal(annotationConfirmationScopesOverlap(
    scope({ mode: "domains", domains: ["subtitle_lines"] }),
    scope({ mode: "domains", domains: ["banyan_marks"] }),
  ), false);
  assert.equal(annotationConfirmationScopesOverlap(
    scope({ mode: "tracks", trackIds: ["track-a"] }),
    scope({ mode: "tracks", trackIds: ["track-b"] }),
  ), false);
  assert.equal(annotationConfirmationScopesOverlap(
    scope({ mode: "domains", domains: ["subtitle_lines"] }),
    scope({ mode: "tracks", trackIds: ["character-track"] }),
  ), false);
});

// 创建与撤销都要求 read + review；撤销他人记录还要求管理员或 owner 身份。
test("审核权限与 write/manage permissions 保持正交", () => {
  const base = {
    actorUserId: "reviewer-1",
    canRead: true,
    canReview: true,
    isAdminOrOwner: false,
  };
  assert.deepEqual(canCreateAnnotationConfirmation(base), {
    allowed: true,
    reason: "allowed",
  });
  assert.equal(canCreateAnnotationConfirmation({ ...base, canRead: false }).reason, "read_required");
  assert.equal(canCreateAnnotationConfirmation({ ...base, canReview: false }).reason, "review_required");
  assert.equal(canRevokeAnnotationConfirmation(base, "reviewer-1").allowed, true);
  assert.equal(
    canRevokeAnnotationConfirmation(base, "reviewer-2").reason,
    "creator_or_manager_required",
  );
  assert.equal(canRevokeAnnotationConfirmation(
    { ...base, isAdminOrOwner: true },
    "reviewer-2",
  ).allowed, true);
});
