import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type {
  PlatformMaintenanceStatus,
  SetPlatformMaintenanceRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, forbidden, maintenanceMode } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

// 维护许可使用独立于资源树锁的固定 int64 key；所有 API 实例连接同一数据库即可共享边界。
const MAINTENANCE_ADVISORY_LOCK_KEY = "6361718588744490068";
const RUNTIME_STATE_ID = "platform";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type WritePermit = {
  release: () => Promise<void>;
};

// coordinator 用共享锁覆盖完整写请求，用独占锁完成“排空在途写入后进入维护”的原子切换。
export class MaintenanceCoordinator {
  private readonly requestPermits = new WeakMap<FastifyRequest, WritePermit>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly lockPool: Pool,
    private readonly access: ResourceAccessService,
  ) {}

  // Fastify gate 放在业务 handler 之前；任何失败都 fail closed，不允许在状态未知时继续写入。
  registerRequestGate(app: FastifyInstance) {
    app.addHook("onRequest", async (request) => {
      if (SAFE_METHODS.has(request.method) || isMaintenanceMutation(request)) {
        return;
      }
      const permit = await this.acquireWritePermit();
      this.requestPermits.set(request, permit);
    });
    app.addHook("onResponse", async (request) => {
      await this.releaseRequestPermit(request);
    });
    // 客户端中途断开时未必能走到普通响应路径；abort hook 复用幂等释放，避免长期占用共享锁。
    app.addHook("onRequestAbort", async (request) => {
      await this.releaseRequestPermit(request);
    });
  }

  async acquireWritePermit(): Promise<WritePermit> {
    const client = await this.lockPool.connect();
    let locked = false;
    let released = false;
    // permit 生命周期由当前专用连接承载；幂等释放同时防止 active/error 分支重复归还连接。
    const release = async () => {
      if (released) return;
      released = true;
      if (locked) {
        locked = false;
        await unlockAndRelease(client, "shared");
      } else {
        client.release();
      }
    };
    try {
      await client.query(
        "SELECT pg_advisory_lock_shared($1::bigint)",
        [MAINTENANCE_ADVISORY_LOCK_KEY],
      );
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
      return {
        // release 幂等，避免未来新增 error hook 时与 onResponse 重复解锁。
        release,
      };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
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
    const client = await this.lockPool.connect();
    let locked = false;
    let operationError: unknown;
    try {
      // 独占锁会等待所有已通过 gate 的写请求响应完成；拿到锁后才允许持久化 active。
      await client.query(
        "SELECT pg_advisory_lock($1::bigint)",
        [MAINTENANCE_ADVISORY_LOCK_KEY],
      );
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

  // 响应完成与请求中断共用这一出口；先从 WeakMap 删除，保证两个 hook 竞争时只释放一次。
  private async releaseRequestPermit(request: FastifyRequest) {
    const permit = this.requestPermits.get(request);
    if (!permit) return;
    this.requestPermits.delete(request);
    try {
      await permit.release();
    } catch (error) {
      // 请求生命周期已经结束，无法再改变响应；记录错误且 helper 已销毁可疑数据库连接。
      request.log.error(error, "释放维护写许可失败");
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
    if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以切换平台维护状态。");
    }
  }
}

// 只有专用维护 mutation 可绕过共享 permit；路径比较忽略 query，但不放宽其他管理员命令。
function isMaintenanceMutation(request: FastifyRequest) {
  return request.method === "POST" &&
    request.url.split("?", 1)[0] === "/api/admin/maintenance";
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
