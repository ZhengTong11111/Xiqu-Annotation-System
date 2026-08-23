const CURSOR_VERSION = 1;

export type AnnotationRangeCommentCursor = {
  annotationFileId: string;
  includeWithdrawn: boolean;
  createdAt: Date;
  id: string;
};

// 游标绑定文件与撤回筛选，防止客户端把一个列表的游标误用于另一权限上下文。
export function encodeAnnotationRangeCommentCursor(cursor: AnnotationRangeCommentCursor) {
  return Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    annotationFileId: cursor.annotationFileId,
    includeWithdrawn: cursor.includeWithdrawn,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

export function decodeAnnotationRangeCommentCursor(
  value: string,
  expected: Pick<AnnotationRangeCommentCursor, "annotationFileId" | "includeWithdrawn">,
): AnnotationRangeCommentCursor | null {
  if (!value || value.length > 2_048) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(decoded)) return null;
    if (
      decoded.version !== CURSOR_VERSION ||
      decoded.annotationFileId !== expected.annotationFileId ||
      decoded.includeWithdrawn !== expected.includeWithdrawn ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string" ||
      decoded.id.length < 1 ||
      decoded.id.length > 200
    ) return null;
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return null;
    return { ...expected, createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
