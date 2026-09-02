import type {
  AnnotationToolAttemptState,
  SubmitAnnotationToolAttemptBatchResponse,
} from "@xiqu/shared";
import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import {
  annotationToolAttemptQueueStore,
  type AnnotationToolAttemptQueueStore,
  type QueuedAnnotationToolAttempt,
} from "./annotationToolAttemptQueue";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type DeliveryClient = Pick<PlatformClient, "submitAnnotationToolAttempts">;

export type AnnotationToolAttemptDeliveryBatchResult =
  | { status: "empty" }
  | { status: "progress"; delivered: number; dropped: number };

type DeliveryBatchOptions = {
  userId: string;
  client: DeliveryClient;
  store: AnnotationToolAttemptQueueStore;
  signal?: AbortSignal;
  onPermanentDrop?: (input: { attemptId: string; status: number }) => void;
};

/**
 * 送达一批当前状态快照。整批永久失败时递归二分，避免一个已删除文件或撤权事实堵住同账号的其他离线记录。
 */
export async function deliverAnnotationToolAttemptQueueBatch(
  options: DeliveryBatchOptions,
): Promise<AnnotationToolAttemptDeliveryBatchResult> {
  const rows = await options.store.listForUser(options.userId);
  if (rows.length === 0) return { status: "empty" };
  const counts = await deliverRows(rows, options);
  return { status: "progress", ...counts };
}

async function deliverRows(
  rows: QueuedAnnotationToolAttempt[],
  options: DeliveryBatchOptions,
): Promise<{ delivered: number; dropped: number }> {
  try {
    const response = await options.client.submitAnnotationToolAttempts(
      { attempts: rows.map(({ attempt }) => attempt) },
      options.signal,
    );
    assertAcknowledgesEveryRow(response, rows);
    await Promise.all(rows.map((row) => options.store.deleteIfVersion(row)));
    return { delivered: rows.length, dropped: 0 };
  } catch (error) {
    if (!isPermanentRowFailure(error)) throw error;
    if (rows.length > 1) {
      const middle = Math.ceil(rows.length / 2);
      const left = await deliverRows(rows.slice(0, middle), options);
      const right = await deliverRows(rows.slice(middle), options);
      return {
        delivered: left.delivered + right.delivered,
        dropped: left.dropped + right.dropped,
      };
    }

    const row = rows[0];
    // 单行已被服务端确定为永久不可接收时才清除；version 比较保护送达期间由另一标签页补写的新状态。
    const deleted = await options.store.deleteIfVersion(row);
    if (deleted) options.onPermanentDrop?.({ attemptId: row.attempt.id, status: error.status });
    return { delivered: 0, dropped: deleted ? 1 : 0 };
  }
}

function assertAcknowledgesEveryRow(
  response: SubmitAnnotationToolAttemptBatchResponse,
  rows: readonly QueuedAnnotationToolAttempt[],
) {
  if (!response || !Array.isArray(response.attempts) || response.attempts.length !== rows.length) {
    throw new Error("工具尝试批量响应数量不完整。");
  }
  const acknowledgedIds = new Set(response.attempts.map(({ id }) => id));
  if (acknowledgedIds.size !== rows.length || rows.some(({ attempt }) => !acknowledgedIds.has(attempt.id))) {
    throw new Error("工具尝试批量响应身份不完整。");
  }
}

function isPermanentRowFailure(error: unknown): error is PlatformApiError {
  return error instanceof PlatformApiError &&
    error.status >= 400 && error.status < 500 &&
    ![401, 408, 425, 429].includes(error.status);
}

function isAuthenticationFailure(error: unknown) {
  return error instanceof PlatformApiError && error.status === 401;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export type AnnotationToolAttemptDeliveryCoordinator = {
  start(): void;
  enqueue(attempt: AnnotationToolAttemptState): void;
  ensureDelivered(attemptIds: readonly string[]): Promise<{ unavailableAttemptIds: string[] }>;
  dispose(): void;
};

type CoordinatorOptions = {
  userId: string;
  client: DeliveryClient;
  store?: AnnotationToolAttemptQueueStore;
  online?: () => boolean;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * 每个已登录 Workspace 只创建一个账号级协调器。它不暴露发送状态给编辑器，遥测故障不得污染保存/冲突 UI。
 */
export function createAnnotationToolAttemptDeliveryCoordinator(
  options: CoordinatorOptions,
): AnnotationToolAttemptDeliveryCoordinator {
  const store = options.store ?? annotationToolAttemptQueueStore;
  const isOnline = options.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const eventTarget = options.eventTarget ?? (typeof window === "undefined" ? null : window);
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let started = false;
  let disposed = false;
  let running = false;
  let rerunRequested = false;
  let authenticationSuspended = false;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbortController: AbortController | null = null;
  const pendingWrites = new Map<string, Promise<void>>();
  const unavailableAttemptIds = new Set<string>();

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (disposed || authenticationSuspended || retryTimer !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    retryTimer = setTimer(() => {
      retryTimer = null;
      kick();
    }, delay);
  };

  const drain = async () => {
    if (running || disposed || authenticationSuspended || !isOnline()) return;
    running = true;
    activeAbortController = new AbortController();
    try {
      while (!disposed && isOnline()) {
        const result = await deliverAnnotationToolAttemptQueueBatch({
          userId: options.userId,
          client: options.client,
          store,
          signal: activeAbortController.signal,
          onPermanentDrop: ({ attemptId, status }) => {
            // 只记录定位身份和 HTTP 类别，不输出句子、详情、项目内容或凭据。
            unavailableAttemptIds.add(attemptId);
            console.warn("工具尝试记录无法永久送达，已移出本地队列。", { attemptId, status });
          },
        });
        retryDelayMs = INITIAL_RETRY_DELAY_MS;
        if (result.status === "empty") break;
      }
    } catch (error) {
      if (!disposed && !isAbortError(error)) {
        if (isAuthenticationFailure(error)) {
          // 旧 token 失效后停止忙重试；重新登录会创建新的账号 owner 并继续读取同一 IndexedDB 队列。
          authenticationSuspended = true;
        } else {
          console.warn("工具尝试记录暂未送达，将在网络恢复后重试。", {
            status: error instanceof PlatformApiError ? error.status : "network_or_protocol",
          });
          scheduleRetry();
        }
      }
    } finally {
      activeAbortController = null;
      running = false;
      if (rerunRequested && !disposed) {
        rerunRequested = false;
        kick();
      }
    }
  };

  function kick() {
    if (disposed || authenticationSuspended) return;
    clearRetry();
    if (running) {
      rerunRequested = true;
      return;
    }
    void drain();
  }

  const handleOnline = () => kick();

  return {
    start() {
      if (started || disposed) return;
      started = true;
      eventTarget?.addEventListener("online", handleOnline);
      kick();
    },
    enqueue(attempt) {
      // IndexedDB 写入和网络送达都在旁路执行；失败只输出有界诊断，绝不能阻断用户的时间轴操作。
      const previousWrite = pendingWrites.get(attempt.id) ?? Promise.resolve();
      const write = previousWrite
        .catch(() => undefined)
        .then(() => store.upsert(options.userId, attempt))
        .then(() => {
          unavailableAttemptIds.delete(attempt.id);
        });
      pendingWrites.set(attempt.id, write);
      void write.then(kick).catch((error: unknown) => {
        unavailableAttemptIds.add(attempt.id);
        console.warn("工具尝试记录未能写入浏览器队列，标注操作不受影响。", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }).finally(() => {
        if (pendingWrites.get(attempt.id) === write) pendingWrites.delete(attempt.id);
      });
    },
    async ensureDelivered(attemptIds) {
      const uniqueIds = [...new Set(attemptIds)];
      if (uniqueIds.length === 0) return { unavailableAttemptIds: [] };
      if (disposed || authenticationSuspended || !isOnline()) {
        return { unavailableAttemptIds: uniqueIds };
      }

      // 保存前只等待这些 attempt 自己的 IndexedDB 写入，不等待账号下无关文件的整个离线队列。
      const unavailable = new Set<string>();
      uniqueIds.filter((attemptId) => unavailableAttemptIds.has(attemptId))
        .forEach((attemptId) => unavailable.add(attemptId));
      await Promise.all(uniqueIds.map(async (attemptId) => {
        try {
          await pendingWrites.get(attemptId);
        } catch {
          unavailable.add(attemptId);
        }
      }));
      const rows = (await Promise.all(uniqueIds.map(async (attemptId) => {
        if (unavailable.has(attemptId)) return null;
        try {
          return await store.getForUser(options.userId, attemptId);
        } catch {
          unavailable.add(attemptId);
          return null;
        }
      }))).filter((row): row is QueuedAnnotationToolAttempt => row !== null);
      if (rows.length === 0) return { unavailableAttemptIds: [...unavailable] };

      try {
        // 多标签页或后台 drain 可能同时送达同一 UUID；服务端与本地 version 条件删除都支持这种幂等竞争。
        const response = await options.client.submitAnnotationToolAttempts({
          attempts: rows.map(({ attempt }) => attempt),
        });
        assertAcknowledgesEveryRow(response, rows);
        await Promise.all(rows.map((row) => store.deleteIfVersion(row)));
        rows.forEach((row) => unavailableAttemptIds.delete(row.attempt.id));
      } catch {
        rows.forEach((row) => unavailable.add(row.attempt.id));
      }
      return { unavailableAttemptIds: [...unavailable] };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearRetry();
      eventTarget?.removeEventListener("online", handleOnline);
      activeAbortController?.abort();
    },
  };
}
