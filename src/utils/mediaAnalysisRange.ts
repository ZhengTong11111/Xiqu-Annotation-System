export type TimedMediaIntersection = {
  startTime: number;
  endTime: number;
};

/**
 * 求当前时间窗与分析资产真实时间范围的交集。
 *
 * 渲染层不能简单把索引夹到首帧/末帧，否则正负音频偏移会把边缘数据复制到本来没有音频的时间区域。
 */
export function intersectTimedMediaRange(
  viewportStartTime: number,
  viewportEndTime: number,
  dataStartTime: number,
  dataDuration: number,
): TimedMediaIntersection | null {
  if (
    !Number.isFinite(viewportStartTime) ||
    !Number.isFinite(viewportEndTime) ||
    !Number.isFinite(dataStartTime) ||
    !Number.isFinite(dataDuration) ||
    viewportEndTime <= viewportStartTime ||
    dataDuration <= 0
  ) return null;

  const dataEndTime = dataStartTime + dataDuration;
  if (!Number.isFinite(dataEndTime)) return null;
  const startTime = Math.max(viewportStartTime, dataStartTime);
  const endTime = Math.min(viewportEndTime, dataEndTime);
  return endTime > startTime ? { startTime, endTime } : null;
}
