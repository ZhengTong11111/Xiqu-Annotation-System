import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D3c3c migration 只追加不可变训练包资产和引用门禁", async () => {
  const sql = await readFile(
    new URL(
      "../../../prisma/migrations/20260902100000_alignment_training_package_artifacts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "alignment_training_package_artifacts"/u);
  assert.match(sql, /alignment_training_package_artifacts_contract_check/u);
  assert.match(sql, /"format" = 'xiqu-alignment-training-package'/u);
  assert.match(sql, /"mime_type" = 'application\/zip'/u);
  assert.match(sql, /processing_job_id_fkey/u);
  assert.match(sql, /export_id_fkey/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
