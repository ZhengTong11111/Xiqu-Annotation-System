import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { PlatformApiError, PlatformClient } from "../api/platformClient";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { buildProjectFromLines } from "../utils/project";
import {
  isProjectFileLike,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import type {
  AnnotationDocument,
  AnnotationDocumentSummary,
  AnnotationMode,
  AnnotationProjectSummary,
  AnnotationVersion,
  EffectiveDocumentPermission,
  MediaAsset,
  PlatformUser,
} from "@xiqu/shared";
import type { TopMenuPlatformNavigation } from "../components/TopMenuBar";
import { CourseWorkspace } from "./CourseWorkspace";

export type PlatformEditorSession = {
  client: PlatformClient;
  documentId: string;
  documentTitle: string;
  projectTitle: string;
  baseRevision: number;
  initialProject: ProjectData;
  onDocumentSaved: (document: AnnotationDocument<ProjectData>) => void;
  effectivePermission: EffectiveDocumentPermission;
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

type PlatformView = "login" | "home" | "editor";
type PlatformHomeSection = "projects" | "courses";

const PLATFORM_TOKEN_STORAGE_KEY = "xiqu-platform-dev-token";
const PLATFORM_FILE_PATH_PREFIX = "platform-file:";

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
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [documentsByProjectId, setDocumentsByProjectId] = useState<Record<string, AnnotationDocumentSummary[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [editorSession, setEditorSession] = useState<PlatformEditorSession | null>(null);
  const [localEditorSession, setLocalEditorSession] = useState<LocalEditorSession | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newDocumentTitle, setNewDocumentTitle] = useState("基准标注文档");
  const [newDocumentMode, setNewDocumentMode] = useState<AnnotationMode>("collaborative");
  const [jsonImportFile, setJsonImportFile] = useState<File | null>(null);
  const [jsonImportTitle, setJsonImportTitle] = useState("");
  const [jsonImportMode, setJsonImportMode] = useState<AnnotationMode>("independent");
  const [versionsByDocumentId, setVersionsByDocumentId] = useState<Record<string, AnnotationVersion<ProjectData>[]>>({});
  const [permissionsByDocumentId, setPermissionsByDocumentId] = useState<Record<string, EffectiveDocumentPermission>>({});
  const [versionName, setVersionName] = useState("");
  const [versionDescription, setVersionDescription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [homeSection, setHomeSection] = useState<PlatformHomeSection>("projects");

  const client = useMemo(() => new PlatformClient({
    baseUrl: "http://localhost:4317/api",
    accessToken,
  }), [accessToken]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const selectedDocuments = selectedProject ? documentsByProjectId[selectedProject.id] ?? [] : [];
  const selectedDocument = selectedDocuments.find((document) => document.id === selectedDocumentId) ?? selectedDocuments[0] ?? null;
  const selectedVersions = selectedDocument ? versionsByDocumentId[selectedDocument.id] ?? [] : [];
  const selectedPermission = selectedDocument
    ? permissionsByDocumentId[selectedDocument.id]
    : undefined;

  useEffect(() => {
    if (!accessToken || view === "login") {
      return;
    }
    void loadPlatformHome(client);
  }, [accessToken, client, view]);

  useEffect(() => {
    if (!selectedDocument || view !== "home") {
      return;
    }
    void loadDocumentVersions(selectedDocument.id);
  }, [selectedDocument?.id, view]);

  async function loadPlatformHome(nextClient = client) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [nextUser, nextProjects, nextMediaAssets] = await Promise.all([
        nextClient.me(),
        nextClient.listProjects(),
        nextClient.listMediaAssets(),
      ]);
      const nextDocumentsByProjectId: Record<string, AnnotationDocumentSummary[]> = {};
      for (const project of nextProjects) {
        nextDocumentsByProjectId[project.id] = await nextClient.listProjectDocuments(project.id);
      }
      setUser(nextUser);
      setProjects(nextProjects);
      setMediaAssets(nextMediaAssets);
      setDocumentsByProjectId(nextDocumentsByProjectId);
      setSelectedProjectId((current) => {
        if (current && nextProjects.some((project) => project.id === current)) {
          return current;
        }
        return nextProjects[0]?.id ?? null;
      });
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

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile) {
      setErrorMessage("请先选择要上传的视频或音频文件。");
      return;
    }
    setIsCreatingProject(true);
    setErrorMessage(null);
    try {
      const uploaded = await client.uploadFile(uploadFile);
      const title = newProjectTitle.trim() || stripFileExtension(uploadFile.name);
      const mediaAsset = await client.createMediaAsset({
        title,
        primaryFileId: uploaded.file.id,
      });
      const project = await client.createProject({
        title,
        mediaAssetId: mediaAsset.id,
      });
      const initialProject = createEmptyProjectForFile(uploaded.file.id, uploaded.file.name, client);
      const document = await client.createAnnotationDocument<ProjectData>(project.id, {
        title: newDocumentTitle.trim() || "基准标注文档",
        mode: newDocumentMode,
        initialPayload: prepareProjectForServer(initialProject),
      });
      await loadPlatformHome();
      setSelectedProjectId(project.id);
      setSelectedDocumentId(document.id);
      setUploadFile(null);
      setNewProjectTitle("");
      setNewDocumentTitle("基准标注文档");
      const effectivePermission = await client.getEffectiveDocumentPermission(document.id);
      setPermissionsByDocumentId((current) => ({
        ...current,
        [document.id]: effectivePermission,
      }));
      setEditorSession(createEditorSession(
        document,
        client,
        handleDocumentSaved,
        effectivePermission,
      ));
      setView("editor");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleImportJsonDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject) {
      setErrorMessage("请先选择要导入到哪个项目。");
      return;
    }
    if (!jsonImportFile) {
      setErrorMessage("请选择要导入的项目 JSON 文件。");
      return;
    }
    setIsImportingJson(true);
    setErrorMessage(null);
    try {
      const importedProject = await readProjectJsonFile(jsonImportFile);
      const document = await client.createAnnotationDocument<ProjectData>(selectedProject.id, {
        title: jsonImportTitle.trim() || stripFileExtension(jsonImportFile.name),
        mode: jsonImportMode,
        initialPayload: prepareProjectForServer(importedProject),
      });
      await loadPlatformHome();
      setSelectedProjectId(selectedProject.id);
      setSelectedDocumentId(document.id);
      setJsonImportFile(null);
      setJsonImportTitle("");
      setVersionsByDocumentId((current) => ({
        ...current,
        [document.id]: [],
      }));
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsImportingJson(false);
    }
  }

  async function handleOpenSelectedDocument() {
    if (!selectedDocument) {
      openLocalDemoProject();
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [document, effectivePermission] = await Promise.all([
        client.getAnnotationDocument<ProjectData>(selectedDocument.id),
        client.getEffectiveDocumentPermission(selectedDocument.id),
      ]);
      setPermissionsByDocumentId((current) => ({
        ...current,
        [selectedDocument.id]: effectivePermission,
      }));
      setEditorSession(createEditorSession(document, client, handleDocumentSaved, effectivePermission));
      setLocalEditorSession(null);
      setView("editor");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOpenDocumentById(documentId: string) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [document, effectivePermission] = await Promise.all([
        client.getAnnotationDocument<ProjectData>(documentId),
        client.getEffectiveDocumentPermission(documentId),
      ]);
      setPermissionsByDocumentId((current) => ({ ...current, [documentId]: effectivePermission }));
      setEditorSession(createEditorSession(document, client, handleDocumentSaved, effectivePermission));
      setLocalEditorSession(null);
      setView("editor");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDocumentVersions(documentId: string) {
    setIsLoadingVersions(true);
    setErrorMessage(null);
    try {
      const [versions, effectivePermission] = await Promise.all([
        client.listAnnotationVersions<ProjectData>(documentId),
        client.getEffectiveDocumentPermission(documentId),
      ]);
      setVersionsByDocumentId((current) => ({
        ...current,
        [documentId]: versions,
      }));
      setPermissionsByDocumentId((current) => ({
        ...current,
        [documentId]: effectivePermission,
      }));
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoadingVersions(false);
    }
  }

  async function handleCreateVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDocument) {
      setErrorMessage("请先选择要保存版本的标注文档。");
      return;
    }
    if (!selectedPermission?.canEdit) {
      setErrorMessage("当前账号没有为该文档创建版本的权限。");
      return;
    }
    const trimmedName = versionName.trim();
    if (!trimmedName) {
      setErrorMessage("版本名称不能为空。");
      return;
    }
    setIsCreatingVersion(true);
    setErrorMessage(null);
    try {
      await client.createAnnotationVersion<ProjectData>(selectedDocument.id, {
        name: trimmedName,
        description: versionDescription.trim() || null,
      });
      setVersionName("");
      setVersionDescription("");
      await loadDocumentVersions(selectedDocument.id);
      await loadPlatformHome();
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsCreatingVersion(false);
    }
  }

  async function handleRestoreVersion(version: AnnotationVersion<ProjectData>) {
    if (!selectedPermission?.canManage) {
      setErrorMessage("恢复版本需要该文档的管理权限。");
      return;
    }
    if (!window.confirm(`确定要从版本“${version.name}”恢复吗？恢复会基于该版本生成新的当前快照。`)) {
      return;
    }
    setIsLoadingVersions(true);
    setErrorMessage(null);
    try {
      const restoredDocument = await client.restoreAnnotationVersion<ProjectData>(version.id);
      handleDocumentSaved(restoredDocument);
      setSelectedProjectId(restoredDocument.projectId);
      setSelectedDocumentId(restoredDocument.id);
      await loadDocumentVersions(restoredDocument.id);
      await loadPlatformHome();
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoadingVersions(false);
    }
  }

  function handleDocumentSaved(document: AnnotationDocument<ProjectData>) {
    // 保存后重建 session：沿用当前 effectivePermission（权限范围不因保存而变化）。
    const effectivePermission = permissionsByDocumentId[document.id] ??
      editorSession?.effectivePermission;
    if (effectivePermission) {
      setEditorSession(createEditorSession(
        document,
        client,
        handleDocumentSaved,
        effectivePermission,
      ));
    }
    setLocalEditorSession(null);
    setDocumentsByProjectId((current) => ({
      ...current,
      [document.projectId]: (current[document.projectId] ?? []).map((item) =>
        item.id === document.id
          ? {
              id: document.id,
              projectId: document.projectId,
              title: document.title,
              mode: document.mode,
              currentVersionId: document.currentVersionId,
              updatedAt: document.updatedAt,
            }
          : item,
      ),
    }));
  }

  function handleLogout() {
    window.localStorage.removeItem(PLATFORM_TOKEN_STORAGE_KEY);
    setAccessToken(null);
    setUser(null);
    setProjects([]);
    setMediaAssets([]);
    setDocumentsByProjectId({});
    setSelectedProjectId(null);
    setSelectedDocumentId(null);
    setEditorSession(null);
    setLocalEditorSession(null);
    setVersionsByDocumentId({});
    setPermissionsByDocumentId({});
    setView("login");
  }

  function openLocalDemoProject() {
    setEditorSession(null);
    setLocalEditorSession(createLocalEditorSession(mockProject, "本地示例项目", "demo"));
    setView("editor");
  }

  async function handleOpenLocalProjectJson(file: File) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const importedProject = await readProjectJsonFile(file);
      setEditorSession(null);
      setLocalEditorSession(createLocalEditorSession(
        importedProject,
        stripFileExtension(file.name) || "本地标注项目",
        "json",
      ));
      setView("editor");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  function handleLocalProjectFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void handleOpenLocalProjectJson(file);
    }
    event.target.value = "";
  }

  if (view === "editor") {
    const isServerDocument = Boolean(editorSession);
    const platformNavigation: TopMenuPlatformNavigation = {
      label: isServerDocument || accessToken ? "← 平台" : "← 入口",
      title: isServerDocument || accessToken ? "返回平台主页" : "返回登录与本地入口",
      onBack: () => setView(isServerDocument || accessToken ? "home" : "login"),
    };

    return (
      <div className="platform-editor-host">
        <div className="platform-editor-body">
          {renderEditor(editorSession, localEditorSession, platformNavigation)}
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
              统一管理视频、标注文档、课堂任务、版本与协同编辑。当前接入真实后端与数据库，
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
            <div className="platform-local-entry-panel">
              <div>
                <span className="platform-kicker">Local Workspace</span>
                <strong>不登录，进入本地标注工具</strong>
                <span>本地导入、编辑和保存 JSON，不连接服务器账号。</span>
              </div>
              <div className="platform-local-entry-actions">
                <button type="button" className="platform-secondary-button" onClick={openLocalDemoProject}>
                  新建本地示例项目
                </button>
                <label className="platform-file-button">
                  打开本地项目 JSON
                  <input type="file" accept="application/json,.json" onChange={handleLocalProjectFileChange} />
                </label>
              </div>
            </div>
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
          <button type="button" onClick={openLocalDemoProject}>
            本地工具
          </button>
          <label className="platform-topbar-file-button">
            打开本地 JSON
            <input type="file" accept="application/json,.json" onChange={handleLocalProjectFileChange} />
          </label>
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
          <button type="button" className={homeSection === "projects" ? "active" : ""} onClick={() => setHomeSection("projects")}>项目库</button>
          <button type="button" className={homeSection === "courses" ? "active" : ""} onClick={() => setHomeSection("courses")}>课堂作业</button>
          <button type="button" disabled>账号权限</button>
          <button type="button" disabled>后端任务</button>
          <div className="platform-sidebar-note">
            当前已接入 PostgreSQL、文件上传、项目库和服务端标注文档保存。
          </div>
        </aside>

        <section className="platform-main-panel">
          {errorMessage ? <p className="platform-error" role="alert">{errorMessage}</p> : null}
          {homeSection === "courses" ? (
            <CourseWorkspace
              client={client}
              user={user!}
              projects={projects}
              documentsByProjectId={documentsByProjectId}
              onOpenDocument={handleOpenDocumentById}
              onError={setErrorMessage}
            />
          ) : (
          <>
          <div className="platform-section-header">
            <div>
              <span className="platform-kicker">Project Library</span>
              <h1>视频与标注文档</h1>
            </div>
            <button type="button" onClick={() => void handleOpenSelectedDocument()} disabled={isLoading}>
              打开选中文档
            </button>
          </div>

          {isLoading ? <p className="platform-muted">正在从后端加载项目...</p> : null}

          <form className="platform-create-panel" onSubmit={handleCreateProject}>
            <div>
              <span className="platform-kicker">Upload</span>
              <h2>上传媒体并创建项目</h2>
            </div>
            <label>
              媒体文件
              <input type="file" accept="video/*,audio/*" onChange={handleUploadFileChange} />
            </label>
            <label>
              项目标题
              <input
                value={newProjectTitle}
                onChange={(event) => setNewProjectTitle(event.target.value)}
                placeholder={uploadFile ? stripFileExtension(uploadFile.name) : "例如：顾卫英《寻梦》"}
              />
            </label>
            <label>
              初始文档
              <input
                value={newDocumentTitle}
                onChange={(event) => setNewDocumentTitle(event.target.value)}
              />
            </label>
            <label>
              标注模式
              <select value={newDocumentMode} onChange={(event) => setNewDocumentMode(event.target.value as AnnotationMode)}>
                <option value="collaborative">协作标注</option>
                <option value="independent">独立标注</option>
              </select>
            </label>
            <button type="submit" disabled={isCreatingProject}>
              {isCreatingProject ? "正在创建..." : "上传并创建"}
            </button>
          </form>

          <form className="platform-create-panel platform-json-import-panel" onSubmit={handleImportJsonDocument}>
            <div>
              <span className="platform-kicker">Import JSON</span>
              <h2>导入现有标注 JSON</h2>
            </div>
            <label>
              项目 JSON
              <input type="file" accept="application/json,.json" onChange={handleJsonImportFileChange} />
            </label>
            <label>
              文档标题
              <input
                value={jsonImportTitle}
                onChange={(event) => setJsonImportTitle(event.target.value)}
                placeholder={jsonImportFile ? stripFileExtension(jsonImportFile.name) : "导入后显示的文档名"}
              />
            </label>
            <label>
              标注模式
              <select value={jsonImportMode} onChange={(event) => setJsonImportMode(event.target.value as AnnotationMode)}>
                <option value="independent">独立标注</option>
                <option value="collaborative">协作标注</option>
              </select>
            </label>
            <button type="submit" disabled={!selectedProject || isImportingJson}>
              {isImportingJson ? "正在导入..." : "导入到当前项目"}
            </button>
          </form>

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
                <span>{selectedProject?.updatedAt ? `更新于 ${formatDateTime(selectedProject.updatedAt)}` : "等待加载"}</span>
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
                <button type="button" onClick={() => void handleOpenSelectedDocument()} disabled={!selectedDocument || isLoading}>
                  打开标注编辑器
                </button>
                <button type="button" onClick={() => selectedDocument && void loadDocumentVersions(selectedDocument.id)} disabled={!selectedDocument || isLoadingVersions}>
                  刷新版本
                </button>
              </div>
              <section className="platform-version-panel">
                <div className="platform-detail-title">
                  <h2>标注版本</h2>
                  <span>{selectedDocument ? `${selectedVersions.length} 个版本` : "未选择文档"}</span>
                </div>
                <form className="platform-version-form" onSubmit={handleCreateVersion}>
                  <input
                    value={versionName}
                    onChange={(event) => setVersionName(event.target.value)}
                    placeholder="版本名称"
                    disabled={!selectedDocument || !selectedPermission?.canEdit}
                  />
                  <input
                    value={versionDescription}
                    onChange={(event) => setVersionDescription(event.target.value)}
                    placeholder="版本备注，可选"
                    disabled={!selectedDocument || !selectedPermission?.canEdit}
                  />
                  <button type="submit" disabled={!selectedDocument || !selectedPermission?.canEdit || isCreatingVersion}>
                    {isCreatingVersion ? "保存中..." : "保存版本"}
                  </button>
                </form>
                <div className="platform-version-list">
                  {isLoadingVersions ? <p className="platform-muted">正在加载版本...</p> : null}
                  {selectedVersions.map((version) => (
                    <article key={version.id} className="platform-version-item">
                      <div>
                        <strong>{version.name}</strong>
                        <span>revision {version.revision} · {formatDateTime(version.createdAt)}</span>
                        {version.description ? <p>{version.description}</p> : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRestoreVersion(version)}
                        disabled={!selectedPermission?.canManage}
                        title={selectedPermission?.canManage ? "恢复此版本" : "恢复版本需要管理权限"}
                      >
                        恢复
                      </button>
                    </article>
                  ))}
                  {selectedDocument && !isLoadingVersions && selectedVersions.length === 0 ? (
                    <p className="platform-muted">当前文档还没有手动保存的版本。</p>
                  ) : null}
                </div>
              </section>
              <div className="platform-metadata-strip">
                <span>媒体资产：{mediaAssets.length}</span>
                <span>当前版本：{selectedDocument?.currentVersionId ?? "未保存版本"}</span>
              </div>
            </div>
          </div>
          </>
          )}
        </section>
      </section>
    </main>
  );

  function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setUploadFile(file);
    if (file && !newProjectTitle.trim()) {
      setNewProjectTitle(stripFileExtension(file.name));
    }
  }

  function handleJsonImportFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setJsonImportFile(file);
    if (file && !jsonImportTitle.trim()) {
      setJsonImportTitle(stripFileExtension(file.name));
    }
  }
}

function createEditorSession(
  document: AnnotationDocument<ProjectData>,
  client: PlatformClient,
  onDocumentSaved: (document: AnnotationDocument<ProjectData>) => void,
  effectivePermission: EffectiveDocumentPermission,
): PlatformEditorSession {
  return {
    client,
    documentId: document.id,
    documentTitle: document.title,
    projectTitle: document.project.title,
    baseRevision: document.latestSnapshot.revision,
    initialProject: hydrateProjectForClient(document.latestSnapshot.payload, document.mediaAsset, client),
    onDocumentSaved,
    effectivePermission,
  };
}

function createEmptyProjectForFile(fileId: string, fileName: string, client: PlatformClient): ProjectData {
  return buildProjectFromLines([], {
    url: client.getFileContentUrl(fileId),
    name: fileName,
    source: "url",
    filePath: `${PLATFORM_FILE_PATH_PREFIX}${fileId}`,
  });
}

function createLocalEditorSession(
  initialProject: ProjectData,
  title: string,
  source: LocalEditorSession["source"],
): LocalEditorSession {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title,
    initialProject,
    source,
  };
}

function hydrateProjectForClient(payload: unknown, mediaAsset: MediaAsset, client: PlatformClient): ProjectData {
  const project = isProjectFileLike(payload) ? normalizeImportedProjectFile(payload).project : mockProject;
  const platformFileId = getPlatformFileId(project.video.filePath) ?? mediaAsset.primaryFileId;
  if (!platformFileId) {
    return project;
  }
  return {
    ...project,
    video: {
      ...project.video,
      url: client.getFileContentUrl(platformFileId),
      source: "url",
      filePath: `${PLATFORM_FILE_PATH_PREFIX}${platformFileId}`,
    },
  };
}

export function prepareProjectForServer(project: ProjectData): ProjectData {
  const platformFileId = getPlatformFileId(project.video.filePath);
  return {
    ...project,
    video: platformFileId
      ? {
          ...project.video,
          // 服务端快照不保存带短期 token 的视频 URL，打开时由平台 client 重新补齐。
          url: "",
          source: "url",
          filePath: `${PLATFORM_FILE_PATH_PREFIX}${platformFileId}`,
        }
      : project.video,
  };
}

function getPlatformFileId(filePath: string | null | undefined) {
  return filePath?.startsWith(PLATFORM_FILE_PATH_PREFIX)
    ? filePath.slice(PLATFORM_FILE_PATH_PREFIX.length)
    : null;
}

async function readProjectJsonFile(file: File): Promise<ProjectData> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  if (!isProjectFileLike(parsed)) {
    throw new Error("所选 JSON 不是有效的标注项目文件。");
  }
  return normalizeImportedProjectFile(parsed).project;
}

function stripFileExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
