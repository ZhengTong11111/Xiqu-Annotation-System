import { useEffect, useRef } from "react";
import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import type { AtomicCommitApplyResult } from "./platformAtomicSubmitRuntime";
import type { AtomicSubmitErrorClassification } from "./platformAtomicSubmitPolicy";
import {
  createPlatformAtomicCommandSubmitCoordinator,
  type PlatformAtomicCommandSubmitCoordinator,
} from "./platformAtomicCommandSubmitCoordinator";

type Options = {
  client: PlatformClient | null;
  annotationFileId: string | null;
  sessionKey: string;
  online: boolean;
  applyCommitted: (
    plan: AtomicCommandPlan,
    response: CommitAnnotationCommandBatchResponse,
  ) => AtomicCommitApplyResult;
  onRetryableFailure: (failure: AtomicSubmitErrorClassification) => void;
};

// React adapter 只提供最新会话依赖；single-flight、重试和 Promise 完成语义由可测试 coordinator 负责。
export function usePlatformAtomicCommandSubmit(options: Options) {
  const optionsRef = useRef(options);
  const coordinatorRef = useRef<PlatformAtomicCommandSubmitCoordinator | null>(null);
  optionsRef.current = options;

  function ensureCoordinator() {
    if (coordinatorRef.current) return coordinatorRef.current;
    const coordinator = createPlatformAtomicCommandSubmitCoordinator({
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      submit: (plan) => {
        const latest = optionsRef.current;
        if (!latest.client || !latest.annotationFileId) {
          return Promise.reject(new Error("原子提交会话已经关闭。"));
        }
        return latest.client.commitAnnotationCommandBatch(latest.annotationFileId, plan.request);
      },
      applyCommitted: (plan, response) => optionsRef.current.applyCommitted(plan, response),
      onRetryableFailure: (failure) => optionsRef.current.onRetryableFailure(failure),
    }, {
      online: optionsRef.current.online,
      sessionKey: optionsRef.current.sessionKey,
    });
    coordinatorRef.current = coordinator;
    return coordinator;
  }

  // online/文件/账号变化都推进 coordinator facts；旧会话的等待调用会明确返回 cancelled。
  useEffect(() => {
    ensureCoordinator().updateConnection({
      online: options.online,
      sessionKey: options.sessionKey,
    });
  }, [options.online, options.sessionKey]);

  // Strict Effects cleanup 后置空，第二次 setup 会创建全新的 generation。
  useEffect(() => () => {
    coordinatorRef.current?.dispose();
    coordinatorRef.current = null;
  }, []);

  return {
    submit(plan: AtomicCommandPlan) {
      if (!optionsRef.current.client || !optionsRef.current.annotationFileId) {
        return Promise.resolve({ status: "cancelled" as const });
      }
      return ensureCoordinator().submit(plan);
    },
  };
}
