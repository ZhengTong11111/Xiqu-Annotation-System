ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_review_link_create';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_review_link_revoke';

-- 审核包关联是 additive 治理元数据；原生确认与评论表不做 UPDATE、DELETE 或重建。
CREATE TABLE "annotation_review_links" (
    "id" TEXT NOT NULL,
    "target_annotation_file_id" TEXT NOT NULL,
    "source_annotation_file_id" TEXT,
    "source_resource_id_snapshot" TEXT NOT NULL,
    "source_file_name_snapshot" TEXT NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "package_fingerprint" TEXT NOT NULL,
    "package_payload" JSONB NOT NULL,
    "confirmation_count" INTEGER NOT NULL,
    "range_record_count" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,

    CONSTRAINT "annotation_review_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "annotation_review_links_target_annotation_file_id_package_fingerprint_key"
    ON "annotation_review_links"("target_annotation_file_id", "package_fingerprint");
CREATE INDEX "annotation_review_links_target_annotation_file_id_created_at_id_idx"
    ON "annotation_review_links"("target_annotation_file_id", "created_at", "id");
CREATE INDEX "annotation_review_links_source_annotation_file_id_idx"
    ON "annotation_review_links"("source_annotation_file_id");
CREATE INDEX "annotation_review_links_created_by_idx" ON "annotation_review_links"("created_by");
CREATE INDEX "annotation_review_links_revoked_by_idx" ON "annotation_review_links"("revoked_by");

ALTER TABLE "annotation_review_links" ADD CONSTRAINT "annotation_review_links_target_annotation_file_id_fkey"
    FOREIGN KEY ("target_annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_review_links" ADD CONSTRAINT "annotation_review_links_source_annotation_file_id_fkey"
    FOREIGN KEY ("source_annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "annotation_review_links" ADD CONSTRAINT "annotation_review_links_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "annotation_review_links" ADD CONSTRAINT "annotation_review_links_revoked_by_fkey"
    FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
