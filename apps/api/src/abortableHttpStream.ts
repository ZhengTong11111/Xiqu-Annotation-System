import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

type BatchAsset = {
  storageKey: string;
};

type StreamStorage = {
  getObjectStream: (storageKey: string) => Promise<Readable>;
};

// 把客户端断开转换为 AbortSignal，供所有未来的分析/导出流复用，避免每个路由各写一套 close 判断。
export function bindHttpDisconnectSignal(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const controller = new AbortController();
  let disposed = false;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const handleResponseClose = () => {
    // 正常 finish 后也会 close；只有未完整写完的响应才代表客户端提前离开。
    if (!response.writableFinished) abort();
    dispose();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    request.off("aborted", abort);
    response.off("close", handleResponseClose);
    response.off("finish", dispose);
  };
  request.once("aborted", abort);
  response.once("close", handleResponseClose);
  response.once("finish", dispose);
  return { signal: controller.signal, dispose };
}

// 批量对象流逐项打开存储对象；取消会销毁当前对象流，并阻止继续打开后续瓦片。
export function createAbortableObjectBatchStream(input: {
  header: Uint8Array;
  assets: BatchAsset[];
  storage: StreamStorage;
  signal: AbortSignal;
}) {
  let activeObjectStream: Readable | null = null;
  let batchStream: Readable | null = null;
  const handleAbort = () => {
    // 客户端跳转属于正常控制流，无错误销毁可避免把大量主动取消误记成服务端 500。
    activeObjectStream?.destroy();
    batchStream?.destroy();
  };

  batchStream = Readable.from((async function* () {
    try {
      if (input.signal.aborted) return;
      yield Buffer.from(input.header);
      for (const asset of input.assets) {
        if (input.signal.aborted) return;
        const objectStream = await input.storage.getObjectStream(asset.storageKey);
        activeObjectStream = objectStream;
        try {
          if (input.signal.aborted) return;
          for await (const chunk of objectStream) {
            if (input.signal.aborted) return;
            yield chunk;
          }
        } finally {
          // 正常读完 destroy 是幂等的；异常/取消时确保底层文件或 HTTP 连接立即回收。
          objectStream.destroy();
          if (activeObjectStream === objectStream) activeObjectStream = null;
        }
      }
    } finally {
      input.signal.removeEventListener("abort", handleAbort);
      activeObjectStream?.destroy();
      activeObjectStream = null;
    }
  })());
  input.signal.addEventListener("abort", handleAbort, { once: true });
  if (input.signal.aborted) handleAbort();
  batchStream.once("close", () => {
    input.signal.removeEventListener("abort", handleAbort);
  });
  return batchStream;
}

// 单对象下载、Range 播放和单瓦片读取同样要响应断开，避免 seek/跳转后继续占用存储连接。
export function abortReadableOnSignal(stream: Readable, signal: AbortSignal) {
  const handleAbort = () => stream.destroy();
  signal.addEventListener("abort", handleAbort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", handleAbort));
  if (signal.aborted) handleAbort();
  return stream;
}

// 常规单对象响应共用“绑定断开 -> 打开对象 -> 关闭监听”的完整生命周期，路由只保留权限和响应头职责。
export async function openAbortableResponseStream(
  request: IncomingMessage,
  response: ServerResponse,
  open: () => Promise<Readable>,
) {
  const disconnect = bindHttpDisconnectSignal(request, response);
  try {
    const stream = abortReadableOnSignal(await open(), disconnect.signal);
    stream.once("close", disconnect.dispose);
    return stream;
  } catch (error) {
    disconnect.dispose();
    throw error;
  }
}
