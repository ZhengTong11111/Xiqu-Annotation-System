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
import {
  appendColumnPage,
  createEmptyColumnPageState,
  failColumnAppend,
  replaceColumnPage,
  type ResourceColumnPageState,
} from "./resourceColumnPageState";

export type LoadedResourceColumn = ResourceColumnDescriptor & {
  items: ResourceEntry[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
};

type ColumnData = ResourceColumnPageState;

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
  const dataByKeyRef = useRef(dataByKey);
  dataByKeyRef.current = dataByKey;

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

  const loadMore = useCallback(async (columnKey: string) => {
    const current = dataByKeyRef.current[columnKey];
    const descriptor = descriptors.find(({ key }) => key === columnKey);
    if (
      !current ||
      !descriptor ||
      !current.nextCursor ||
      current.loading ||
      current.loadingMore
    ) return;

    // 下一页请求绑定当前整组列的 generation；路径、搜索或排序改变后，旧响应不得写入新列。
    const generation = requestGenerationRef.current;
    const cursor = current.nextCursor;
    setDataByKey((state) => ({
      ...state,
      [columnKey]: {
        ...state[columnKey]!,
        loadingMore: true,
        loadMoreError: null,
      },
    }));
    try {
      const columnIndex = descriptors.findIndex(({ key }) => key === columnKey);
      const page = await options.client.listResources({
        parentId: descriptor.parentId,
        view: descriptor.view,
        query: columnIndex === descriptors.length - 1
          ? options.query || undefined
          : undefined,
        sortBy: options.sortBy,
        direction: options.direction,
        cursor,
        limit: 200,
      });
      if (generation !== requestGenerationRef.current) return;
      setDataByKey((state) => {
        const latest = state[columnKey];
        if (!latest || latest.nextCursor !== cursor) return state;
        return { ...state, [columnKey]: appendColumnPage(latest, page) };
      });
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      setDataByKey((state) => {
        const latest = state[columnKey];
        return latest
          ? { ...state, [columnKey]: failColumnAppend(latest, describeColumnError(error)) }
          : state;
      });
    }
  }, [
    descriptors,
    options.client,
    options.direction,
    options.query,
    options.sortBy,
  ]);

  useEffect(() => {
    // 入口视图变化后，旧路径不再具有同一语义。例如“收藏”中的路径不能带进“回收站”。
    setDescriptors([createRootResourceColumn(options.rootView)]);
  }, [options.rootView]);

  useEffect(() => {
    if (!options.enabled) return;
    const generation = ++requestGenerationRef.current;
    setDataByKey((current) => Object.fromEntries(descriptors.map((column) => {
      const existing = current[column.key] ?? createEmptyColumnPageState();
      return [column.key, {
        ...existing,
        loading: true,
        loadingMore: false,
        error: null,
        loadMoreError: null,
      }];
    })));

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
        return { key: column.key, page, error: null };
      } catch (error) {
        return {
          key: column.key,
          page: null,
          error: describeColumnError(error),
        };
      }
    })).then((results) => {
      // 快速点击上游目录会并发产生旧路径请求；只允许最新一代结果整体写回。
      if (generation !== requestGenerationRef.current) return;
      const nextData = Object.fromEntries(results.map((result) => [
        result.key,
        result.page
          ? replaceColumnPage(result.page)
          : {
            ...createEmptyColumnPageState(),
            loading: false,
            error: result.error,
          },
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
        new Set(Object.entries(nextData)
          .filter(([, value]) => Boolean(value.nextCursor))
          .map(([key]) => key)),
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
      nextCursor: dataByKey[descriptor.key]?.nextCursor ?? null,
      loading: dataByKey[descriptor.key]?.loading ?? true,
      loadingMore: dataByKey[descriptor.key]?.loadingMore ?? false,
      error: dataByKey[descriptor.key]?.error ?? null,
      loadMoreError: dataByKey[descriptor.key]?.loadMoreError ?? null,
    }),
  ), [dataByKey, descriptors]);

  return {
    columns,
    locationParentId: getColumnLocationParentId(descriptors),
    loadMore,
    openResource,
    refreshVisibleColumns,
    resetToBreadcrumbs,
    truncateAfter,
  };
}

function describeColumnError(error: unknown) {
  return error instanceof Error ? error.message : "无法读取这一列。";
}
