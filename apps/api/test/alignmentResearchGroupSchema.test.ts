import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D3c2a migration 只追加研究分组身份、项目关系和 revision", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902060000_alignment_research_groups/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TYPE "AlignmentResearchGroupKind"/u);
  assert.match(sql, /CREATE TABLE "alignment_research_groups"/u);
  assert.match(sql, /CREATE TABLE "project_alignment_research_groups"/u);
  assert.match(sql, /ADD COLUMN "research_group_revision" INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
