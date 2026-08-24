-- 最终切换前必须已经在 additive release 中执行 RA2 归并 CLI；任何不完整状态都拒绝继续迁移。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "media_analysis_runs"
    WHERE "superseded_by_run_id" IS NULL AND "media_fingerprint" IS NULL
  ) THEN
    RAISE EXCEPTION 'media analysis migration required: canonical run missing media_fingerprint';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "media_analysis_runs"
    WHERE "superseded_by_run_id" IS NULL
    GROUP BY "source_media_resource_id", "media_fingerprint", "algorithm_version", "config_hash"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'media analysis migration required: duplicate canonical media identity';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "media_analysis_runs"
    WHERE "superseded_by_run_id" IS NOT NULL AND "status" IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'media analysis migration required: active superseded run';
  END IF;
END $$;

-- 旧字段继续保留首次发起上下文，但不再决定 run 归属或生命周期。
DROP INDEX "media_analysis_runs_annotation_file_id_source_fingerprint_a_key";

ALTER TABLE "media_analysis_runs"
  DROP CONSTRAINT "media_analysis_runs_annotation_file_id_fkey";
ALTER TABLE "media_analysis_runs"
  ALTER COLUMN "annotation_file_id" DROP NOT NULL,
  ALTER COLUMN "source_mode" DROP NOT NULL,
  ALTER COLUMN "source_offset_seconds" DROP DEFAULT,
  ALTER COLUMN "source_offset_seconds" DROP NOT NULL;
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PostgreSQL partial unique 只约束在线 canonical，历史 superseded run 继续作为可审计事实保留。
CREATE UNIQUE INDEX "media_analysis_runs_active_media_identity_key"
  ON "media_analysis_runs"(
    "source_media_resource_id",
    "media_fingerprint",
    "algorithm_version",
    "config_hash"
  )
  WHERE "superseded_by_run_id" IS NULL;
