-- FA-D2a 只扩展对齐运行/对象元数据；不回填或改写既有标注、历史、任务与媒体事实。
ALTER TYPE "ProcessingJobType" ADD VALUE 'force_alignment';
CREATE TYPE "AlignmentArtifactKind" AS ENUM ('prediction');

CREATE TABLE "alignment_runs" (
  "id" TEXT NOT NULL,
  "annotation_file_id" TEXT,
  "annotation_file_id_snapshot" TEXT NOT NULL,
  "input_revision" INTEGER NOT NULL,
  "input_text_fingerprint" TEXT NOT NULL,
  "input_sentence_count" INTEGER NOT NULL,
  "input_character_count" INTEGER NOT NULL,
  "source_media_resource_id" TEXT,
  "source_media_resource_id_snapshot" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "media_audio_track_id" TEXT,
  "media_audio_track_id_snapshot" TEXT NOT NULL,
  "audio_offset_micros" BIGINT NOT NULL,
  "media_analysis_run_id" TEXT,
  "media_analysis_fingerprint" TEXT,
  "model_name" TEXT NOT NULL,
  "model_version" TEXT NOT NULL,
  "dictionary_version" TEXT NOT NULL,
  "code_version" TEXT NOT NULL,
  "config_hash" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "identity_hash" TEXT NOT NULL,
  "status" "ProcessingJobStatus" NOT NULL DEFAULT 'queued',
  "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "manifest" JSONB,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "alignment_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alignment_runs_identity_check" CHECK (
    "input_revision" > 0 AND
    "input_sentence_count" BETWEEN 0 AND 100000 AND
    "input_character_count" BETWEEN 0 AND 1000000 AND
    "audio_offset_micros" BETWEEN -86400000000 AND 86400000000 AND
    "input_text_fingerprint" ~ '^[0-9a-f]{64}$' AND
    "source_fingerprint" ~ '^[0-9a-f]{64}$' AND
    ("media_analysis_fingerprint" IS NULL OR "media_analysis_fingerprint" ~ '^[0-9a-f]{64}$') AND
    "config_hash" ~ '^[0-9a-f]{64}$' AND
    "identity_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "alignment_runs_source_snapshot_check" CHECK (
    ("annotation_file_id" IS NULL OR "annotation_file_id" = "annotation_file_id_snapshot") AND
    ("source_media_resource_id" IS NULL OR "source_media_resource_id" = "source_media_resource_id_snapshot") AND
    ("media_audio_track_id" IS NULL OR "media_audio_track_id" = "media_audio_track_id_snapshot") AND
    ("media_analysis_run_id" IS NULL OR "media_analysis_fingerprint" IS NOT NULL)
  ),
  CONSTRAINT "alignment_runs_text_check" CHECK (
    char_length("annotation_file_id_snapshot") BETWEEN 1 AND 200 AND
    char_length("source_media_resource_id_snapshot") BETWEEN 1 AND 200 AND
    char_length("media_audio_track_id_snapshot") BETWEEN 1 AND 200 AND
    char_length("model_name") BETWEEN 1 AND 128 AND
    char_length("model_version") BETWEEN 1 AND 128 AND
    char_length("dictionary_version") BETWEEN 1 AND 128 AND
    char_length("code_version") BETWEEN 1 AND 128 AND
    ("error_code" IS NULL OR char_length("error_code") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "alignment_runs_json_size_check" CHECK (
    jsonb_typeof("config") = 'object' AND octet_length("config"::text) <= 16384 AND
    ("manifest" IS NULL OR (jsonb_typeof("manifest") = 'object' AND octet_length("manifest"::text) <= 32768))
  ),
  CONSTRAINT "alignment_runs_lifecycle_check" CHECK (
    "progress" BETWEEN 0 AND 1 AND (
      ("status"::text IN ('queued', 'running', 'cancelling') AND "completed_at" IS NULL) OR
      ("status"::text IN ('cancelled', 'succeeded', 'failed') AND "completed_at" IS NOT NULL)
    ) AND
    ("status"::text <> 'succeeded' OR ("manifest" IS NOT NULL AND "error_code" IS NULL)) AND
    ("status"::text <> 'failed' OR "error_code" IS NOT NULL)
  )
);

CREATE TABLE "alignment_artifacts" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "kind" "AlignmentArtifactKind" NOT NULL,
  "format_version" INTEGER NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alignment_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alignment_artifacts_metadata_check" CHECK (
    "format_version" BETWEEN 1 AND 1000 AND
    char_length("mime_type") BETWEEN 1 AND 128 AND
    char_length("storage_key") BETWEEN 1 AND 1024 AND
    "size" BETWEEN 0 AND 536870912 AND
    "checksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "alignment_runs_annotation_file_id_input_revision_idx"
  ON "alignment_runs"("annotation_file_id", "input_revision");
CREATE INDEX "alignment_runs_source_media_resource_id_idx"
  ON "alignment_runs"("source_media_resource_id");
CREATE INDEX "alignment_runs_media_audio_track_id_idx"
  ON "alignment_runs"("media_audio_track_id");
CREATE INDEX "alignment_runs_media_analysis_run_id_idx"
  ON "alignment_runs"("media_analysis_run_id");
CREATE UNIQUE INDEX "alignment_runs_identity_hash_key"
  ON "alignment_runs"("identity_hash");
CREATE INDEX "alignment_runs_status_created_at_idx"
  ON "alignment_runs"("status", "created_at");
CREATE INDEX "alignment_runs_created_by_created_at_idx"
  ON "alignment_runs"("created_by", "created_at");
CREATE UNIQUE INDEX "alignment_artifacts_storage_key_key"
  ON "alignment_artifacts"("storage_key");
CREATE UNIQUE INDEX "alignment_artifacts_run_id_kind_key"
  ON "alignment_artifacts"("run_id", "kind");
CREATE INDEX "alignment_artifacts_run_id_created_at_idx"
  ON "alignment_artifacts"("run_id", "created_at");

ALTER TABLE "alignment_runs"
  ADD CONSTRAINT "alignment_runs_annotation_file_id_fkey"
    FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "alignment_runs_source_media_resource_id_fkey"
    FOREIGN KEY ("source_media_resource_id") REFERENCES "media_files"("resource_id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "alignment_runs_media_audio_track_id_fkey"
    FOREIGN KEY ("media_audio_track_id") REFERENCES "media_audio_tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "alignment_runs_media_analysis_run_id_fkey"
    FOREIGN KEY ("media_analysis_run_id") REFERENCES "media_analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "alignment_runs_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_artifacts"
  ADD CONSTRAINT "alignment_artifacts_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "alignment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "processing_jobs" ADD COLUMN "alignment_run_id" TEXT;
CREATE INDEX "processing_jobs_alignment_run_id_idx" ON "processing_jobs"("alignment_run_id");
ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_alignment_run_id_fkey"
    FOREIGN KEY ("alignment_run_id") REFERENCES "alignment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "processing_jobs_alignment_run_type_check" CHECK (
    ("alignment_run_id" IS NULL AND "type"::text <> 'force_alignment') OR
    ("alignment_run_id" IS NOT NULL AND "analysis_run_id" IS NULL AND "type"::text = 'force_alignment')
  );
