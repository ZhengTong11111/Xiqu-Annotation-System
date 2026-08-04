import { useEffect, useRef } from "react";
import type { ProjectSyncStatus } from "../state/projectDocumentState";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import {
  createPlatformAutoSaveRuntime,
  type PlatformAutoSaveRuntime,
} from "./platformAutoSaveRuntime";

type PlatformAutoSaveOptions = {
  enabled: boolean;
  dirty: boolean;
  suspended: boolean;
  localRevision: number;
  syncStatus: ProjectSyncStatus;
  online: boolean;
  save: () => Promise<PlatformSaveOutcome>;
  onUnexpectedError: (error: unknown) => void;
};

// 自动保存 hook 只把 React facts 接到独立运行时；timer、single-flight 和退避不再散落于组件生命周期。
export function usePlatformAutoSave(options: PlatformAutoSaveOptions) {
  const saveRef = useRef(options.save);
  const onUnexpectedErrorRef = useRef(options.onUnexpectedError);
  const runtimeRef = useRef<PlatformAutoSaveRuntime | null>(null);

  saveRef.current = options.save;
  onUnexpectedErrorRef.current = options.onUnexpectedError;

  // effect setup 按需创建运行时；Strict Mode 模拟卸载置空后，第二次 setup 会得到新实例。
  const ensureRuntime = () => {
    if (runtimeRef.current) return runtimeRef.current;
    const runtime = createPlatformAutoSaveRuntime({
      now: () => Date.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      save: () => saveRef.current(),
      onUnexpectedError: (error) => onUnexpectedErrorRef.current(error),
    });
    runtimeRef.current = runtime;
    return runtime;
  };

  // 每次产品 facts 改变只更新协调器；协调器内部保证 timer 与请求均为单实例。
  useEffect(() => {
    ensureRuntime().update({
      enabled: options.enabled,
      dirty: options.dirty,
      suspended: options.suspended,
      localRevision: options.localRevision,
      syncStatus: options.syncStatus,
      online: options.online,
    });
  }, [
    options.dirty,
    options.enabled,
    options.localRevision,
    options.online,
    options.suspended,
    options.syncStatus,
  ]);

  // 卸载时销毁并置空；这同时兼容 React 18 开发态的 Strict Effects setup-cleanup-setup 顺序。
  useEffect(() => () => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);
}
