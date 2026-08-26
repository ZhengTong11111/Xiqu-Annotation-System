-- RA4c1 只增加可审计的迁移动作；旧设置表与在线兼容合同留到独立 RA4c2 migration 删除。
ALTER TYPE "AuditAction"
  ADD VALUE IF NOT EXISTS 'analysis_audio_setting_migration_apply';
