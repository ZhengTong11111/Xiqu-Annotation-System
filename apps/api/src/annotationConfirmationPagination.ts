const CURSOR_VERSION = 1;

export type AnnotationConfirmationCursor = {
  annotationFileId: string;
  createdAt: Date;
  id: string;
};

// 确认游标绑定文件与复合排序锚点；它只是续页位置，不能承载权限或可信业务事实。
export function encodeAnnotationConfirmationCursor(cursor: AnnotationConfirmationCursor) {
  return Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    annotationFileId: cursor.annotationFileId,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), "utf8").toString("base64url");
}

export function decodeAnnotationConfirmationCursor(
  value: string,
  expectedAnnotationFileId: string,
): AnnotationConfirmationCursor | null {
  if (!value || value.length > 2_048) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(decoded)) return null;
    if (
      decoded.version !== CURSOR_VERSION ||
      decoded.annotationFileId !== expectedAnnotationFileId ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string" ||
      decoded.id.length < 1 ||
      decoded.id.length > 200
    ) return null;
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return null;
    return { annotationFileId: expectedAnnotationFileId, createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
