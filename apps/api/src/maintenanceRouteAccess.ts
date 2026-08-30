import type { FastifyContextConfig, FastifyInstance } from "fastify";

export type MaintenanceAccess = "read" | "write" | "control";

export type MaintenanceRouteManifestEntry = {
  method: string;
  path: string;
  access: MaintenanceAccess;
  explicit: boolean;
};

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
const ROUTE_MANIFESTS = new WeakMap<FastifyInstance, Map<string, MaintenanceRouteManifestEntry>>();

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

// manifest 只记录 Fastify 已注册的路由事实，供测试与后续诊断审计；运行时门禁仍只调用上面的 resolver。
export function attachMaintenanceRouteManifest(app: FastifyInstance) {
  if (ROUTE_MANIFESTS.has(app)) {
    throw new Error("同一 Fastify 应用不能重复注册维护路由清单。");
  }
  const entries = new Map<string, MaintenanceRouteManifestEntry>();
  ROUTE_MANIFESTS.set(app, entries);
  return (
    method: string | string[],
    path: string,
    config?: FastifyContextConfig,
  ) => {
    const methods = [...new Set(
      (Array.isArray(method) ? method : [method]).map((value) => value.toUpperCase()),
    )].sort();
    const explicit = config?.maintenanceAccess !== undefined;
    const access = resolveMaintenanceAccess(method, config);
    for (const normalizedMethod of methods) {
      const key = `${normalizedMethod} ${path}`;
      const existing = entries.get(key);
      if (existing && existing.access !== access) {
        // 同一 method/path 出现不同维护语义时不能猜测 winner，否则注册顺序会改变维护安全边界。
        throw new Error(`路由 ${key} 声明了冲突的维护访问语义。`);
      }
      entries.set(key, {
        method: normalizedMethod,
        path,
        access,
        explicit: existing?.explicit === true || explicit,
      });
    }
  };
}

// 返回冻结副本并稳定排序，避免调用方改写运行中记录或因注册顺序产生无意义快照差异。
export function getMaintenanceRouteManifest(app: FastifyInstance) {
  const entries = ROUTE_MANIFESTS.get(app);
  if (!entries) return Object.freeze([]) as readonly MaintenanceRouteManifestEntry[];
  return Object.freeze([...entries.values()]
    .sort((left, right) =>
      left.path.localeCompare(right.path) || left.method.localeCompare(right.method))
    .map((entry) => Object.freeze({ ...entry })));
}
