import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D3c3b migration 只追加训练导出任务类型、可空外键和一致性门禁", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902090000_alignment_training_export_jobs/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ADD VALUE 'alignment_training_export'/u);
  assert.match(sql, /ADD VALUE 'alignment_training_export_job_create'/u);
  assert.match(sql, /ADD COLUMN "alignment_training_export_id" TEXT/u);
  assert.match(sql, /processing_jobs_alignment_training_export_id_fkey/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.match(sql, /processing_jobs_alignment_training_export_type_check/u);
  assert.match(sql, /"analysis_run_id" IS NULL/u);
  assert.match(sql, /"alignment_run_id" IS NULL/u);
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
