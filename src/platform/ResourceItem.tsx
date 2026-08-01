import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronRight,
  Copy,
  FileJson2,
  FileVideo2,
  Folder,
  FolderInput,
  FolderOpen,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { ResourceEntry } from "@xiqu/shared";
import {
  registerResourceDraggable,
  registerResourceDropTarget,
} from "./resourceDragAndDrop";
import { isResourceContainer } from "./resourceColumnModel";

export type ResourceItemDisplayMode = "list" | "grid" | "column";

export function ResourceItem(props: {
  resource: ResourceEntry;
  displayMode: ResourceItemDisplayMode;
  isSelected: boolean;
  isPathSelected?: boolean;
  isDragging: boolean;
  interactionDisabled: boolean;
  isTrashView: boolean;
  getDragResources: () => ResourceEntry[];
  onSelect: (event: MouseEvent, resource: ResourceEntry) => void;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  onDragStart: (resourceIds: string[]) => void;
  onDragFinish: () => void;
  onDropResources: (resourceIds: string[], targetId: string) => void;
}) {
  const elementRef = useRef<HTMLButtonElement>(null);
  const latestPropsRef = useRef(props);
  const [dropActive, setDropActive] = useState(false);
  latestPropsRef.current = props;
  const isContainer = isResourceContainer(props.resource);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const cleanups = [registerResourceDraggable({
      element,
      getResources: () => latestPropsRef.current.getDragResources(),
      disabled: () => latestPropsRef.current.interactionDisabled,
      onDragStart: (resourceIds) =>
        latestPropsRef.current.onDragStart(resourceIds),
      onDragFinish: () => latestPropsRef.current.onDragFinish(),
    })];
    if (isContainer) {
      cleanups.push(registerResourceDropTarget({
        element,
        targetId: props.resource.id,
        canCreateChild: () => latestPropsRef.current.resource.permission
          .capabilities.includes("create_child"),
        disabled: () => latestPropsRef.current.interactionDisabled,
        onActiveChange: setDropActive,
        onDrop: (resourceIds, targetId) =>
          latestPropsRef.current.onDropResources(resourceIds, targetId),
      }));
    }
    // Pragmatic DnD 是命令式注册；统一在共享资源项里注销，避免三种视图各留一套监听器。
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [isContainer, props.resource.id]);

  const className = [
    `resource-${props.displayMode}-item`,
    props.isSelected ? "selected" : "",
    props.isPathSelected ? "path-selected" : "",
    props.isDragging ? "dragging" : "",
    dropActive ? "drop-target-active" : "",
  ].filter(Boolean).join(" ");

  return (
    <ResourceContextMenu {...props}>
      <button
        ref={elementRef}
        type="button"
        className={className}
        data-resource-id={props.resource.id}
        onClick={(event) => props.onSelect(event, props.resource)}
        onDoubleClick={() => {
          if (!props.isTrashView) props.onOpen(props.resource);
        }}
      >
        {props.displayMode === "grid" ? (
          <>
            <ResourceIcon resource={props.resource} size={34} />
            <strong>{props.resource.name}</strong>
            <span>{props.resource.owner.displayName}</span>
          </>
        ) : props.displayMode === "column" ? (
          <>
            <ResourceIcon resource={props.resource} size={17} />
            <strong>{props.resource.name}</strong>
            {isContainer ? <ChevronRight size={15} /> : <span />}
          </>
        ) : (
          <>
            <span className="resource-name-cell">
              <ResourceIcon resource={props.resource} size={18} />
              <strong>{props.resource.name}</strong>
            </span>
            <span>{resourceTypeLabel(props.resource.type)}</span>
            <span>{formatResourceDate(props.resource.updatedAt)}</span>
            <span>{props.resource.owner.displayName}</span>
            <span>{formatResourceSize(props.resource.size)}</span>
          </>
        )}
      </button>
    </ResourceContextMenu>
  );
}

function ResourceContextMenu(props: {
  resource: ResourceEntry;
  isTrashView: boolean;
  children: ReactNode;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
}) {
  const capabilities = props.resource.permission.capabilities;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="resource-context-menu">
          {props.isTrashView ? (
            <ContextMenu.Item
              disabled={!capabilities.includes("delete")}
              onSelect={() => props.onRestore(props.resource)}
            >
              <RotateCcw size={15} /> 恢复到原位置
            </ContextMenu.Item>
          ) : (
            <>
              <ContextMenu.Item onSelect={() => props.onOpen(props.resource)}>
                <FolderOpen size={15} /> 打开
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item
                disabled={!capabilities.includes("copy")}
                onSelect={() => props.onCopy(props.resource)}
              >
                <Copy size={15} /> 复制
              </ContextMenu.Item>
              <ContextMenu.Item
                disabled={!capabilities.includes("move")}
                onSelect={() => props.onMove(props.resource)}
              >
                <FolderInput size={15} /> 移动到…
              </ContextMenu.Item>
              <ContextMenu.Item
                disabled={!capabilities.includes("write")}
                onSelect={() => props.onRename(props.resource)}
              >
                <Settings2 size={15} /> 重命名
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item
                className="danger"
                disabled={!capabilities.includes("delete")}
                onSelect={() => props.onTrash(props.resource)}
              >
                <Trash2 size={15} /> 移到回收站
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ResourceIcon(props: { resource: ResourceEntry; size: number }) {
  if (props.resource.type === "project") {
    return <FolderOpen size={props.size} className="project-icon" />;
  }
  if (props.resource.type === "folder") {
    return <Folder size={props.size} className="folder-icon" />;
  }
  if (props.resource.type === "media_file") {
    return <FileVideo2 size={props.size} className="media-icon" />;
  }
  return <FileJson2 size={props.size} className="annotation-icon" />;
}

export function resourceTypeLabel(type: ResourceEntry["type"]) {
  return {
    folder: "文件夹",
    project: "项目",
    annotation_file: "标注文件",
    media_file: "媒体文件",
  }[type];
}

export function formatResourceDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatResourceSize(value?: number | null) {
  if (!value) return "—";
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
