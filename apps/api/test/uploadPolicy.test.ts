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

test("上传策略接受明确覆盖并拒绝超出 Int 存储边界", () => {
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
  assert.throws(() => loadUploadPolicy({
    maxUploadBytes: 2_000_000_001,
    userQuotaBytes: 3_000_000_000,
    platformQuotaBytes: 4_000_000_000,
  }), /BigInt/);
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
