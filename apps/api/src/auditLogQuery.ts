import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  AuditLogEntry,
  ListAuditLogsOptions,
} from "@xiqu/shared";

// 审计分页游标只保存稳定排序锚点和查询指纹，不承担授权或防篡改证明。
type AuditLogCursorPayload = {
  version: 1;
  createdAt: string;
  id: string;
  queryFingerprint: string;
};

// 规范查询把浏览器可选字符串收敛为数据库和游标共同使用的唯一语义。
export type NormalizedAuditLogQuery = {
  resourceId: string | null;
  actorUserId: string | null;
  targetUserId: string | null;
  action: ListAuditLogsOptions["action"] | null;
  createdFrom: Date | null;
  createdTo: Date | null;
};

export type AuditLogCursor = {
  createdAt: Date;
  id: string;
};

export class AuditLogQueryError extends Error {}

// 空筛选统一变为 null；时间范围在进入 Prisma 前完成合法性和先后顺序校验。
export function normalizeAuditLogQuery(
  options: ListAuditLogsOptions,
): NormalizedAuditLogQuery {
  const createdFrom = parseOptionalAuditTime(options.createdFrom, "开始时间");
  const createdTo = parseOptionalAuditTime(options.createdTo, "结束时间");
  if (createdFrom && createdTo && createdFrom.getTime() > createdTo.getTime()) {
    throw new AuditLogQueryError("审计日志开始时间不能晚于结束时间。");
  }
  return {
    resourceId: normalizeOptionalId(options.resourceId),
    actorUserId: normalizeOptionalId(options.actorUserId),
    targetUserId: normalizeOptionalId(options.targetUserId),
    action: options.action ?? null,
    createdFrom,
    createdTo,
  };
}

// 指纹排除 limit/cursor，使翻页时调整每页数量不会把同一查询误判为另一查询。
export function getAuditLogQueryFingerprint(
  query: NormalizedAuditLogQuery,
): string {
  const serialized = {
    resourceId: query.resourceId,
    actorUserId: query.actorUserId,
    targetUserId: query.targetUserId,
    action: query.action,
    createdFrom: query.createdFrom?.toISOString() ?? null,
    createdTo: query.createdTo?.toISOString() ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(serialized))
    .digest("base64url");
}

// 下一页游标使用 createdAt + id 复合锚点，保证同一毫秒产生的多条日志也不会漏项或重复。
export function encodeAuditLogCursor(
  cursor: AuditLogCursor,
  query: NormalizedAuditLogQuery,
): string {
  const payload: AuditLogCursorPayload = {
    version: 1,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
    queryFingerprint: getAuditLogQueryFingerprint(query),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// 解码时同时验证格式和查询上下文，旧筛选的游标不能静默用于新筛选。
export function decodeAuditLogCursor(
  token: string,
  query: NormalizedAuditLogQuery,
): AuditLogCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    );
    if (!isAuditLogCursorPayload(parsed)) {
      throw new AuditLogQueryError("审计日志分页游标格式无效。");
    }
    if (parsed.queryFingerprint !== getAuditLogQueryFingerprint(query)) {
      throw new AuditLogQueryError("审计日志分页游标不属于当前筛选。");
    }
    const createdAt = new Date(parsed.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt
    ) {
      throw new AuditLogQueryError("审计日志分页游标格式无效。");
    }
    return { createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof AuditLogQueryError) throw error;
    throw new AuditLogQueryError("审计日志分页游标格式无效。");
  }
}

// 列表与导出共用同一个 Prisma 条件；游标只附加严格小于复合排序锚点的范围。
export function buildAuditLogWhere(
  query: NormalizedAuditLogQuery,
  cursor: AuditLogCursor | null = null,
): Prisma.AuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (query.createdFrom) createdAt.gte = query.createdFrom;
  if (query.createdTo) createdAt.lte = query.createdTo;
  const filters: Prisma.AuditLogWhereInput[] = [
    {
      resourceId: query.resourceId ?? undefined,
      actorUserId: query.actorUserId ?? undefined,
      targetUserId: query.targetUserId ?? undefined,
      action: query.action ?? undefined,
      createdAt: Object.keys(createdAt).length ? createdAt : undefined,
    },
  ];
  if (cursor) {
    filters.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }
  return { AND: filters };
}

// CSV 使用固定列和稳定 JSON，便于离线审计时比较文件而不受对象键插入顺序影响。
export function buildAuditLogCsv(entries: readonly AuditLogEntry[]): string {
  const header = [
    "时间",
    "动作",
    "执行账号",
    "执行账号 ID",
    "资源",
    "资源 ID",
    "文件对象 ID",
    "目标账号",
    "目标账号 ID",
    "详情",
    "审计 ID",
  ];
  const lines = entries.map((entry) => [
    entry.createdAt,
    entry.action,
    entry.actor
      ? `${entry.actor.displayName} (${entry.actor.accountName})`
      : "",
    entry.actorUserId ?? "",
    entry.resource?.name ?? "",
    entry.resourceId ?? "",
    entry.fileId ?? "",
    entry.targetUser
      ? `${entry.targetUser.displayName} (${entry.targetUser.accountName})`
      : "",
    entry.targetUserId ?? "",
    stableJsonStringify(entry.detail),
    entry.id,
  ]);
  return `\uFEFF${[header, ...lines]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n")}\r\n`;
}

// 公式前缀即使前面带空白也先加文本标记；随后统一引用并转义双引号与换行。
export function escapeCsvCell(value: unknown): string {
  const normalized = String(value ?? "").replaceAll("\0", "");
  const formulaSafe = /^\s*[=+\-@]/.test(normalized)
    ? `'${normalized}`
    : normalized;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

// detail 来自 JSON 列，但仍以容错方式排序和序列化，坏历史值不能中断整批导出。
export function stableJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value)) ?? "";
  } catch {
    return "";
  }
}

// 递归排序只处理可序列化 JSON 结构，数组顺序保持业务原义。
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

// ISO 时间必须能往返标准化，拒绝浏览器实现相关的宽松日期文本。
function parseOptionalAuditTime(
  value: string | undefined,
  label: string,
): Date | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  // 接受带 Z 或显式时区偏移的 ISO 日期时间；拒绝依赖运行环境解释的日期和本地时间文本。
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const parsed = new Date(normalized);
  if (!isoDateTime.test(normalized) || Number.isNaN(parsed.getTime())) {
    throw new AuditLogQueryError(`${label}必须是有效的 ISO 时间。`);
  }
  return parsed;
}

// 标识筛选去除外围空白，空字符串不能形成与 null 不同的游标上下文。
function normalizeOptionalId(value: string | undefined): string | null {
  return value?.trim() || null;
}

// 游标 guard 拒绝数组、未知版本、空 id 和缺失查询指纹。
function isAuditLogCursorPayload(value: unknown): value is AuditLogCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.queryFingerprint === "string" &&
    candidate.queryFingerprint.length > 0;
}
