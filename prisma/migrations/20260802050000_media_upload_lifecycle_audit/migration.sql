-- 统一媒体上传和对象生命周期清理需要独立审计语义，不能复用普通资源更新事件。
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'media_upload';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'storage_orphan_cleanup';
