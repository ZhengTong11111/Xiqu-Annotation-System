-- 媒体来源与媒体种类使用数据库枚举，避免 VOD 被伪装成缺少对象的 uploaded 行。
CREATE TYPE "MediaSourceType" AS ENUM ('uploaded', 'aliyun_vod');
CREATE TYPE "MediaKind" AS ENUM ('video', 'audio');
ALTER TYPE "AuditAction" ADD VALUE 'aliyun_vod_media_create' AFTER 'media_upload';

ALTER TABLE "media_files"
  ADD COLUMN "source_type" "MediaSourceType" NOT NULL DEFAULT 'uploaded',
  ADD COLUMN "media_kind" "MediaKind",
  ADD COLUMN "aliyun_vod_video_id" TEXT,
  ADD COLUMN "aliyun_vod_region" TEXT,
  ALTER COLUMN "file_id" DROP NOT NULL,
  ALTER COLUMN "mime_type" DROP NOT NULL,
  ALTER COLUMN "size" DROP NOT NULL;

-- 旧数据只能由真实 MIME 推导种类；异常 MIME 让迁移失败，不能静默污染科研媒体语义。
UPDATE "media_files"
SET "media_kind" = CASE
  WHEN "mime_type" LIKE 'video/%' THEN 'video'::"MediaKind"
  WHEN "mime_type" LIKE 'audio/%' THEN 'audio'::"MediaKind"
  ELSE NULL
END;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "media_files" WHERE "media_kind" IS NULL) THEN
    RAISE EXCEPTION 'media_files contains unsupported MIME values';
  END IF;
END $$;

ALTER TABLE "media_files"
  ALTER COLUMN "media_kind" SET NOT NULL,
  ADD CONSTRAINT "media_files_source_fields_check" CHECK (
    (
      "source_type" = 'uploaded'
      AND "file_id" IS NOT NULL
      AND "mime_type" IS NOT NULL
      AND "size" IS NOT NULL
      AND "aliyun_vod_video_id" IS NULL
      AND "aliyun_vod_region" IS NULL
    )
    OR
    (
      "source_type" = 'aliyun_vod'
      AND "file_id" IS NULL
      AND "mime_type" IS NULL
      AND "size" IS NULL
      AND "aliyun_vod_video_id" IS NOT NULL
      AND "aliyun_vod_region" IS NOT NULL
    )
  );

CREATE INDEX "media_files_source_type_idx" ON "media_files"("source_type");
CREATE INDEX "media_files_aliyun_vod_region_aliyun_vod_video_id_idx"
  ON "media_files"("aliyun_vod_region", "aliyun_vod_video_id");
