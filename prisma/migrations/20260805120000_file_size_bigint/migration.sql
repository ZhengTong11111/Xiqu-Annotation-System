-- 将 FileObject.size 与 MediaFile.size 由 integer 迁移到 bigint，
-- 解除单文件 2 GiB 的 Int4 上限。线格式仍为 JSON number，转换发生在应用 mapper 边界。
ALTER TABLE "files" ALTER COLUMN "size" TYPE bigint USING "size"::bigint;
ALTER TABLE "media_files" ALTER COLUMN "size" TYPE bigint USING "size"::bigint;
