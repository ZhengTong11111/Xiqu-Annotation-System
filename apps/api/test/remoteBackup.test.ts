import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  ObjectReadRange,
  ObjectStorage,
  StagedBinary,
  StoredObjectSummary,
} from "../src/objectStorage.js";
import { parseS3Options } from "../src/objectStorageFactory.js";
import {
  assertSafeRemoteBackupId,
  remoteBackupKeys,
} from "../src/backup/remoteBackupPaths.js";
import { publishRemoteBackupPackage } from "../src/backup/remoteBackupService.js";
import { assertSeparatedStorageNamespaces } from "../src/backup/remoteBackupStorageFactory.js";
import { verifyRemoteBackup } from "../src/backup/remoteBackupVerifier.js";

const BACKUP_ID = "xiqu-backup-2026-08-03T00-00-00-000Z-test1234";

// 内存适配器实现完整 ObjectStorage 协议，让测试能观察 staged/promote/补偿顺序而不绕过业务端口。
class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly events: string[] = [];
  failPromoteKey: string | null = null;
  failDeleteKey: string | null = null;

  constructor(private readonly location: string) {}

  describeBackend() {
    return { kind: "remote" as const, provider: "memory", location: this.location };
  }

  createStorageKey(extension: string) {
    return `${randomUUID()}.${extension}`;
  }

  // 测试上传同样执行真实字节上限和 SHA-256，不能凭调用参数伪造摘要。
  async putStagedObject(finalStorageKey: string, stream: Readable, maxBytes: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error("测试上传超过大小上限");
      chunks.push(bytes);
    }
    const content = Buffer.concat(chunks);
    const stagedStorageKey = `${finalStorageKey}.upload-${randomUUID()}`;
    this.objects.set(stagedStorageKey, content);
    this.events.push(`stage:${finalStorageKey}`);
    return {
      finalStorageKey,
      stagedStorageKey,
      size,
      checksum: createHash("sha256").update(content).digest("hex"),
      header: content.subarray(0, 8_192),
    } satisfies StagedBinary;
  }

  // 可选故障发生在 final 已形成之后，专门验证 copy 成功、staged 删除失败一类边界。
  async promoteStagedObject(staged: StagedBinary) {
    const content = this.objects.get(staged.stagedStorageKey);
    if (!content) throw new Error("测试 staged 对象不存在");
    this.objects.set(staged.finalStorageKey, content);
    this.events.push(`promote:${staged.finalStorageKey}`);
    if (this.failPromoteKey === staged.finalStorageKey) {
      throw new Error("测试 promote 在 final 形成后失败");
    }
    this.objects.delete(staged.stagedStorageKey);
  }

  async getObjectStream(storageKey: string, range?: ObjectReadRange) {
    const content = this.objects.get(storageKey);
    if (!content) throw new Error(`对象不存在：${storageKey}`);
    const selected = range ? content.subarray(range.start, range.end + 1) : content;
    return Readable.from([selected]);
  }

  async objectExists(storageKey: string) {
    return this.objects.has(storageKey);
  }

  async deleteObject(storageKey: string) {
    this.events.push(`delete:${storageKey}`);
    if (this.failDeleteKey === storageKey) throw new Error("测试补偿删除失败");
    this.objects.delete(storageKey);
  }

  async checkReadiness() {}

  async listStoredObjects(): Promise<StoredObjectSummary[]> {
    return [...this.objects].map(([storageKey, content]) => ({
      storageKey,
      size: content.length,
      modifiedAt: new Date("2026-08-03T00:00:00.000Z"),
      staged: storageKey.includes(".upload-"),
    }));
  }
}

// 最小数据库摘要与源对象保持一致，成功备份不应生成一致性 warning。
function createDatabaseSummary(content: Buffer) {
  return {
    resourceCount: 1,
    annotationFileCount: 0,
    mediaFileCount: 1,
    fileObjectCount: 1,
    fileObjects: [{
      storageKey: "media/test.mp4",
      size: content.length,
      checksum: createHash("sha256").update(content).digest("hex"),
    }],
  };
}

// 发布夹具复用同一 package 参数，测试只改变目标故障或发布后的远端内容。
async function createPublishedFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiqu-remote-backup-"));
  const dumpPath = path.join(directory, "database.dump");
  await writeFile(dumpPath, "database-dump");
  const media = Buffer.from("media-content");
  const source = new MemoryObjectStorage("memory/source");
  source.objects.set("media/test.mp4", media);
  const target = new MemoryObjectStorage("memory/backups");
  const options = {
    databaseSummary: createDatabaseSummary(media),
    operator: {
      id: "admin-id",
      accountName: "admin",
      displayName: "系统管理员",
      roles: ["super_admin" as const],
    },
    sourceStorage: source,
    backupStorage: target,
    backupId: BACKUP_ID,
    dumpPath,
    databaseIdentity: {
      host: "localhost",
      port: 54329,
      database: "xiqu_platform",
      schema: "public",
    },
    postgresToolVersion: "pg_dump (PostgreSQL) 16.14",
    maintenanceReason: "远端备份测试",
  };
  return { directory, options, source, target };
}

test("远端 key、专用配置和 namespace 隔离均 fail closed", () => {
  assert.throws(() => assertSafeRemoteBackupId("../other"), /路径穿越/);
  assert.throws(() => assertSafeRemoteBackupId("parent/child"), /目录分隔符/);
  assert.throws(
    () => assertSeparatedStorageNamespaces(
      { kind: "remote", provider: "s3-compatible", location: "http://s3/bucket/platform" },
      { kind: "remote", provider: "s3-compatible", location: "http://s3/bucket/platform/backups" },
    ),
    /互不包含/,
  );
  assert.throws(() => parseS3Options({}, "XIQU_BACKUP_S3", true), /XIQU_BACKUP_S3_BUCKET/);
  assert.throws(() => parseS3Options({
    XIQU_BACKUP_S3_BUCKET: "Invalid_Bucket",
    XIQU_BACKUP_S3_REGION: "us-east-1",
    XIQU_BACKUP_S3_ACCESS_KEY_ID: "key",
    XIQU_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
    XIQU_BACKUP_S3_PREFIX: "remote-backups",
  }, "XIQU_BACKUP_S3", true), /XIQU_BACKUP_S3_BUCKET/);
  const parsed = parseS3Options({
    XIQU_BACKUP_S3_BUCKET: "backup-bucket",
    XIQU_BACKUP_S3_REGION: "us-east-1",
    XIQU_BACKUP_S3_ACCESS_KEY_ID: "key",
    XIQU_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
    XIQU_BACKUP_S3_PREFIX: "remote-backups",
  }, "XIQU_BACKUP_S3", true);
  assert.equal(parsed.prefix, "remote-backups");
});

test("远端包最后发布 manifest 并可逐项流式校验", async () => {
  const fixture = await createPublishedFixture();
  try {
    const result = await publishRemoteBackupPackage(fixture.options);
    assert.equal(result.manifest.warnings.length, 0);
    assert.equal(
      fixture.target.events.filter((event) => event.startsWith("promote:")).at(-1),
      `promote:${remoteBackupKeys.manifest(BACKUP_ID)}`,
    );
    const verification = await verifyRemoteBackup(fixture.target, BACKUP_ID);
    assert.equal(verification.valid, true);
    assert.deepEqual(verification.errors, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("远端校验汇总篡改和未声明对象", async () => {
  const fixture = await createPublishedFixture();
  try {
    await publishRemoteBackupPackage(fixture.options);
    fixture.target.objects.set(remoteBackupKeys.database(BACKUP_ID), Buffer.from("tampered"));
    fixture.target.objects.set(`${BACKUP_ID}/unexpected.bin`, Buffer.from("extra"));
    const verification = await verifyRemoteBackup(fixture.target, BACKUP_ID);
    assert.equal(verification.valid, false);
    assert.match(verification.errors.join("\n"), /未声明/);
    assert.match(verification.errors.join("\n"), /大小不一致|SHA-256 不一致/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manifest promote 形成 final 后失败仍清理全部已发布 payload", async () => {
  const fixture = await createPublishedFixture();
  try {
    fixture.target.failPromoteKey = remoteBackupKeys.manifest(BACKUP_ID);
    await assert.rejects(publishRemoteBackupPackage(fixture.options), /测试 promote/);
    const remainingPackageObjects = [...fixture.target.objects.keys()]
      .filter((key) => key.startsWith(`${BACKUP_ID}/`));
    assert.deepEqual(remainingPackageObjects, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("缺少 manifest 的 payload 永远不能被识别为有效备份", async () => {
  const target = new MemoryObjectStorage("memory/backups");
  target.objects.set(remoteBackupKeys.database(BACKUP_ID), Buffer.from("orphan-dump"));
  const verification = await verifyRemoteBackup(target, BACKUP_ID);
  assert.equal(verification.valid, false);
  assert.equal(verification.manifest, null);
});

test("远端 manifest 超过内存上限时在 JSON 解析前被拒绝", async () => {
  const target = new MemoryObjectStorage("memory/backups");
  target.objects.set(
    remoteBackupKeys.manifest(BACKUP_ID),
    Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
  );
  const verification = await verifyRemoteBackup(target, BACKUP_ID);
  assert.equal(verification.valid, false);
  assert.match(verification.errors.join("\n"), /超过允许大小/);
});

test("发布失败且补偿删除失败时聚合报告两类错误", async () => {
  const fixture = await createPublishedFixture();
  try {
    const manifestKey = remoteBackupKeys.manifest(BACKUP_ID);
    fixture.target.failPromoteKey = manifestKey;
    fixture.target.failDeleteKey = manifestKey;
    await assert.rejects(
      publishRemoteBackupPackage(fixture.options),
      (error: unknown) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match((error as Error).message, /部分已发布对象无法清理/);
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
