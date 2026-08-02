import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  requireLocalSnapshotRoot,
  type ObjectStorage,
} from "../src/objectStorage.js";
import { createObjectStorageFromEnvironment } from "../src/objectStorageFactory.js";

// 默认值与显式 local 必须经过同一工厂路径，避免生产和运维命令使用不同装配逻辑。
test("对象存储工厂默认和显式 local 都返回规范本地描述", () => {
  const defaultStorage = createObjectStorageFromEnvironment({
    XIQU_STORAGE_ROOT: "./data/test-storage",
  });
  const explicitStorage = createObjectStorageFromEnvironment({
    XIQU_OBJECT_STORAGE_BACKEND: " local ",
    XIQU_STORAGE_ROOT: "./data/test-storage",
  });
  assert.equal(defaultStorage.describeBackend().kind, "local");
  assert.equal(explicitStorage.describeBackend().kind, "local");
  assert.match(requireLocalSnapshotRoot(defaultStorage), /data\/test-storage$/);
});

// 配置错误必须在启动阶段显式失败，不能把预期的远端写入静默落到本地磁盘。
test("对象存储工厂对空白和未知后端 fail closed", () => {
  assert.throws(
    () => createObjectStorageFromEnvironment({ XIQU_OBJECT_STORAGE_BACKEND: " " }),
    /<empty>/,
  );
  assert.throws(
    () => createObjectStorageFromEnvironment({ XIQU_OBJECT_STORAGE_BACKEND: "s3" }),
    /当前可用值只有 local/,
  );
});

// 本地备份能力通过判别描述收窄，远端适配器即使满足业务端口也不能暴露伪本地路径。
test("本地快照能力拒绝远端后端而不读取伪造路径", () => {
  // typed remote fixture 证明能力判断只依赖判别描述，不要求测试伪装 concrete local class。
  const remoteStorage = {
    describeBackend: () => ({ kind: "remote", provider: "test", location: "bucket" } as const),
    createStorageKey: () => "key",
    putStagedObject: async () => ({
      finalStorageKey: "key",
      stagedStorageKey: "staged",
      checksum: "0".repeat(64),
      size: 0,
      header: new Uint8Array(),
    }),
    promoteStagedObject: async () => undefined,
    getObjectStream: () => Readable.from([]),
    objectExists: async () => false,
    deleteObject: async () => undefined,
    checkReadiness: async () => undefined,
    listStoredObjects: async () => [],
  } satisfies ObjectStorage;
  assert.throws(() => requireLocalSnapshotRoot(remoteStorage), /只支持本地对象存储/);
});
