// ProjectData 是无环纯数据；引用相同的媒体 URL 等大值会立即返回，变化集合才递归比较。
export function areProjectValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!areProjectValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length || leftKeys.some(
    (key) => !Object.prototype.hasOwnProperty.call(rightRecord, key),
  )) return false;
  return leftKeys.every((key) => areProjectValuesEqual(leftRecord[key], rightRecord[key]));
}
