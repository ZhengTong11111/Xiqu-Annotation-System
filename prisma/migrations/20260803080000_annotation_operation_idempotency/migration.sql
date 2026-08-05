-- 历史 operation 没有客户端幂等键；先增加可空列，完成确定性回填后再收紧约束。
ALTER TABLE "annotation_operations"
ADD COLUMN "client_operation_id" TEXT,
ADD COLUMN "request_hash" TEXT;

-- legacy 前缀不会与当前 op-UUID 冲突；历史请求不会参与新客户端重放，只需保留唯一身份。
UPDATE "annotation_operations"
SET
  "client_operation_id" = 'legacy:' || "id",
  "request_hash" = repeat('0', 64);

-- 回填完成后，所有新写入都必须提供客户端 id 与服务端请求指纹。
ALTER TABLE "annotation_operations"
ALTER COLUMN "client_operation_id" SET NOT NULL,
ALTER COLUMN "request_hash" SET NOT NULL;

-- 幂等作用域按文件和账号隔离，允许不同账号安全复用同一个本地 operation id。
CREATE UNIQUE INDEX "annotation_operations_annotation_file_id_actor_user_id_client_operation_id_key"
ON "annotation_operations"("annotation_file_id", "actor_user_id", "client_operation_id");
