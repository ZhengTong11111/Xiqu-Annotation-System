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

const reconstructibleReadCapabilityBrand = Symbol("annotation-history-reconstructible-read-candidate");

export type AnnotationHistoryReconstructibleReadCapability = Readonly<{
  [reconstructibleReadCapabilityBrand]: true;
}>;

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
 * 仅供隔离测试证明未来 reconstructible 读取合同；生产代码在正式迁移授权前不得创建或传递该能力。
 * Symbol 品牌不会经过 JSON、HTTP 或环境变量传播，避免把候选模式误做成隐式运行时开关。
 */
export function createAnnotationHistoryReconstructibleReadTestCapability():
AnnotationHistoryReconstructibleReadCapability {
  return Object.freeze({ [reconstructibleReadCapabilityBrand]: true });
}

/**
 * 统一协调恢复快照的存储形态读取。默认只接受 inline；候选重建路径必须显式持有测试能力。
 * 数据库事实与内容证明分别委托给 HC3b2a loader 和 HC3b1 纯内核，本层不复制查询或重放逻辑。
 */
export async function resolveAnnotationRecoverySnapshotPayloadAsync<TPayload>(input: {
  transaction: Prisma.TransactionClient;
  row: AnnotationRecoverySnapshotPayloadRow<TPayload>;
  reconstructibleCapability?: AnnotationHistoryReconstructibleReadCapability;
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
  if (
    row.storageMode !== "reconstructible" ||
    input.reconstructibleCapability?.[reconstructibleReadCapabilityBrand] !== true
  ) {
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
