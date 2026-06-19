import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { PlatformApiError, PlatformClient } from "../api/platformClient";
import type {
  AnnotationDocumentSummary,
  AnnotationProjectSummary,
  PlatformUser,
} from "../../packages/shared/src/index";

type PlatformWorkspaceProps = {
  renderEditor: () => JSX.Element;
};

type PlatformView = "login" | "home" | "editor";

const PLATFORM_TOKEN_STORAGE_KEY = "xiqu-platform-dev-token";

export function PlatformWorkspace({ renderEditor }: PlatformWorkspaceProps) {
  const [view, setView] = useState<PlatformView>(() =>
    window.localStorage.getItem(PLATFORM_TOKEN_STORAGE_KEY) ? "home" : "login",
  );
  const [accountName, setAccountName] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    window.localStorage.getItem(PLATFORM_TOKEN_STORAGE_KEY),
  );
  const [projects, setProjects] = useState<AnnotationProjectSummary[]>([]);
  const [documentsByProjectId, setDocumentsByProjectId] = useState<Record<string, AnnotationDocumentSummary[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const client = useMemo(() => new PlatformClient({
    baseUrl: "http://localhost:4317/api",
    accessToken,
  }), [accessToken]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const selectedDocuments = selectedProject ? documentsByProjectId[selectedProject.id] ?? [] : [];
  const selectedDocument = selectedDocuments.find((document) => document.id === selectedDocumentId) ?? selectedDocuments[0] ?? null;

  useEffect(() => {
    if (!accessToken || view === "login") {
      return;
    }
    void loadPlatformHome(client);
  }, [accessToken, client, view]);

  async function loadPlatformHome(nextClient = client) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [nextUser, nextProjects] = await Promise.all([
        nextClient.me(),
        nextClient.listProjects(),
      ]);
      const nextDocumentsByProjectId: Record<string, AnnotationDocumentSummary[]> = {};
      for (const project of nextProjects) {
        nextDocumentsByProjectId[project.id] = await nextClient.listProjectDocuments(project.id);
      }
      setUser(nextUser);
      setProjects(nextProjects);
      setDocumentsByProjectId(nextDocumentsByProjectId);
      setSelectedProjectId((current) => current ?? nextProjects[0]?.id ?? null);
      setSelectedDocumentId((current) => {
        if (current) {
          return current;
        }
        const firstProjectId = nextProjects[0]?.id;
        return firstProjectId ? nextDocumentsByProjectId[firstProjectId]?.[0]?.id ?? null : null;
      });
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
      if (error instanceof PlatformApiError && error.status === 401) {
        window.localStorage.removeItem(PLATFORM_TOKEN_STORAGE_KEY);
        setAccessToken(null);
        setUser(null);
        setView("login");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const loginResult = await client.login({ accountName, password });
      window.localStorage.setItem(PLATFORM_TOKEN_STORAGE_KEY, loginResult.accessToken);
      setAccessToken(loginResult.accessToken);
      setUser(loginResult.user);
      setView("home");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  function handleLogout() {
    window.localStorage.removeItem(PLATFORM_TOKEN_STORAGE_KEY);
    setAccessToken(null);
    setUser(null);
    setProjects([]);
    setDocumentsByProjectId({});
    setSelectedProjectId(null);
    setSelectedDocumentId(null);
    setView("login");
  }

  if (view === "editor") {
    return (
      <div className="platform-editor-host">
        <div className="platform-editor-return-bar">
          <button type="button" onClick={() => setView("home")}>
            返回平台主页
          </button>
          <span>
            {selectedProject?.title ?? "本地标注项目"}
            {selectedDocument ? ` / ${selectedDocument.title}` : ""}
          </span>
        </div>
        <div className="platform-editor-body">
          {renderEditor()}
        </div>
      </div>
    );
  }

  if (view === "login") {
    return (
      <main className="platform-shell">
        <section className="platform-login-panel">
          <div className="platform-login-copy">
            <span className="platform-kicker">Kunqu Research Workspace</span>
            <h1>昆曲多模态标注平台</h1>
            <p>
              统一管理视频、标注文档、课堂任务、版本与协同编辑。当前为后端骨架接入阶段，
              可使用开发账号验证平台入口。
            </p>
          </div>
          <form className="platform-login-form" onSubmit={handleLogin}>
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
                value={password}
                type="password"
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            {errorMessage ? <p className="platform-error" role="alert">{errorMessage}</p> : null}
            <button type="submit" disabled={isLoading}>
              {isLoading ? "正在登录..." : "登录平台"}
            </button>
            <button type="button" className="platform-secondary-button" onClick={() => setView("editor")}>
              不登录，进入本地标注工具
            </button>
            <p className="platform-login-hint">开发账号：admin/admin123、ta/ta123、student/student123</p>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="platform-shell">
      <header className="platform-topbar">
        <div className="platform-brand">
          <span className="top-menu-brand-dot" />
          <div>
            <strong>戏曲多轨标注工作台</strong>
            <span>数据库平台预览</span>
          </div>
        </div>
        <div className="platform-user-box">
          <span>{user ? `${user.displayName} · ${user.roles.join("/")}` : "未连接账号"}</span>
          <button type="button" onClick={() => void loadPlatformHome()} disabled={isLoading}>
            刷新
          </button>
          <button type="button" onClick={handleLogout}>
            退出
          </button>
        </div>
      </header>

      <section className="platform-dashboard">
        <aside className="platform-sidebar">
          <h2>平台导航</h2>
          <button type="button" className="active">项目库</button>
          <button type="button" disabled>课堂作业</button>
          <button type="button" disabled>账号权限</button>
          <button type="button" disabled>后端任务</button>
          <div className="platform-sidebar-note">
            这些入口先保留位置，后续会逐步接入课程、权限和任务队列。
          </div>
        </aside>

        <section className="platform-main-panel">
          <div className="platform-section-header">
            <div>
              <span className="platform-kicker">Project Library</span>
              <h1>视频与标注文档</h1>
            </div>
            <button type="button" onClick={() => setView("editor")}>
              进入当前标注工具
            </button>
          </div>

          {errorMessage ? <p className="platform-error" role="alert">{errorMessage}</p> : null}
          {isLoading ? <p className="platform-muted">正在从后端加载项目...</p> : null}

          <div className="platform-grid">
            <div className="platform-list-panel">
              <h2>项目</h2>
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={project.id === selectedProject?.id ? "selected" : ""}
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setSelectedDocumentId(documentsByProjectId[project.id]?.[0]?.id ?? null);
                  }}
                >
                  <strong>{project.title}</strong>
                  <span>{project.documentCount} 份标注文档</span>
                </button>
              ))}
              {!projects.length && !isLoading ? <p className="platform-muted">暂无项目。</p> : null}
            </div>

            <div className="platform-detail-panel">
              <div className="platform-detail-title">
                <h2>{selectedProject?.title ?? "未选择项目"}</h2>
                <span>{selectedProject?.updatedAt ? `更新于 ${selectedProject.updatedAt}` : "等待加载"}</span>
              </div>
              <div className="platform-document-list">
                {selectedDocuments.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className={document.id === selectedDocument?.id ? "selected" : ""}
                    onClick={() => setSelectedDocumentId(document.id)}
                  >
                    <strong>{document.title}</strong>
                    <span>{document.mode === "collaborative" ? "协作标注" : "独立标注"}</span>
                  </button>
                ))}
                {!selectedDocuments.length ? <p className="platform-muted">该项目暂无可访问标注文档。</p> : null}
              </div>
              <div className="platform-action-row">
                <button type="button" onClick={() => setView("editor")}>
                  打开标注编辑器
                </button>
                <button type="button" disabled>
                  保存为新版本
                </button>
                <button type="button" disabled>
                  分配标注范围
                </button>
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function getPlatformErrorMessage(error: unknown) {
  if (error instanceof PlatformApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "平台请求失败，请确认后端 API 是否已启动。";
}
