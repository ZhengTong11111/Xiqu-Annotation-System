import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ResourceBreadcrumb,
  ResourceEntry,
  ResourceListView,
  ResourceSortField,
  SortDirection,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  buildResourceColumnPath,
  createRootResourceColumn,
  getColumnLocationParentId,
  getValidResourceColumnPathLength,
  truncateResourceColumnPath,
  updateResourceColumnPath,
  type ResourceColumnDescriptor,
} from "./resourceColumnModel";

export type LoadedResourceColumn = ResourceColumnDescriptor & {
  items: ResourceEntry[];
  loading: boolean;
  error: string | null;
};

type ColumnData = Pick<LoadedResourceColumn, "items" | "loading" | "error">;

export function useResourceColumns(options: {
  client: PlatformClient;
  enabled: boolean;
  rootView: ResourceListView;
  query: string;
  sortBy: ResourceSortField;
  direction: SortDirection;
}) {
  const [descriptors, setDescriptors] = useState<ResourceColumnDescriptor[]>([
    createRootResourceColumn(options.rootView),
  ]);
  const [dataByKey, setDataByKey] = useState<Record<string, ColumnData>>({});
  const [refreshRevision, setRefreshRevision] = useState(0);
  const requestGenerationRef = useRef(0);

  const resetToBreadcrumbs = useCallback((breadcrumbs: ResourceBreadcrumb[]) => {
    setDescriptors(buildResourceColumnPath(options.rootView, breadcrumbs));
  }, [options.rootView]);

  const openResource = useCallback((
    columnIndex: number,
    resource: Pick<ResourceEntry, "id" | "type">,
  ) => {
    setDescriptors((current) =>
      updateResourceColumnPath(current, columnIndex, resource));
  }, []);

  const truncateAfter = useCallback((columnIndex: number) => {
    setDescriptors((current) =>
      truncateResourceColumnPath(current, columnIndex));
  }, []);

  const refreshVisibleColumns = useCallback(() => {
    setRefreshRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    // 入口视图变化后，旧路径不再具有同一语义。例如“收藏”中的路径不能带进“回收站”。
    setDescriptors([createRootResourceColumn(options.rootView)]);
  }, [options.rootView]);

  useEffect(() => {
    if (!options.enabled) return;
    const generation = ++requestGenerationRef.current;
    setDataByKey((current) => Object.fromEntries(descriptors.map((column) => [
      column.key,
      {
        items: current[column.key]?.items ?? [],
        loading: true,
        error: null,
      },
    ])));

    void Promise.all(descriptors.map(async (column, index) => {
      try {
        const page = await options.client.listResources({
          parentId: column.parentId,
          view: column.view,
          // 搜索只作用于当前最右列。若过滤祖先列，会让路径容器暂时消失并被误判为已移动。
          query: index === descriptors.length - 1
            ? options.query || undefined
            : undefined,
          sortBy: options.sortBy,
          direction: options.direction,
          limit: 200,
        });
        return { key: column.key, items: page.items, error: null };
      } catch (error) {
        return {
          key: column.key,
          items: [] as ResourceEntry[],
          error: describeColumnError(error),
        };
      }
    })).then((results) => {
      // 快速点击上游目录会并发产生旧路径请求；只允许最新一代结果整体写回。
      if (generation !== requestGenerationRef.current) return;
      const nextData = Object.fromEntries(results.map((result) => [
        result.key,
        { items: result.items, loading: false, error: result.error },
      ]));
      setDataByKey(nextData);

      // mutation 后路径容器可能已被移动或删除。只保留仍能从左列找到打开者的连续路径，
      // 防止右侧继续展示已经不可达的旧目录。
      const validLength = getValidResourceColumnPathLength(
        descriptors,
        Object.fromEntries(Object.entries(nextData).map(([key, value]) => [
          key,
          value.items,
        ])),
        new Set(results.filter(({ error }) => error).map(({ key }) => key)),
      );
      if (validLength < descriptors.length) {
        setDescriptors((current) => current.slice(0, validLength));
      }
    });

    return () => {
      if (generation === requestGenerationRef.current) {
        requestGenerationRef.current += 1;
      }
    };
  }, [
    descriptors,
    options.client,
    options.direction,
    options.enabled,
    options.query,
    options.sortBy,
    refreshRevision,
  ]);

  const columns = useMemo<LoadedResourceColumn[]>(() => descriptors.map(
    (descriptor) => ({
      ...descriptor,
      items: dataByKey[descriptor.key]?.items ?? [],
      loading: dataByKey[descriptor.key]?.loading ?? true,
      error: dataByKey[descriptor.key]?.error ?? null,
    }),
  ), [dataByKey, descriptors]);

  return {
    columns,
    locationParentId: getColumnLocationParentId(descriptors),
    openResource,
    refreshVisibleColumns,
    resetToBreadcrumbs,
    truncateAfter,
  };
}

function describeColumnError(error: unknown) {
  return error instanceof Error ? error.message : "无法读取这一列。";
}
