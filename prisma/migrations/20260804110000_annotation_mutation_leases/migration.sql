-- 结构性标注变更使用短时数据库租约；token 只保存 SHA-256 摘要。
CREATE TYPE "AnnotationMutationPurpose" AS ENUM ('track_structure', 'bulk_import', 'bulk_repair');

ALTER TYPE "AuditAction" ADD VALUE 'annotation_mutation_lease_acquire';
ALTER TYPE "AuditAction" ADD VALUE 'annotation_mutation_lease_renew';
ALTER TYPE "AuditAction" ADD VALUE 'annotation_mutation_lease_release';

CREATE TABLE "annotation_mutation_leases" (
    "annotation_file_id" TEXT NOT NULL,
    "holder_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "AnnotationMutationPurpose" NOT NULL,
    "base_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annotation_mutation_leases_pkey" PRIMARY KEY ("annotation_file_id")
);

CREATE UNIQUE INDEX "annotation_mutation_leases_token_hash_key"
ON "annotation_mutation_leases"("token_hash");
CREATE INDEX "annotation_mutation_leases_holder_user_id_idx"
ON "annotation_mutation_leases"("holder_user_id");
CREATE INDEX "annotation_mutation_leases_expires_at_idx"
ON "annotation_mutation_leases"("expires_at");

ALTER TABLE "annotation_mutation_leases"
ADD CONSTRAINT "annotation_mutation_leases_annotation_file_id_fkey"
FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "annotation_mutation_leases"
ADD CONSTRAINT "annotation_mutation_leases_holder_user_id_fkey"
FOREIGN KEY ("holder_user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
