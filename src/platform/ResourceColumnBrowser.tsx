import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import type { ResourceEntry, ResourceListView } from "@xiqu/shared";
import { getColumnPathSelection } from "./resourceColumnModel";
import { ResourceItem } from "./ResourceItem";
import type { LoadedResourceColumn } from "./useResourceColumns";

export function ResourceColumnBrowser(props: {
  columns: LoadedResourceColumn[];
  viewLabels: Record<ResourceListView, string>;
  selectedIds: string[];
  selectionColumnIndex: number;
  draggedResourceIds: string[];
  interactionDisabled: boolean;
  isTrashView: boolean;
  onSelect: (
    event: MouseEvent,
    resource: ResourceEntry,
    columnIndex: number,
  ) => void;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onDownload: (resource: ResourceEntry) => void;
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  onCompare: (resource: ResourceEntry) => void;
  canCompareSelection: boolean;
  onDragStart: (resourceIds: string[], columnIndex: number) => void;
  onDragFinish: () => void;
  onDropResources: (resourceIds: string[], targetId: string) => void;
  onLoadMore: (columnKey: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 新目录列出现后自动露出最右侧，但只滚动横向列组，不改变各列自己的纵向位置。
    scrollerRef.current?.scrollTo({
      left: scrollerRef.current.scrollWidth,
      behavior: "smooth",
    });
  }, [props.columns.length]);

  useEffect(() => {
    // 逻辑列始终挂载，可直接让列容器进入横向视口；纵向资源由列内虚拟器定位。
    const column = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-column-index="${props.selectionColumnIndex}"]`,
    );
    column?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.selectedIds, props.selectionColumnIndex]);

  return (
    <div ref={scrollerRef} className="resource-column-browser">
      {props.columns.map((column, columnIndex) => {
        const pathSelectedId = getColumnPathSelection(
          props.columns,
          columnIndex,
        );
        const columnSelection = props.selectionColumnIndex === columnIndex
          ? props.selectedIds
          : [];
        return (
          <section
            key={column.key}
            className={[
              "resource-column",
              props.selectionColumnIndex === columnIndex ? "active" : "",
            ].filter(Boolean).join(" ")}
            data-column-index={columnIndex}
          >
            <header>{columnTitle(props.columns, columnIndex, props.viewLabels)}</header>
            <VirtualColumnItems
              {...props}
              column={column}
              columnIndex={columnIndex}
              columnSelection={columnSelection}
              pathSelectedId={pathSelectedId}
            />
          </section>
        );
      })}
    </div>
  );
}

// 每个 Finder 列持有独立滚动元素和虚拟器，列间纵向位置不会互相干扰。
function VirtualColumnItems(props: Parameters<typeof ResourceColumnBrowser>[0] & {
  column: LoadedResourceColumn;
  columnIndex: number;
  columnSelection: string[];
  pathSelectedId: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.column.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const selectedId = props.columnSelection[0] ?? props.pathSelectedId;

  useEffect(() => {
    // 选中项可能刚由后续页加载；按数据索引定位，不依赖尚未挂载的 DOM 查询。
    if (!selectedId) return;
    const index = props.column.items.findIndex(({ id }) => id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [props.column.items, selectedId, virtualizer]);

  useEffect(() => {
    const lastIndex = virtualRows[virtualRows.length - 1]?.index;
    if (
      lastIndex === undefined ||
      !props.column.nextCursor ||
      props.column.loadingMore ||
      lastIndex < props.column.items.length - 5
    ) return;
    props.onLoadMore(props.column.key);
  }, [
    props.column.items.length,
    props.column.key,
    props.column.loadingMore,
    props.column.nextCursor,
    props.onLoadMore,
    virtualRows,
  ]);

  if (props.column.error) {
    return <div className="resource-column-message error">{props.column.error}</div>;
  }
  if (props.column.loading && !props.column.items.length) {
    return <div className="resource-column-message">正在读取...</div>;
  }
  if (!props.column.items.length) {
    return <div className="resource-column-message">没有可见资源</div>;
  }

  return (
    <div ref={scrollRef} className="resource-column-scroll">
      <div
        className="resource-virtual-spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => {
          const resource = props.column.items[row.index]!;
          const isSelected = props.columnSelection.includes(resource.id);
          return (
            <div
              key={resource.id}
              className="resource-virtual-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <ResourceItem
                resource={resource}
                displayMode="column"
                isSelected={isSelected}
                isPathSelected={props.pathSelectedId === resource.id}
                isDragging={props.draggedResourceIds.includes(resource.id)}
                interactionDisabled={props.interactionDisabled}
                isTrashView={props.isTrashView}
                canTrashSelection={isSelected
                  ? props.column.items
                    .filter(({ id }) => props.columnSelection.includes(id))
                    .every((item) =>
                      item.permission.capabilities.includes("delete"))
                  : resource.permission.capabilities.includes("delete")}
                canCompareSelection={props.canCompareSelection && isSelected}
                getDragResources={() => isSelected
                  ? props.column.items.filter(({ id }) =>
                    props.columnSelection.includes(id))
                  : [resource]}
                onSelect={(event, item) =>
                  props.onSelect(event, item, props.columnIndex)}
                onOpen={props.onOpen}
                onRename={props.onRename}
                onCopy={props.onCopy}
                onMove={props.onMove}
                onDownload={props.onDownload}
                onRestore={props.onRestore}
                onTrash={props.onTrash}
                onCompare={props.onCompare}
                onDragStart={(resourceIds) =>
                  props.onDragStart(resourceIds, props.columnIndex)}
                onDragFinish={props.onDragFinish}
                onDropResources={props.onDropResources}
              />
            </div>
          );
        })}
      </div>
      {props.column.nextCursor ? (
        <div className="resource-column-load-more">
          {props.column.loadMoreError ? (
            <span role="alert">{props.column.loadMoreError}</span>
          ) : null}
          <button
            type="button"
            disabled={props.column.loadingMore}
            onClick={() => props.onLoadMore(props.column.key)}
          >
            {props.column.loadingMore ? "正在加载…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function columnTitle(
  columns: LoadedResourceColumn[],
  index: number,
  viewLabels: Record<ResourceListView, string>,
) {
  if (index === 0) return viewLabels[columns[0]?.view ?? "all_projects"];
  const openedId = columns[index]?.openedByResourceId;
  return columns[index - 1]?.items.find(({ id }) => id === openedId)?.name ??
    "文件夹";
}
