ALTER TABLE "media_analysis_runs"
  ADD COLUMN "media_fingerprint" TEXT;

ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_media_fingerprint_check" CHECK (
    "media_fingerprint" IS NULL OR "media_fingerprint" ~ '^[a-f0-9]{64}$'
  );

CREATE INDEX "media_analysis_runs_media_fingerprint_identity_idx"
  ON "media_analysis_runs"(
    "source_media_resource_id",
    "media_fingerprint",
    "algorithm_version",
    "config_hash"
  );
