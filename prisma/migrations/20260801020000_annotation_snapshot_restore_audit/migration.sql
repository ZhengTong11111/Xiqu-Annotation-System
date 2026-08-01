-- 快照恢复是独立于普通保存的受审计内容写入，便于事故追溯而不记录完整 payload。
ALTER TYPE "AuditAction" ADD VALUE 'annotation_snapshot_restore';
