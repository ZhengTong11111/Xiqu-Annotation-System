import { HardDrive } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  AnnotationFile,
  PlatformRole,
  PlatformUser,
  ResourceEntry,
} from "@xiqu/shared";
import { PlatformClient } from "../api/platformClient";
import type { TopMenuPlatformNavigation } from "../components/TopMenuBar";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import type { ProjectDocumentRecoveryState } from "../state/projectDocumentState";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import type {
  AnnotationMergeDraft,
  AnnotationMergePreparationRequest,
  AnnotationMergePreparationResult,
} from "./annotationMergeDraft";
import { prepareAnnotationMergeDraft } from "./annotationMergePreparation";
import { ResourceExplorer } from "./ResourceExplorer";
import { PlatformDraftConflictDialog } from "./PlatformDraftConflictDialog";
import { hydrateProjectForClient } from "./platformProjectPayload";
import {
  assessPlatformDraftCompatibility,
  normalizePlatformDraftRecord,
  toProjectDocumentRecoveryState,
  type PlatformDraftRecord,
} from "./platformDraft";
import { platformDraftStore } from "./platformDraftStore";
import {
  preparePlatformDraftConflict,
  type PlatformDraftConflictPreparationRequest,
} from "./platformDraftConflict";
import type { AnnotationMergeReviewIntent } from "./AnnotationMergeDiffReview";
import {
  PlatformDraftRecoveryDialog,
  type PlatformDraftRecoveryMode,
} from "./PlatformDraftRecoveryDialog";

export type PlatformEditorSession = {
  client: PlatformClient;
  annotationFileId: string;
  annotationFileName: string;
  projectTitle: string;
  baseRevision: number;
  initialProject: ProjectData;
  onAnnotationFileSaved: (file: AnnotationFile<ProjectData>) => void;
  canWrite: boolean;
  canReview: boolean;
  currentUserId: string;
  currentUserRoles: PlatformRole[];
  canRevokeAnyConfirmation: boolean;
  accessLabel: string;
  initialFocus?: AnnotationComparisonFocus;
  pendingMergeDraft?: AnnotationMergeDraft;
  initialRecoveryState?: ProjectDocumentRecoveryState;
};

export type LocalEditorSession = {
  id: string;
  title: string;
  initialProject: ProjectData;
  source: "demo" | "json";
};

type PlatformWorkspaceProps = {
  renderEditor: (
    session: PlatformEditorSession | null,
    localSession: LocalEditorSession | null,
    platformNavigation: TopMenuPlatformNavigation,
  ) => JSX.Element;
};

type PlatformView = "login" | "explorer" | "editor";

type PendingDraftOpen = {
  file: AnnotationFile<ProjectData>;
  serverProject: ProjectData;
  initialFocus?: AnnotationComparisonFocus;
  draft: PlatformDraftRecord;
  mode: PlatformDraftRecoveryMode;
};

const TOKEN_KEY = "xiqu-platform-dev-token";

export function PlatformWorkspace({ renderEditor }: PlatformWorkspaceProps) {
  const [view, setView] = useState<PlatformView>(() =>
    window.localStorage.getItem(TOKEN_KEY) ? "explorer" : "login");
  const [accountName, setAccountName] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    window.localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [editorSession, setEditorSession] =
    useState<PlatformEditorSession | null>(null);
  const [localSession, setLocalSession] =
    useState<LocalEditorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDraftOpen, setPendingDraftOpen] = useState<PendingDraftOpen | null>(null);
  const [draftConflictVisible, setDraftConflictVisible] = useState(false);
  const [draftDecisionBusy, setDraftDecisionBusy] = useState(false);

  const client = useMemo(() => new PlatformClient({
    baseUrl: "http://localhost:4317/api",
    accessToken,
  }), [accessToken]);

  useEffect(() => {
    if (!accessToken || view === "login") return;
    void client.me().then(setUser).catch((nextError: unknown) => {
      window.localStorage.removeItem(TOKEN_KEY);
      setAccessToken(null);
      setView("login");
      setError(describeError(nextError));
    });
  }, [accessToken, client, view]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await client.login({ accountName, password });
      window.localStorage.setItem(TOKEN_KEY, result.accessToken);
      setAccessToken(result.accessToken);
      setUser(result.user);
      setView("explorer");
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }

  function openLocal(project: ProjectData, title: string) {
    setLocalSession({
      id: `local-${Date.now()}`,
      title,
      initialProject: project,
      source: title === "本地示例项目" ? "demo" : "json",
    });
    setEditorSession(null);
    setView("editor");
  }

  // 平台编辑会话在一处构造，普通打开与整合草稿打开共享 revision、权限和保存回调规则。
  const enterPlatformEditor = useCallback(async (input: {
    file: AnnotationFile<ProjectData>;
    initialProject: ProjectData;
    initialFocus?: AnnotationComparisonFocus;
    pendingMergeDraft?: AnnotationMergeDraft;
    initialRecoveryState?: ProjectDocumentRecoveryState;
  }) => {
    // 平台治理命令必须绑定已登录账号；会话尚未恢复完成时不允许构造匿名编辑器状态。
    if (!user) {
      throw new Error("登录会话尚未恢复，请刷新后重试。");
    }
    const parent = input.file.resource.parentId
      ? await client.getResource(input.file.resource.parentId).catch(() => null)
      : null;
    // 撤销他人确认的 owner 权威覆盖整个祖先容器链，必须与服务端 hasOwnerAuthority 语义一致。
    const hasOwnerAuthority = input.file.resource.permission.isOwner ||
      parent?.owner.id === user.id ||
      await hasAncestorOwnerAuthority(
        client,
        parent?.parentId,
        user.id,
      );
    const next: PlatformEditorSession = {
      client,
      annotationFileId: input.file.resource.id,
      annotationFileName: input.file.resource.name,
      projectTitle: parent?.name ?? "平台标注项目",
      baseRevision: input.file.revision,
      initialProject: input.initialProject,
      canWrite: input.file.resource.permission.capabilities.includes("write"),
      canReview: input.file.resource.permission.capabilities.includes("review"),
      currentUserId: user.id,
      currentUserRoles: [...user.roles],
      canRevokeAnyConfirmation: hasOwnerAuthority || user.roles.some(
        (role) => role === "admin" || role === "super_admin",
      ),
      accessLabel: input.file.resource.permission.isOwner
        ? "文件所有者"
        : input.file.resource.permission.capabilities.includes("write")
          ? "可编辑"
          : "只读",
      initialFocus: input.initialFocus,
      pendingMergeDraft: input.pendingMergeDraft,
      initialRecoveryState: input.initialRecoveryState,
      onAnnotationFileSaved: (saved) => {
        setEditorSession((current) => current
          ? {
              ...current,
              baseRevision: saved.revision,
              annotationFileName: saved.resource.name,
            }
          : current);
      },
    };
    setEditorSession(next);
    setLocalSession(null);
    setView("editor");
  }, [client, user]);

  // 文件真正进入编辑器后再记录最近打开；恢复对话框取消时不能留下虚假的访问记录。
  const enterPlatformFileAndMarkOpened = useCallback(async (input: {
    file: AnnotationFile<ProjectData>;
    initialProject: ProjectData;
    initialFocus?: AnnotationComparisonFocus;
    pendingMergeDraft?: AnnotationMergeDraft;
    initialRecoveryState?: ProjectDocumentRecoveryState;
  }) => {
    await enterPlatformEditor(input);
    void client.markResourceOpened(input.file.resource.id).catch((markError) => {
      console.warn("记录最近打开失败", markError);
    });
  }, [client, enterPlatformEditor]);

  // stale 草稿准备前重新读取两侧权威状态；旧屏幕选择不能在 revision 或草稿变化后继续应用。
  const preparePendingDraftConflict = useCallback(async (
    intent: AnnotationMergeReviewIntent,
  ): Promise<AnnotationMergePreparationResult> => {
    const pending = pendingDraftOpen;
    if (!pending || pending.mode !== "revision-conflict" || !user) {
      return { ok: false, message: "草稿比较会话已失效，请重新打开文件。" };
    }
    try {
      const [latestFile, rawDraft] = await Promise.all([
        client.getAnnotationFile<unknown>(pending.file.resource.id),
        platformDraftStore.get(user.id, pending.file.resource.id),
      ]);
      const latestDraft = normalizePlatformDraftRecord(rawDraft, {
        userId: user.id,
        annotationFileId: pending.file.resource.id,
      });
      if (!latestDraft) {
        return { ok: false, message: "浏览器草稿已被删除、损坏或替换，请关闭后重新打开文件。" };
      }
      const request: PlatformDraftConflictPreparationRequest = {
        userId: user.id,
        annotationFileId: pending.file.resource.id,
        draftUpdatedAt: pending.draft.updatedAt,
        draftRemoteBaseRevision: pending.draft.remoteBaseRevision,
        serverRevision: pending.file.revision,
        selectedEntryKeys: intent.selectedEntryKeys,
        conflictResolutions: intent.conflictResolutions,
        planFingerprint: intent.planFingerprint,
      };
      const prepared = preparePlatformDraftConflict({
        localDraft: latestDraft,
        serverFile: latestFile,
        request,
        hydrateProject: (project) => hydrateProjectForClient(project, client),
      });
      if (!prepared.ok) return prepared;
      const targetFile = prepared.value.targetFile as AnnotationFile<ProjectData>;
      await enterPlatformFileAndMarkOpened({
        file: targetFile,
        initialProject: prepared.value.draft.baseProject,
        pendingMergeDraft: prepared.value.draft,
      });
      setDraftConflictVisible(false);
      setPendingDraftOpen(null);
      return { ok: true };
    } catch (nextError) {
      return { ok: false, message: describeError(nextError) };
    }
  }, [client, enterPlatformFileAndMarkOpened, pendingDraftOpen, user]);

  // 平台文件只有这一条打开路径：每次重新读取最新内容、revision 与权限，再建立隔离的编辑器会话。
  const openPlatformAnnotationFile = useCallback(async (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ): Promise<boolean> => {
    setError(null);
    try {
      const file = await client.getAnnotationFile<ProjectData>(resource.id);
      const serverProject = hydrateProjectForClient(file.payload, client);
      // 草稿严格按当前登录账号和文件读取；未知或损坏数据不能通过类型断言进入编辑器。
      if (!user) throw new Error("登录会话尚未恢复，请刷新后重试。");
      const rawDraft = await platformDraftStore.get(user.id, resource.id);
      const draft = normalizePlatformDraftRecord(rawDraft, {
        userId: user.id,
        annotationFileId: resource.id,
      });
      if (rawDraft !== null && !draft) {
        // 损坏草稿不能进入 document state，但也不能永久阻塞文件；仅在用户明确确认后删除并继续。
        const shouldDiscardInvalidDraft = window.confirm(
          "浏览器中的本地草稿格式已损坏或不兼容，无法安全恢复。\n\n"
          + "是否删除这份无效草稿并打开服务器版本？取消将保留草稿且不打开文件。",
        );
        if (!shouldDiscardInvalidDraft) return false;
        await platformDraftStore.delete(user.id, resource.id);
        await enterPlatformFileAndMarkOpened({ file, initialProject: serverProject, initialFocus });
        return true;
      }
      if (draft) {
        const compatibility = assessPlatformDraftCompatibility(draft, file.revision);
        setDraftConflictVisible(false);
        setPendingDraftOpen({
          file,
          serverProject,
          initialFocus,
          draft,
          mode: !file.resource.permission.capabilities.includes("write")
            ? "read-only"
            : compatibility.status,
        });
        return true;
      }
      await enterPlatformFileAndMarkOpened({ file, initialProject: serverProject, initialFocus });
      return true;
    } catch (nextError) {
      const message = describeError(nextError);
      setError(message);
      // 资源管理器当前没有承载外层错误条，打开失败时需要立即给出可见反馈并保留原页面状态。
      window.alert(message);
      return false;
    }
  }, [client, enterPlatformFileAndMarkOpened, user]);

  // 同 revision 草稿恢复保留本地 operation id/revision；媒体 URL 在恢复时重新按当前会话生成。
  const recoverPendingDraft = useCallback(async () => {
    const pending = pendingDraftOpen;
    if (!pending || pending.mode !== "recoverable" || draftDecisionBusy) return;
    setDraftDecisionBusy(true);
    try {
      const recoveryState = toProjectDocumentRecoveryState(
        pending.draft,
        (project) => hydrateProjectForClient(project, client),
      );
      await enterPlatformFileAndMarkOpened({
        file: pending.file,
        initialProject: recoveryState.currentProject,
        initialFocus: pending.initialFocus,
        initialRecoveryState: recoveryState,
      });
      setPendingDraftOpen(null);
      setDraftConflictVisible(false);
    } catch (nextError) {
      const message = describeError(nextError);
      setError(message);
      window.alert(message);
    } finally {
      setDraftDecisionBusy(false);
    }
  }, [client, draftDecisionBusy, enterPlatformFileAndMarkOpened, pendingDraftOpen]);

  // 丢弃是显式不可逆决策：先删除 IndexedDB 草稿成功，再打开最新服务器内容。
  const discardPendingDraftAndOpen = useCallback(async () => {
    const pending = pendingDraftOpen;
    if (!pending || draftDecisionBusy) return;
    setDraftDecisionBusy(true);
    try {
      await platformDraftStore.delete(pending.draft.userId, pending.draft.annotationFileId);
      await enterPlatformFileAndMarkOpened({
        file: pending.file,
        initialProject: pending.serverProject,
        initialFocus: pending.initialFocus,
      });
      setPendingDraftOpen(null);
      setDraftConflictVisible(false);
    } catch (nextError) {
      const message = describeError(nextError);
      setError(message);
      window.alert(message);
    } finally {
      setDraftDecisionBusy(false);
    }
  }, [draftDecisionBusy, enterPlatformFileAndMarkOpened, pendingDraftOpen]);

  // 选择性整合准备会重新读取并重建整套语义计划；任何过期、权限或结构变化都留在比较页报告。
  const prepareAnnotationMerge = useCallback(async (
    request: AnnotationMergePreparationRequest,
  ): Promise<AnnotationMergePreparationResult> => {
    try {
      const [leftFile, rightFile] = await Promise.all([
        client.getAnnotationFile<unknown>(request.leftResourceId),
        client.getAnnotationFile<unknown>(request.rightResourceId),
      ]);
      const prepared = prepareAnnotationMergeDraft({
        leftFile,
        rightFile,
        request,
        hydrateProject: (project) => hydrateProjectForClient(project, client),
      });
      if (!prepared.ok) return prepared;
      const typedTargetFile = prepared.value.targetFile as AnnotationFile<ProjectData>;
      // 整合草稿不能绕过本地恢复草稿：先让用户普通打开目标文件处理草稿，再重新比较生成新计划。
      if (!user) return { ok: false, message: "登录会话尚未恢复，请刷新后重试。" };
      const rawDraft = await platformDraftStore.get(user.id, typedTargetFile.resource.id);
      if (rawDraft !== null) {
        const localDraft = normalizePlatformDraftRecord(rawDraft, {
          userId: user.id,
          annotationFileId: typedTargetFile.resource.id,
        });
        return {
          ok: false,
          message: localDraft
            ? "目标文件存在未处理的浏览器草稿。请先普通打开目标文件，恢复或丢弃草稿后再重新比较。"
            : "目标文件存在损坏或不兼容的浏览器草稿，暂不允许准备整合以避免覆盖本地数据。",
        };
      }
      await enterPlatformEditor({
        file: typedTargetFile,
        initialProject: prepared.value.draft.baseProject,
        pendingMergeDraft: prepared.value.draft,
      });
      return { ok: true };
    } catch (nextError) {
      return { ok: false, message: describeError(nextError) };
    }
  }, [client, enterPlatformEditor, user]);

  if (view === "login") {
    return (
      <main className="platform-login-shell">
        <form className="platform-login-panel" onSubmit={login}>
          <div className="platform-login-mark"><HardDrive size={24} /></div>
          <p className="platform-kicker">Kunqu Research Assets</p>
          <h1>戏曲多模态标注平台</h1>
          <p>管理项目、媒体、标注文件与逐文件账号权限。</p>
          {error ? <div className="platform-error">{error}</div> : null}
          <label>
            账号
            <input
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="platform-primary-button">登录平台</button>
          <button
            type="button"
            className="platform-secondary-button"
            onClick={() => openLocal(mockProject, "本地示例项目")}
          >
            不登录，进入本地标注工具
          </button>
          <small>开发账号：admin / admin123</small>
        </form>
      </main>
    );
  }

  if (view === "editor") {
    const serverFile = Boolean(editorSession);
    return renderEditor(editorSession, localSession, {
      label: serverFile ? "返回资源管理器" : "退出本地工具",
      title: serverFile ? "返回平台资源管理器" : "返回登录入口",
      onBack: () => setView(serverFile ? "explorer" : "login"),
    });
  }

  return (
    <>
      <ResourceExplorer
        client={client}
        user={user}
        onLogout={() => {
          window.localStorage.removeItem(TOKEN_KEY);
          setAccessToken(null);
          setUser(null);
          setPendingDraftOpen(null);
          setDraftConflictVisible(false);
          setView("login");
        }}
        onOpenLocalJson={openLocal}
        onOpenAnnotationFile={openPlatformAnnotationFile}
        onPrepareAnnotationMerge={prepareAnnotationMerge}
      />
      {pendingDraftOpen && draftConflictVisible ? (
        <PlatformDraftConflictDialog
          file={pendingDraftOpen.file}
          draft={pendingDraftOpen.draft}
          onBack={() => setDraftConflictVisible(false)}
          onPrepare={preparePendingDraftConflict}
        />
      ) : pendingDraftOpen ? (
        <PlatformDraftRecoveryDialog
          fileName={pendingDraftOpen.file.resource.name}
          remoteRevision={pendingDraftOpen.file.revision}
          draft={pendingDraftOpen.draft}
          mode={pendingDraftOpen.mode}
          busy={draftDecisionBusy}
          onCancel={() => {
            setPendingDraftOpen(null);
            setDraftConflictVisible(false);
          }}
          onRecover={() => void recoverPendingDraft()}
          onCompareConflict={() => setDraftConflictVisible(true)}
          onDiscardAndOpen={() => void discardPendingDraftAndOpen()}
        />
      ) : null}
    </>
  );
}

// 前端只用祖先 owner 结果决定是否展示命令；服务端仍会在事务内重新遍历并执行权威校验。
async function hasAncestorOwnerAuthority(
  client: PlatformClient,
  initialParentId: string | null | undefined,
  userId: string,
): Promise<boolean> {
  let parentId = initialParentId ?? null;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = await client.getResource(parentId).catch(() => null);
    if (!parent) return false;
    if (parent.owner.id === userId) return true;
    parentId = parent.parentId ?? null;
  }
  return false;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
