import { useEffect, useRef } from "react";
import type { ProjectDocumentRecoveryState } from "../state/projectDocumentState";
import {
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
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestOptionsRef = useRef(options);

  getRecoveryStateRef.current = options.getRecoveryState;
  onPersistenceErrorRef.current = options.onPersistenceError;
  latestOptionsRef.current = options;

  // 写队列跨 render 保持顺序；失败只报告本次任务，下一次写入仍可继续尝试。
  const enqueue = (task: () => Promise<void>) => {
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(task)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "浏览器草稿存储失败。";
        console.error("平台草稿持久化失败", error);
        onPersistenceErrorRef.current(message);
      });
  };

  // 单次写入在执行时读取最新 document refs，并保留首份草稿创建时间。
  const enqueueDraftWrite = (context: PlatformDraftPersistenceOptions) => {
    if (!context.userId || !context.annotationFileId) return;
    const store = context.store ?? platformDraftStore;
    const userId = context.userId;
    const annotationFileId = context.annotationFileId;
    enqueue(async () => {
      const existingValue = await store.get(userId, annotationFileId);
      const existing = normalizePlatformDraftRecord(existingValue, { userId, annotationFileId });
      const record = buildPlatformDraftRecord({
        userId,
        annotationFileId,
        remoteBaseRevision: context.remoteBaseRevision,
        recoveryState: getRecoveryStateRef.current(),
        createdAt: existing?.createdAt,
      });
      await store.put(record);
    });
  };

  useEffect(() => {
    const action = getPlatformDraftPersistenceAction(options);
    if (action === "none" || !options.userId || !options.annotationFileId) return;
    const store = options.store ?? platformDraftStore;
    const userId = options.userId;
    const annotationFileId = options.annotationFileId;

    // clean 只可能来自初始服务器文件或确认成功的完整保存，此时应清除已经被服务器覆盖的草稿。
    if (action === "delete") {
      enqueue(() => store.delete(userId, annotationFileId));
      return;
    }

    // dirty 编辑延迟合并为一份 envelope；timer 触发时再读 refs，保存用户最后一次操作后的项目。
    const timer = window.setTimeout(() => {
      enqueueDraftWrite(options);
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
      enqueueDraftWrite(latest);
    }
  }, []);
}
