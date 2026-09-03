import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "./testEnvironment.js";

const migrationPath = new URL(
  "../../../prisma/migrations/20260902010000_annotation_recovery_snapshot_storage_expand/migration.sql",
  import.meta.url,
);
const shadowMigrationPath = new URL(
  "../../../prisma/migrations/20260902020000_annotation_recovery_snapshot_shadow_recipe/migration.sql",
  import.meta.url,
);
const futureContractMigrationPath = new URL(
  "../../../prisma/migrations/20260903010000_annotation_recovery_snapshot_future_contract/migration.sql",
  import.meta.url,
);
const shadowInlineContractMigrationPath = new URL(
  "../../../prisma/migrations/20260903020000_annotation_recovery_snapshot_shadow_inline_contract/migration.sql",
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

test("HC3a migration 允许完整影子 recipe，但仍禁止清空 payload 或切换存储模式", async () => {
  const { schemaName } = assertSafeTestDatabaseUrl();
  const hc2Source = await readFile(migrationPath, "utf8");
  const hc3Source = await readFile(shadowMigrationPath, "utf8");
  assert.doesNotMatch(hc3Source, /\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  assert.doesNotMatch(hc3Source, /DROP\s+COLUMN|ALTER\s+COLUMN\s+"payload"/iu);

  const tableName = "hc3a_shadow_recovery_snapshots_test";
  const enumName = "HC3aShadowRecoverySnapshotStorageModeTest";
  const rewriteMigration = (source: string) => source
    .replaceAll("AnnotationRecoverySnapshotStorageMode", enumName)
    .replaceAll("annotation_recovery_snapshots", tableName);
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${schemaName}`,
  });

  try {
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
    const payload = { marker: "影子阶段必须保留", nested: [1, 2, 3] };
    await pool.query(
      `INSERT INTO "${tableName}" (
        "id", "annotation_file_id", "revision", "payload", "created_by"
      ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      ["target-2", "file-1", 2, JSON.stringify(payload), "user-1"],
    );
    await pool.query(rewriteMigration(hc2Source));
    await pool.query(rewriteMigration(hc3Source));

    await pool.query(`
      UPDATE "${tableName}"
      SET "payload_sha256" = $2,
          "checkpoint_snapshot_id" = 'checkpoint-1',
          "operation_revision_start" = 2,
          "operation_revision_end" = 2,
          "operation_sequence_start" = 10,
          "operation_sequence_end" = 10,
          "operation_count" = 1,
          "compaction_version" = 1,
          "recipe_verified_at" = CURRENT_TIMESTAMP
      WHERE "id" = $1
    `, ["target-2", "a".repeat(64)]);
    const row = await pool.query<{
      payload: unknown;
      storage_mode: string;
      compacted_at: Date | null;
      recipe_verified_at: Date | null;
    }>(`SELECT payload, storage_mode, compacted_at, recipe_verified_at FROM "${tableName}"`);
    assert.deepEqual(row.rows[0]?.payload, payload);
    assert.equal(row.rows[0]?.storage_mode, "inline");
    assert.equal(row.rows[0]?.compacted_at, null);
    assert.ok(row.rows[0]?.recipe_verified_at);

    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "storage_mode" = 'reconstructible' WHERE "id" = $1`, ["target-2"]),
      /hc2a_inline_only_check/u,
    );
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "payload" = NULL WHERE "id" = $1`, ["target-2"]),
      /not-null constraint/u,
    );
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "compacted_at" = CURRENT_TIMESTAMP WHERE "id" = $1`, ["target-2"]),
      /inline_shadow_recipe_check/u,
    );
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "operation_count" = NULL WHERE "id" = $1`, ["target-2"]),
      /recipe_shape_check/u,
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.query(`DROP TYPE IF EXISTS "${enumName}"`);
    await pool.end();
  }
});

test("HC3c2 migration 保留旧 inline 并允许完整 reconstructible 合同", async () => {
  const { schemaName } = assertSafeTestDatabaseUrl();
  const hc2Source = await readFile(migrationPath, "utf8");
  const hc3Source = await readFile(shadowMigrationPath, "utf8");
  const futureSource = await readFile(futureContractMigrationPath, "utf8");
  const shadowInlineSource = await readFile(shadowInlineContractMigrationPath, "utf8");
  assert.doesNotMatch(futureSource, /\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  assert.doesNotMatch(shadowInlineSource, /\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);

  const tableName = "hc3c2_future_recovery_snapshots_test";
  const enumName = "HC3c2FutureRecoverySnapshotStorageModeTest";
  const rewriteMigration = (source: string) => source
    .replaceAll("AnnotationRecoverySnapshotStorageMode", enumName)
    .replaceAll("annotation_recovery_snapshots", tableName);
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${schemaName}`,
  });

  try {
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
    const legacyPayload = { marker: "HC3c2 迁移前历史" };
    await pool.query(
      `INSERT INTO "${tableName}" ("id", "annotation_file_id", "revision", "payload", "created_by")
       VALUES ('legacy-1', 'file-1', 1, $1::jsonb, 'user-1')`,
      [JSON.stringify(legacyPayload)],
    );
    await pool.query(rewriteMigration(hc2Source));
    await pool.query(rewriteMigration(hc3Source));
    await pool.query(rewriteMigration(futureSource));
    await pool.query(rewriteMigration(shadowInlineSource));

    const legacy = await pool.query<{ payload: unknown; storage_mode: string }>(
      `SELECT payload, storage_mode FROM "${tableName}" WHERE id = 'legacy-1'`,
    );
    assert.deepEqual(legacy.rows[0], { payload: legacyPayload, storage_mode: "inline" });

    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "storage_mode" = 'reconstructible' WHERE id = 'legacy-1'`),
      /future_storage_contract_ch/u,
    );
    await pool.query(`
      INSERT INTO "${tableName}" (
        "id", "annotation_file_id", "revision", "payload", "storage_mode", "payload_sha256",
        "checkpoint_snapshot_id", "operation_revision_start", "operation_revision_end",
        "operation_sequence_start", "operation_sequence_end", "operation_count", "compaction_version",
        "recipe_verified_at", "compacted_at", "created_by"
      ) VALUES (
        'future-2', 'file-1', 2, NULL, 'reconstructible', $1,
        'legacy-1', 2, 2, 1, 1, 1, 1,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'user-1'
      )
    `, ["a".repeat(64)]);

    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "payload_sha256" = NULL WHERE id = 'future-2'`),
      /future_storage_contract_ch/u,
    );
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "payload" = '{}'::jsonb WHERE id = 'future-2'`),
      /future_storage_contract_ch/u,
    );
    await assert.rejects(
      pool.query(`UPDATE "${tableName}" SET "storage_mode" = 'archived' WHERE id = 'future-2'`),
      /future_storage_contract_ch/u,
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.query(`DROP TYPE IF EXISTS "${enumName}"`);
    await pool.end();
  }
});
