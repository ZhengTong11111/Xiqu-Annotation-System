const MAX_OFFSET_SECONDS = 86_400;
const MAX_OFFSET_MILLISECONDS = MAX_OFFSET_SECONDS * 1_000;

/**
 * 表单允许直接输入秒，但必须保持为有限值并落在服务端同一正负 24 小时边界内。
 * 这里不擅自量化手工输入，避免仅打开并保存表单就改写已有高精度历史值。
 */
export function parseMediaAudioTrackOffsetSeconds(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_OFFSET_SECONDS
    ? parsed
    : null;
}

/** 服务端秒值进入表单时保留到微秒级，并使用普通十进制避免科学计数法破坏 number 输入。 */
export function formatMediaAudioTrackOffsetDraft(offsetSeconds: number) {
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > MAX_OFFSET_SECONDS) {
    return "";
  }
  return offsetSeconds
    .toFixed(6)
    .replace(/(?:\.0+|(?<=[0-9])0+)$/u, "")
    .replace(/\.$/u, "");
}

/**
 * 校准按钮始终在整数毫秒上运算，避免连续点击产生 0.30000000000000004 一类浮点尾数。
 * 返回 null 表示当前草稿无效或本次步进会越界，调用方不能静默从零开始猜测。
 */
export function adjustMediaAudioTrackOffsetDraft(
  currentValue: string,
  deltaMilliseconds: number,
) {
  const currentSeconds = parseMediaAudioTrackOffsetSeconds(currentValue);
  if (
    currentSeconds === null ||
    !Number.isInteger(deltaMilliseconds) ||
    deltaMilliseconds === 0
  ) return null;
  const nextMilliseconds = Math.round(currentSeconds * 1_000) + deltaMilliseconds;
  if (Math.abs(nextMilliseconds) > MAX_OFFSET_MILLISECONDS) return null;
  return formatMediaAudioTrackOffsetDraft(nextMilliseconds / 1_000);
}

/** 正值表示音频在项目时间轴上延后开始，负值表示提前。 */
export function describeMediaAudioTrackOffset(value: string) {
  const offsetSeconds = parseMediaAudioTrackOffsetSeconds(value);
  if (offsetSeconds === null) return null;
  const milliseconds = offsetSeconds * 1_000;
  if (milliseconds === 0) return "与视频对齐（0 ms）";
  const magnitude = formatCompactMilliseconds(Math.abs(milliseconds));
  return milliseconds > 0
    ? `音频相对视频延后 ${magnitude} ms`
    : `音频相对视频提前 ${magnitude} ms`;
}

function formatCompactMilliseconds(value: number) {
  return value.toFixed(3).replace(/(?:\.0+|(?<=[0-9])0+)$/u, "").replace(/\.$/u, "");
}
