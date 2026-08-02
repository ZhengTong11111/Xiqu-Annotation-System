import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import type {
  PlatformUser,
  ResourceBreadcrumb,
  ResourceEntry,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { collectDestinationContainers } from "./resourceDestinationPaging";

type DestinationPickerProps = {
  client: PlatformClient;
  resources: ResourceEntry[];
  user: PlatformUser;
  onCancel: () => void;
  onMove: (parentId: string | null) => Promise<void>;
};

type DirectoryState = {
  current: ResourceEntry | null;
  breadcrumbs: ResourceBreadcrumb[];
  children: ResourceEntry[];
  nextCursor: string | null;
};

const EMPTY_DIRECTORY: DirectoryState = {
  current: null,
  breadcrumbs: [],
  children: [],
  nextCursor: null,
};

export function ResourceDestinationPicker(props: DestinationPickerProps) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<DirectoryState>(EMPTY_DIRECTORY);
  const [selectedTarget, setSelectedTarget] = useState<ResourceEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMoving, setIsMoving] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const isAdmin = props.user.roles.some((role) =>
    role === "super_admin" || role === "admin");
  const candidate = selectedTarget ?? directory.current;
  const candidateId = candidate?.id ?? null;
  const canCreateInCandidate = candidate
    ? candidate.permission.capabilities.includes("create_child")
    : folderId === null && isAdmin;
  const sourceIds = useMemo(
    () => new Set(props.resources.map(({ id }) => id)),
    [props.resources],
  );
  const isCurrentParent = props.resources.every((resource) =>
    (resource.parentId ?? null) === candidateId);
  const isSourceCandidate = candidateId !== null && sourceIds.has(candidateId);
  const canConfirm = !isLoading &&
    !isMoving &&
    canCreateInCandidate &&
    !isCurrentParent &&
    !isSourceCandidate;

  const statusMessage = useMemo(() => {
    if (isLoading) return "正在读取目标目录…";
    if (isSourceCandidate) return "不能把资源移动到它自己内部。";
    if (isCurrentParent) return "资源已经位于这个目录中。";
    if (!canCreateInCandidate) return "你没有在这个位置新建子项的权限。";
    return `将移动到：${candidate?.name ?? "资源根目录"}`;
  }, [
    canCreateInCandidate,
    candidate?.name,
    isCurrentParent,
    isLoading,
    isSourceCandidate,
  ]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    // 切换目录会使旧追加请求失效，新目录不能继承旧页的 loading 锁。
    setIsLoadingMore(false);
    setError(null);
    setSelectedTarget(null);
    setDirectory(EMPTY_DIRECTORY);

    void Promise.all([
      collectDestinationContainers((cursor) => props.client.listResources({
        parentId: folderId,
        view: "children",
        sortBy: "name",
        direction: "asc",
        cursor: cursor ?? undefined,
        limit: 200,
      }), null),
      folderId ? props.client.getResource(folderId) : Promise.resolve(null),
    ]).then(([page, current]) => {
      // 快速切换目录会产生并发请求，只允许最后一次响应更新视图，避免路径和内容串页。
      if (requestId !== requestIdRef.current) return;
      setDirectory({
        current,
        breadcrumbs: page.breadcrumbs,
        children: page.items,
        nextCursor: page.nextCursor,
      });
    }).catch((nextError: unknown) => {
      if (requestId !== requestIdRef.current) return;
      setError(describePickerError(nextError));
      setDirectory((current) => ({ ...current, children: [] }));
    }).finally(() => {
      if (requestId === requestIdRef.current) setIsLoading(false);
    });

    return () => {
      // 路径变化或组件卸载时让旧响应失效，不在卸载后的组件上写入状态。
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [folderId, props.client]);

  async function loadMoreDirectories() {
    const cursor = directory.nextCursor;
    if (!cursor || isLoadingMore || isMoving) return;
    const requestId = requestIdRef.current;
    setIsLoadingMore(true);
    setError(null);
    try {
      const page = await collectDestinationContainers((nextCursor) =>
        props.client.listResources({
          parentId: folderId,
          view: "children",
          sortBy: "name",
          direction: "asc",
          cursor: nextCursor ?? undefined,
          limit: 200,
        }), cursor);
      if (requestId !== requestIdRef.current) return;
      setDirectory((current) => {
        const seen = new Set(current.children.map(({ id }) => id));
        return {
          ...current,
          children: [
            ...current.children,
            ...page.items.filter(({ id }) => !seen.has(id)),
          ],
          nextCursor: page.nextCursor,
        };
      });
    } catch (nextError) {
      // 后续页失败保留已加载目标和 cursor，用户可在同一位置重试。
      if (requestId === requestIdRef.current) {
        setError(describePickerError(nextError));
      }
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingMore(false);
    }
  }

  function enterDirectory(resource: ResourceEntry) {
    // 后代只能经过其父容器进入；禁用源容器入口即可在 UI 层阻止选择 source subtree。
    // 后端仍会在事务内重新检查循环关系，前端判断不承担安全职责。
    if (sourceIds.has(resource.id) || isMoving) return;
    setFolderId(resource.id);
  }

  function goToDirectory(resourceId: string | null) {
    if (isMoving) return;
    setSelectedTarget(null);
    if (resourceId === folderId) return;
    setIsLoading(true);
    setFolderId(resourceId);
  }

  async function confirmMove() {
    if (!canConfirm) return;
    setIsMoving(true);
    setError(null);
    try {
      await props.onMove(candidateId);
    } catch (nextError) {
      // 失败时保留当前位置和候选目标，用户可处理权限或同名冲突后直接重试。
      setError(describePickerError(nextError));
      setIsMoving(false);
    }
  }

  function handleDirectoryKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    resource: ResourceEntry,
  ) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    enterDirectory(resource);
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !isMoving) props.onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="resource-destination-dialog">
          <header className="resource-destination-header">
            <div>
              <FolderInput size={20} />
              <span>
                <Dialog.Title>{buildPickerTitle(props.resources)}</Dialog.Title>
                <Dialog.Description>选择目标项目或文件夹</Dialog.Description>
              </span>
            </div>
            <Dialog.Close asChild>
              <button type="button" title="关闭" disabled={isMoving}>
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>

          <div className="resource-destination-navigation">
            <button
              type="button"
              title="返回上一级"
              disabled={!folderId || isLoading || isMoving}
              onClick={() => goToDirectory(directory.current?.parentId ?? null)}
            >
              <ArrowLeft size={16} />
            </button>
            <nav aria-label="目标目录路径">
              <button type="button" onClick={() => goToDirectory(null)}>
                资源根目录
              </button>
              {directory.breadcrumbs.map((item) => (
                <span key={item.id}>
                  <ChevronRight size={13} />
                  <button type="button" onClick={() => goToDirectory(item.id)}>
                    {item.name}
                  </button>
                </span>
              ))}
            </nav>
          </div>

          <div className="resource-destination-list" aria-busy={isLoading}>
            {isLoading ? (
              <div className="resource-destination-empty">正在读取目录…</div>
            ) : directory.children.length ? (
              directory.children.map((resource) => {
                const isSource = sourceIds.has(resource.id);
                const isSelected = selectedTarget?.id === resource.id;
                const canCreate = resource.permission.capabilities.includes("create_child");
                return (
                  <button
                    key={resource.id}
                    type="button"
                    className={isSelected ? "selected" : ""}
                    disabled={isSource || isMoving}
                    title={isSource
                      ? "不能移动到资源自身或其后代"
                      : canCreate
                        ? "双击打开；选中后可作为目标"
                        : "可浏览，但没有在此新建子项的权限"}
                    onClick={() => setSelectedTarget(resource)}
                    onDoubleClick={() => enterDirectory(resource)}
                    onKeyDown={(event) => handleDirectoryKeyDown(event, resource)}
                  >
                    {resource.type === "project"
                      ? <FolderOpen size={20} />
                      : <Folder size={20} />}
                    <span>
                      <strong>{resource.name}</strong>
                      <small>
                        {isSource
                          ? "当前资源，不能作为目标"
                          : canCreate
                            ? "可移动到此处"
                            : "仅可浏览"}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                );
              })
            ) : (
              <div className="resource-destination-empty">这个位置没有可浏览的子目录。</div>
            )}
            {/* 目录可能位于服务器后续页；显式入口同时承担有限扫描后的继续与失败重试。 */}
            {directory.nextCursor ? (
              <div className="resource-destination-load-more">
                <button
                  type="button"
                  disabled={isLoadingMore || isMoving}
                  onClick={() => void loadMoreDirectories()}
                >
                  {isLoadingMore ? "正在查找更多位置…" : "加载更多位置"}
                </button>
              </div>
            ) : null}
          </div>

          <footer className="resource-destination-footer">
            <div>
              <span>{statusMessage}</span>
              {error ? <strong role="alert">{error}</strong> : null}
            </div>
            <Dialog.Close asChild>
              <button type="button" disabled={isMoving}>取消</button>
            </Dialog.Close>
            <button
              type="button"
              className="primary"
              disabled={!canConfirm}
              onClick={() => void confirmMove()}
            >
              <FolderInput size={16} />
              {isMoving ? "正在移动…" : "移动到这里"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function describePickerError(error: unknown) {
  return error instanceof Error ? error.message : "移动失败，请稍后重试。";
}

function buildPickerTitle(resources: ResourceEntry[]) {
  if (resources.length === 1) return `移动“${resources[0]!.name}”`;
  const summary = resources.slice(0, 2).map(({ name }) => `“${name}”`).join("、");
  return `移动 ${resources.length} 项（${summary}${resources.length > 2 ? "等" : ""}）`;
}
