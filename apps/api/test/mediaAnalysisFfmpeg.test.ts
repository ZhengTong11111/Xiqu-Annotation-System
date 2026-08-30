import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildMediaAnalysisFfmpegArgs,
  streamMediaAnalysisPcm,
} from "../src/mediaAnalysisFfmpeg.js";

test("FFmpeg 参数不经过 shell 且 VOD 临时 URL 保持单一 argv", () => {
  const url = "https://vod.example.test/audio.mp3?auth=a&value=b c";
  const args = buildMediaAnalysisFfmpegArgs({ kind: "vod", url });
  assert.equal(args[args.indexOf("-i") + 1], url);
  assert.deepEqual(args.slice(-8), ["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]);
});

test("FFmpeg 从上传对象流增量输出 16 kHz 单声道 PCM", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const chunks: Float32Array[] = [];
  const result = await streamMediaAnalysisPcm(
    { kind: "uploaded", stream: Readable.from([buildWav(8_000, 0.1, 220)]) },
    async (samples) => { chunks.push(samples); },
    { ffmpegPath },
  );
  assert.ok(result.sampleCount >= 1_590 && result.sampleCount <= 1_610);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), result.sampleCount);
  assert.ok(chunks.some((chunk) => chunk.some((value) => Math.abs(value) > 0.05)));
});

test("上传对象流中断会稳定收口为 input_failed", async () => {
  const source = new Readable({
    read() {
      this.destroy(new Error("测试输入流中断"));
    },
  });
  await assert.rejects(
    () => streamMediaAnalysisPcm(
      { kind: "uploaded", stream: source },
      async () => undefined,
      {
        spawnFfmpeg: () => spawnNodeChild(`
          process.stdin.resume();
          setInterval(() => undefined, 1_000);
        `),
        terminationGraceMs: 20,
      },
    ),
    (error) => error instanceof Error && "code" in error && error.code === "input_failed",
  );
});

test("FFmpeg 忽略 SIGTERM 时会升级 SIGKILL 并按 aborted 收口", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const processing = streamMediaAnalysisPcm(
    { kind: "vod", url: "https://vod.example.test/never-used.mp3" },
    async () => undefined,
    {
      signal: controller.signal,
      spawnFfmpeg: () => spawnNodeChild(`
        process.on("SIGTERM", () => undefined);
        process.stdout.write(Buffer.alloc(4));
        setInterval(() => undefined, 1_000);
      `),
      terminationGraceMs: 20,
    },
  );
  // 等子进程安装 SIGTERM handler，确保测试真正经过强制终止分支。
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await assert.rejects(
    processing,
    (error) => error instanceof Error && "code" in error && error.code === "aborted",
  );
  assert.ok(Date.now() - startedAt < 1_000, "忽略 SIGTERM 的子进程必须有界退出");
});

function spawnNodeChild(source: string) {
  return spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

function buildWav(sampleRate: number, duration: number, frequency: number) {
  const sampleCount = Math.round(sampleRate * duration);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    buffer.writeInt16LE(Math.round(value * 16_000), 44 + index * 2);
  }
  return buffer;
}
