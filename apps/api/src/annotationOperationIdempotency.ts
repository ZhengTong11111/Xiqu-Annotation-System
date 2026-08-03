import { createHash } from "node:crypto";

const CLIENT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// 请求指纹只覆盖会影响 operation 语义的客户端字段，文件和账号由数据库唯一作用域隔离。
export type AnnotationOperationFingerprintInput = {
  baseRevision: number;
  localRevision: number | null;
  action: string;
  payload: unknown;
};

// 客户端幂等键使用保守可打印字符集，既兼容现有 op-UUID，也避免日志和索引中的控制字符。
export function isValidClientOperationId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_OPERATION_ID_PATTERN.test(value);
}

// SHA-256 绑定规范化请求；hash 只保存在服务端，API 冲突响应不回显 payload 或指纹。
export function createAnnotationOperationRequestHash(
  input: AnnotationOperationFingerprintInput,
) {
  return createHash("sha256")
    .update(stableJsonStringify({
      action: input.action,
      baseRevision: input.baseRevision,
      localRevision: input.localRevision,
      payload: input.payload,
    }))
    .digest("hex");
}

// 稳定 JSON 递归排序对象 key，但保留数组顺序；非 JSON 值 fail closed，不能产生含糊指纹。
export function stableJsonStringify(value: unknown) {
  return serializeJsonValue(value, new Set<object>());
}

// 递归序列化显式处理 JSON 六类值，并用当前递归栈识别循环引用。
function serializeJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("operation payload 不能包含非有限数字。");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("operation payload 包含不支持的非 JSON 值。");
  }
  if (ancestors.has(value)) throw new Error("operation payload 不能包含循环引用。");
  ancestors.add(value);
  try {
    // 数组顺序属于业务语义，不能像对象 key 一样排序。
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeJsonValue(item, ancestors)).join(",")}]`;
    }
    // 只接受普通 JSON 对象，Date/Map/类实例不能被静默压成空对象后共享指纹。
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("operation payload 只能包含普通 JSON 对象。");
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJsonValue(
        (value as Record<string, unknown>)[key],
        ancestors,
      )}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
