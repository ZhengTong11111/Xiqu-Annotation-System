-- FA-D3c3a 只补充可导出输入事实和引用保护；旧 provenance export 保持原值，不做破坏性回填。
ALTER TABLE "alignment_training_exports"
  ADD COLUMN "input_manifest_format" TEXT,
  ADD COLUMN "input_manifest_version" INTEGER,
  ADD COLUMN "input_manifest_checksum" TEXT,
  ADD COLUMN "input_manifest" JSONB,
  ADD COLUMN "target_sentence_count" INTEGER,
  ADD COLUMN "target_character_count" INTEGER,
  ADD COLUMN "target_snapshot_bytes" INTEGER;

ALTER TABLE "alignment_training_exports"
ADD CONSTRAINT "alignment_training_exports_input_manifest_check"
CHECK (
  num_nonnulls(
    "input_manifest_format",
    "input_manifest_version",
    "input_manifest_checksum",
    "input_manifest",
    "target_sentence_count",
    "target_character_count",
    "target_snapshot_bytes"
  ) IN (0, 7)
  AND (
    "input_manifest_checksum" IS NULL
    OR (
      "input_manifest_checksum" ~ '^[0-9a-f]{64}$'
      AND "input_manifest_version" > 0
      AND "target_sentence_count" > 0
      AND "target_character_count" > 0
      AND "target_snapshot_bytes" > 0
    )
  )
);

CREATE TABLE "alignment_training_export_inputs" (
  "export_id" TEXT NOT NULL,
  "alignment_application_id" TEXT NOT NULL,
  "source_file_id" TEXT,
  "target_snapshot" JSONB NOT NULL,
  "target_snapshot_checksum" TEXT NOT NULL,
  "target_sentence_count" INTEGER NOT NULL,
  "target_character_count" INTEGER NOT NULL,
  "target_snapshot_bytes" INTEGER NOT NULL,
  "source_snapshot" JSONB NOT NULL,
  "source_snapshot_checksum" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alignment_training_export_inputs_pkey"
    PRIMARY KEY ("export_id", "alignment_application_id"),
  CONSTRAINT "alignment_training_export_inputs_count_check"
    CHECK (
      "target_sentence_count" > 0
      AND "target_character_count" > 0
      AND "target_snapshot_bytes" > 0
    ),
  CONSTRAINT "alignment_training_export_inputs_hash_check"
    CHECK (
      "target_snapshot_checksum" ~ '^[0-9a-f]{64}$'
      AND "source_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX "alignment_training_export_inputs_source_file_id_idx"
ON "alignment_training_export_inputs"("source_file_id");

ALTER TABLE "alignment_training_export_items"
ADD CONSTRAINT "alignment_training_export_items_alignment_artifact_id_fkey"
FOREIGN KEY ("alignment_artifact_id") REFERENCES "alignment_artifacts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_training_export_inputs"
ADD CONSTRAINT "alignment_training_export_inputs_item_fkey"
FOREIGN KEY ("export_id", "alignment_application_id")
REFERENCES "alignment_training_export_items"("export_id", "alignment_application_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alignment_training_export_inputs"
ADD CONSTRAINT "alignment_training_export_inputs_source_file_id_fkey"
FOREIGN KEY ("source_file_id") REFERENCES "files"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
