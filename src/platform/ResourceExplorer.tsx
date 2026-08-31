import {
  Archive,
  ChevronRight,
  ClipboardPaste,
  Cloud,
  Clock3,
  Download,
  FileJson2,
  FilePlus2,
  Files,
  Folder,
  FolderInput,
  FolderOpen,
  Grid2X2,
  HardDrive,
  Heart,
  KeyRound,
  List,
  ListTodo,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  ScrollText,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, MouseEvent } from "react";
import {
  canManagePlatformAccounts,
  hasFullPlatformResourceAccess,
  type AnnotationWorkflowStatus,
  type AnnotationFile,
  type PlatformUser,
  type ResourceEntry,
  type ResourceListPage,
  type ResourceListView,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { createEmptyProjectData } from "../utils/project";
import {
  isProjectFileLike,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import { prepareProjectForServer } from "./platformProjectPayload";
import { AnnotationComparisonDialog } from "./AnnotationComparisonDialog";
import { AuditLogDialog } from "./AuditLogDialog";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import type {
  AnnotationMergePreparationRequest,
  AnnotationMergePreparationResult,
} from "./annotationMergeDraft";
import { ResourceColumnBrowser } from "./ResourceColumnBrowser";
import { ResourceDestinationPicker } from "./ResourceDestinationPicker";
import {
  canDirectlyDownloadResource,
  formatResourceDate,
  ResourceIcon,
  ResourceWorkflowStatusBadge,
  resourceTypeLabel,
} from "./ResourceItem";
import { ResourceVirtualCollection } from "./ResourceVirtualCollection";
import { ResourceRecoveryHistory } from "./ResourceRecoveryHistory";
import { SystemDiagnosticsDialog } from "./SystemDiagnosticsDialog";
import { AccountManagementDialog } from "./AccountManagementDialog";
import { copyResourcesSequentially } from "./resourceClipboard";
import {
  registerResourceDropTarget,
} from "./resourceDragAndDrop";
import { restoreResourcesSequentially } from "./resourceRestore";
import { isResourceContainer } from "./resourceColumnModel";
import { useResourceColumns } from "./useResourceColumns";
import { appendResourceListPage } from "./resourcePageState";
import { getComparableAnnotationFiles } from "./resourceComparison";
import { AnnotationMediaBindingDialog } from "./AnnotationMediaBindingDialog";
import { AliyunVodMediaDialog } from "./AliyunVodMediaDialog";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { downloadFromUrl } from "./browserDownload";
import { ResourcePermissionEditor } from "./ResourcePermissionEditor";
import { ProjectPermissionManagementDialog } from "./ProjectPermissionManagementDialog";
import {
  getAnnotationWorkflowCommandState,
  resourceResponsibleOrCreatorLabel,
} from "./annotationWorkflow";
import { ProjectWorkflowGroupEditor } from "./ProjectWorkflowGroupEditor";
import {
  AnnotationWorkflowStatusDialog,
  type AnnotationWorkflowStatusPrompt,
} from "./AnnotationWorkflowStatusDialog";
import { BatchAnnotationImportDialog } from "./BatchAnnotationImportDialog";
import { MAX_BATCH_ANNOTATION_FILES } from "./annotationBatchImport";

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
export function ResourceExplorer(props: {
  client: PlatformClient;
  user: PlatformUser | null;
  initialFolderId: string | null;
  onLogout: () => void;
  onOpenLocalJson: (project: ProjectData, title: string) => void;
  onOpenAnnotationFile: (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ) => Promise<boolean>;
  onPrepareAnnotationMerge: (
    request: AnnotationMergePreparationRequest,
  ) => Promise<AnnotationMergePreparationResult>;
  taskCenter: {
    activeCount: number;
    isPartial: boolean;
    onOpen: () => void;
  };
}) {
  const [rootView, setRootView] = useState<ResourceListView>("all_projects");
  // 从编辑器返回时直接读取文件所在目录，避免组件重新挂载后退回“所有项目”根视图。
  const [folderId, setFolderId] = useState<string | null>(props.initialFolderId);
  const [page, setPage] = useState<ResourceListPage>({
    items: [],
    breadcrumbs: [],
    nextCursor: null,
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [anchorColumnIndex, setAnchorColumnIndex] = useState(0);
  const [selectionColumnIndex, setSelectionColumnIndex] = useState(0);
  const [mode, setMode] = useState<ExplorerMode>("list");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] =
    useState<"name" | "createdAt" | "updatedAt" | "size">("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [clipboard, setClipboard] = useState<ResourceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isPasting, setIsPasting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [isCreatingBlankAnnotation, setIsCreatingBlankAnnotation] = useState(false);
  const [isMovingResources, setIsMovingResources] = useState(false);
  const [draggedResourceIds, setDraggedResourceIds] = useState<string[]>([]);
  const [breadcrumbResources, setBreadcrumbResources] = useState<
    Record<string, ResourceEntry>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [accountManagementOpen, setAccountManagementOpen] = useState(false);
  const [projectPermissionManagementOpen, setProjectPermissionManagementOpen] = useState(false);
  const [permissionRefreshVersion, setPermissionRefreshVersion] = useState(0);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [vodDialogOpen, setVodDialogOpen] = useState(false);
  const [workflowStatusPrompt, setWorkflowStatusPrompt] =
    useState<AnnotationWorkflowStatusPrompt | null>(null);
  const [workflowStatusPending, setWorkflowStatusPending] = useState(false);
  const [pendingJsonImport, setPendingJsonImport] = useState<{
    parentId: string;
    fileName: string;
    project: ProjectData;
  } | null>(null);
  const [pendingBatchJsonImport, setPendingBatchJsonImport] = useState<{
    files: File[];
  } | null>(null);
  const [movingResources, setMovingResources] = useState<ResourceEntry[]>([]);
  const [comparisonFiles, setComparisonFiles] = useState<
    [ResourceEntry, ResourceEntry] | null
  >(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const restoreInFlightRef = useRef(false);
  const pasteInFlightRef = useRef(false);
  const moveInFlightRef = useRef(false);
  const trashInFlightRef = useRef(false);
  const createBlankAnnotationInFlightRef = useRef(false);
  const breadcrumbRequestIdRef = useRef(0);
  const pendingColumnSelectionRef = useRef<number | null>(null);
  const pageRequestIdRef = useRef(0);

  const columnBrowser = useResourceColumns({
    client: props.client,
    enabled: mode === "column",
    rootView,
    query: search,
    sortBy,
    direction,
  });
  const selectionItems = mode === "column"
    ? columnBrowser.columns[selectionColumnIndex]?.items ?? []
    : page.items;
  const selected = selectionItems.find((item) =>
    item.id === selectedIds[0]) ?? null;
  const selectedResources = selectionItems.filter((item) =>
    selectedIds.includes(item.id));
  const isTrashView = rootView === "trash";
  const locationParentId = mode === "column"
    ? columnBrowser.locationParentId
    : folderId;
  const isAllProjectsRoot = !locationParentId && rootView === "all_projects";
  // 账号治理与资源/运维全权是两条不同边界：管理员仍可管理资源，但只有系统管理员可管理账号。
  const hasFullResourceAccess = props.user
    ? hasFullPlatformResourceAccess(props.user.roles)
    : false;
  const canManageAccounts = props.user
    ? canManagePlatformAccounts(props.user.roles)
    : false;
  // 首次读取替换列表，下一页读取保留既有资源；request id 防止旧查询响应串入新目录。
  const loadPage = useCallback(async (cursor: string | null = null) => {
    const requestId = ++pageRequestIdRef.current;
    if (cursor) setIsLoadingMore(true);
    else setIsLoading(true);
    setError(null);
    try {
      const result = await props.client.listResources({
        parentId: folderId,
        view: folderId ? "children" : rootView,
        query: search || undefined,
        sortBy,
        direction,
        cursor: cursor ?? undefined,
        limit: 200,
      });
      if (requestId !== pageRequestIdRef.current) return;
      if (cursor) {
        setPage((current) => appendResourceListPage(current, result));
      } else {
        setPage(result);
        // 首次替换才裁剪选择；尚未加载的后续页不能被误判为资源已删除。
        setSelectedIds((current) =>
          current.filter((id) => result.items.some((item) => item.id === id)));
      }
    } catch (nextError) {
      if (requestId === pageRequestIdRef.current) setError(describeError(nextError));
    } finally {
      if (requestId === pageRequestIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, [direction, folderId, props.client, rootView, search, sortBy]);

  // 既有调用继续把 refresh 解释为重新读取第一页，mutation 后不会把旧 cursor 留在页面中。
  const refreshPage = useCallback(() => loadPage(null), [loadPage]);

  useEffect(() => {
    if (mode === "column") return;
    // 查询条件一变化就先让旧响应失效；搜索防抖期间也不能短暂写回上一关键词的结果。
    pageRequestIdRef.current += 1;
    setIsLoadingMore(false);
    const timer = window.setTimeout(() => void refreshPage(), search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [mode, refreshPage, search]);

  const refreshCurrentView = useCallback(async () => {
    if (mode === "column") {
      columnBrowser.refreshVisibleColumns();
      return;
    }
    await refreshPage();
  }, [columnBrowser.refreshVisibleColumns, mode, refreshPage]);

  useEffect(() => {
    const requestId = ++breadcrumbRequestIdRef.current;
    if (!page.breadcrumbs.length) {
      setBreadcrumbResources({});
      return;
    }
    void Promise.all(page.breadcrumbs.map((item) =>
      props.client.getResource(item.id))).then((resources) => {
      if (requestId !== breadcrumbRequestIdRef.current) return;
      setBreadcrumbResources(Object.fromEntries(resources.map((resource) =>
        [resource.id, resource])));
    }).catch(() => {
      // 面包屑权限信息只用于拖拽预判；读取失败时 fail closed，不影响普通路径导航。
      if (requestId === breadcrumbRequestIdRef.current) {
        setBreadcrumbResources({});
      }
    });
    return () => {
      if (requestId === breadcrumbRequestIdRef.current) {
        breadcrumbRequestIdRef.current += 1;
      }
    };
  }, [page.breadcrumbs, props.client]);

  const openResource = useCallback((resource: ResourceEntry) => {
    if (isResourceContainer(resource)) {
      if (mode === "column") {
        const columnIndex = columnBrowser.columns.findIndex((column) =>
          column.items.some(({ id }) => id === resource.id));
        if (columnIndex >= 0 && !isTrashView) {
          columnBrowser.openResource(columnIndex, resource);
          setFolderId(resource.id);
        }
        return;
      }
      setFolderId(resource.id);
      setSelectedIds([]);
    } else if (resource.type === "annotation_file") {
      void props.onOpenAnnotationFile(resource);
    }
  }, [
    columnBrowser.columns,
    columnBrowser.openResource,
    isTrashView,
    mode,
    props.onOpenAnnotationFile,
  ]);

  const copySelection = useCallback(() => {
    if (isTrashView) return;
    setClipboard(selectionItems.filter((item) =>
      selectedIds.includes(item.id)));
  }, [isTrashView, selectedIds, selectionItems]);

  const pasteClipboard = useCallback(async () => {
    if (
      isTrashView ||
      !locationParentId ||
      !clipboard.length ||
      pasteInFlightRef.current
    ) return;
    // 快捷键与工具栏可能在 React 状态提交前连续触发；ref 保证同一剪贴板不会并发粘贴两轮。
    pasteInFlightRef.current = true;
    setIsPasting(true);
    setError(null);
    try {
      const result = await copyResourcesSequentially(
        clipboard,
        locationParentId,
        (resourceId, parentId) =>
          props.client.copyResource(resourceId, { parentId }),
      );
      await refreshCurrentView();
      const copiedIds = result.copied.map(({ copy }) => copy.id);
      setSelectedIds(copiedIds);
      setAnchorId(copiedIds[0] ?? null);
      setSelectionColumnIndex(Math.max(0, columnBrowser.columns.length - 1));
      if (result.failed.length) {
        const details = result.failed.map(({ source, error }) =>
          `${source.name}：${describeError(error)}`).join("；");
        setError(
          `已复制 ${result.copied.length} 项，${result.failed.length} 项失败。${details}`,
        );
      }
    } finally {
      pasteInFlightRef.current = false;
      setIsPasting(false);
    }
  }, [
    clipboard,
    columnBrowser.columns.length,
    isTrashView,
    locationParentId,
    props.client,
    refreshCurrentView,
  ]);

  const restoreResources = useCallback(async (resources: ResourceEntry[]) => {
    if (!resources.length || restoreInFlightRef.current) return;
    // React 状态更新前仍可能收到第二次菜单事件；ref 用于阻止同一资源被并发恢复两次。
    restoreInFlightRef.current = true;
    setIsRestoring(true);
    setError(null);
    try {
      const result = await restoreResourcesSequentially(
        resources,
        (resourceId) => props.client.restoreResource(resourceId),
      );
      await refreshCurrentView();
      const failedIds = result.failed.map(({ resource }) => resource.id);
      setSelectedIds(failedIds);
      setAnchorId(failedIds[0] ?? null);
      if (result.failed.length) {
        const details = result.failed.map(({ resource, error }) =>
          `${resource.name}：${describeError(error)}`).join("；");
        setError(
          `已恢复 ${result.restored.length} 项，${result.failed.length} 项失败。${details}`,
        );
      }
    } finally {
      restoreInFlightRef.current = false;
      setIsRestoring(false);
    }
  }, [props.client, refreshCurrentView]);

  const trashResources = useCallback(async (resources: ResourceEntry[]) => {
    if (
      isTrashView ||
      !resources.length ||
      trashInFlightRef.current
    ) return;
    const count = resources.length;
    if (!window.confirm(
      count === 1
        ? `将“${resources[0]!.name}”移到回收站？`
        : `将选中的 ${count} 项资源移到回收站？`,
    )) return;

    // 右键、工具栏和快捷键可能在 React 状态提交前连续触发；ref 保证只提交一批。
    trashInFlightRef.current = true;
    setIsTrashing(true);
    setError(null);
    try {
      await props.client.trashResources({
        resourceIds: resources.map(({ id }) => id),
      });
      setSelectedIds([]);
      setAnchorId(null);
      setDraggedResourceIds([]);
      await refreshCurrentView();
    } catch (nextError) {
      // 失败时保留原选择，用户可以检查权限或刷新后重试。
      setError(describeError(nextError));
    } finally {
      trashInFlightRef.current = false;
      setIsTrashing(false);
    }
  }, [isTrashView, props.client, refreshCurrentView]);

  useEffect(() => {
    const pendingIndex = pendingColumnSelectionRef.current;
    if (pendingIndex === null) return;
    const column = columnBrowser.columns[pendingIndex];
    if (!column || column.loading) return;
    pendingColumnSelectionRef.current = null;
    const first = column.items[0];
    setSelectionColumnIndex(pendingIndex);
    setAnchorColumnIndex(pendingIndex);
    setAnchorId(first?.id ?? null);
    setSelectedIds(first ? [first.id] : []);
  }, [columnBrowser.columns]);

  useEffect(() => {
    if (mode !== "column" || selectionColumnIndex < columnBrowser.columns.length) {
      return;
    }
    // 移动、删除或权限变化可能让 hook 自动截断右侧路径；选择状态必须同时回到最后一个有效列。
    const lastIndex = Math.max(0, columnBrowser.columns.length - 1);
    setSelectionColumnIndex(lastIndex);
    setAnchorColumnIndex(lastIndex);
    setSelectedIds([]);
    setAnchorId(null);
  }, [columnBrowser.columns.length, mode, selectionColumnIndex]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      const isRefreshShortcut = event.key === "F5" ||
        (command && event.key.toLowerCase() === "r");
      if (isRefreshShortcut) {
        // 资源管理器刷新只重新拉取当前目录/可见列，不能整页重载并丢失登录态、选择和窗口上下文。
        event.preventDefault();
        void refreshCurrentView();
        return;
      }
      // Radix 对话框负责其内部键盘交互，打开时不能让资源列表的全局快捷键同时执行。
      if (
        movingResources.length ||
        isMovingResources ||
        isTrashing ||
        isRestoring ||
        isPasting
      ) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) return;
      if (command && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(selectionItems.map((item) => item.id));
      } else if (command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        if (!isTrashView) copySelection();
      } else if (command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
      } else if (command && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".resource-search-input")?.focus();
      } else if (
        mode === "column" &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        if (!selectionItems.length) return;
        const currentIndex = selectionItems.findIndex(({ id }) =>
          id === selectedIds[0]);
        const delta = event.key === "ArrowUp" ? -1 : 1;
        const nextIndex = Math.min(
          selectionItems.length - 1,
          Math.max(0, currentIndex < 0 ? 0 : currentIndex + delta),
        );
        const next = selectionItems[nextIndex]!;
        setSelectedIds([next.id]);
        setAnchorId(next.id);
        setAnchorColumnIndex(selectionColumnIndex);
      } else if (
        mode === "column" &&
        event.key === "ArrowRight" &&
        selected &&
        isResourceContainer(selected) &&
        !isTrashView
      ) {
        event.preventDefault();
        columnBrowser.openResource(selectionColumnIndex, selected);
        setFolderId(selected.id);
        pendingColumnSelectionRef.current = selectionColumnIndex + 1;
      } else if (
        mode === "column" &&
        event.key === "ArrowLeft" &&
        selectionColumnIndex > 0
      ) {
        event.preventDefault();
        const openedBy = columnBrowser.columns[selectionColumnIndex]
          ?.openedByResourceId;
        setSelectionColumnIndex(selectionColumnIndex - 1);
        setAnchorColumnIndex(selectionColumnIndex - 1);
        setAnchorId(openedBy ?? null);
        setSelectedIds(openedBy ? [openedBy] : []);
      } else if (event.key === "Enter" && selected && !isTrashView) {
        event.preventDefault();
        if (mode === "column" && isResourceContainer(selected)) {
          columnBrowser.openResource(selectionColumnIndex, selected);
          setFolderId(selected.id);
          pendingColumnSelectionRef.current = selectionColumnIndex + 1;
        } else {
          openResource(selected);
        }
      } else if (event.key === "Escape") {
        setSelectedIds([]);
        if (mode === "column") {
          columnBrowser.truncateAfter(selectionColumnIndex);
          setFolderId(
            columnBrowser.columns[selectionColumnIndex]?.parentId ?? null,
          );
        }
      } else if (event.key === "F2" && selected && !isTrashView) {
        event.preventDefault();
        void renameResource(
          props.client,
          selected,
          refreshCurrentView,
          setError,
        );
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedIds.length
      ) {
        event.preventDefault();
        // 永久删除尚未定义对象存储清理和恢复期限；回收站内必须明确抑制普通删除快捷键。
        if (!isTrashView) void trashResources(selectedResources);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    columnBrowser.columns,
    columnBrowser.openResource,
    columnBrowser.truncateAfter,
    copySelection,
    mode,
    openResource,
    pasteClipboard,
    props.client,
    refreshCurrentView,
    movingResources.length,
    isRestoring,
    isPasting,
    isMovingResources,
    isTrashing,
    isTrashView,
    selected,
    selectedIds,
    selectionColumnIndex,
    selectionItems,
    selectedResources,
    trashResources,
  ]);

  function chooseView(view: ResourceListView) {
    // 在同一虚拟入口内从深层路径返回根目录时 rootView 不会变化，因此必须显式清空 Finder 列路径。
    // 否则随后切回 list/grid 会把旧最右列 parentId 再写回普通视图。
    if (mode === "column") columnBrowser.resetToBreadcrumbs([]);
    setFolderId(null);
    setRootView(view);
    setSelectedIds([]);
    setAnchorId(null);
    setSelectionColumnIndex(0);
    setAnchorColumnIndex(0);
  }

  function selectResource(
    event: MouseEvent,
    resource: ResourceEntry,
    items = page.items,
    columnIndex = 0,
  ) {
    const command = event.metaKey || event.ctrlKey;
    const wasSameColumn = selectionColumnIndex === columnIndex;
    setSelectionColumnIndex(columnIndex);
    if (event.shiftKey && anchorId && anchorColumnIndex === columnIndex) {
      const start = items.findIndex((item) => item.id === anchorId);
      const end = items.findIndex((item) => item.id === resource.id);
      if (start >= 0 && end >= 0) {
        const range = items
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((item) => item.id);
        setSelectedIds(command
          ? [...new Set([...selectedIds, ...range])]
          : range);
      }
      return;
    }
    if (mode === "column" && !command && !event.shiftKey) {
      if (!isTrashView) columnBrowser.openResource(columnIndex, resource);
      setFolderId(isResourceContainer(resource)
        ? resource.id
        : columnBrowser.columns[columnIndex]?.parentId ?? null);
    }
    setAnchorId(resource.id);
    setAnchorColumnIndex(columnIndex);
    setSelectedIds((current) => command
      ? wasSameColumn && current.includes(resource.id)
        ? current.filter((id) => id !== resource.id)
        : wasSameColumn
          ? [...current, resource.id]
          : [resource.id]
      : [resource.id]);
  }

  function openMovePicker(resource: ResourceEntry) {
    if (isTrashView || moveInFlightRef.current) return;
    const resources = selectedIds.includes(resource.id)
      ? selectedResources
      : [resource];
    if (!resources.length || resources.some((item) =>
      !item.permission.capabilities.includes("move"))) return;
    if (!selectedIds.includes(resource.id)) {
      setSelectedIds([resource.id]);
      setAnchorId(resource.id);
    }
    // 对话框持有打开瞬间的选择快照，后续刷新不会改变本次移动的资源集合。
    setMovingResources(resources);
  }

  const moveResourcesTo = useCallback(async (
    resourceIds: string[],
    parentId: string | null,
  ) => {
    if (moveInFlightRef.current) return null;
    moveInFlightRef.current = true;
    setIsMovingResources(true);
    setError(null);
    try {
      const result = await props.client.moveResources({ resourceIds, parentId });
      setSelectedIds([]);
      setAnchorId(null);
      await refreshCurrentView();
      if (!result.moved.length && result.unchanged.length) {
        setError("所选资源已经位于目标目录中。");
      }
      return result;
    } finally {
      moveInFlightRef.current = false;
      setIsMovingResources(false);
      setDraggedResourceIds([]);
    }
  }, [props.client, refreshCurrentView]);

  const handleResourceDragStart = useCallback((resourceIds: string[]) => {
    setDraggedResourceIds(resourceIds);
    setSelectedIds(resourceIds);
    setAnchorId(resourceIds[0] ?? null);
  }, []);
  const handleResourceDragFinish = useCallback(() => {
    setDraggedResourceIds([]);
  }, []);
  const handleResourceDrop = useCallback((
    resourceIds: string[],
    targetId: string,
  ) => {
    void moveResourcesTo(resourceIds, targetId)
      .catch((nextError) => setError(describeError(nextError)));
  }, [moveResourcesTo]);

  async function createContainer(type: "folder" | "project") {
    const name = window.prompt(type === "project" ? "项目名称：" : "文件夹名称：");
    if (!name) return;
    try {
      await props.client.createResource({
        parentId: locationParentId,
        type,
        name,
      });
      await refreshCurrentView();
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }

  async function createBlankAnnotationProject() {
    if (!locationParentId) {
      setError("请先进入项目或文件夹，再新建空白标注工程。");
      return;
    }
    if (createBlankAnnotationInFlightRef.current) return;

    const inputName = window.prompt(
      "空白标注工程名称：",
      "未命名标注.annotation.json",
    );
    const name = inputName?.trim();
    if (!name) return;

    createBlankAnnotationInFlightRef.current = true;
    setIsCreatingBlankAnnotation(true);
    setError(null);
    try {
      // 空白工程仍走平台标注文件接口，使 revision、ACL、恢复草稿和后续自动保存从创建时就保持一致。
      const created = await props.client.createAnnotationFile<ProjectData>({
        parentId: locationParentId,
        name,
        payload: prepareProjectForServer(createEmptyProjectData()),
        mediaResourceId: null,
      });
      await refreshCurrentView();
      setSelectedIds([created.resource.id]);
      setAnchorId(created.resource.id);

      // 复用平台唯一打开路径，重新读取权威 revision 与权限后再建立编辑器会话。
      const opened = await props.onOpenAnnotationFile(created.resource);
      if (!opened) {
        setError("空白标注工程已创建，但未进入编辑器。可在当前目录中重新打开。");
      }
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      createBlankAnnotationInFlightRef.current = false;
      setIsCreatingBlankAnnotation(false);
    }
  }

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    try {
      if (files.length > MAX_BATCH_ANNOTATION_FILES) {
        throw new Error(`一次最多导入 ${MAX_BATCH_ANNOTATION_FILES} 份标注 JSON，请分批选择。`);
      }
      if (isAllProjectsRoot) {
        if (!hasFullResourceAccess) throw new Error("只有管理员可以执行批量标注导入。");
        // 根界面按编号选择目标项目/文件夹；文件对象脱离 input 后仍可用于本轮解析，关闭窗口即释放引用。
        setPendingBatchJsonImport({ files });
        return;
      }
      if (!locationParentId) throw new Error("批量导入请进入“所有项目”界面。");
      if (files.length > 1) throw new Error("多份 JSON 请回到“所有项目”界面批量导入。");
      const file = files[0]!;
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isProjectFileLike(parsed)) {
        throw new Error("所选 JSON 不是有效的标注项目文件。");
      }
      const project = normalizeImportedProjectFile(parsed).project;
      // JSON 正文解析成功后必须显式选择媒体；关系由数据库保存，不再猜测本机绝对路径。
      setPendingJsonImport({ parentId: locationParentId, fileName: file.name, project });
    } catch (nextError) {
      setError(describeError(nextError));
    }
  }

  async function uploadMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!locationParentId) {
      setError("请先进入项目或文件夹。");
      return;
    }
    setIsLoading(true);
    try {
      // accept 仅改善文件选择体验；媒体签名、容量和权限都由统一服务端上传命令复核。
      await props.client.uploadMedia(locationParentId, file, file.name);
      await refreshCurrentView();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setIsLoading(false);
    }
  }

  function changeMode(nextMode: ExplorerMode) {
    if (nextMode === mode) return;
    if (nextMode === "column") {
      // 单页目录的 breadcrumbs 包含当前容器；据此恢复完整路径，而不是切换后跳回根目录。
      columnBrowser.resetToBreadcrumbs(page.breadcrumbs);
      setSelectionColumnIndex(page.breadcrumbs.length);
      setAnchorColumnIndex(page.breadcrumbs.length);
    } else if (mode === "column") {
      setFolderId(columnBrowser.locationParentId);
      if (selectionColumnIndex !== columnBrowser.columns.length - 1) {
        setSelectedIds([]);
        setAnchorId(null);
      }
    }
    setMode(nextMode);
  }

  const columnBreadcrumbs = columnBrowser.columns.slice(1).flatMap(
    (column, index) => {
      const resource = columnBrowser.columns[index]?.items.find(({ id }) =>
        id === column.openedByResourceId);
      return resource ? [resource] : [];
    },
  );
  const displayBreadcrumbs = mode === "column"
    ? columnBreadcrumbs
    : page.breadcrumbs;
  const interactionDisabled = isTrashView ||
    isLoading ||
    isCreatingBlankAnnotation ||
    isPasting ||
    isRestoring ||
    isMovingResources ||
    workflowStatusPending ||
    isTrashing ||
    movingResources.length > 0;
  // 工具栏和三种视图的右键菜单共用同一个资格判定，并按 selectedIds 保留左右顺序。
  const comparableFiles = getComparableAnnotationFiles(
    selectedIds,
    selectionItems,
    { isTrashView, interactionDisabled },
  );
  const renameSelectedResource = (resource: ResourceEntry) =>
    void renameResource(
      props.client,
      resource,
      refreshCurrentView,
      setError,
    );
  const trashFromContext = (resource: ResourceEntry) => {
    const resources = selectedIds.includes(resource.id)
      ? selectedResources
      : [resource];
    void trashResources(resources);
  };
  const downloadResource = (resource: ResourceEntry) => {
    if (!canDirectlyDownloadResource(resource)) return;
    const fallbackName = resource.type === "annotation_file" &&
      !resource.name.toLowerCase().endsWith(".json")
      ? `${resource.name}.json`
      : resource.name;
    downloadFromUrl(props.client.getResourceDownloadUrl(resource.id), fallbackName);
  };
  const requestWorkflowStatus = (
    resource: ResourceEntry,
    target: AnnotationWorkflowStatus,
  ) => {
    const current = resource.workflowStatus ?? "unannotated";
    const commandState = getAnnotationWorkflowCommandState(
      current,
      target,
      resource.permission.capabilities,
    );
    if (commandState === "current") return;
    if (commandState === "forbidden") {
      setError(target === "reviewed"
        ? "当前账号缺少该文件的审核权限。"
        : "当前账号缺少完成此状态转换所需的编辑或审核权限。");
      return;
    }
    setWorkflowStatusPrompt({
      resourceId: resource.id,
      resourceName: resource.name,
      current,
      target,
      blocked: commandState === "blocked_order",
    });
  };

  const confirmWorkflowStatus = async () => {
    const prompt = workflowStatusPrompt;
    if (!prompt || prompt.blocked || workflowStatusPending) return;
    setWorkflowStatusPending(true);
    setError(null);
    try {
      await props.client.updateAnnotationWorkflowStatus(prompt.resourceId, {
        expectedStatus: prompt.current,
        status: prompt.target,
      });
      setWorkflowStatusPrompt(null);
      await refreshCurrentView();
    } catch (nextError) {
      // 409 会保留弹窗和原选择，用户可以看到服务端返回的陈旧状态原因后刷新重试。
      setError(describeError(nextError));
    } finally {
      setWorkflowStatusPending(false);
    }
  };

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
          <button
            type="button"
            className="resource-task-center-button"
            title="后台任务"
            aria-label={`后台任务，${props.taskCenter.activeCount} 项活动任务`}
            onClick={props.taskCenter.onOpen}
          >
            <ListTodo size={17} />
            {props.taskCenter.activeCount > 0 ? (
              <span className="resource-task-center-badge">
                {props.taskCenter.activeCount > 99 ? "99+" : props.taskCenter.activeCount}
                {props.taskCenter.isPartial ? "+" : ""}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            title="修改我的密码"
            onClick={() => setChangePasswordOpen(true)}
          >
            <KeyRound size={17} />
          </button>
          {canManageAccounts ? (
            <button
              type="button"
              title="账号管理"
              onClick={() => setAccountManagementOpen(true)}
            >
              <Users size={17} />
            </button>
          ) : null}
          {hasFullResourceAccess ? (
            <>
              {/* 项目权限是管理员快速入口；账号生命周期仍只属于系统管理员。 */}
              <button
                type="button"
                title="项目权限管理"
                onClick={() => setProjectPermissionManagementOpen(true)}
              >
                <ShieldCheck size={17} />
              </button>
              {/* 全局审计与系统诊断使用独立窗口，避免健康指标和业务日志混成一个超长面板。 */}
              <button
                type="button"
                title="审计日志"
                onClick={() => setAuditLogOpen(true)}
              >
                <ScrollText size={17} />
              </button>
              <button
                type="button"
                title="系统诊断"
                onClick={() => setDiagnosticsOpen(true)}
              >
                <ServerCog size={17} />
              </button>
            </>
          ) : null}
          <button type="button" title="刷新" onClick={() => void refreshCurrentView()}>
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
              {displayBreadcrumbs.map((item, index) => (
                <span key={item.id}>
                  <ChevronRight size={14} />
                  <ResourceBreadcrumbTarget
                    resource={mode === "column"
                      ? columnBreadcrumbs[index] ?? null
                      : breadcrumbResources[item.id] ?? null}
                    disabled={
                      isTrashView ||
                      isLoading ||
                      isPasting ||
                      isRestoring ||
                      isMovingResources ||
                      workflowStatusPending ||
                      movingResources.length > 0
                    }
                    onNavigate={() => {
                      if (mode === "column") {
                        columnBrowser.openResource(index, item);
                        setFolderId(item.id);
                        setSelectionColumnIndex(index);
                        setAnchorColumnIndex(index);
                        setAnchorId(item.id);
                        setSelectedIds([item.id]);
                      } else {
                        setFolderId(item.id);
                      }
                    }}
                    onDrop={handleResourceDrop}
                  >
                    {item.name}
                  </ResourceBreadcrumbTarget>
                </span>
              ))}
            </div>
            <div className="resource-toolbar-actions">
              {isTrashView ? (
                <button
                  type="button"
                  disabled={
                    isRestoring ||
                    !selectionItems.some((item) =>
                      selectedIds.includes(item.id) &&
                      item.permission.capabilities.includes("delete"))
                  }
                  onClick={() => void restoreResources(
                    selectionItems.filter((item) => selectedIds.includes(item.id)),
                  )}
                  title="恢复到原位置"
                >
                  <RotateCcw size={16} />
                  {isRestoring ? "正在恢复" : `恢复所选${selectedIds.length ? `（${selectedIds.length}）` : ""}`}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void createContainer("project")}
                    title="新建项目"
                  >
                    <Plus size={16} />
                  </button>
                  <button type="button" disabled={!locationParentId} onClick={() => void createContainer("folder")} title="新建文件夹">
                    <Folder size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={!locationParentId || isCreatingBlankAnnotation}
                    onClick={() => void createBlankAnnotationProject()}
                    title={locationParentId ? "新建空白标注工程" : "请先进入项目或文件夹"}
                  >
                    <FilePlus2 size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={!locationParentId && !(isAllProjectsRoot && hasFullResourceAccess)}
                    onClick={() => jsonInputRef.current?.click()}
                    title={isAllProjectsRoot
                      ? hasFullResourceAccess
                        ? "按编号批量导入标注 JSON"
                        : "只有管理员可以批量导入标注 JSON"
                      : "导入标注 JSON"}
                  >
                    <FileJson2 size={16} />
                  </button>
                  <button type="button" disabled={!locationParentId} onClick={() => mediaInputRef.current?.click()} title="上传媒体">
                    <Upload size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={!locationParentId}
                    onClick={() => setVodDialogOpen(true)}
                    title="接入阿里云 VOD"
                  >
                    <Cloud size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={!locationParentId || !clipboard.length || isPasting}
                    onClick={() => void pasteClipboard()}
                    title={locationParentId
                      ? `粘贴 ${clipboard.length} 项到当前目录`
                      : "请先进入项目或文件夹"}
                  >
                    <ClipboardPaste size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={
                      !selectedResources.length ||
                      isMovingResources ||
                      selectedResources.some((resource) =>
                        !resource.permission.capabilities.includes("move"))
                    }
                    onClick={() => openMovePicker(selectedResources[0]!)}
                    title="移动所选资源"
                  >
                    <FolderInput size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={
                      !selectedResources.length ||
                      isTrashing ||
                      selectedResources.some((resource) =>
                        !resource.permission.capabilities.includes("delete"))
                    }
                    onClick={() => void trashResources(selectedResources)}
                    title={selectedResources.length
                      ? `将所选 ${selectedResources.length} 项移到回收站`
                      : "请先选择资源"}
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={!comparableFiles}
                    onClick={() => setComparisonFiles(comparableFiles)}
                    title={comparableFiles
                      ? "比较所选的两个标注文件"
                      : "请选择两个可读取的标注文件"}
                  >
                    <Files size={16} />
                  </button>
                </>
              )}
              <span className="resource-toolbar-divider" />
              <button type="button" className={mode === "list" ? "active" : ""} onClick={() => changeMode("list")} title="列表"><List size={16} /></button>
              <button type="button" className={mode === "grid" ? "active" : ""} onClick={() => changeMode("grid")} title="网格"><Grid2X2 size={16} /></button>
              <button type="button" className={mode === "column" ? "active" : ""} onClick={() => changeMode("column")} title="分栏"><MoreHorizontal size={16} /></button>
            </div>
          </div>
          {/* 固定保留反馈行，确保无错误时资源集合仍落在可伸展的第三个网格轨道。 */}
          <div className="resource-browser-feedback">
            {error ? <div className="resource-error-banner">{error}</div> : null}
          </div>
          {mode === "column" ? (
            <ResourceColumnBrowser
              columns={columnBrowser.columns}
              viewLabels={VIEW_LABELS}
              selectedIds={selectedIds}
              selectionColumnIndex={selectionColumnIndex}
              draggedResourceIds={draggedResourceIds}
              interactionDisabled={interactionDisabled}
              isTrashView={isTrashView}
              onSelect={(event, resource, columnIndex) => selectResource(
                event,
                resource,
                columnBrowser.columns[columnIndex]?.items ?? [],
                columnIndex,
              )}
              onOpen={openResource}
              onRename={renameSelectedResource}
              onCopy={(resource) => setClipboard([resource])}
              onMove={openMovePicker}
              onDownload={downloadResource}
              onRequestWorkflowStatus={requestWorkflowStatus}
              onRestore={(resource) => void restoreResources([resource])}
              onTrash={trashFromContext}
              canCompareSelection={Boolean(comparableFiles)}
              onCompare={() => {
                if (comparableFiles) setComparisonFiles(comparableFiles);
              }}
              onDragStart={(resourceIds, columnIndex) => {
                setSelectionColumnIndex(columnIndex);
                setAnchorColumnIndex(columnIndex);
                handleResourceDragStart(resourceIds);
              }}
              onDragFinish={handleResourceDragFinish}
              onDropResources={handleResourceDrop}
              onLoadMore={columnBrowser.loadMore}
            />
          ) : (
            <>
              <ResourceVirtualCollection
                items={page.items}
                selectedIds={selectedIds}
                mode={mode}
                isLoading={isLoading}
                isLoadingMore={isLoadingMore}
                hasNextPage={Boolean(page.nextCursor)}
                onLoadMore={() => {
                  if (page.nextCursor) void loadPage(page.nextCursor);
                }}
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
                isTrashView={isTrashView}
                onRename={renameSelectedResource}
                onCopy={(resource) => setClipboard([resource])}
                onMove={openMovePicker}
                onDownload={downloadResource}
                onRequestWorkflowStatus={requestWorkflowStatus}
                interactionDisabled={interactionDisabled}
                draggedResourceIds={draggedResourceIds}
                onDragStart={handleResourceDragStart}
                onDragFinish={handleResourceDragFinish}
                onDropResources={handleResourceDrop}
                onRestore={(resource) => void restoreResources([resource])}
                onTrash={trashFromContext}
                canCompareSelection={Boolean(comparableFiles)}
                onCompare={() => {
                  if (comparableFiles) setComparisonFiles(comparableFiles);
                }}
              />
            </>
          )}
        </section>

        <ResourceInspector
          client={props.client}
          resource={selected}
          readOnly={isTrashView}
          permissionRefreshVersion={permissionRefreshVersion}
          onChanged={() => refreshCurrentView()}
          onWorkflowGroupsChanged={async () => {
            // 职责组会改变有效权限来源，保存后同时重读列表摘要和 Inspector 权限矩阵。
            setPermissionRefreshVersion((current) => current + 1);
            await refreshCurrentView();
          }}
          onError={setError}
          onOpenAnnotationFile={props.onOpenAnnotationFile}
          onDownload={downloadResource}
        />
      </section>
      <input ref={jsonInputRef} hidden multiple type="file" accept="application/json,.json" onChange={(event) => void importJson(event)} />
      <input ref={mediaInputRef} hidden type="file" accept="video/*,audio/*" onChange={(event) => void uploadMedia(event)} />
      <AliyunVodMediaDialog
        client={props.client}
        parentId={locationParentId}
        open={vodDialogOpen}
        onOpenChange={setVodDialogOpen}
        onCreated={(resource) => {
          // 新建成功后刷新当前目录并选中资源，让用户能立即查看来源和权限详情。
          setSelectedIds([resource.id]);
          setAnchorId(resource.id);
          void refreshCurrentView();
        }}
      />
      {movingResources.length && props.user ? (
        <ResourceDestinationPicker
          client={props.client}
          resources={movingResources}
          user={props.user}
          onCancel={() => setMovingResources([])}
          onMove={async (parentId) => {
            const result = await moveResourcesTo(
              movingResources.map(({ id }) => id),
              parentId,
            );
            if (result) setMovingResources([]);
          }}
        />
      ) : null}
      {/* 比较对话框持有打开瞬间的文件快照，关闭后保留资源选择便于继续操作。 */}
      <AnnotationComparisonDialog
        client={props.client}
        files={comparisonFiles}
        onOpenFileAtTime={props.onOpenAnnotationFile}
        onPrepareMerge={props.onPrepareAnnotationMerge}
        onClose={() => setComparisonFiles(null)}
      />
      <AnnotationWorkflowStatusDialog
        prompt={workflowStatusPrompt}
        pending={workflowStatusPending}
        onClose={() => setWorkflowStatusPrompt(null)}
        onConfirm={() => void confirmWorkflowStatus()}
      />
      {pendingJsonImport ? (
        <AnnotationMediaBindingDialog
          client={props.client}
          parentId={pendingJsonImport.parentId}
          current={null}
          open
          allowUnbound
          onOpenChange={(open) => { if (!open) setPendingJsonImport(null); }}
          onConfirm={async (mediaResourceId) => {
            try {
              await props.client.createAnnotationFile({
                parentId: pendingJsonImport.parentId,
                name: pendingJsonImport.fileName,
                payload: prepareProjectForServer(pendingJsonImport.project),
                mediaResourceId,
              });
              setPendingJsonImport(null);
              await refreshCurrentView();
            } catch (nextError) {
              // 对话框保留当前目录与媒体选择，并在原位呈现失败原因。
              throw nextError;
            }
          }}
        />
      ) : null}
      {pendingBatchJsonImport ? (
        <BatchAnnotationImportDialog
          client={props.client}
          files={pendingBatchJsonImport.files}
          open
          onOpenChange={(open) => { if (!open) setPendingBatchJsonImport(null); }}
          onCompleted={refreshCurrentView}
        />
      ) : null}
      <ChangePasswordDialog
        client={props.client}
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
        onChanged={props.onLogout}
      />
      {canManageAccounts ? (
        <AccountManagementDialog
          client={props.client}
          currentUserId={props.user?.id ?? ""}
          open={accountManagementOpen}
          onOpenChange={setAccountManagementOpen}
        />
      ) : null}
      {/* 审计与系统诊断属于全资源管理员工具，不依赖当前资源选择，也不会挤占右侧 Inspector。 */}
      {hasFullResourceAccess ? (
        <>
          <ProjectPermissionManagementDialog
            client={props.client}
            open={projectPermissionManagementOpen}
            onOpenChange={setProjectPermissionManagementOpen}
            onPermissionChanged={async () => {
              // 项目 ACL 也可能改变当前子资源的继承权限，因此任何项目授权写入后都重读当前 Inspector 矩阵。
              setPermissionRefreshVersion((current) => current + 1);
              await refreshCurrentView();
            }}
          />
          {/* 审计窗口独立持有分页和筛选状态，不依赖当前资源选择。 */}
          <AuditLogDialog
            client={props.client}
            open={auditLogOpen}
            onOpenChange={setAuditLogOpen}
          />
          <SystemDiagnosticsDialog
            client={props.client}
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
          />
        </>
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

function ResourceBreadcrumbTarget(props: {
  resource: ResourceEntry | null;
  disabled: boolean;
  onNavigate: () => void;
  onDrop: (resourceIds: string[], targetId: string) => void;
  children: string;
}) {
  const elementRef = useRef<HTMLButtonElement>(null);
  const latestPropsRef = useRef(props);
  const [dropActive, setDropActive] = useState(false);
  latestPropsRef.current = props;

  useEffect(() => {
    const element = elementRef.current;
    const resource = props.resource;
    if (!element || !resource) return;
    return registerResourceDropTarget({
      element,
      targetId: resource.id,
      canCreateChild: () => latestPropsRef.current.resource?.permission
        .capabilities.includes("create_child") ?? false,
      disabled: () => latestPropsRef.current.disabled,
      onActiveChange: setDropActive,
      onDrop: (resourceIds, targetId) =>
        latestPropsRef.current.onDrop(resourceIds, targetId),
    });
  }, [props.resource?.id]);

  return (
    <button
      ref={elementRef}
      type="button"
      className={dropActive ? "drop-target-active" : ""}
      onClick={props.onNavigate}
    >
      {props.children}
    </button>
  );
}

function ResourceInspector(props: {
  client: PlatformClient;
  resource: ResourceEntry | null;
  readOnly: boolean;
  permissionRefreshVersion: number;
  onChanged: () => void | Promise<void>;
  onWorkflowGroupsChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
  onOpenAnnotationFile: (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ) => Promise<boolean>;
  onDownload: (resource: ResourceEntry) => void;
}) {
  const [annotationFile, setAnnotationFile] = useState<AnnotationFile<ProjectData> | null>(null);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);

  useEffect(() => {
    let active = true;
    if (props.resource?.type !== "annotation_file" || props.readOnly) {
      setAnnotationFile(null);
      return () => { active = false; };
    }
    void props.client.getAnnotationFile<ProjectData>(props.resource.id)
      .then((file) => { if (active) setAnnotationFile(file); })
      .catch((error) => { if (active) props.onError(describeError(error)); });
    return () => { active = false; };
  }, [props.client, props.onError, props.readOnly, props.resource]);

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
        <dt>类型</dt><dd>{resourceTypeLabel(props.resource)}</dd>
        <dt>{props.resource.type === "project" ? "所有者" : "创建人"}</dt>
        <dd>{props.resource.owner.displayName}</dd>
        {props.resource.type === "project" ? (
          <>
            <dt>负责人</dt>
            <dd>{resourceResponsibleOrCreatorLabel(props.resource)}</dd>
          </>
        ) : null}
        {props.resource.type === "project" || props.resource.type === "annotation_file" ? (
          <><dt>状态</dt><dd><ResourceWorkflowStatusBadge resource={props.resource} /></dd></>
        ) : null}
        <dt>创建</dt><dd>{formatResourceDate(props.resource.createdAt)}</dd>
        <dt>修改</dt><dd>{formatResourceDate(props.resource.updatedAt)}</dd>
        {props.resource.revision ? <><dt>修订</dt><dd>{props.resource.revision}</dd></> : null}
      </dl>
      {!props.readOnly ? (
        <div className="resource-inspector-actions">
          <button
            type="button"
            className="resource-inspector-action-button"
            onClick={() => void props.client.updateResource(props.resource!.id, {
              favorite: !props.resource!.favorite,
            }).then(props.onChanged).catch((error) => props.onError(describeError(error)))}
          >
            <Heart size={16} fill={props.resource.favorite ? "currentColor" : "none"} />
            {props.resource.favorite ? "已收藏" : "添加收藏"}
          </button>
          {canDirectlyDownloadResource(props.resource) ? (
            <button
              type="button"
              className="resource-inspector-action-button"
              onClick={() => props.onDownload(props.resource!)}
            >
              <Download size={16} /> 下载
            </button>
          ) : null}
        </div>
      ) : (
        <div className="resource-permission-readonly">
          回收站资源仅显示基本信息；恢复后可编辑收藏和账号权限。
        </div>
      )}
      {props.resource.type === "media_file" ? (
        <div className="resource-inspector-section-heading">
          <div>
            <strong>媒体来源</strong>
            <span>
              {props.resource.mediaSourceType === "aliyun_vod"
                ? "阿里云 VOD · 播放时临时签发凭据"
                : "服务器上传 · 可关联为独立音轨"}
            </span>
          </div>
        </div>
      ) : null}
      {/* 活动标注文件在详情栏中独立展示只读恢复历史，不与业务版本或普通资源混排。 */}
      {!props.readOnly && props.resource.type === "annotation_file" ? (
        <>
          <div className="resource-inspector-section-heading">
            <div>
              <strong>关联媒体</strong>
              <span>
                {annotationFile?.media?.name ?? "尚未关联视频或音频"}
                {!props.resource.permission.capabilities.includes("write") ? " · 只读，无法修改" : ""}
              </span>
            </div>
            {props.resource.permission.capabilities.includes("write") ? <button type="button" onClick={() => setMediaDialogOpen(true)}>设置</button> : null}
          </div>
          <ResourceRecoveryHistory
            key={props.resource.id}
            client={props.client}
            resource={props.resource}
            onRestored={() => props.onChanged()}
            onOpenCurrentAtTime={(focus) => props.onOpenAnnotationFile(
              props.resource!,
              focus,
            )}
          />
          <AnnotationMediaBindingDialog
            client={props.client}
            parentId={props.resource.parentId ?? null}
            current={annotationFile?.media ?? null}
            open={mediaDialogOpen}
            busy={mediaBusy}
            allowUnbound
            onOpenChange={setMediaDialogOpen}
            onConfirm={async (mediaResourceId) => {
              setMediaBusy(true);
              try {
                const file = await props.client.updateAnnotationMedia<ProjectData>(
                  props.resource!.id,
                  { mediaResourceId },
                );
                setAnnotationFile(file);
                setMediaDialogOpen(false);
                await props.onChanged();
              } catch (error) {
                // 失败由选择器原位展示，避免 Inspector 同时留下第二份过期错误横幅。
                throw error;
              } finally {
                setMediaBusy(false);
              }
            }}
          />
        </>
      ) : null}
      {props.resource.type === "project" ? (
        <ProjectWorkflowGroupEditor
          client={props.client}
          resource={props.resource}
          readOnly={props.readOnly}
          onChanged={props.onWorkflowGroupsChanged}
          onError={props.onError}
        />
      ) : null}
      {/* 权限矩阵由独立组件管理，资源详情不再维护第二套请求和账号行状态。 */}
      <ResourcePermissionEditor
        client={props.client}
        resource={props.resource}
        readOnly={props.readOnly}
        refreshVersion={props.permissionRefreshVersion}
        onChanged={props.onChanged}
        onError={props.onError}
      />
    </aside>
  );
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

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
