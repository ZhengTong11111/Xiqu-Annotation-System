import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { HardDriveDownload, ServerOff } from "lucide-react";

export type MaintenanceDraftSaveState =
  | { status: "saving" }
  | { status: "saved" }
  | { status: "failed"; message: string };

type Props = {
  open: boolean;
  draftState: MaintenanceDraftSaveState;
  onClose: () => void;
  onSuppressForSession: () => void;
};

// 该提示只表达当前文件会话的本地保存事实，不把浏览器草稿误称为服务器同步成功。
export function PlatformMaintenanceSaveWarningDialog(props: Props) {
  const draftMessage = props.draftState.status === "saving"
    ? "正在把本次修改写入此浏览器的恢复草稿..."
    : props.draftState.status === "saved"
      ? "本地恢复草稿已保存。维护结束后，重新打开文件时可按提示恢复并同步。"
      : `本地恢复草稿保存失败：${props.draftState.message}。请暂时不要关闭或刷新页面。`;

  return (
    <AlertDialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="platform-maintenance-save-warning">
          <header>
            <ServerOff size={22} />
            <span>
              <AlertDialog.Title>服务器正在维护</AlertDialog.Title>
              <AlertDialog.Description>
                当前修改暂时无法自动保存到服务器。你仍可继续编辑，系统会将已完成的修改保存在本机浏览器中。
              </AlertDialog.Description>
            </span>
          </header>
          <div className={`platform-maintenance-draft-state is-${props.draftState.status}`}>
            <HardDriveDownload size={17} />
            <span>{draftMessage}</span>
          </div>
          <p>
            维护结束前请避免清除浏览器数据。选择“不再提醒”只对本次打开的这个文件有效，下次打开仍会提醒。
          </p>
          <footer>
            <AlertDialog.Cancel asChild>
              <button type="button">关闭</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button type="button" className="primary" onClick={props.onSuppressForSession}>
                本文件本次不再提醒
              </button>
            </AlertDialog.Action>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

