import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationOperationRequestHash,
  isValidClientOperationId,
  stableJsonStringify,
} from "../src/annotationOperationIdempotency.js";

// 客户端 id 校验兼容现有 op-UUID，并拒绝超长、路径和控制字符。
test("operation 客户端幂等键使用有界安全字符集", () => {
  assert.equal(isValidClientOperationId("op-550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidClientOperationId("a:b_c.d-1"), true);
  assert.equal(isValidClientOperationId(""), false);
  assert.equal(isValidClientOperationId(`a${"b".repeat(128)}`), false);
  assert.equal(isValidClientOperationId("op/path"), false);
  assert.equal(isValidClientOperationId("op\nnewline"), false);
});

// 对象 key 顺序不影响 JSON 语义，数组顺序和字段值变化必须改变规范文本。
test("operation 请求指纹使用稳定 JSON 且保留数组语义", () => {
  assert.equal(
    stableJsonStringify({ b: 2, a: { y: true, x: null } }),
    stableJsonStringify({ a: { x: null, y: true }, b: 2 }),
  );
  assert.notEqual(stableJsonStringify([1, 2]), stableJsonStringify([2, 1]));
  assert.throws(() => stableJsonStringify({ value: Number.NaN }), /非有限/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => stableJsonStringify(cyclic), /循环引用/);
});

// revision、local revision、action 与 payload 都属于不可变请求，任一变化都产生不同 hash。
test("operation 请求指纹绑定全部业务字段", () => {
  const base = {
    baseRevision: 3,
    localRevision: 5,
    action: "project.commit",
    payload: { type: "project.commit", ids: ["a", "b"] },
  };
  const hash = createAnnotationOperationRequestHash(base);
  assert.equal(hash.length, 64);
  assert.equal(createAnnotationOperationRequestHash({
    ...base,
    payload: { ids: ["a", "b"], type: "project.commit" },
  }), hash);
  assert.notEqual(createAnnotationOperationRequestHash({ ...base, baseRevision: 4 }), hash);
  assert.notEqual(createAnnotationOperationRequestHash({ ...base, localRevision: null }), hash);
  assert.notEqual(createAnnotationOperationRequestHash({ ...base, action: "project.undo" }), hash);
  assert.notEqual(createAnnotationOperationRequestHash({
    ...base,
    payload: { type: "project.commit", ids: ["b", "a"] },
  }), hash);
});
