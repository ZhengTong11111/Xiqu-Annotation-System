import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { ResourceEntry } from "@xiqu/shared";
import type { ApiUser } from "../src/domain.js";
import { MediaUploadService } from "../src/mediaUploadService.js";
import type { ObjectStorage, StagedBinary } from "../src/objectStorage.js";
import { ApiObservability } from "../src/observability.js";
import type { ResourceService } from "../src/resourceService.js";

const USER: ApiUser = {
  id: "user-upload-test",
  accountName: "upload_test",
  displayName: "上传测试账号",
  roles: ["annotator"],
};

const POLICY = {
  maxUploadBytes: 1_024,
  userQuotaBytes: 2_048,
  platformQuotaBytes: 4_096,
  orphanGraceMs: 1_000,
};

// 最小 ftyp box 让测试经过真实媒体签名检测，而不是绕过上传校验阶段。
function minimalMp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(4),
    Buffer.from("isomiso2"),
  ]);
}

type UploadFixtureOptions = {
  publishError?: Error;
  commitError?: Error;
  dtoError?: Error;
  cleanupFailureStage?: "final" | "staged";
};

function createUploadFixture(options: UploadFixtureOptions = {}) {
  const bytes = minimalMp4();
  const finalStorageKey = "test/final.mp4";
  const stagedStorageKey = "test/final.mp4.upload-test";
  const objects = new Set<string>();
  const deleteCalls: string[] = [];
  const loggerErrors: Array<{ error: unknown; message: string }> = [];
  const observability = new ApiObservability();
  const staged: StagedBinary = {
    finalStorageKey,
    stagedStorageKey,
    checksum: "test-checksum",
    size: bytes.length,
    header: bytes,
  };

  const storage = {
    createStorageKey: () => finalStorageKey,
    putStagedObject: async () => {
      objects.add(stagedStorageKey);
      return staged;
    },
    promoteStagedObject: async () => {
      // 先形成 final 再抛错，模拟 S3 CopyObject 成功、响应或 staged 删除失败的歧义状态。
      objects.add(finalStorageKey);
      if (options.publishError) throw options.publishError;
      objects.delete(stagedStorageKey);
    },
    deleteObject: async (storageKey: string) => {
      deleteCalls.push(storageKey);
      const stage = storageKey === finalStorageKey ? "final" : "staged";
      if (options.cleanupFailureStage === stage) {
        throw new Error(`测试 ${stage} 补偿失败`);
      }
      objects.delete(storageKey);
    },
  } satisfies Pick<
    ObjectStorage,
    "createStorageKey" | "putStagedObject" | "promoteStagedObject" | "deleteObject"
  >;
  const resources = {
    prepareMediaUpload: async () => undefined,
    commitUploadedMedia: async () => {
      if (options.commitError) throw options.commitError;
      return "resource-upload-test";
    },
    getResource: async () => {
      if (options.dtoError) throw options.dtoError;
      return { id: "resource-upload-test" } as ResourceEntry;
    },
  } as unknown as ResourceService;
  const service = new MediaUploadService(resources, storage, POLICY, observability);
  const logger = {
    error(error: unknown, message: string) {
      loggerErrors.push({ error, message });
    },
  };
  const upload = () => service.upload(USER, {
    parentId: "project-upload-test",
    name: "test.mp4",
    stream: Readable.from([bytes]),
    wasTruncated: () => false,
  }, logger);

  return {
    upload,
    objects,
    deleteCalls,
    loggerErrors,
    observability,
    finalStorageKey,
    stagedStorageKey,
  };
}

test("发布结果不确定时同时补偿 final 与 staged 并保留原错误", async () => {
  const publishError = new Error("测试发布结果不确定");
  const fixture = createUploadFixture({ publishError });

  await assert.rejects(fixture.upload(), (error) => error === publishError);
  assert.deepEqual(
    fixture.deleteCalls,
    [fixture.finalStorageKey, fixture.stagedStorageKey],
  );
  assert.deepEqual([...fixture.objects], []);
  assert.deepEqual(fixture.loggerErrors, []);
});

test("数据库提交失败时删除全部未提交对象", async () => {
  const commitError = new Error("测试数据库提交失败");
  const fixture = createUploadFixture({ commitError });

  await assert.rejects(fixture.upload(), (error) => error === commitError);
  assert.deepEqual(
    fixture.deleteCalls,
    [fixture.finalStorageKey, fixture.stagedStorageKey],
  );
  assert.deepEqual([...fixture.objects], []);
});

test("补偿失败不会覆盖业务根因并记录固定阶段", async () => {
  const publishError = new Error("测试发布失败主错误");
  const fixture = createUploadFixture({
    publishError,
    cleanupFailureStage: "final",
  });

  await assert.rejects(fixture.upload(), (error) => error === publishError);
  assert.equal(fixture.objects.has(fixture.finalStorageKey), true);
  assert.equal(fixture.objects.has(fixture.stagedStorageKey), false);
  assert.equal(fixture.loggerErrors.length, 1);
  assert.equal(fixture.loggerErrors[0]?.message.includes("最终对象"), true);
  const metrics = await fixture.observability.registry.metrics();
  assert.match(metrics, /compensation_failures_total\{stage="final"\} 1/);
});

test("数据库已提交后 DTO 失败不删除权威对象或重复记失败", async () => {
  const dtoError = new Error("测试 DTO 读取失败");
  const fixture = createUploadFixture({ dtoError });

  await assert.rejects(fixture.upload(), (error) => error === dtoError);
  assert.equal(fixture.objects.has(fixture.finalStorageKey), true);
  assert.deepEqual(fixture.deleteCalls, []);
  const metrics = await fixture.observability.registry.metrics();
  assert.match(metrics, /xiqu_media_uploads_total\{result="success"\} 1/);
  assert.doesNotMatch(metrics, /xiqu_media_uploads_total\{result="internal"\} 1/);
});
