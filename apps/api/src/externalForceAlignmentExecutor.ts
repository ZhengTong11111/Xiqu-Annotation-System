import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ForceAlignmentExecutor, ForceAlignmentExecutorInput } from "./alignmentExecutor.js";
import { ForceAlignmentExecutorError } from "./alignmentExecutor.js";

const MAX_AUDIO_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXECUTOR_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTOR_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * 生产模型通过固定文件协议接入：正文投影和音频只存在于 0700 临时目录，命令行不携带正文、URL 或凭据。
 * 可执行程序必须支持 `--request <json> --audio <binary> --output <json>`，退出码 0 后 worker 仍会严格校验输出。
 */
export class ExternalForceAlignmentExecutor implements ForceAlignmentExecutor {
  constructor(private readonly executablePath: string) {
    if (!path.isAbsolute(executablePath)) {
      throw new Error("强制对齐执行器必须使用绝对路径。");
    }
  }

  async checkReadiness() {
    await access(this.executablePath, constants.X_OK);
  }

  async execute(input: ForceAlignmentExecutorInput, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(tmpdir(), "xiqu-force-alignment-"));
    const requestPath = path.join(directory, "request.json");
    const audioPath = path.join(directory, "audio.input");
    const outputPath = path.join(directory, "prediction.json");
    try {
      // request 文件只在 worker 本机临时存在；URL 已由下面的受控下载转换为普通音频文件。
      const requestBytes = Buffer.from(JSON.stringify({
        version: 1,
        projection: input.projection,
        audioOffsetMicros: input.audioOffsetMicros,
        model: input.model,
      }), "utf8");
      if (requestBytes.byteLength > MAX_EXECUTOR_REQUEST_BYTES) {
        throw new ForceAlignmentExecutorError("alignment_execution_failed");
      }
      await writeFile(requestPath, requestBytes, { mode: 0o600, flag: "wx" });
      await materializeAudio(input, audioPath, signal);
      await runExecutor(this.executablePath, requestPath, audioPath, outputPath, signal);
      const metadata = await stat(outputPath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_EXECUTOR_OUTPUT_BYTES) {
        throw new ForceAlignmentExecutorError("alignment_execution_failed");
      }
      const output = await readFile(outputPath, "utf8");
      try {
        return JSON.parse(output) as unknown;
      } catch {
        throw new ForceAlignmentExecutorError("alignment_execution_failed");
      }
    } finally {
      // 临时目录含正文投影与音频；删除失败必须成为稳定治理错误，不能静默留下敏感副本或输出路径。
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        throw new ForceAlignmentExecutorError("alignment_temporary_cleanup_failed");
      }
    }
  }
}

async function materializeAudio(
  input: ForceAlignmentExecutorInput,
  outputPath: string,
  signal: AbortSignal,
) {
  let source: Readable;
  if (input.audio.kind === "uploaded") {
    source = input.audio.stream;
  } else {
    let response: Response;
    try {
      response = await fetch(input.audio.url, { signal, redirect: "follow" });
    } catch {
      throw new ForceAlignmentExecutorError("alignment_execution_failed");
    }
    if (!response.ok || !response.body) {
      throw new ForceAlignmentExecutorError("alignment_execution_failed");
    }
    source = Readable.fromWeb(response.body as never);
  }
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_AUDIO_INPUT_BYTES) {
        callback(new ForceAlignmentExecutorError("alignment_execution_failed"));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(source, limiter, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }), { signal });
}

async function runExecutor(
  executablePath: string,
  requestPath: string,
  audioPath: string,
  outputPath: string,
  signal: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, [
      "--request", requestPath,
      "--audio", audioPath,
      "--output", outputPath,
    ], {
      shell: false,
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    let settled = false;
    let forcedKillTimer: NodeJS.Timeout | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      // 执行器忽略 SIGTERM 时必须有上界；等真实 exit 后才删除临时输入，避免子进程继续访问已移除目录。
      forcedKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forcedKillTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(new ForceAlignmentExecutorError("alignment_executor_unavailable")));
    child.once("exit", (code, terminationSignal) => {
      if (signal.aborted) {
        finish(new ForceAlignmentExecutorError("alignment_execution_failed"));
      } else if (code === 0 && terminationSignal === null) {
        finish();
      } else {
        finish(new ForceAlignmentExecutorError("alignment_execution_failed"));
      }
    });
    if (signal.aborted) abort();
  });
}
