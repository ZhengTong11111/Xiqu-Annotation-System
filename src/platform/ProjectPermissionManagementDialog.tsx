import * as Dialog from "@radix-ui/react-dialog";
import {
  FolderKanban,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PermissionManagementProject,
  PlatformUser,
  ResourcePermissionMatrixRow,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { formatPlatformRoleLabels } from "./platformRoleLabels";
import {
  createProjectPermissionSavePlan,
  getProjectPermissionLockReason,
  getProjectSimplePermissionMatch,
  getProjectPermissionResidualAccess,
} from "./projectPermissionManagement";
import { describeSupplementalPermissionSources } from "./resourcePermissionSources";
import {
  RESOURCE_CAPABILITY_LABELS,
  type ResourceSimplePermissionSelection,
  type ResourcePermissionPreset,
} from "./resourcePermissionPresets";
import { ResourcePermissionPresetSelector } from "./ResourcePermissionPresetSelector";

type Props = {
  client: PlatformClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPermissionChanged: (projectId: string) => void | Promise<void>;
};

// 三栏窗口把人员、项目和权限事实并列展示；账号生命周期与任意文件的详细 ACL 仍留在原有界面。
export function ProjectPermissionManagementDialog(props: Props) {
  const [accountQuery, setAccountQuery] = useState("");
  const [accounts, setAccounts] = useState<PlatformUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [projects, setProjects] = useState<PermissionManagementProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsLoadingMore, setProjectsLoadingMore] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<ResourcePermissionMatrixRow[] | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [draftPermission, setDraftPermission] = useState<ResourceSimplePermissionSelection | null>(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const accountGenerationRef = useRef(0);
  const projectGenerationRef = useRef(0);
  const matrixGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);

  const selectedAccount = useMemo(
    () => accounts.find(({ id }) => id === selectedUserId) ?? null,
    [accounts, selectedUserId],
  );
  const selectedProject = useMemo(
    () => projects.find(({ id }) => id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedRow = useMemo(
    () => matrix?.find(({ user }) => user.id === selectedUserId) ?? null,
    [matrix, selectedUserId],
  );

  // 人员搜索绑定 generation；快速输入时较早响应不能覆盖较新的关键词结果。
  const loadAccounts = useCallback(async (query: string) => {
    const generation = ++accountGenerationRef.current;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const nextAccounts = await props.client.listDirectoryUsers(query.trim() || undefined);
      if (generation !== accountGenerationRef.current) return;
      setAccounts(nextAccounts);
      setSelectedUserId((current) => nextAccounts.some(({ id }) => id === current)
        ? current
        : null);
    } catch (error) {
      if (generation === accountGenerationRef.current) {
        setAccountsError(describeError(error, "人员列表读取失败。"));
      }
    } finally {
      if (generation === accountGenerationRef.current) setAccountsLoading(false);
    }
  }, [props.client]);

  // 项目第一页替换结果，后续页去重追加；搜索和翻页共享同一请求代际。
  const loadProjects = useCallback(async (
    query: string,
    cursor: string | null = null,
  ) => {
    const generation = ++projectGenerationRef.current;
    if (cursor) setProjectsLoadingMore(true);
    else setProjectsLoading(true);
    setProjectsError(null);
    try {
      const page = await props.client.listPermissionManagementProjects({
        query: query.trim() || undefined,
        cursor: cursor ?? undefined,
        limit: 50,
      });
      if (generation !== projectGenerationRef.current) return;
      setProjects((current) => cursor
        ? appendUniqueProjects(current, page.items)
        : page.items);
      setProjectCursor(page.nextCursor);
      if (!cursor) {
        setSelectedProjectId((current) => page.items.some(({ id }) => id === current)
          ? current
          : null);
      }
    } catch (error) {
      if (generation === projectGenerationRef.current) {
        setProjectsError(describeError(error, "项目列表读取失败。"));
      }
    } finally {
      if (generation === projectGenerationRef.current) {
        setProjectsLoading(false);
        setProjectsLoadingMore(false);
      }
    }
  }, [props.client]);

  // 权限矩阵只按当前项目请求一次，切换人员直接在本地矩阵中定位，不产生重复网络读取。
  const loadMatrix = useCallback(async (projectId: string): Promise<boolean> => {
    const generation = ++matrixGenerationRef.current;
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const nextMatrix = await props.client.listResourcePermissions(projectId);
      if (generation !== matrixGenerationRef.current) return false;
      setMatrix(nextMatrix);
      return true;
    } catch (error) {
      if (generation === matrixGenerationRef.current) {
        setMatrixError(describeError(error, "项目权限读取失败。"));
      }
      return false;
    } finally {
      if (generation === matrixGenerationRef.current) setMatrixLoading(false);
    }
  }, [props.client]);

  // 打开窗口或人员关键词变化时防抖读取；搜索期间立即废弃旧响应。
  useEffect(() => {
    accountGenerationRef.current += 1;
    if (!props.open) return;
    const timer = window.setTimeout(
      () => void loadAccounts(accountQuery),
      accountQuery.trim() ? 260 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [accountQuery, loadAccounts, props.open]);

  // 项目搜索变化会清空旧分页和旧项目 selection，避免右栏继续指向不可见的旧查询对象。
  useEffect(() => {
    projectGenerationRef.current += 1;
    if (!props.open) return;
    setProjects([]);
    setProjectCursor(null);
    setSelectedProjectId(null);
    const timer = window.setTimeout(
      () => void loadProjects(projectQuery),
      projectQuery.trim() ? 260 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [loadProjects, projectQuery, props.open]);

  // 选择项目后读取权威矩阵；没有项目时同时清理上一项目的权限事实。
  useEffect(() => {
    matrixGenerationRef.current += 1;
    setMatrix(null);
    setMatrixError(null);
    if (props.open && selectedProjectId) void loadMatrix(selectedProjectId);
  }, [loadMatrix, props.open, selectedProjectId]);

  // 人员、项目或服务端矩阵变化后从 direct ACL 重建两部分草稿，custom 状态不能自动猜测基础权限。
  useEffect(() => {
    const match = selectedRow ? getProjectSimplePermissionMatch(selectedRow) : null;
    setDraftPermission(match && match.basePreset !== "custom" ? {
      basePreset: match.basePreset,
      canReview: match.canReview,
    } : null);
    setOverwriteConfirmed(false);
    setSaveMessage(null);
  }, [selectedProjectId, selectedRow, selectedUserId]);

  // 关闭后清空本地筛选和请求代际，迟到响应不能污染下一次打开。
  useEffect(() => {
    if (props.open) return;
    accountGenerationRef.current += 1;
    projectGenerationRef.current += 1;
    matrixGenerationRef.current += 1;
    saveGenerationRef.current += 1;
    setAccountQuery("");
    setProjectQuery("");
    setAccounts([]);
    setProjects([]);
    setSelectedUserId(null);
    setSelectedProjectId(null);
    setProjectCursor(null);
    setMatrix(null);
    setSaving(false);
  }, [props.open]);

  const savePlan = selectedRow && draftPermission
    ? createProjectPermissionSavePlan(selectedRow, draftPermission)
    : null;
  const lockReason = selectedRow ? getProjectPermissionLockReason(selectedRow) : null;

  async function savePermission() {
    if (
      saving ||
      !selectedProject ||
      !selectedRow ||
      !draftPermission ||
      !savePlan ||
      savePlan.kind === "noop" ||
      lockReason ||
      (savePlan.requiresDetailedOverwrite && !overwriteConfirmed)
    ) return;
    const generation = ++saveGenerationRef.current;
    const projectId = selectedProject.id;
    const userId = selectedRow.user.id;
    setSaving(true);
    setSaveMessage(null);
    setMatrixError(null);
    try {
      if (savePlan.kind === "remove") {
        await props.client.removeResourcePermission(projectId, userId);
      } else {
        await props.client.upsertResourcePermission(projectId, userId, {
          capabilities: savePlan.capabilities,
          inheritToChildren: savePlan.inheritToChildren,
        });
      }
      if (generation !== saveGenerationRef.current) return;
      // 写入和权威回读是两个独立步骤；只有回读成功，才能向用户报告完整保存闭环。
      const reloaded = await loadMatrix(projectId);
      if (generation !== saveGenerationRef.current) return;
      await props.onPermissionChanged(projectId);
      if (generation === saveGenerationRef.current && reloaded) {
        setSaveMessage("项目权限已保存并重新读取。");
      }
    } catch (error) {
      if (generation === saveGenerationRef.current) {
        setMatrixError(describeError(error, "项目权限保存失败。"));
      }
    } finally {
      if (generation === saveGenerationRef.current) setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!saving) props.onOpenChange(open);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop" />
        <Dialog.Content className="project-permission-dialog">
          <header className="system-diagnostics-header">
            <div>
              <ShieldCheck size={20} />
              <div>
                <Dialog.Title>项目权限管理</Dialog.Title>
                <Dialog.Description>选择人员与项目，快速设置项目范围权限</Dialog.Description>
              </div>
            </div>
            <div className="system-diagnostics-header-actions">
              <button
                type="button"
                title="刷新人员与项目"
                disabled={saving}
                onClick={() => {
                  void loadAccounts(accountQuery);
                  void loadProjects(projectQuery);
                  if (selectedProjectId) void loadMatrix(selectedProjectId);
                }}
              >
                <RefreshCw size={16} />
              </button>
              <Dialog.Close asChild>
                <button type="button" title="关闭" disabled={saving}><X size={17} /></button>
              </Dialog.Close>
            </div>
          </header>

          <div className="project-permission-body" aria-busy={saving}>
            <PermissionSelectionColumn
              title="人员"
              icon={<User size={16} />}
              query={accountQuery}
              queryPlaceholder="搜索姓名或账号"
              disabled={saving}
              onQueryChange={setAccountQuery}
            >
              <AccountList
                accounts={accounts}
                selectedId={selectedUserId}
                loading={accountsLoading}
                error={accountsError}
                disabled={saving}
                onSelect={setSelectedUserId}
                onRetry={() => void loadAccounts(accountQuery)}
              />
            </PermissionSelectionColumn>

            <PermissionSelectionColumn
              title="项目"
              icon={<FolderKanban size={16} />}
              query={projectQuery}
              queryPlaceholder="搜索项目名称"
              disabled={saving}
              onQueryChange={setProjectQuery}
            >
              <ProjectList
                projects={projects}
                selectedId={selectedProjectId}
                loading={projectsLoading}
                loadingMore={projectsLoadingMore}
                error={projectsError}
                hasMore={Boolean(projectCursor)}
                disabled={saving}
                onSelect={setSelectedProjectId}
                onRetry={() => void loadProjects(projectQuery)}
                onLoadMore={() => {
                  if (projectCursor) void loadProjects(projectQuery, projectCursor);
                }}
              />
            </PermissionSelectionColumn>

            <PermissionEditorPane
              account={selectedAccount}
              project={selectedProject}
              row={selectedRow}
              loading={matrixLoading}
              error={matrixError}
              saving={saving}
              saveMessage={saveMessage}
              draftPermission={draftPermission}
              savePlan={savePlan}
              lockReason={lockReason}
              overwriteConfirmed={overwriteConfirmed}
              onPresetChange={(preset) => {
                const currentMatch = selectedRow
                  ? getProjectSimplePermissionMatch(selectedRow)
                  : null;
                setDraftPermission((current) => ({
                  basePreset: preset,
                  // 从 custom 明确覆盖基础档时保留可准确识别的审核附加项，避免无关能力一起丢失。
                  canReview: current?.canReview ?? currentMatch?.canReview ?? false,
                }));
                setOverwriteConfirmed(false);
                setSaveMessage(null);
              }}
              onReviewChange={(canReview) => {
                setDraftPermission((current) => current ? { ...current, canReview } : current);
                setOverwriteConfirmed(false);
                setSaveMessage(null);
              }}
              onOverwriteConfirmed={setOverwriteConfirmed}
              onSave={() => void savePermission()}
              onRetry={() => {
                if (selectedProjectId) void loadMatrix(selectedProjectId);
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PermissionSelectionColumn(props: {
  title: string;
  icon: JSX.Element;
  query: string;
  queryPlaceholder: string;
  disabled: boolean;
  onQueryChange: (query: string) => void;
  children: JSX.Element;
}) {
  return (
    <section className="project-permission-column">
      <header><span>{props.icon}{props.title}</span></header>
      <label className="project-permission-search">
        <Search size={15} />
        <input
          value={props.query}
          placeholder={props.queryPlaceholder}
          maxLength={120}
          disabled={props.disabled}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </label>
      {props.children}
    </section>
  );
}

function AccountList(props: {
  accounts: PlatformUser[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (props.loading && props.accounts.length === 0) return <ColumnMessage>正在读取人员...</ColumnMessage>;
  if (props.error && props.accounts.length === 0) {
    return <ColumnError message={props.error} onRetry={props.onRetry} />;
  }
  if (props.accounts.length === 0) return <ColumnMessage>没有匹配的活动账号。</ColumnMessage>;
  return (
    <div className="project-permission-list" role="listbox" aria-label="人员列表">
      {props.accounts.map((account) => {
        const privileged = account.roles.some((role) => role === "super_admin" || role === "admin");
        return (
          <button
            key={account.id}
            type="button"
            role="option"
            aria-selected={account.id === props.selectedId}
            className={account.id === props.selectedId ? "active" : ""}
            disabled={props.disabled}
            onClick={() => props.onSelect(account.id)}
          >
            <span className="resource-user-avatar">{account.displayName.slice(0, 1)}</span>
            <span className="project-permission-item-copy">
              <strong>{account.displayName}</strong>
              <small>{account.accountName} · {formatPlatformRoleLabels(account.roles)}</small>
            </span>
            {privileged ? <Lock size={14} aria-label="全局完整权限" /> : null}
          </button>
        );
      })}
      {props.error ? <ColumnInlineError message={props.error} /> : null}
    </div>
  );
}

function ProjectList(props: {
  projects: PermissionManagementProject[];
  selectedId: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (props.loading && props.projects.length === 0) return <ColumnMessage>正在读取项目...</ColumnMessage>;
  if (props.error && props.projects.length === 0) {
    return <ColumnError message={props.error} onRetry={props.onRetry} />;
  }
  if (props.projects.length === 0) return <ColumnMessage>没有匹配的活动项目。</ColumnMessage>;
  return (
    <div className="project-permission-list" role="listbox" aria-label="项目列表">
      {props.projects.map((project) => (
        <button
          key={project.id}
          type="button"
          role="option"
          aria-selected={project.id === props.selectedId}
          className={project.id === props.selectedId ? "active" : ""}
          disabled={props.disabled}
          onClick={() => props.onSelect(project.id)}
        >
          <FolderKanban size={17} />
          <span className="project-permission-item-copy">
            <strong>{project.name}</strong>
            <small title={formatProjectPath(project)}>{formatProjectPath(project)}</small>
            <small>{project.owner.displayName} · {formatDate(project.updatedAt)}</small>
          </span>
        </button>
      ))}
      {props.hasMore ? (
        <button
          type="button"
          className="project-permission-load-more"
          disabled={props.disabled || props.loadingMore}
          onClick={props.onLoadMore}
        >
          {props.loadingMore ? "正在加载..." : "加载更多项目"}
        </button>
      ) : null}
      {props.error ? <ColumnInlineError message={props.error} /> : null}
    </div>
  );
}

function PermissionEditorPane(props: {
  account: PlatformUser | null;
  project: PermissionManagementProject | null;
  row: ResourcePermissionMatrixRow | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveMessage: string | null;
  draftPermission: ResourceSimplePermissionSelection | null;
  savePlan: ReturnType<typeof createProjectPermissionSavePlan> | null;
  lockReason: string | null;
  overwriteConfirmed: boolean;
  onPresetChange: (preset: ResourcePermissionPreset) => void;
  onReviewChange: (canReview: boolean) => void;
  onOverwriteConfirmed: (confirmed: boolean) => void;
  onSave: () => void;
  onRetry: () => void;
}) {
  if (!props.account || !props.project) {
    return (
      <section className="project-permission-editor-pane empty">
        <ShieldCheck size={28} />
        <strong>请选择人员和项目</strong>
        <p>{!props.account && !props.project
          ? "先在左侧选择人员，再在中间选择项目。"
          : !props.account ? "还需要选择一名人员。" : "还需要选择一个项目。"}</p>
      </section>
    );
  }
  if (props.loading) return <section className="project-permission-editor-pane"><ColumnMessage>正在读取权限...</ColumnMessage></section>;
  if (props.error && !props.row) {
    return <section className="project-permission-editor-pane"><ColumnError message={props.error} onRetry={props.onRetry} /></section>;
  }
  if (!props.row) {
    return <section className="project-permission-editor-pane"><ColumnMessage>账号已停用或不在最新权限矩阵中，请刷新。</ColumnMessage></section>;
  }

  const currentMatch = getProjectSimplePermissionMatch(props.row);
  const residualAccess = getProjectPermissionResidualAccess(props.row);
  const displayedPermission = props.draftPermission ?? (
    currentMatch.basePreset === "custom"
      ? null
      : { basePreset: currentMatch.basePreset, canReview: currentMatch.canReview }
  );
  const canSave = Boolean(
    props.draftPermission &&
    props.savePlan &&
    props.savePlan.kind !== "noop" &&
    !props.lockReason &&
    (!props.savePlan.requiresDetailedOverwrite || props.overwriteConfirmed),
  );
  return (
    <section className="project-permission-editor-pane">
      <header className="project-permission-editor-heading">
        <div className="resource-user-avatar">{props.account.displayName.slice(0, 1)}</div>
        <div>
          <strong>{props.account.displayName}</strong>
          <span>{props.account.accountName} · {formatPlatformRoleLabels(props.account.roles)}</span>
          <small>{formatProjectPath(props.project)}</small>
        </div>
      </header>

      <dl className="project-permission-facts">
        <dt>当前直接授权</dt>
        <dd>{formatDirectPermission(props.row, currentMatch)}</dd>
        <dt>最终有效权限</dt>
        <dd>{formatCapabilities(props.row.effectivePermission.capabilities)}</dd>
        <dt>权限来源</dt>
        <dd>{formatPermissionSource(props.row)}</dd>
        <dt>项目所有者</dt>
        <dd>{props.project.owner.displayName}</dd>
      </dl>

      {props.lockReason ? (
        <div className="project-permission-lock"><Lock size={16} /><span>{props.lockReason}</span></div>
      ) : (
        <>
          {/* custom 初始不预选任何三档；只有用户明确选择后才形成覆盖意图。 */}
          <ResourcePermissionPresetSelector
            name={`project-permission-${props.project.id}-${props.account.id}`}
            ariaLabel={`${props.account.displayName}在${props.project.name}的权限`}
            value={props.draftPermission?.basePreset ?? currentMatch.basePreset}
            canReview={props.draftPermission?.canReview ?? currentMatch.canReview}
            existingCanReview={currentMatch.canReview}
            resourceType="project"
            disabled={props.saving}
            onChange={props.onPresetChange}
            onReviewChange={props.onReviewChange}
          />
          {currentMatch.basePreset === "custom" ? (
            <div className="resource-permission-preset-note warning">
              当前包含权限管理或其他无法由极简模式表达的细分能力。选择基础预设会覆盖这些详细设置。
            </div>
          ) : null}
          {props.row.directPermission && !props.row.directPermission.inheritToChildren ? (
            <div className="resource-permission-preset-note warning">
              当前直接授权不向子资源传递。保存任何非空极简组合后，将改为整个项目范围。
            </div>
          ) : null}
          {displayedPermission?.basePreset === "none" ? (
            <div className="resource-permission-preset-note">
              {displayedPermission.canReview
                ? [residualAccess, "当前直接授权只增加审核；实际审核还需要查看能力"].filter(Boolean).join("；")
                : residualAccess ?? "保存后将删除此项目对该账号的直接授权。"}
            </div>
          ) : null}
          {displayedPermission && (
            displayedPermission.basePreset !== "none" || displayedPermission.canReview
          ) ? (
            <div className="project-permission-scope-note">
              项目级授权会传递到子资源，但不会绕过子资源的继承截断或删除已有直接授权。
            </div>
          ) : null}
          {props.savePlan?.requiresDetailedOverwrite ? (
            <label className="project-permission-overwrite-confirmation">
              <input
                type="checkbox"
                checked={props.overwriteConfirmed}
                disabled={props.saving}
                onChange={(event) => props.onOverwriteConfirmed(event.target.checked)}
              />
              我已了解：保存会覆盖当前自定义或非传递的详细设置
            </label>
          ) : null}
          <div className="project-permission-editor-footer">
            <span className={props.error ? "error" : ""}>
              {props.error ?? props.saveMessage ?? (
                props.savePlan?.kind === "noop" ? "当前已是该设置" : "选择后点击保存才会生效"
              )}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!canSave || props.saving}
              onClick={props.onSave}
            >
              {props.saving ? "正在保存..." : "保存权限"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ColumnMessage(props: { children: string }) {
  return <div className="project-permission-column-message">{props.children}</div>;
}

function ColumnError(props: { message: string; onRetry: () => void }) {
  return (
    <div className="project-permission-column-message error">
      <span>{props.message}</span>
      <button type="button" onClick={props.onRetry}>重试</button>
    </div>
  );
}

function ColumnInlineError(props: { message: string }) {
  return <div className="project-permission-inline-error">{props.message}</div>;
}

function appendUniqueProjects(
  current: PermissionManagementProject[],
  incoming: PermissionManagementProject[],
) {
  const seen = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !seen.has(id))];
}

function formatProjectPath(project: PermissionManagementProject) {
  return project.path.map(({ name }) => name).join(" / ");
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCapabilities(capabilities: ResourcePermissionMatrixRow["effectivePermission"]["capabilities"]) {
  return capabilities.map((capability) => RESOURCE_CAPABILITY_LABELS[capability]).join("、") || "无额外能力";
}

function formatDirectPermission(
  row: ResourcePermissionMatrixRow,
  match: ReturnType<typeof getProjectSimplePermissionMatch>,
) {
  if (!row.directPermission) return "不额外授权";
  const scope = row.directPermission.inheritToChildren ? "整个项目" : "仅当前项目";
  if (match.basePreset === "none" && match.canReview) return `仅可审核 · ${scope}`;
  if (match.basePreset === "view") {
    return `${match.canReview ? "仅查看 + 可审核" : "仅查看"} · ${scope}`;
  }
  if (match.basePreset === "edit") {
    return `${match.canReview ? "可编辑 + 可审核" : "可编辑"} · ${scope}`;
  }
  return `自定义细分权限 · ${row.directPermission.inheritToChildren ? "向子资源传递" : "仅当前项目"}`;
}

function formatPermissionSource(row: ResourcePermissionMatrixRow) {
  if (row.effectivePermission.isOwner) return "项目所有者";
  if (row.effectivePermission.source === "admin") return "全局管理员";
  if (row.directPermission) return "当前项目直接授权";
  if (row.effectivePermission.source === "role") return "教师角色自动查看";
  if (row.effectivePermission.inheritedFrom.length > 0) {
    return describeSupplementalPermissionSources(
      row.effectivePermission.inheritedFrom,
    ) ?? "继承权限";
  }
  return "没有直接、角色或继承来源";
}

function describeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
