-- FA-D3c2a 只增加研究分组身份和项目关系；既有标注、操作、快照、审核和对齐事实零回填、零改写。
CREATE TYPE "AlignmentResearchGroupKind" AS ENUM ('work', 'performer');

ALTER TYPE "AuditAction" ADD VALUE 'alignment_research_group_create';
ALTER TYPE "AuditAction" ADD VALUE 'project_alignment_research_groups_update';

ALTER TABLE "project_metadata"
ADD COLUMN "research_group_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "project_metadata"
ADD CONSTRAINT "project_metadata_research_group_revision_check"
CHECK ("research_group_revision" >= 0);

CREATE TABLE "alignment_research_groups" (
  "id" TEXT NOT NULL,
  "kind" "AlignmentResearchGroupKind" NOT NULL,
  "display_name" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alignment_research_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alignment_research_groups_display_name_check"
    CHECK (char_length("display_name") BETWEEN 1 AND 120 AND "display_name" = btrim("display_name"))
);

CREATE TABLE "project_alignment_research_groups" (
  "project_resource_id" TEXT NOT NULL,
  "research_group_id" TEXT NOT NULL,
  "assigned_by" TEXT NOT NULL,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_alignment_research_groups_pkey"
    PRIMARY KEY ("project_resource_id", "research_group_id")
);

CREATE INDEX "alignment_research_groups_kind_display_name_id_idx"
ON "alignment_research_groups"("kind", "display_name", "id");

CREATE INDEX "alignment_research_groups_created_by_idx"
ON "alignment_research_groups"("created_by");

CREATE INDEX "project_alignment_research_groups_research_group_id_idx"
ON "project_alignment_research_groups"("research_group_id");

CREATE INDEX "project_alignment_research_groups_assigned_by_idx"
ON "project_alignment_research_groups"("assigned_by");

ALTER TABLE "alignment_research_groups"
ADD CONSTRAINT "alignment_research_groups_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_alignment_research_groups"
ADD CONSTRAINT "project_alignment_research_groups_project_resource_id_fkey"
FOREIGN KEY ("project_resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_alignment_research_groups"
ADD CONSTRAINT "project_alignment_research_groups_research_group_id_fkey"
FOREIGN KEY ("research_group_id") REFERENCES "alignment_research_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_alignment_research_groups"
ADD CONSTRAINT "project_alignment_research_groups_assigned_by_fkey"
FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
