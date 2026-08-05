import * as Dialog from "@radix-ui/react-dialog";
import { KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlatformClient } from "../api/platformClient";

type Props = {
  client: PlatformClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
};

// 所有登录账号共用自己的密码修改入口；管理员替他人重置密码仍留在账号管理窗口。
export function ChangePasswordDialog(props: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError(null);
  }, [props.open]);

  async function submit() {
    if (busy) return;
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.client.changeOwnPassword({ currentPassword, newPassword });
      // 服务端会撤销该账号的全部旧会话；立即退出，避免继续使用已经失效的 access token。
      props.onOpenChange(false);
      props.onChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "修改密码失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop" />
        <Dialog.Content className="change-password-dialog">
          <header className="system-diagnostics-header">
            <div><KeyRound size={20} /><div><Dialog.Title>修改密码</Dialog.Title><Dialog.Description>修改后需要重新登录</Dialog.Description></div></div>
            <Dialog.Close asChild><button type="button" title="关闭"><X size={17} /></button></Dialog.Close>
          </header>
          {error ? <div className="resource-error-banner">{error}</div> : null}
          <div className="change-password-fields">
            <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
            <label>确认新密码<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            <small>密码长度需为 10-200 个字符，并同时包含字母和数字。</small>
          </div>
          <footer className="annotation-media-actions">
            <Dialog.Close asChild><button type="button" disabled={busy}>取消</button></Dialog.Close>
            <button type="button" className="platform-primary-button" disabled={busy || !currentPassword || !newPassword || !confirmation} onClick={() => void submit()}>{busy ? "正在修改" : "确认修改"}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
