import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "react";
import type { ResourceEntry } from "@xiqu/shared";
import type { AnnotationWorkflowStatus } from "@xiqu/shared";
import { ResourceItem } from "./ResourceItem";

export type ResourceCollectionMode = "list" | "grid";

// 虚拟资源集合只控制可视区布局；资源命令、权限、菜单和 DnD 继续由共享 ResourceItem 负责。
export type ResourceVirtualCollectionProps = {
  items: ResourceEntry[];
  selectedIds: string[];
  mode: ResourceCollectionMode;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasNextPage: boolean;
  isTrashView: boolean;
  sortBy: string;
  direction: "asc" | "desc";
  onSort: (field: "name" | "createdAt" | "updatedAt" | "size") => void;
  onLoadMore: () => void;
  onSelect: (event: MouseEvent, resource: ResourceEntry) => void;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onDownload: (resource: ResourceEntry) => void;
  onRequestWorkflowStatus: (
    resource: ResourceEntry,
    status: AnnotationWorkflowStatus,
  ) => void;
  interactionDisabled: boolean;
  draggedResourceIds: string[];
  onDragStart: (resourceIds: string[]) => void;
  onDragFinish: () => void;
  onDropResources: (resourceIds: string[], targetId: string) => void;
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  canCompareSelection: boolean;
  onCompare: (resource: ResourceEntry) => void;
};

const LIST_ROW_HEIGHT = 38;
const GRID_MIN_CARD_WIDTH = 138;
const GRID_ROW_HEIGHT = 128;
const GRID_GAP = 8;
const GRID_HORIZONTAL_PADDING = 24;

// 入口组件保持 loading/empty 语义统一，再按显示模式选择固定行或虚拟网格实现。
export function ResourceVirtualCollection(
  props: ResourceVirtualCollectionProps,
) {
  if (props.isLoading && !props.items.length) {
    return <div className="resource-empty">正在读取资源...</div>;
  }
  if (!props.items.length) {
    return <div className="resource-empty">这个位置还没有可见资源。</div>;
  }
  return props.mode === "grid"
    ? <VirtualResourceGrid {...props} />
    : <VirtualResourceList {...props} />;
}

// 详细列表将表头留在滚动区外，虚拟器只管理固定高度的数据行。
function VirtualResourceList(props: ResourceVirtualCollectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 10,
  });
  const virtualRows = virtualizer.getVirtualItems();
  useLoadMoreNearEnd(
    virtualRows[virtualRows.length - 1]?.index,
    props.items.length,
    props.hasNextPage,
    props.isLoadingMore,
    props.onLoadMore,
  );

  return (
    <div ref={scrollRef} className="resource-list">
      <div className="resource-list-header">
        <SortButton label="名称" field="name" {...props} />
        <span>类型</span>
        <SortButton label="修改时间" field="updatedAt" {...props} />
        <span>负责人</span>
        <span>状态</span>
        <SortButton label="大小" field="size" {...props} />
      </div>
      <div
        className="resource-virtual-spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => {
          const resource = props.items[row.index]!;
          return (
            <div
              key={resource.id}
              className="resource-virtual-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <ResourceItem
                resource={resource}
                displayMode="list"
                {...resourceItemProps(props, resource)}
              />
            </div>
          );
        })}
      </div>
      <LoadMoreCommand {...props} />
    </div>
  );
}

// 网格按“卡片行”虚拟化；ResizeObserver 只重算列数，不改变资源顺序或选择语义。
function VirtualResourceGrid(props: ResourceVirtualCollectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columnCount = Math.max(1, Math.floor(
    (Math.max(0, width - GRID_HORIZONTAL_PADDING) + GRID_GAP) /
      (GRID_MIN_CARD_WIDTH + GRID_GAP),
  ));
  const rowCount = Math.ceil(props.items.length / columnCount);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 4,
  });
  const virtualRows = virtualizer.getVirtualItems();
  useLoadMoreNearEnd(
    virtualRows[virtualRows.length - 1]?.index,
    rowCount,
    props.hasNextPage,
    props.isLoadingMore,
    props.onLoadMore,
  );

  return (
    <div ref={scrollRef} className="resource-grid">
      <div
        className="resource-virtual-spacer resource-grid-spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => {
          const resources = props.items.slice(
            row.index * columnCount,
            (row.index + 1) * columnCount,
          );
          return (
            <div
              key={row.key}
              className="resource-grid-row"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                transform: `translateY(${row.start}px)`,
              }}
            >
              {resources.map((resource) => (
                <ResourceItem
                  key={resource.id}
                  resource={resource}
                  displayMode="grid"
                  {...resourceItemProps(props, resource)}
                />
              ))}
            </div>
          );
        })}
      </div>
      <LoadMoreCommand {...props} />
    </div>
  );
}

// 接近当前已加载集合末端时预取下一页；父级 loading 锁保证同一 cursor 不会并发请求。
function useLoadMoreNearEnd(
  lastVisibleIndex: number | undefined,
  itemCount: number,
  hasNextPage: boolean,
  isLoadingMore: boolean,
  onLoadMore: () => void,
) {
  useEffect(() => {
    if (
      lastVisibleIndex === undefined ||
      !hasNextPage ||
      isLoadingMore ||
      lastVisibleIndex < itemCount - 5
    ) return;
    onLoadMore();
  }, [hasNextPage, isLoadingMore, itemCount, lastVisibleIndex, onLoadMore]);
}

// 显式命令既显示加载状态，也为键盘用户和失败重试保留稳定入口。
function LoadMoreCommand(props: ResourceVirtualCollectionProps) {
  if (!props.hasNextPage) return null;
  return (
    <div className="resource-load-more">
      <button
        type="button"
        disabled={props.isLoading || props.isLoadingMore}
        onClick={props.onLoadMore}
      >
        {props.isLoadingMore ? "正在加载…" : "加载更多"}
      </button>
    </div>
  );
}

// 三种视图共享同一资源项属性组，整组选择权限不能因虚拟项卸载而改变。
function resourceItemProps(
  props: ResourceVirtualCollectionProps,
  resource: ResourceEntry,
) {
  const isSelected = props.selectedIds.includes(resource.id);
  const trashCandidates = isSelected
    ? props.items.filter(({ id }) => props.selectedIds.includes(id))
    : [resource];
  return {
    isSelected,
    isDragging: props.draggedResourceIds.includes(resource.id),
    interactionDisabled: props.interactionDisabled,
    isTrashView: props.isTrashView,
    canTrashSelection: trashCandidates.every((item) =>
      item.permission.capabilities.includes("delete")),
    canCompareSelection: isSelected && props.canCompareSelection,
    getDragResources: () => isSelected
      ? props.items.filter(({ id }) => props.selectedIds.includes(id))
      : [resource],
    onSelect: props.onSelect,
    onOpen: props.onOpen,
    onRename: props.onRename,
    onCopy: props.onCopy,
    onMove: props.onMove,
    onDownload: props.onDownload,
    onRequestWorkflowStatus: props.onRequestWorkflowStatus,
    onRestore: props.onRestore,
    onTrash: props.onTrash,
    onCompare: props.onCompare,
    onDragStart: props.onDragStart,
    onDragFinish: props.onDragFinish,
    onDropResources: props.onDropResources,
  };
}

// 排序按钮只发送字段命令，方向切换继续由 ResourceExplorer 的查询状态统一管理。
function SortButton(props: {
  label: string;
  field: "name" | "createdAt" | "updatedAt" | "size";
  sortBy: string;
  direction: "asc" | "desc";
  onSort: (field: "name" | "createdAt" | "updatedAt" | "size") => void;
}) {
  return (
    <button type="button" onClick={() => props.onSort(props.field)}>
      {props.label}{props.sortBy === props.field
        ? (props.direction === "asc" ? " ↑" : " ↓")
        : ""}
    </button>
  );
}
