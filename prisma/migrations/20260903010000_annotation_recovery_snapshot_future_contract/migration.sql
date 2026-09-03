-- HC3c2 只扩展未来双形态读取合同，不改写任何既有恢复快照。
-- 历史行仍保持 inline + payload；本迁移不切换 storage_mode，也不回填 recipe。
ALTER TABLE "annotation_recovery_snapshots"
  ALTER COLUMN "payload" DROP NOT NULL;

-- HC2a/HC3a 的 inline-only 约束只负责过渡期保护，正式双形态合同由下面的统一约束接管。
ALTER TABLE "annotation_recovery_snapshots"
  DROP CONSTRAINT "annotation_recovery_snapshots_hc2a_inline_only_check",
  DROP CONSTRAINT "annotation_recovery_snapshots_recipe_shape_check",
  DROP CONSTRAINT "annotation_recovery_snapshots_inline_shadow_recipe_check";

-- 两种形态必须完整且互斥：任何半迁移行都在数据库层被拒绝，resolver 无需猜测缺失字段。
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

-- archived 仍是保留的未来枚举值，但本阶段没有 archived resolver/对象合同，必须继续 fail closed。
