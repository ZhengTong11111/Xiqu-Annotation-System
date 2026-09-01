import { mergeAnnotationReviewPage } from "./annotationReviewPaging";

export type AnnotationReviewCursorPage<TRecord> = {
  currentRevision: number;
  items: TRecord[];
  nextCursor: string | null;
};

type DrainAnnotationReviewPagesInput<TRecord extends { id: string }> = {
  initialPage: AnnotationReviewCursorPage<TRecord>;
  fetchPage: (cursor: string) => Promise<AnnotationReviewCursorPage<TRecord>>;
};

const MAX_REVIEW_PAGE_REQUESTS_PER_LOAD = 10_000;

// 单条历史流严格按服务端 opaque cursor 排空；重复 cursor 会立即失败，防止坏响应形成无限请求。
export async function drainAnnotationReviewPages<TRecord extends { id: string }>(
  input: DrainAnnotationReviewPagesInput<TRecord>,
): Promise<AnnotationReviewCursorPage<TRecord>> {
  let currentRevision = input.initialPage.currentRevision;
  let items = [...input.initialPage.items];
  let nextCursor = input.initialPage.nextCursor;
  const consumedCursors = new Set<string>();
  let requestCount = 0;

  while (nextCursor) {
    if (consumedCursors.has(nextCursor)) {
      throw new Error("审核历史分页游标发生循环，已停止加载以保护当前会话。");
    }
    if (requestCount >= MAX_REVIEW_PAGE_REQUESTS_PER_LOAD) {
      throw new Error("审核历史分页数量异常，已停止加载以避免无界请求。");
    }
    consumedCursors.add(nextCursor);
    requestCount += 1;
    const page = await input.fetchPage(nextCursor);
    currentRevision = page.currentRevision;
    items = mergeAnnotationReviewPage(items, page.items);
    nextCursor = page.nextCursor;
  }

  return { currentRevision, items, nextCursor: null };
}
