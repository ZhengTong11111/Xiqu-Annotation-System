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

// React adapter 只负责按文件/revision 建立运行时；明文 token 仅保存在 runtime 闭包和 ref 中。
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
  }, [options.annotationFileId, options.baseRevision, options.client, options.enabled]);

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
    release: useCallback(() => runtimeRef.current?.release() ?? Promise.resolve(), []),
  };
}
