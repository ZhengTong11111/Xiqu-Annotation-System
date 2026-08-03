import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  ObjectReadRange,
  ObjectStorage,
  StagedBinary,
  StoredObjectSummary,
} from "../src/objectStorage.js";
import { checkRemoteStorageCapabilities } from "../src/backup/remoteStorageCapabilityCheck.js";

// 内存替身精确实现对象端口语义，并记录调用顺序供事务式能力检查断言。
class CapabilityStorageStub implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  failRead = false;
  failDelete = false;

  describeBackend() {
    return {
      kind: "remote" as const,
      provider: "test-s3",
      location: "https://storage.example/xiqu-backups/protected-prefix",
    };
  }

  createStorageKey(extension: string) {
    return `unused.${extension}`;
  }

  async putStagedObject(finalStorageKey: string, stream: Readable): Promise<StagedBinary> {
    this.calls.push("put");
    const content = await readAll(stream);
    const stagedStorageKey = `${finalStorageKey}.upload-test`;
    this.objects.set(stagedStorageKey, content);
    return {
      finalStorageKey,
      stagedStorageKey,
      checksum: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      header: content,
    };
  }

  async promoteStagedObject(staged: StagedBinary) {
    this.calls.push("promote");
    const content = this.objects.get(staged.stagedStorageKey);
    if (!content) throw new Error("missing staged");
    this.objects.set(staged.finalStorageKey, content);
    this.objects.delete(staged.stagedStorageKey);
  }

  async getObjectStream(storageKey: string, range?: ObjectReadRange) {
    this.calls.push(range ? "get-range" : "get-full");
    if (this.failRead) throw new Error("injected read failure");
    const content = this.objects.get(storageKey);
    if (!content) throw new Error("missing object");
    return Readable.from([
      range ? content.subarray(range.start, range.end + 1) : content,
    ]);
  }

  async objectExists(storageKey: string) {
    this.calls.push("head");
    return this.objects.has(storageKey);
  }

  async deleteObject(storageKey: string) {
    this.calls.push("delete");
    if (this.failDelete) throw new Error("injected delete failure");
    this.objects.delete(storageKey);
  }

  async checkReadiness() {
    this.calls.push("readiness");
  }

  async listStoredObjects(): Promise<StoredObjectSummary[]> {
    this.calls.push("list");
    return [...this.objects.entries()].map(([storageKey, content]) => ({
      storageKey,
      size: content.length,
      modifiedAt: new Date("2026-08-03T00:00:00.000Z"),
      staged: storageKey.includes(".upload-"),
    }));
  }
}

// 成功路径必须覆盖全部能力、生成脱敏报告，并在返回前清空探针对象。
test("远端能力检查覆盖完整协议且不留探针对象", async () => {
  const storage = new CapabilityStorageStub();
  const times = [
    new Date("2026-08-03T01:00:00.000Z"),
    new Date("2026-08-03T01:00:01.000Z"),
  ];
  const report = await checkRemoteStorageCapabilities(storage, () => times.shift()!);
  assert.equal(report.passed, true);
  assert.equal(report.cleaned, true);
  assert.equal(report.checks.length, 8);
  assert.equal(storage.objects.size, 0);
  assert.deepEqual(storage.calls.slice(0, 4), ["readiness", "put", "head", "list"]);
  assert.equal(storage.calls.includes("get-full"), true);
  assert.equal(storage.calls.includes("get-range"), true);
  assert.equal(JSON.stringify(report).includes("secret"), false);
});

// 业务读取失败后仍执行两个幂等删除，原始错误不能被补偿阶段吞掉。
test("远端能力检查失败后仍清理 staged 和 final", async () => {
  const storage = new CapabilityStorageStub();
  storage.failRead = true;
  await assert.rejects(
    checkRemoteStorageCapabilities(storage),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(
        ((error as AggregateError).errors[0] as Error).message,
        /injected read failure/,
      );
      return true;
    },
  );
  assert.equal(storage.objects.size, 0);
  assert.equal(storage.calls.filter((call) => call === "delete").length, 2);
});

// 补偿也失败时 AggregateError 同时保留业务与清理原因，便于运维确定是否需要人工排残留。
test("远端能力检查同时报告业务故障和清理故障", async () => {
  const storage = new CapabilityStorageStub();
  storage.failRead = true;
  storage.failDelete = true;
  await assert.rejects(
    checkRemoteStorageCapabilities(storage),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const messages = (error as AggregateError).errors.map((item) => String(item));
      assert.equal(messages.some((message) => message.includes("injected read failure")), true);
      assert.equal(messages.filter((message) => message.includes("清理验收探针对象失败")).length, 2);
      return true;
    },
  );
});

// 测试替身只读取本轮的小型流，不引入额外缓冲或外部 helper。
async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
