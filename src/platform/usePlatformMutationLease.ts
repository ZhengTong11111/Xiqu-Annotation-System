import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationMutationPurpose } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  createPlatformMutationLeaseRuntime,
  type PlatformMutationLeaseRuntime,
  type PlatformMutationLeaseViewState,
} from "./platformMutationLeaseRuntime";

type UsePlatformMutationLeaseOptions = {
  client: PlatformClient | null;
  annotationFileId: string | null;
  baseRevision: number;
  enabled: boolean;
  onLeaseLost: (error: unknown) => void;
};

// React adapter 按文件建立运行时并原位推进 revision；明文 token 仅保存在 runtime 闭包和 ref 中。
export function usePlatformMutationLease(options: UsePlatformMutationLeaseOptions) {
  const [state, setState] = useState<PlatformMutationLeaseViewState>({ status: "idle" });
  const runtimeRef = useRef<PlatformMutationLeaseRuntime | null>(null);
  const onLeaseLostRef = useRef(options.onLeaseLost);
  onLeaseLostRef.current = options.onLeaseLost;

  useEffect(() => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    setState({ status: "idle" });
    if (!options.enabled || !options.client || !options.annotationFileId) return;
    const client = options.client;
    const annotationFileId = options.annotationFileId;
    const runtime = createPlatformMutationLeaseRuntime({
      baseRevision: options.baseRevision,
      now: () => Date.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      acquire: (purpose, baseRevision) => client.acquireAnnotationMutationLease(
        annotationFileId,
        { purpose, baseRevision },
      ),
      renew: (token) => client.renewAnnotationMutationLease(annotationFileId, { token }),
      release: (token) => client.releaseAnnotationMutationLease(annotationFileId, { token }),
      onStateChange: setState,
      onLeaseLost: (error) => onLeaseLostRef.current(error),
    });
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [options.annotationFileId, options.client, options.enabled]);

  // revision 变化只推进现有会话基线；避免每批提交后依赖一次异步卸载/重建才能申请下一把锁。
  useEffect(() => {
    runtimeRef.current?.updateBaseRevision(options.baseRevision);
  }, [options.baseRevision]);

  const acquire = useCallback(async (purpose: AnnotationMutationPurpose) => {
    if (!options.enabled) return undefined;
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("结构编辑租约尚未就绪，请稍后重试。");
    return runtime.acquire(purpose);
  }, [options.enabled]);

  return {
    state,
    acquire,
    getToken: useCallback(() => runtimeRef.current?.getToken(), []),
    markCommitted: useCallback(() => runtimeRef.current?.markCommitted(), []),
    advanceBaseRevision: useCallback(
      (baseRevision: number) => runtimeRef.current?.updateBaseRevision(baseRevision),
      [],
    ),
    release: useCallback(() => runtimeRef.current?.release() ?? Promise.resolve(), []),
  };
}
