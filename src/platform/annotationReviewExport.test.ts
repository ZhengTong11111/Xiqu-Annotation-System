import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationConfirmationList,
  AnnotationRangeCommentPage,
} from "@xiqu/shared";
import {
  ANNOTATION_REVIEW_EXPORT_FORMAT,
  buildAnnotationReviewExportPackage,
  getAnnotationReviewExportFileName,
} from "./annotationReviewExport";

function createCompleteHistory() {
  const confirmations: AnnotationConfirmationList = {
    currentRevision: 9,
    nextCursor: null,
    confirmations: [{
      id: "confirmation-1",
      annotationFileId: "file-1",
      confirmedRevision: 9,
      scope: { startTime: 1, endTime: 2, targets: { mode: "all" } },
      note: "已核对",
      createdBy: { id: "reviewer-1", accountName: "reviewer", displayName: "审核员" },
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
  };
  const comments: AnnotationRangeCommentPage = {
    currentRevision: 9,
    nextCursor: null,
    items: [{
      id: "feedback-1",
      annotationFileId: "file-1",
      commentedRevision: 9,
      scope: { startTime: 3, endTime: 4, targets: { mode: "all" } },
      kind: "editor_feedback",
      body: "请复核身段衔接",
      createdBy: { id: "editor-1", accountName: "editor", displayName: "标注者" },
      createdAt: "2026-09-01T00:01:00.000Z",
    }],
  };
  return { confirmations, comments };
}

test("导出包保存完整来源、版本与两类审核事实", () => {
  const history = createCompleteHistory();
  const result = buildAnnotationReviewExportPackage({
    annotationFileId: "file-1",
    annotationFileName: "寻梦.json",
    confirmations: history.confirmations,
    comments: history.comments,
    exportedAt: new Date("2026-09-01T01:00:00.000Z"),
  });

  assert.equal(result.format, ANNOTATION_REVIEW_EXPORT_FORMAT);
  assert.equal(result.version, 1);
  assert.deepEqual(result.source, {
    annotationFileId: "file-1",
    annotationFileName: "寻梦.json",
    revision: 9,
  });
  assert.deepEqual(result.counts, { confirmations: 1, rangeRecords: 1 });
  assert.equal(result.records.confirmations[0]?.note, "已核对");
  assert.equal(result.records.rangeRecords[0]?.body, "请复核身段衔接");
  assert.doesNotMatch(JSON.stringify(result), /nextCursor|accessToken|mediaUrl|projectData/i);
});

test("存在未消费游标时拒绝导出残缺历史", () => {
  const history = createCompleteHistory();
  assert.throws(() => buildAnnotationReviewExportPackage({
    annotationFileId: "file-1",
    annotationFileName: "寻梦.json",
    confirmations: { ...history.confirmations, nextCursor: "more" },
    comments: history.comments,
  }), /尚未完整加载/);
});

test("两条历史流修订不同或包含其他文件记录时拒绝导出", () => {
  const history = createCompleteHistory();
  assert.throws(() => buildAnnotationReviewExportPackage({
    annotationFileId: "file-1",
    annotationFileName: "寻梦.json",
    confirmations: history.confirmations,
    comments: { ...history.comments, currentRevision: 10 },
  }), /不同服务器修订/);

  assert.throws(() => buildAnnotationReviewExportPackage({
    annotationFileId: "file-1",
    annotationFileName: "寻梦.json",
    confirmations: history.confirmations,
    comments: {
      ...history.comments,
      items: history.comments.items.map((item) => ({ ...item, annotationFileId: "file-2" })),
    },
  }), /其他文件记录/);
});

test("导出文件名保留原标注名称并去除末尾 JSON 扩展名", () => {
  assert.equal(getAnnotationReviewExportFileName("寻梦.json"), "寻梦.review-package.json");
  assert.equal(getAnnotationReviewExportFileName("  "), "annotation.review-package.json");
});
