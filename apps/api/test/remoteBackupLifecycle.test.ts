import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { StoredObjectSummary } from "../src/objectStorage.js";
import { serializeBackupManifest } from "../src/backup/backupManifest.js";
import { RemoteBackupLifecycleService } from "../src/backup/remoteBackupLifecycle.js";
import { remoteBackupKeys } from "../src/backup/remoteBackupPaths.js";
import {
  resolveRemoteBackupRetentionPolicy,
  type RemoteBackupRetentionPolicy,
} from "../src/backup/remoteBackupRetentionPolicy.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const POLICY: RemoteBackupRetentionPolicy = {
  incompleteGraceMs: 24 * 60 * 60 * 1_000,
  retentionDays: 30,
  minimumRetained: 1,
};
const OLD_ID = "xiqu-backup-2026-05-01T00-00-00-000Z-11111111";
const NEW_ID = "xiqu-backup-2026-08-01T00-00-00-000Z-22222222";
const INCOMPLETE_ID = "xiqu-backup-2026-04-01T00-00-00-000Z-33333333";
const FRESH_INCOMPLETE_ID = "xiqu-backup-2026-08-03T11-30-00-000Z-44444444";

// 生命周期内存存储保留对象修改时间和删除事件，测试不会把 list 顺序或参数伪装成业务结论。
class LifecycleMemoryStorage {
  readonly objects = new Map<string, { content: Buffer; modifiedAt: Date }>();
  readonly deleteEvents: string[] = [];
  failDeleteKey: string | null = null;

  async getObjectStream(storageKey: string) {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error(`对象不存在：${storageKey}`);
    return Readable.from([object.content]);
  }

  async listStoredObjects(): Promise<StoredObjectSummary[]> {
    return [...this.objects].map(([storageKey, object]) => ({
      storageKey,
      size: object.content.length,
      modifiedAt: object.modifiedAt,
      staged: storageKey.includes(".upload-"),
    }));
  }

  async deleteObject(storageKey: string) {
    this.deleteEvents.push(storageKey);
    if (storageKey === this.failDeleteKey) throw new Error("测试删除失败");
    this.objects.delete(storageKey);
  }

  put(storageKey: string, content: Buffer | string, modifiedAt: Date) {
    this.objects.set(storageKey, {
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      modifiedAt,
    });
  }
}

// 完整包夹具生成通过运行时 manifest 校验的最小 custom-dump 摘要，便于专注生命周期分类。
function putCompleteBackup(
  storage: LifecycleMemoryStorage,
  backupId: string,
  createdAt: string,
  modifiedAt = new Date(createdAt),
) {
  const dump = Buffer.from(`dump:${backupId}`);
  storage.put(remoteBackupKeys.database(backupId), dump, modifiedAt);
  storage.put(remoteBackupKeys.manifest(backupId), serializeBackupManifest({
    format: "xiqu-platform-backup",
    version: 1,
    createdAt,
    operator: { accountName: "admin", userId: "admin-id" },
    maintenanceReason: "生命周期测试",
    database: {
      identity: {
        host: "localhost",
        port: 54329,
        database: "xiqu_platform",
        schema: "public",
      },
      postgresToolVersion: "pg_dump (PostgreSQL) 16.14",
      dump: {
        relativePath: "database.dump",
        size: dump.length,
        sha256: createHash("sha256").update(dump).digest("hex"),
      },
      summary: {
        resourceCount: 0,
        annotationFileCount: 0,
        mediaFileCount: 0,
        fileObjectCount: 0,
        fileObjects: [],
      },
    },
    objects: { count: 0, totalBytes: 0, entries: [] },
    warnings: [],
  }), modifiedAt);
}

test("保留计划区分完整、未完成、坏包和未知对象", async () => {
  const storage = new LifecycleMemoryStorage();
  putCompleteBackup(storage, OLD_ID, "2026-05-01T00:00:00.000Z");
  putCompleteBackup(storage, NEW_ID, "2026-08-01T00:00:00.000Z");
  storage.put(remoteBackupKeys.database(INCOMPLETE_ID), "old-partial", new Date("2026-07-01"));
  storage.put(
    remoteBackupKeys.database(FRESH_INCOMPLETE_ID),
    "fresh-partial",
    new Date("2026-08-03T11:30:00Z"),
  );
  const invalidId = "xiqu-backup-2026-03-01T00-00-00-000Z-55555555";
  storage.put(remoteBackupKeys.manifest(invalidId), "not-json", new Date("2026-03-01"));
  storage.put("notes/readme.txt", "foreign", new Date("2026-01-01"));
  storage.put(OLD_ID, "root-object-is-not-a-package", new Date("2026-01-01"));

  const report = await new RemoteBackupLifecycleService(storage).inspect(POLICY, NOW);
  const byId = new Map(report.packages.map((item) => [item.backupId, item]));
  assert.equal(byId.get(OLD_ID)?.cleanupEligible, true);
  assert.match(byId.get(NEW_ID)?.reason ?? "", /最新 1 个/);
  assert.equal(byId.get(INCOMPLETE_ID)?.cleanupEligible, true);
  assert.equal(byId.get(FRESH_INCOMPLETE_ID)?.cleanupEligible, false);
  assert.equal(byId.get(invalidId)?.status, "invalid_manifest");
  assert.equal(report.unrecognized.objectCount, 2);
  assert.equal(report.eligible.packageCount, 2);
});

test("manifest 集合不一致只报告而不进入清理", async () => {
  const storage = new LifecycleMemoryStorage();
  putCompleteBackup(storage, OLD_ID, "2026-05-01T00:00:00.000Z");
  storage.put(`${OLD_ID}/unexpected.bin`, "extra", new Date("2026-05-01"));
  const report = await new RemoteBackupLifecycleService(storage).inspect(POLICY, NOW);
  assert.equal(report.packages[0]?.status, "inconsistent");
  assert.equal(report.packages[0]?.cleanupEligible, false);

  // 即使 key 集合相同，payload 列表大小与 manifest 不符也不能进入自动保留删除。
  storage.objects.delete(`${OLD_ID}/unexpected.bin`);
  storage.put(remoteBackupKeys.database(OLD_ID), "different-length", new Date("2026-05-01"));
  const sizeMismatch = await new RemoteBackupLifecycleService(storage).inspect(POLICY, NOW);
  assert.equal(sizeMismatch.packages[0]?.status, "inconsistent");
});

test("计划 token 对同状态稳定并拒绝过期清理", async () => {
  const storage = new LifecycleMemoryStorage();
  putCompleteBackup(storage, OLD_ID, "2026-05-01T00:00:00.000Z");
  putCompleteBackup(storage, NEW_ID, "2026-08-01T00:00:00.000Z");
  const lifecycle = new RemoteBackupLifecycleService(storage);
  const first = await lifecycle.inspect(POLICY, NOW);
  const second = await lifecycle.inspect(POLICY, new Date(NOW.getTime() + 1_000));
  assert.equal(first.planToken, second.planToken);

  storage.put("notes/state-changed.txt", "changed", NOW);
  const changed = await lifecycle.inspect(POLICY, NOW);
  assert.notEqual(changed.planToken, first.planToken);
  await assert.rejects(
    lifecycle.cleanup(POLICY, first.planToken, true, NOW),
    /状态或保留策略已变化/,
  );
  assert.deepEqual(storage.deleteEvents, []);
});

test("确认清理先撤销完整包 manifest 并独立删除未完成包", async () => {
  const storage = new LifecycleMemoryStorage();
  putCompleteBackup(storage, OLD_ID, "2026-05-01T00:00:00.000Z");
  putCompleteBackup(storage, NEW_ID, "2026-08-01T00:00:00.000Z");
  storage.put(remoteBackupKeys.database(INCOMPLETE_ID), "old-partial", new Date("2026-07-01"));
  const lifecycle = new RemoteBackupLifecycleService(storage);
  const report = await lifecycle.inspect(POLICY, NOW);
  await assert.rejects(lifecycle.cleanup(POLICY, report.planToken, false, NOW), /显式确认/);
  const result = await lifecycle.cleanup(POLICY, report.planToken, true, NOW);
  assert.equal(result.deletedPackageCount, 2);
  assert.equal(result.failedPackageCount, 0);
  assert.equal(storage.objects.has(remoteBackupKeys.manifest(NEW_ID)), true);
  assert.ok(
    storage.deleteEvents.indexOf(remoteBackupKeys.manifest(OLD_ID)) <
      storage.deleteEvents.indexOf(remoteBackupKeys.database(OLD_ID)),
  );
  assert.equal(storage.objects.has(remoteBackupKeys.database(OLD_ID)), false);
  assert.equal(storage.objects.has(remoteBackupKeys.database(INCOMPLETE_ID)), false);
});

test("完整包 manifest 删除失败时不触碰 payload", async () => {
  const storage = new LifecycleMemoryStorage();
  putCompleteBackup(storage, OLD_ID, "2026-05-01T00:00:00.000Z");
  putCompleteBackup(storage, NEW_ID, "2026-08-01T00:00:00.000Z");
  storage.put(remoteBackupKeys.database(INCOMPLETE_ID), "old-partial", new Date("2026-07-01"));
  storage.failDeleteKey = remoteBackupKeys.manifest(OLD_ID);
  const lifecycle = new RemoteBackupLifecycleService(storage);
  const report = await lifecycle.inspect(POLICY, NOW);
  const result = await lifecycle.cleanup(POLICY, report.planToken, true, NOW);
  assert.equal(result.failedPackageCount, 1);
  assert.equal(result.deletedPackageCount, 1);
  assert.equal(storage.objects.has(remoteBackupKeys.database(INCOMPLETE_ID)), false);
  assert.equal(
    storage.deleteEvents.filter((key) => key.startsWith(`${OLD_ID}/`)).length,
    1,
  );
  assert.equal(storage.objects.has(remoteBackupKeys.database(OLD_ID)), true);
});

test("远端保留策略统一拒绝危险环境与 CLI 覆盖", () => {
  assert.deepEqual(resolveRemoteBackupRetentionPolicy({}, {
    incompleteGraceMs: "60000",
    retentionDays: "7",
    minimumRetained: "2",
  }), { incompleteGraceMs: 60_000, retentionDays: 7, minimumRetained: 2 });
  assert.throws(
    () => resolveRemoteBackupRetentionPolicy({ XIQU_REMOTE_BACKUP_RETENTION_DAYS: "0" }),
    /必须在/,
  );
  assert.throws(
    () => resolveRemoteBackupRetentionPolicy({}, { minimumRetained: "1.5" }),
    /必须是整数/,
  );
});
