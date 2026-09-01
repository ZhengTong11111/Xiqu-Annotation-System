import assert from "node:assert/strict";
import test from "node:test";
import { drainAnnotationReviewPages } from "./annotationReviewPageDrain";

type TestRecord = { id: string; value: string };

test("完整加载按服务端游标逐页读取并去除分页边界重复项", async () => {
  const requestedCursors: string[] = [];
  const result = await drainAnnotationReviewPages<TestRecord>({
    initialPage: {
      currentRevision: 7,
      items: [{ id: "a", value: "首条" }],
      nextCursor: "cursor-1",
    },
    fetchPage: async (cursor) => {
      requestedCursors.push(cursor);
      if (cursor === "cursor-1") {
        return {
          currentRevision: 7,
          items: [
            { id: "a", value: "首条" },
            { id: "b", value: "第二条" },
          ],
          nextCursor: "cursor-2",
        };
      }
      return {
        currentRevision: 7,
        items: [{ id: "c", value: "第三条" }],
        nextCursor: null,
      };
    },
  });

  assert.deepEqual(requestedCursors, ["cursor-1", "cursor-2"]);
  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result.nextCursor, null);
});

test("服务端重复返回同一游标时立即停止，避免无限请求", async () => {
  let requestCount = 0;
  await assert.rejects(
    drainAnnotationReviewPages<TestRecord>({
      initialPage: { currentRevision: 1, items: [], nextCursor: "loop" },
      fetchPage: async () => {
        requestCount += 1;
        return { currentRevision: 1, items: [], nextCursor: "loop" };
      },
    }),
    /分页游标发生循环/,
  );
  assert.equal(requestCount, 1);
});

test("分页请求失败时向调用方传播错误，不伪装成完整历史", async () => {
  await assert.rejects(
    drainAnnotationReviewPages<TestRecord>({
      initialPage: { currentRevision: 2, items: [], nextCursor: "next" },
      fetchPage: async () => {
        throw new Error("temporary failure");
      },
    }),
    /temporary failure/,
  );
});
