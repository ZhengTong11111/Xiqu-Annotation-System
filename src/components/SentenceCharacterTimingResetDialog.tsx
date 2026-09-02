import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useRef, useState } from "react";

export type SentenceCharacterTimingResetPrompt = {
  lineId: string;
  sentenceText: string;
  characterCount: number;
};

type Props = {
  prompt: SentenceCharacterTimingResetPrompt | null;
  onCancel: () => void;
  onConfirm: (suppressForSession: boolean) => void;
};

/**
 * 单句时间重置的二次确认只管理本次交互；会话级免提示状态由 App 持有，避免误写入项目或浏览器存储。
 */
export function SentenceCharacterTimingResetDialog(props: Props) {
  const [suppressForSession, setSuppressForSession] = useState(false);
  const confirmingRef = useRef(false);

  useEffect(() => {
    // 每次打开都从未勾选开始；取消上一次窗口不能偷偷改变下一次操作。
    if (props.prompt) {
      setSuppressForSession(false);
      confirmingRef.current = false;
    }
  }, [props.prompt?.lineId]);

  return (
    <AlertDialog.Root
      open={Boolean(props.prompt)}
      onOpenChange={(open) => {
        if (open) return;
        // AlertDialog.Action 也会触发关闭事件；确认路径已经由按钮处理，不能再被误记成一次取消。
        if (confirmingRef.current) {
          confirmingRef.current = false;
          return;
        }
        props.onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="platform-confirm-dialog resource-workflow-dialog sentence-character-timing-reset-dialog">
          <AlertDialog.Title>重置本句逐字时间？</AlertDialog.Title>
          <AlertDialog.Description>
            将把“{props.prompt?.sentenceText ?? "当前句"}”的 {props.prompt?.characterCount ?? 0} 个逐字块
            平均铺满整句时间。
          </AlertDialog.Description>
          <p className="sentence-character-timing-reset-note">
            逐字文字、四声和身份不会改变；关联工尺时间会同步调整。该操作可以撤销。
          </p>
          <label className="sentence-character-timing-reset-suppression">
            <input
              type="checkbox"
              checked={suppressForSession}
              onChange={(event) => setSuppressForSession(event.target.checked)}
            />
            <span>
              本次打开文件不再提示
              <small>重新打开文件或刷新页面后会恢复提示。</small>
            </span>
          </label>
          <div className="platform-confirm-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button">取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  confirmingRef.current = true;
                  props.onConfirm(suppressForSession);
                }}
              >
                确认重置
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
