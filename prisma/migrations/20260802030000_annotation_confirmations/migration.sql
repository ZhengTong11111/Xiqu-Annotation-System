-- 已确认标注范围使用独立逐资源审核能力，不借用普通编辑或权限管理能力。
ALTER TYPE "ResourceCapability" ADD VALUE IF NOT EXISTS 'review';

-- 创建与撤销都写治理审计，但审计 detail 不保存备注或标注 payload。
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_confirmation_create';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_confirmation_revoke';

CREATE TYPE "AnnotationConfirmationTargetMode" AS ENUM ('all', 'domains', 'tracks');
CREATE TYPE "AnnotationConfirmationDomain" AS ENUM (
  'subtitle_lines',
  'character_annotations',
  'gongche_annotations',
  'banyan_sections',
  'banyan_marks',
  'custom_tracks',
  'custom_blocks',
  'attached_points'
);

CREATE TABLE "annotation_confirmations" (
  "id" TEXT NOT NULL,
  "annotation_file_id" TEXT NOT NULL,
  "confirmed_revision" INTEGER NOT NULL,
  "start_time" DOUBLE PRECISION NOT NULL,
  "end_time" DOUBLE PRECISION NOT NULL,
  "target_mode" "AnnotationConfirmationTargetMode" NOT NULL,
  "domains" "AnnotationConfirmationDomain"[] NOT NULL DEFAULT ARRAY[]::"AnnotationConfirmationDomain"[],
  "track_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "note" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_by" TEXT,
  "revoked_at" TIMESTAMP(3),
  "revoke_reason" TEXT,

  CONSTRAINT "annotation_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "annotation_confirmations_positive_revision" CHECK ("confirmed_revision" > 0),
  CONSTRAINT "annotation_confirmations_valid_time" CHECK (
    "start_time" <> 'NaN'::DOUBLE PRECISION AND
    "end_time" <> 'NaN'::DOUBLE PRECISION AND
    abs("start_time") <> 'Infinity'::DOUBLE PRECISION AND
    abs("end_time") <> 'Infinity'::DOUBLE PRECISION AND
    "start_time" >= 0 AND "end_time" > "start_time"
  ),
  CONSTRAINT "annotation_confirmations_valid_targets" CHECK (
    ("target_mode" = 'all' AND cardinality("domains") = 0 AND cardinality("track_ids") = 0) OR
    ("target_mode" = 'domains' AND cardinality("domains") > 0 AND cardinality("track_ids") = 0) OR
    ("target_mode" = 'tracks' AND cardinality("domains") = 0 AND cardinality("track_ids") > 0)
  ),
  CONSTRAINT "annotation_confirmations_valid_revocation" CHECK (
    ("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL) OR
    ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
  )
);

CREATE INDEX "annotation_confirmations_annotation_file_id_created_at_idx"
  ON "annotation_confirmations"("annotation_file_id", "created_at");
CREATE INDEX "annotation_confirmations_annotation_file_id_confirmed_revision_idx"
  ON "annotation_confirmations"("annotation_file_id", "confirmed_revision");
CREATE INDEX "annotation_confirmations_created_by_idx" ON "annotation_confirmations"("created_by");
CREATE INDEX "annotation_confirmations_revoked_by_idx" ON "annotation_confirmations"("revoked_by");

ALTER TABLE "annotation_confirmations"
  ADD CONSTRAINT "annotation_confirmations_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_confirmations"
  ADD CONSTRAINT "annotation_confirmations_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "annotation_confirmations"
  ADD CONSTRAINT "annotation_confirmations_revoked_by_fkey"
  FOREIGN KEY ("revoked_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
