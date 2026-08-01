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
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  onDragStart: (resourceIds: string[], columnIndex: number) => void;
  onDragFinish: () => void;
  onDropResources: (resourceIds: string[], targetId: string) => void;
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
    const selectedId = props.selectedIds[0];
    if (!selectedId) return;
    const selectedElement = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-resource-id="${CSS.escape(selectedId)}"]`,
    );
    selectedElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
          >
            <header>{columnTitle(props.columns, columnIndex, props.viewLabels)}</header>
            <div className="resource-column-scroll">
              {column.error ? (
                <div className="resource-column-message error">{column.error}</div>
              ) : column.loading && !column.items.length ? (
                <div className="resource-column-message">正在读取...</div>
              ) : !column.items.length ? (
                <div className="resource-column-message">没有可见资源</div>
              ) : column.items.map((resource) => (
                <ResourceItem
                  key={resource.id}
                  resource={resource}
                  displayMode="column"
                  isSelected={columnSelection.includes(resource.id)}
                  isPathSelected={pathSelectedId === resource.id}
                  isDragging={props.draggedResourceIds.includes(resource.id)}
                  interactionDisabled={props.interactionDisabled}
                  isTrashView={props.isTrashView}
                  canTrashSelection={columnSelection.includes(resource.id)
                    ? column.items
                      .filter(({ id }) => columnSelection.includes(id))
                      .every((item) =>
                        item.permission.capabilities.includes("delete"))
                    : resource.permission.capabilities.includes("delete")}
                  getDragResources={() => columnSelection.includes(resource.id)
                    ? column.items.filter(({ id }) =>
                      columnSelection.includes(id))
                    : [resource]}
                  onSelect={(event, item) =>
                    props.onSelect(event, item, columnIndex)}
                  onOpen={props.onOpen}
                  onRename={props.onRename}
                  onCopy={props.onCopy}
                  onMove={props.onMove}
                  onRestore={props.onRestore}
                  onTrash={props.onTrash}
                  onDragStart={(resourceIds) =>
                    props.onDragStart(resourceIds, columnIndex)}
                  onDragFinish={props.onDragFinish}
                  onDropResources={props.onDropResources}
                />
              ))}
            </div>
          </section>
        );
      })}
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
