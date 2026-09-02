export const DEFAULT_ANNOTATION_RECOVERY_SNAPSHOT_PAGE_LIMIT = 50;
export const MAX_ANNOTATION_RECOVERY_SNAPSHOT_PAGE_LIMIT = 100;
const RECOVERY_SNAPSHOT_CURSOR_VERSION = 1;
const MAX_RECOVERY_SNAPSHOT_CURSOR_LENGTH = 2_048;

export type AnnotationRecoverySnapshotCursor = {
  annotationFileId: string;
  revision: number;
  createdAt: Date;
  id: string;
};

export type NormalizedAnnotationRecoverySnapshotPage = {
  cursor: AnnotationRecoverySnapshotCursor | null;
  limit: number;
};

// 路由只需把该稳定错误转换成 400，不能把 base64/JSON 解析细节暴露给调用方。
export class AnnotationRecoverySnapshotCursorError extends Error {}

/**
 * cursor 同时绑定文件和完整倒序锚点。revision 正常唯一，时间与 id 仍保留为异常迁移数据的确定性兜底。
 */
export function normalizeAnnotationRecoverySnapshotPage(input: {
  annotationFileId: string;
  cursor?: unknown;
  limit?: unknown;
}): NormalizedAnnotationRecoverySnapshotPage {
  const limit = input.limit === undefined
    ? DEFAULT_ANNOTATION_RECOVERY_SNAPSHOT_PAGE_LIMIT
    : parsePageLimit(input.limit);
  if (input.cursor === undefined) return { cursor: null, limit };
  if (
    typeof input.cursor !== "string" ||
    input.cursor.length < 1 ||
    input.cursor.length > MAX_RECOVERY_SNAPSHOT_CURSOR_LENGTH
  ) {
    throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标无效。");
  }
  const cursor = decodeAnnotationRecoverySnapshotCursor(input.cursor);
  if (cursor.annotationFileId !== input.annotationFileId) {
    throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标不属于当前文件。");
  }
  return { cursor, limit };
}

// 客户端只能把 opaque token 原样交回同一文件接口，不能自行推导历史权限或完整性结论。
export function encodeAnnotationRecoverySnapshotCursor(
  cursor: AnnotationRecoverySnapshotCursor,
) {
  return Buffer.from(JSON.stringify({
    version: RECOVERY_SNAPSHOT_CURSOR_VERSION,
    annotationFileId: cursor.annotationFileId,
    revision: cursor.revision,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

function decodeAnnotationRecoverySnapshotCursor(
  token: string,
): AnnotationRecoverySnapshotCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!isRecord(decoded) || !hasExactKeys(decoded, [
      "version",
      "annotationFileId",
      "revision",
      "createdAt",
      "id",
    ])) {
      throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标无效。");
    }
    if (
      decoded.version !== RECOVERY_SNAPSHOT_CURSOR_VERSION ||
      typeof decoded.annotationFileId !== "string" ||
      decoded.annotationFileId.length < 1 ||
      decoded.annotationFileId.length > 200 ||
      !Number.isSafeInteger(decoded.revision) ||
      Number(decoded.revision) < 1 ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string" ||
      decoded.id.length < 1 ||
      decoded.id.length > 200
    ) {
      throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标无效。");
    }
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) {
      throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标无效。");
    }
    return {
      annotationFileId: decoded.annotationFileId,
      revision: Number(decoded.revision),
      createdAt,
      id: decoded.id,
    };
  } catch (error) {
    if (error instanceof AnnotationRecoverySnapshotCursorError) throw error;
    throw new AnnotationRecoverySnapshotCursorError("恢复历史分页游标无效。");
  }
}

function parsePageLimit(value: unknown) {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isInteger(parsed) ||
    Number(parsed) < 1 ||
    Number(parsed) > MAX_ANNOTATION_RECOVERY_SNAPSHOT_PAGE_LIMIT
  ) {
    throw new AnnotationRecoverySnapshotCursorError(
      `恢复历史分页数量必须是 1 到 ${MAX_ANNOTATION_RECOVERY_SNAPSHOT_PAGE_LIMIT} 的整数。`,
    );
  }
  return Number(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}
