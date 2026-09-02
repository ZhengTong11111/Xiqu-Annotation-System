-- FA-D3c3b 只追加训练导出任务关系；没有 worker 发布、旧任务回填或既有业务事实改写。
ALTER TYPE "ProcessingJobType" ADD VALUE 'alignment_training_export';
ALTER TYPE "AuditAction" ADD VALUE 'alignment_training_export_job_create';

ALTER TABLE "processing_jobs"
ADD COLUMN "alignment_training_export_id" TEXT;

CREATE INDEX "processing_jobs_alignment_training_export_id_idx"
ON "processing_jobs"("alignment_training_export_id");

ALTER TABLE "processing_jobs"
ADD CONSTRAINT "processing_jobs_alignment_training_export_id_fkey"
FOREIGN KEY ("alignment_training_export_id") REFERENCES "alignment_training_exports"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "processing_jobs"
ADD CONSTRAINT "processing_jobs_alignment_training_export_type_check"
CHECK (
  (
    "type"::text = 'alignment_training_export'
    AND "alignment_training_export_id" IS NOT NULL
    AND "analysis_run_id" IS NULL
    AND "alignment_run_id" IS NULL
  )
  OR (
    "type"::text <> 'alignment_training_export'
    AND "alignment_training_export_id" IS NULL
  )
);
