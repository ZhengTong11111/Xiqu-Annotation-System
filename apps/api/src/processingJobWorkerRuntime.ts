import { randomUUID } from "node:crypto";
import type { ProcessingJobWorkerAdapter } from "./processingJobWorkerCoordinator.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_INITIAL_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

type ProcessingJobWorkerRuntimeLogger = {
  warn(facts: Record<string, unknown>, message: string): void;
};

export type ProcessingJobWorkerRuntimeOptions = {
  pollIntervalMs?: number;
  staleRecoveryIntervalMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  logger?: ProcessingJobWorkerRuntimeLogger;
};

/** 单进程串行领取后台任务；停止时中止当前适配器，并等待数据库收口后再退出。 */
export class ProcessingJobWorkerRuntime {
  private readonly workerId = `processing-job-${randomUUID()}`;
  private readonly abortController = new AbortController();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly service: ProcessingJobWorkerAdapter,
    private readonly options: ProcessingJobWorkerRuntimeOptions = {},
  ) {
    assertPositiveInterval(options.pollIntervalMs, "pollIntervalMs");
    assertPositiveInterval(options.staleRecoveryIntervalMs, "staleRecoveryIntervalMs");
    assertPositiveInterval(options.retryInitialMs, "retryInitialMs");
    assertPositiveInterval(options.retryMaxMs, "retryMaxMs");
    if (this.retryInitialMs > this.retryMaxMs) {
      throw new Error("worker 初始重试间隔不能超过最大间隔。");
    }
  }

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
    let consecutiveFailures = 0;
    let nextRecoveryAt = 0;
    while (!this.stopped) {
      try {
        const now = Date.now();
        if (now >= nextRecoveryAt) {
          await this.service.recoverStaleJobs();
          nextRecoveryAt = Date.now() + this.staleRecoveryIntervalMs;
        }
        const processed = await this.service.processNext(
          this.workerId,
          this.abortController.signal,
        );
        consecutiveFailures = 0;
        if (!processed) await wait(this.pollIntervalMs, this.abortController.signal);
      } catch {
        if (this.stopped) return;
        consecutiveFailures += 1;
        const retryDelayMs = calculateWorkerRetryDelay(
          consecutiveFailures,
          this.retryInitialMs,
          this.retryMaxMs,
        );
        // 循环日志只包含有界状态，不能把数据库、VOD 或模型执行器原始异常带入服务日志。
        this.options.logger?.warn(
          {
            errorCode: "worker_loop_iteration_failed",
            consecutiveFailures: Math.min(consecutiveFailures, 32),
            retryDelayMs,
          },
          "后台任务 worker 循环暂时失败，将按有界退避重试",
        );
        await wait(retryDelayMs, this.abortController.signal);
      }
    }
  }

  private get pollIntervalMs() {
    return this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private get staleRecoveryIntervalMs() {
    return this.options.staleRecoveryIntervalMs ?? DEFAULT_STALE_RECOVERY_INTERVAL_MS;
  }

  private get retryInitialMs() {
    return this.options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS;
  }

  private get retryMaxMs() {
    return this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }
}

export function calculateWorkerRetryDelay(
  consecutiveFailures: number,
  initialMs = DEFAULT_RETRY_INITIAL_MS,
  maximumMs = DEFAULT_RETRY_MAX_MS,
) {
  const exponent = Math.max(0, Math.min(30, consecutiveFailures - 1));
  return Math.min(maximumMs, initialMs * (2 ** exponent));
}

function assertPositiveInterval(value: number | undefined, name: string) {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${name} 必须是正数。`);
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
