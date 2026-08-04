import { randomUUID } from "node:crypto";
import type { Notification, Pool, PoolClient } from "pg";
import type {
  AnnotationRevisionEvent,
  AnnotationRevisionPublisher,
} from "./annotationCollaborationHub.js";
import type { ApiObservability } from "./observability.js";
import {
  parseSerializedAnnotationRevisionEventEnvelope,
  serializeAnnotationRevisionEventEnvelope,
} from "./annotationRevisionEventEnvelope.js";

const DEFAULT_MAX_PENDING_FILES = 1_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type AnnotationRevisionListener = {
  close: () => Promise<void>;
};

export type AnnotationRevisionEventTransport = {
  openListener: (
    channel: string,
    handlers: {
      onNotification: (payload: string | undefined) => void;
      onError: (error: unknown) => void;
    },
  ) => Promise<AnnotationRevisionListener>;
  notify: (channel: string, payload: string) => Promise<void>;
};

type AnnotationRevisionEventBusOptions = {
  transport: AnnotationRevisionEventTransport;
  channel: string;
  deliver: (event: AnnotationRevisionEvent) => "accepted" | "duplicate";
  observability: Pick<
    ApiObservability,
    | "setAnnotationRevisionBusConnected"
    | "setAnnotationRevisionBusPendingFiles"
    | "recordAnnotationRevisionBusPublish"
    | "recordAnnotationRevisionBusInbound"
    | "recordAnnotationRevisionBusReconnect"
  >;
  logger: {
    error: (error: unknown, message?: string) => void;
  };
  instanceId?: string;
  maxPendingFiles?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
};

/**
 * 使用独立 PostgreSQL pool 承担 LISTEN/NOTIFY。
 *
 * LISTEN 必须占有一条持久连接，因此不能借用维护模式或 Prisma 的业务查询连接池。
 */
export function createPostgresAnnotationRevisionTransport(
  pool: Pool,
): AnnotationRevisionEventTransport {
  return {
    async openListener(channel, handlers) {
      assertSafeChannel(channel);
      const client = await pool.connect();
      let failed = false;
      let closed = false;
      const onNotification = (message: Notification) => {
        if (!closed && message.channel === channel) {
          handlers.onNotification(message.payload);
        }
      };
      const onConnectionFailure = (error: unknown) => {
        if (closed) return;
        failed = true;
        handlers.onError(error);
      };
      const onConnectionEnd = () => onConnectionFailure(
        new Error("PostgreSQL revision LISTEN connection ended."),
      );
      client.on("notification", onNotification);
      client.on("error", onConnectionFailure);
      client.on("end", onConnectionEnd);
      try {
        await client.query(`LISTEN ${channel}`);
      } catch (error) {
        removeClientListeners(client, onNotification, onConnectionFailure, onConnectionEnd);
        client.release(true);
        throw error;
      }
      return {
        async close() {
          if (closed) return;
          closed = true;
          removeClientListeners(client, onNotification, onConnectionFailure, onConnectionEnd);
          if (!failed) {
            try {
              await client.query(`UNLISTEN ${channel}`);
            } catch {
              failed = true;
            }
          }
          client.release(failed);
        },
      };
    },
    async notify(channel, payload) {
      assertSafeChannel(channel);
      await pool.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
  };
}

/**
 * revision bus 是“可丢失的失效提示”，不是持久消息队列。
 * 本机先投递、跨实例再异步广播；任一 NOTIFY 丢失都由客户端既有 HTTP catch-up 恢复正确状态。
 */
export class PostgresAnnotationRevisionEventBus implements AnnotationRevisionPublisher {
  private readonly instanceId: string;
  private readonly maxPendingFiles: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly random: () => number;
  private readonly pending = new Map<string, AnnotationRevisionEvent>();
  private listener: AnnotationRevisionListener | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private connectInFlight = false;
  private drainPromise: Promise<void> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
  private closed = false;

  constructor(private readonly options: AnnotationRevisionEventBusOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.maxPendingFiles = options.maxPendingFiles ?? DEFAULT_MAX_PENDING_FILES;
    if (!Number.isInteger(this.maxPendingFiles) || this.maxPendingFiles < 1) {
      throw new Error("revision event bus 的待发布文件上限必须是正整数。");
    }
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.random = options.random ?? Math.random;
  }

  async start() {
    if (this.closed) throw new Error("已关闭的 revision event bus 不能重新启动。");
    if (this.started) return;
    this.started = true;
    // 初始 LISTEN 失败属于部署配置错误，必须阻止应用以“跨实例可用”的假状态启动。
    try {
      await this.connectListener(true);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  publishRevisionAdvanced(event: AnnotationRevisionEvent) {
    if (!this.started || this.closed) return;
    // 本机连接不依赖 NOTIFY 回环；数据库临时故障也不能增加同实例的通知延迟。
    const localResult = this.options.deliver(event);
    this.options.observability.recordAnnotationRevisionBusInbound(localResult);
    this.enqueue(event);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.generation += 1;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pending.clear();
    this.options.observability.setAnnotationRevisionBusPendingFiles(0);
    this.options.observability.setAnnotationRevisionBusConnected(false);
    const listener = this.listener;
    this.listener = null;
    try {
      await listener?.close();
    } catch (error) {
      this.options.logger.error(error, "annotation revision LISTEN close failed");
    } finally {
      // 已经发出的短 query 在关闭 pool 前收口，避免未处理 rejection 或测试进程悬挂。
      await this.drainPromise;
    }
  }

  private enqueue(event: AnnotationRevisionEvent) {
    const existing = this.pending.get(event.annotationFileId);
    if (existing) {
      if (event.revision > existing.revision) {
        this.pending.set(event.annotationFileId, event);
      }
      this.options.observability.recordAnnotationRevisionBusPublish("coalesced");
      return;
    }
    if (this.pending.size >= this.maxPendingFiles) {
      const oldestFileId = this.pending.keys().next().value;
      if (typeof oldestFileId === "string") this.pending.delete(oldestFileId);
      this.options.observability.recordAnnotationRevisionBusPublish("dropped");
    }
    this.pending.set(event.annotationFileId, event);
    this.options.observability.recordAnnotationRevisionBusPublish("queued");
    this.options.observability.setAnnotationRevisionBusPendingFiles(this.pending.size);
    this.ensureDrain();
  }

  private ensureDrain() {
    if (this.drainPromise || this.closed) return;
    this.drainPromise = this.drain()
      .catch((error: unknown) => {
        // drain 内部已逐项隔离，走到这里表示合同外故障；记录后仍必须释放 single-flight。
        this.options.logger.error(error, "annotation revision event bus drain failed");
      })
      .finally(() => {
        this.drainPromise = null;
        if (!this.closed && this.pending.size) this.ensureDrain();
      });
  }

  private async drain() {
    while (!this.closed && this.pending.size) {
      const next = this.pending.entries().next().value as
        | [string, AnnotationRevisionEvent]
        | undefined;
      if (!next) return;
      const [annotationFileId, event] = next;
      this.pending.delete(annotationFileId);
      this.options.observability.setAnnotationRevisionBusPendingFiles(this.pending.size);
      try {
        const payload = serializeAnnotationRevisionEventEnvelope(this.instanceId, event);
        await this.options.transport.notify(this.options.channel, payload);
      } catch (error) {
        // 权威 revision 已提交，通知失败只能降级到 HTTP catch-up，绝不能反向让保存响应失败。
        this.options.observability.recordAnnotationRevisionBusPublish("failed");
        this.options.logger.error(error, "annotation revision NOTIFY failed");
      }
    }
  }

  private async connectListener(initial: boolean) {
    if (this.closed || this.connectInFlight) return;
    this.connectInFlight = true;
    const requestGeneration = this.generation;
    let retryAfterAttempt = false;
    try {
      const listener = await this.options.transport.openListener(this.options.channel, {
        onNotification: (payload) => this.handleNotification(payload),
        onError: (error) => this.handleListenerFailure(requestGeneration, error),
      });
      if (this.closed || requestGeneration !== this.generation) {
        await listener.close();
        retryAfterAttempt = !this.closed;
        return;
      }
      this.listener = listener;
      this.reconnectAttempt = 0;
      this.options.observability.setAnnotationRevisionBusConnected(true);
    } catch (error) {
      this.options.observability.setAnnotationRevisionBusConnected(false);
      if (initial) throw error;
      retryAfterAttempt = true;
    } finally {
      this.connectInFlight = false;
      // connectInFlight 必须先释放再排重连，否则同步失败会被 single-flight 门禁误吞掉。
      if (retryAfterAttempt) this.scheduleReconnect();
    }
  }

  private handleNotification(payload: string | undefined) {
    const envelope = parseSerializedAnnotationRevisionEventEnvelope(payload);
    if (!envelope) {
      this.options.observability.recordAnnotationRevisionBusInbound("invalid");
      return;
    }
    const result = this.options.deliver({
      annotationFileId: envelope.annotationFileId,
      revision: envelope.revision,
      operationCursor: envelope.operationCursor,
    });
    this.options.observability.recordAnnotationRevisionBusInbound(result);
  }

  private handleListenerFailure(requestGeneration: number, error: unknown) {
    if (this.closed || requestGeneration !== this.generation) return;
    this.options.logger.error(error, "annotation revision LISTEN connection failed");
    this.options.observability.setAnnotationRevisionBusConnected(false);
    this.generation += 1;
    const listener = this.listener;
    this.listener = null;
    void listener?.close()
      .catch((closeError: unknown) => {
        this.options.logger.error(closeError, "failed to release annotation revision listener");
      })
      .finally(() => this.scheduleReconnect());
    if (!listener) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.connectInFlight) return;
    this.reconnectAttempt += 1;
    this.options.observability.recordAnnotationRevisionBusReconnect();
    const base = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt - 1, 6),
    );
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.connectListener(false);
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function assertSafeChannel(channel: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(channel)) {
    throw new Error("revision event bus channel 不是安全的 PostgreSQL 标识符。");
  }
}

function removeClientListeners(
  client: PoolClient,
  onNotification: (message: Notification) => void,
  onConnectionFailure: (error: unknown) => void,
  onConnectionEnd: () => void,
) {
  client.removeListener("notification", onNotification);
  client.removeListener("error", onConnectionFailure);
  client.removeListener("end", onConnectionEnd);
}
