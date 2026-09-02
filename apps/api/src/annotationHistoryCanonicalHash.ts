import { createHash } from "node:crypto";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";

export const ANNOTATION_HISTORY_CANONICAL_HASH_VERSION = "canonical-json-sha256-v1" as const;

/**
 * 恢复历史与 operation 幂等请求共用同一稳定 JSON 语义：对象 key 排序、数组顺序保留。
 * 这样 HC1 的 dry-run hash 不会形成第二套“规范化 JSON”，也不会因普通 key 顺序差异误报。
 */
export function createAnnotationHistoryCanonicalHash(value: unknown) {
  return createHash("sha256")
    .update(stableJsonStringify(value))
    .digest("hex");
}

export function measureAnnotationHistoryJsonBytes(value: unknown) {
  return Buffer.byteLength(stableJsonStringify(value), "utf8");
}
