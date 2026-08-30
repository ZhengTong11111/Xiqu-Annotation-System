import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Download, History, X } from "lucide-react";
import { PROJECT_FILE_VERSION } from "../utils/projectFile";
import type { PlatformDraftRecord } from "./platformDraft";

export type PlatformDraftRecoveryMode = "recoverable" | "revision-conflict" | "read-only";

// 平台文件打开前的恢复决策独立于编辑器，确保旧草稿不会先进入 document state 再被动回滚。
export function PlatformDraftRecoveryDialog(props: {
  fileName: string;
  remoteRevision: number;
  draft: PlatformDraftRecord;
  mode: PlatformDraftRecoveryMode;
  conflictReason?: "remote_revision_changed" | "server_baseline_mismatch";
  busy: boolean;
  onCancel: () => void;
  onRecover: () => void;
  onCompareConflict: () => void;
  onDiscardAndOpen: () => void;
}) {
  const canRecover = props.mode === "recoverable";
  const description = props.mode === "revision-conflict"
    ? props.conflictReason === "server_baseline_mismatch"
      ? "浏览器草稿的保存基线与同一服务器修订的正文不一致。为避免覆盖内容，本轮禁止直接恢复。"
      : "服务器文件已在本地草稿之后发生变化。为避免覆盖他人内容，本轮禁止直接恢复。"
    : props.mode === "read-only"
      ? "当前账号已没有此文件的写入权限，本地草稿不会自动删除或载入只读编辑器。"
      : "检测到与服务器当前修订一致的未保存本地草稿。请选择继续本地编辑或使用服务器版本。";

  // 导出只包含标准项目 JSON，作为 revision 冲突流程完成前的人工数据保险。
  const exportDraft = () => {
    const blob = new Blob([
      JSON.stringify({ version: PROJECT_FILE_VERSION, project: props.draft.currentProject }, null, 2),
    ], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${stripJsonExtension(props.fileName)}.local-draft.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => {
      if (!open && !props.busy) props.onCancel();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="resource-recovery-dialog platform-draft-recovery-dialog">
          {/* 标题区突出“未保存草稿”，避免与服务器恢复快照或普通文件版本混淆。 */}
          <header className="resource-recovery-dialog-header">
            <History size={19} />
            <span>
              <Dialog.Title>发现未保存的浏览器草稿</Dialog.Title>
              <Dialog.Description>{props.fileName}</Dialog.Description>
            </span>
            <button type="button" title="取消打开" disabled={props.busy} onClick={props.onCancel}>
              <X size={17} />
            </button>
          </header>

          {/* 修订与时间来自持久 envelope，不用资源列表中的可能过期摘要。 */}
          <div className="resource-recovery-dialog-body">
            <div className={`platform-draft-recovery-message ${canRecover ? "" : "warning"}`}>
              {!canRecover ? <AlertTriangle size={18} /> : <History size={18} />}
              <div>
                <strong>{description}</strong>
                <dl>
                  <div><dt>草稿更新时间</dt><dd>{formatDraftDate(props.draft.updatedAt)}</dd></div>
                  <div><dt>草稿基准</dt><dd>r{props.draft.remoteBaseRevision}</dd></div>
                  <div><dt>服务器当前</dt><dd>r{props.remoteRevision}</dd></div>
                  <div><dt>待同步操作</dt><dd>{props.draft.pendingOperations.length} 项</dd></div>
                </dl>
              </div>
            </div>
          </div>

          {/* 冲突或只读时仍允许导出数据，但只有同 revision 草稿能够直接恢复进编辑器。 */}
          <footer className="resource-recovery-dialog-footer">
            <button type="button" disabled={props.busy} onClick={exportDraft}>
              <Download size={15} />
              导出草稿 JSON
            </button>
            <div>
              {props.mode === "revision-conflict" ? (
                <button type="button" disabled={props.busy} onClick={props.onCompareConflict}>
                  比较并整合草稿
                </button>
              ) : null}
              <button type="button" disabled={props.busy} onClick={props.onDiscardAndOpen}>
                {props.busy ? "正在处理…" : "丢弃草稿并打开服务器版本"}
              </button>
              {canRecover ? (
                <button type="button" className="primary" disabled={props.busy} onClick={props.onRecover}>
                  恢复本地草稿
                </button>
              ) : null}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatDraftDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function stripJsonExtension(fileName: string) {
  return fileName.replace(/\.json$/i, "") || "annotation";
}
