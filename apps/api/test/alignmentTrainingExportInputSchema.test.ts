import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D3c3a migration 只追加训练输入快照、校验和引用保护", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902080000_alignment_training_export_inputs/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "alignment_training_export_inputs"/u);
  assert.match(sql, /alignment_training_exports_input_manifest_check/u);
  assert.match(sql, /alignment_training_export_items_alignment_artifact_id_fkey/u);
  assert.match(sql, /alignment_training_export_inputs_source_file_id_fkey/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
