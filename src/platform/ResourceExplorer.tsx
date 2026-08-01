import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Archive,
  ChevronRight,
  Clock3,
  Copy,
  FileJson2,
  FileVideo2,
  Folder,
  FolderInput,
  FolderOpen,
  Grid2X2,
  HardDrive,
  Heart,
  List,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, MouseEvent } from "react";
import {
  RESOURCE_CAPABILITIES,
  type PlatformUser,
  type ResourceCapability,
  type ResourceEntry,
  type ResourceListPage,
  type ResourceListView,
  type ResourcePermissionMatrixRow,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import {
  isProjectFileLike,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import { prepareProjectForServer } from "./PlatformWorkspace";
import { ResourceDestinationPicker } from "./ResourceDestinationPicker";

type ExplorerMode = "list" | "grid" | "column";

const VIEW_LABELS: Record<ResourceListView, string> = {
  children: "资源",
  all_projects: "所有项目",
  recent: "最近打开",
  favorites: "我的收藏",
  shared: "与我共享",
  archived: "已归档",
  trash: "回收站",
};
const CAPABILITY_LABELS: Record<ResourceCapability, string> = {
  read: "查看",
  write: "编辑",
  create_child: "新建子项",
  copy: "复制",
  move: "移动",
  delete: "删除",
  download: "下载",
  manage_permissions: "管理权限",
};

export function ResourceExplorer(props: {
  client: PlatformClient;
  user: PlatformUser | null;
  onLogout: () => void;
  onOpenLocalJson: (project: ProjectData, title: string) => void;
  onOpenAnnotationFile: (resource: ResourceEntry) => void;
}) {
  const [rootView, setRootView] = useState<ResourceListView>("all_projects");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [page, setPage] = useState<ResourceListPage>({
    items: [],
    breadcrumbs: [],
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExplorerMode>("list");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] =
    useState<"name" | "createdAt" | "updatedAt" | "size">("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [clipboard, setClipboard] = useState<ResourceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movingResource, setMovingResource] = useState<ResourceEntry | null>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const selected =
    page.items.find((item) => item.id === selectedIds[0]) ?? null;
  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await props.client.listResources({
        parentId: folderId,
        view: folderId ? "children" : rootView,
        query: search || undefined,
        sortBy,
        direction,
        limit: 200,
      });
      setPage(result);
      setSelectedIds((current) =>
        current.filter((id) => result.items.some((item) => item.id === id)));
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setIsLoading(false);
    }
  }, [direction, folderId, props.client, rootView, search, sortBy]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, search]);

  const openResource = useCallback((resource: ResourceEntry) => {
    if (resource.type === "folder" || resource.type === "project") {
      setFolderId(resource.id);
      setSelectedIds([]);
    } else if (resource.type === "annotation_file") {
      props.onOpenAnnotationFile(resource);
    }
  }, [props.onOpenAnnotationFile]);

  const copySelection = useCallback(() => {
    setClipboard(page.items.filter((item) => selectedIds.includes(item.id)));
  }, [page.items, selectedIds]);

  const pasteClipboard = useCallback(async () => {
    if (!folderId || !clipboard.length) return;
    setIsLoading(true);
    try {
      for (const item of clipboard) {
        await props.client.copyResource(item.id, { parentId: folderId });
      }
      await refresh();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setIsLoading(false);
    }
  }, [clipboard, folderId, props.client, refresh]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Radix 对话框负责其内部键盘交互，打开时不能让资源列表的全局快捷键同时执行。
      if (movingResource) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(page.items.map((item) => item.id));
      } else if (command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
      } else if (command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
      } else if (command && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".resource-search-input")?.focus();
      } else if (event.key === "Enter" && selected) {
        openResource(selected);
      } else if (event.key === "Escape") {
        setSelectedIds([]);
      } else if (event.key === "F2" && selected) {
        event.preventDefault();
        void renameResource(props.client, selected, refresh, setError);
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedIds.length &&
        window.confirm("将所选资源移到回收站？")
      ) {
        event.preventDefault();
        void Promise.all(
          selectedIds.map((id) => props.client.trashResource(id)),
        ).then(refresh).catch((nextError) => setError(describeError(nextError)));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    copySelection,
    openResource,
    page.items,
    pasteClipboard,
    props.client,
    refresh,
    movingResource,
    selected,
    selectedIds,
  ]);

  function chooseView(view: ResourceListView) {
    setFolderId(null);
    setRootView(view);
    setSelectedIds([]);
  }

  function selectResource(event: MouseEvent, resource: ResourceEntry) {
    const command = event.metaKey || event.ctrlKey;
    if (event.shiftKey && anchorId) {
      const start = page.items.findIndex((item) => item.id === anchorId);
      const end = page.items.findIndex((item) => item.id === resource.id);
      if (start >= 0 && end >= 0) {
        const range = page.items
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((item) => item.id);
        setSelectedIds(command
          ? [...new Set([...selectedIds, ...range])]
          : range);
      }
      return;
    }
    setAnchorId(resource.id);
    setSelectedIds((current) => command
      ? current.includes(resource.id)
        ? current.filter((id) => id !== resource.id)
        : [...current, resource.id]
      : [resource.id]);
  }

  async function createContainer(type: "folder" | "project") {
    const name = window.prompt(type === "project" ? "项目名称：" : "文件夹名称：");
    if (!name) return;
    try {
      await props.client.createResource({
        parentId: folderId,
        type,
        name,
      });
      await refresh();
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isProjectFileLike(parsed)) {
        throw new Error("所选 JSON 不是有效的标注项目文件。");
      }
      if (!folderId) throw new Error("请先进入项目或文件夹。");
      const project = normalizeImportedProjectFile(parsed).project;
      await props.client.createAnnotationFile({
        parentId: folderId,
        name: file.name,
        payload: prepareProjectForServer(project),
      });
      await refresh();
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }

  async function uploadMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!folderId) {
      setError("请先进入项目或文件夹。");
      return;
    }
    setIsLoading(true);
    try {
      const uploaded = await props.client.uploadFile(file);
      await props.client.importMediaFile({
        parentId: folderId,
        fileId: uploaded.file.id,
        name: file.name,
      });
      await refresh();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="resource-explorer-shell">
      <header className="resource-explorer-topbar">
        <div className="resource-explorer-brand">
          <HardDrive size={20} />
          <div>
            <strong>戏曲多模态资源工作区</strong>
            <span>科研数据与标注文件</span>
          </div>
        </div>
        <div className="resource-search">
          <Search size={16} />
          <input
            className="resource-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目与文件"
          />
        </div>
        <div className="resource-account">
          <span>{props.user?.displayName ?? "正在验证账号"}</span>
          <button type="button" title="刷新" onClick={() => void refresh()}>
            <RefreshCw size={17} />
          </button>
          <button type="button" title="退出" onClick={props.onLogout}>
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <section className="resource-explorer-body">
        <aside className="resource-sidebar">
          <nav>
            <NavItem icon={<FolderOpen size={17} />} label="所有项目" active={!folderId && rootView === "all_projects"} onClick={() => chooseView("all_projects")} />
            <NavItem icon={<Clock3 size={17} />} label="最近打开" active={!folderId && rootView === "recent"} onClick={() => chooseView("recent")} />
            <NavItem icon={<Heart size={17} />} label="我的收藏" active={!folderId && rootView === "favorites"} onClick={() => chooseView("favorites")} />
            <NavItem icon={<ShieldCheck size={17} />} label="与我共享" active={!folderId && rootView === "shared"} onClick={() => chooseView("shared")} />
            <NavItem icon={<Archive size={17} />} label="已归档" active={!folderId && rootView === "archived"} onClick={() => chooseView("archived")} />
            <NavItem icon={<Trash2 size={17} />} label="回收站" active={!folderId && rootView === "trash"} onClick={() => chooseView("trash")} />
          </nav>
          <div className="resource-sidebar-footer">
            <button
              type="button"
              onClick={() => props.onOpenLocalJson(mockProject, "本地示例项目")}
            >
              <HardDrive size={16} /> 本地标注工具
            </button>
          </div>
        </aside>

        <section className="resource-browser">
          <div className="resource-browser-toolbar">
            <div className="resource-breadcrumbs">
              <button type="button" onClick={() => chooseView(rootView)}>
                {VIEW_LABELS[rootView]}
              </button>
              {page.breadcrumbs.map((item) => (
                <span key={item.id}>
                  <ChevronRight size={14} />
                  <button type="button" onClick={() => setFolderId(item.id)}>
                    {item.name}
                  </button>
                </span>
              ))}
            </div>
            <div className="resource-toolbar-actions">
              <button type="button" onClick={() => void createContainer("project")}>
                <Plus size={16} /> 项目
              </button>
              <button type="button" disabled={!folderId} onClick={() => void createContainer("folder")} title="新建文件夹">
                <Folder size={16} />
              </button>
              <button type="button" disabled={!folderId} onClick={() => jsonInputRef.current?.click()} title="导入标注 JSON">
                <FileJson2 size={16} />
              </button>
              <button type="button" disabled={!folderId} onClick={() => mediaInputRef.current?.click()} title="上传媒体">
                <Upload size={16} />
              </button>
              <span className="resource-toolbar-divider" />
              <button type="button" className={mode === "list" ? "active" : ""} onClick={() => setMode("list")} title="列表"><List size={16} /></button>
              <button type="button" className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")} title="网格"><Grid2X2 size={16} /></button>
              <button type="button" className={mode === "column" ? "active" : ""} onClick={() => setMode("column")} title="分栏"><MoreHorizontal size={16} /></button>
            </div>
          </div>
          {error ? <div className="resource-error-banner">{error}</div> : null}
          <ResourceCollection
            items={page.items}
            selectedIds={selectedIds}
            mode={mode}
            isLoading={isLoading}
            sortBy={sortBy}
            direction={direction}
            onSort={(field) => {
              if (sortBy === field) {
                setDirection((current) => current === "asc" ? "desc" : "asc");
              } else {
                setSortBy(field);
                setDirection("asc");
              }
            }}
            onSelect={selectResource}
            onOpen={openResource}
            onRename={(resource) =>
              void renameResource(props.client, resource, refresh, setError)}
            onCopy={(resource) => setClipboard([resource])}
            onMove={setMovingResource}
            onTrash={(resource) =>
              void props.client.trashResource(resource.id)
                .then(refresh)
                .catch((nextError) => setError(describeError(nextError)))}
          />
        </section>

        <ResourceInspector
          client={props.client}
          resource={selected}
          onChanged={() => void refresh()}
          onError={setError}
        />
      </section>
      <input ref={jsonInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importJson(event)} />
      <input ref={mediaInputRef} hidden type="file" accept="video/*,audio/*" onChange={(event) => void uploadMedia(event)} />
      {movingResource && props.user ? (
        <ResourceDestinationPicker
          client={props.client}
          resource={movingResource}
          user={props.user}
          onCancel={() => setMovingResource(null)}
          onMove={async (parentId) => {
            await props.client.moveResource(movingResource.id, { parentId });
            // 成功后以服务端目录重新归一化选择，避免 Inspector 持有已移出列表的旧对象。
            setSelectedIds((current) =>
              current.filter((id) => id !== movingResource.id));
            setAnchorId(null);
            setMovingResource(null);
            await refresh();
          }}
        />
      ) : null}
    </main>
  );
}

function NavItem(props: {
  icon: JSX.Element;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={props.active ? "active" : ""} onClick={props.onClick}>
      {props.icon}<span>{props.label}</span>
    </button>
  );
}

type CollectionProps = {
  items: ResourceEntry[];
  selectedIds: string[];
  mode: ExplorerMode;
  isLoading: boolean;
  sortBy: string;
  direction: "asc" | "desc";
  onSort: (field: "name" | "createdAt" | "updatedAt" | "size") => void;
  onSelect: (event: MouseEvent, resource: ResourceEntry) => void;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
};

function ResourceCollection(props: CollectionProps) {
  if (props.isLoading && !props.items.length) {
    return <div className="resource-empty">正在读取资源...</div>;
  }
  if (!props.items.length) {
    return <div className="resource-empty">这个位置还没有可见资源。</div>;
  }
  if (props.mode === "grid") {
    return (
      <div className="resource-grid">
        {props.items.map((resource) => (
          <ResourceMenu key={resource.id} resource={resource} {...props}>
            <button
              type="button"
              className={`resource-grid-item ${props.selectedIds.includes(resource.id) ? "selected" : ""}`}
              onClick={(event) => props.onSelect(event, resource)}
              onDoubleClick={() => props.onOpen(resource)}
            >
              <ResourceIcon resource={resource} size={34} />
              <strong>{resource.name}</strong>
              <span>{resource.owner.displayName}</span>
            </button>
          </ResourceMenu>
        ))}
      </div>
    );
  }
  return (
    <div className={`resource-list ${props.mode === "column" ? "column-mode" : ""}`}>
      <div className="resource-list-header">
        <SortButton label="名称" field="name" {...props} />
        <span>类型</span>
        <SortButton label="修改时间" field="updatedAt" {...props} />
        <span>负责人</span>
        <SortButton label="大小" field="size" {...props} />
      </div>
      {props.items.map((resource) => (
        <ResourceMenu key={resource.id} resource={resource} {...props}>
          <button
            type="button"
            className={`resource-list-row ${props.selectedIds.includes(resource.id) ? "selected" : ""}`}
            onClick={(event) => props.onSelect(event, resource)}
            onDoubleClick={() => props.onOpen(resource)}
          >
            <span className="resource-name-cell"><ResourceIcon resource={resource} size={18} /><strong>{resource.name}</strong></span>
            <span>{typeLabel(resource.type)}</span>
            <span>{formatDate(resource.updatedAt)}</span>
            <span>{resource.owner.displayName}</span>
            <span>{formatSize(resource.size)}</span>
          </button>
        </ResourceMenu>
      ))}
    </div>
  );
}

function ResourceMenu(props: CollectionProps & {
  resource: ResourceEntry;
  children: JSX.Element;
}) {
  const capabilities = props.resource.permission.capabilities;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="resource-context-menu">
          <ContextMenu.Item onSelect={() => props.onOpen(props.resource)}><FolderOpen size={15} /> 打开</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={!capabilities.includes("copy")} onSelect={() => props.onCopy(props.resource)}><Copy size={15} /> 复制</ContextMenu.Item>
          <ContextMenu.Item disabled={!capabilities.includes("move")} onSelect={() => props.onMove(props.resource)}><FolderInput size={15} /> 移动到…</ContextMenu.Item>
          <ContextMenu.Item disabled={!capabilities.includes("write")} onSelect={() => props.onRename(props.resource)}><Settings2 size={15} /> 重命名</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item className="danger" disabled={!capabilities.includes("delete")} onSelect={() => props.onTrash(props.resource)}><Trash2 size={15} /> 移到回收站</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function SortButton(props: {
  label: string;
  field: "name" | "createdAt" | "updatedAt" | "size";
  sortBy: string;
  direction: "asc" | "desc";
  onSort: (field: "name" | "createdAt" | "updatedAt" | "size") => void;
}) {
  return (
    <button type="button" onClick={() => props.onSort(props.field)}>
      {props.label}{props.sortBy === props.field ? (props.direction === "asc" ? " ↑" : " ↓") : ""}
    </button>
  );
}

function ResourceInspector(props: {
  client: PlatformClient;
  resource: ResourceEntry | null;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [matrix, setMatrix] = useState<ResourcePermissionMatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const canManage = props.resource?.permission.canManagePermissions ?? false;

  const load = useCallback(async () => {
    if (!props.resource || !canManage) {
      setMatrix([]);
      return;
    }
    setLoading(true);
    try {
      setMatrix(await props.client.listResourcePermissions(props.resource.id));
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [canManage, props.client, props.onError, props.resource]);

  useEffect(() => void load(), [load]);

  if (!props.resource) {
    return (
      <aside className="resource-inspector empty">
        <Settings2 size={24} /><strong>检查器</strong>
        <p>选择项目或文件，查看详情与账号权限。</p>
      </aside>
    );
  }
  return (
    <aside className="resource-inspector">
      <div className="resource-inspector-preview"><ResourceIcon resource={props.resource} size={38} /></div>
      <h2>{props.resource.name}</h2>
      <dl>
        <dt>类型</dt><dd>{typeLabel(props.resource.type)}</dd>
        <dt>所有者</dt><dd>{props.resource.owner.displayName}</dd>
        <dt>创建</dt><dd>{formatDate(props.resource.createdAt)}</dd>
        <dt>修改</dt><dd>{formatDate(props.resource.updatedAt)}</dd>
        {props.resource.revision ? <><dt>修订</dt><dd>{props.resource.revision}</dd></> : null}
      </dl>
      <button
        type="button"
        className="resource-favorite-button"
        onClick={() => void props.client.updateResource(props.resource!.id, {
          favorite: !props.resource!.favorite,
        }).then(props.onChanged).catch((error) => props.onError(describeError(error)))}
      >
        <Heart size={16} fill={props.resource.favorite ? "currentColor" : "none"} />
        {props.resource.favorite ? "已收藏" : "添加收藏"}
      </button>
      <div className="resource-inspector-section-heading">
        <div><strong>账号权限</strong><span>当前选中资源的逐账号授权</span></div>
        {canManage ? <button type="button" onClick={() => void load()} title="刷新权限"><RefreshCw size={15} /></button> : null}
      </div>
      {!canManage ? (
        <div className="resource-permission-readonly">
          你拥有：{props.resource.permission.capabilities.map((item) => CAPABILITY_LABELS[item]).join("、") || "无权限"}
        </div>
      ) : null}
      {loading ? <div className="resource-permission-readonly">正在读取账号权限...</div> : null}
      {canManage ? (
        <>
          <label className="resource-inheritance-toggle">
            <input
              type="checkbox"
              checked={!props.resource.breakPermissionInheritance}
              onChange={(event) => void props.client.updateResourceInheritance(
                props.resource!.id,
                { breakPermissionInheritance: !event.target.checked },
              ).then(() => {
                props.onChanged();
                void load();
              }).catch((error) => props.onError(describeError(error)))}
            />
            继承父目录权限
          </label>
          <div className="resource-permission-list">
            {matrix.map((row) => (
              <PermissionRow
                key={row.user.id}
                client={props.client}
                resource={props.resource!}
                row={row}
                onChanged={() => {
                  props.onChanged();
                  void load();
                }}
                onError={props.onError}
              />
            ))}
          </div>
        </>
      ) : null}
    </aside>
  );
}

function PermissionRow(props: {
  client: PlatformClient;
  resource: ResourceEntry;
  row: ResourcePermissionMatrixRow;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [capabilities, setCapabilities] = useState<ResourceCapability[]>(
    props.row.directPermission?.capabilities ?? [],
  );
  const [inherit, setInherit] = useState(
    props.row.directPermission?.inheritToChildren ?? true,
  );
  const privileged =
    props.row.effectivePermission.isOwner ||
    props.row.effectivePermission.source === "admin";

  useEffect(() => {
    setCapabilities(props.row.directPermission?.capabilities ?? []);
    setInherit(props.row.directPermission?.inheritToChildren ?? true);
  }, [props.row]);

  return (
    <section className="resource-permission-row">
      <button type="button" className="resource-permission-summary" onClick={() => setExpanded((current) => !current)}>
        <span className="resource-user-avatar">{props.row.user.displayName.slice(0, 1)}</span>
        <span>
          <strong>{props.row.user.displayName}</strong>
          <small>
            {privileged
              ? props.row.effectivePermission.isOwner
                ? "所有者 · 完整权限"
                : "系统管理员 · 完整权限"
              : props.row.directPermission
                ? "当前资源直接授权"
                : props.row.effectivePermission.source === "inherited"
                  ? `继承：${props.row.effectivePermission.inheritedFrom.map((item) => item.resourceName).join("、")}`
                  : "尚未授权"}
          </small>
        </span>
        <ChevronRight size={15} className={expanded ? "expanded" : ""} />
      </button>
      {expanded && !privileged ? (
        <div className="resource-permission-editor">
          <div className="resource-capability-grid">
            {RESOURCE_CAPABILITIES.map((capability) => (
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={(event) => setCapabilities((current) =>
                    event.target.checked
                      ? [...current, capability]
                      : current.filter((item) => item !== capability))}
                />
                {CAPABILITY_LABELS[capability]}
              </label>
            ))}
          </div>
          <label className="resource-inheritance-toggle compact">
            <input type="checkbox" checked={inherit} onChange={(event) => setInherit(event.target.checked)} />
            授权传递给子文件
          </label>
          <div className="resource-permission-actions">
            {props.row.directPermission ? (
              <button
                type="button"
                className="danger"
                onClick={() => void props.client.removeResourcePermission(
                  props.resource.id,
                  props.row.user.id,
                ).then(props.onChanged).catch((error) => props.onError(describeError(error)))}
              >
                移除直接授权
              </button>
            ) : <span />}
            <button
              type="button"
              className="primary"
              onClick={() => void props.client.upsertResourcePermission(
                props.resource.id,
                props.row.user.id,
                { capabilities, inheritToChildren: inherit },
              ).then(props.onChanged).catch((error) => props.onError(describeError(error)))}
            >
              保存权限
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResourceIcon(props: { resource: ResourceEntry; size: number }) {
  if (props.resource.type === "project") return <FolderOpen size={props.size} className="project-icon" />;
  if (props.resource.type === "folder") return <Folder size={props.size} className="folder-icon" />;
  if (props.resource.type === "media_file") return <FileVideo2 size={props.size} className="media-icon" />;
  return <FileJson2 size={props.size} className="annotation-icon" />;
}

async function renameResource(
  client: PlatformClient,
  resource: ResourceEntry,
  onChanged: () => void | Promise<void>,
  onError: (message: string | null) => void,
) {
  const name = window.prompt("新的资源名称：", resource.name);
  if (!name || name === resource.name) return;
  try {
    await client.updateResource(resource.id, { name });
    await onChanged();
  } catch (error) {
    onError(describeError(error));
  }
}

function typeLabel(type: ResourceEntry["type"]) {
  return {
    folder: "文件夹",
    project: "项目",
    annotation_file: "标注文件",
    media_file: "媒体文件",
  }[type];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSize(value?: number | null) {
  if (!value) return "—";
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
