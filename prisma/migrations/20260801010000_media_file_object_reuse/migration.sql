-- 普通“复制媒体”只复制资源节点和媒体元数据，并复用不可变的对象存储实体。
-- 因此一个 FileObject 必须允许被多个 MediaFile 资源引用。
DROP INDEX IF EXISTS "media_files_file_id_key";

CREATE INDEX "media_files_file_id_idx" ON "media_files"("file_id");
