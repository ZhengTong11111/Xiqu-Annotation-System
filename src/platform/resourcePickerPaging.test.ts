import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { collectResourcePickerItems } from "./resourcePickerPaging";

const item = (id: string, type: ResourceEntry["type"]) => ({ id, type }) as ResourceEntry;
const page = (
  items: ResourceEntry[],
  nextCursor: string | null,
  breadcrumbs: ResourceListPage["breadcrumbs"] = [],
): ResourceListPage => ({ items, breadcrumbs, nextCursor });

test("资源选择分页器跳过无关页并保留服务端顺序", async () => {
  const pages = new Map<string | null, ResourceListPage>([
    [null, page([item("annotation", "annotation_file")], "page-2")],
    ["page-2", page([
      item("folder", "folder"),
      item("media", "media_file"),
    ], null)],
  ]);
  const result = await collectResourcePickerItems(
    async (cursor) => pages.get(cursor)!,
    null,
    (resource) => resource.type === "folder" || resource.type === "media_file",
  );
  assert.deepEqual(result.items.map(({ id }) => id), ["folder", "media"]);
  assert.equal(result.nextCursor, null);
});

test("资源选择分页器在有限预算后保留 cursor 和首个面包屑", async () => {
  const breadcrumbs = [{ id: "project", parentId: null, type: "project", name: "项目" }] as ResourceListPage["breadcrumbs"];
  let calls = 0;
  const result = await collectResourcePickerItems(async (cursor) => {
    calls += 1;
    return page(
      [item(`annotation-${calls}`, "annotation_file")],
      `${cursor ?? "root"}-${calls}`,
      breadcrumbs,
    );
  }, null, (resource) => resource.type === "media_file", 2);
  assert.equal(calls, 2);
  assert.equal(result.items.length, 0);
  assert.ok(result.nextCursor);
  assert.deepEqual(result.breadcrumbs, breadcrumbs);
});
