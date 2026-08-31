import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnnotationConfirmationList,
  AnnotationConfirmationRecord,
  AnnotationRangeCommentPage,
  AnnotationRangeCommentRecord,
  CreateAnnotationConfirmationRequest,
  CreateAnnotationRangeCommentRequest,
  RevokeAnnotationConfirmationRequest,
  WithdrawAnnotationRangeCommentRequest,
} from "@xiqu/shared";
import { PlatformApiError, type PlatformClient } from "../api/platformClient";

export type AnnotationReviewMutationResult<TRecord> = {
  record: TRecord;
  refreshFailed: boolean;
};

type ReviewMutationRecord = AnnotationConfirmationRecord | AnnotationRangeCommentRecord;

// Hook 统一管理确认、审核评论和编辑反馈，确保文件切换、慢响应和 mutation 后刷新遵守同一代次边界。
export function useAnnotationReviews(input: {
  client: PlatformClient | null;
  annotationFileId: string | null;
}) {
  const [confirmations, setConfirmations] = useState<AnnotationConfirmationList | null>(null);
  const [comments, setComments] = useState<AnnotationRangeCommentPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const requestGenerationRef = useRef(0);
  const resourceGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  // 全量刷新并发读取两类治理事实；任一失败都不混入另一文件会话。
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!input.client || !input.annotationFileId) {
      setConfirmations(null);
      setComments(null);
      setError(null);
      return false;
    }
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const [nextConfirmations, nextComments] = await Promise.all([
        input.client.listAnnotationConfirmations(input.annotationFileId),
        input.client.listAnnotationRangeComments(input.annotationFileId, {
          includeWithdrawn: true,
          limit: 100,
        }),
      ]);
      if (!mountedRef.current || generation !== requestGenerationRef.current) return false;
      setConfirmations(nextConfirmations);
      setComments(nextComments);
      return true;
    } catch (nextError) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return false;
      setError(describeAnnotationReviewError(nextError));
      return false;
    } finally {
      if (mountedRef.current && generation === requestGenerationRef.current) setLoading(false);
    }
  }, [input.annotationFileId, input.client]);

  useEffect(() => {
    resourceGenerationRef.current += 1;
    requestGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    setConfirmations(null);
    setComments(null);
    setError(null);
    setMutationPending(false);
    setLoadingMoreComments(false);
    if (input.client && input.annotationFileId) void refresh();
  }, [input.annotationFileId, input.client, refresh]);

  // 追加分页只接受当前 nextCursor；刷新或换文件会让慢响应失效。
  const loadMoreComments = useCallback(async () => {
    if (!input.client || !input.annotationFileId || !comments?.nextCursor || loadingMoreComments) return;
    const generation = requestGenerationRef.current;
    const resourceGeneration = resourceGenerationRef.current;
    setLoadingMoreComments(true);
    try {
      const page = await input.client.listAnnotationRangeComments(input.annotationFileId, {
        cursor: comments.nextCursor,
        includeWithdrawn: true,
        limit: 100,
      });
      if (
        !mountedRef.current ||
        generation !== requestGenerationRef.current ||
        resourceGeneration !== resourceGenerationRef.current
      ) return;
      setComments((current) => current ? {
        currentRevision: page.currentRevision,
        items: mergeCommentPages(current.items, page.items),
        nextCursor: page.nextCursor,
      } : page);
    } catch (nextError) {
      if (mountedRef.current && resourceGeneration === resourceGenerationRef.current) {
        setError(describeAnnotationReviewError(nextError));
      }
    } finally {
      if (mountedRef.current && resourceGeneration === resourceGenerationRef.current) {
        setLoadingMoreComments(false);
      }
    }
  }, [comments?.nextCursor, input.annotationFileId, input.client, loadingMoreComments]);

  // 两套 endpoint 的四类命令共用一条 mutation 管道；kind 在带正文记录内部区分评论与反馈。
  const runMutation = useCallback(async <TRecord extends ReviewMutationRecord>(
    operation: () => Promise<TRecord>,
  ): Promise<AnnotationReviewMutationResult<TRecord>> => {
    if (!input.client || !input.annotationFileId) throw new Error("当前不是平台标注文件。");
    const resourceGeneration = resourceGenerationRef.current;
    const mutationGeneration = ++mutationGenerationRef.current;
    setMutationPending(true);
    setError(null);
    try {
      const record = await operation();
      if (resourceGeneration !== resourceGenerationRef.current) {
        return { record, refreshFailed: true };
      }
      return { record, refreshFailed: !await refresh() };
    } catch (nextError) {
      const message = describeAnnotationReviewError(nextError);
      if (mountedRef.current && resourceGeneration === resourceGenerationRef.current) setError(message);
      throw new Error(message);
    } finally {
      if (
        mountedRef.current &&
        resourceGeneration === resourceGenerationRef.current &&
        mutationGeneration === mutationGenerationRef.current
      ) setMutationPending(false);
    }
  }, [input.annotationFileId, input.client, refresh]);

  const createConfirmation = useCallback((request: CreateAnnotationConfirmationRequest) =>
    runMutation(() => input.client!.createAnnotationConfirmation(input.annotationFileId!, request)),
  [input.annotationFileId, input.client, runMutation]);
  const revokeConfirmation = useCallback((id: string, request: RevokeAnnotationConfirmationRequest) =>
    runMutation(() => input.client!.revokeAnnotationConfirmation(input.annotationFileId!, id, request)),
  [input.annotationFileId, input.client, runMutation]);
  const createComment = useCallback((request: CreateAnnotationRangeCommentRequest) =>
    runMutation(() => input.client!.createAnnotationRangeComment(input.annotationFileId!, request)),
  [input.annotationFileId, input.client, runMutation]);
  const withdrawComment = useCallback((id: string, request: WithdrawAnnotationRangeCommentRequest) =>
    runMutation(() => input.client!.withdrawAnnotationRangeComment(input.annotationFileId!, id, request)),
  [input.annotationFileId, input.client, runMutation]);

  return {
    confirmations,
    comments,
    loading,
    loadingMoreComments,
    error,
    mutationPending,
    refresh,
    loadMoreComments,
    createConfirmation,
    revokeConfirmation,
    createComment,
    withdrawComment,
  };
}

function mergeCommentPages(
  current: AnnotationRangeCommentRecord[],
  incoming: AnnotationRangeCommentRecord[],
) {
  const seen = new Set(current.map((record) => record.id));
  return [...current, ...incoming.filter((record) => !seen.has(record.id))];
}

function describeAnnotationReviewError(error: unknown): string {
  if (error instanceof PlatformApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "标注审核操作失败，请稍后重试。";
}
