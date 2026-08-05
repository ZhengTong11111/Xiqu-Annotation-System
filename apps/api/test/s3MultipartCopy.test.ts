import assert from "node:assert/strict";
import test from "node:test";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  type S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { planS3MultipartCopyParts } from "../src/s3ObjectStorage.js";
import { S3ObjectStorage } from "../src/s3ObjectStorage.js";

const GIB = 1024 * 1024 * 1024;
const S3_MAX_OBJECT_BYTES = 5_000_000_000_000;
const TEST_OPTIONS = {
  region: "test-region",
  bucket: "test-bucket",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  forcePathStyle: true,
} as const;

// 大于单次 CopyObject 上限的常规媒体应被拆成连续闭区间，首尾不能丢失或重复字节。
test("S3 multipart copy 为 20 GiB 对象生成连续有界分片", () => {
  const size = 20 * GIB;
  const parts = planS3MultipartCopyParts(size);
  assert.equal(parts.length, 40);
  assert.deepEqual(parts[0], {
    partNumber: 1,
    start: 0,
    end: 512 * 1024 * 1024 - 1,
  });
  assert.equal(parts.at(-1)?.end, size - 1);
  for (let index = 1; index < parts.length; index += 1) {
    assert.equal(parts[index]!.start, parts[index - 1]!.end + 1);
    assert.equal(parts[index]!.partNumber, index + 1);
  }
});

// S3 最大对象仍必须落在 10,000 part 协议限制内，超过服务端对象上限则在开始复制前失败。
test("S3 multipart copy 在 5 TB 边界内规划并拒绝越界对象", () => {
  const maximum = planS3MultipartCopyParts(S3_MAX_OBJECT_BYTES);
  assert.ok(maximum.length <= 10_000);
  assert.equal(maximum[0]?.start, 0);
  assert.equal(maximum.at(-1)?.end, S3_MAX_OBJECT_BYTES - 1);
  assert.throws(() => planS3MultipartCopyParts(S3_MAX_OBJECT_BYTES + 1), /不能超过 5 TB/);
  assert.throws(() => planS3MultipartCopyParts(0), /正安全整数/);
});

// 命令级测试无需真的写入 5 GB 数据，但必须证明大对象不会退回有上限的单次 CopyObject。
test("S3 大对象发布完成 multipart copy 后才删除 staged", async () => {
  const commands: unknown[] = [];
  const client = createCommandClient(async (command) => {
    commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
    if (command instanceof UploadPartCopyCommand) {
      return { CopyPartResult: { ETag: `etag-${command.input.PartNumber}` } };
    }
    return {};
  });
  const storage = new S3ObjectStorage(TEST_OPTIONS, client);
  await storage.promoteStagedObject(createLargeStagedBinary());

  assert.equal(commands[0] instanceof CreateMultipartUploadCommand, true);
  assert.equal(commands.filter((command) => command instanceof UploadPartCopyCommand).length, 11);
  assert.equal(commands.some((command) => command instanceof CompleteMultipartUploadCommand), true);
  assert.equal(commands.at(-1) instanceof DeleteObjectCommand, true);
  assert.equal(commands.some((command) => command instanceof AbortMultipartUploadCommand), false);
});

// 复制失败必须中止 multipart session，并保留 staged 供上层统一补偿，不能假装发布成功。
test("S3 multipart copy 分片失败时 abort 且不删除 staged", async () => {
  const commands: unknown[] = [];
  const client = createCommandClient(async (command) => {
    commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-2" };
    if (command instanceof UploadPartCopyCommand && command.input.PartNumber === 2) {
      throw new Error("copy failed");
    }
    if (command instanceof UploadPartCopyCommand) {
      return { CopyPartResult: { ETag: `etag-${command.input.PartNumber}` } };
    }
    return {};
  });
  const storage = new S3ObjectStorage(TEST_OPTIONS, client);

  await assert.rejects(storage.promoteStagedObject(createLargeStagedBinary()), /copy failed/);
  assert.equal(commands.some((command) => command instanceof AbortMultipartUploadCommand), true);
  assert.equal(commands.some((command) => command instanceof CompleteMultipartUploadCommand), false);
  assert.equal(commands.some((command) => command instanceof DeleteObjectCommand), false);
});

function createLargeStagedBinary() {
  return {
    finalStorageKey: "media/final.mp4",
    stagedStorageKey: "media/final.mp4.upload-test",
    checksum: "checksum",
    size: 5 * GIB + 1,
    header: new Uint8Array(),
  };
}

// S3Client 的 send 是泛型重载；测试 sender 只实现当前命令所需结果，再在边界收窄为官方客户端类型。
function createCommandClient(
  send: (command: unknown) => Promise<Record<string, unknown>>,
) {
  return { send } as unknown as S3Client;
}
