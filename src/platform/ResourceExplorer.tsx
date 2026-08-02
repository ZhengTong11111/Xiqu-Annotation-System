import {
  Archive,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  FileJson2,
  Files,
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
  RotateCcw,
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
import { AnnotationComparisonDialog } from "./AnnotationComparisonDialog";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import type {
  AnnotationMergePreparationRequest,
  AnnotationMergePreparationResult,
} from "./annotationMergeDraft";
import { ResourceColumnBrowser } from "./ResourceColumnBrowser";
import { ResourceDestinationPicker } from "./ResourceDestinationPicker";
import {
  formatResourceDate,
  ResourceIcon,
  resourceTypeLabel,
} from "./ResourceItem";
import { ResourceVirtualCollection } from "./ResourceVirtualCollection";
import { ResourceRecoveryHistory } from "./ResourceRecoveryHistory";
import { copyResourcesSequentially } from "./resourceClipboard";
import {
  registerResourceDropTarget,
} from "./resourceDragAndDrop";
import { restoreResourcesSequentially } from "./resourceRestore";
import { isResourceContainer } from "./resourceColumnModel";
import { useResourceColumns } from "./useResourceColumns";
import { appendResourceListPage } from "./resourcePageState";
import { getComparableAnnotationFiles } from "./resourceComparison";

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
  review: "审核",
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
  onOpenAnnotationFile: (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ) => Promise<boolean>;
  onPrepareAnnotationMerge: (
    request: AnnotationMergePreparationRequest,
  ) => Promise<AnnotationMergePreparationResult>;
}) {
  const [rootView, setRootView] = useState<ResourceListView>("all_projects");
  const [folderId, setFolderId] = useState<string | null>(null);
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
  const [isMovingResources, setIsMovingResources] = useState(false);
  const [draggedResourceIds, setDraggedResourceIds] = useState<string[]>([]);
  const [breadcrumbResources, setBreadcrumbResources] = useState<
    Record<string, ResourceEntry>
  >({});
  const [error, setError] = useState<string | null>(null);
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
      const command = event.metaKey || event.ctrlKey;
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

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isProjectFileLike(parsed)) {
        throw new Error("所选 JSON 不是有效的标注项目文件。");
      }
      if (!locationParentId) throw new Error("请先进入项目或文件夹。");
      const project = normalizeImportedProjectFile(parsed).project;
      await props.client.createAnnotationFile({
        parentId: locationParentId,
        name: file.name,
        payload: prepareProjectForServer(project),
      });
      await refreshCurrentView();
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
      const uploaded = await props.client.uploadFile(file);
      await props.client.importMediaFile({
        parentId: locationParentId,
        fileId: uploaded.file.id,
        name: file.name,
      });
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
    isPasting ||
    isRestoring ||
    isMovingResources ||
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
                  <button type="button" disabled={!locationParentId} onClick={() => jsonInputRef.current?.click()} title="导入标注 JSON">
                    <FileJson2 size={16} />
                  </button>
                  <button type="button" disabled={!locationParentId} onClick={() => mediaInputRef.current?.click()} title="上传媒体">
                    <Upload size={16} />
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
          onChanged={() => refreshCurrentView()}
          onError={setError}
          onOpenAnnotationFile={props.onOpenAnnotationFile}
        />
      </section>
      <input ref={jsonInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importJson(event)} />
      <input ref={mediaInputRef} hidden type="file" accept="video/*,audio/*" onChange={(event) => void uploadMedia(event)} />
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
  onChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
  onOpenAnnotationFile: (
    resource: ResourceEntry,
    initialFocus?: AnnotationComparisonFocus,
  ) => Promise<boolean>;
}) {
  const [matrix, setMatrix] = useState<ResourcePermissionMatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const canManage = !props.readOnly &&
    (props.resource?.permission.canManagePermissions ?? false);

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
        <dt>类型</dt><dd>{resourceTypeLabel(props.resource.type)}</dd>
        <dt>所有者</dt><dd>{props.resource.owner.displayName}</dd>
        <dt>创建</dt><dd>{formatResourceDate(props.resource.createdAt)}</dd>
        <dt>修改</dt><dd>{formatResourceDate(props.resource.updatedAt)}</dd>
        {props.resource.revision ? <><dt>修订</dt><dd>{props.resource.revision}</dd></> : null}
      </dl>
      {!props.readOnly ? (
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
      ) : (
        <div className="resource-permission-readonly">
          回收站资源仅显示基本信息；恢复后可编辑收藏和账号权限。
        </div>
      )}
      {/* 活动标注文件在详情栏中独立展示只读恢复历史，不与业务版本或普通资源混排。 */}
      {!props.readOnly && props.resource.type === "annotation_file" ? (
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
      ) : null}
      <div className="resource-inspector-section-heading">
        <div><strong>账号权限</strong><span>当前选中资源的逐账号授权</span></div>
        {canManage ? <button type="button" onClick={() => void load()} title="刷新权限"><RefreshCw size={15} /></button> : null}
      </div>
      {!canManage && !props.readOnly ? (
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
