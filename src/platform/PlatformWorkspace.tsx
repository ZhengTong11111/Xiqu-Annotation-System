import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type {
  AnnotationProjectSummary,
  AnnotationVersionSummary,
  AnnotationWorkspace,
  AnnotationWorkspaceSummary,
  EffectiveWorkspacePermission,
  MediaAsset,
  PlatformUser,
  ProjectVersion,
} from "@xiqu/shared";
import { PlatformApiError, PlatformClient } from "../api/platformClient";
import type { TopMenuPlatformNavigation } from "../components/TopMenuBar";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { buildProjectFromLines } from "../utils/project";
import {
  isProjectFileLike,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import { ProjectPermissionWorkspace } from "./ProjectPermissionWorkspace";

export type PlatformEditorSession = {
  client: PlatformClient;
  workspaceId: string;
  workspaceName: string;
  projectTitle: string;
  baseRevision: number;
  initialProject: ProjectData;
  onWorkspaceSaved: (workspace: AnnotationWorkspace<ProjectData>) => void;
  effectivePermission: EffectiveWorkspacePermission;
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
type PlatformHomeSection = "projects" | "permissions";
type ProjectDetailTab = "workspaces" | "annotations" | "versions";

const PLATFORM_TOKEN_STORAGE_KEY = "xiqu-platform-dev-token";
const PLATFORM_FILE_PATH_PREFIX = "platform-file:";

export function PlatformWorkspace({ renderEditor }: PlatformWorkspaceProps) {
  const [view, setView] = useState<PlatformView>(() =>
    window.localStorage.getItem(PLATFORM_TOKEN_STORAGE_KEY) ? "home" : "login"
  );
  const [accountName, setAccountName] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    window.localStorage.getItem(PLATFORM_TOKEN_STORAGE_KEY)
  );
  const [projects, setProjects] = useState<AnnotationProjectSummary[]>([]);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [workspacesByProjectId, setWorkspacesByProjectId] = useState<
    Record<string, AnnotationWorkspaceSummary[]>
  >({});
  const [annotationVersionsByProjectId, setAnnotationVersionsByProjectId] =
    useState<Record<string, AnnotationVersionSummary[]>>({});
  const [projectVersionsByProjectId, setProjectVersionsByProjectId] = useState<
    Record<string, ProjectVersion[]>
  >({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [editorSession, setEditorSession] =
    useState<PlatformEditorSession | null>(null);
  const [localEditorSession, setLocalEditorSession] =
    useState<LocalEditorSession | null>(null);
  const [homeSection, setHomeSection] =
    useState<PlatformHomeSection>("projects");
  const [detailTab, setDetailTab] =
    useState<ProjectDetailTab>("workspaces");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("项目主工作区");
  const [jsonImportFile, setJsonImportFile] = useState<File | null>(null);
  const [jsonImportName, setJsonImportName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const client = useMemo(() => new PlatformClient({
    baseUrl: "http://localhost:4317/api",
    accessToken,
  }), [accessToken]);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ??
    projects[0] ??
    null;
  const selectedWorkspaces = selectedProject
    ? workspacesByProjectId[selectedProject.id] ?? []
    : [];
  const selectedWorkspace =
    selectedWorkspaces.find((workspace) =>
      workspace.id === selectedWorkspaceId) ??
    selectedWorkspaces[0] ??
    null;
  const selectedAnnotationVersions = selectedProject
    ? annotationVersionsByProjectId[selectedProject.id] ?? []
    : [];
  const selectedProjectVersions = selectedProject
    ? projectVersionsByProjectId[selectedProject.id] ?? []
    : [];
  const canManageAnyProject = projects.some((project) =>
    project.currentUserCapabilities.includes("manage_members")
  );

  useEffect(() => {
    if (!accessToken || view === "login") return;
    void loadPlatformHome(client);
  }, [accessToken, client, view]);

  useEffect(() => {
    // 切换账号后不能沿用上一位管理员停留的权限页面。
    if (homeSection === "permissions" && !canManageAnyProject) {
      setHomeSection("projects");
    }
  }, [canManageAnyProject, homeSection]);

  async function loadPlatformHome(nextClient = client) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [nextUser, nextProjects, nextMediaAssets] = await Promise.all([
        nextClient.me(),
        nextClient.listProjects(),
        nextClient.listMediaAssets(),
      ]);
      const nextWorkspaces: Record<string, AnnotationWorkspaceSummary[]> = {};
      const nextAnnotationVersions: Record<string, AnnotationVersionSummary[]> =
        {};
      const nextProjectVersions: Record<string, ProjectVersion[]> = {};
      await Promise.all(nextProjects.map(async (project) => {
        const [workspaces, versions, projectVersions] = await Promise.all([
          nextClient.listProjectWorkspaces(project.id),
          nextClient.listProjectAnnotationVersions(project.id),
          nextClient.listProjectVersions(project.id),
        ]);
        nextWorkspaces[project.id] = workspaces;
        nextAnnotationVersions[project.id] = versions;
        nextProjectVersions[project.id] = projectVersions;
      }));
      setUser(nextUser);
      setProjects(nextProjects);
      setMediaAssets(nextMediaAssets);
      setWorkspacesByProjectId(nextWorkspaces);
      setAnnotationVersionsByProjectId(nextAnnotationVersions);
      setProjectVersionsByProjectId(nextProjectVersions);
      setSelectedProjectId((current) =>
        current && nextProjects.some((project) => project.id === current)
          ? current
          : nextProjects[0]?.id ?? null
      );
      setSelectedWorkspaceId((current) => {
        if (
          current &&
          Object.values(nextWorkspaces).some((items) =>
            items.some((workspace) => workspace.id === current))
        ) {
          return current;
        }
        const firstProjectId = nextProjects[0]?.id;
        return firstProjectId
          ? nextWorkspaces[firstProjectId]?.[0]?.id ?? null
          : null;
      });
    } catch (error) {
      handlePlatformError(error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const login = await client.login({ accountName, password });
      window.localStorage.setItem(
        PLATFORM_TOKEN_STORAGE_KEY,
        login.accessToken,
      );
      setAccessToken(login.accessToken);
      setUser(login.user);
      setHomeSection("projects");
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
      setErrorMessage("请先选择视频或音频文件。");
      return;
    }
    setIsMutating(true);
    setErrorMessage(null);
    try {
      const uploaded = await client.uploadFile(uploadFile);
      const title =
        newProjectTitle.trim() || stripFileExtension(uploadFile.name);
      const media = await client.createMediaAsset({
        title,
        primaryFileId: uploaded.file.id,
      });
      const project = await client.createProject({
        title,
        mediaAssetId: media.id,
      });
      const initialProject = createEmptyProjectForFile(
        uploaded.file.id,
        uploaded.file.name,
        client,
      );
      const workspace = await client.createWorkspace<ProjectData>(project.id, {
        name: newWorkspaceName.trim() || "项目主工作区",
        workspaceType: "main",
        initialPayload: prepareProjectForServer(initialProject),
      });
      await loadPlatformHome();
      setSelectedProjectId(project.id);
      setSelectedWorkspaceId(workspace.id);
      setUploadFile(null);
      setNewProjectTitle("");
      setNewWorkspaceName("项目主工作区");
      openServerWorkspace(workspace);
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleImportJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject || !jsonImportFile) {
      setErrorMessage("请先选择项目和要导入的 JSON 文件。");
      return;
    }
    setIsMutating(true);
    setErrorMessage(null);
    try {
      const imported = await readProjectJsonFile(jsonImportFile);
      const workspace = await client.createWorkspace<ProjectData>(
        selectedProject.id,
        {
          name:
            jsonImportName.trim() ||
            stripFileExtension(jsonImportFile.name),
          workspaceType: "personal",
          initialPayload: prepareProjectForServer(imported),
        },
      );
      setJsonImportFile(null);
      setJsonImportName("");
      await loadPlatformHome();
      setSelectedProjectId(selectedProject.id);
      setSelectedWorkspaceId(workspace.id);
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleOpenWorkspace(workspaceId = selectedWorkspace?.id) {
    if (!workspaceId) {
      setErrorMessage("请先选择工作区。");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      openServerWorkspace(
        await client.getWorkspace<ProjectData>(workspaceId),
      );
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleForkVersion(version: AnnotationVersionSummary) {
    const name = window.prompt(
      `从“${version.name}”创建新工作区：`,
      `${version.name} 的分支`,
    )?.trim();
    if (!name) return;
    setIsMutating(true);
    try {
      const workspace = await client.forkAnnotationVersion<ProjectData>(
        version.id,
        { workspaceName: name },
      );
      await loadPlatformHome();
      setSelectedProjectId(version.projectId);
      setSelectedWorkspaceId(workspace.id);
      openServerWorkspace(workspace);
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleCreateProjectVersion(version: AnnotationVersionSummary) {
    if (!selectedProject) return;
    const name = window.prompt(
      "项目候选版本名称：",
      `项目版本：${version.name}`,
    )?.trim();
    if (!name) return;
    setIsMutating(true);
    try {
      await client.createProjectVersion(selectedProject.id, {
        sourceVersionId: version.id,
        name,
      });
      await loadPlatformHome();
      setDetailTab("versions");
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsMutating(false);
    }
  }

  async function handlePublishProjectVersion(version: ProjectVersion) {
    if (!window.confirm(`确认发布项目版本“${version.name}”？`)) return;
    setIsMutating(true);
    try {
      await client.publishProjectVersion(version.id);
      await loadPlatformHome();
    } catch (error) {
      setErrorMessage(getPlatformErrorMessage(error));
    } finally {
      setIsMutating(false);
    }
  }

  function openServerWorkspace(workspace: AnnotationWorkspace<ProjectData>) {
    setEditorSession(createEditorSession(
      workspace,
      client,
      handleWorkspaceSaved,
    ));
    setLocalEditorSession(null);
    setSelectedProjectId(workspace.projectId);
    setSelectedWorkspaceId(workspace.id);
    setView("editor");
  }

  function handleWorkspaceSaved(
    workspace: AnnotationWorkspace<ProjectData>,
  ) {
    setEditorSession(createEditorSession(
      workspace,
      client,
      handleWorkspaceSaved,
    ));
    setWorkspacesByProjectId((current) => ({
      ...current,
      [workspace.projectId]: (current[workspace.projectId] ?? []).map((item) =>
        item.id === workspace.id
          ? workspace
          : item
      ),
    }));
  }

  function handleLogout() {
    window.localStorage.removeItem(PLATFORM_TOKEN_STORAGE_KEY);
    setAccessToken(null);
    setUser(null);
    setProjects([]);
    setMediaAssets([]);
    setWorkspacesByProjectId({});
    setAnnotationVersionsByProjectId({});
    setProjectVersionsByProjectId({});
    setSelectedProjectId(null);
    setSelectedWorkspaceId(null);
    setEditorSession(null);
    setLocalEditorSession(null);
    setHomeSection("projects");
    setView("login");
  }

  function openLocalDemoProject() {
    setEditorSession(null);
    setLocalEditorSession(
      createLocalEditorSession(mockProject, "本地示例项目", "demo"),
    );
    setView("editor");
  }

  async function handleOpenLocalProjectJson(file: File) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const imported = await readProjectJsonFile(file);
      setEditorSession(null);
      setLocalEditorSession(createLocalEditorSession(
        imported,
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

  function handleLocalProjectFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (file) void handleOpenLocalProjectJson(file);
    event.target.value = "";
  }

  function handlePlatformError(error: unknown) {
    setErrorMessage(getPlatformErrorMessage(error));
    if (error instanceof PlatformApiError && error.status === 401) {
      window.localStorage.removeItem(PLATFORM_TOKEN_STORAGE_KEY);
      setAccessToken(null);
      setUser(null);
      setView("login");
    }
  }

  if (view === "editor") {
    const isServerWorkspace = Boolean(editorSession);
    const platformNavigation: TopMenuPlatformNavigation = {
      label: isServerWorkspace || accessToken ? "← 平台" : "← 入口",
      title: isServerWorkspace || accessToken
        ? "返回平台主页"
        : "返回登录与本地入口",
      onBack: () => setView(isServerWorkspace || accessToken ? "home" : "login"),
    };
    return (
      <div className="platform-editor-host">
        <div className="platform-editor-body">
          {renderEditor(
            editorSession,
            localEditorSession,
            platformNavigation,
          )}
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
            <p>统一管理媒体、标注工作区、成员成果和可追溯项目版本。</p>
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
            {errorMessage
              ? <p className="platform-error" role="alert">{errorMessage}</p>
              : null}
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
                <button
                  type="button"
                  className="platform-secondary-button"
                  onClick={openLocalDemoProject}
                >
                  新建本地示例项目
                </button>
                <label className="platform-file-button">
                  打开本地项目 JSON
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={handleLocalProjectFileChange}
                  />
                </label>
              </div>
            </div>
            <p className="platform-login-hint">
              开发账号：admin/admin123、ta/ta123、student/student123
            </p>
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
            <span>工作区与版本平台</span>
          </div>
        </div>
        <div className="platform-user-box">
          <span>
            {user
              ? `${user.displayName} · ${user.roles.join("/")}`
              : "未连接账号"}
          </span>
          <button type="button" onClick={openLocalDemoProject}>本地工具</button>
          <label className="platform-topbar-file-button">
            打开本地 JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleLocalProjectFileChange}
            />
          </label>
          <button
            type="button"
            onClick={() => void loadPlatformHome()}
            disabled={isLoading}
          >
            刷新
          </button>
          <button type="button" onClick={handleLogout}>退出</button>
        </div>
      </header>

      <section className="platform-dashboard">
        <aside className="platform-sidebar">
          <h2>平台导航</h2>
          <button
            type="button"
            className={homeSection === "projects" ? "active" : ""}
            onClick={() => setHomeSection("projects")}
          >
            项目库
          </button>
          <button
            type="button"
            className={homeSection === "permissions" ? "active" : ""}
            onClick={() => setHomeSection("permissions")}
            disabled={!canManageAnyProject}
            title={canManageAnyProject
              ? "管理项目成员及其授权范围"
              : "当前账号没有可管理的项目"}
          >
            项目权限管理
          </button>
          <button type="button" disabled>后端任务</button>
          <div className="platform-sidebar-note">
            工作区用于持续编辑；完成版本和项目版本均不可变、可追溯。
          </div>
        </aside>

        <section className={`platform-main-panel ${
          homeSection === "permissions"
            ? "platform-main-panel-permissions"
            : ""
        }`}>
          {errorMessage
            ? <p className="platform-error" role="alert">{errorMessage}</p>
            : null}
          {homeSection === "permissions"
            ? (
                <ProjectPermissionWorkspace
                  client={client}
                  projects={projects}
                  selectedProjectId={selectedProjectId}
                  onSelectProject={setSelectedProjectId}
                  onOpenWorkspace={(workspaceId) =>
                    void handleOpenWorkspace(workspaceId)}
                  onProjectsChanged={() => loadPlatformHome()}
                  onError={setErrorMessage}
                />
              )
            : (
                <ProjectLibrary
                  projects={projects}
                  selectedProject={selectedProject}
                  selectedWorkspaces={selectedWorkspaces}
                  selectedWorkspace={selectedWorkspace}
                  annotationVersions={selectedAnnotationVersions}
                  projectVersions={selectedProjectVersions}
                  detailTab={detailTab}
                  isLoading={isLoading}
                  isMutating={isMutating}
                  uploadFile={uploadFile}
                  newProjectTitle={newProjectTitle}
                  newWorkspaceName={newWorkspaceName}
                  jsonImportFile={jsonImportFile}
                  jsonImportName={jsonImportName}
                  mediaAssetCount={mediaAssets.length}
                  onSelectProject={(projectId) => {
                    setSelectedProjectId(projectId);
                    setSelectedWorkspaceId(
                      workspacesByProjectId[projectId]?.[0]?.id ?? null,
                    );
                  }}
                  onSelectWorkspace={setSelectedWorkspaceId}
                  onDetailTab={setDetailTab}
                  onUploadFile={(file) => {
                    setUploadFile(file);
                    if (file && !newProjectTitle.trim()) {
                      setNewProjectTitle(stripFileExtension(file.name));
                    }
                  }}
                  onNewProjectTitle={setNewProjectTitle}
                  onNewWorkspaceName={setNewWorkspaceName}
                  onJsonFile={(file) => {
                    setJsonImportFile(file);
                    if (file && !jsonImportName.trim()) {
                      setJsonImportName(stripFileExtension(file.name));
                    }
                  }}
                  onJsonImportName={setJsonImportName}
                  onCreateProject={handleCreateProject}
                  onImportJson={handleImportJson}
                  onOpenWorkspace={(workspaceId) =>
                    void handleOpenWorkspace(workspaceId)}
                  onForkVersion={(version) => void handleForkVersion(version)}
                  onCreateProjectVersion={(version) =>
                    void handleCreateProjectVersion(version)}
                  onPublishProjectVersion={(version) =>
                    void handlePublishProjectVersion(version)}
                />
              )}
        </section>
      </section>
    </main>
  );
}

type ProjectLibraryProps = {
  projects: AnnotationProjectSummary[];
  selectedProject: AnnotationProjectSummary | null;
  selectedWorkspaces: AnnotationWorkspaceSummary[];
  selectedWorkspace: AnnotationWorkspaceSummary | null;
  annotationVersions: AnnotationVersionSummary[];
  projectVersions: ProjectVersion[];
  detailTab: ProjectDetailTab;
  isLoading: boolean;
  isMutating: boolean;
  uploadFile: File | null;
  newProjectTitle: string;
  newWorkspaceName: string;
  jsonImportFile: File | null;
  jsonImportName: string;
  mediaAssetCount: number;
  onSelectProject: (projectId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onDetailTab: (tab: ProjectDetailTab) => void;
  onUploadFile: (file: File | null) => void;
  onNewProjectTitle: (value: string) => void;
  onNewWorkspaceName: (value: string) => void;
  onJsonFile: (file: File | null) => void;
  onJsonImportName: (value: string) => void;
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
  onImportJson: (event: FormEvent<HTMLFormElement>) => void;
  onOpenWorkspace: (workspaceId?: string) => void;
  onForkVersion: (version: AnnotationVersionSummary) => void;
  onCreateProjectVersion: (version: AnnotationVersionSummary) => void;
  onPublishProjectVersion: (version: ProjectVersion) => void;
};

function ProjectLibrary(props: ProjectLibraryProps) {
  const canCreateProjectVersion =
    props.selectedProject?.currentUserCapabilities.includes(
      "create_project_version",
    ) ?? false;
  const canPublish =
    props.selectedProject?.currentUserCapabilities.includes(
      "publish_project_version",
    ) ?? false;
  return (
    <>
      <div className="platform-section-header">
        <div>
          <span className="platform-kicker">Project Library</span>
          <h1>项目、工作区与版本</h1>
        </div>
        <button
          type="button"
          onClick={() => props.onOpenWorkspace(props.selectedWorkspace?.id)}
          disabled={!props.selectedWorkspace || props.isLoading}
        >
          打开工作区
        </button>
      </div>

      <form className="platform-create-panel" onSubmit={props.onCreateProject}>
        <div>
          <span className="platform-kicker">Upload</span>
          <h2>上传媒体并创建项目</h2>
        </div>
        <label>
          媒体文件
          <input
            type="file"
            accept="video/*,audio/*"
            onChange={(event) =>
              props.onUploadFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          项目标题
          <input
            value={props.newProjectTitle}
            onChange={(event) =>
              props.onNewProjectTitle(event.target.value)}
            placeholder={props.uploadFile
              ? stripFileExtension(props.uploadFile.name)
              : "例如：顾卫英《寻梦》"}
          />
        </label>
        <label>
          主工作区
          <input
            value={props.newWorkspaceName}
            onChange={(event) =>
              props.onNewWorkspaceName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={props.isMutating}>
          {props.isMutating ? "正在创建..." : "上传并创建"}
        </button>
      </form>

      <form
        className="platform-create-panel platform-json-import-panel"
        onSubmit={props.onImportJson}
      >
        <div>
          <span className="platform-kicker">Import JSON</span>
          <h2>导入为个人工作区</h2>
        </div>
        <label>
          项目 JSON
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) =>
              props.onJsonFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          工作区名称
          <input
            value={props.jsonImportName}
            onChange={(event) =>
              props.onJsonImportName(event.target.value)}
            placeholder={props.jsonImportFile
              ? stripFileExtension(props.jsonImportFile.name)
              : "导入后的工作区名称"}
          />
        </label>
        <button
          type="submit"
          disabled={!props.selectedProject || props.isMutating}
        >
          导入到当前项目
        </button>
      </form>

      <div className="platform-grid">
        <div className="platform-list-panel">
          <h2>项目</h2>
          {props.projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={
                project.id === props.selectedProject?.id ? "selected" : ""
              }
              onClick={() => props.onSelectProject(project.id)}
            >
              <strong>{project.title}</strong>
              <span>
                {project.workspaceCount} 个工作区 ·{" "}
                {project.annotationVersionCount} 个完成版本
              </span>
            </button>
          ))}
          {!props.projects.length && !props.isLoading
            ? <p className="platform-muted">暂无项目。</p>
            : null}
        </div>

        <div className="platform-detail-panel">
          <div className="platform-detail-title">
            <h2>{props.selectedProject?.title ?? "未选择项目"}</h2>
            <span>
              {props.selectedProject?.updatedAt
                ? `更新于 ${formatDateTime(props.selectedProject.updatedAt)}`
                : "等待加载"}
            </span>
          </div>
          <div className="platform-segmented-tabs">
            <button
              type="button"
              className={props.detailTab === "workspaces" ? "active" : ""}
              onClick={() => props.onDetailTab("workspaces")}
            >
              工作区
            </button>
            <button
              type="button"
              className={props.detailTab === "annotations" ? "active" : ""}
              onClick={() => props.onDetailTab("annotations")}
            >
              成员标注
            </button>
            <button
              type="button"
              className={props.detailTab === "versions" ? "active" : ""}
              onClick={() => props.onDetailTab("versions")}
            >
              项目版本
            </button>
          </div>

          {props.detailTab === "workspaces"
            ? (
                <div className="platform-version-list">
                  {props.selectedWorkspaces.map((workspace) => (
                    <article
                      key={workspace.id}
                      className={`platform-version-item ${
                        workspace.id === props.selectedWorkspace?.id
                          ? "selected"
                          : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="platform-item-main-button"
                        onClick={() => props.onSelectWorkspace(workspace.id)}
                      >
                        <strong>{workspace.name}</strong>
                        <span>
                          {workspace.owner.displayName} · revision{" "}
                          {workspace.latestRevision} · {workspace.status}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          props.onSelectWorkspace(workspace.id);
                          props.onOpenWorkspace(workspace.id);
                        }}
                      >
                        打开
                      </button>
                    </article>
                  ))}
                  {!props.selectedWorkspaces.length
                    ? <p className="platform-muted">该项目暂无工作区。</p>
                    : null}
                </div>
              )
            : null}

          {props.detailTab === "annotations"
            ? (
                <div className="platform-version-list">
                  {props.annotationVersions.map((version) => (
                    <article key={version.id} className="platform-version-item">
                      <div>
                        <strong>{version.name}</strong>
                        <span>
                          {version.creator.displayName} · revision{" "}
                          {version.revision} ·{" "}
                          {formatDateTime(version.completedAt)}
                        </span>
                        {version.parentVersionId
                          ? <p>来源版本：{version.parentVersionId}</p>
                          : null}
                      </div>
                      <div className="platform-inline-actions">
                        <button
                          type="button"
                          onClick={() => props.onForkVersion(version)}
                        >
                          Fork
                        </button>
                        <button
                          type="button"
                          disabled={!canCreateProjectVersion}
                          onClick={() =>
                            props.onCreateProjectVersion(version)}
                        >
                          建立候选
                        </button>
                      </div>
                    </article>
                  ))}
                  {!props.annotationVersions.length
                    ? <p className="platform-muted">暂无完成的标注版本。</p>
                    : null}
                </div>
              )
            : null}

          {props.detailTab === "versions"
            ? (
                <div className="platform-version-list">
                  {props.projectVersions.map((version) => (
                    <article key={version.id} className="platform-version-item">
                      <div>
                        <strong>
                          v{version.sequence} · {version.name}
                        </strong>
                        <span>
                          {version.status} · 来源：
                          {version.sourceVersion.name}（
                          {version.sourceVersion.creator.displayName}）
                        </span>
                        {version.publishedAt
                          ? <p>发布于 {formatDateTime(version.publishedAt)}</p>
                          : null}
                      </div>
                      {version.status === "candidate"
                        ? (
                            <button
                              type="button"
                              disabled={!canPublish}
                              onClick={() =>
                                props.onPublishProjectVersion(version)}
                            >
                              发布
                            </button>
                          )
                        : null}
                    </article>
                  ))}
                  {!props.projectVersions.length
                    ? <p className="platform-muted">暂无项目版本。</p>
                    : null}
                </div>
              )
            : null}

          <div className="platform-metadata-strip">
            <span>媒体资产：{props.mediaAssetCount}</span>
            <span>
              当前发布版本：
              {props.selectedProject?.currentProjectVersionId ?? "尚未发布"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function createEditorSession(
  workspace: AnnotationWorkspace<ProjectData>,
  client: PlatformClient,
  onWorkspaceSaved: (
    workspace: AnnotationWorkspace<ProjectData>,
  ) => void,
): PlatformEditorSession {
  return {
    client,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projectTitle: workspace.project.title,
    baseRevision: workspace.latestSnapshot.revision,
    initialProject: hydrateProjectForClient(
      workspace.latestSnapshot.payload,
      workspace.mediaAsset,
      client,
    ),
    onWorkspaceSaved,
    effectivePermission: workspace.permission,
  };
}

function createEmptyProjectForFile(
  fileId: string,
  fileName: string,
  client: PlatformClient,
): ProjectData {
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

function hydrateProjectForClient(
  payload: unknown,
  mediaAsset: MediaAsset,
  client: PlatformClient,
): ProjectData {
  const project = isProjectFileLike(payload)
    ? normalizeImportedProjectFile(payload).project
    : mockProject;
  const platformFileId =
    getPlatformFileId(project.video.filePath) ?? mediaAsset.primaryFileId;
  if (!platformFileId) return project;
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
          // 快照不保存带会话 token 的 URL，重新打开时由 PlatformClient 注入。
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
  const parsed = JSON.parse(await file.text()) as unknown;
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
  if (error instanceof PlatformApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "平台请求失败，请确认后端 API 是否已启动。";
}
