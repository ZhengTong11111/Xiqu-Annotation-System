DO $$ BEGIN
  CREATE TYPE "AnalysisAudioMode" AS ENUM ('auto', 'media_override');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "MediaAnalysisAssetKind" AS ENUM ('waveform', 'spectrogram', 'pitch');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_analysis_audio_update';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_analysis_create';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'media_analysis';

ALTER TABLE "processing_jobs"
  ADD COLUMN IF NOT EXISTS "analysis_run_id" TEXT,
  ADD COLUMN IF NOT EXISTS "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "error_code" TEXT,
  ADD COLUMN IF NOT EXISTS "finished_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "heartbeat_at" TIMESTAMP(3);

CREATE TABLE "annotation_analysis_audio_settings" (
  "annotation_file_id" TEXT NOT NULL,
  "mode" "AnalysisAudioMode" NOT NULL DEFAULT 'auto',
  "override_media_resource_id" TEXT,
  "offset_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updated_by" TEXT NOT NULL,
  "validated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "annotation_analysis_audio_settings_pkey" PRIMARY KEY ("annotation_file_id"),
  CONSTRAINT "annotation_analysis_audio_settings_mode_check" CHECK (
    ("mode" = 'auto' AND "override_media_resource_id" IS NULL)
    OR ("mode" = 'media_override' AND "override_media_resource_id" IS NOT NULL)
  ),
  CONSTRAINT "annotation_analysis_audio_settings_offset_check" CHECK (
    "offset_seconds" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND abs("offset_seconds") <= 86400
  )
);

CREATE TABLE "media_analysis_runs" (
  "id" TEXT NOT NULL,
  "annotation_file_id" TEXT NOT NULL,
  "source_media_resource_id" TEXT NOT NULL,
  "source_mode" "AnalysisAudioMode" NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "source_offset_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "algorithm_version" TEXT NOT NULL,
  "config_hash" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "status" "ProcessingJobStatus" NOT NULL DEFAULT 'queued',
  "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "duration" DOUBLE PRECISION,
  "sample_rate" INTEGER,
  "manifest" JSONB,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "media_analysis_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_analysis_runs_offset_check" CHECK (
    "source_offset_seconds" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND abs("source_offset_seconds") <= 86400
  ),
  CONSTRAINT "media_analysis_runs_progress_check" CHECK (
    "progress" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND "progress" >= 0 AND "progress" <= 1
  ),
  CONSTRAINT "media_analysis_runs_duration_check" CHECK (
    "duration" IS NULL OR (
      "duration" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
      AND "duration" >= 0
    )
  ),
  CONSTRAINT "media_analysis_runs_sample_rate_check" CHECK (
    "sample_rate" IS NULL OR "sample_rate" > 0
  )
);

CREATE TABLE "media_analysis_assets" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "kind" "MediaAnalysisAssetKind" NOT NULL,
  "preset" TEXT NOT NULL,
  "level" INTEGER NOT NULL DEFAULT 0,
  "tile_index" INTEGER NOT NULL,
  "start_time" DOUBLE PRECISION NOT NULL,
  "end_time" DOUBLE PRECISION NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_analysis_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_analysis_assets_coordinates_check" CHECK (
    "level" >= 0 AND "tile_index" >= 0
    AND "start_time" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND "end_time" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND "start_time" >= 0 AND "end_time" > "start_time"
  ),
  CONSTRAINT "media_analysis_assets_size_check" CHECK ("size" >= 0)
);

CREATE INDEX "annotation_analysis_audio_settings_override_media_resource__idx"
  ON "annotation_analysis_audio_settings"("override_media_resource_id");
CREATE INDEX "annotation_analysis_audio_settings_updated_by_idx"
  ON "annotation_analysis_audio_settings"("updated_by");
CREATE INDEX "media_analysis_runs_annotation_file_id_created_at_idx"
  ON "media_analysis_runs"("annotation_file_id", "created_at");
CREATE INDEX "media_analysis_runs_source_media_resource_id_idx"
  ON "media_analysis_runs"("source_media_resource_id");
CREATE INDEX "media_analysis_runs_status_idx" ON "media_analysis_runs"("status");
CREATE UNIQUE INDEX "media_analysis_runs_annotation_file_id_source_fingerprint_a_key"
  ON "media_analysis_runs"("annotation_file_id", "source_fingerprint", "algorithm_version", "config_hash");
CREATE UNIQUE INDEX "media_analysis_assets_storage_key_key"
  ON "media_analysis_assets"("storage_key");
CREATE INDEX "media_analysis_assets_run_id_kind_preset_level_start_time_idx"
  ON "media_analysis_assets"("run_id", "kind", "preset", "level", "start_time");
CREATE UNIQUE INDEX "media_analysis_assets_run_id_kind_preset_level_tile_index_key"
  ON "media_analysis_assets"("run_id", "kind", "preset", "level", "tile_index");
CREATE INDEX "processing_jobs_analysis_run_id_idx" ON "processing_jobs"("analysis_run_id");
CREATE INDEX "processing_jobs_status_created_at_idx" ON "processing_jobs"("status", "created_at");
CREATE UNIQUE INDEX "processing_jobs_one_active_media_analysis_idx"
  ON "processing_jobs"("analysis_run_id")
  WHERE "analysis_run_id" IS NOT NULL AND "status" IN ('queued', 'running');
ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_attempt_count_check" CHECK ("attempt_count" >= 0);

ALTER TABLE "annotation_analysis_audio_settings"
  ADD CONSTRAINT "annotation_analysis_audio_settings_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_analysis_audio_settings"
  ADD CONSTRAINT "annotation_analysis_audio_settings_override_media_resource_fkey"
  FOREIGN KEY ("override_media_resource_id") REFERENCES "media_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_analysis_audio_settings"
  ADD CONSTRAINT "annotation_analysis_audio_settings_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_source_media_resource_id_fkey"
  FOREIGN KEY ("source_media_resource_id") REFERENCES "media_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_analysis_assets"
  ADD CONSTRAINT "media_analysis_assets_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "media_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_analysis_run_id_fkey"
  FOREIGN KEY ("analysis_run_id") REFERENCES "media_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
