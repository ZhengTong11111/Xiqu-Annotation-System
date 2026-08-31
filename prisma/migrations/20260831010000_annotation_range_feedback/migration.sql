ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_range_feedback_create';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_range_feedback_withdraw';

-- 历史范围评论全部保留为审核评论；新增非空列不会改变现有事实或分页顺序。
CREATE TYPE "AnnotationRangeCommentKind" AS ENUM ('review_comment', 'editor_feedback');

ALTER TABLE "annotation_range_comments"
  ADD COLUMN "kind" "AnnotationRangeCommentKind" NOT NULL DEFAULT 'review_comment';
