-- HC2a 只扩展恢复快照存储合同，不更新、重写或删除任何历史 JSON payload。
CREATE TYPE "AnnotationRecoverySnapshotStorageMode" AS ENUM (
  'inline',
  'reconstructible',
  'archived'
);

ALTER TABLE "annotation_recovery_snapshots"
  ADD COLUMN "storage_mode" "AnnotationRecoverySnapshotStorageMode" NOT NULL DEFAULT 'inline',
  ADD COLUMN "payload_sha256" TEXT,
  ADD COLUMN "checkpoint_snapshot_id" TEXT,
  ADD COLUMN "operation_revision_start" INTEGER,
  ADD COLUMN "operation_revision_end" INTEGER,
  ADD COLUMN "operation_sequence_start" INTEGER,
  ADD COLUMN "operation_sequence_end" INTEGER,
  ADD COLUMN "operation_count" INTEGER,
  ADD COLUMN "compaction_version" INTEGER,
  ADD COLUMN "compacted_at" TIMESTAMP(3);

-- HC2a 尚未写入 recipe 或归档事实；数据库门禁防止新 release 提前产生不可读取的快照。
ALTER TABLE "annotation_recovery_snapshots"
  ADD CONSTRAINT "annotation_recovery_snapshots_hc2a_inline_only_check"
    CHECK ("storage_mode" = 'inline'),
  ADD CONSTRAINT "annotation_recovery_snapshots_payload_sha256_check"
    CHECK (
      "payload_sha256" IS NULL OR
      "payload_sha256" ~ '^[0-9a-f]{64}$'
    ),
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
        "compacted_at" IS NULL
      ) OR (
        "checkpoint_snapshot_id" IS NOT NULL AND
        "operation_revision_start" IS NOT NULL AND
        "operation_revision_end" IS NOT NULL AND
        "operation_sequence_start" IS NOT NULL AND
        "operation_sequence_end" IS NOT NULL AND
        "operation_count" IS NOT NULL AND
        "operation_count" > 0 AND
        "compaction_version" IS NOT NULL AND
        "compaction_version" > 0 AND
        "compacted_at" IS NOT NULL AND
        "operation_revision_start" <= "operation_revision_end" AND
        "operation_sequence_start" <= "operation_sequence_end"
      )
    ),
  ADD CONSTRAINT "annotation_recovery_snapshots_inline_recipe_empty_check"
    CHECK (
      "storage_mode" <> 'inline' OR (
        "checkpoint_snapshot_id" IS NULL AND
        "operation_revision_start" IS NULL AND
        "operation_revision_end" IS NULL AND
        "operation_sequence_start" IS NULL AND
        "operation_sequence_end" IS NULL AND
        "operation_count" IS NULL AND
        "compaction_version" IS NULL AND
        "compacted_at" IS NULL
      )
    );
