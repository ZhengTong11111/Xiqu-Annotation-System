import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  LocalObjectStorage,
  StorageSizeLimitError,
} from "../src/storage.js";

test("本地对象存储以暂存、校验、原子发布完成上传", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-storage-test-"));
  const storage = new LocalObjectStorage(root);
  try {
    const finalStorageKey = storage.createStorageKey("mp4");
    const staged = await storage.putStagedObject(
      finalStorageKey,
      Readable.from(Buffer.from("123456")),
      6,
    );
    assert.equal(staged.size, 6);
    assert.equal((await storage.listStoredObjects())[0]?.staged, true);
    await storage.promoteStagedObject(staged);
    assert.equal(await storage.objectExists(finalStorageKey), true);
    assert.deepEqual(
      await readFile(path.join(root, finalStorageKey)),
      Buffer.from("123456"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("本地对象存储超限或越界时不留下半文件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-storage-test-"));
  const storage = new LocalObjectStorage(root);
  try {
    await assert.rejects(
      storage.putStagedObject(
        storage.createStorageKey("mp4"),
        Readable.from(Buffer.from("1234567")),
        6,
      ),
      StorageSizeLimitError,
    );
    assert.deepEqual(await storage.listStoredObjects(), []);
    await assert.rejects(storage.deleteObject("../outside"), /非法文件存储路径/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
