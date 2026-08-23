import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertGeneratedPrismaClientMatchesSchema,
  normalizePrismaSchemaForComparison,
} from "../src/prismaClientSchemaGuard.js";

test("Prisma schema 比较忽略生成器引入的列对齐差异", () => {
  const source = `model User {\n  id          String @id\n  displayName String\n}\n`;
  const generated = `model User {\n  id String          @id\n  displayName    String\n}\n`;
  assert.equal(
    normalizePrismaSchemaForComparison(source),
    normalizePrismaSchemaForComparison(generated),
  );
});

test("Prisma schema 比较保留字符串中的空白", () => {
  assert.notEqual(
    normalizePrismaSchemaForComparison('generator client { output = "one path" }'),
    normalizePrismaSchemaForComparison('generator client { output = "two paths" }'),
  );
});

test("运行时门禁接受同一 schema，拒绝旧字段和缺失生成物", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiqu-prisma-schema-"));
  const sourceDirectory = path.join(root, "prisma");
  const generatedDirectory = path.join(root, "node_modules", ".prisma", "client");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(generatedDirectory, { recursive: true });

  try {
    const currentSchema = "model Review {\n  id String @id\n  comment String?\n}\n";
    await writeFile(path.join(sourceDirectory, "schema.prisma"), currentSchema);
    await writeFile(
      path.join(generatedDirectory, "schema.prisma"),
      "model Review {\n id      String @id\n comment String?\n}\n",
    );
    assert.doesNotThrow(() => assertGeneratedPrismaClientMatchesSchema(root));

    // 旧 Client 即使仍有同名模型，也会因为缺少新字段而被切换前门禁拒绝。
    await writeFile(
      path.join(generatedDirectory, "schema.prisma"),
      "model Review {\n id String @id\n}\n",
    );
    assert.throws(
      () => assertGeneratedPrismaClientMatchesSchema(root),
      /Prisma Client 与 prisma\/schema\.prisma 不一致/u,
    );

    await rm(path.join(generatedDirectory, "schema.prisma"));
    assert.throws(
      () => assertGeneratedPrismaClientMatchesSchema(root),
      /Prisma Client 生成物不完整/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
