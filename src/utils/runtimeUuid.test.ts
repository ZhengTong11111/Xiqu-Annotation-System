import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeUuid } from "./runtimeUuid";

test("安全上下文优先调用浏览器原生 randomUUID", () => {
  const value = createRuntimeUuid({
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(value, "11111111-2222-4333-8444-555555555555");
});

test("HTTP 非安全上下文使用 getRandomValues 生成标准 UUID v4", () => {
  const value = createRuntimeUuid({
    getRandomValues: (array) => {
      const bytes = array as unknown as Uint8Array;
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return array;
    },
  });

  assert.equal(value, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("没有 Web Crypto 时仍返回格式正确且不重复的 UUID", () => {
  const first = createRuntimeUuid({});
  const second = createRuntimeUuid({});
  const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  assert.match(first, uuidV4Pattern);
  assert.match(second, uuidV4Pattern);
  assert.notEqual(first, second);
});
