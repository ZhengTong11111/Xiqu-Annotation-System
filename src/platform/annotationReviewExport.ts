import type {
  AnnotationConfirmationList,
  AnnotationRangeCommentPage,
} from "@xiqu/shared";

export const ANNOTATION_REVIEW_EXPORT_FORMAT = "xiqu.annotation-review-package";
export const ANNOTATION_REVIEW_EXPORT_VERSION = 1;

export type AnnotationReviewExportPackageV1 = {
  format: typeof ANNOTATION_REVIEW_EXPORT_FORMAT;
  version: typeof ANNOTATION_REVIEW_EXPORT_VERSION;
  exportedAt: string;
  source: {
    annotationFileId: string;
    annotationFileName: string;
    revision: number;
  };
  counts: {
    confirmations: number;
    rangeRecords: number;
  };
  records: {
    confirmations: AnnotationConfirmationList["confirmations"];
    rangeRecords: AnnotationRangeCommentPage["items"];
  };
};

// 导出只能基于两条已经排空且属于同一文件/修订的历史流，避免生成看似完整的残缺包。
export function buildAnnotationReviewExportPackage(input: {
  annotationFileId: string;
  annotationFileName: string;
  confirmations: AnnotationConfirmationList;
  comments: AnnotationRangeCommentPage;
  exportedAt?: Date;
}): AnnotationReviewExportPackageV1 {
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

  return {
    format: ANNOTATION_REVIEW_EXPORT_FORMAT,
    version: ANNOTATION_REVIEW_EXPORT_VERSION,
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
}

export function getAnnotationReviewExportFileName(annotationFileName: string): string {
  const baseName = annotationFileName.replace(/\.json$/i, "").trim() || "annotation";
  return `${baseName}.review-package.json`;
}
