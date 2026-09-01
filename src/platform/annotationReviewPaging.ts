type ReviewRecord = { id: string };

// 刷新后的第一页与旧追加页不能混用；同一次续页只按稳定 id 去重并保持服务端顺序。
export function mergeAnnotationReviewPage<TRecord extends ReviewRecord>(
  current: TRecord[],
  incoming: TRecord[],
) {
  const seen = new Set(current.map((record) => record.id));
  return [...current, ...incoming.filter((record) => !seen.has(record.id))];
}
