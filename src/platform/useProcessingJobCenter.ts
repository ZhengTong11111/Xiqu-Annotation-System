import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlatformUser,
  ProcessingJobDetail,
  ProcessingJobPage,
  ProcessingJobRequestListItem,
  ProcessingJobScope,
  ProcessingJobStatus,
  ProcessingJobSummary,
  ProcessingJobType,
} from "@xiqu/shared";
import { hasFullPlatformResourceAccess } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { createRuntimeUuid } from "../utils/runtimeUuid";
import {
  getActiveProcessingJobCount,
  getProcessingJobPollInterval,
} from "./processingJobCenterModel";

const EMPTY_PAGE: ProcessingJobPage = { items: [], nextCursor: null };

export function useProcessingJobCenter(input: {
  client: PlatformClient;
  user: PlatformUser | null;
  open: boolean;
}) {
  const [scope, setScope] = useState<ProcessingJobScope>("mine");
  const [status, setStatus] = useState<ProcessingJobStatus | "">("");
  const [type, setType] = useState<ProcessingJobType | "">("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<ProcessingJobSummary | null>(null);
  const [page, setPage] = useState<ProcessingJobPage>(EMPTY_PAGE);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProcessingJobDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const listGenerationRef = useRef(0);
  const moreInFlightRef = useRef(false);
  const moreAbortRef = useRef<AbortController | null>(null);
  const commandInFlightRef = useRef(false);
  const retryableCommandRef = useRef<{ key: string; id: string } | null>(null);

  const activeCount = getActiveProcessingJobCount(summary);
  const activeCountRef = useRef(activeCount);
  activeCountRef.current = activeCount;
  const selectedItem = useMemo(
    () => page.items.find(({ requestId }) => requestId === selectedRequestId) ?? null,
    [page.items, selectedRequestId],
  );
  const selectedJobId = selectedItem?.job.id ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // 页面恢复可见或网络恢复时只递增一个刷新代际；列表与摘要仍由各自 single-flight effect 权威读取。
  useEffect(() => {
    const refreshWhenUsable = () => {
      if (!document.hidden && navigator.onLine) setRefreshVersion((value) => value + 1);
    };
    const handleOnline = () => {
      setOnline(true);
      refreshWhenUsable();
    };
    const handleOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", refreshWhenUsable);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenUsable);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Workspace 不会因退出登录而卸载；账号代际切换必须清掉管理员范围和模糊命令重试身份。
  useEffect(() => {
    retryableCommandRef.current = null;
    setCommandError(null);
    if (input.user && !hasFullPlatformResourceAccess(input.user.roles)) setScope("mine");
  }, [input.user?.id]);

  // mine summary 是顶部 badge 的唯一来源；关闭面板后继续低频刷新，但 hidden/offline 时不制造请求。
  useEffect(() => {
    if (!input.user) {
      setSummary(null);
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (disposed) return;
      let nextActiveCount = activeCountRef.current;
      if (!document.hidden && navigator.onLine) {
        const controller = new AbortController();
        activeController = controller;
        try {
          const next = await input.client.getProcessingJobSummary("mine", controller.signal);
          if (!disposed) {
            setSummary(next);
            nextActiveCount = getActiveProcessingJobCount(next);
          }
        } catch (nextError) {
          // 摘要是辅助状态；列表会展示可操作错误，badge 请求失败不能覆盖已有权威数字或制造全局报错。
          if (!isAbortError(nextError)) {
            nextActiveCount = activeCountRef.current;
          }
        } finally {
          if (activeController === controller) activeController = null;
        }
      }
      if (!disposed) {
        timer = window.setTimeout(refresh, getProcessingJobPollInterval(input.open, nextActiveCount));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      activeController?.abort();
      moreAbortRef.current?.abort();
      moreAbortRef.current = null;
      moreInFlightRef.current = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [input.client, input.open, input.user, refreshVersion]);

  // 打开面板后定期替换第一页；筛选和账号变化都会废弃旧代际，迟到响应不能串入新视图。
  useEffect(() => {
    const generation = ++listGenerationRef.current;
    // 筛选、账号或可见性代际改变时，旧分页读取已经失去业务价值，应立即释放网络和服务端读取资源。
    moreAbortRef.current?.abort();
    moreAbortRef.current = null;
    moreInFlightRef.current = false;
    setMoreLoading(false);
    setSelectedRequestId(null);
    setDetail(null);
    setCommandError(null);
    if (!input.open || !input.user) {
      setPage(EMPTY_PAGE);
      setListLoading(false);
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (disposed) return;
      if (!document.hidden && navigator.onLine) {
        const controller = new AbortController();
        activeController = controller;
        setListLoading(true);
        try {
          const next = await input.client.listProcessingJobs({
            scope,
            status: status || undefined,
            type: type || undefined,
            query: query || undefined,
            limit: 50,
          }, controller.signal);
          if (!disposed && listGenerationRef.current === generation) {
            setPage(next);
            setError(null);
          }
        } catch (nextError) {
          if (!isAbortError(nextError) && !disposed && listGenerationRef.current === generation) {
            setError(describeError(nextError));
          }
        } finally {
          if (activeController === controller) activeController = null;
          if (!disposed && listGenerationRef.current === generation) setListLoading(false);
        }
      }
      if (!disposed) {
        timer = window.setTimeout(refresh, getProcessingJobPollInterval(true, activeCountRef.current));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      activeController?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [input.client, input.open, input.user, query, refreshVersion, scope, status, type]);

  useEffect(() => {
    if (!input.open || !selectedJobId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (!document.hidden && navigator.onLine) {
        const controller = new AbortController();
        activeController = controller;
        setDetailLoading(true);
        try {
          const next = await input.client.getProcessingJob(selectedJobId, controller.signal);
          if (!disposed) {
            setDetail(next);
            setCommandError(null);
          }
        } catch (nextError) {
          if (!isAbortError(nextError) && !disposed) setCommandError(describeError(nextError));
        } finally {
          if (activeController === controller) activeController = null;
          if (!disposed) setDetailLoading(false);
        }
      }
      if (!disposed) {
        timer = window.setTimeout(refresh, getProcessingJobPollInterval(true, activeCountRef.current));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      activeController?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [input.client, input.open, refreshVersion, selectedJobId]);

  const loadMore = useCallback(async () => {
    if (!input.user || !page.nextCursor || moreInFlightRef.current) return;
    moreInFlightRef.current = true;
    setMoreLoading(true);
    const generation = listGenerationRef.current;
    const controller = new AbortController();
    moreAbortRef.current = controller;
    try {
      const next = await input.client.listProcessingJobs({
        scope,
        status: status || undefined,
        type: type || undefined,
        query: query || undefined,
        cursor: page.nextCursor,
        limit: 50,
      }, controller.signal);
      if (generation !== listGenerationRef.current) return;
      setPage((current) => ({
        items: mergeRequestItems(current.items, next.items),
        nextCursor: next.nextCursor,
      }));
      setError(null);
    } catch (nextError) {
      if (!isAbortError(nextError) && generation === listGenerationRef.current) {
        setError(describeError(nextError));
      }
    } finally {
      if (moreAbortRef.current === controller) {
        moreAbortRef.current = null;
        moreInFlightRef.current = false;
        setMoreLoading(false);
      }
    }
  }, [input.client, input.user, page.nextCursor, query, scope, status, type]);

  const executeCommand = useCallback(async (
    action: "cancel" | "force-cancel" | "retry",
    item: ProcessingJobRequestListItem,
  ) => {
    if (commandInFlightRef.current) return false;
    commandInFlightRef.current = true;
    setCommandBusy(true);
    setCommandError(null);
    const key = `${action}:${action === "force-cancel" ? item.job.id : item.requestId}`;
    const existing = retryableCommandRef.current;
    const clientCommandId = existing?.key === key ? existing.id : createRuntimeUuid();
    retryableCommandRef.current = { key, id: clientCommandId };
    try {
      if (action === "cancel") {
        await input.client.cancelProcessingJobRequest(item.requestId, { clientCommandId });
      } else if (action === "force-cancel") {
        await input.client.forceCancelProcessingJob(item.job.id, { clientCommandId });
      } else {
        await input.client.retryProcessingJobRequest(item.requestId, { clientCommandId });
      }
      retryableCommandRef.current = null;
      setRefreshVersion((value) => value + 1);
      return true;
    } catch (nextError) {
      // 模糊失败保留同一 UUID；用户再次提交同一动作时精确重放，不能生成第二个重试执行。
      setCommandError(describeError(nextError));
      return false;
    } finally {
      commandInFlightRef.current = false;
      setCommandBusy(false);
    }
  }, [input.client]);

  return {
    scope,
    setScope,
    status,
    setStatus,
    type,
    setType,
    queryInput,
    setQueryInput,
    summary,
    activeCount,
    page,
    selectedItem,
    selectedRequestId,
    setSelectedRequestId,
    detail,
    listLoading,
    moreLoading,
    detailLoading,
    commandBusy,
    error,
    commandError,
    online,
    isAdministrator: Boolean(
      input.user && hasFullPlatformResourceAccess(input.user.roles),
    ),
    refresh: () => setRefreshVersion((value) => value + 1),
    loadMore,
    executeCommand,
  };
}

export type ProcessingJobCenterController = ReturnType<typeof useProcessingJobCenter>;

function mergeRequestItems(
  current: ProcessingJobRequestListItem[],
  incoming: ProcessingJobRequestListItem[],
) {
  const seen = new Set(current.map(({ requestId }) => requestId));
  return [...current, ...incoming.filter(({ requestId }) => !seen.has(requestId))];
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "后台任务请求失败。";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
