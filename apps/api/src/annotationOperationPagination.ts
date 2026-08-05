const DEFAULT_OPERATION_PAGE_LIMIT = 100;
export const MAX_OPERATION_PAGE_LIMIT = 200;

type OperationCursorPayload = {
  version: 1;
  annotationFileId: string;
  afterSequence: number;
};

export type NormalizedAnnotationOperationPage = {
  afterSequence: number;
  limit: number;
  sourceCursor: string | null;
};

// 游标错误由 router/repository 统一转换为 400，不泄漏 base64/JSON 实现细节。
export class AnnotationOperationCursorError extends Error {}

// 查询参数先统一收敛默认值和整数边界，再进入数据库；cursor 永远不携带权限事实。
export function normalizeAnnotationOperationPage(input: {
  annotationFileId: string;
  cursor?: unknown;
  limit?: unknown;
}): NormalizedAnnotationOperationPage {
  const limit = input.limit === undefined
    ? DEFAULT_OPERATION_PAGE_LIMIT
    : parseLimit(input.limit);
  if (input.cursor === undefined || input.cursor === null || input.cursor === "") {
    return { afterSequence: 0, limit, sourceCursor: null };
  }
  if (typeof input.cursor !== "string") {
    throw new AnnotationOperationCursorError("标注操作游标格式无效。");
  }
  const payload = decodeAnnotationOperationCursor(input.cursor);
  if (payload.annotationFileId !== input.annotationFileId) {
    throw new AnnotationOperationCursorError("标注操作游标不属于当前文件。");
  }
  return { afterSequence: payload.afterSequence, limit, sourceCursor: input.cursor };
}

// 返回 opaque cursor；客户端只能把它交回同一文件的读取接口，不能自行推导授权或序号。
export function encodeAnnotationOperationCursor(
  annotationFileId: string,
  afterSequence: number,
) {
  const payload: OperationCursorPayload = {
    version: 1,
    annotationFileId,
    afterSequence,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeAnnotationOperationCursor(token: string): OperationCursorPayload {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!isOperationCursorPayload(value)) {
      throw new AnnotationOperationCursorError("标注操作游标格式无效。");
    }
    return value;
  } catch (error) {
    if (error instanceof AnnotationOperationCursorError) throw error;
    throw new AnnotationOperationCursorError("标注操作游标格式无效。");
  }
}

function parseLimit(value: unknown) {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > MAX_OPERATION_PAGE_LIMIT) {
    throw new AnnotationOperationCursorError("标注操作分页数量无效。");
  }
  return Number(parsed);
}

// Runtime guard 使用精确字段和安全整数，未知版本或伪造额外字段一律 fail closed。
function isOperationCursorPayload(value: unknown): value is OperationCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 3 &&
    candidate.version === 1 &&
    typeof candidate.annotationFileId === "string" &&
    candidate.annotationFileId.length > 0 &&
    Number.isSafeInteger(candidate.afterSequence) &&
    Number(candidate.afterSequence) >= 0;
}
