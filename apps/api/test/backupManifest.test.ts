import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeBackupManifest, writeBackupManifest } from "../src/backup/backupManifest.js";
import {
  assertIsolatedDatabaseTarget,
  assertSafeRelativePath,
  assertSafeRestoreStorage,
  assertSeparatedDirectories,
  resolveInsideRoot,
} from "../src/backup/backupPaths.js";
import { digestFile } from "../src/backup/checksum.js";
import type { BackupManifest } from "../src/backup/backupTypes.js";
import { verifyBackupDirectory } from "../src/backup/backupVerifier.js";
import { parsePostgresConnection } from "../src/backup/postgresTools.js";

// 测试夹具生成一个最小但真实可校验的备份目录，供往返和篡改测试复用。
async function createBackupFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiqu-backup-manifest-"));
  await mkdir(path.join(root, "objects", "2026-08-03"), { recursive: true });
  await writeFile(path.join(root, "database.dump"), "database");
  await writeFile(path.join(root, "objects", "2026-08-03", "media.bin"), "media");
  const dump = await digestFile(path.join(root, "database.dump"));
  const object = await digestFile(path.join(root, "objects", "2026-08-03", "media.bin"));
  const manifest: BackupManifest = {
    format: "xiqu-platform-backup",
    version: 1,
    createdAt: "2026-08-03T00:00:00.000Z",
    operator: { accountName: "admin", userId: "admin-id" },
    maintenanceReason: "测试备份",
    database: {
      identity: { host: "localhost", port: 54329, database: "xiqu_platform", schema: "public" },
      postgresToolVersion: "pg_dump (PostgreSQL) 16.14",
      dump: { relativePath: "database.dump", ...dump },
      summary: {
        resourceCount: 0,
        annotationFileCount: 0,
        mediaFileCount: 1,
        fileObjectCount: 1,
        fileObjects: [{ storageKey: "2026-08-03/media.bin", size: object.size, checksum: object.sha256 }],
        derivedObjectCount: 0,
        derivedObjects: [],
      },
    },
    objects: {
      count: 1,
      totalBytes: object.size,
      entries: [{ storageKey: "2026-08-03/media.bin", relativePath: "objects/2026-08-03/media.bin", ...object }],
    },
    warnings: [],
  };
  await writeBackupManifest(root, manifest);
  return { root, manifest };
}

test("备份 manifest 稳定排序并可完成离线校验", async () => {
  const { root, manifest } = await createBackupFixture();
  try {
    assert.deepEqual(normalizeBackupManifest(manifest), manifest);
    const result = await verifyBackupDirectory(root);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("备份校验能够发现对象内容篡改", async () => {
  const { root } = await createBackupFixture();
  try {
    await writeFile(path.join(root, "objects", "2026-08-03", "media.bin"), "tampered");
    const result = await verifyBackupDirectory(root);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /大小不一致|SHA-256 不一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("备份校验拒绝 manifest 未声明的额外文件", async () => {
  const { root } = await createBackupFixture();
  try {
    await writeFile(path.join(root, "unexpected.txt"), "unexpected");
    const result = await verifyBackupDirectory(root);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /manifest 未声明的文件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("备份路径拒绝路径穿越和根目录逃逸", () => {
  assert.throws(() => assertSafeRelativePath("../secret"), /路径穿越/);
  assert.throws(() => assertSafeRelativePath("objects\\secret"), /安全的相对路径/);
  assert.throws(() => resolveInsideRoot("/tmp/root", "../secret"), /路径穿越/);
});

test("备份与恢复目标拒绝源目录重叠和同一数据库", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiqu-backup-paths-"));
  const storage = path.join(root, "storage");
  const output = path.join(storage, "backups");
  await mkdir(storage);
  try {
    assert.throws(() => assertSeparatedDirectories(storage, output), /彼此分离/);
    await assert.rejects(
      assertSafeRestoreStorage(path.join(storage, "restore"), storage, path.join(root, "backup")),
      /不能与源存储或备份目录重叠/,
    );
    const identity = { host: "localhost", port: 5432, database: "xiqu", schema: "public" };
    assert.throws(() => assertIsolatedDatabaseTarget(identity, identity), /不能与备份源数据库相同/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL 工具连接拆分后不会把密码放入安全身份", () => {
  const parsed = parsePostgresConnection(
    "postgresql://user:secret@localhost:54329/xiqu?schema=public",
  );
  assert.deepEqual(parsed.identity, {
    host: "localhost",
    port: 54329,
    database: "xiqu",
    schema: "public",
  });
  assert.equal(parsed.childEnvironment.PGPASSWORD, "secret");
  assert.doesNotMatch(JSON.stringify(parsed.identity), /secret/);
});

test("未知 manifest 版本在读取文件摘要前即被拒绝", async () => {
  const { root, manifest } = await createBackupFixture();
  try {
    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ ...manifest, version: 999 }),
    );
    const result = await verifyBackupDirectory(root);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /不支持备份 manifest 版本/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
