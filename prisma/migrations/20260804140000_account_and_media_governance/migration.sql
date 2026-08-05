ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'account_create';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'account_update';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'account_password_reset';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'account_password_change';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_media_bind';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_media_unbind';

-- 旧版本允许任意字符串；无法指向活动媒体资源的值不能进入新外键。
UPDATE "annotation_files" AS annotation
SET "media_resource_id" = NULL
WHERE "media_resource_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "media_files" AS media
    WHERE media."resource_id" = annotation."media_resource_id"
  );

ALTER TABLE "annotation_files"
ADD CONSTRAINT "annotation_files_media_resource_id_fkey"
FOREIGN KEY ("media_resource_id") REFERENCES "media_files"("resource_id")
ON DELETE SET NULL ON UPDATE CASCADE;
