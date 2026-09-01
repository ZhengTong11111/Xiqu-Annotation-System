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
import { ANNOTATION_REVIEW_PAGE_MAX_LIMIT } from "@xiqu/shared";
import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import { drainAnnotationReviewPages } from "./annotationReviewPageDrain";
import { mergeAnnotationReviewPage } from "./annotationReviewPaging";

export type AnnotationReviewMutationResult<TRecord> = {
  record: TRecord;
  refreshFailed: boolean;
};

type ReviewMutationRecord = AnnotationConfirmationRecord | AnnotationRangeCommentRecord;

export type CompleteAnnotationReviewHistory = {
  confirmations: AnnotationConfirmationList;
  comments: AnnotationRangeCommentPage;
};

// Hook 统一管理确认、审核评论和编辑反馈，确保文件切换、慢响应和 mutation 后刷新遵守同一代次边界。
export function useAnnotationReviews(input: {
  client: PlatformClient | null;
  annotationFileId: string | null;
  currentRevision?: number | null;
  autoLoadAll?: boolean;
}) {
  const [confirmations, setConfirmations] = useState<AnnotationConfirmationList | null>(null);
  const [comments, setComments] = useState<AnnotationRangeCommentPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMoreConfirmations, setLoadingMoreConfirmations] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const requestGenerationRef = useRef(0);
  const resourceGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const autoLoadAttemptRef = useRef<string | null>(null);
  const loadAllInFlightRef = useRef<{
    resourceGeneration: number;
    promise: Promise<CompleteAnnotationReviewHistory | null>;
  } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  // 首屏并发读取两类治理事实；一类失败时仍保留另一类结果，避免局部故障把全部历史隐藏。
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
      const [confirmationResult, commentResult] = await Promise.allSettled([
        input.client.listAnnotationConfirmations(input.annotationFileId, { limit: 100 }),
        input.client.listAnnotationRangeComments(input.annotationFileId, {
          includeWithdrawn: true,
          limit: 100,
        }),
      ]);
      if (!mountedRef.current || generation !== requestGenerationRef.current) return false;
      setConfirmations(confirmationResult.status === "fulfilled" ? confirmationResult.value : null);
      setComments(commentResult.status === "fulfilled" ? commentResult.value : null);
      const failures = [
        confirmationResult.status === "rejected"
          ? `确认记录：${describeAnnotationReviewError(confirmationResult.reason)}`
          : null,
        commentResult.status === "rejected"
          ? `评论与反馈：${describeAnnotationReviewError(commentResult.reason)}`
          : null,
      ].filter((message): message is string => Boolean(message));
      setError(failures.length ? `部分审核历史加载失败。${failures.join("；")}` : null);
      return failures.length === 0;
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
    setLoadingMoreConfirmations(false);
    setLoadingMoreComments(false);
    setLoadingAll(false);
    autoLoadAttemptRef.current = null;
    if (input.client && input.annotationFileId) void refresh();
  }, [input.annotationFileId, input.client, refresh]);

  useEffect(() => {
    if (!Number.isInteger(input.currentRevision) || Number(input.currentRevision) < 1) return;
    const currentRevision = Number(input.currentRevision);
    // 普通标注保存只会推进文件 revision，不会改变独立审核事实；就地推进版本即可更新 freshness 和导出来源，
    // 避免审核员每次自动保存后重新下载完整确认/评论历史。
    setConfirmations((current) => current && current.currentRevision < currentRevision
      ? { ...current, currentRevision }
      : current);
    setComments((current) => current && current.currentRevision < currentRevision
      ? { ...current, currentRevision }
      : current);
  }, [input.currentRevision]);

  // “加载全部”并行排空两张事实表；同一文件的重复触发复用同一个 Promise，避免按钮和自动预取重复请求。
  const loadAllRecords = useCallback((): Promise<CompleteAnnotationReviewHistory | null> => {
    if (!input.client || !input.annotationFileId || !confirmations || !comments) {
      return Promise.resolve(null);
    }
    const resourceGeneration = resourceGenerationRef.current;
    const existing = loadAllInFlightRef.current;
    if (existing?.resourceGeneration === resourceGeneration) return existing.promise;
    const requestGeneration = requestGenerationRef.current;
    setLoadingAll(true);
    setError(null);

    const promise = (async (): Promise<CompleteAnnotationReviewHistory | null> => {
      const [confirmationResult, commentResult] = await Promise.allSettled([
        drainAnnotationReviewPages({
          initialPage: {
            currentRevision: confirmations.currentRevision,
            items: confirmations.confirmations,
            nextCursor: confirmations.nextCursor,
          },
          fetchPage: async (cursor) => {
            const page = await input.client!.listAnnotationConfirmations(input.annotationFileId!, {
              cursor,
              limit: ANNOTATION_REVIEW_PAGE_MAX_LIMIT,
            });
            return {
              currentRevision: page.currentRevision,
              items: page.confirmations,
              nextCursor: page.nextCursor,
            };
          },
        }),
        drainAnnotationReviewPages({
          initialPage: {
            currentRevision: comments.currentRevision,
            items: comments.items,
            nextCursor: comments.nextCursor,
          },
          fetchPage: async (cursor) => {
            const page = await input.client!.listAnnotationRangeComments(input.annotationFileId!, {
              cursor,
              includeWithdrawn: true,
              limit: ANNOTATION_REVIEW_PAGE_MAX_LIMIT,
            });
            return page;
          },
        }),
      ]);
      if (
        !mountedRef.current ||
        resourceGeneration !== resourceGenerationRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) return null;

      const nextConfirmations = confirmationResult.status === "fulfilled" ? {
        currentRevision: confirmationResult.value.currentRevision,
        confirmations: confirmationResult.value.items,
        nextCursor: null,
      } satisfies AnnotationConfirmationList : null;
      const nextComments = commentResult.status === "fulfilled"
        ? commentResult.value satisfies AnnotationRangeCommentPage
        : null;
      if (nextConfirmations) setConfirmations(nextConfirmations);
      if (nextComments) setComments(nextComments);

      const failures = [
        confirmationResult.status === "rejected"
          ? `确认记录：${describeAnnotationReviewError(confirmationResult.reason)}`
          : null,
        commentResult.status === "rejected"
          ? `评论与反馈：${describeAnnotationReviewError(commentResult.reason)}`
          : null,
      ].filter((message): message is string => Boolean(message));
      if (failures.length) {
        setError(`完整审核历史加载失败，已保留成功读取的记录。${failures.join("；")}`);
        return null;
      }
      setError(null);
      return { confirmations: nextConfirmations!, comments: nextComments! };
    })().finally(() => {
      if (loadAllInFlightRef.current?.promise === promise) loadAllInFlightRef.current = null;
      if (mountedRef.current && resourceGeneration === resourceGenerationRef.current) setLoadingAll(false);
    });
    loadAllInFlightRef.current = { resourceGeneration, promise };
    return promise;
  }, [comments, confirmations, input.annotationFileId, input.client]);

  // 具备审核权限的会话在首屏可见后只自动排空一次；失败后等待人工刷新，避免持续重试放大故障。
  useEffect(() => {
    if (!input.autoLoadAll || loading || loadingAll || !confirmations || !comments) return;
    if (!confirmations.nextCursor && !comments.nextCursor) return;
    const attemptKey = `${resourceGenerationRef.current}:${requestGenerationRef.current}`;
    if (autoLoadAttemptRef.current === attemptKey) return;
    autoLoadAttemptRef.current = attemptKey;
    void loadAllRecords();
  }, [comments, confirmations, input.autoLoadAll, loadAllRecords, loading, loadingAll]);

  // 确认与评论拥有独立 cursor；继续加载一类记录不会消费另一类的分页位置。
  const loadMoreConfirmations = useCallback(async () => {
    if (
      !input.client ||
      !input.annotationFileId ||
      !confirmations?.nextCursor ||
      loadingMoreConfirmations
    ) return;
    const generation = requestGenerationRef.current;
    const resourceGeneration = resourceGenerationRef.current;
    setLoadingMoreConfirmations(true);
    try {
      const page = await input.client.listAnnotationConfirmations(input.annotationFileId, {
        cursor: confirmations.nextCursor,
        limit: 100,
      });
      if (
        !mountedRef.current ||
        generation !== requestGenerationRef.current ||
        resourceGeneration !== resourceGenerationRef.current
      ) return;
      setConfirmations((current) => current ? {
        currentRevision: page.currentRevision,
        confirmations: mergeAnnotationReviewPage(current.confirmations, page.confirmations),
        nextCursor: page.nextCursor,
      } : page);
    } catch (nextError) {
      if (
        mountedRef.current &&
        generation === requestGenerationRef.current &&
        resourceGeneration === resourceGenerationRef.current
      ) {
        setError(describeAnnotationReviewError(nextError));
      }
    } finally {
      if (mountedRef.current && resourceGeneration === resourceGenerationRef.current) {
        setLoadingMoreConfirmations(false);
      }
    }
  }, [confirmations?.nextCursor, input.annotationFileId, input.client, loadingMoreConfirmations]);

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
        items: mergeAnnotationReviewPage(current.items, page.items),
        nextCursor: page.nextCursor,
      } : page);
    } catch (nextError) {
      if (
        mountedRef.current &&
        generation === requestGenerationRef.current &&
        resourceGeneration === resourceGenerationRef.current
      ) {
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
    loadingMoreConfirmations,
    loadingMoreComments,
    loadingAll,
    error,
    mutationPending,
    refresh,
    loadMoreConfirmations,
    loadMoreComments,
    loadAllRecords,
    createConfirmation,
    revokeConfirmation,
    createComment,
    withdrawComment,
  };
}

function describeAnnotationReviewError(error: unknown): string {
  if (error instanceof PlatformApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "标注审核操作失败，请稍后重试。";
}
