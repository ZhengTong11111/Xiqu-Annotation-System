import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "./testEnvironment.js";

const migrationRoot = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
const prismaSchemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const migrationLockPath = fileURLToPath(new URL("../../../prisma/migrations/migration_lock.toml", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const productionBaselineMigration = "20260901030000_annotation_review_link_integrity";
const currentFinalMigration = "20260903020000_annotation_recovery_snapshot_shadow_inline_contract";

test("生产 36 migration 基线升级到当前 41 migration 时完整保留既有业务事实", async () => {
  assertSafeTestDatabaseUrl();
  const schemaName = `history_upgrade_${randomUUID().replaceAll("-", "")}_test`;
  const databaseUrl = new URL(TEST_DATABASE_URL);
  databaseUrl.search = "";
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const client = await pool.connect();
  const quotedSchema = quoteIdentifier(schemaName);
  let stagedPrismaRoot: string | null = null;

  try {
    // 临时目录放在 workspace 内，使临时 Prisma config 能按 Node 规则解析仓库依赖；finally 会无条件删除。
    stagedPrismaRoot = await mkdtemp(join(workspaceRoot, ".history-upgrade-"));
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);

    const migrationNames = await readOrderedMigrationNames();
    const baselineIndex = migrationNames.indexOf(productionBaselineMigration);
    const finalIndex = migrationNames.indexOf(currentFinalMigration);
    assert.equal(baselineIndex, 35, "生产历史基线必须仍是第 36 条 migration");
    assert.equal(finalIndex, 40, "当前候选必须仍以第 41 条 migration 收尾");
    assert.equal(migrationNames.length, finalIndex + 1, "当前收尾 migration 后不能有未纳入演练的新 migration");

    // 先精确停在生产现有版本，再注入业务事实；新空库一次跑到底无法证明历史升级安全。
    await prepareStagedPrismaRoot(stagedPrismaRoot);
    await copyMigrations(stagedPrismaRoot, migrationNames.slice(0, baselineIndex + 1));
    await runPrismaMigrateDeploy(stagedPrismaRoot, TEST_DATABASE_URL, schemaName);
    await seedHistoricalBusinessFacts(client);
    const beforeUpgrade = await readProtectedBusinessFacts(client);

    await copyMigrations(stagedPrismaRoot, migrationNames.slice(baselineIndex + 1, finalIndex + 1));
    await runPrismaMigrateDeploy(stagedPrismaRoot, TEST_DATABASE_URL, schemaName);
    const afterUpgrade = await readProtectedBusinessFacts(client);
    assert.deepEqual(afterUpgrade, beforeUpgrade);

    await assertHistoryCapacitySchema(client, schemaName);
  } finally {
    client.release();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await pool.end();
      if (stagedPrismaRoot) {
        await rm(stagedPrismaRoot, { recursive: true, force: true });
      }
    }
  }
});

async function readOrderedMigrationNames() {
  const entries = await readdir(migrationRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function prepareStagedPrismaRoot(stagedPrismaRoot: string) {
  const stagedSchemaPath = join(stagedPrismaRoot, "schema.prisma");
  const stagedMigrationsPath = join(stagedPrismaRoot, "migrations");
  await mkdir(stagedMigrationsPath, { recursive: true });
  await cp(prismaSchemaPath, stagedSchemaPath);
  await cp(migrationLockPath, join(stagedMigrationsPath, "migration_lock.toml"));
  await writeFile(join(stagedPrismaRoot, "prisma.config.ts"), `
    import { defineConfig } from "prisma/config";

    export default defineConfig({
      schema: ${JSON.stringify(stagedSchemaPath)},
      datasource: { url: process.env.DATABASE_URL },
      migrations: { path: ${JSON.stringify(stagedMigrationsPath)} },
    });
  `, "utf8");
}

async function copyMigrations(stagedPrismaRoot: string, migrationNames: string[]) {
  for (const migrationName of migrationNames) {
    await cp(
      join(migrationRoot, migrationName),
      join(stagedPrismaRoot, "migrations", migrationName),
      { recursive: true },
    );
  }
}

async function runPrismaMigrateDeploy(
  stagedPrismaRoot: string,
  baseDatabaseUrl: string,
  schemaName: string,
) {
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.searchParams.set("schema", schemaName);
  const configPath = join(stagedPrismaRoot, "prisma.config.ts");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "migrate", "deploy", "--config", configPath],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `Prisma 历史升级演练失败，退出码 ${code ?? "null"}：${stderr.slice(-2000) || stdout.slice(-2000)}`,
      ));
    });
  });
}

async function seedHistoricalBusinessFacts(client: pg.PoolClient) {
  const payload = {
    version: 7,
    title: "历史升级演练",
    duration: 12.5,
    sentences: [{ id: "sentence-1", text: "原有标注不能丢失", start: 1, end: 3 }],
  };
  const operationPayload = {
    type: "annotation.character.timing.update",
    characterId: "character-1",
    before: { start: 1, end: 1.5 },
    after: { start: 1.1, end: 1.6 },
  };
  const reviewPackage = {
    formatVersion: 1,
    source: { resourceId: "annotation-source", revision: 3 },
    confirmations: [{ id: "confirmation-1", startTime: 1, endTime: 2 }],
  };

  await client.query(`
    INSERT INTO "users" (
      "id", "account_name", "display_name", "password_hash", "updated_at"
    ) VALUES ('user-1', 'history-upgrade-user', '历史升级用户', 'not-a-real-credential', CURRENT_TIMESTAMP)
  `);
  await client.query(`
    INSERT INTO "resource_entries" (
      "id", "parent_id", "type", "name", "owner_user_id", "updated_at"
    ) VALUES
      ('project-1', NULL, 'project', '历史升级项目', 'user-1', CURRENT_TIMESTAMP),
      ('annotation-source', 'project-1', 'annotation_file', '来源标注.json', 'user-1', CURRENT_TIMESTAMP),
      ('annotation-target', 'project-1', 'annotation_file', '目标标注.json', 'user-1', CURRENT_TIMESTAMP)
  `);
  await client.query(`
    INSERT INTO "project_metadata" ("resource_id", "description")
    VALUES ('project-1', '验证 36 到 41 migration 的业务事实保留')
  `);
  await client.query(`
    INSERT INTO "annotation_files" (
      "resource_id", "payload", "revision", "last_edited_by", "last_saved_at",
      "last_operation_sequence", "workflow_status", "workflow_updated_at", "workflow_updated_by"
    ) VALUES
      ('annotation-source', $1::jsonb, 3, 'user-1', '2026-09-01T08:00:00Z', 1, 'annotated', '2026-09-01T08:00:00Z', 'user-1'),
      ('annotation-target', $2::jsonb, 2, 'user-1', '2026-09-01T08:01:00Z', 0, 'unannotated', NULL, NULL)
  `, [payload, { ...payload, title: "历史升级目标" }]);
  await client.query(`
    INSERT INTO "annotation_operations" (
      "id", "annotation_file_id", "actor_user_id", "client_operation_id", "request_hash",
      "sequence", "base_revision", "local_revision", "action", "payload", "status",
      "committed_revision", "committed_at", "created_at"
    ) VALUES (
      'operation-1', 'annotation-source', 'user-1', '11111111-1111-4111-8111-111111111111',
      repeat('a', 64), 1, 2, 3, 'annotation.character.timing.update', $1::jsonb, 'accepted', 3,
      '2026-09-01T08:00:00Z', '2026-09-01T07:59:59Z'
    )
  `, [operationPayload]);
  await client.query(`
    INSERT INTO "annotation_recovery_snapshots" (
      "id", "annotation_file_id", "revision", "payload", "created_by", "reason", "created_at"
    ) VALUES (
      'snapshot-1', 'annotation-source', 2, $1::jsonb, 'user-1', '升级前恢复点', '2026-09-01T07:59:00Z'
    )
  `, [payload]);
  await client.query(`
    INSERT INTO "annotation_confirmations" (
      "id", "annotation_file_id", "confirmed_revision", "start_time", "end_time", "target_mode",
      "domains", "track_ids", "note", "created_by", "created_at"
    ) VALUES (
      'confirmation-1', 'annotation-source', 3, 1, 2, 'domains',
      ARRAY['subtitle_lines']::"AnnotationConfirmationDomain"[], ARRAY[]::TEXT[],
      '保留确认事实', 'user-1', '2026-09-01T08:02:00Z'
    )
  `);
  await client.query(`
    INSERT INTO "annotation_range_comments" (
      "id", "annotation_file_id", "commented_revision", "start_time", "end_time", "target_mode",
      "domains", "track_ids", "kind", "body", "created_by", "created_at"
    ) VALUES
      ('comment-1', 'annotation-source', 3, 2, 3, 'all', ARRAY[]::"AnnotationConfirmationDomain"[],
       ARRAY[]::TEXT[], 'review_comment', '保留审核评论', 'user-1', '2026-09-01T08:03:00Z'),
      ('feedback-1', 'annotation-source', 3, 3, 4, 'all', ARRAY[]::"AnnotationConfirmationDomain"[],
       ARRAY[]::TEXT[], 'editor_feedback', '保留编辑反馈', 'user-1', '2026-09-01T08:04:00Z')
  `);
  await client.query(`
    INSERT INTO "annotation_review_links" (
      "id", "target_annotation_file_id", "source_annotation_file_id", "source_resource_id_snapshot",
      "source_file_name_snapshot", "source_revision", "package_fingerprint", "package_payload",
      "confirmation_count", "range_record_count", "created_by", "created_at"
    ) VALUES (
      'review-link-1', 'annotation-target', 'annotation-source', 'annotation-source', '来源标注.json', 3,
      repeat('b', 64), $1::jsonb, 1, 1, 'user-1', '2026-09-01T08:05:00Z'
    )
  `, [reviewPackage]);
}

async function readProtectedBusinessFacts(client: pg.PoolClient) {
  // 只比较生产基线已经存在的列；容量治理新增列另行验证默认值，避免把合法 expand 误报为数据漂移。
  return {
    annotationFiles: await readJsonRows(client, `
      SELECT "resource_id", "payload", "revision", "last_edited_by", "last_saved_at",
             "last_operation_sequence", "workflow_status", "workflow_updated_at", "workflow_updated_by"
      FROM "annotation_files" ORDER BY "resource_id"
    `),
    projectMetadata: await readJsonRows(client, `
      SELECT "resource_id", "description" FROM "project_metadata" ORDER BY "resource_id"
    `),
    operations: await readJsonRows(client, `
      SELECT "id", "annotation_file_id", "actor_user_id", "client_operation_id", "request_hash",
             "sequence", "base_revision", "local_revision", "action", "payload", "status",
             "committed_revision", "committed_at", "created_at"
      FROM "annotation_operations" ORDER BY "id"
    `),
    snapshots: await readJsonRows(client, `
      SELECT "id", "annotation_file_id", "revision", "payload", "created_by", "reason", "created_at"
      FROM "annotation_recovery_snapshots" ORDER BY "id"
    `),
    confirmations: await readJsonRows(client, `
      SELECT * FROM "annotation_confirmations" ORDER BY "id"
    `),
    rangeComments: await readJsonRows(client, `
      SELECT * FROM "annotation_range_comments" ORDER BY "id"
    `),
    reviewLinks: await readJsonRows(client, `
      SELECT * FROM "annotation_review_links" ORDER BY "id"
    `),
  };
}

async function readJsonRows(client: pg.PoolClient, sql: string) {
  const result = await client.query<Record<string, unknown>>(sql);
  return result.rows;
}

async function assertHistoryCapacitySchema(client: pg.PoolClient, schemaName: string) {
  const snapshots = await client.query<{
    storage_mode: string;
    payload_present: boolean;
    payload_sha256: string | null;
    checkpoint_snapshot_id: string | null;
    recipe_verified_at: Date | null;
    compacted_at: Date | null;
  }>(`
    SELECT "storage_mode"::text, "payload" IS NOT NULL AS payload_present, "payload_sha256",
           "checkpoint_snapshot_id", "recipe_verified_at", "compacted_at"
    FROM "annotation_recovery_snapshots"
  `);
  assert.deepEqual(snapshots.rows, [{
    storage_mode: "inline",
    payload_present: true,
    payload_sha256: null,
    checkpoint_snapshot_id: null,
    recipe_verified_at: null,
    compacted_at: null,
  }]);
  assert.equal(await tableExists(client, "annotation_tool_attempts"), true);
  for (const constraintName of ["annotation_recovery_snapshots_future_storage_contract_check"]) {
    assert.equal(await constraintExists(client, schemaName, constraintName), true, `${constraintName} 应存在`);
  }
}

async function tableExists(client: pg.PoolClient, tableName: string) {
  const result = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1)::text AS relation",
    [tableName],
  );
  return result.rows[0]?.relation !== null;
}

async function constraintExists(client: pg.PoolClient, schemaName: string, constraintName: string) {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_record
      INNER JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
      WHERE namespace.nspname = $1 AND constraint_record.conname = $2
    ) AS present
  `, [schemaName, constraintName]);
  return result.rows[0]?.present === true;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
