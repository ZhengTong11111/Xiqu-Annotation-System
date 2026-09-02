import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import {
  AlignmentTrainingAudioFfmpegError,
  buildAlignmentTrainingFfmpegArgs,
  openAlignmentTrainingFlacStream,
} from "../src/alignmentTrainingAudioFfmpeg.js";

test("训练音频 FFmpeg 参数固定为 16k 单声道 s16 FLAC 且只接受安全 HTTPS VOD", () => {
  const uploaded = buildAlignmentTrainingFfmpegArgs({
    kind: "uploaded",
    stream: Readable.from([]),
  });
  assert.equal(uploaded.at(-1), "pipe:1");
  assert.equal(uploaded[uploaded.indexOf("-i") + 1], "pipe:0");
  assert.deepEqual(uploaded.slice(-10), [
    "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-c:a", "flac", "-f", "flac", "pipe:1",
  ].slice(-10));
  const vod = buildAlignmentTrainingFfmpegArgs({
    kind: "vod",
    url: "https://vod.example.test/audio.mp3?token=temporary",
  });
  assert.equal(vod[vod.indexOf("-i") + 1], "https://vod.example.test/audio.mp3?token=temporary");
  assert.throws(
    () => buildAlignmentTrainingFfmpegArgs({ kind: "vod", url: "http://example.test/audio.mp3" }),
    (error: unknown) => error instanceof AlignmentTrainingAudioFfmpegError &&
      error.code === "audio_input_failed",
  );
});

test("训练音频 stdout 增量返回且上传输入不需要整文件 Buffer", async () => {
  const output = await openAlignmentTrainingFlacStream({
    kind: "uploaded",
    stream: Readable.from([Buffer.from("first"), Buffer.from("-second")]),
  }, {
    signal: new AbortController().signal,
    // 测试子进程只回显 stdin；业务 argv 已由独立纯函数断言，不依赖宿主 FFmpeg。
    spawnFfmpeg: () => spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  assert.equal((await readStream(output)).toString("utf8"), "first-second");
});

test("训练音频取消会终止子进程并以有限 code 关闭输出", async () => {
  const controller = new AbortController();
  const output = await openAlignmentTrainingFlacStream({
    kind: "vod",
    url: "https://vod.example.test/audio.mp3",
  }, {
    signal: controller.signal,
    terminationGraceMs: 20,
    spawnFfmpeg: () => spawn(process.execPath, [
      "-e",
      "process.stdin.resume(); setInterval(() => {}, 1000)",
    ], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  controller.abort();
  await assert.rejects(
    readStream(output),
    (error: unknown) => error instanceof AlignmentTrainingAudioFfmpegError &&
      error.code === "audio_aborted",
  );
});

async function readStream(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
