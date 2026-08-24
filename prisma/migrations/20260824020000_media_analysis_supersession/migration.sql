ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_analysis_migration_apply';

ALTER TABLE "media_analysis_runs"
  ADD COLUMN "superseded_by_run_id" TEXT,
  ADD COLUMN "superseded_at" TIMESTAMP(3),
  ADD COLUMN "superseded_by" TEXT;

-- 三个归并事实必须一起出现；保留旧 run 和全部资产，使 RA2a 标记可以审计、重跑且不破坏对象。
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_supersession_fields_check" CHECK (
    (
      "superseded_by_run_id" IS NULL
      AND "superseded_at" IS NULL
      AND "superseded_by" IS NULL
    )
    OR (
      "superseded_by_run_id" IS NOT NULL
      AND "superseded_at" IS NOT NULL
      AND "superseded_by" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "media_analysis_runs_not_self_superseded_check" CHECK (
    "superseded_by_run_id" IS NULL OR "superseded_by_run_id" <> "id"
  );

ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_superseded_by_run_id_fkey"
  FOREIGN KEY ("superseded_by_run_id") REFERENCES "media_analysis_runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_analysis_runs_superseded_by_fkey"
  FOREIGN KEY ("superseded_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "media_analysis_runs_media_identity_idx"
  ON "media_analysis_runs"(
    "source_media_resource_id",
    "source_fingerprint",
    "algorithm_version",
    "config_hash"
  );
CREATE INDEX "media_analysis_runs_superseded_by_run_id_idx"
  ON "media_analysis_runs"("superseded_by_run_id");
CREATE INDEX "media_analysis_runs_superseded_by_idx"
  ON "media_analysis_runs"("superseded_by");
