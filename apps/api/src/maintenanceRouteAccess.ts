import type { FastifyContextConfig } from "fastify";

export type MaintenanceAccess = "read" | "write" | "control";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * 维护模式只冻结持久业务写入；未声明的非安全方法按 write 处理，保证新增路由默认 fail closed。
     */
    maintenanceAccess?: MaintenanceAccess;
  }
}

// 路由声明复用冻结对象，避免各模块手写字符串后出现拼写或语义漂移。
export const MAINTENANCE_READ_ROUTE = Object.freeze({
  config: Object.freeze({ maintenanceAccess: "read" as const }),
});

export const MAINTENANCE_CONTROL_ROUTE = Object.freeze({
  config: Object.freeze({ maintenanceAccess: "control" as const }),
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// HTTP 安全方法默认只读，其他方法默认写入；只有逐项审计的路由才能显式放宽。
export function resolveMaintenanceAccess(
  method: string | string[],
  config?: FastifyContextConfig,
): MaintenanceAccess {
  const declared = config?.maintenanceAccess;
  if (declared) return declared;
  const methods = Array.isArray(method) ? method : [method];
  return methods.every((value) => SAFE_METHODS.has(value.toUpperCase()))
    ? "read"
    : "write";
}
