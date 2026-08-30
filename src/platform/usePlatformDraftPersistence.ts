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
  getRemoteBaseRevision: () => number;
  onPersistenceError: (message: string) => void;
  store?: PlatformDraftStore;
};

export type PlatformDraftPersistenceAction = "none" | "put" | "delete";

export type PlatformDraftFlushResult =
  | { ok: true }
  | { ok: false; message: string };

export type PlatformDraftCleanExitRequest = {
  remoteBaseRevision: number;
  recoveryState: ProjectDocumentRecoveryState;
};

export type PlatformDraftCleanExitCheckpoint = {
  userId: string;
  annotationFileId: string;
  remoteBaseRevision: number;
  localRevision: number;
  savedRevision: number;
};

export type PlatformDraftTaskQueue = {
  enqueue: (task: () => Promise<void>) => Promise<void>;
};

// 草稿写队列只接收已经净化并冻结的记录，不能在异步任务真正执行时重新拼接 document refs。
export function capturePlatformDraftWriteRecord(input: {
  userId: string;
  annotationFileId: string;
  remoteBaseRevision: number;
  recoveryState: ProjectDocumentRecoveryState;
  now?: number;
}) {
  // 项目净化函数会保留部分不可变对象引用；这里必须主动克隆，否则后续编辑仍会改写已排队的记录。
  return structuredClone(buildPlatformDraftRecord(input));
}

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

// 生命周期决策保持为纯函数；待确认整合或 transient 编辑暂停时不得误写或删除原恢复草稿。
export function getPlatformDraftPersistenceAction(input: Pick<
  PlatformDraftPersistenceOptions,
  "enabled" | "suspended" | "userId" | "annotationFileId" | "hasUnsavedChanges"
>): PlatformDraftPersistenceAction {
  if (input.suspended || !input.enabled || !input.userId || !input.annotationFileId) {
    return "none";
  }
  return input.hasUnsavedChanges ? "put" : "delete";
}

// 干净退出只接受没有 pending operation 且本地/已保存 revision 完全一致的检查点。
// ProjectData 等价性由 document owner 在调用前验证，这里只负责草稿存储可独立复核的稳定事实。
export function buildPlatformDraftCleanExitCheckpoint(input: {
  userId: string | null;
  annotationFileId: string | null;
  remoteBaseRevision: number;
  recoveryState: ProjectDocumentRecoveryState;
}): PlatformDraftCleanExitCheckpoint | null {
  if (
    !input.userId ||
    !input.annotationFileId ||
    input.recoveryState.pendingOperations.length > 0 ||
    input.recoveryState.localRevision !== input.recoveryState.savedRevision
  ) return null;
  return {
    userId: input.userId,
    annotationFileId: input.annotationFileId,
    remoteBaseRevision: input.remoteBaseRevision,
    localRevision: input.recoveryState.localRevision,
    savedRevision: input.recoveryState.savedRevision,
  };
}

export function doesRecoveryStateMatchCleanExitCheckpoint(
  checkpoint: PlatformDraftCleanExitCheckpoint,
  recoveryState: ProjectDocumentRecoveryState,
) {
  return recoveryState.pendingOperations.length === 0 &&
    recoveryState.localRevision === checkpoint.localRevision &&
    recoveryState.savedRevision === checkpoint.savedRevision;
}

// 平台草稿采用短节流持续写入；页面关闭只依赖已经完成的写入，不把异步 IndexedDB 任务拖到 unload。
export function usePlatformDraftPersistence(options: PlatformDraftPersistenceOptions) {
  const getRecoveryStateRef = useRef(options.getRecoveryState);
  const getRemoteBaseRevisionRef = useRef(options.getRemoteBaseRevision);
  const onPersistenceErrorRef = useRef(options.onPersistenceError);
  const writeQueueRef = useRef<PlatformDraftTaskQueue | null>(null);
  const latestOptionsRef = useRef(options);
  const cleanExitCheckpointRef = useRef<PlatformDraftCleanExitCheckpoint | null>(null);

  getRecoveryStateRef.current = options.getRecoveryState;
  getRemoteBaseRevisionRef.current = options.getRemoteBaseRevision;
  onPersistenceErrorRef.current = options.onPersistenceError;
  latestOptionsRef.current = options;
  const activeCleanExitCheckpoint = cleanExitCheckpointRef.current;
  if (
    activeCleanExitCheckpoint &&
    (
      activeCleanExitCheckpoint.userId !== options.userId ||
      activeCleanExitCheckpoint.annotationFileId !== options.annotationFileId ||
      activeCleanExitCheckpoint.remoteBaseRevision !== options.remoteBaseRevision
    )
  ) {
    // 检查点只能服务创建它的账号、文件和服务器基线，绝不能跨编辑会话抑制草稿。
    cleanExitCheckpointRef.current = null;
  } else if (
    options.hasUnsavedChanges &&
    activeCleanExitCheckpoint &&
    !doesRecoveryStateMatchCleanExitCheckpoint(
      activeCleanExitCheckpoint,
      options.getRecoveryState(),
    )
  ) {
    // 清场后若仍发生编辑，旧检查点立即失效；卸载时必须恢复写入最新草稿。
    cleanExitCheckpointRef.current = null;
  }

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

  // revision 与 recovery state 必须在任务入队前一起冻结；若等 IndexedDB 前序任务完成后再读 refs，
  // 可能把旧 revision 和已经前进的 ProjectData 拼成一个无法安全恢复的草稿。
  const enqueueDraftWrite = (context: PlatformDraftPersistenceOptions): Promise<void> => {
    // 正常决策会先排除身份缺失；显式失败可防止未来调用点把无目标写入误判为成功。
    if (!context.userId || !context.annotationFileId) {
      return Promise.reject(new Error("平台草稿缺少账号或标注文件标识。"));
    }
    const store = context.store ?? platformDraftStore;
    const userId = context.userId;
    const annotationFileId = context.annotationFileId;
    const capturedRecord = capturePlatformDraftWriteRecord({
      userId,
      annotationFileId,
      remoteBaseRevision: getRemoteBaseRevisionRef.current(),
      recoveryState: getRecoveryStateRef.current(),
    });
    return enqueue(async () => {
      const existingValue = await store.get(userId, annotationFileId);
      const existing = normalizePlatformDraftRecord(existingValue, { userId, annotationFileId });
      const record = existing
        ? { ...capturedRecord, createdAt: existing.createdAt }
        : capturedRecord;
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

  const finalizeCleanExit = useCallback(async (
    request: PlatformDraftCleanExitRequest,
  ): Promise<PlatformDraftFlushResult> => {
    const latest = latestOptionsRef.current;
    const checkpoint = buildPlatformDraftCleanExitCheckpoint({
      userId: latest.userId,
      annotationFileId: latest.annotationFileId,
      remoteBaseRevision: request.remoteBaseRevision,
      recoveryState: request.recoveryState,
    });
    if (!latest.enabled || latest.suspended || !checkpoint) {
      return { ok: false, message: "当前文档尚未达到可安全退出的同步状态。" };
    }
    const store = latest.store ?? platformDraftStore;
    cleanExitCheckpointRef.current = checkpoint;
    try {
      // delete 必须排在所有已排队 put 之后；检查点先武装，尚未触发的 debounce timer 也不能在其后复活草稿。
      await enqueue(() => store.delete(checkpoint.userId, checkpoint.annotationFileId));
      const currentRecoveryState = getRecoveryStateRef.current();
      if (!doesRecoveryStateMatchCleanExitCheckpoint(checkpoint, currentRecoveryState)) {
        cleanExitCheckpointRef.current = null;
        // 清场期间出现的新编辑必须在 delete 之后恢复成最新草稿，随后明确拒绝本次退出。
        await enqueueDraftWrite({
          ...latest,
          remoteBaseRevision: request.remoteBaseRevision,
          hasUnsavedChanges: true,
          localRevision: currentRecoveryState.localRevision,
        });
        return { ok: false, message: "清理恢复草稿期间检测到新的编辑，已保留最新草稿。" };
      }
      return { ok: true };
    } catch (error) {
      cleanExitCheckpointRef.current = null;
      return {
        ok: false,
        message: error instanceof Error ? error.message : "浏览器恢复草稿清理失败。",
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
      if (cleanExitCheckpointRef.current) return;
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
    const cleanExitCheckpoint = cleanExitCheckpointRef.current;
    if (
      cleanExitCheckpoint &&
      cleanExitCheckpoint.userId === latest.userId &&
      cleanExitCheckpoint.annotationFileId === latest.annotationFileId &&
      doesRecoveryStateMatchCleanExitCheckpoint(
        cleanExitCheckpoint,
        getRecoveryStateRef.current(),
      )
    ) {
      return;
    }
    // 返回资源管理器会卸载编辑器；立即排入最后草稿，不能因 debounce timer 被清理而漏掉最近编辑。
    if (getPlatformDraftPersistenceAction(latest) === "put") {
      void enqueueDraftWrite(latest).catch(() => undefined);
    }
  }, []);

  return { flushNow, finalizeCleanExit };
}
