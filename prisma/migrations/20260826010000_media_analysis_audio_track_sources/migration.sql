ALTER TABLE "media_analysis_runs"
  ADD COLUMN "source_vod_rendition_job_id" TEXT;

-- JobId 是稳定的供应商流身份，但必须保持有界；临时 URL、PlayAuth 等凭据没有数据库字段。
ALTER TABLE "media_analysis_runs"
  ADD CONSTRAINT "media_analysis_runs_vod_rendition_job_id_check" CHECK (
    "source_vod_rendition_job_id" IS NULL OR (
      char_length("source_vod_rendition_job_id") BETWEEN 1 AND 200
      AND "source_vod_rendition_job_id" = btrim("source_vod_rendition_job_id")
      AND "source_vod_rendition_job_id" !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX "media_analysis_runs_source_vod_rendition_idx"
  ON "media_analysis_runs"("source_media_resource_id", "source_vod_rendition_job_id");
