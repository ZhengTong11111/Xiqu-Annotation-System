import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import type { CreateAnnotationOperationRequest } from "@xiqu/shared";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";

// 服务端 operation log 的 payload 摘要形状。
// 这里刻意只上传 operation 摘要，不上传完整 ProjectData：
// 当前服务器 snapshot 仍由 /save 保存整份 payload，operation log 只是审计和未来协同同步的地基。
// 如果每条 operation 都存完整 beforeProject/afterProject，一次普通编辑就会把整份项目写进数据库，很快膨胀。
type ServerOperationPayload = {
  localOperationId: string;
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
): CreateAnnotationOperationRequest {
  const payload: ServerOperationPayload = {
    localOperationId: operation.id,
    localCreatedAt: operation.createdAt,
    type: operation.type,
    historyAction: operation.action,
    localBaseRevision: operation.baseRevision,
    hasProjectBeforeAfter: Boolean(operation.beforeProject || operation.afterProject),
    hasTrackSnapBeforeAfter: Boolean(operation.beforeTrackSnapEnabled || operation.afterTrackSnapEnabled),
  };
  // track-snap.update 额外记录哪些轨道的吸附开关变化了，便于后续按轨道维度审查。
  if (operation.type === "track-snap.update") {
    payload.changedTrackIds = diffTrackSnapTrackIds(operation);
  }
  return {
    baseRevision: serverBaseRevision,
    localRevision: operation.localRevision,
    // 服务端 action 字段用 operation.type（如 "project.commit"）；
    // 更细的 historyAction（edit/import-srt 等）放 payload 里。
    action: operation.type,
    payload,
  };
}

function diffTrackSnapTrackIds(operation: ProjectDocumentOperation): string[] {
  const before = operation.beforeTrackSnapEnabled ?? {};
  const after = operation.afterTrackSnapEnabled ?? {};
  const trackIds = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(trackIds).filter((id) => before[id] !== after[id]);
}

// 顺序提交 pending operations 到服务端 operation log。
// 所有 operation 共用同一个 serverBaseRevision：提交期间 snapshot 还没写，baseRevision 不变。
// 不用 Promise.all：服务端要求每条 operation 的 baseRevision 等于当前最新 revision，
// 并发提交会让错误定位变乱；顺序提交便于定位是哪一条失败。
// 若某条 operation 提交遇到 409（说明服务器 snapshot 已被别的会话更新），
// 直接抛出，由调用方进入 conflict 状态，不再继续提交后续 operation。
export async function submitPendingOperations(
  client: PlatformClient,
  annotationFileId: string,
  pendingOperations: ProjectDocumentOperation[],
  serverBaseRevision: number,
  onSubmitted?: (operationId: string) => void,
) {
  const submittedOperationIds: string[] = [];
  for (const operation of pendingOperations) {
    if (operation.syncState !== "pending") {
      continue;
    }
    await client.createAnnotationOperation(
      annotationFileId,
      buildServerOperationRequest(operation, serverBaseRevision),
    );
    submittedOperationIds.push(operation.id);
    // 逐条回调，让调用方即使在后续 operation 失败时，也能知道哪些已经写入服务端。
    onSubmitted?.(operation.id);
  }
  return submittedOperationIds;
}

// 把服务器保存过程中的错误归类为对用户有意义的同步状态。
// - 409：服务器工作区 revision 已变化，需要刷新或处理冲突，不应继续保存。
// - 离线：浏览器判定 navigator.onLine === false，保存未到达服务器。
// - 其他 API 错误（含 403/500 等）或网络异常归为 error。
// 调用方据此 setSyncStatus，不要在失败时调用 markProjectAsSaved。
export function describeServerSaveError(error: unknown): {
  status: "conflict" | "offline" | "error";
  message: string;
} {
  if (error instanceof PlatformApiError) {
    if (error.status === 409) {
      return {
        status: "conflict",
        message: "服务器工作区已有更新，请刷新后处理冲突。",
      };
    }
    if (error.status === 403) {
      return {
        status: "error",
        message: "当前账号没有保存权限。",
      };
    }
    return { status: "error", message: error.message };
  }
  // 非 PlatformApiError 通常是 fetch 失败（TypeError: Failed to fetch）等网络层错误。
  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (isOffline) {
    return {
      status: "offline",
      message: "网络离线，服务器保存未完成。",
    };
  }
  if (error instanceof Error) {
    return { status: "error", message: error.message };
  }
  return { status: "error", message: "保存到服务器失败。" };
}
