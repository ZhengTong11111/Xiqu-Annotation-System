import type { PrismaClient } from "@prisma/client";
import type {
  FastifyInstance,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import type { Pool, PoolClient } from "pg";
import type {
  PlatformMaintenanceStatus,
  SetPlatformMaintenanceRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import {
  badRequest,
  forbidden,
  maintenanceMode,
  writeGateBusy,
} from "./errors.js";
import {
  attachMaintenanceRouteManifest,
  resolveMaintenanceAccess,
} from "./maintenanceRouteAccess.js";
import type { ResourceAccessService } from "./resourceAccess.js";

// 维护许可使用独立于资源树锁的固定 int64 key；所有 API 实例连接同一数据库即可共享边界。
const MAINTENANCE_ADVISORY_LOCK_KEY = "6361718588744490068";
const RUNTIME_STATE_ID = "platform";
const DEFAULT_EXCLUSIVE_WAIT_MS = 30_000;
const EXCLUSIVE_POLL_INTERVAL_MS = 25;

type WritePermit = {
  release: () => Promise<void>;
};

type RequestPermitState = {
  permit: WritePermit;
  handlerStarted: boolean;
};

export type MaintenancePermitDiagnostics = {
  active: number;
  waiting: number;
  oldestActiveAgeMs: number;
};

export type MaintenancePermitObserver = {
  recordMaintenancePermitAcquireFailure: (stage: "pool" | "exclusive") => void;
  recordMaintenancePermitReleaseFailure: () => void;
  observeMaintenancePermitHold: (durationMs: number) => void;
};

type MaintenanceCoordinatorOptions = {
  exclusiveWaitMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

const NOOP_PERMIT_OBSERVER: MaintenancePermitObserver = {
  recordMaintenancePermitAcquireFailure: () => undefined,
  recordMaintenancePermitReleaseFailure: () => undefined,
  observeMaintenancePermitHold: () => undefined,
};

// coordinator 用共享锁覆盖完整写请求，用独占锁完成“排空在途写入后进入维护”的原子切换。
export class MaintenanceCoordinator {
  private readonly requestPermits = new WeakMap<FastifyRequest, RequestPermitState>();
  private readonly activePermitStartedAt = new Map<number, number>();
  private readonly observer: MaintenancePermitObserver;
  private readonly exclusiveWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private waitingPermitCount = 0;
  private nextPermitId = 1;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly lockPool: Pool,
    private readonly access: ResourceAccessService,
    observer: MaintenancePermitObserver = NOOP_PERMIT_OBSERVER,
    options: MaintenanceCoordinatorOptions = {},
  ) {
    this.observer = observer;
    this.exclusiveWaitMs = options.exclusiveWaitMs ?? DEFAULT_EXCLUSIVE_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    }));
  }

  // Fastify gate 先取得许可，再由统一 handler 包装器在业务 Promise 结束时释放，避免依赖网络响应完成事件。
  registerRequestGate(app: FastifyInstance) {
    const coordinator = this;
    const recordRoute = attachMaintenanceRouteManifest(app);
    app.addHook("onRoute", (routeOptions) => {
      recordRoute(routeOptions.method, routeOptions.url, routeOptions.config);
      if (resolveMaintenanceAccess(routeOptions.method, routeOptions.config) !== "write") {
        return;
      }
      const originalHandler = routeOptions.handler;
      routeOptions.handler = (async function wrappedMaintenanceWriteHandler(
        this: FastifyInstance,
        request,
        reply,
      ) {
        coordinator.markHandlerStarted(request);
        try {
          return await originalHandler.call(this, request, reply);
        } finally {
          // 客户端断开也不能提前释放真实写入；只有 handler 自身结束才代表业务边界完成。
          await coordinator.releaseRequestPermit(request, "handler_settled");
        }
      }) as RouteHandlerMethod;
    });
    app.addHook("onRequest", async (request) => {
      if (resolveMaintenanceAccess(request.method, request.routeOptions.config) !== "write") return;
      const permit = await this.acquireWritePermit();
      this.requestPermits.set(request, { permit, handlerStarted: false });
    });
    // error/onResponse 只作为早期解析错误和框架异常的保险；正常写请求由 handler 包装器释放。
    app.addHook("onError", async (request) => {
      await this.releaseRequestPermit(request, "request_error");
    });
    app.addHook("onResponse", async (request) => {
      await this.releaseRequestPermit(request, "response_fallback");
    });
    // 请求体尚未进入 handler 就被中止时可以释放；handler 已开始则必须等待其 finally，避免维护误判写入已排空。
    app.addHook("onRequestAbort", async (request) => {
      const state = this.requestPermits.get(request);
      if (state && !state.handlerStarted) {
        await this.releaseRequestPermit(request, "request_aborted_before_handler");
      }
    });
  }

  async acquireWritePermit(): Promise<WritePermit> {
    this.waitingPermitCount += 1;
    let client: PoolClient;
    try {
      client = await this.lockPool.connect();
    } catch {
      this.waitingPermitCount -= 1;
      this.observer.recordMaintenancePermitAcquireFailure("pool");
      throw writeGateBusy("写入门禁当前繁忙，请稍后重试。");
    }
    let locked = false;
    let released = false;
    let waiting = true;
    let permitId: number | null = null;
    let acquiredAt = 0;
    const finishWaiting = () => {
      if (!waiting) return;
      waiting = false;
      this.waitingPermitCount -= 1;
    };
    // permit 生命周期由当前专用连接承载；幂等释放同时防止 active/error 分支重复归还连接。
    const release = async () => {
      if (released) return;
      released = true;
      finishWaiting();
      if (locked) {
        locked = false;
        try {
          await unlockAndRelease(client, "shared");
        } catch (error) {
          this.observer.recordMaintenancePermitReleaseFailure();
          throw error;
        } finally {
          if (permitId !== null) this.activePermitStartedAt.delete(permitId);
          if (acquiredAt > 0) {
            this.observer.observeMaintenancePermitHold(this.now() - acquiredAt);
          }
        }
      } else {
        client.release();
      }
    };
    try {
      // 普通请求不等待正在切换的独占维护锁；立即返回可重试 503，避免占满整个专用池。
      const lockResult = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock_shared($1::bigint) AS locked",
        [MAINTENANCE_ADVISORY_LOCK_KEY],
      );
      if (!lockResult.rows[0]?.locked) {
        throw writeGateBusy("平台正在切换维护状态，请稍后重试。");
      }
      locked = true;
      const result = await client.query<{ maintenance_mode: boolean }>(
        `SELECT maintenance_mode
         FROM platform_runtime_state
         WHERE id = $1`,
        [RUNTIME_STATE_ID],
      );
      const state = result.rows[0];
      if (state?.maintenance_mode) {
        await release();
        // 维护原因只在管理员状态接口中公开，匿名 mutation 只能得到稳定、无运维细节的拒绝信息。
        throw maintenanceMode("平台正在维护，暂时不能执行写入操作。");
      }
      finishWaiting();
      acquiredAt = this.now();
      permitId = this.nextPermitId++;
      this.activePermitStartedAt.set(permitId, acquiredAt);
      return {
        // release 幂等，避免未来新增 error hook 时与 onResponse 重复解锁。
        release,
      };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }

  // 管理诊断读取当前 API 实例的许可事实；不公开连接 pid、SQL 或具体请求身份。
  getPermitDiagnostics(): MaintenancePermitDiagnostics {
    const now = this.now();
    let oldestActiveAgeMs = 0;
    for (const startedAt of this.activePermitStartedAt.values()) {
      oldestActiveAgeMs = Math.max(oldestActiveAgeMs, now - startedAt);
    }
    return {
      active: this.activePermitStartedAt.size,
      waiting: this.waitingPermitCount,
      oldestActiveAgeMs,
    };
  }

  async getStatus(user: ApiUser): Promise<PlatformMaintenanceStatus> {
    this.assertAdministrator(user);
    return this.readStatus();
  }

  async setMaintenance(
    user: ApiUser,
    input: SetPlatformMaintenanceRequest,
  ): Promise<PlatformMaintenanceStatus> {
    this.assertAdministrator(user);
    // coordinator 自身维护原因不变量，未来 CLI 复用时不能绕过 HTTP route 的输入校验。
    const reason = input.reason?.trim() || null;
    if (input.enabled && !reason) {
      throw badRequest("进入维护模式前必须填写原因。");
    }
    if (reason && reason.length > 240) {
      throw badRequest("维护原因不能超过 240 个字符。");
    }
    let client: PoolClient;
    try {
      client = await this.lockPool.connect();
    } catch {
      this.observer.recordMaintenancePermitAcquireFailure("pool");
      throw writeGateBusy("维护门禁连接当前繁忙，请稍后重试。");
    }
    let locked = false;
    let operationError: unknown;
    try {
      // 独占锁等待真实业务 handler 排空，但使用有界轮询，避免僵死写入让管理员请求永久挂起。
      await this.acquireExclusivePermit(client);
      locked = true;
      await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.platformRuntimeState.findUnique({
          where: { id: RUNTIME_STATE_ID },
        });
        if (current?.maintenanceMode === input.enabled) return;
        const now = new Date();
        await transaction.platformRuntimeState.upsert({
          where: { id: RUNTIME_STATE_ID },
          create: {
            id: RUNTIME_STATE_ID,
            maintenanceMode: input.enabled,
            maintenanceReason: input.enabled ? reason : null,
            maintenanceStartedAt: input.enabled ? now : null,
            maintenanceStartedBy: input.enabled ? user.id : null,
          },
          update: {
            maintenanceMode: input.enabled,
            maintenanceReason: input.enabled ? reason : null,
            maintenanceStartedAt: input.enabled ? now : null,
            maintenanceStartedBy: input.enabled ? user.id : null,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: input.enabled ? "maintenance_enable" : "maintenance_disable",
            actorUserId: user.id,
            detail: input.enabled ? { reason } : {},
          },
        });
      });
    } catch (error) {
      operationError = error;
    }
    try {
      // 无论事务成功或失败都释放独占 session lock；失败连接由 helper 直接销毁，不会带锁回池。
      if (locked) {
        await unlockAndRelease(client, "exclusive");
      } else {
        client.release();
      }
    } catch (unlockError) {
      // 同时失败时保留两个原因，避免解锁异常掩盖原始业务/数据库错误。
      if (operationError) {
        throw new AggregateError(
          [operationError, unlockError],
          "切换维护状态并释放数据库锁时均发生错误。",
        );
      }
      throw unlockError;
    }
    if (operationError) throw operationError;
    return this.readStatus();
  }

  private markHandlerStarted(request: FastifyRequest) {
    const state = this.requestPermits.get(request);
    if (state) state.handlerStarted = true;
  }

  // 独占维护锁使用 try-lock 轮询；超时保留正常写入状态，并返回可诊断、可重试的稳定错误。
  private async acquireExclusivePermit(client: PoolClient) {
    const deadline = this.now() + this.exclusiveWaitMs;
    while (true) {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [MAINTENANCE_ADVISORY_LOCK_KEY],
      );
      if (result.rows[0]?.locked) return;
      if (this.now() >= deadline) {
        this.observer.recordMaintenancePermitAcquireFailure("exclusive");
        throw writeGateBusy("仍有写入操作尚未结束，暂时不能切换维护状态。", {
          activeWritePermits: this.activePermitStartedAt.size,
        });
      }
      await this.sleep(Math.min(
        EXCLUSIVE_POLL_INTERVAL_MS,
        Math.max(0, deadline - this.now()),
      ));
    }
  }

  // handler/fallback/中止共用这一出口；先从 WeakMap 删除，保证多个生命周期出口竞争时只释放一次。
  private async releaseRequestPermit(
    request: FastifyRequest,
    releasePath: string,
  ) {
    const state = this.requestPermits.get(request);
    if (!state) return;
    this.requestPermits.delete(request);
    try {
      await state.permit.release();
    } catch (error) {
      // 请求生命周期已经结束，无法再改变响应；记录错误且 helper 已销毁可疑数据库连接。
      request.log.error({ err: error, releasePath }, "释放维护写许可失败");
    }
  }

  private async readStatus(): Promise<PlatformMaintenanceStatus> {
    const state = await this.prisma.platformRuntimeState.findUnique({
      where: { id: RUNTIME_STATE_ID },
    });
    const starter = state?.maintenanceStartedBy
      ? await this.prisma.user.findUnique({
          where: { id: state.maintenanceStartedBy },
          select: { id: true, accountName: true, displayName: true },
        })
      : null;
    return {
      enabled: state?.maintenanceMode ?? false,
      reason: state?.maintenanceReason ?? null,
      startedAt: state?.maintenanceStartedAt?.toISOString() ?? null,
      startedBy: starter,
      updatedAt: state?.updatedAt.toISOString() ?? new Date(0).toISOString(),
    };
  }

  private assertAdministrator(user: ApiUser) {
    if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以切换平台维护状态。");
    }
  }
}

// advisory lock 属于数据库 session，必须先显式 unlock 再归还连接池。
async function unlockAndRelease(
  client: PoolClient,
  mode: "shared" | "exclusive",
) {
  try {
    const functionName = mode === "shared"
      ? "pg_advisory_unlock_shared"
      : "pg_advisory_unlock";
    await client.query(`SELECT ${functionName}($1::bigint)`, [
      MAINTENANCE_ADVISORY_LOCK_KEY,
    ]);
    client.release();
  } catch (error) {
    // unlock 失败的 session 不能回池，否则可能把仍持锁的连接交给下一次请求。
    client.release(true);
    throw error;
  }
}
