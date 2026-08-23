ALTER TYPE "AuditAction" ADD VALUE 'annotation_range_comment_create';
ALTER TYPE "AuditAction" ADD VALUE 'annotation_range_comment_withdraw';

CREATE TABLE "annotation_range_comments" (
  "id" TEXT NOT NULL,
  "annotation_file_id" TEXT NOT NULL,
  "commented_revision" INTEGER NOT NULL,
  "start_time" DOUBLE PRECISION NOT NULL,
  "end_time" DOUBLE PRECISION NOT NULL,
  "target_mode" "AnnotationConfirmationTargetMode" NOT NULL,
  "domains" "AnnotationConfirmationDomain"[] NOT NULL DEFAULT ARRAY[]::"AnnotationConfirmationDomain"[],
  "track_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "body" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawn_by" TEXT,
  "withdrawn_at" TIMESTAMP(3),
  "withdraw_reason" TEXT,

  CONSTRAINT "annotation_range_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "annotation_range_comments_revision_check" CHECK ("commented_revision" > 0),
  CONSTRAINT "annotation_range_comments_range_check" CHECK (
    "start_time" >= 0 AND "end_time" > "start_time"
  ),
  CONSTRAINT "annotation_range_comments_body_check" CHECK (
    length(btrim("body")) BETWEEN 1 AND 4000
  ),
  CONSTRAINT "annotation_range_comments_targets_check" CHECK (
    ("target_mode" = 'all' AND cardinality("domains") = 0 AND cardinality("track_ids") = 0) OR
    ("target_mode" = 'domains' AND cardinality("domains") > 0 AND cardinality("track_ids") = 0) OR
    ("target_mode" = 'tracks' AND cardinality("domains") = 0 AND cardinality("track_ids") > 0)
  ),
  CONSTRAINT "annotation_range_comments_withdrawal_check" CHECK (
    ("withdrawn_at" IS NULL AND "withdrawn_by" IS NULL AND "withdraw_reason" IS NULL) OR
    ("withdrawn_at" IS NOT NULL AND "withdrawn_by" IS NOT NULL)
  )
);

CREATE INDEX "annotation_range_comments_annotation_file_id_created_at_id_idx"
  ON "annotation_range_comments"("annotation_file_id", "created_at" DESC, "id" DESC);
CREATE INDEX "annotation_range_comments_annotation_file_id_commented_revision_idx"
  ON "annotation_range_comments"("annotation_file_id", "commented_revision");
CREATE INDEX "annotation_range_comments_created_by_idx"
  ON "annotation_range_comments"("created_by");
CREATE INDEX "annotation_range_comments_withdrawn_by_idx"
  ON "annotation_range_comments"("withdrawn_by");

ALTER TABLE "annotation_range_comments"
  ADD CONSTRAINT "annotation_range_comments_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_range_comments"
  ADD CONSTRAINT "annotation_range_comments_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "annotation_range_comments"
  ADD CONSTRAINT "annotation_range_comments_withdrawn_by_fkey"
  FOREIGN KEY ("withdrawn_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
