-- 审计浏览按时间与 id 形成稳定总序，并为常用动作、资源和账号筛选提供可用索引。
DROP INDEX IF EXISTS "audit_logs_resource_id_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_actor_user_id_created_at_idx";

CREATE INDEX "audit_logs_created_at_id_idx"
ON "audit_logs"("created_at", "id");

CREATE INDEX "audit_logs_action_created_at_id_idx"
ON "audit_logs"("action", "created_at", "id");

CREATE INDEX "audit_logs_resource_id_created_at_id_idx"
ON "audit_logs"("resource_id", "created_at", "id");

CREATE INDEX "audit_logs_actor_user_id_created_at_id_idx"
ON "audit_logs"("actor_user_id", "created_at", "id");

CREATE INDEX "audit_logs_target_user_id_created_at_id_idx"
ON "audit_logs"("target_user_id", "created_at", "id");

CREATE INDEX "audit_logs_file_id_created_at_id_idx"
ON "audit_logs"("file_id", "created_at", "id");
