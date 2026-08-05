import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/errors.js";
import {
  detectAndValidateMedia,
  loadUploadPolicy,
  normalizeUploadName,
} from "../src/uploadPolicy.js";

// 最小 MP4 ftyp box 用于验证真实签名，而不是信任测试传入的 MIME 字符串。
function minimalMp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(4),
    Buffer.from("isomiso2"),
  ]);
}

test("上传策略接受明确覆盖，且单文件上限可超过 2 GiB", () => {
  assert.deepEqual(loadUploadPolicy({
    maxUploadBytes: 64,
    userQuotaBytes: 128,
    platformQuotaBytes: 256,
    orphanGraceMs: 1_000,
  }), {
    maxUploadBytes: 64,
    userQuotaBytes: 128,
    platformQuotaBytes: 256,
    orphanGraceMs: 1_000,
  });
  // size 列已迁移为 BigInt，单文件不再受 Int4 的 2 GiB 上限约束；
  // 5 GiB 的策略应当被接受。
  const large = loadUploadPolicy({
    maxUploadBytes: 5 * 1024 * 1024 * 1024,
    userQuotaBytes: 10 * 1024 * 1024 * 1024,
    platformQuotaBytes: 20 * 1024 * 1024 * 1024,
  });
  assert.equal(large.maxUploadBytes, 5 * 1024 * 1024 * 1024);
  // 用户配额大于平台配额仍被拒绝。
  assert.throws(
    () => loadUploadPolicy({
      maxUploadBytes: 64,
      userQuotaBytes: 256,
      platformQuotaBytes: 128,
    }),
    /用户存储配额不能大于平台存储配额。/,
  );
});

test("未显式设置时单文件上限默认等于用户配额", () => {
  // 默认不再 1 GiB：单文件不可能超过账号配额，故以配额为上限。清理环境变量确保默认路径生效。
  const saved = process.env.XIQU_MAX_UPLOAD_BYTES;
  delete process.env.XIQU_MAX_UPLOAD_BYTES;
  try {
    const policy = loadUploadPolicy({
      userQuotaBytes: 5 * 1024 * 1024 * 1024,
      platformQuotaBytes: 10 * 1024 * 1024 * 1024,
    });
    assert.equal(policy.maxUploadBytes, 5 * 1024 * 1024 * 1024);
  } finally {
    if (saved !== undefined) process.env.XIQU_MAX_UPLOAD_BYTES = saved;
  }
});

test("上传名称与媒体签名执行服务端校验", async () => {
  assert.equal(normalizeUploadName("  sample.mp4  "), "sample.mp4");
  assert.throws(() => normalizeUploadName("../sample.mp4"), HttpError);
  assert.deepEqual(await detectAndValidateMedia("sample.mp4", minimalMp4()), {
    extension: "mp4",
    mimeType: "video/mp4",
  });
  await assert.rejects(
    detectAndValidateMedia("sample.wav", minimalMp4()),
    (error: unknown) => error instanceof HttpError &&
      error.code === "unsupported_media",
  );
  await assert.rejects(
    detectAndValidateMedia("sample.mp4", Buffer.from("plain text")),
    (error: unknown) => error instanceof HttpError &&
      error.code === "unsupported_media",
  );
});
