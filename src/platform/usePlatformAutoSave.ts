import { useEffect, useReducer, useRef } from "react";
import type { ProjectSyncStatus } from "../state/projectDocumentState";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import {
  getPlatformAutoSaveDecision,
  getPlatformAutoSaveRetryDelay,
  PLATFORM_AUTO_SAVE_IDLE_DELAY_MS,
} from "./platformAutoSavePolicy";

type PlatformAutoSaveOptions = {
  enabled: boolean;
  dirty: boolean;
  suspended: boolean;
  localRevision: number;
  syncStatus: ProjectSyncStatus;
  save: () => Promise<PlatformSaveOutcome>;
};

// 自动保存 hook 只编排一个 timer 和一个请求；真正的保存事务仍由 App 的唯一保存命令负责。
export function usePlatformAutoSave(options: PlatformAutoSaveOptions) {
  const saveRef = useRef(options.save);
  const latestOptionsRef = useRef(options);
  const inFlightRef = useRef(false);
  const idleDueAtRef = useRef<number | null>(null);
  const retryDueAtRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const retryBlockedRef = useRef(false);
  const lastLocalRevisionRef = useRef(options.localRevision);
  const lastOnlineRef = useRef(typeof navigator === "undefined" || navigator.onLine !== false);
  const mountedRef = useRef(true);
  const [, rerender] = useReducer((value: number) => value + 1, 0);

  saveRef.current = options.save;
  latestOptionsRef.current = options;

  // 组件卸载后允许在途请求自然完成，但禁止其继续安排当前会话的 timer 或 render。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 新用户编辑重新开始空闲计时；revision conflict 不能靠继续编辑自动解除。
  if (lastLocalRevisionRef.current !== options.localRevision) {
    lastLocalRevisionRef.current = options.localRevision;
    const nextDueAt = Date.now() + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
    // 已知可重试 error 保留“有 retry 截止时间”的证据，只把长退避缩回一次空闲窗口。
    if (options.syncStatus === "error" && retryDueAtRef.current !== null) {
      retryDueAtRef.current = nextDueAt;
      idleDueAtRef.current = null;
    } else {
      idleDueAtRef.current = nextDueAt;
      retryDueAtRef.current = null;
    }
    retryAttemptRef.current = 0;
  }

  useEffect(() => {
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    const cameOnline = online && !lastOnlineRef.current;
    lastOnlineRef.current = online;
    if (cameOnline && options.dirty && options.syncStatus !== "conflict") {
      // 恢复在线后立即重新尝试，不额外等待完整空闲窗口。
      idleDueAtRef.current = Date.now();
      retryDueAtRef.current = null;
      retryAttemptRef.current = 0;
    }
  }, [options.dirty, options.syncStatus]);

  useEffect(() => {
    const online = typeof navigator === "undefined" || navigator.onLine !== false;

    // clean 或禁用后清空会话内退避；IndexedDB 草稿生命周期由独立 hook 管理。
    if (!options.enabled || !options.dirty) {
      idleDueAtRef.current = null;
      retryDueAtRef.current = null;
      retryAttemptRef.current = 0;
      retryBlockedRef.current = false;
    } else if (idleDueAtRef.current === null && retryDueAtRef.current === null) {
      idleDueAtRef.current = Date.now() + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
    }

    const decision = getPlatformAutoSaveDecision({
      enabled: options.enabled,
      dirty: options.dirty,
      suspended: options.suspended,
      online,
      syncStatus: options.syncStatus,
      inFlight: inFlightRef.current,
      retryBlocked: retryBlockedRef.current,
      idleDueAt: idleDueAtRef.current,
      retryDueAt: retryDueAtRef.current,
      now: Date.now(),
    });
    if (decision.action === "disabled" || decision.action === "blocked") return;
    if (decision.action === "waiting") {
      if (decision.reason === "in-flight") return;
      const timer = window.setTimeout(() => rerender(), Math.max(0, decision.delayMs));
      return () => window.clearTimeout(timer);
    }

    // 到点后只允许一个请求；请求期间 facts 可继续变化，但不能启动第二份并发保存。
    inFlightRef.current = true;
    idleDueAtRef.current = null;
    retryDueAtRef.current = null;
    void saveRef.current().then((outcome) => {
      if (!mountedRef.current) return;
      if (outcome.status === "offline") {
        retryDueAtRef.current = null;
      } else if (outcome.status === "error" && outcome.retryable) {
        retryDueAtRef.current = Date.now() + getPlatformAutoSaveRetryDelay(
          retryAttemptRef.current,
        );
        retryAttemptRef.current += 1;
      } else if (
        outcome.status === "conflict" ||
        (outcome.status === "error" && !outcome.retryable)
      ) {
        retryBlockedRef.current = true;
      } else {
        retryAttemptRef.current = 0;
        // 保存期间出现的新编辑会在下一 render 重新进入空闲窗口。
        if (latestOptionsRef.current.dirty) {
          idleDueAtRef.current = Date.now() + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
        }
      }
    }).finally(() => {
      inFlightRef.current = false;
      if (mountedRef.current) rerender();
    });
  }, [options.dirty, options.enabled, options.localRevision, options.suspended, options.syncStatus]);
}
