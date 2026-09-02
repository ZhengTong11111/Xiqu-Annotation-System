-- FA-D3c3c 只追加不可变训练包资产；不回填、不扫描，也不改写既有任务或标注事实。
CREATE TABLE "alignment_training_package_artifacts" (
  "id" TEXT NOT NULL,
  "export_id" TEXT NOT NULL,
  "processing_job_id" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "container" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "plan_checksum" TEXT NOT NULL,
  "manifest_checksum" TEXT NOT NULL,
  "item_count" INTEGER NOT NULL,
  "manifest" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alignment_training_package_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alignment_training_package_artifacts_contract_check" CHECK (
    "format" = 'xiqu-alignment-training-package'
    AND "version" = 1
    AND "container" = 'zip'
    AND "mime_type" = 'application/zip'
    AND "size" > 0
    AND "item_count" > 0 AND "item_count" <= 200
    AND "checksum" ~ '^[0-9a-f]{64}$'
    AND "plan_checksum" ~ '^[0-9a-f]{64}$'
    AND "manifest_checksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "alignment_training_package_artifacts_processing_job_id_key"
ON "alignment_training_package_artifacts"("processing_job_id");

CREATE UNIQUE INDEX "alignment_training_package_artifacts_storage_key_key"
ON "alignment_training_package_artifacts"("storage_key");

CREATE INDEX "alignment_training_package_artifacts_export_id_created_at_idx"
ON "alignment_training_package_artifacts"("export_id", "created_at");

CREATE INDEX "alignment_training_package_artifacts_checksum_idx"
ON "alignment_training_package_artifacts"("checksum");

ALTER TABLE "alignment_training_package_artifacts"
ADD CONSTRAINT "alignment_training_package_artifacts_export_id_fkey"
FOREIGN KEY ("export_id") REFERENCES "alignment_training_exports"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_training_package_artifacts"
ADD CONSTRAINT "alignment_training_package_artifacts_processing_job_id_fkey"
FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
