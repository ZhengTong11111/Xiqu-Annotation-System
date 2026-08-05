import { randomUUID } from "node:crypto";
import type { MediaAnalysisWorkerService } from "./mediaAnalysisWorkerService.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** 单 worker 串行 claim；停止时中止当前 FFmpeg，并等待数据库写入完成后再退出。 */
export class MediaAnalysisWorkerRuntime {
  private readonly workerId = `media-analysis-${randomUUID()}`;
  private readonly abortController = new AbortController();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly service: MediaAnalysisWorkerService,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  start() {
    if (this.running) return this.running;
    this.running = this.runLoop();
    return this.running;
  }

  async stop() {
    if (this.stopped) return this.running ?? Promise.resolve();
    this.stopped = true;
    this.abortController.abort();
    await this.running;
  }

  private async runLoop() {
    await this.service.recoverStaleJobs();
    while (!this.stopped) {
      const processed = await this.service.processNext(
        this.workerId,
        this.abortController.signal,
      );
      if (!processed) await wait(this.pollIntervalMs, this.abortController.signal);
    }
  }
}

function wait(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
