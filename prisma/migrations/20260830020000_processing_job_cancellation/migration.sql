ALTER TYPE "ProcessingJobStatus" ADD VALUE IF NOT EXISTS 'cancelling';
ALTER TYPE "ProcessingJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'processing_job_request_cancel';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'processing_job_force_cancel';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'processing_job_retry';

CREATE TYPE "ProcessingJobCancellationMode" AS ENUM ('user_request', 'admin_force');
CREATE TYPE "ProcessingJobCommandAction" AS ENUM ('cancel_request', 'force_cancel', 'retry');
CREATE TYPE "ProcessingJobCommandOutcome" AS ENUM (
  'pending',
  'request_cancelled_execution_continues',
  'execution_cancelling',
  'execution_cancelled',
  'already_terminal',
  'request_already_cancelled',
  'retry_scheduled'
);

ALTER TABLE "processing_jobs"
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_by" TEXT,
  ADD COLUMN "cancellation_mode" "ProcessingJobCancellationMode",
  ADD COLUMN "cancellation_reason" TEXT;

ALTER TABLE "processing_job_requests"
  ADD COLUMN "media_audio_track_id" TEXT,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by" TEXT,
  ADD COLUMN "cancellation_reason" TEXT;

ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_cancellation_fact_check"
  CHECK (
    ("cancel_requested_at" IS NULL AND "cancel_requested_by" IS NULL AND "cancellation_mode" IS NULL AND "cancellation_reason" IS NULL)
    OR
    ("cancel_requested_at" IS NOT NULL AND "cancel_requested_by" IS NOT NULL AND "cancellation_mode" IS NOT NULL)
  ),
  ADD CONSTRAINT "processing_jobs_cancellation_status_check"
  CHECK (
    "status" NOT IN ('cancelling', 'cancelled')
    OR ("cancel_requested_at" IS NOT NULL AND "cancel_requested_by" IS NOT NULL AND "cancellation_mode" IS NOT NULL)
  ),
  ADD CONSTRAINT "processing_jobs_cancellation_reason_length_check"
  CHECK ("cancellation_reason" IS NULL OR char_length("cancellation_reason") <= 500),
  ADD CONSTRAINT "processing_jobs_cancel_requested_by_fkey"
  FOREIGN KEY ("cancel_requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "processing_job_requests"
  ADD CONSTRAINT "processing_job_requests_cancellation_fact_check"
  CHECK (
    ("cancelled_at" IS NULL AND "cancelled_by" IS NULL AND "cancellation_reason" IS NULL)
    OR
    ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "processing_job_requests_cancellation_reason_length_check"
  CHECK ("cancellation_reason" IS NULL OR char_length("cancellation_reason") <= 500),
  ADD CONSTRAINT "processing_job_requests_media_audio_track_id_fkey"
  FOREIGN KEY ("media_audio_track_id") REFERENCES "media_audio_tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "processing_job_requests_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "processing_jobs_cancel_requested_by_idx"
  ON "processing_jobs"("cancel_requested_by");
CREATE INDEX "processing_job_requests_media_audio_track_id_idx"
  ON "processing_job_requests"("media_audio_track_id");
CREATE INDEX "processing_job_requests_cancelled_by_idx"
  ON "processing_job_requests"("cancelled_by");

-- cancelling 仍占用 canonical run 和资产发布边界，完成清理前不能创建第二个相同执行。
DROP INDEX "processing_jobs_one_active_deduplication_key_idx";
CREATE UNIQUE INDEX "processing_jobs_one_active_deduplication_key_idx"
  ON "processing_jobs"("deduplication_key")
  WHERE "status" IN ('queued', 'running', 'cancelling');

CREATE TABLE "processing_job_commands" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "client_command_id" TEXT NOT NULL,
  "action" "ProcessingJobCommandAction" NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "target_job_id" TEXT,
  "target_request_id" TEXT,
  "result_job_id" TEXT,
  "outcome" "ProcessingJobCommandOutcome" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processing_job_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processing_job_commands_actor_user_id_client_command_id_key"
  ON "processing_job_commands"("actor_user_id", "client_command_id");
CREATE INDEX "processing_job_commands_target_job_id_created_at_idx"
  ON "processing_job_commands"("target_job_id", "created_at");
CREATE INDEX "processing_job_commands_target_request_id_created_at_idx"
  ON "processing_job_commands"("target_request_id", "created_at");
CREATE INDEX "processing_job_commands_result_job_id_idx"
  ON "processing_job_commands"("result_job_id");

ALTER TABLE "processing_job_commands"
  ADD CONSTRAINT "processing_job_commands_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "processing_job_commands_target_job_id_fkey"
  FOREIGN KEY ("target_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "processing_job_commands_target_request_id_fkey"
  FOREIGN KEY ("target_request_id") REFERENCES "processing_job_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "processing_job_commands_result_job_id_fkey"
  FOREIGN KEY ("result_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
