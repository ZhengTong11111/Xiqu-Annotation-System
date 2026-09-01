import type {
  AnnotationConfirmationList,
  AnnotationRangeCommentPage,
  AnnotationReviewPackageV1,
} from "@xiqu/shared";
import {
  ANNOTATION_REVIEW_PACKAGE_FORMAT,
  ANNOTATION_REVIEW_PACKAGE_VERSION,
} from "@xiqu/shared";
import { parseAnnotationReviewPackage } from "@xiqu/document-model";

// 保留既有导出模块常量名，调用方不需要了解合同已提升到 shared。
export const ANNOTATION_REVIEW_EXPORT_FORMAT = ANNOTATION_REVIEW_PACKAGE_FORMAT;
export const ANNOTATION_REVIEW_EXPORT_VERSION = ANNOTATION_REVIEW_PACKAGE_VERSION;

// 导出只能基于两条已经排空且属于同一文件/修订的历史流，避免生成看似完整的残缺包。
export function buildAnnotationReviewExportPackage(input: {
  annotationFileId: string;
  annotationFileName: string;
  confirmations: AnnotationConfirmationList;
  comments: AnnotationRangeCommentPage;
  exportedAt?: Date;
}): AnnotationReviewPackageV1 {
  if (input.confirmations.nextCursor || input.comments.nextCursor) {
    throw new Error("审核历史尚未完整加载，不能导出残缺审核包。");
  }
  if (input.confirmations.currentRevision !== input.comments.currentRevision) {
    throw new Error("两类审核历史基于不同服务器修订，请刷新后重新导出。");
  }
  const recordsBelongToSource = [
    ...input.confirmations.confirmations,
    ...input.comments.items,
  ].every((record) => record.annotationFileId === input.annotationFileId);
  if (!recordsBelongToSource) {
    throw new Error("审核历史包含其他文件记录，已阻止导出。");
  }

  const reviewPackage = {
    format: ANNOTATION_REVIEW_PACKAGE_FORMAT,
    version: ANNOTATION_REVIEW_PACKAGE_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    source: {
      annotationFileId: input.annotationFileId,
      annotationFileName: input.annotationFileName,
      revision: input.confirmations.currentRevision,
    },
    counts: {
      confirmations: input.confirmations.confirmations.length,
      rangeRecords: input.comments.items.length,
    },
    records: {
      confirmations: input.confirmations.confirmations,
      rangeRecords: input.comments.items,
    },
  };
  // API 用户摘要可能携带额外 roles；导出边界重新解析并裁剪为稳定交换合同。
  const normalized = parseAnnotationReviewPackage(reviewPackage);
  if (!normalized.ok) {
    throw new Error(`审核包生成结果不符合交换格式：${normalized.issues.join("；")}`);
  }
  return normalized.value;
}

export function getAnnotationReviewExportFileName(annotationFileName: string): string {
  const baseName = annotationFileName.replace(/\.json$/i, "").trim() || "annotation";
  return `${baseName}.review-package.json`;
}
