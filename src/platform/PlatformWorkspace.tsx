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
import { normalizeImportedProjectFile } from "../utils/projectFile";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import type {
  AnnotationMergeDraft,
  AnnotationMergePreparationRequest,
  AnnotationMergePreparationResult,
} from "./annotationMergeDraft";
import { prepareAnnotationMergeDraft } from "./annotationMergePreparation";
import { ResourceExplorer } from "./ResourceExplorer";

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

const TOKEN_KEY = "xiqu-platform-dev-token";
const PLATFORM_FILE_PATH_PREFIX = "platform-file:";

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

  // 平台文件只有这一条打开路径：每次重新读取最新内容、revision 与权限，再建立隔离的编辑器会话。
  const openPlatformAnnotationFile = useCallback(async (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ): Promise<boolean> => {
    setError(null);
    try {
      const file = await client.getAnnotationFile<ProjectData>(resource.id);
      await enterPlatformEditor({
        file,
        initialProject: hydrateProjectForClient(file.payload, client),
        initialFocus,
      });
      // 最近打开失败不应阻止已读取的文件进入编辑器；维护模式下该辅助写入会被预期拒绝。
      void client.markResourceOpened(resource.id).catch((markError) => {
        console.warn("记录最近打开失败", markError);
      });
      return true;
    } catch (nextError) {
      const message = describeError(nextError);
      setError(message);
      // 资源管理器当前没有承载外层错误条，打开失败时需要立即给出可见反馈并保留原页面状态。
      window.alert(message);
      return false;
    }
  }, [client, enterPlatformEditor]);

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
      await enterPlatformEditor({
        file: typedTargetFile,
        initialProject: prepared.value.draft.baseProject,
        pendingMergeDraft: prepared.value.draft,
      });
      return { ok: true };
    } catch (nextError) {
      return { ok: false, message: describeError(nextError) };
    }
  }, [client, enterPlatformEditor]);

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
    <ResourceExplorer
      client={client}
      user={user}
      onLogout={() => {
        window.localStorage.removeItem(TOKEN_KEY);
        setAccessToken(null);
        setUser(null);
        setView("login");
      }}
      onOpenLocalJson={openLocal}
      onOpenAnnotationFile={openPlatformAnnotationFile}
      onPrepareAnnotationMerge={prepareAnnotationMerge}
    />
  );
}

export function hydrateProjectForClient(
  payload: unknown,
  client: PlatformClient,
): ProjectData {
  const project = normalizeImportedProjectFile(payload).project;
  const fileId = getPlatformFileId(project.video.filePath);
  if (!fileId) return project;
  return {
    ...project,
    video: {
      ...project.video,
      url: client.getFileContentUrl(fileId),
      source: "url",
      filePath: `${PLATFORM_FILE_PATH_PREFIX}${fileId}`,
    },
  };
}


export function prepareProjectForServer(project: ProjectData): ProjectData {
  const fileId = getPlatformFileId(project.video.filePath);
  return {
    ...project,
    video: fileId
      ? {
          ...project.video,
          // 会话 token 不落盘，打开文件时再生成受保护的媒体 URL。
          url: "",
          source: "url",
          filePath: `${PLATFORM_FILE_PATH_PREFIX}${fileId}`,
        }
      : project.video,
  };
}

function getPlatformFileId(filePath: string | null | undefined) {
  return filePath?.startsWith(PLATFORM_FILE_PATH_PREFIX)
    ? filePath.slice(PLATFORM_FILE_PATH_PREFIX.length)
    : null;
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
