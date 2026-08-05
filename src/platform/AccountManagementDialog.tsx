import * as Dialog from "@radix-ui/react-dialog";
import { KeyRound, Plus, RefreshCw, UserCog, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ManagedAccount, PlatformRole } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

const ROLE_OPTIONS: Array<{ role: PlatformRole; label: string }> = [
  { role: "super_admin", label: "系统管理员" },
  { role: "admin", label: "管理员" },
  { role: "teacher", label: "教师" },
  { role: "annotator", label: "标注员" },
  { role: "reviewer", label: "审核员" },
  { role: "service", label: "服务账号" },
];

type Props = {
  client: PlatformClient;
  currentUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 账号生命周期与逐资源 ACL 分开：本窗口只管理身份、角色、状态和密码，不编辑文件权限。
export function AccountManagementDialog(props: Props) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<PlatformRole[]>(["annotator"]);
  const selected = accounts.find((account) => account.id === selectedId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await props.client.listManagedAccounts({ query: query.trim() || undefined, limit: 200 });
      setAccounts(page.items);
      setSelectedId((current) => page.items.some(({ id }) => id === current)
        ? current
        : page.items[0]?.id ?? null);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, [props.client, query]);

  useEffect(() => {
    if (!props.open) return;
    void load();
  }, [load, props.open]);

  async function createAccount() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await props.client.createManagedAccount({
        accountName,
        displayName,
        password,
        roles,
      });
      setCreating(false);
      setAccountName("");
      setDisplayName("");
      setPassword("");
      setRoles(["annotator"]);
      await load();
      setSelectedId(created.id);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function updateSelected(input: { displayName?: string; roles?: PlatformRole[]; isActive?: boolean }) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.updateManagedAccount(selected.id, input);
      await load();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!selected || busy) return;
    const nextPassword = window.prompt(`为 ${selected.displayName} 设置新密码（至少 10 位，含字母和数字）：`);
    if (!nextPassword) return;
    if (!window.confirm("重置后该账号现有登录会话会立即失效，确认继续？")) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.resetManagedAccountPassword(selected.id, { password: nextPassword });
      window.alert("密码已重置，目标账号需要重新登录。");
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop" />
        <Dialog.Content className={`account-management-dialog${error ? " has-error" : ""}`}>
          <header className="system-diagnostics-header">
            <div><UserCog size={20} /><div><Dialog.Title>账号管理</Dialog.Title><Dialog.Description>账号生命周期与平台角色</Dialog.Description></div></div>
            <div className="system-diagnostics-header-actions">
              <button type="button" title="刷新账号" onClick={() => void load()}><RefreshCw size={16} /></button>
              <Dialog.Close asChild><button type="button" title="关闭"><X size={17} /></button></Dialog.Close>
            </div>
          </header>
          <div className="account-management-toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号或显示名称" />
            <button type="button" onClick={() => void load()}>搜索</button>
            <button type="button" onClick={() => setCreating((current) => !current)}><Plus size={15} />新建账号</button>
          </div>
          {error ? <div className="resource-error-banner">{error}</div> : null}
          <div className="account-management-body">
            <div className="account-management-list">
              {loading ? <p>正在读取账号…</p> : accounts.map((account) => (
                <button key={account.id} type="button" className={account.id === selectedId ? "active" : ""} onClick={() => setSelectedId(account.id)}>
                  <strong>{account.displayName}</strong><span>{account.accountName} · {account.isActive ? "活动" : "已停用"}</span>
                </button>
              ))}
            </div>
            <div className="account-management-editor">
              {creating ? (
                <section>
                  <h3>创建账号</h3>
                  <label>账号名<input value={accountName} onChange={(event) => setAccountName(event.target.value)} /></label>
                  <label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
                  <label>初始密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                  <RolePicker value={roles} onChange={setRoles} />
                  <button type="button" disabled={busy} onClick={() => void createAccount()}>创建</button>
                </section>
              ) : selected ? (
                <AccountEditor account={selected} currentUserId={props.currentUserId} busy={busy} onUpdate={updateSelected} onResetPassword={resetPassword} />
              ) : <p>请选择一个账号。</p>}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountEditor(props: {
  account: ManagedAccount;
  currentUserId: string;
  busy: boolean;
  onUpdate: (input: { displayName?: string; roles?: PlatformRole[]; isActive?: boolean }) => Promise<void>;
  onResetPassword: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(props.account.displayName);
  const [roles, setRoles] = useState<PlatformRole[]>(props.account.roles);
  useEffect(() => { setDisplayName(props.account.displayName); setRoles(props.account.roles); }, [props.account]);
  return <section>
    <h3>{props.account.displayName}</h3>
    <p>{props.account.accountName} · 创建于 {new Date(props.account.createdAt).toLocaleString("zh-CN")}</p>
    <label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
    <RolePicker value={roles} onChange={setRoles} />
    <div className="account-management-actions">
      <button type="button" disabled={props.busy} onClick={() => void props.onUpdate({ displayName, roles })}>保存资料与角色</button>
      <button
        type="button"
        disabled={props.busy || props.account.id === props.currentUserId}
        title={props.account.id === props.currentUserId ? "请使用顶部的“修改我的密码”入口" : "重置该账号密码"}
        onClick={() => void props.onResetPassword()}
      ><KeyRound size={15} />重置密码</button>
      <button
        type="button"
        className="danger"
        disabled={props.busy || props.account.id === props.currentUserId}
        onClick={() => {
          const action = props.account.isActive ? "停用" : "恢复";
          if (window.confirm(`${action}账号 ${props.account.displayName}？`)) void props.onUpdate({ isActive: !props.account.isActive });
        }}
      >{props.account.isActive ? "停用账号" : "恢复账号"}</button>
    </div>
  </section>;
}

function RolePicker(props: { value: PlatformRole[]; onChange: (roles: PlatformRole[]) => void }) {
  return <fieldset className="account-role-picker"><legend>平台角色</legend>{ROLE_OPTIONS.map(({ role, label }) => (
    <label key={role}><input type="checkbox" checked={props.value.includes(role)} onChange={(event) => props.onChange(event.target.checked ? [...new Set([...props.value, role])] : props.value.filter((item) => item !== role))} />{label}</label>
  ))}</fieldset>;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "账号操作失败。";
}
