-- P1 先以 nullable 列完成历史回填，再启用 NOT NULL，避免在迁移中制造无身份的活动任务。
ALTER TABLE "processing_jobs"
  ADD COLUMN "deduplication_key" TEXT;

-- media_analysis 的 canonical identity 已由媒体级 run 固化；使用带长度段的可迁移文本，避免依赖 pgcrypto。
-- 临时 URL、标注文件、音轨偏移和账号均不参与该执行身份。
UPDATE "processing_jobs" AS job
SET "deduplication_key" = concat(
  'media-analysis:v1:',
  length(run."source_media_resource_id"), ':', run."source_media_resource_id", ':',
  length(run."media_fingerprint"), ':', run."media_fingerprint", ':',
  length(coalesce(run."source_vod_rendition_job_id", '')), ':', coalesce(run."source_vod_rendition_job_id", ''), ':',
  length(run."algorithm_version"), ':', run."algorithm_version", ':',
  length(run."config_hash"), ':', run."config_hash"
)
FROM "media_analysis_runs" AS run
WHERE job."type" = 'media_analysis'
  AND job."analysis_run_id" = run."id"
  AND run."media_fingerprint" IS NOT NULL;

-- 无法证明 canonical identity 的历史任务必须各自保持唯一，不能凭任务类型或资源名猜测合并。
UPDATE "processing_jobs"
SET "deduplication_key" = concat('legacy:v1:', "id")
WHERE "deduplication_key" IS NULL;

ALTER TABLE "processing_jobs"
  ALTER COLUMN "deduplication_key" SET NOT NULL;

-- 若历史数据库已经存在同 identity 的多个活动执行，拒绝迁移并保留现场，不能擅自选择 winner。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "processing_jobs"
    WHERE "status" IN ('queued', 'running')
    GROUP BY "deduplication_key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'processing job migration required: duplicate active deduplication key';
  END IF;
END $$;

DROP INDEX IF EXISTS "processing_jobs_one_active_media_analysis_idx";
CREATE INDEX "processing_jobs_deduplication_key_idx"
  ON "processing_jobs"("deduplication_key");
CREATE UNIQUE INDEX "processing_jobs_one_active_deduplication_key_idx"
  ON "processing_jobs"("deduplication_key")
  WHERE "status" IN ('queued', 'running');

CREATE TABLE "processing_job_requests" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "requester_user_id" TEXT NOT NULL,
  "context_resource_id" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processing_job_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processing_job_requests_job_id_requester_user_id_context_resource_id_key"
  ON "processing_job_requests"("job_id", "requester_user_id", "context_resource_id");
CREATE INDEX "processing_job_requests_job_id_requested_at_idx"
  ON "processing_job_requests"("job_id", "requested_at");
CREATE INDEX "processing_job_requests_requester_user_id_requested_at_id_idx"
  ON "processing_job_requests"("requester_user_id", "requested_at", "id");
CREATE INDEX "processing_job_requests_context_resource_id_requested_at_id_idx"
  ON "processing_job_requests"("context_resource_id", "requested_at", "id");

ALTER TABLE "processing_job_requests"
  ADD CONSTRAINT "processing_job_requests_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "processing_job_requests"
  ADD CONSTRAINT "processing_job_requests_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "processing_job_requests"
  ADD CONSTRAINT "processing_job_requests_context_resource_id_fkey"
  FOREIGN KEY ("context_resource_id") REFERENCES "resource_entries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- created_by/resource_id 是旧 job 已经保存的明确来源；只回填这两项，不伪造当时不存在的 client request id。
INSERT INTO "processing_job_requests" (
  "id",
  "job_id",
  "requester_user_id",
  "context_resource_id",
  "requested_at"
)
SELECT
  concat('legacy-request-', md5(job."id")),
  job."id",
  job."created_by",
  job."resource_id",
  job."created_at"
FROM "processing_jobs" AS job;

-- 幂等 key 与业务需求分表：多标签页可共享一个需求，同时每个模糊响应重试仍有不可变映射。
CREATE TABLE "processing_job_request_keys" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "requester_user_id" TEXT NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processing_job_request_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "processing_job_request_keys_requester_user_id_client_request_id_key"
  ON "processing_job_request_keys"("requester_user_id", "client_request_id");
CREATE INDEX "processing_job_request_keys_request_id_created_at_idx"
  ON "processing_job_request_keys"("request_id", "created_at");
ALTER TABLE "processing_job_request_keys"
  ADD CONSTRAINT "processing_job_request_keys_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "processing_job_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "processing_job_request_keys"
  ADD CONSTRAINT "processing_job_request_keys_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
