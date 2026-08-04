import { randomUUID } from "node:crypto";
import type { Notification, Pool, PoolClient } from "pg";

const DEFAULT_MAX_PENDING_KEYS = 1_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type PostgresEventListener = {
  close: () => Promise<void>;
};

export type PostgresEventTransport = {
  openListener: (
    channel: string,
    handlers: {
      onNotification: (payload: string | undefined) => void;
      onError: (error: unknown) => void;
    },
  ) => Promise<PostgresEventListener>;
  notify: (channel: string, payload: string) => Promise<void>;
};

export type PostgresCoalescedEventBusOptions<TEvent, TDeliveryResult extends string> = {
  transport: PostgresEventTransport;
  channel: string;
  getKey: (event: TEvent) => string;
  coalesce: (existing: TEvent, incoming: TEvent) => TEvent;
  serialize: (sourceInstanceId: string, event: TEvent) => string;
  parse: (payload: string | undefined) => TEvent | null;
  deliver: (event: TEvent) => TDeliveryResult;
  metrics: {
    setConnected: (connected: boolean) => void;
    setPendingKeys: (count: number) => void;
    recordPublish: (result: "queued" | "coalesced" | "dropped" | "failed") => void;
    recordInbound: (result: TDeliveryResult | "invalid") => void;
    recordReconnect: () => void;
  };
  logger: {
    error: (error: unknown, message?: string) => void;
  };
  instanceId?: string;
  maxPendingKeys?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
};

/**
 * 创建 LISTEN/NOTIFY 的窄传输端口。
 * 持久 LISTEN 必须使用专用 pool，不能借用 Prisma 查询或维护 advisory-lock 连接。
 */
export function createPostgresEventTransport(pool: Pool): PostgresEventTransport {
  return {
    async openListener(channel, handlers) {
      assertSafeChannel(channel);
      const client = await pool.connect();
      let failed = false;
      let closed = false;
      const onNotification = (message: Notification) => {
        if (!closed && message.channel === channel) handlers.onNotification(message.payload);
      };
      const onConnectionFailure = (error: unknown) => {
        if (closed) return;
        failed = true;
        handlers.onError(error);
      };
      const onConnectionEnd = () => onConnectionFailure(
        new Error("PostgreSQL collaboration LISTEN connection ended."),
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
 * 通用核心只处理连接、重连、同 key 合并和有界发布。
 * 业务包装器仍负责严格协议、事件 key、合并规则、投递结果与具体指标名。
 */
export class PostgresCoalescedEventBus<TEvent, TDeliveryResult extends string> {
  private readonly instanceId: string;
  private readonly maxPendingKeys: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly random: () => number;
  private readonly pending = new Map<string, TEvent>();
  private listener: PostgresEventListener | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private connectInFlight = false;
  private drainPromise: Promise<void> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
  private closed = false;

  constructor(private readonly options: PostgresCoalescedEventBusOptions<TEvent, TDeliveryResult>) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.maxPendingKeys = options.maxPendingKeys ?? DEFAULT_MAX_PENDING_KEYS;
    if (!Number.isInteger(this.maxPendingKeys) || this.maxPendingKeys < 1) {
      throw new Error("PostgreSQL event bus 的待发布 key 上限必须是正整数。");
    }
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.random = options.random ?? Math.random;
  }

  async start() {
    if (this.closed) throw new Error("已关闭的 PostgreSQL event bus 不能重新启动。");
    if (this.started) return;
    this.started = true;
    try {
      // 初始 LISTEN 失败必须阻止应用带着错误的跨实例能力声明启动。
      await this.connectListener(true);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  publish(event: TEvent) {
    if (!this.started || this.closed) return;
    // 当前实例先投递；数据库通知失败只能降低其他实例的实时性。
    this.options.metrics.recordInbound(this.options.deliver(event));
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
    this.options.metrics.setPendingKeys(0);
    this.options.metrics.setConnected(false);
    const listener = this.listener;
    this.listener = null;
    try {
      await listener?.close();
    } catch (error) {
      this.options.logger.error(error, "PostgreSQL collaboration LISTEN close failed");
    } finally {
      // 已发出的短 query 在 pool 关闭前收口，避免未处理 rejection 或悬挂测试进程。
      await this.drainPromise;
    }
  }

  private enqueue(event: TEvent) {
    const key = this.options.getKey(event);
    const existing = this.pending.get(key);
    if (existing) {
      this.pending.set(key, this.options.coalesce(existing, event));
      this.options.metrics.recordPublish("coalesced");
      return;
    }
    if (this.pending.size >= this.maxPendingKeys) {
      const oldestKey = this.pending.keys().next().value;
      if (typeof oldestKey === "string") this.pending.delete(oldestKey);
      this.options.metrics.recordPublish("dropped");
    }
    this.pending.set(key, event);
    this.options.metrics.recordPublish("queued");
    this.options.metrics.setPendingKeys(this.pending.size);
    this.ensureDrain();
  }

  private ensureDrain() {
    if (this.drainPromise || this.closed) return;
    this.drainPromise = this.drain()
      .catch((error: unknown) => {
        this.options.logger.error(error, "PostgreSQL collaboration event drain failed");
      })
      .finally(() => {
        this.drainPromise = null;
        if (!this.closed && this.pending.size) this.ensureDrain();
      });
  }

  private async drain() {
    while (!this.closed && this.pending.size) {
      const next = this.pending.entries().next().value as [string, TEvent] | undefined;
      if (!next) return;
      const [key, event] = next;
      this.pending.delete(key);
      this.options.metrics.setPendingKeys(this.pending.size);
      try {
        await this.options.transport.notify(
          this.options.channel,
          this.options.serialize(this.instanceId, event),
        );
      } catch (error) {
        // 权威业务事实已经提交；通知失败只能被记录，不能反向抛给调用方。
        this.options.metrics.recordPublish("failed");
        this.options.logger.error(error, "PostgreSQL collaboration NOTIFY failed");
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
      this.options.metrics.setConnected(true);
    } catch (error) {
      this.options.metrics.setConnected(false);
      if (initial) throw error;
      retryAfterAttempt = true;
    } finally {
      this.connectInFlight = false;
      // 先释放 single-flight 再安排重连，避免同步失败被自己吞掉。
      if (retryAfterAttempt) this.scheduleReconnect();
    }
  }

  private handleNotification(payload: string | undefined) {
    const event = this.options.parse(payload);
    if (!event) {
      this.options.metrics.recordInbound("invalid");
      return;
    }
    this.options.metrics.recordInbound(this.options.deliver(event));
  }

  private handleListenerFailure(requestGeneration: number, error: unknown) {
    if (this.closed || requestGeneration !== this.generation) return;
    this.options.logger.error(error, "PostgreSQL collaboration LISTEN connection failed");
    this.options.metrics.setConnected(false);
    this.generation += 1;
    const listener = this.listener;
    this.listener = null;
    void listener?.close()
      .catch((closeError: unknown) => {
        this.options.logger.error(closeError, "failed to release PostgreSQL collaboration listener");
      })
      .finally(() => this.scheduleReconnect());
    if (!listener) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.connectInFlight) return;
    this.reconnectAttempt += 1;
    this.options.metrics.recordReconnect();
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
    throw new Error("PostgreSQL collaboration channel 不是安全标识符。");
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
