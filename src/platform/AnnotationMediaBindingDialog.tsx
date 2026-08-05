import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ChevronRight,
  Cloud,
  Film,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnnotationMediaReference,
  ResourceBreadcrumb,
  ResourceEntry,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { isResourceContainer } from "./resourceColumnModel";
import { collectResourcePickerItems } from "./resourcePickerPaging";
import { AliyunVodMediaDialog } from "./AliyunVodMediaDialog";

type Props = {
  client: PlatformClient;
  parentId: string | null;
  current?: AnnotationMediaReference | null;
  open: boolean;
  busy?: boolean;
  allowUnbound?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (mediaResourceId: string | null) => Promise<void> | void;
};

type DirectoryState = {
  current: ResourceEntry | null;
  breadcrumbs: ResourceBreadcrumb[];
  items: ResourceEntry[];
  nextCursor: string | null;
};

const EMPTY_DIRECTORY: DirectoryState = {
  current: null,
  breadcrumbs: [],
  items: [],
  nextCursor: null,
};

// 导入、Inspector 和平台编辑器共用同一媒体选择器。目录导航只消费资源树 API；
// 媒体绑定与权限真相仍由后端 updateAnnotationMedia 命令统一复核。
export function AnnotationMediaBindingDialog(props: Props) {
  const [folderId, setFolderId] = useState<string | null>(props.parentId);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryState>(EMPTY_DIRECTORY);
  const [selectedId, setSelectedId] = useState<string | null>(props.current?.resourceId ?? null);
  const [createdSelection, setCreatedSelection] = useState<ResourceEntry | null>(null);
  const [vodDialogOpen, setVodDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  const selectedItem = useMemo(
    () => directory.items.find(({ id }) => id === selectedId) ??
      (createdSelection?.id === selectedId ? createdSelection : null),
    [createdSelection, directory.items, selectedId],
  );
  const selectedCanBind = selectedId === null
    ? Boolean(props.allowUnbound)
    : selectedItem
      ? canBindMedia(selectedItem)
      : props.current?.resourceId === selectedId;
  const canUpload = Boolean(
    folderId && directory.current?.permission.capabilities.includes("create_child"),
  );
  const interactionBusy = Boolean(props.busy || uploading || confirming);

  const fetchPickerPage = useCallback((cursor: string | null) =>
    props.client.listResources({
      parentId: folderId,
      view: "children",
      query: query.trim() || undefined,
      sortBy: "name",
      direction: "asc",
      cursor: cursor ?? undefined,
      limit: 200,
    }), [folderId, props.client, query]);

  useEffect(() => {
    if (!props.open) return;
    setFolderId(props.parentId);
    setQuery("");
    setSelectedId(props.current?.resourceId ?? null);
    setCreatedSelection(null);
    setVodDialogOpen(false);
    setError(null);
  }, [props.current?.resourceId, props.open, props.parentId]);

  useEffect(() => {
    if (!props.open) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setDirectory(EMPTY_DIRECTORY);

    void Promise.all([
      collectResourcePickerItems(fetchPickerPage, null, isMediaPickerItem),
      folderId ? props.client.getResource(folderId) : Promise.resolve(null),
    ]).then(([page, current]) => {
      // 用户快速切目录或搜索时，迟到响应不能把路径和列表退回旧位置。
      if (requestId !== requestIdRef.current) return;
      setDirectory({
        current,
        breadcrumbs: page.breadcrumbs,
        items: page.items,
        nextCursor: page.nextCursor,
      });
    }).catch((nextError: unknown) => {
      if (requestId !== requestIdRef.current) return;
      setError(describeError(nextError));
    }).finally(() => {
      if (requestId === requestIdRef.current) setLoading(false);
    });

    return () => {
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [fetchPickerPage, folderId, props.client, props.open, refreshRevision]);

  async function loadMore() {
    const cursor = directory.nextCursor;
    if (!cursor || loadingMore || interactionBusy) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await collectResourcePickerItems(fetchPickerPage, cursor, isMediaPickerItem);
      if (requestId !== requestIdRef.current) return;
      setDirectory((current) => {
        const seen = new Set(current.items.map(({ id }) => id));
        return {
          ...current,
          items: [
            ...current.items,
            ...page.items.filter(({ id }) => !seen.has(id)),
          ],
          nextCursor: page.nextCursor,
        };
      });
    } catch (nextError) {
      if (requestId === requestIdRef.current) setError(describeError(nextError));
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  }

  function goToDirectory(resourceId: string | null) {
    if (interactionBusy || resourceId === folderId) return;
    setQuery("");
    setFolderId(resourceId);
  }

  async function upload(file: File | undefined) {
    if (!file || uploading || !folderId || !canUpload) return;
    setUploading(true);
    setError(null);
    try {
      const resource = await props.client.uploadMedia(folderId, file, file.name);
      // 上传响应已经携带完整权限信息；列表刷新完成前也应允许立即确认刚上传的媒体。
      setCreatedSelection(resource);
      setSelectedId(resource.id);
      setRefreshRevision((value) => value + 1);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function confirmSelection() {
    if (!selectedCanBind || interactionBusy) return;
    setConfirming(true);
    setError(null);
    try {
      await props.onConfirm(selectedId);
    } catch (nextError) {
      // mutation 失败保留目录、搜索和选择，用户可修复权限或网络后原地重试。
      setError(describeError(nextError));
    } finally {
      setConfirming(false);
    }
  }

  return <Dialog.Root
    open={props.open}
    onOpenChange={(open) => {
      // 上传或提交期间保持窗口与选择上下文，避免请求完成后落到已卸载组件。
      if (!interactionBusy) props.onOpenChange(open);
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="system-diagnostics-backdrop" />
      <Dialog.Content className="annotation-media-dialog">
        <header className="system-diagnostics-header">
          <div><Film size={20} /><div><Dialog.Title>关联视频或音频</Dialog.Title><Dialog.Description>从有权访问的服务器目录选择媒体，关系独立保存</Dialog.Description></div></div>
          <div className="system-diagnostics-header-actions">
            <button type="button" title="刷新当前目录" disabled={interactionBusy} onClick={() => setRefreshRevision((value) => value + 1)}><RefreshCw size={16} /></button>
            <Dialog.Close asChild><button type="button" title="关闭" disabled={interactionBusy}><X size={17} /></button></Dialog.Close>
          </div>
        </header>

        <div className="annotation-media-navigation">
          <button
            type="button"
            title="返回上一级"
            disabled={!folderId || loading || interactionBusy}
            onClick={() => goToDirectory(directory.current?.parentId ?? null)}
          >
            <ArrowLeft size={16} />
          </button>
          <nav aria-label="媒体目录路径">
            <button type="button" onClick={() => goToDirectory(null)}>资源根目录</button>
            {directory.breadcrumbs.map((item) => <span key={item.id}>
              <ChevronRight size={13} />
              <button type="button" onClick={() => goToDirectory(item.id)}>{item.name}</button>
            </span>)}
          </nav>
          <label className="annotation-media-search">
            <Search size={15} />
            <input
              value={query}
              placeholder="搜索当前目录"
              aria-label="搜索当前目录媒体"
              disabled={interactionBusy}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ? <div className="resource-error-banner" role="alert">{error}</div> : null}
        {props.current ? (
          <div className="annotation-media-current">
            <span>当前关联</span>
            <strong>{props.current.name}</strong>
            <small>{describeMediaReference(props.current)}</small>
          </div>
        ) : null}

        <div className="annotation-media-list" aria-busy={loading}>
          {props.allowUnbound ? (
            <button type="button" className={selectedId === null ? "active" : ""} disabled={interactionBusy} onClick={() => setSelectedId(null)}>
              <X size={19} /><strong>暂不关联媒体</strong><span>之后可在标注文件详情或编辑器中重新设置</span>
            </button>
          ) : null}
          {loading ? <p>正在读取当前目录…</p> : null}
          {!loading && !directory.items.length ? <p>当前目录没有可浏览的文件夹或媒体。</p> : null}
          {directory.items.map((item) => {
            if (isResourceContainer(item)) {
              return <button key={item.id} type="button" disabled={interactionBusy} onClick={() => goToDirectory(item.id)}>
                {item.type === "project" ? <FolderOpen size={19} /> : <Folder size={19} />}
                <strong>{item.name}</strong><span>打开目录</span><ChevronRight className="annotation-media-enter-icon" size={16} />
              </button>;
            }
            const permitted = canBindMedia(item);
            return <button
              key={item.id}
              type="button"
              className={selectedId === item.id ? "active" : ""}
              disabled={!permitted || interactionBusy}
              title={permitted ? "选择此媒体" : "需要读取和下载权限"}
              onClick={() => {
                setCreatedSelection(null);
                setSelectedId(item.id);
              }}
            >
              <Film size={19} /><strong>{item.name}</strong><span>{describeMediaResource(item)}</span>
            </button>;
          })}
          {directory.nextCursor ? (
            <div className="annotation-media-load-more">
              <button type="button" disabled={loadingMore || interactionBusy} onClick={() => void loadMore()}>
                {loadingMore ? "正在加载…" : "加载更多"}
              </button>
            </div>
          ) : null}
        </div>

        <footer className="annotation-media-actions">
          <span>{folderId ? `上传位置：${directory.current?.name ?? "正在读取"}` : "进入项目或文件夹后可上传媒体"}</span>
          <input ref={inputRef} hidden type="file" accept="video/*,audio/*" onChange={(event) => void upload(event.target.files?.[0])} />
          <button type="button" disabled={!canUpload || interactionBusy} title={canUpload ? "上传到当前目录" : "当前目录不可上传"} onClick={() => inputRef.current?.click()}><Upload size={15} />{uploading ? "上传中" : "上传新媒体"}</button>
          <button type="button" disabled={!canUpload || interactionBusy} title={canUpload ? "在当前目录创建 VOD 资源" : "当前目录不可创建"} onClick={() => setVodDialogOpen(true)}><Cloud size={15} />接入 VOD</button>
          <button type="button" className="platform-primary-button" disabled={!selectedCanBind || interactionBusy} onClick={() => void confirmSelection()}>{props.busy || confirming ? "保存中" : "确认关联"}</button>
        </footer>
        <AliyunVodMediaDialog
          client={props.client}
          parentId={folderId}
          open={vodDialogOpen}
          onOpenChange={setVodDialogOpen}
          onCreated={(resource) => {
            setCreatedSelection(resource);
            setSelectedId(resource.id);
            setRefreshRevision((value) => value + 1);
          }}
        />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function isMediaPickerItem(resource: ResourceEntry) {
  return isResourceContainer(resource) || resource.type === "media_file";
}

function canBindMedia(resource: ResourceEntry) {
  const capabilities = resource.permission.capabilities;
  return resource.type === "media_file" &&
    capabilities.includes("read") && capabilities.includes("download") &&
    Boolean(resource.mediaKind === "video" || resource.mediaKind === "audio");
}

// 当前绑定与目录资源分别使用严格来源标签，VOD 不显示伪造大小或 MIME。
function describeMediaReference(media: AnnotationMediaReference) {
  if (media.sourceType === "aliyun_vod") {
    return `阿里云 VOD · ${media.mediaKind === "video" ? "视频" : "音频"} · ${formatDuration(media.duration)}`;
  }
  return `${formatBytes(media.size)} · ${media.mimeType}`;
}

function describeMediaResource(media: ResourceEntry) {
  if (media.mediaSourceType === "aliyun_vod") {
    return `阿里云 VOD · ${media.mediaKind === "audio" ? "音频" : "视频"} · ${formatDuration(media.duration ?? null)}`;
  }
  return `${formatBytes(media.size ?? 0)} · ${media.mimeType ?? "未知媒体类型"}`;
}

// 供应商时长缺失时保留明确状态，避免把未知时长误写成 0:00。
function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "时长未知";
  const totalSeconds = Math.max(0, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "读取媒体失败。";
}
