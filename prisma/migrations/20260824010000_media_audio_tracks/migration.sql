DO $$ BEGIN
  CREATE TYPE "MediaAudioTrackKind" AS ENUM (
    'original',
    'vocal',
    'accompaniment',
    'denoised',
    'reference',
    'custom'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_audio_track_create';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_audio_track_update';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_audio_track_delete';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_audio_track_reorder';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_audio_preference_update';

CREATE TABLE "media_audio_tracks" (
  "id" TEXT NOT NULL,
  "primary_media_resource_id" TEXT NOT NULL,
  "audio_media_resource_id" TEXT,
  "name" TEXT NOT NULL,
  "kind" "MediaAudioTrackKind" NOT NULL,
  "offset_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_audio_tracks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_audio_tracks_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120
  ),
  CONSTRAINT "media_audio_tracks_offset_check" CHECK (
    "offset_seconds" NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
    AND abs("offset_seconds") <= 86400
  ),
  CONSTRAINT "media_audio_tracks_sort_order_check" CHECK (
    "sort_order" >= 0 AND "sort_order" < 64
  ),
  CONSTRAINT "media_audio_tracks_source_check" CHECK (
    (
      "kind" = 'original'
      AND "audio_media_resource_id" IS NULL
      AND "offset_seconds" = 0
      AND "enabled" = true
    )
    OR (
      "kind" <> 'original'
      AND "audio_media_resource_id" IS NOT NULL
    )
  )
);

CREATE TABLE "annotation_audio_preferences" (
  "annotation_file_id" TEXT NOT NULL,
  "default_audio_track_id" TEXT,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "annotation_audio_preferences_pkey" PRIMARY KEY ("annotation_file_id")
);

CREATE UNIQUE INDEX "media_audio_tracks_primary_media_resource_id_audio_media_res_key"
  ON "media_audio_tracks"("primary_media_resource_id", "audio_media_resource_id");
CREATE UNIQUE INDEX "media_audio_tracks_one_original_per_primary_idx"
  ON "media_audio_tracks"("primary_media_resource_id")
  WHERE "kind" = 'original';
CREATE INDEX "media_audio_tracks_primary_media_resource_id_sort_order_id_idx"
  ON "media_audio_tracks"("primary_media_resource_id", "sort_order", "id");
CREATE INDEX "media_audio_tracks_audio_media_resource_id_idx"
  ON "media_audio_tracks"("audio_media_resource_id");
CREATE INDEX "media_audio_tracks_created_by_idx"
  ON "media_audio_tracks"("created_by");
CREATE INDEX "annotation_audio_preferences_default_audio_track_id_idx"
  ON "annotation_audio_preferences"("default_audio_track_id");
CREATE INDEX "annotation_audio_preferences_updated_by_idx"
  ON "annotation_audio_preferences"("updated_by");

ALTER TABLE "media_audio_tracks"
  ADD CONSTRAINT "media_audio_tracks_primary_media_resource_id_fkey"
  FOREIGN KEY ("primary_media_resource_id") REFERENCES "media_files"("resource_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_audio_tracks"
  ADD CONSTRAINT "media_audio_tracks_audio_media_resource_id_fkey"
  FOREIGN KEY ("audio_media_resource_id") REFERENCES "media_files"("resource_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_audio_tracks"
  ADD CONSTRAINT "media_audio_tracks_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "annotation_audio_preferences"
  ADD CONSTRAINT "annotation_audio_preferences_annotation_file_id_fkey"
  FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "annotation_audio_preferences"
  ADD CONSTRAINT "annotation_audio_preferences_default_audio_track_id_fkey"
  FOREIGN KEY ("default_audio_track_id") REFERENCES "media_audio_tracks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "annotation_audio_preferences"
  ADD CONSTRAINT "annotation_audio_preferences_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 既有媒体使用确定性 id 回填原声音轨；不依赖生产数据库额外扩展，也不复制任何外部音轨关系。
INSERT INTO "media_audio_tracks" (
  "id",
  "primary_media_resource_id",
  "audio_media_resource_id",
  "name",
  "kind",
  "offset_seconds",
  "sort_order",
  "enabled",
  "created_by",
  "created_at",
  "updated_at"
)
SELECT
  'original-' || md5(media."resource_id"),
  media."resource_id",
  NULL,
  CASE WHEN media."media_kind" = 'video' THEN '视频原声' ELSE '媒体原声' END,
  'original'::"MediaAudioTrackKind",
  0,
  0,
  true,
  resource."owner_user_id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "media_files" AS media
INNER JOIN "resource_entries" AS resource ON resource."id" = media."resource_id"
WHERE NOT EXISTS (
  SELECT 1
  FROM "media_audio_tracks" AS existing
  WHERE existing."primary_media_resource_id" = media."resource_id"
    AND existing."kind" = 'original'
);
