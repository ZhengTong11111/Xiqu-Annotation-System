-- HC3a 只允许 inline 快照保存已经复核的影子 recipe；payload 仍然 NOT NULL，其他存储模式仍被 HC2a 门禁禁止。
ALTER TABLE "annotation_recovery_snapshots"
  ADD COLUMN "recipe_verified_at" TIMESTAMP(3);

ALTER TABLE "annotation_recovery_snapshots"
  DROP CONSTRAINT "annotation_recovery_snapshots_recipe_shape_check",
  DROP CONSTRAINT "annotation_recovery_snapshots_inline_recipe_empty_check";

-- recipe 必须整组写入，并且必须绑定目标 payload hash；不能留下部分定位信息供后续清理器误读。
ALTER TABLE "annotation_recovery_snapshots"
  ADD CONSTRAINT "annotation_recovery_snapshots_recipe_shape_check"
    CHECK (
      (
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
        "payload_sha256" IS NOT NULL AND
        "checkpoint_snapshot_id" IS NOT NULL AND
        "operation_revision_start" IS NOT NULL AND
        "operation_revision_end" IS NOT NULL AND
        "operation_sequence_start" IS NOT NULL AND
        "operation_sequence_end" IS NOT NULL AND
        "operation_count" IS NOT NULL AND
        "operation_count" > 0 AND
        "compaction_version" IS NOT NULL AND
        "compaction_version" > 0 AND
        "recipe_verified_at" IS NOT NULL AND
        "operation_revision_start" > 0 AND
        "operation_sequence_start" > 0 AND
        "operation_revision_start" <= "operation_revision_end" AND
        "operation_revision_end" = "revision" AND
        "operation_sequence_start" <= "operation_sequence_end" AND
        "operation_count" <= "operation_sequence_end" - "operation_sequence_start" + 1
      )
    ),
  ADD CONSTRAINT "annotation_recovery_snapshots_inline_shadow_recipe_check"
    CHECK (
      "storage_mode" <> 'inline' OR "compacted_at" IS NULL
    );

-- 此阶段故意保留 annotation_recovery_snapshots_hc2a_inline_only_check；迁移不能启用 reconstructible/archived。
