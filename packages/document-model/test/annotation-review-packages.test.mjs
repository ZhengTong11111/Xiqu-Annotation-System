import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationReviewPackageFingerprintInput,
  parseAnnotationReviewPackage,
} from "../dist/index.js";

function reviewPackage(overrides = {}) {
  return {
    format: "xiqu.annotation-review-package",
    version: 1,
    exportedAt: "2026-09-01T10:00:00.000Z",
    source: {
      annotationFileId: "source-file",
      annotationFileName: "来源.json",
      revision: 7,
    },
    counts: { confirmations: 1, rangeRecords: 1 },
    records: {
      confirmations: [{
        id: "confirmation-1",
        annotationFileId: "source-file",
        confirmedRevision: 7,
        scope: { startTime: 1, endTime: 2, targets: { mode: "tracks", trackIds: ["character-track"] } },
        note: "已核对",
        createdBy: {
          id: "reviewer-1",
          accountName: "reviewer",
          displayName: "审核员",
          roles: ["teacher"],
        },
        createdAt: "2026-09-01T09:00:00.000Z",
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      }],
      rangeRecords: [{
        id: "comment-1",
        annotationFileId: "source-file",
        commentedRevision: 6,
        scope: { startTime: 3, endTime: 4, targets: { mode: "all" } },
        kind: "review_comment",
        body: "需要复核",
        createdBy: { id: "reviewer-1", accountName: "reviewer", displayName: "审核员" },
        createdAt: "2026-09-01T09:01:00.000Z",
        withdrawnAt: null,
        withdrawnBy: null,
        withdrawReason: null,
      }],
    },
    ...overrides,
  };
}

test("解析完整审核包并裁剪用户引用中的额外字段", () => {
  const parsed = parseAnnotationReviewPackage(reviewPackage());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.records.confirmations[0].createdBy, {
    id: "reviewer-1",
    accountName: "reviewer",
    displayName: "审核员",
  });
});

test("指纹排除 exportedAt 但保留事实内容", () => {
  const first = parseAnnotationReviewPackage(reviewPackage());
  const second = parseAnnotationReviewPackage(reviewPackage({
    exportedAt: "2026-09-01T11:00:00.000Z",
  }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(
    buildAnnotationReviewPackageFingerprintInput(first.value),
    buildAnnotationReviewPackageFingerprintInput(second.value),
  );
  second.value.records.rangeRecords[0].body = "正文变化";
  assert.notEqual(
    buildAnnotationReviewPackageFingerprintInput(first.value),
    buildAnnotationReviewPackageFingerprintInput(second.value),
  );
});

test("拒绝数量不符、跨文件、重复身份和半截撤销生命周期", () => {
  const empty = reviewPackage({
    counts: { confirmations: 0, rangeRecords: 0 },
    records: { confirmations: [], rangeRecords: [] },
  });
  assert.equal(parseAnnotationReviewPackage(empty).ok, false);

  const wrongCount = reviewPackage({ counts: { confirmations: 2, rangeRecords: 1 } });
  assert.equal(parseAnnotationReviewPackage(wrongCount).ok, false);

  const foreign = reviewPackage();
  foreign.records.confirmations[0].annotationFileId = "other-file";
  assert.equal(parseAnnotationReviewPackage(foreign).ok, false);

  const duplicate = reviewPackage();
  duplicate.records.confirmations.push({ ...duplicate.records.confirmations[0] });
  duplicate.counts.confirmations = 2;
  assert.equal(parseAnnotationReviewPackage(duplicate).ok, false);

  const brokenLifecycle = reviewPackage();
  brokenLifecycle.records.confirmations[0].revokedAt = "2026-09-01T09:30:00.000Z";
  assert.equal(parseAnnotationReviewPackage(brokenLifecycle).ok, false);
});
