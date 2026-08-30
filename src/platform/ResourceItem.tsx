import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronRight,
  Check,
  Copy,
  Download,
  FileJson2,
  Files,
  FileVideo2,
  Folder,
  FolderInput,
  FolderOpen,
  ListChecks,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { AnnotationWorkflowStatus, ResourceEntry } from "@xiqu/shared";
import {
  registerResourceDraggable,
  registerResourceDropTarget,
} from "./resourceDragAndDrop";
import { isResourceContainer } from "./resourceColumnModel";
import {
  ANNOTATION_WORKFLOW_STATUS_OPTIONS,
  annotationWorkflowStatusLabel,
  getAnnotationWorkflowCommandState,
  resourceResponsibleLabel,
  resourceWorkflowStatus,
} from "./annotationWorkflow";

export type ResourceItemDisplayMode = "list" | "grid" | "column";

export function ResourceItem(props: {
  resource: ResourceEntry;
  displayMode: ResourceItemDisplayMode;
  isSelected: boolean;
  isPathSelected?: boolean;
  isDragging: boolean;
  interactionDisabled: boolean;
  isTrashView: boolean;
  canTrashSelection?: boolean;
  canCompareSelection?: boolean;
  getDragResources: () => ResourceEntry[];
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
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  onCompare: (resource: ResourceEntry) => void;
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

  // 详细列表沿用既有 `.resource-list-row` 网格布局；新增状态列后仍由共享资源项统一输出六列。
  const displayClassName = props.displayMode === "list"
    ? "resource-list-row"
    : `resource-${props.displayMode}-item`;
  const className = [
    displayClassName,
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
            <span>{resourceResponsibleLabel(props.resource)}</span>
            <ResourceWorkflowStatusBadge resource={props.resource} compact />
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
            <span>{resourceTypeLabel(props.resource)}</span>
            <span>{formatResourceDate(props.resource.updatedAt)}</span>
            <span>{resourceResponsibleLabel(props.resource)}</span>
            <span><ResourceWorkflowStatusBadge resource={props.resource} /></span>
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
  canTrashSelection?: boolean;
  canCompareSelection?: boolean;
  children: ReactNode;
  onOpen: (resource: ResourceEntry) => void;
  onRename: (resource: ResourceEntry) => void;
  onCopy: (resource: ResourceEntry) => void;
  onMove: (resource: ResourceEntry) => void;
  onDownload: (resource: ResourceEntry) => void;
  onRequestWorkflowStatus: (
    resource: ResourceEntry,
    status: AnnotationWorkflowStatus,
  ) => void;
  onRestore: (resource: ResourceEntry) => void;
  onTrash: (resource: ResourceEntry) => void;
  onCompare: (resource: ResourceEntry) => void;
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
              {/* 比较入口只在当前整组选中项恰好构成两个可读标注文件时出现。 */}
              {props.canCompareSelection ? (
                <ContextMenu.Item onSelect={() => props.onCompare(props.resource)}>
                  <Files size={15} /> 比较标注文件
                </ContextMenu.Item>
              ) : null}
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
              {props.resource.type === "annotation_file" ||
              props.resource.type === "media_file" ? (
                <ContextMenu.Item
                  disabled={!canDirectlyDownloadResource(props.resource)}
                  title={props.resource.type === "media_file" &&
                    props.resource.mediaSourceType === "aliyun_vod"
                    ? "阿里云 VOD 不提供平台原文件下载"
                    : undefined}
                  onSelect={() => props.onDownload(props.resource)}
                >
                  <Download size={15} /> 下载
                </ContextMenu.Item>
              ) : null}
              <ContextMenu.Item
                disabled={!capabilities.includes("write")}
                onSelect={() => props.onRename(props.resource)}
              >
                <Settings2 size={15} /> 重命名
              </ContextMenu.Item>
              {props.resource.type === "annotation_file" ? (
                <AnnotationWorkflowStatusMenu
                  resource={props.resource}
                  onRequest={props.onRequestWorkflowStatus}
                />
              ) : null}
              <ContextMenu.Separator />
              <ContextMenu.Item
                className="danger"
                disabled={props.canTrashSelection === false ||
                  !capabilities.includes("delete")}
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

function AnnotationWorkflowStatusMenu(props: {
  resource: ResourceEntry;
  onRequest: (resource: ResourceEntry, status: AnnotationWorkflowStatus) => void;
}) {
  const current = props.resource.workflowStatus ?? "unannotated";
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="resource-context-subtrigger">
        <ListChecks size={15} /> 标注状态
        <ChevronRight size={14} className="resource-context-subtrigger-arrow" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="resource-context-menu">
          <ContextMenu.RadioGroup value={current}>
            {ANNOTATION_WORKFLOW_STATUS_OPTIONS.map((option) => {
              const commandState = getAnnotationWorkflowCommandState(
                current,
                option.value,
                props.resource.permission.capabilities,
              );
              const disabled = commandState === "forbidden";
              return (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  disabled={disabled}
                  title={disabled
                    ? option.value === "reviewed"
                      ? "需要该文件的审核权限"
                      : "需要该文件的编辑或审核权限"
                    : undefined}
                  onSelect={() => {
                    if (commandState !== "current") {
                      props.onRequest(props.resource, option.value);
                    }
                  }}
                >
                  <span className="resource-context-radio-indicator">
                    <ContextMenu.ItemIndicator><Check size={13} /></ContextMenu.ItemIndicator>
                  </span>
                  {option.label}
                </ContextMenu.RadioItem>
              );
            })}
          </ContextMenu.RadioGroup>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export function ResourceWorkflowStatusBadge(props: {
  resource: ResourceEntry;
  compact?: boolean;
}) {
  const status = resourceWorkflowStatus(props.resource);
  if (!status) return <span className="resource-workflow-empty">—</span>;
  return (
    <span
      className={`resource-workflow-status ${status}${props.compact ? " compact" : ""}`}
      title={annotationWorkflowStatusLabel(status)}
      aria-label={`状态：${annotationWorkflowStatusLabel(status)}`}
    >
      {props.compact ? null : annotationWorkflowStatusLabel(status)}
    </span>
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

export function resourceTypeLabel(resource: ResourceEntry) {
  if (resource.type === "media_file") {
    const kind = resource.mediaKind === "audio" ? "音频" : "视频";
    return resource.mediaSourceType === "aliyun_vod"
      ? `VOD ${kind}`
      : kind;
  }
  return {
    folder: "文件夹",
    project: "项目",
    annotation_file: "标注文件",
  }[resource.type];
}

// 外部 VOD 的 download 权限仍用于授权播放，但它没有平台可直接下载的原始对象。
export function canDirectlyDownloadResource(resource: ResourceEntry) {
  return resource.permission.capabilities.includes("download") &&
    (resource.type === "annotation_file" ||
      (resource.type === "media_file" && resource.mediaSourceType !== "aliyun_vod"));
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
