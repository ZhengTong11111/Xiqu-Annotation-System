import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { collectDestinationContainers } from "./resourceDestinationPaging";

// 测试 DTO 只声明目标分页器实际读取的 id/type 字段。
const item = (id: string, type: ResourceEntry["type"]) => ({ id, type }) as ResourceEntry;
const page = (
  items: ResourceEntry[],
  nextCursor: string | null,
): ResourceListPage => ({ items, breadcrumbs: [], nextCursor });

test("自动跨过纯文件页直到发现目录", async () => {
  const pages = new Map<string | null, ResourceListPage>([
    [null, page([item("a", "annotation_file")], "next")],
    ["next", page([item("folder", "folder")], null)],
  ]);
  const result = await collectDestinationContainers(async (cursor) => pages.get(cursor)!, null);
  assert.deepEqual(result.items.map(({ id }) => id), ["folder"]);
  assert.equal(result.nextCursor, null);
});

test("有限扫描耗尽预算后保留 cursor", async () => {
  let calls = 0;
  const result = await collectDestinationContainers(async (cursor) => {
    calls += 1;
    return page([item(`file-${calls}`, "media_file")], `${cursor ?? "root"}-${calls}`);
  }, null, 2);
  assert.equal(calls, 2);
  assert.equal(result.items.length, 0);
  assert.ok(result.nextCursor);
});
