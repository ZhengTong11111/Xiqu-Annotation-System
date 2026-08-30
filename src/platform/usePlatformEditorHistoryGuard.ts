import { useCallback, useEffect, useRef } from "react";
import { createRuntimeUuid } from "../utils/runtimeUuid";

type PlatformEditorHistoryGuardOptions = {
  enabled: boolean;
  sessionKey: string | null;
  requestLeave: () => Promise<boolean>;
  onApprovedLeave: () => void;
};

const HISTORY_GUARD_KEY = "__xiquPlatformEditorGuard";
const HISTORY_GUARD_VACANT_KEY = "__xiquPlatformEditorGuardVacant";
const HISTORY_GUARD_PREVIOUS_STATE_KEY = "__xiquPlatformEditorPreviousState";

// 浏览器不允许网页永久关闭原生后退。这里为当前编辑会话建立一个同 URL 哨兵，
// 后退时先回到哨兵并执行保存门禁；批准后再移除哨兵，因此不会把用户永久困在页面中。
export function usePlatformEditorHistoryGuard({
  enabled,
  sessionKey,
  requestLeave,
  onApprovedLeave,
}: PlatformEditorHistoryGuardOptions) {
  const requestLeaveRef = useRef(requestLeave);
  const onApprovedLeaveRef = useRef(onApprovedLeave);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const markerRef = useRef<string | null>(null);
  const releasedRef = useRef(false);

  requestLeaveRef.current = requestLeave;
  onApprovedLeaveRef.current = onApprovedLeave;

  const triggerLeave = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;
    const task = requestLeaveRef.current().then((approved) => {
      if (!approved) return false;
      releasedRef.current = true;
      // 正常离开时退回哨兵前一项，避免反复打开文件后积累无意义的同 URL 历史记录。
      const marker = markerRef.current;
      if (marker && window.history.state?.[HISTORY_GUARD_KEY] === marker) {
        window.history.back();
      }
      // 先读取并释放 history 标记，再切换 React 视图；同步卸载不能让 marker ref 提前失效。
      onApprovedLeaveRef.current();
      return true;
    }).finally(() => {
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    inFlightRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    if (!enabled || !sessionKey) return;
    const marker = createRuntimeUuid();
    const currentState = window.history.state;
    // React Strict Effects 会执行一次 setup-cleanup-setup。复用刚清空的哨兵项，避免开发环境每次打开多积一层历史。
    const reusingVacantEntry = isHistoryRecord(currentState) &&
      currentState[HISTORY_GUARD_VACANT_KEY] === true;
    const previousState = reusingVacantEntry
      ? currentState[HISTORY_GUARD_PREVIOUS_STATE_KEY]
      : currentState;
    markerRef.current = marker;
    releasedRef.current = false;
    const markerState = {
      ...(isHistoryRecord(previousState) ? previousState : {}),
      [HISTORY_GUARD_KEY]: marker,
    };
    if (reusingVacantEntry) {
      window.history.replaceState(markerState, "", window.location.href);
    } else {
      window.history.pushState(markerState, "", window.location.href);
    }

    const handlePopState = () => {
      if (releasedRef.current) return;
      // 用户后退后立即补回同 URL 哨兵；异步保存失败时仍停留在编辑器，成功后由统一入口正常移除。
      window.history.pushState({
        ...(isHistoryRecord(previousState) ? previousState : {}),
        [HISTORY_GUARD_KEY]: marker,
      }, "", window.location.href);
      void triggerLeave();
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (!releasedRef.current && window.history.state?.[HISTORY_GUARD_KEY] === marker) {
        // 非正常卸载留下一个可复用空位；不主动导航，避免登出、热更新或 Strict Effects 清理时意外离站。
        window.history.replaceState({
          [HISTORY_GUARD_VACANT_KEY]: true,
          [HISTORY_GUARD_PREVIOUS_STATE_KEY]: previousState,
        }, "", window.location.href);
      }
      markerRef.current = null;
      inFlightRef.current = null;
    };
  }, [enabled, sessionKey, triggerLeave]);

  return triggerLeave;
}

function isHistoryRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
