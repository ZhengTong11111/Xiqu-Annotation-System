import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useState } from "react";

type AnnotationReviewWithdrawalDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  pending: boolean;
  portalContainer?: HTMLElement;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string | null) => Promise<void>;
};

// 面板和时间轴右键共用同一个软删除确认界面；这里只收集原因，不复制权限或服务端 mutation 规则。
export function AnnotationReviewWithdrawalDialog(props: AnnotationReviewWithdrawalDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!props.open) setReason("");
  }, [props.open]);

  return (
    <AlertDialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!props.pending) props.onOpenChange(open);
      }}
    >
      <AlertDialog.Portal container={props.portalContainer}>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="annotation-review-dialog">
          <AlertDialog.Title>{props.title}</AlertDialog.Title>
          <AlertDialog.Description>
            {props.description ?? "操作不会删除历史；记录仍保存在服务器，并可在“显示已撤销与已撤回”中查看。"}
          </AlertDialog.Description>
          <label>
            原因（可选）
            <textarea
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="annotation-review-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={props.pending}>取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className="danger"
                disabled={props.pending}
                onClick={(event) => {
                  event.preventDefault();
                  void props.onSubmit(reason.trim() || null);
                }}
              >{props.pending ? "正在提交…" : "确认操作"}</button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
