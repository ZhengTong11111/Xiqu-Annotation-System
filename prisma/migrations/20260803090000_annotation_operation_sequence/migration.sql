-- 先增加可回填字段；历史 operation 不能因协作协议升级被删除或重新创建。
ALTER TABLE "annotation_files"
ADD COLUMN "last_operation_sequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "annotation_operations"
ADD COLUMN "sequence" INTEGER;

-- 每个文件按稳定的创建时间和 id 回填 1..N，相同时间戳也不会产生不确定顺序。
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "annotation_file_id"
      ORDER BY "created_at" ASC, "id" ASC
    )::INTEGER AS "assigned_sequence"
  FROM "annotation_operations"
)
UPDATE "annotation_operations" AS operation
SET "sequence" = ranked."assigned_sequence"
FROM ranked
WHERE operation."id" = ranked."id";

-- 文件计数器从历史最大序号继续；没有 operation 的文件保持 0。
UPDATE "annotation_files" AS file
SET "last_operation_sequence" = counts."last_sequence"
FROM (
  SELECT "annotation_file_id", MAX("sequence") AS "last_sequence"
  FROM "annotation_operations"
  GROUP BY "annotation_file_id"
) AS counts
WHERE file."resource_id" = counts."annotation_file_id";

ALTER TABLE "annotation_operations"
ALTER COLUMN "sequence" SET NOT NULL;

CREATE UNIQUE INDEX "annotation_operations_annotation_file_id_sequence_key"
ON "annotation_operations"("annotation_file_id", "sequence");
