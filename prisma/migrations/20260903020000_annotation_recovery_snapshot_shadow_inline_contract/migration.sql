-- HC3c2 修正：保留 HC3a 已存在的“完整 payload + inline shadow recipe”研究合同。
-- 只替换 CHECK 定义，不更新或删除任何恢复快照数据。
ALTER TABLE "annotation_recovery_snapshots"
  DROP CONSTRAINT "annotation_recovery_snapshots_future_storage_contract_check";

-- 普通 inline、完整 payload 的影子 recipe、未来 reconstructible 三种形态互斥且字段完整。
ALTER TABLE "annotation_recovery_snapshots"
  ADD CONSTRAINT "annotation_recovery_snapshots_future_storage_contract_check"
    CHECK (
      (
        "storage_mode" = 'inline' AND
        "payload" IS NOT NULL AND
        "checkpoint_snapshot_id" IS NULL AND
        "operation_revision_start" IS NULL AND
        "operation_revision_end" IS NULL AND
        "operation_sequence_start" IS NULL AND
        "operation_sequence_end" IS NULL AND
        "operation_count" IS NULL AND
        "compaction_version" IS NULL AND
        "recipe_verified_at" IS NULL AND
        "compacted_at" IS NULL
      ) OR (
        "storage_mode" = 'inline' AND
        "payload" IS NOT NULL AND
        "payload_sha256" IS NOT NULL AND
        "checkpoint_snapshot_id" IS NOT NULL AND
        btrim("checkpoint_snapshot_id") <> '' AND
        "operation_revision_start" IS NOT NULL AND
        "operation_revision_end" IS NOT NULL AND
        "operation_sequence_start" IS NOT NULL AND
        "operation_sequence_end" IS NOT NULL AND
        "operation_count" IS NOT NULL AND
        "operation_count" > 0 AND
        "compaction_version" = 1 AND
        "recipe_verified_at" IS NOT NULL AND
        "compacted_at" IS NULL AND
        "operation_revision_start" > 0 AND
        "operation_revision_start" <= "operation_revision_end" AND
        "operation_revision_end" = "revision" AND
        "operation_sequence_start" > 0 AND
        "operation_sequence_start" <= "operation_sequence_end" AND
        "operation_count" <= "operation_sequence_end" - "operation_sequence_start" + 1
      ) OR (
        "storage_mode" = 'reconstructible' AND
        "payload" IS NULL AND
        "payload_sha256" IS NOT NULL AND
        "checkpoint_snapshot_id" IS NOT NULL AND
        btrim("checkpoint_snapshot_id") <> '' AND
        "operation_revision_start" IS NOT NULL AND
        "operation_revision_end" IS NOT NULL AND
        "operation_sequence_start" IS NOT NULL AND
        "operation_sequence_end" IS NOT NULL AND
        "operation_count" IS NOT NULL AND
        "operation_count" > 0 AND
        "compaction_version" = 1 AND
        "recipe_verified_at" IS NOT NULL AND
        "compacted_at" IS NOT NULL AND
        "operation_revision_start" > 0 AND
        "operation_revision_start" <= "operation_revision_end" AND
        "operation_revision_end" = "revision" AND
        "operation_sequence_start" > 0 AND
        "operation_sequence_start" <= "operation_sequence_end" AND
        "operation_count" <= "operation_sequence_end" - "operation_sequence_start" + 1
      )
    );
