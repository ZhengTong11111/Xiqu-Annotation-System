import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import type { ResourceEntry } from "@xiqu/shared";

const RESOURCE_DRAG_KIND = "xiqu-resource-selection";

type ResourceDragData = {
  kind: typeof RESOURCE_DRAG_KIND;
  resourceIds: string[];
  parentIds: Array<string | null>;
  primaryName: string;
};

export function registerResourceDraggable(options: {
  element: HTMLElement;
  getResources: () => ResourceEntry[];
  disabled: () => boolean;
  onDragStart: (resourceIds: string[]) => void;
  onDragFinish: () => void;
}) {
  return draggable({
    element: options.element,
    canDrag: () => {
      const resources = options.getResources();
      return !options.disabled() &&
        resources.length > 0 &&
        resources.every(({ permission }) =>
          permission.capabilities.includes("move"));
    },
    getInitialData: () => buildResourceDragData(options.getResources()),
    onGenerateDragPreview: ({ nativeSetDragImage, source }) => {
      const dragData = parseResourceDragData(source.data);
      if (!dragData) return;
      setCustomNativeDragPreview({
        nativeSetDragImage,
        render: ({ container }) => {
          const preview = document.createElement("div");
          preview.className = "resource-native-drag-preview";
          preview.textContent = dragData.resourceIds.length > 1
            ? `${dragData.primaryName}  +${dragData.resourceIds.length - 1}`
            : dragData.primaryName;
          container.append(preview);
          return () => preview.remove();
        },
      });
    },
    onDragStart: ({ source }) => {
      const dragData = parseResourceDragData(source.data);
      if (dragData) options.onDragStart(dragData.resourceIds);
    },
    onDrop: options.onDragFinish,
  });
}

export function registerResourceDropTarget(options: {
  element: HTMLElement;
  targetId: string;
  canCreateChild: () => boolean;
  disabled: () => boolean;
  onActiveChange: (active: boolean) => void;
  onDrop: (resourceIds: string[], targetId: string) => void;
}) {
  const canDrop = (data: Record<string | symbol, unknown>) => {
    const dragData = parseResourceDragData(data);
    if (!dragData || options.disabled() || !options.canCreateChild()) {
      return false;
    }
    if (dragData.resourceIds.includes(options.targetId)) return false;
    // 全部资源已在目标内时属于 no-op；混合来源仍交给原子批量 API 区分 moved/unchanged。
    return !dragData.parentIds.every((parentId) => parentId === options.targetId);
  };

  return combine(
    dropTargetForElements({
      element: options.element,
      canDrop: ({ source }) => canDrop(source.data),
      getDropEffect: () => "move",
      onDragEnter: () => options.onActiveChange(true),
      onDragLeave: () => options.onActiveChange(false),
      onDrop: ({ source }) => {
        options.onActiveChange(false);
        const dragData = parseResourceDragData(source.data);
        if (dragData && canDrop(source.data)) {
          options.onDrop(dragData.resourceIds, options.targetId);
        }
      },
    }),
    () => options.onActiveChange(false),
  );
}

function buildResourceDragData(resources: ResourceEntry[]): ResourceDragData {
  return {
    kind: RESOURCE_DRAG_KIND,
    resourceIds: resources.map(({ id }) => id),
    parentIds: resources.map(({ parentId }) => parentId ?? null),
    primaryName: resources[0]?.name ?? "资源",
  };
}

function parseResourceDragData(
  value: Record<string | symbol, unknown>,
): ResourceDragData | null {
  if (
    value.kind !== RESOURCE_DRAG_KIND ||
    !Array.isArray(value.resourceIds) ||
    value.resourceIds.some((id) => typeof id !== "string") ||
    !Array.isArray(value.parentIds) ||
    value.parentIds.some((id) => id !== null && typeof id !== "string") ||
    typeof value.primaryName !== "string"
  ) return null;
  return value as ResourceDragData;
}
