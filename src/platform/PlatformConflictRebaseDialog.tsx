import * as Dialog from "@radix-ui/react-dialog";
import { GitMerge, ShieldCheck, X } from "lucide-react";
import type { PlatformConflictRebaseProposal } from "./platformConflictRebasePreparation";

// 对话框只展示已经由纯准备器证明的轻量事实；网络重读、草稿写入和编辑器切换均由 Workspace 负责。
export function PlatformConflictRebaseDialog(props: {
  fileName: string;
  proposal: PlatformConflictRebaseProposal;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onManualReview: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => {
      if (!open && !props.busy) props.onCancel();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="resource-recovery-dialog platform-draft-recovery-dialog">
          {/* 标题明确这是一次待确认的重放，不把它描述成服务器已经完成的自动合并。 */}
          <header className="resource-recovery-dialog-header">
            <GitMerge size={19} />
            <span>
              <Dialog.Title>本地修改可以重放到最新版本</Dialog.Title>
              <Dialog.Description>{props.fileName}</Dialog.Description>
            </span>
            <button type="button" title="取消处理" disabled={props.busy} onClick={props.onCancel}>
              <X size={17} />
            </button>
          </header>

          {/* 这里只展示 revision、数量和租约需求，研究正文与完整命令始终留在本地草稿中。 */}
          <div className="resource-recovery-dialog-body">
            <div className="platform-draft-recovery-message rebase-ready">
              <ShieldCheck size={18} />
              <div>
                <strong>
                  服务器已有的修改与这组本地命令目标没有直接冲突。确认后会以服务器最新版本为基准重新应用本地修改。
                </strong>
                <dl>
                  <div><dt>本地草稿基准</dt><dd>r{props.proposal.draftRemoteBaseRevision}</dd></div>
                  <div><dt>服务器当前版本</dt><dd>r{props.proposal.serverRevision}</dd></div>
                  <div><dt>待重放操作</dt><dd>{props.proposal.operationCount} 项</dd></div>
                  <div>
                    <dt>结构编辑锁</dt>
                    <dd>{formatLeasePurpose(props.proposal.requiredLeasePurpose)}</dd>
                  </div>
                </dl>
                <p className="platform-conflict-rebase-note">
                  确认时系统会再次读取服务器和本地草稿。若版本、权限或命令条件已经变化，本次操作会停止，不会覆盖服务器内容。
                </p>
                {props.error ? <p className="platform-conflict-rebase-error" role="alert">{props.error}</p> : null}
              </div>
            </div>
          </div>

          {/* 人工比较始终保留为同级退路，用户无需先放弃本地草稿。 */}
          <footer className="resource-recovery-dialog-footer">
            <button type="button" disabled={props.busy} onClick={props.onManualReview}>
              改用人工比较
            </button>
            <div>
              <button type="button" disabled={props.busy} onClick={props.onCancel}>取消</button>
              <button type="button" className="primary" disabled={props.busy} onClick={props.onConfirm}>
                {props.busy ? "正在重新核对…" : "重放到最新版本"}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatLeasePurpose(purpose: PlatformConflictRebaseProposal["requiredLeasePurpose"]): string {
  if (purpose === "track_structure") return "需要（轨道结构）";
  if (purpose === "bulk_import") return "需要（批量导入）";
  if (purpose === "bulk_repair") return "需要（批量修复）";
  return "不需要";
}
