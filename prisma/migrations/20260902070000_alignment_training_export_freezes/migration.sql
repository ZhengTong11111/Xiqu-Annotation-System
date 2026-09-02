-- FA-D3c2b 只追加不可变训练冻结事实；在线标注、操作、快照、审核和对齐记录均不回填、不改写。
CREATE TYPE "AlignmentTrainingTargetMode" AS ENUM ('prediction', 'manual_revision');
CREATE TYPE "AlignmentTrainingSplit" AS ENUM ('train', 'validation', 'test');

ALTER TYPE "AuditAction" ADD VALUE 'alignment_training_export_freeze';

CREATE TABLE "alignment_training_exports" (
  "id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "client_action_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "manifest_format" TEXT NOT NULL,
  "manifest_version" INTEGER NOT NULL,
  "manifest_checksum" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "split_seed_hash" TEXT NOT NULL,
  "split_ratios" JSONB NOT NULL,
  "split_counts" JSONB NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "component_count" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alignment_training_exports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alignment_training_exports_count_check"
    CHECK ("sample_count" > 0 AND "component_count" > 0 AND "component_count" <= "sample_count"),
  CONSTRAINT "alignment_training_exports_hash_check"
    CHECK (
      "request_hash" ~ '^[0-9a-f]{64}$' AND
      "manifest_checksum" ~ '^[0-9a-f]{64}$' AND
      "split_seed_hash" ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE "alignment_training_export_items" (
  "export_id" TEXT NOT NULL,
  "alignment_application_id" TEXT NOT NULL,
  "annotation_file_id_snapshot" TEXT NOT NULL,
  "project_resource_id_snapshot" TEXT NOT NULL,
  "project_research_group_revision" INTEGER NOT NULL,
  "alignment_run_id" TEXT NOT NULL,
  "alignment_artifact_id" TEXT NOT NULL,
  "base_revision" INTEGER NOT NULL,
  "committed_revision" INTEGER NOT NULL,
  "observation_end_revision" INTEGER NOT NULL,
  "target_mode" "AlignmentTrainingTargetMode" NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "group_component_hash" TEXT NOT NULL,
  "split" "AlignmentTrainingSplit" NOT NULL,
  "snapshot" JSONB NOT NULL,

  CONSTRAINT "alignment_training_export_items_pkey"
    PRIMARY KEY ("export_id", "alignment_application_id"),
  CONSTRAINT "alignment_training_export_items_revision_check"
    CHECK (
      "base_revision" >= 0 AND
      "committed_revision" = "base_revision" + 1 AND
      "observation_end_revision" >= "committed_revision" AND
      "target_revision" BETWEEN "committed_revision" AND "observation_end_revision" AND
      "project_research_group_revision" >= 0
    ),
  CONSTRAINT "alignment_training_export_items_component_hash_check"
    CHECK ("group_component_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "alignment_training_export_groups" (
  "export_id" TEXT NOT NULL,
  "alignment_application_id" TEXT NOT NULL,
  "research_group_id" TEXT NOT NULL,
  "project_resource_id_snapshot" TEXT NOT NULL,
  "kind" "AlignmentResearchGroupKind" NOT NULL,
  "display_name_snapshot" TEXT NOT NULL,

  CONSTRAINT "alignment_training_export_groups_pkey"
    PRIMARY KEY ("export_id", "alignment_application_id", "research_group_id"),
  CONSTRAINT "alignment_training_export_groups_display_name_check"
    CHECK (char_length("display_name_snapshot") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "alignment_training_exports_created_by_client_action_id_key"
ON "alignment_training_exports"("created_by", "client_action_id");
CREATE INDEX "alignment_training_exports_created_at_id_idx"
ON "alignment_training_exports"("created_at", "id");
CREATE INDEX "alignment_training_exports_manifest_checksum_idx"
ON "alignment_training_exports"("manifest_checksum");
CREATE INDEX "alignment_training_export_items_annotation_file_id_snapshot_idx"
ON "alignment_training_export_items"("annotation_file_id_snapshot");
CREATE INDEX "alignment_training_export_items_project_resource_id_snapshot_idx"
ON "alignment_training_export_items"("project_resource_id_snapshot");
CREATE INDEX "alignment_training_export_items_alignment_run_id_idx"
ON "alignment_training_export_items"("alignment_run_id");
CREATE INDEX "alignment_training_export_items_alignment_artifact_id_idx"
ON "alignment_training_export_items"("alignment_artifact_id");
CREATE INDEX "alignment_training_export_groups_research_group_id_idx"
ON "alignment_training_export_groups"("research_group_id");
CREATE INDEX "alignment_training_export_groups_project_resource_id_snapshot_idx"
ON "alignment_training_export_groups"("project_resource_id_snapshot");

ALTER TABLE "alignment_training_exports"
ADD CONSTRAINT "alignment_training_exports_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_training_export_items"
ADD CONSTRAINT "alignment_training_export_items_export_id_fkey"
FOREIGN KEY ("export_id") REFERENCES "alignment_training_exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alignment_training_export_groups"
ADD CONSTRAINT "alignment_training_export_groups_item_fkey"
FOREIGN KEY ("export_id", "alignment_application_id")
REFERENCES "alignment_training_export_items"("export_id", "alignment_application_id")
ON DELETE CASCADE ON UPDATE CASCADE;
