import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
  abortReadableOnSignal,
  bindHttpDisconnectSignal,
  createAbortableObjectBatchStream,
  openAbortableResponseStream,
} from "../src/abortableHttpStream.js";

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

test("批量对象尚未打开完成时取消仍会回收迟到流", async () => {
  const controller = new AbortController();
  const delayedObject = new PassThrough();
  let resolveOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const opened: string[] = [];
  const stream = createAbortableObjectBatchStream({
    header: Buffer.from("header"),
    assets: [{ storageKey: "delayed" }, { storageKey: "never" }],
    storage: {
      getObjectStream: async (storageKey) => {
        opened.push(storageKey);
        await openGate;
        return delayedObject;
      },
    },
    signal: controller.signal,
  });
  stream.resume();
  await waitFor(() => opened.length === 1);
  controller.abort();
  resolveOpen();
  await once(stream, "close");
  await waitFor(() => delayedObject.destroyed);
  assert.deepEqual(opened, ["delayed"]);
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

test("对象仍在异步打开时客户端断开会销毁迟到流并清理监听", async () => {
  const request = new EventEmitter() as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  Object.defineProperty(response, "writableFinished", { value: false, configurable: true });
  const objectStream = new PassThrough();
  let resolveOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const opening = openAbortableResponseStream(request, response, async () => {
    await openGate;
    return objectStream;
  });

  request.emit("aborted");
  resolveOpen();
  const returned = await opening;
  await once(returned, "close");
  assert.equal(returned.destroyed, true);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("finish"), 0);
});

test("正常响应完成只清理断开监听而不误取消对象流", async () => {
  const request = new EventEmitter() as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  Object.defineProperty(response, "writableFinished", { value: true, configurable: true });
  const disconnect = bindHttpDisconnectSignal(request, response);
  response.emit("finish");
  assert.equal(disconnect.signal.aborted, false);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("finish"), 0);
});

test("对象打开失败会清理全部断开监听并保留原始错误", async () => {
  const request = new EventEmitter() as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  Object.defineProperty(response, "writableFinished", { value: false, configurable: true });
  await assert.rejects(
    openAbortableResponseStream(request, response, async () => {
      throw new Error("storage-open-failed");
    }),
    /storage-open-failed/,
  );
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("finish"), 0);
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
