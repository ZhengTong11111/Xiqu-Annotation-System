import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { TEST_DATABASE_URL } from "./testEnvironment.js";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260826030000_remove_legacy_analysis_audio_settings/migration.sql",
  import.meta.url,
);

test("RA4c2 migration 在旧设置未映射时拒绝删除，映射完成后再原子清理", async () => {
  const schemaName = `ra4c2_${randomUUID().replaceAll("-", "")}_test`;
  const databaseUrl = new URL(TEST_DATABASE_URL);
  databaseUrl.search = "";
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  const client = await pool.connect();
  const quotedSchema = quoteIdentifier(schemaName);

  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);
    await client.query(createLegacyFixtureSql);

    // 先保留一个尚未转换为共享音轨的 override，迁移必须整体失败且旧表仍可继续补迁。
    await assert.rejects(
      async () => client.query(await readFileMigration()),
      /override has no equivalent enabled audio track/u,
    );
    assert.equal(await tableExists(client, "annotation_analysis_audio_settings"), true);

    await client.query(`
      INSERT INTO "media_audio_tracks" (
        "id", "primary_media_resource_id", "audio_media_resource_id", "kind",
        "offset_seconds", "enabled"
      ) VALUES ('track-reference', 'media-primary', 'media-audio', 'reference', 0.25, true)
    `);
    await client.query(await readFile(migrationUrl, "utf8"));

    assert.equal(await tableExists(client, "annotation_analysis_audio_settings"), false);
    assert.equal(await columnExists(client, schemaName, "media_analysis_runs", "annotation_file_id"), false);
    assert.equal(await columnExists(client, schemaName, "media_analysis_runs", "source_mode"), false);
    assert.equal(await columnExists(client, schemaName, "media_analysis_runs", "source_offset_seconds"), false);
    assert.equal(await typeExists(client, schemaName, "AnalysisAudioMode"), false);
  } finally {
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.end();
  }
});

async function readFileMigration() {
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
      SELECT 1
      FROM pg_type AS type
      INNER JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1 AND type.typname = $2
    ) AS present
  `, [schemaName, typeName]);
  return result.rows[0]?.present === true;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

// 夹具只建立 migration 会读取或删除的列，避免复制完整 Prisma schema 成为第二套测试模型。
const createLegacyFixtureSql = `
  CREATE TYPE "AnalysisAudioMode" AS ENUM ('auto', 'media_override');
  CREATE TYPE "MediaAudioTrackKind" AS ENUM ('original', 'reference');

  CREATE TABLE "resource_entries" (
    "id" TEXT PRIMARY KEY,
    "parent_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "trashed_at" TIMESTAMP(3)
  );
  CREATE TABLE "media_files" (
    "resource_id" TEXT PRIMARY KEY,
    "media_kind" TEXT NOT NULL
  );
  CREATE TABLE "annotation_files" (
    "resource_id" TEXT PRIMARY KEY,
    "media_resource_id" TEXT
  );
  CREATE TABLE "media_audio_tracks" (
    "id" TEXT PRIMARY KEY,
    "primary_media_resource_id" TEXT NOT NULL,
    "audio_media_resource_id" TEXT,
    "vod_rendition_media_resource_id" TEXT,
    "kind" "MediaAudioTrackKind" NOT NULL,
    "offset_seconds" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL
  );
  CREATE TABLE "annotation_analysis_audio_settings" (
    "annotation_file_id" TEXT PRIMARY KEY,
    "mode" "AnalysisAudioMode" NOT NULL,
    "override_media_resource_id" TEXT,
    "offset_seconds" DOUBLE PRECISION NOT NULL
  );
  CREATE TABLE "media_analysis_runs" (
    "id" TEXT PRIMARY KEY,
    "annotation_file_id" TEXT,
    "source_mode" "AnalysisAudioMode",
    "source_offset_seconds" DOUBLE PRECISION
  );
  ALTER TABLE "media_analysis_runs"
    ADD CONSTRAINT "media_analysis_runs_annotation_file_id_fkey"
    FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id");
  CREATE INDEX "media_analysis_runs_annotation_file_id_created_at_idx"
    ON "media_analysis_runs"("annotation_file_id");

  INSERT INTO "resource_entries" ("id") VALUES
    ('annotation-1'), ('media-primary'), ('media-audio');
  INSERT INTO "media_files" ("resource_id", "media_kind") VALUES
    ('media-primary', 'video'), ('media-audio', 'audio');
  INSERT INTO "annotation_files" ("resource_id", "media_resource_id")
    VALUES ('annotation-1', 'media-primary');
  INSERT INTO "media_audio_tracks" (
    "id", "primary_media_resource_id", "kind", "offset_seconds", "enabled"
  ) VALUES ('track-original', 'media-primary', 'original', 0, true);
  INSERT INTO "annotation_analysis_audio_settings" (
    "annotation_file_id", "mode", "override_media_resource_id", "offset_seconds"
  ) VALUES ('annotation-1', 'media_override', 'media-audio', 0.25);
`;
