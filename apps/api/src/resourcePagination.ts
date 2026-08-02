import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  ListResourcesOptions,
  ResourceListView,
  ResourceSortField,
  ResourceType,
  SortDirection,
} from "@xiqu/shared";

// Cursor 只保存版本、最后一个候选 id 和查询指纹；权限仍由每次请求重新计算。
type ResourceCursorPayload = {
  version: 1;
  resourceId: string;
  queryFingerprint: string;
};

// 规范化上下文排除 limit，使调用方可在翻页时调整页大小而不破坏游标。
export type NormalizedResourceQuery = {
  parentId: string | null;
  view: ResourceListView;
  query: string | null;
  type: ResourceType | null;
  sortBy: ResourceSortField;
  direction: SortDirection;
};

// 纯分页错误由 service 转成统一 400，不把 JSON/base64 实现细节泄漏到路由。
export class ResourceCursorError extends Error {}

// 所有默认值在 cursor 和数据库查询前统一收敛，避免两处对“同一查询”产生不同理解。
export function normalizeResourceQuery(
  options: ListResourcesOptions,
): NormalizedResourceQuery {
  return {
    parentId: options.parentId?.trim() || null,
    view: options.view ?? "children",
    query: options.query?.trim() || null,
    type: options.type ?? null,
    sortBy: options.sortBy ?? "name",
    direction: options.direction ?? "asc",
  };
}

// 指纹使用稳定字段顺序和 sha256，token 不暴露搜索词或目录结构。
export function getResourceQueryFingerprint(
  query: NormalizedResourceQuery,
): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("base64url");
}

// 客户端把 cursor 当作 opaque token；编码内容不承担授权或完整性证明。
export function encodeResourceCursor(
  resourceId: string,
  query: NormalizedResourceQuery,
): string {
  const payload: ResourceCursorPayload = {
    version: 1,
    resourceId,
    queryFingerprint: getResourceQueryFingerprint(query),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// 解码同时绑定当前查询上下文，旧目录/搜索/排序的 cursor 不会静默退回第一页。
export function decodeResourceCursor(
  token: string,
  query: NormalizedResourceQuery,
): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!isResourceCursorPayload(parsed)) {
      throw new ResourceCursorError("资源分页游标格式无效。");
    }
    if (parsed.queryFingerprint !== getResourceQueryFingerprint(query)) {
      throw new ResourceCursorError("资源分页游标不属于当前查询。");
    }
    return parsed.resourceId;
  } catch (error) {
    if (error instanceof ResourceCursorError) throw error;
    throw new ResourceCursorError("资源分页游标格式无效。");
  }
}

// Prisma 排序始终追加 id，令同名、同时间和空 size 资源也形成稳定总序。
export function buildResourceOrderBy(
  query: NormalizedResourceQuery,
): Prisma.ResourceEntryOrderByWithRelationInput[] {
  const direction = query.direction;
  const primary: Prisma.ResourceEntryOrderByWithRelationInput = query.sortBy === "size"
    ? { mediaFile: { size: direction } }
    : { [query.sortBy]: direction };
  return [primary, { id: direction }];
}

// 候选批次有明确上下界；小页不会产生大量往返，大页也不会制造无界 Promise 扇出。
export function getResourceScanBatchSize(limit: number): number {
  return Math.min(Math.max(limit * 2, 50), 200);
}

// 有限并发执行 ACL/祖先检查，保持输入顺序并避免一次启动整个候选全集。
export async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  // worker 数量受当前批次和正整数并发上限共同约束。
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    // 每个 worker 从共享递增索引领取任务；JavaScript 单线程保证领取步骤不会交叉。
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }));
  return results;
}

// Runtime guard 拒绝数组、空 id、未知版本和缺失指纹，避免类型断言掩盖坏 token。
function isResourceCursorPayload(value: unknown): value is ResourceCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.resourceId === "string" &&
    candidate.resourceId.length > 0 &&
    typeof candidate.queryFingerprint === "string" &&
    candidate.queryFingerprint.length > 0;
}
