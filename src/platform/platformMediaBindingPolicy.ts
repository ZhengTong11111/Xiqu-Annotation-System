import type { ProjectSyncStatus } from "../state/projectDocumentState";

export type PlatformMediaBindingFacts = {
  canWrite: boolean;
  hasUnsavedChanges: boolean;
  pendingOperationCount: number;
  hasTransientEdit: boolean;
  hasInlineEdit: boolean;
  hasPendingMergeDraft: boolean;
  syncStatus: ProjectSyncStatus;
  saveInFlight: boolean;
  appliedRemoteRevision: number;
  observedRemoteRevision: number;
};

// 平台媒体关系独立于标注正文，只能在 clean 边界替换运行时媒体，不能覆盖尚未保存的标注状态。
export function getPlatformMediaBindingBlockReason(
  facts: PlatformMediaBindingFacts,
): string | undefined {
  if (!facts.canWrite) return "当前文件为只读状态，不能修改关联媒体。";
  if (facts.hasPendingMergeDraft) return "请先应用或取消待处理的标注整合。";
  if (facts.hasInlineEdit) return "请先结束当前文字编辑。";
  if (facts.hasTransientEdit) return "请先结束当前拖拽或尺寸调整。";
  if (facts.hasUnsavedChanges || facts.pendingOperationCount > 0) {
    return "请先保存当前标注修改，再关联服务器媒体。";
  }
  if (facts.saveInFlight || facts.syncStatus === "saving") return "正在保存标注，请稍候。";
  if (facts.syncStatus === "conflict") return "请先处理服务器版本冲突。";
  if (facts.syncStatus === "offline") return "当前处于离线状态，无法关联服务器媒体。";
  if (facts.syncStatus === "error") return "当前同步状态异常，请先处理或重新打开文件。";
  if (facts.observedRemoteRevision > facts.appliedRemoteRevision) {
    return "正在接收其他账号的修改，请等待同步完成。";
  }
  return undefined;
}
