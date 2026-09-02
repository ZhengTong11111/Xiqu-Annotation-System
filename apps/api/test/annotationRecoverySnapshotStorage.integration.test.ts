import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "./testEnvironment.js";

const migrationPath = new URL(
  "../../../prisma/migrations/20260902010000_annotation_recovery_snapshot_storage_expand/migration.sql",
  import.meta.url,
);

test("HC2a migration 对既有恢复快照只增加 inline 元数据", async () => {
  const { schemaName } = assertSafeTestDatabaseUrl();
  const sourceSql = await readFile(migrationPath, "utf8");
  assert.doesNotMatch(sourceSql, /\b(?:UPDATE|DELETE|DROP)\s+"annotation_recovery_snapshots"/i);

  const tableName = "hc2a_legacy_recovery_snapshots_test";
  const enumName = "HC2aLegacyRecoverySnapshotStorageModeTest";
  const migrationSql = sourceSql
    .replaceAll("AnnotationRecoverySnapshotStorageMode", enumName)
    .replaceAll("annotation_recovery_snapshots", tableName);
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${schemaName}`,
  });

  try {
    // 临时表模拟上一版 schema，先写入历史任意 JSON，再执行未经简化的真实 migration SQL。
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.query(`DROP TYPE IF EXISTS "${enumName}"`);
    await pool.query(`
      CREATE TABLE "${tableName}" (
        "id" TEXT PRIMARY KEY,
        "annotation_file_id" TEXT NOT NULL,
        "revision" INTEGER NOT NULL,
        "payload" JSONB NOT NULL,
        "created_by" TEXT NOT NULL,
        "reason" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const historicalPayload = {
      wrapper: { version: 2, unknownField: true },
      marker: "迁移前历史 JSON",
    };
    await pool.query(
      `INSERT INTO "${tableName}" (
        "id", "annotation_file_id", "revision", "payload", "created_by"
      ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      ["snapshot-before-hc2", "annotation-before-hc2", 8, JSON.stringify(historicalPayload), "user-1"],
    );

    await pool.query(migrationSql);
    const result = await pool.query<{
      payload: unknown;
      storage_mode: string;
      payload_sha256: string | null;
      checkpoint_snapshot_id: string | null;
    }>(`SELECT payload, storage_mode, payload_sha256, checkpoint_snapshot_id FROM "${tableName}"`);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.rows[0], {
      payload: historicalPayload,
      storage_mode: "inline",
      payload_sha256: null,
      checkpoint_snapshot_id: null,
    });

    // 当前阶段数据库门禁必须拒绝提前写入 reconstructible，失败后原行保持 inline。
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "storage_mode" = 'reconstructible' WHERE "id" = $1`, [
        "snapshot-before-hc2",
      ]),
      /hc2a_inline_only_check/,
    );
    const unchanged = await pool.query<{ storage_mode: string; payload: unknown }>(
      `SELECT storage_mode, payload FROM "${tableName}" WHERE "id" = $1`,
      ["snapshot-before-hc2"],
    );
    assert.deepEqual(unchanged.rows[0], {
      storage_mode: "inline",
      payload: historicalPayload,
    });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.query(`DROP TYPE IF EXISTS "${enumName}"`);
    await pool.end();
  }
});
