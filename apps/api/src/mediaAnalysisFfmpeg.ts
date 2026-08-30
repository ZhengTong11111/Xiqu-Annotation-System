import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MEDIA_ANALYSIS_SAMPLE_RATE = 16_000;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export type MediaAnalysisFfmpegInput =
  | { kind: "uploaded"; stream: Readable }
  | { kind: "vod"; url: string };

export type MediaAnalysisFfmpegResult = {
  sampleCount: number;
  stderrExcerpt: string;
};

export class MediaAnalysisFfmpegError extends Error {
  constructor(
    readonly code: "tool_unavailable" | "decode_failed" | "aborted" | "input_failed",
  ) {
    super(`Media analysis FFmpeg failed: ${code}`);
  }
}

type SpawnFfmpeg = (
  executable: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

/**
 * FFmpeg 只输出 16 kHz 单声道 f32le；上传对象从 stdin 流入，VOD 临时 URL 仅进入子进程 argv。
 * argv、URL 和 stderr 均不会进入异常 message，调用方只能记录稳定错误码。
 */
export async function streamMediaAnalysisPcm(
  input: MediaAnalysisFfmpegInput,
  onSamples: (samples: Float32Array) => Promise<void>,
  options: {
    ffmpegPath?: string;
    signal?: AbortSignal;
    spawnFfmpeg?: SpawnFfmpeg;
    terminationGraceMs?: number;
  } = {},
): Promise<MediaAnalysisFfmpegResult> {
  if (options.signal?.aborted) {
    throw new MediaAnalysisFfmpegError("aborted");
  }
  const ffmpegPath = options.ffmpegPath?.trim() || "ffmpeg";
  const args = buildMediaAnalysisFfmpegArgs(input);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnFfmpeg ?? defaultSpawnFfmpeg)(ffmpegPath, args);
  } catch {
    throw new MediaAnalysisFfmpegError("tool_unavailable");
  }

  let spawnError = false;
  let aborted = false;
  let childClosed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  const clearForceKillTimer = () => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
  };
  child.once("close", () => {
    childClosed = true;
    clearForceKillTimer();
  });
  const terminate = () => {
    if (childClosed || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (forceKillTimer) return;
    const graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (!childClosed && child.exitCode === null && child.signalCode === null) {
        // 第三方解码器若忽略 SIGTERM，必须升级为 SIGKILL，避免一个任务永久占住串行 worker。
        child.kill("SIGKILL");
      }
    }, graceMs);
    forceKillTimer.unref();
  };
  const abort = () => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  // signal 可能在 spawn 与监听注册之间切换为 aborted，注册后再次检查以关闭这条竞态窗口。
  if (options.signal?.aborted) abort();
  child.once("error", () => {
    spawnError = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return;
    const bounded = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
    stderrChunks.push(bounded);
    stderrBytes += bounded.byteLength;
  });

  let inputFailure: MediaAnalysisFfmpegError | null = null;
  // 输入失败保存为已消费的结果值；主 stdout 路径先结束时不会留下迟到的 rejected Promise。
  const inputPromise = input.kind === "uploaded"
    ? pipeline(input.stream, child.stdin).catch(() => {
        inputFailure = new MediaAnalysisFfmpegError("input_failed");
        terminate();
      })
    : Promise.resolve(child.stdin.end());

  let sampleCount = 0;
  let carry = Buffer.alloc(0);
  try {
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const completeBytes = bytes.length - (bytes.length % 4);
      carry = bytes.subarray(completeBytes);
      if (completeBytes === 0) continue;
      const samples = decodeFloat32Le(bytes.subarray(0, completeBytes));
      sampleCount += samples.length;
      await onSamples(samples);
    }
    await inputPromise;
    const exitCode = await waitForChildClose(child);
    if (aborted || options.signal?.aborted) {
      throw new MediaAnalysisFfmpegError("aborted");
    }
    if (spawnError) throw new MediaAnalysisFfmpegError("tool_unavailable");
    if (inputFailure) throw inputFailure;
    if (exitCode !== 0 || carry.length !== 0) {
      throw new MediaAnalysisFfmpegError("decode_failed");
    }
    return {
      sampleCount,
      // 该摘要只供 worker 内部诊断；API、审计和普通日志不得输出它。
      stderrExcerpt: Buffer.concat(stderrChunks).toString("utf8"),
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!childClosed && child.exitCode === null && child.signalCode === null) terminate();
    // 回调异常也必须等输入流和 child 有界收口，不能把句柄或 rejection 留给下一任务。
    await inputPromise;
    if (!childClosed) await waitForChildClose(child);
    clearForceKillTimer();
  }
}

export function buildMediaAnalysisFfmpegArgs(input: MediaAnalysisFfmpegInput) {
  const source = input.kind === "uploaded" ? "pipe:0" : input.url;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    source,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(MEDIA_ANALYSIS_SAMPLE_RATE),
    "-f",
    "f32le",
    "pipe:1",
  ];
}

function defaultSpawnFfmpeg(executable: string, args: string[]) {
  return spawn(executable, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function decodeFloat32Le(bytes: Buffer) {
  const output = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = bytes.readFloatLE(index * 4);
  }
  return output;
}

function waitForChildClose(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
}
