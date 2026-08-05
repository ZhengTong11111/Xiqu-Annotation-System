-- 目录名称和更新时间分页使用与 Prisma schema 对应的复合 B-tree 索引。
CREATE INDEX IF NOT EXISTS "resource_entries_directory_name_idx"
ON "resource_entries"("parent_id", "trashed_at", "archived_at", "name", "id");

CREATE INDEX IF NOT EXISTS "resource_entries_directory_updated_idx"
ON "resource_entries"("parent_id", "trashed_at", "archived_at", "updated_at", "id");

-- 最近打开视图从账号过滤后按时间读取，避免扫描其他账号的用户状态。
CREATE INDEX IF NOT EXISTS "resource_user_states_recent_idx"
ON "resource_user_states"("user_id", "last_opened_at");

-- 名称 contains 搜索需要 pg_trgm，但扩展是数据库级对象，不能由 api_test 等隔离 schema 的普通
-- migration 安全安装或迁移。本轮不擅自修改扩展所有权；生产部署将在运维基线中显式预置后另加索引。
