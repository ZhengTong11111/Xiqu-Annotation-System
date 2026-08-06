// ProjectData 最终以 JSON 持久化：对象中值为 undefined 的可选键会被省略，因此应与“键不存在”等价。
// null 仍是显式值，数组中的 undefined 也不能按对象省略规则处理，避免放宽真实领域差异。
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
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length || leftKeys.some(
    (key) => !Object.prototype.hasOwnProperty.call(rightRecord, key),
  )) return false;
  return leftKeys.every((key) => areProjectValuesEqual(leftRecord[key], rightRecord[key]));
}
