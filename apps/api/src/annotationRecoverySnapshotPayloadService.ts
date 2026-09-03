import type { Prisma } from "@prisma/client";
import type { ProjectData } from "@xiqu/document-model";
import {
  reconstructAnnotationHistoryPayload,
  type AnnotationHistoryReconstructionCode,
} from "./annotationHistoryReconstruction.js";
import {
  loadAnnotationHistoryReconstructionFacts,
  type AnnotationHistoryReconstructionFactLoadCode,
  type AnnotationHistoryStoredRecipeColumns,
} from "./annotationHistoryReconstructionFacts.js";
import {
  resolveAnnotationRecoverySnapshotPayload,
  type AnnotationRecoverySnapshotResolutionCode,
} from "./annotationRecoverySnapshotResolver.js";

export type AnnotationRecoverySnapshotAsyncResolutionCode =
  | AnnotationRecoverySnapshotResolutionCode
  | AnnotationHistoryReconstructionFactLoadCode
  | AnnotationHistoryReconstructionCode
  | "snapshot_compaction_incomplete"
  | "snapshot_payload_state_invalid"
  | "snapshot_payload_missing";

export type AnnotationRecoverySnapshotPayloadRow<TPayload = unknown> = AnnotationHistoryStoredRecipeColumns & {
  id: string;
  annotationFileId: string;
  revision: number;
  storageMode: string;
  payload: TPayload | null;
  compactedAt: Date | null;
};

export type AnnotationRecoverySnapshotAsyncResolution<TPayload> =
  | { ok: true; payload: TPayload }
  | {
      ok: false;
      code: AnnotationRecoverySnapshotAsyncResolutionCode;
      snapshotId: string;
      annotationFileId: string;
      revision: number;
    };

/**
 * 统一协调恢复快照的两种持久化形态读取。数据库 CHECK 已保证新行的字段互斥，
 * 这里仍逐项 fail closed，防止旧 release、手工数据或部分恢复暴露近似内容。
 * 数据库事实与内容证明分别委托给 HC3b2a loader 和 HC3b1 纯内核，本层不复制查询或重放逻辑。
 */
export async function resolveAnnotationRecoverySnapshotPayloadAsync<TPayload>(input: {
  transaction: Prisma.TransactionClient;
  row: AnnotationRecoverySnapshotPayloadRow<TPayload>;
}): Promise<AnnotationRecoverySnapshotAsyncResolution<TPayload | ProjectData>> {
  const { row } = input;
  if (row.storageMode === "inline") {
    if (row.payload === null) return failed(row, "snapshot_payload_missing");
    return resolveAnnotationRecoverySnapshotPayload({
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      storageMode: row.storageMode,
      payload: row.payload,
      payloadSha256: row.payloadSha256,
    });
  }
  if (row.storageMode !== "reconstructible") {
    return failed(row, "snapshot_storage_mode_unsupported");
  }
  // 未来 contract migration 必须原子形成“正文为空 + 已压缩时间”；半迁移行不能靠 recipe 侥幸读取。
  if (row.payload !== null) return failed(row, "snapshot_payload_state_invalid");
  if (row.compactedAt === null) return failed(row, "snapshot_compaction_incomplete");

  const facts = await loadAnnotationHistoryReconstructionFacts(
    input.transaction,
    row.annotationFileId,
    row,
  );
  if (!facts.ok) return failed(row, facts.code);
  const reconstruction = reconstructAnnotationHistoryPayload({
    annotationFileId: row.annotationFileId,
    expectedTargetSnapshotId: row.id,
    checkpoint: facts.checkpoint,
    target: row,
    // reconstructible 读取必须仅依赖 checkpoint + operation；目标正文未来会为空。
    operations: facts.operations,
    expectedRecipe: facts.recipe,
  });
  if (!reconstruction.ok) return failed(row, reconstruction.code);
  return { ok: true, payload: reconstruction.payload };
}

function failed(
  row: Pick<AnnotationRecoverySnapshotPayloadRow, "id" | "annotationFileId" | "revision">,
  code: AnnotationRecoverySnapshotAsyncResolutionCode,
): AnnotationRecoverySnapshotAsyncResolution<never> {
  return {
    ok: false,
    code,
    snapshotId: row.id,
    annotationFileId: row.annotationFileId,
    revision: row.revision,
  };
}
