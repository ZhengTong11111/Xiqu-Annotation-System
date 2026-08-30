import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { AnnotationWorkflowStatus } from "@xiqu/shared";
import { annotationWorkflowStatusLabel } from "./annotationWorkflow";

export type AnnotationWorkflowStatusPrompt = {
  resourceId: string;
  resourceName: string;
  current: AnnotationWorkflowStatus;
  target: AnnotationWorkflowStatus;
  blocked: boolean;
};

/**
 * 资源管理器与编辑器共用同一状态确认窗口，保证跨级阻断和治理提示不会随入口产生分歧。
 */
export function AnnotationWorkflowStatusDialog(props: {
  prompt: AnnotationWorkflowStatusPrompt | null;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const prompt = props.prompt;
  const currentLabel = annotationWorkflowStatusLabel(prompt?.current);
  const targetLabel = annotationWorkflowStatusLabel(prompt?.target);
  return (
    <AlertDialog.Root
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="platform-confirm-dialog resource-workflow-dialog">
          <AlertDialog.Title>
            {prompt?.blocked
              ? prompt.current === "unannotated"
                ? "暂不能标记为已审核"
                : "不能跨级撤回状态"
              : `设置为${targetLabel}？`}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {prompt?.blocked
              ? prompt.current === "unannotated"
                ? "该文件尚未完成标注。请先由具有编辑权限的账号标记为“已标注”，再由具有审核权限的账号完成审核。"
                : "已审核文件不能直接恢复为未标注。请先由具有审核权限的账号撤回到“已标注”，再由具有编辑权限的账号撤回标注结论。"
              : `“${prompt?.resourceName ?? "该文件"}”当前为“${currentLabel}”，确认改为“${targetLabel}”？状态变更会记录操作者和时间，但不会修改标注正文或修订号。`}
          </AlertDialog.Description>
          {props.error ? <p className="resource-dialog-error" role="alert">{props.error}</p> : null}
          <div className="platform-confirm-dialog-actions">
            {prompt?.blocked ? (
              <AlertDialog.Cancel asChild>
                <button type="button" onClick={props.onClose}>知道了</button>
              </AlertDialog.Cancel>
            ) : (
              <>
                <AlertDialog.Cancel asChild>
                  <button type="button" disabled={props.pending}>取消</button>
                </AlertDialog.Cancel>
                <button
                  type="button"
                  className="primary"
                  disabled={props.pending}
                  onClick={props.onConfirm}
                >
                  {props.pending ? "正在保存…" : "确认设置"}
                </button>
              </>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
