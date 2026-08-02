import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnnotationConfirmationList,
  AnnotationConfirmationRecord,
  CreateAnnotationConfirmationRequest,
  RevokeAnnotationConfirmationRequest,
} from "@xiqu/shared";
import {
  PlatformApiError,
  type PlatformClient,
} from "../api/platformClient";

// mutation 与后续列表刷新分别计入结果，避免把“命令成功、刷新失败”误报成整体失败。
export type AnnotationConfirmationMutationResult = {
  record: AnnotationConfirmationRecord;
  refreshFailed: boolean;
};

// Hook 集中管理一份标注文件的确认事实，避免 App 和面板分别实现请求竞态与错误状态。
export function useAnnotationConfirmations(input: {
  client: PlatformClient | null;
  annotationFileId: string | null;
}) {
  const [data, setData] = useState<AnnotationConfirmationList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const requestGenerationRef = useRef(0);
  const resourceGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  // 卸载后让所有异步响应失效，防止浮动窗口或编辑器退出期间继续写入 React 状态。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  // 刷新使用 generation 隔离资源切换；旧文件的慢响应不能覆盖当前编辑会话。
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!input.client || !input.annotationFileId) {
      setData(null);
      setError(null);
      return false;
    }
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextData = await input.client.listAnnotationConfirmations(
        input.annotationFileId,
      );
      if (!mountedRef.current || generation !== requestGenerationRef.current) {
        return false;
      }
      setData(nextData);
      return true;
    } catch (nextError) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) {
        return false;
      }
      setError(describeAnnotationConfirmationError(nextError));
      return false;
    } finally {
      if (mountedRef.current && generation === requestGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [input.annotationFileId, input.client]);

  // 文件切换时立即清除旧事实，再读取新文件，避免短暂展示上一文件的确认范围。
  useEffect(() => {
    resourceGenerationRef.current += 1;
    requestGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    setData(null);
    setError(null);
    setMutationPending(false);
    if (input.client && input.annotationFileId) {
      void refresh();
    }
  }, [input.annotationFileId, input.client, refresh]);

  // 创建成功后重新读取列表；若后续刷新失败，保留“命令已成功”的返回值供 UI 准确提示。
  const create = useCallback(async (
    request: CreateAnnotationConfirmationRequest,
  ): Promise<AnnotationConfirmationMutationResult> => {
    if (!input.client || !input.annotationFileId) {
      throw new Error("当前不是平台标注文件。");
    }
    const resourceGeneration = resourceGenerationRef.current;
    const mutationGeneration = ++mutationGenerationRef.current;
    setMutationPending(true);
    setError(null);
    try {
      const record = await input.client.createAnnotationConfirmation(
        input.annotationFileId,
        request,
      );
      // 资源切换后旧命令即使已在服务端完成，也不能用旧文件列表覆盖当前编辑器。
      if (resourceGeneration !== resourceGenerationRef.current) {
        return { record, refreshFailed: true };
      }
      const refreshed = await refresh();
      return { record, refreshFailed: !refreshed };
    } catch (nextError) {
      const message = describeAnnotationConfirmationError(nextError);
      // 旧文件命令的错误不得覆盖新文件会话；调用方仍会收到准确的 rejected Promise。
      if (
        mountedRef.current &&
        resourceGeneration === resourceGenerationRef.current
      ) {
        setError(message);
      }
      throw new Error(message);
    } finally {
      // 只有最后一条、且仍属于当前资源的命令可以结束 pending，避免旧请求干扰新命令。
      if (
        mountedRef.current &&
        resourceGeneration === resourceGenerationRef.current &&
        mutationGeneration === mutationGenerationRef.current
      ) {
        setMutationPending(false);
      }
    }
  }, [input.annotationFileId, input.client, refresh]);

  // 撤销同样不做乐观删除；追加式事实只有服务端返回并重新列表后才成为本地权威状态。
  const revoke = useCallback(async (
    confirmationId: string,
    request: RevokeAnnotationConfirmationRequest,
  ): Promise<AnnotationConfirmationMutationResult> => {
    if (!input.client || !input.annotationFileId) {
      throw new Error("当前不是平台标注文件。");
    }
    const resourceGeneration = resourceGenerationRef.current;
    const mutationGeneration = ++mutationGenerationRef.current;
    setMutationPending(true);
    setError(null);
    try {
      const record = await input.client.revokeAnnotationConfirmation(
        input.annotationFileId,
        confirmationId,
        request,
      );
      // 撤销完成时若用户已切换文件，只返回事实，不再触发旧资源刷新。
      if (resourceGeneration !== resourceGenerationRef.current) {
        return { record, refreshFailed: true };
      }
      const refreshed = await refresh();
      return { record, refreshFailed: !refreshed };
    } catch (nextError) {
      const message = describeAnnotationConfirmationError(nextError);
      // 文件切换后的旧撤销错误只回传原调用方，不污染当前文件面板。
      if (
        mountedRef.current &&
        resourceGeneration === resourceGenerationRef.current
      ) {
        setError(message);
      }
      throw new Error(message);
    } finally {
      if (
        mountedRef.current &&
        resourceGeneration === resourceGenerationRef.current &&
        mutationGeneration === mutationGenerationRef.current
      ) {
        setMutationPending(false);
      }
    }
  }, [input.annotationFileId, input.client, refresh]);

  return {
    data,
    loading,
    error,
    mutationPending,
    refresh,
    create,
    revoke,
  };
}

// API 错误保留服务端业务消息；未知异常使用稳定中文提示并交由调用方记录原始错误。
function describeAnnotationConfirmationError(error: unknown): string {
  if (error instanceof PlatformApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "确认记录操作失败，请稍后重试。";
}
