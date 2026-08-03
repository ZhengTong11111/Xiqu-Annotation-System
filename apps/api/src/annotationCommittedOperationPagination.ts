const DEFAULT_COMMITTED_OPERATION_PAGE_LIMIT = 100;
export const MAX_COMMITTED_OPERATION_PAGE_LIMIT = 200;
const MAX_DATABASE_SEQUENCE = 2_147_483_647;

type CommittedOperationCursorPayload = {
  version: 1;
  annotationFileId: string;
  afterCommittedRevision: number;
  afterSequence: number;
};

export type NormalizedCommittedOperationPage = {
  afterCommittedRevision: number;
  afterSequence: number;
  limit: number;
  sourceCursor: string | null;
};

// 已提交 feed 的游标错误统一转为 400，外部不依赖内部 base64url/JSON 结构。
export class AnnotationCommittedOperationCursorError extends Error {}

// 快照 cursor 跳过该 revision 的全部 operation，下一次读取只观察更晚保存事实。
export function encodeAnnotationSnapshotOperationCursor(
  annotationFileId: string,
  revision: number,
) {
  return encodeAnnotationCommittedOperationCursor(
    annotationFileId,
    revision,
    MAX_DATABASE_SEQUENCE,
  );
}

// 页尾 cursor 精确锚定最后一条 `(committedRevision, sequence)`，支持同 revision 分页。
export function encodeAnnotationCommittedOperationCursor(
  annotationFileId: string,
  afterCommittedRevision: number,
  afterSequence: number,
) {
  const payload: CommittedOperationCursorPayload = {
    version: 1,
    annotationFileId,
    afterCommittedRevision,
    afterSequence,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// 查询入口统一处理默认起点、limit 和文件绑定，cursor 永远不携带权限事实。
export function normalizeAnnotationCommittedOperationPage(input: {
  annotationFileId: string;
  cursor?: unknown;
  limit?: unknown;
}): NormalizedCommittedOperationPage {
  const limit = input.limit === undefined
    ? DEFAULT_COMMITTED_OPERATION_PAGE_LIMIT
    : parseLimit(input.limit);
  if (input.cursor === undefined || input.cursor === null || input.cursor === "") {
    return {
      afterCommittedRevision: 0,
      afterSequence: 0,
      limit,
      sourceCursor: null,
    };
  }
  if (typeof input.cursor !== "string") {
    throw new AnnotationCommittedOperationCursorError("已提交操作游标格式无效。");
  }
  const payload = decodeCursor(input.cursor);
  if (payload.annotationFileId !== input.annotationFileId) {
    throw new AnnotationCommittedOperationCursorError("已提交操作游标不属于当前文件。");
  }
  return {
    afterCommittedRevision: payload.afterCommittedRevision,
    afterSequence: payload.afterSequence,
    limit,
    sourceCursor: input.cursor,
  };
}

// Runtime guard 精确限制版本和整数范围，避免伪造 cursor 改变排序语义。
function decodeCursor(token: string): CommittedOperationCursorPayload {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!isCursorPayload(value)) {
      throw new AnnotationCommittedOperationCursorError("已提交操作游标格式无效。");
    }
    return value;
  } catch (error) {
    if (error instanceof AnnotationCommittedOperationCursorError) throw error;
    throw new AnnotationCommittedOperationCursorError("已提交操作游标格式无效。");
  }
}

// limit 只接受 1..200 的整数，拒绝小数、负值和宽松字符串解析。
function parseLimit(value: unknown) {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > MAX_COMMITTED_OPERATION_PAGE_LIMIT) {
    throw new AnnotationCommittedOperationCursorError("已提交操作分页数量无效。");
  }
  return Number(parsed);
}

// cursor 只允许四个已知字段；数据库 Int 边界也在 API 输入边界显式限制。
function isCursorPayload(value: unknown): value is CommittedOperationCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 4 &&
    candidate.version === 1 &&
    typeof candidate.annotationFileId === "string" &&
    candidate.annotationFileId.length > 0 &&
    Number.isInteger(candidate.afterCommittedRevision) &&
    Number(candidate.afterCommittedRevision) >= 0 &&
    Number(candidate.afterCommittedRevision) <= MAX_DATABASE_SEQUENCE &&
    Number.isInteger(candidate.afterSequence) &&
    Number(candidate.afterSequence) >= 0 &&
    Number(candidate.afterSequence) <= MAX_DATABASE_SEQUENCE;
}
