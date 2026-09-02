-- FA-R1 纠正产品边界：平台只采集人工修正，不再运行对齐模型或生成训练包。
-- 清理前逐项确认错误链路从未产生事实；任一门禁失败都必须人工核查，禁止静默丢数据。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "alignment_training_package_artifacts" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: training package artifacts exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_training_export_inputs" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: training export inputs exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_training_export_groups" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: training export groups exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_training_export_items" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: training export items exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_training_exports" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: training exports exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "project_alignment_research_groups" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: project research groups exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_research_groups" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: research groups exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_quality_assessments" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: quality assessments exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_applications" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: alignment applications exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_artifacts" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: alignment artifacts exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "alignment_runs" LIMIT 1) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: alignment runs exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "processing_jobs"
    WHERE "type"::text IN ('force_alignment', 'alignment_training_export')
       OR "alignment_run_id" IS NOT NULL
       OR "alignment_training_export_id" IS NOT NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: processing jobs exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "annotation_operations"
    WHERE "alignment_application_id" IS NOT NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: operation bindings exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "project_metadata"
    WHERE "research_group_revision" <> 0
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: project research revisions exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "audit_logs"
    WHERE "action"::text IN (
      'alignment_quality_assessment_upsert',
      'alignment_research_group_create',
      'project_alignment_research_groups_update',
      'alignment_training_export_freeze',
      'alignment_training_export_job_create',
      'alignment_training_package_download'
    )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'force-alignment cleanup blocked: audit facts exist';
  END IF;
END $$;

-- 先解除核心业务表对错误功能表的引用，再按依赖方向删除空表。
ALTER TABLE "processing_jobs"
  DROP CONSTRAINT "processing_jobs_alignment_training_export_type_check",
  DROP CONSTRAINT "processing_jobs_alignment_training_export_id_fkey",
  DROP CONSTRAINT "processing_jobs_alignment_run_type_check",
  DROP CONSTRAINT "processing_jobs_alignment_run_id_fkey",
  DROP COLUMN "alignment_training_export_id",
  DROP COLUMN "alignment_run_id";

ALTER TABLE "annotation_operations"
  DROP CONSTRAINT "annotation_operations_alignment_application_id_fkey",
  DROP COLUMN "alignment_application_id";

DROP TABLE "alignment_training_package_artifacts";
DROP TABLE "alignment_training_export_inputs";
DROP TABLE "alignment_training_export_groups";
DROP TABLE "alignment_training_export_items";
DROP TABLE "alignment_training_exports";
DROP TABLE "alignment_quality_assessments";
DROP TABLE "alignment_applications";
DROP TABLE "alignment_artifacts";
DROP TABLE "alignment_runs";
DROP TABLE "project_alignment_research_groups";
DROP TABLE "alignment_research_groups";

ALTER TABLE "project_metadata"
  DROP CONSTRAINT "project_metadata_research_group_revision_check",
  DROP COLUMN "research_group_revision";

DROP TYPE "AlignmentTrainingSplit";
DROP TYPE "AlignmentTrainingTargetMode";
DROP TYPE "AlignmentResearchGroupKind";
DROP TYPE "AlignmentQualityIssueCode";
DROP TYPE "AlignmentQualityVerdict";
DROP TYPE "AlignmentQualityAssessmentScope";
DROP TYPE "AlignmentArtifactKind";

-- PostgreSQL enum 不能安全地原地删除值；历史 ProcessingJobType/AuditAction 值保留为不可达 tombstone。
-- 运行时代码、Prisma schema 和 API 均不再接受这些值，避免为枚举清理重写任务与审计大表。
