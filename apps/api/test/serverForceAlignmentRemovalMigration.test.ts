import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { TEST_DATABASE_URL } from "./testEnvironment.js";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260902120000_remove_server_force_alignment_pipeline/migration.sql",
  import.meta.url,
);

test("FA-R1 cleanup 对非空错误链路 fail closed，空结构才允许被完整移除", async () => {
  const schemaName = `far1_${randomUUID().replaceAll("-", "")}_test`;
  const databaseUrl = new URL(TEST_DATABASE_URL);
  databaseUrl.search = "";
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const client = await pool.connect();
  const quotedSchema = quoteIdentifier(schemaName);

  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);
    await client.query(createFixtureSql);

    await client.query(`INSERT INTO "alignment_runs" ("id") VALUES ('run-used')`);
    const migrationSql = await readMigration();
    await assert.rejects(
      () => client.query(migrationSql),
      /alignment runs exist/u,
    );
    assert.equal(await tableExists(client, "alignment_runs"), true);
    assert.equal(await columnExists(client, schemaName, "processing_jobs", "alignment_run_id"), true);

    await client.query(`DELETE FROM "alignment_runs"`);
    await client.query(migrationSql);
    for (const tableName of removedTables) {
      assert.equal(await tableExists(client, tableName), false, `${tableName} 应被清理`);
    }
    assert.equal(await columnExists(client, schemaName, "processing_jobs", "alignment_run_id"), false);
    assert.equal(await columnExists(client, schemaName, "annotation_operations", "alignment_application_id"), false);
    assert.equal(await columnExists(client, schemaName, "project_metadata", "research_group_revision"), false);
    for (const typeName of removedTypes) {
      assert.equal(await typeExists(client, schemaName, typeName), false, `${typeName} 应被清理`);
    }
  } finally {
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.end();
  }
});

test("FA-R1 cleanup 不改写标注、operation、快照或工具尝试业务数据", async () => {
  const sql = await readMigration();
  for (const table of [
    "annotation_files",
    "annotation_recovery_snapshots",
    "annotation_tool_attempts",
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(?:UPDATE|DELETE\\s+FROM|DROP\\s+TABLE|ALTER\\s+TABLE)\\s+"${table}"`, "iu"));
  }
  assert.doesNotMatch(sql, /\bCASCADE\b/iu);
  assert.match(sql, /alignment_operations|annotation_operations/iu);
});

async function readMigration() {
  return readFile(migrationUrl, "utf8");
}

async function tableExists(client: pg.PoolClient, tableName: string) {
  const result = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1)::text AS relation",
    [tableName],
  );
  return result.rows[0]?.relation !== null;
}

async function columnExists(
  client: pg.PoolClient,
  schemaName: string,
  tableName: string,
  columnName: string,
) {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
    ) AS present
  `, [schemaName, tableName, columnName]);
  return result.rows[0]?.present === true;
}

async function typeExists(client: pg.PoolClient, schemaName: string, typeName: string) {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1 AND type.typname = $2
    ) AS present
  `, [schemaName, typeName]);
  return result.rows[0]?.present === true;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

const removedTables = [
  "alignment_training_package_artifacts",
  "alignment_training_export_inputs",
  "alignment_training_export_groups",
  "alignment_training_export_items",
  "alignment_training_exports",
  "alignment_quality_assessments",
  "alignment_applications",
  "alignment_artifacts",
  "alignment_runs",
  "project_alignment_research_groups",
  "alignment_research_groups",
] as const;

const removedTypes = [
  "AlignmentTrainingSplit",
  "AlignmentTrainingTargetMode",
  "AlignmentResearchGroupKind",
  "AlignmentQualityIssueCode",
  "AlignmentQualityVerdict",
  "AlignmentQualityAssessmentScope",
  "AlignmentArtifactKind",
] as const;

// 夹具只实现清理迁移实际读取和删除的合同，避免复制完整生产 schema。
const createFixtureSql = `
  CREATE TYPE "ProcessingJobType" AS ENUM ('media_analysis', 'force_alignment', 'alignment_training_export');
  CREATE TYPE "AuditAction" AS ENUM (
    'auth_login',
    'alignment_quality_assessment_upsert',
    'alignment_research_group_create',
    'project_alignment_research_groups_update',
    'alignment_training_export_freeze',
    'alignment_training_export_job_create',
    'alignment_training_package_download'
  );
  CREATE TYPE "AlignmentArtifactKind" AS ENUM ('prediction');
  CREATE TYPE "AlignmentQualityAssessmentScope" AS ENUM ('editor', 'reviewer');
  CREATE TYPE "AlignmentQualityVerdict" AS ENUM ('correct', 'needs_adjustment', 'unusable');
  CREATE TYPE "AlignmentQualityIssueCode" AS ENUM ('boundary_offset');
  CREATE TYPE "AlignmentResearchGroupKind" AS ENUM ('work', 'performer');
  CREATE TYPE "AlignmentTrainingTargetMode" AS ENUM ('prediction', 'manual_revision');
  CREATE TYPE "AlignmentTrainingSplit" AS ENUM ('train', 'validation', 'test');

  CREATE TABLE "alignment_runs" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_artifacts" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_applications" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_quality_assessments" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_research_groups" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "project_alignment_research_groups" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_training_exports" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_training_export_items" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_training_export_groups" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_training_export_inputs" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "alignment_training_package_artifacts" ("id" TEXT PRIMARY KEY);

  CREATE TABLE "processing_jobs" (
    "id" TEXT PRIMARY KEY,
    "type" "ProcessingJobType" NOT NULL,
    "analysis_run_id" TEXT,
    "alignment_run_id" TEXT,
    "alignment_training_export_id" TEXT,
    CONSTRAINT "processing_jobs_alignment_run_id_fkey" FOREIGN KEY ("alignment_run_id") REFERENCES "alignment_runs"("id"),
    CONSTRAINT "processing_jobs_alignment_run_type_check" CHECK (true),
    CONSTRAINT "processing_jobs_alignment_training_export_id_fkey" FOREIGN KEY ("alignment_training_export_id") REFERENCES "alignment_training_exports"("id"),
    CONSTRAINT "processing_jobs_alignment_training_export_type_check" CHECK (true)
  );
  CREATE TABLE "annotation_operations" (
    "id" TEXT PRIMARY KEY,
    "alignment_application_id" TEXT,
    CONSTRAINT "annotation_operations_alignment_application_id_fkey"
      FOREIGN KEY ("alignment_application_id") REFERENCES "alignment_applications"("id")
  );
  CREATE TABLE "project_metadata" (
    "id" TEXT PRIMARY KEY,
    "research_group_revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "project_metadata_research_group_revision_check" CHECK ("research_group_revision" >= 0)
  );
  CREATE TABLE "audit_logs" (
    "id" TEXT PRIMARY KEY,
    "action" "AuditAction" NOT NULL
  );
`;
