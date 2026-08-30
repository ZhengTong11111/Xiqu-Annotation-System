import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createAbortableObjectBatchStream } from "../src/abortableHttpStream.js";
import { abortReadableOnSignal } from "../src/abortableHttpStream.js";

test("批量对象流按顺序输出 manifest 与对象内容", async () => {
  const opened: string[] = [];
  const stream = createAbortableObjectBatchStream({
    header: Buffer.from("header:"),
    assets: [{ storageKey: "first" }, { storageKey: "second" }],
    storage: {
      getObjectStream: async (storageKey) => {
        opened.push(storageKey);
        return Readable.from([Buffer.from(storageKey)]);
      },
    },
    signal: new AbortController().signal,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "header:firstsecond");
  assert.deepEqual(opened, ["first", "second"]);
});

test("客户端取消会销毁当前对象流并阻止打开后续对象", async () => {
  const controller = new AbortController();
  const activeObject = new PassThrough();
  const opened: string[] = [];
  const stream = createAbortableObjectBatchStream({
    header: Buffer.from("header"),
    assets: [{ storageKey: "first" }, { storageKey: "second" }],
    storage: {
      getObjectStream: async (storageKey) => {
        opened.push(storageKey);
        return activeObject;
      },
    },
    signal: controller.signal,
  });
  const capturedErrors: Error[] = [];
  stream.on("error", (error: Error) => capturedErrors.push(error));
  stream.resume();
  await waitFor(() => opened.length === 1);
  controller.abort();
  await new Promise<void>((resolve) => stream.once("close", resolve));
  assert.equal(activeObject.destroyed, true);
  assert.deepEqual(opened, ["first"]);
  assert.deepEqual(capturedErrors, []);
});

test("单对象流在 Range seek 中止后立即销毁", async () => {
  const controller = new AbortController();
  const objectStream = new PassThrough();
  const errors: Error[] = [];
  objectStream.on("error", (error: Error) => errors.push(error));
  abortReadableOnSignal(objectStream, controller.signal);
  controller.abort();
  await new Promise<void>((resolve) => objectStream.once("close", resolve));
  assert.equal(objectStream.destroyed, true);
  assert.deepEqual(errors, []);
});

test("一百个快速跳转批次全部回收且不继续读取下一瓦片", async () => {
  const controllers = Array.from({ length: 100 }, () => new AbortController());
  const activeObjects: PassThrough[] = [];
  let openedCount = 0;
  const streams = controllers.map((controller) => {
    const stream = createAbortableObjectBatchStream({
      header: Buffer.from("h"),
      assets: [{ storageKey: "visible" }, { storageKey: "stale" }],
      storage: {
        getObjectStream: async () => {
          openedCount += 1;
          const objectStream = new PassThrough();
          activeObjects.push(objectStream);
          return objectStream;
        },
      },
      signal: controller.signal,
    });
    stream.resume();
    return stream;
  });
  const closed = streams.map((stream) =>
    new Promise<void>((resolve) => stream.once("close", resolve)));
  await waitFor(() => openedCount === controllers.length);
  controllers.forEach((controller) => controller.abort());
  await Promise.all(closed);
  assert.equal(openedCount, controllers.length);
  assert.equal(activeObjects.every((stream) => stream.destroyed), true);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待对象流打开超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
