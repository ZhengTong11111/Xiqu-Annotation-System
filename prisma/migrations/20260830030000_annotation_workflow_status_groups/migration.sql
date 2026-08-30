-- 文件工作流是平台治理元数据；历史文件不根据 payload 猜测完成状态，统一从未标注开始。
CREATE TYPE "AnnotationWorkflowStatus" AS ENUM ('unannotated', 'annotated', 'reviewed');

ALTER TABLE "annotation_files"
ADD COLUMN "workflow_status" "AnnotationWorkflowStatus" NOT NULL DEFAULT 'unannotated',
ADD COLUMN "workflow_updated_at" TIMESTAMP(3),
ADD COLUMN "workflow_updated_by" TEXT;

CREATE INDEX "annotation_files_workflow_status_idx"
ON "annotation_files"("workflow_status");

CREATE INDEX "annotation_files_workflow_updated_by_idx"
ON "annotation_files"("workflow_updated_by");

ALTER TABLE "annotation_files"
ADD CONSTRAINT "annotation_files_workflow_updated_by_fkey"
FOREIGN KEY ("workflow_updated_by") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- 项目职责组只表达分工，不创建或修改任何资源 ACL。
CREATE TYPE "ProjectWorkflowGroup" AS ENUM ('annotation', 'review');

CREATE TABLE "project_workflow_members" (
  "id" TEXT NOT NULL,
  "project_resource_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "group" "ProjectWorkflowGroup" NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_workflow_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_workflow_members_project_resource_id_user_id_group_key"
ON "project_workflow_members"("project_resource_id", "user_id", "group");

CREATE INDEX "project_workflow_members_project_resource_id_group_idx"
ON "project_workflow_members"("project_resource_id", "group");

CREATE INDEX "project_workflow_members_user_id_group_idx"
ON "project_workflow_members"("user_id", "group");

ALTER TABLE "project_workflow_members"
ADD CONSTRAINT "project_workflow_members_project_resource_id_fkey"
FOREIGN KEY ("project_resource_id") REFERENCES "resource_entries"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_workflow_members"
ADD CONSTRAINT "project_workflow_members_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_workflow_members"
ADD CONSTRAINT "project_workflow_members_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'annotation_workflow_status_update';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'project_workflow_groups_update';
