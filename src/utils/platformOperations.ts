import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import type { CreateAnnotationOperationRequest } from "@xiqu/shared";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";

// legacy operation log 的 payload 摘要形状；领域命令直接发送 shared versioned envelope。
// 这里刻意只上传 operation 摘要，不上传完整 ProjectData：
// 当前服务器 snapshot 仍由 /save 保存整份 payload，operation log 只是审计和未来协同同步的地基。
// 如果每条 operation 都存完整 beforeProject/afterProject，一次普通编辑就会把整份项目写进数据库，很快膨胀。
type ServerOperationPayload = {
  localCreatedAt: number;
  type: ProjectDocumentOperation["type"];
  historyAction: ProjectDocumentOperation["action"];
  localBaseRevision: number;
  hasProjectBeforeAfter: boolean;
  hasTrackSnapBeforeAfter: boolean;
  changedTrackIds?: string[];
};

// 把本地 ProjectDocumentOperation 转成服务端 operation log 请求。
// 注意：请求里的 baseRevision 用的是「服务器当前 snapshot revision」(serverBaseRevision)，
// 而不是 operation.baseRevision——后者是本地记录 operation 时的 local revision，两者语义不同。
export function buildServerOperationRequest(
  operation: ProjectDocumentOperation,
  serverBaseRevision: number,
  mutationLeaseToken?: string,
): CreateAnnotationOperationRequest {
  // 已迁移操作保留稳定目标和 before/after，服务端会校验 action 与 envelope 一致。
  if (operation.commandEnvelope) {
    return {
      clientOperationId: operation.id,
      baseRevision: serverBaseRevision,
      localRevision: operation.localRevision,
      action: operation.commandEnvelope.command.type,
      payload: operation.commandEnvelope,
      ...(mutationLeaseToken ? { mutationLeaseToken } : {}),
    };
  }
  const payload: ServerOperationPayload = {
    localCreatedAt: operation.createdAt,
    type: operation.type,
    historyAction: operation.action,
    localBaseRevision: operation.baseRevision,
    hasProjectBeforeAfter: operation.summary.hasProjectChange,
    hasTrackSnapBeforeAfter: operation.summary.hasTrackSnapChange,
  };
  // track-snap.update 额外记录哪些轨道的吸附开关变化了，便于后续按轨道维度审查。
  if (operation.type === "track-snap.update") {
    payload.changedTrackIds = operation.summary.changedTrackIds ?? [];
  }
  return {
    // 本地稳定 id 是服务端一等幂等键；网络响应丢失后的重试不会再插入重复 operation。
    clientOperationId: operation.id,
    baseRevision: serverBaseRevision,
    localRevision: operation.localRevision,
    // 服务端 action 字段用 operation.type（如 "project.commit"）；
    // 更细的 historyAction（edit/import-srt 等）放 payload 里。
    action: operation.type,
    payload,
    ...(mutationLeaseToken ? { mutationLeaseToken } : {}),
  };
}

// 顺序提交 pending operations 到服务端 operation log。
// 所有 operation 共用同一个 serverBaseRevision：提交期间 snapshot 还没写，baseRevision 不变。
// 不用 Promise.all：服务端要求每条 operation 的 baseRevision 等于当前最新 revision，
// 并发提交会让错误定位变乱；顺序提交便于定位是哪一条失败。
// 若某条 operation 提交遇到 409（说明服务器 snapshot 已被别的会话更新），
// 直接抛出，由调用方进入 conflict 状态，不再继续提交后续 operation。
export async function submitLegacyPendingOperations(
  client: PlatformClient,
  annotationFileId: string,
  pendingOperations: ProjectDocumentOperation[],
  serverBaseRevision: number,
  onSubmitted?: (operationId: string) => void,
  mutationLeaseToken?: string,
) {
  const submittedOperationIds: string[] = [];
  for (const operation of pendingOperations) {
    if (operation.syncState !== "pending") {
      continue;
    }
    await client.createAnnotationOperation(
      annotationFileId,
      buildServerOperationRequest(operation, serverBaseRevision, mutationLeaseToken),
    );
    submittedOperationIds.push(operation.id);
    // 逐条回调，让调用方即使在后续 operation 失败时，也能知道哪些已经写入服务端。
    onSubmitted?.(operation.id);
  }
  return submittedOperationIds;
}

export type PlatformSaveOutcome =
  | { status: "saved" }
  | { status: "rebased"; message: string }
  | {
      status: "skipped";
      reason: "not-platform" | "read-only" | "clean" | "busy" | "transient-edit";
    }
  | { status: "offline"; retryable: true; message: string }
  | { status: "conflict"; retryable: false; message: string }
  | { status: "error"; retryable: boolean; message: string };

// 把服务器保存过程中的错误归类为对用户有意义、且可供自动调度器判断的同步结果。
// - 409：服务器工作区 revision 已变化，需要刷新或处理冲突，不应继续保存。
// - 离线：浏览器判定 navigator.onLine === false，保存未到达服务器。
// - 408/429/5xx 与 fetch TypeError 可退避重试；确定的 4xx 与未知程序错误不盲重试。
// 调用方据此 setSyncStatus，不要在失败时调用 markProjectAsSaved。
export function describeServerSaveError(error: unknown): Exclude<
  PlatformSaveOutcome,
  { status: "saved" | "rebased" | "skipped" }
> {
  if (error instanceof PlatformApiError) {
    if (error.status === 409) {
      const detailCode = getPlatformErrorDetailCode(error.details);
      if (detailCode?.startsWith("annotation_mutation_lease_")) {
        return {
          status: "error",
          retryable: false,
          message: `${error.message} 本地草稿仍已保留，请重新取得结构编辑锁后再保存。`,
        };
      }
      return {
        status: "conflict",
        retryable: false,
        message: "服务器工作区已有更新，请刷新后处理冲突。",
      };
    }
    if (error.status === 403) {
      return {
        status: "error",
        retryable: false,
        message: "当前账号没有保存权限。",
      };
    }
    return {
      status: "error",
      retryable: error.status === 408 || error.status === 429 || error.status >= 500,
      message: error.message,
    };
  }
  // 非 PlatformApiError 通常是 fetch 失败（TypeError: Failed to fetch）等网络层错误。
  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (isOffline) {
    return {
      status: "offline",
      retryable: true,
      message: "网络离线，服务器保存未完成。",
    };
  }
  if (error instanceof TypeError) {
    return { status: "error", retryable: true, message: error.message };
  }
  if (error instanceof Error) {
    return { status: "error", retryable: false, message: error.message };
  }
  return {
    status: "error",
    retryable: false,
    message: "保存到服务器失败。",
  };
}

function getPlatformErrorDetailCode(details: unknown) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const code = (details as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}
