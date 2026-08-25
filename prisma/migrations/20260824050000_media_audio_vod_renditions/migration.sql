ALTER TABLE "media_audio_tracks"
  ADD COLUMN "vod_rendition_media_resource_id" TEXT,
  ADD COLUMN "vod_rendition_job_id" TEXT,
  ADD COLUMN "vod_rendition_format" TEXT,
  ADD COLUMN "vod_rendition_definition" TEXT,
  ADD COLUMN "vod_rendition_bitrate" DOUBLE PRECISION,
  ADD COLUMN "vod_rendition_duration" DOUBLE PRECISION;

ALTER TABLE "media_audio_tracks"
  DROP CONSTRAINT "media_audio_tracks_source_check";

-- 三类来源互斥：原声、独立音频资源、VOD 视频下由 JobId 唯一标识的纯音频转码流。
ALTER TABLE "media_audio_tracks"
  ADD CONSTRAINT "media_audio_tracks_source_check" CHECK (
    (
      "kind" = 'original'
      AND "audio_media_resource_id" IS NULL
      AND "vod_rendition_media_resource_id" IS NULL
      AND "vod_rendition_job_id" IS NULL
      AND "vod_rendition_format" IS NULL
      AND "vod_rendition_definition" IS NULL
      AND "vod_rendition_bitrate" IS NULL
      AND "vod_rendition_duration" IS NULL
      AND "offset_seconds" = 0
      AND "enabled" = true
    )
    OR (
      "kind" <> 'original'
      AND "audio_media_resource_id" IS NOT NULL
      AND "vod_rendition_media_resource_id" IS NULL
      AND "vod_rendition_job_id" IS NULL
      AND "vod_rendition_format" IS NULL
      AND "vod_rendition_definition" IS NULL
      AND "vod_rendition_bitrate" IS NULL
      AND "vod_rendition_duration" IS NULL
    )
    OR (
      "kind" <> 'original'
      AND "audio_media_resource_id" IS NULL
      AND "vod_rendition_media_resource_id" IS NOT NULL
      AND "vod_rendition_job_id" IS NOT NULL
      AND "vod_rendition_format" = 'mp3'
      AND ("vod_rendition_definition" IS NULL OR char_length("vod_rendition_definition") BETWEEN 1 AND 32)
      AND ("vod_rendition_bitrate" IS NULL OR (
        "vod_rendition_bitrate" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
        AND "vod_rendition_bitrate" >= 0
      ))
      AND ("vod_rendition_duration" IS NULL OR (
        "vod_rendition_duration" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
        AND "vod_rendition_duration" >= 0
      ))
    )
  );

ALTER TABLE "media_audio_tracks"
  ADD CONSTRAINT "media_audio_tracks_vod_rendition_media_resource_id_fkey"
  FOREIGN KEY ("vod_rendition_media_resource_id") REFERENCES "media_files"("resource_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "media_audio_tracks_vod_rendition_media_resource_id_idx"
  ON "media_audio_tracks"("vod_rendition_media_resource_id");

CREATE UNIQUE INDEX "media_audio_tracks_primary_vod_rendition_job_key"
  ON "media_audio_tracks"(
    "primary_media_resource_id",
    "vod_rendition_media_resource_id",
    "vod_rendition_job_id"
  )
  WHERE "vod_rendition_job_id" IS NOT NULL;
