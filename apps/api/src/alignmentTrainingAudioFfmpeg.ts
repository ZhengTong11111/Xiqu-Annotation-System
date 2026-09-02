import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export type AlignmentTrainingAudioInput =
  | { kind: "uploaded"; stream: Readable }
  | { kind: "vod"; url: string };

export type AlignmentTrainingAudioNormalizer = (
  input: AlignmentTrainingAudioInput,
  signal: AbortSignal,
) => Promise<Readable>;

export type AlignmentTrainingAudioFfmpegErrorCode =
  | "audio_aborted"
  | "audio_tool_unavailable"
  | "audio_input_failed"
  | "audio_transcode_failed";

export class AlignmentTrainingAudioFfmpegError extends Error {
  constructor(readonly code: AlignmentTrainingAudioFfmpegErrorCode) {
    super(code);
  }
}

type SpawnFfmpeg = (
  executable: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

/**
 * 启动增量 FLAC 转码并立即返回 stdout。临时 VOD URL 只进入 argv；异常只携带固定 code，
 * 调用方销毁输出或 AbortSignal 触发时都会终止子进程和上传输入流。
 */
export async function openAlignmentTrainingFlacStream(
  input: AlignmentTrainingAudioInput,
  options: {
    signal: AbortSignal;
    ffmpegPath?: string;
    spawnFfmpeg?: SpawnFfmpeg;
    terminationGraceMs?: number;
  },
): Promise<Readable> {
  if (options.signal.aborted) throw new AlignmentTrainingAudioFfmpegError("audio_aborted");
  const args = buildAlignmentTrainingFfmpegArgs(input);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnFfmpeg ?? defaultSpawnFfmpeg)(
      options.ffmpegPath?.trim() || "ffmpeg",
      args,
    );
  } catch {
    throw new AlignmentTrainingAudioFfmpegError("audio_tool_unavailable");
  }

  const output = new PassThrough();
  let settled = false;
  let aborted = false;
  let spawnFailed = false;
  let inputFailed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };
  const abort = () => {
    aborted = true;
    input.kind === "uploaded" && input.stream.destroy();
    terminate();
  };
  const cleanup = () => {
    options.signal.removeEventListener("abort", abort);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
  };

  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  child.once("error", () => {
    spawnFailed = true;
  });
  // stderr 只需持续排空以免子进程阻塞；内容不得进入错误、日志或数据库。
  child.stderr.resume();
  child.stdout.pipe(output, { end: false });

  const inputPromise = input.kind === "uploaded"
    ? pipeline(input.stream, child.stdin).catch(() => {
        inputFailed = true;
        terminate();
      })
    : Promise.resolve(child.stdin.end());

  child.once("close", (code) => {
    void inputPromise.then(() => {
      settled = true;
      cleanup();
      if (aborted || options.signal.aborted) {
        output.destroy(new AlignmentTrainingAudioFfmpegError("audio_aborted"));
      } else if (spawnFailed) {
        output.destroy(new AlignmentTrainingAudioFfmpegError("audio_tool_unavailable"));
      } else if (inputFailed) {
        output.destroy(new AlignmentTrainingAudioFfmpegError("audio_input_failed"));
      } else if (code !== 0) {
        output.destroy(new AlignmentTrainingAudioFfmpegError("audio_transcode_failed"));
      } else {
        output.end();
      }
    });
  });
  output.once("close", () => {
    if (settled) return;
    input.kind === "uploaded" && input.stream.destroy();
    terminate();
  });
  return output;
}

/** FFmpeg 参数是固定协议；VOD 只接受无内嵌凭据的 HTTPS 临时地址。 */
export function buildAlignmentTrainingFfmpegArgs(input: AlignmentTrainingAudioInput) {
  const source = input.kind === "uploaded" ? "pipe:0" : requireSafeHttpsUrl(input.url);
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
    "16000",
    "-sample_fmt",
    "s16",
    "-c:a",
    "flac",
    "-f",
    "flac",
    "pipe:1",
  ];
}

function requireSafeHttpsUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    throw new AlignmentTrainingAudioFfmpegError("audio_input_failed");
  }
}

function defaultSpawnFfmpeg(executable: string, args: string[]) {
  return spawn(executable, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
