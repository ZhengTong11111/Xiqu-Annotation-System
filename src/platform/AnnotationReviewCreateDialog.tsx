import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useRef, useState } from "react";
import type { AnnotationReviewCreateMode } from "./annotationConfirmationView";
import {
  getAnnotationReviewBlockerMessage,
  type AnnotationReviewCreateBlocker,
} from "./annotationConfirmationView";

export type AnnotationReviewCreatePrompt = {
  mode: AnnotationReviewCreateMode;
  range: { start: number; end: number };
};

type AnnotationReviewCreateDialogProps = {
  prompt: AnnotationReviewCreatePrompt | null;
  blocker: AnnotationReviewCreateBlocker | null;
  mutationPending: boolean;
  onClose: () => void;
  onSubmit: (input: { mode: AnnotationReviewCreateMode; text: string | null }) => Promise<void>;
};

const MODE_LABELS: Record<AnnotationReviewCreateMode, string> = {
  confirmation: "标注确认",
  comment: "审核评论",
  feedback: "编辑反馈",
};

// 循环范围右键入口使用紧凑弹窗完成写入；高级目标选择仍由右侧审核面板承担。
export function AnnotationReviewCreateDialog(props: AnnotationReviewCreateDialogProps) {
  const [text, setText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prompt = props.prompt;
  const requiresText = Boolean(prompt && prompt.mode !== "confirmation");
  const textInvalid = requiresText && !text.trim();
  const blockerMessage = getAnnotationReviewBlockerMessage(props.blocker);

  useEffect(() => {
    setText("");
    setSubmitError(null);
    if (!prompt) return;
    const frameId = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frameId);
  }, [prompt]);

  async function submit() {
    if (!prompt || props.blocker || props.mutationPending || textInvalid) return;
    setSubmitError(null);
    try {
      await props.onSubmit({
        mode: prompt.mode,
        text: text.trim() || null,
      });
      props.onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "范围记录提交失败，请稍后重试。");
    }
  }

  return (
    <AlertDialog.Root
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open && !props.mutationPending) props.onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="annotation-review-dialog annotation-review-create-dialog">
          <AlertDialog.Title>添加{prompt ? MODE_LABELS[prompt.mode] : "范围记录"}</AlertDialog.Title>
          <AlertDialog.Description>
            当前范围 {prompt?.range.start.toFixed(3) ?? "-"}–{prompt?.range.end.toFixed(3) ?? "-"} 秒 · 全部标注
          </AlertDialog.Description>
          <label>
            {prompt?.mode === "confirmation" ? "审核备注（可选）" : prompt?.mode === "feedback" ? "标注反馈" : "范围评论"}
            <textarea
              ref={inputRef}
              rows={4}
              maxLength={prompt?.mode === "confirmation" ? 2000 : 4000}
              required={requiresText}
              placeholder={prompt?.mode === "feedback"
                ? "写下标注过程中需要审核者关注的问题"
                : prompt?.mode === "comment"
                  ? "写下对当前范围的审核意见"
                  : undefined}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {blockerMessage ? <p className="annotation-confirmation-blocker">{blockerMessage}</p> : null}
          {textInvalid ? <p className="annotation-confirmation-blocker">
            {prompt?.mode === "feedback" ? "标注反馈正文不能为空。" : "范围评论正文不能为空。"}
          </p> : null}
          {submitError ? <p className="annotation-confirmation-error" role="alert">{submitError}</p> : null}
          <div className="annotation-review-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={props.mutationPending}>取消</button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="primary"
              disabled={Boolean(props.blocker) || props.mutationPending || textInvalid}
              onClick={() => void submit()}
            >{props.mutationPending ? "正在提交…" : `确认添加${prompt ? MODE_LABELS[prompt.mode] : "记录"}`}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
