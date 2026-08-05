import { useCallback, useEffect, useRef } from "react";
import type { PlatformOperationCatchUpResult } from "./platformOperationCatchUp";
import {
  createPlatformOperationCatchUpRuntime,
  type PlatformOperationCatchUpFacts,
  type PlatformOperationCatchUpRuntime,
} from "./platformOperationCatchUpRuntime";

type UsePlatformOperationCatchUpOptions = PlatformOperationCatchUpFacts & {
  check: (facts: PlatformOperationCatchUpFacts) => Promise<PlatformOperationCatchUpResult>;
  apply: (
    result: PlatformOperationCatchUpResult,
    facts: PlatformOperationCatchUpFacts,
  ) => Promise<void> | void;
  onError: (error: unknown) => void;
};

// React hook 只负责把最新 callback/facts 接到独立运行时，避免 timer 状态散落进 App effect。
export function usePlatformOperationCatchUp(options: UsePlatformOperationCatchUpOptions) {
  const checkRef = useRef(options.check);
  const applyRef = useRef(options.apply);
  const onErrorRef = useRef(options.onError);
  const runtimeRef = useRef<PlatformOperationCatchUpRuntime | null>(null);

  checkRef.current = options.check;
  applyRef.current = options.apply;
  onErrorRef.current = options.onError;

  // Strict Effects 清理后重新 setup 时创建新运行时，旧实例的 generation 会拒绝迟到结果。
  function ensureRuntime() {
    if (runtimeRef.current) return runtimeRef.current;
    runtimeRef.current = createPlatformOperationCatchUpRuntime({
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      check: (facts) => checkRef.current(facts),
      apply: (result, facts) => applyRef.current(result, facts),
      onError: (error) => onErrorRef.current(error),
    });
    return runtimeRef.current;
  }

  // 产品事实变化只更新协调器；协调器自行决定立即检查、等待或暂停。
  useEffect(() => {
    ensureRuntime().update({
      enabled: options.enabled,
      blocked: options.blocked,
      online: options.online,
      sessionKey: options.sessionKey,
      knownRevision: options.knownRevision,
      cursor: options.cursor,
    });
  }, [
    options.blocked,
    options.cursor,
    options.enabled,
    options.knownRevision,
    options.online,
    options.sessionKey,
  ]);

  // 卸载时注销 timer 并废弃在途结果，不能让旧文件响应写入下一编辑会话。
  useEffect(() => () => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);

  // 返回稳定命令供 WebSocket 通知唤醒 HTTP catch-up，不把 runtime 实例泄漏给 App。
  return useCallback(() => {
    ensureRuntime().requestCheck();
  }, []);
}
