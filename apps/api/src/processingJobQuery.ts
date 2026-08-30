import { createHash } from "node:crypto";
import {
  PROCESSING_JOB_STATUSES,
  PROCESSING_JOB_TYPES,
  type ListProcessingJobsOptions,
  type ProcessingJobScope,
  type ProcessingJobStatus,
  type ProcessingJobType,
} from "@xiqu/shared";

const SCOPES = new Set<ProcessingJobScope>(["mine", "related", "all"]);
const STATUSES = new Set<ProcessingJobStatus>(PROCESSING_JOB_STATUSES);
const TYPES = new Set<ProcessingJobType>(PROCESSING_JOB_TYPES);

export type NormalizedProcessingJobQuery = {
  scope: ProcessingJobScope;
  status: ProcessingJobStatus | null;
  type: ProcessingJobType | null;
  limit: number;
};

export type ProcessingJobCursor = {
  requestedAt: Date;
  id: string;
};

type CursorPayload = {
  version: 1;
  requestedAt: string;
  id: string;
  queryFingerprint: string;
};

export class ProcessingJobQueryError extends Error {}

/** 查询参数在进入 Prisma 前收敛成有限枚举和固定分页上限。 */
export function normalizeProcessingJobQuery(
  options: ListProcessingJobsOptions,
): NormalizedProcessingJobQuery {
  const scope = options.scope ?? "mine";
  if (!SCOPES.has(scope)) throw new ProcessingJobQueryError("后台任务范围不正确。");
  if (options.status !== undefined && !STATUSES.has(options.status)) {
    throw new ProcessingJobQueryError("后台任务状态不正确。");
  }
  if (options.type !== undefined && !TYPES.has(options.type)) {
    throw new ProcessingJobQueryError("后台任务类型不正确。");
  }
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ProcessingJobQueryError("后台任务每页数量必须在 1 到 100 之间。");
  }
  return {
    scope,
    status: options.status ?? null,
    type: options.type ?? null,
    limit,
  };
}

export function encodeProcessingJobCursor(
  cursor: ProcessingJobCursor,
  query: NormalizedProcessingJobQuery,
) {
  const payload: CursorPayload = {
    version: 1,
    requestedAt: cursor.requestedAt.toISOString(),
    id: cursor.id,
    queryFingerprint: getQueryFingerprint(query),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 游标绑定筛选指纹，旧范围或状态的锚点不能静默用于新查询。 */
export function decodeProcessingJobCursor(
  token: string,
  query: NormalizedProcessingJobQuery,
): ProcessingJobCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!isCursorPayload(parsed) || parsed.queryFingerprint !== getQueryFingerprint(query)) {
      throw new ProcessingJobQueryError("后台任务分页游标无效，请刷新第一页。");
    }
    const requestedAt = new Date(parsed.requestedAt);
    if (Number.isNaN(requestedAt.getTime()) || requestedAt.toISOString() !== parsed.requestedAt) {
      throw new ProcessingJobQueryError("后台任务分页游标无效，请刷新第一页。");
    }
    return { requestedAt, id: parsed.id };
  } catch (error) {
    if (error instanceof ProcessingJobQueryError) throw error;
    throw new ProcessingJobQueryError("后台任务分页游标无效，请刷新第一页。");
  }
}

function getQueryFingerprint(query: NormalizedProcessingJobQuery) {
  return createHash("sha256").update(JSON.stringify({
    scope: query.scope,
    status: query.status,
    type: query.type,
  })).digest("base64url");
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as CursorPayload).version === 1 &&
    typeof (value as CursorPayload).requestedAt === "string" &&
    typeof (value as CursorPayload).id === "string" &&
    (value as CursorPayload).id.length > 0 &&
    (value as CursorPayload).id.length <= 200 &&
    typeof (value as CursorPayload).queryFingerprint === "string",
  );
}
