import { HardDrive } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { AnnotationFile, PlatformUser } from "@xiqu/shared";
import { PlatformClient } from "../api/platformClient";
import type { TopMenuPlatformNavigation } from "../components/TopMenuBar";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { normalizeImportedProjectFile } from "../utils/projectFile";
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
  accessLabel: string;
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
      onOpenAnnotationFile={async (resource) => {
        try {
          const file = await client.getAnnotationFile<ProjectData>(resource.id);
          const parent = file.resource.parentId
            ? await client.getResource(file.resource.parentId).catch(() => null)
            : null;
          const next: PlatformEditorSession = {
            client,
            annotationFileId: file.resource.id,
            annotationFileName: file.resource.name,
            projectTitle: parent?.name ?? "平台标注项目",
            baseRevision: file.revision,
            initialProject: hydrateProjectForClient(file.payload, client),
            canWrite: file.resource.permission.capabilities.includes("write"),
            accessLabel: file.resource.permission.isOwner
              ? "文件所有者"
              : file.resource.permission.capabilities.includes("write")
                ? "可编辑"
                : "只读",
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
        } catch (nextError) {
          const message = describeError(nextError);
          setError(message);
          // 资源管理器当前没有承载外层错误条，打开失败时需要立即给出可见反馈。
          window.alert(message);
        }
      }}
    />
  );
}

function hydrateProjectForClient(
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

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
