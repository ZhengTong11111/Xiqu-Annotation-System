import type { ProjectSyncStatus } from "../state/projectDocumentState";

export type PlatformRemoteEditGateFacts = {
  observedRemoteRevision: number;
  appliedRemoteRevision: number;
  hasUnsavedChanges: boolean;
  pendingOperationCount: number;
  hasTransientEdit: boolean;
  hasInlineEdit: boolean;
  hasPendingMergeDraft: boolean;
  syncStatus: ProjectSyncStatus;
};

// 远端 revision 已知但尚未进入本地 ProjectData 时，干净客户端不能再从旧快照开始一次新编辑。
// 已经开始的本地编辑不在这里中断；那属于真实并发，后续仍由命令前置条件与冲突流程裁决。
export function shouldBlockEditingForRemoteCatchUp(
  facts: PlatformRemoteEditGateFacts,
) {
  if (facts.observedRemoteRevision <= facts.appliedRemoteRevision) return false;
  // clean error 会话仍可通过权威 HTTP 追赶自愈；追赶落地前必须和 saved 会话一样阻止从旧快照开始新编辑。
  if (facts.syncStatus !== "saved" && facts.syncStatus !== "error") return false;
  if (facts.hasUnsavedChanges || facts.pendingOperationCount > 0) return false;
  if (facts.hasTransientEdit || facts.hasInlineEdit || facts.hasPendingMergeDraft) return false;
  return true;
}
