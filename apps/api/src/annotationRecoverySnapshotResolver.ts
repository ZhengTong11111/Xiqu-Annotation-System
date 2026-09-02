import { createAnnotationHistoryCanonicalHash } from "./annotationHistoryCanonicalHash.js";

export type AnnotationRecoverySnapshotResolutionCode =
  | "snapshot_payload_hash_mismatch"
  | "snapshot_storage_mode_unsupported";

export type AnnotationRecoverySnapshotResolvableRow<TPayload = unknown> = {
  id: string;
  annotationFileId: string;
  revision: number;
  storageMode: string;
  payload: TPayload;
  payloadSha256: string | null;
};

export type AnnotationRecoverySnapshotResolution<TPayload> =
  | { ok: true; payload: TPayload }
  | {
      ok: false;
      code: AnnotationRecoverySnapshotResolutionCode;
      snapshotId: string;
      annotationFileId: string;
      revision: number;
    };

/**
 * 统一解析恢复快照的持久化形态。inline 分支刻意不调用当前 ProjectData parser：历史快照允许保存旧版包装结构
 * 或任意合法 JSON，详情和恢复必须保持其原始 JSON 语义，不能借读取动作补默认值或删除未知字段。
 */
export function resolveAnnotationRecoverySnapshotPayload<TPayload>(
  row: AnnotationRecoverySnapshotResolvableRow<TPayload>,
): AnnotationRecoverySnapshotResolution<TPayload> {
  if (row.storageMode !== "inline") {
    return {
      ok: false,
      code: "snapshot_storage_mode_unsupported",
      snapshotId: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
    };
  }

  // HC2a 不回填历史 hash；一旦某行带有 hash，就必须在返回或恢复前完成完整性校验。
  if (
    row.payloadSha256 !== null &&
    createAnnotationHistoryCanonicalHash(row.payload) !== row.payloadSha256
  ) {
    return {
      ok: false,
      code: "snapshot_payload_hash_mismatch",
      snapshotId: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
    };
  }

  // 返回同一个 JSON 值而不是克隆或规范化，使旧版 payload 保持数据库读取时的精确结构。
  return { ok: true, payload: row.payload };
}
