import { useCallback, useEffect, useRef } from "react";
import type { ProjectDocumentRecoveryState } from "../state/projectDocumentState";
import {
  arePlatformDraftContentsEqual,
  buildPlatformDraftRecord,
  normalizePlatformDraftRecord,
} from "./platformDraft";
import { platformDraftStore, type PlatformDraftStore } from "./platformDraftStore";

const DRAFT_WRITE_DELAY_MS = 700;

type PlatformDraftPersistenceOptions = {
  enabled: boolean;
  suspended: boolean;
  userId: string | null;
  annotationFileId: string | null;
  remoteBaseRevision: number;
  hasUnsavedChanges: boolean;
  localRevision: number;
  pendingOperationSignature: string;
  getRecoveryState: () => ProjectDocumentRecoveryState;
  onPersistenceError: (message: string) => void;
  store?: PlatformDraftStore;
};

export type PlatformDraftPersistenceAction = "none" | "put" | "delete";

export type PlatformDraftFlushResult =
  | { ok: true }
  | { ok: false; message: string };

export type PlatformDraftTaskQueue = {
  enqueue: (task: () => Promise<void>) => Promise<void>;
};

// 草稿任务严格串行；调用者可等待自己的 execution，而队列会报告失败并继续接收后续任务。
export function createPlatformDraftTaskQueue(
  onError: (error: unknown) => void,
): PlatformDraftTaskQueue {
  let tail = Promise.resolve();
  return {
    enqueue(task) {
      const execution = tail.catch(() => undefined).then(task);
      tail = execution.catch(onError);
      return execution;
    },
  };
}

// 生命周期决策保持为纯函数，待确认整合暂停时不得误写或删除原恢复草稿。
export function getPlatformDraftPersistenceAction(input: Pick<
  PlatformDraftPersistenceOptions,
  "enabled" | "suspended" | "userId" | "annotationFileId" | "hasUnsavedChanges"
>): PlatformDraftPersistenceAction {
  if (input.suspended || !input.enabled || !input.userId || !input.annotationFileId) {
    return "none";
  }
  return input.hasUnsavedChanges ? "put" : "delete";
}

// 平台草稿采用短节流持续写入；页面关闭只依赖已经完成的写入，不把异步 IndexedDB 任务拖到 unload。
export function usePlatformDraftPersistence(options: PlatformDraftPersistenceOptions) {
  const getRecoveryStateRef = useRef(options.getRecoveryState);
  const onPersistenceErrorRef = useRef(options.onPersistenceError);
  const writeQueueRef = useRef<PlatformDraftTaskQueue | null>(null);
  const latestOptionsRef = useRef(options);

  getRecoveryStateRef.current = options.getRecoveryState;
  onPersistenceErrorRef.current = options.onPersistenceError;
  latestOptionsRef.current = options;

  // 队列只创建一次，但错误处理通过 ref 始终调用当前会话回调。
  if (writeQueueRef.current === null) {
    writeQueueRef.current = createPlatformDraftTaskQueue((error) => {
      const message = error instanceof Error ? error.message : "浏览器草稿存储失败。";
      console.error("平台草稿持久化失败", error);
      onPersistenceErrorRef.current(message);
    });
  }

  // 写队列跨 render 保持顺序；失败只报告本次任务，下一次写入仍可继续尝试。
  const enqueue = (task: () => Promise<void>) => {
    return writeQueueRef.current!.enqueue(task);
  };

  // debounce、删除和卸载写入没有显式调用者等待结果；错误已由队列统一上报，这里只避免未处理 rejection。
  const enqueueInBackground = (task: () => Promise<void>) => {
    void enqueue(task).catch(() => undefined);
  };

  // 单次写入在执行时读取最新 document refs，并保留首份草稿创建时间。
  const enqueueDraftWrite = (context: PlatformDraftPersistenceOptions): Promise<void> => {
    // 正常决策会先排除身份缺失；显式失败可防止未来调用点把无目标写入误判为成功。
    if (!context.userId || !context.annotationFileId) {
      return Promise.reject(new Error("平台草稿缺少账号或标注文件标识。"));
    }
    const store = context.store ?? platformDraftStore;
    const userId = context.userId;
    const annotationFileId = context.annotationFileId;
    return enqueue(async () => {
      const existingValue = await store.get(userId, annotationFileId);
      const existing = normalizePlatformDraftRecord(existingValue, { userId, annotationFileId });
      const record = buildPlatformDraftRecord({
        userId,
        annotationFileId,
        remoteBaseRevision: context.remoteBaseRevision,
        recoveryState: getRecoveryStateRef.current(),
        createdAt: existing?.createdAt,
      });
      // flush 与紧随其后的卸载捕获可能读取同一状态；内容去重保留首次写入时间，真实后续编辑仍会形成新记录。
      if (existing && arePlatformDraftContentsEqual(existing, record)) return;
      await store.put(record);
    });
  };

  // 冲突导航必须等待同一队列中的最新草稿写完，不能另开 store.put 与 debounce 任务竞速。
  const flushNow = useCallback(async (): Promise<PlatformDraftFlushResult> => {
    const latest = latestOptionsRef.current;
    if (getPlatformDraftPersistenceAction(latest) !== "put") {
      return { ok: false, message: "当前会话没有可写入的未保存平台草稿。" };
    }
    try {
      await enqueueDraftWrite(latest);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "浏览器草稿存储失败。",
      };
    }
  }, []);

  useEffect(() => {
    const action = getPlatformDraftPersistenceAction(options);
    if (action === "none" || !options.userId || !options.annotationFileId) return;
    const store = options.store ?? platformDraftStore;
    const userId = options.userId;
    const annotationFileId = options.annotationFileId;

    // clean 只可能来自初始服务器文件或确认成功的完整保存，此时应清除已经被服务器覆盖的草稿。
    if (action === "delete") {
      enqueueInBackground(() => store.delete(userId, annotationFileId));
      return;
    }

    // dirty 编辑延迟合并为一份 envelope；timer 触发时再读 refs，保存用户最后一次操作后的项目。
    const timer = window.setTimeout(() => {
      void enqueueDraftWrite(options).catch(() => undefined);
    }, DRAFT_WRITE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    options.annotationFileId,
    options.enabled,
    options.hasUnsavedChanges,
    options.localRevision,
    options.pendingOperationSignature,
    options.remoteBaseRevision,
    options.suspended,
    options.store,
    options.userId,
  ]);

  useEffect(() => () => {
    const latest = latestOptionsRef.current;
    // 返回资源管理器会卸载编辑器；立即排入最后草稿，不能因 debounce timer 被清理而漏掉最近编辑。
    if (getPlatformDraftPersistenceAction(latest) === "put") {
      void enqueueDraftWrite(latest).catch(() => undefined);
    }
  }, []);

  return { flushNow };
}
