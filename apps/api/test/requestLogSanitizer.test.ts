import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";
import {
  createSafeFastifyLoggerConfiguration,
  createSafeRequestLoggerOptions,
  sanitizeRequestUrlForLogging,
} from "../src/requestLogSanitizer.js";

// 纯函数先覆盖正常 URL 的参数保留与目标凭据替换。
test("redacts access_token while retaining the request route and other query values", () => {
  assert.equal(
    sanitizeRequestUrlForLogging(
      "/api/files/file-1/content?access_token=xiqu_secret&download=true",
    ),
    "/api/files/file-1/content?access_token=%5BRedacted%5D&download=true",
  );
});

// 编码参数名和解析回退必须同样 fail closed，普通 URL 则保持字节语义不变。
test("redacts encoded access_token parameter names and leaves unrelated URLs unchanged", () => {
  assert.equal(
    sanitizeRequestUrlForLogging("/api/resources?%61ccess_token=xiqu_secret"),
    "/api/resources?access_token=%5BRedacted%5D",
  );
  assert.equal(
    sanitizeRequestUrlForLogging("/api/resources?cursor=next"),
    "/api/resources?cursor=next",
  );
});

// 自定义 level/stream 是集成测试和部署常用入口；真实 Fastify 请求日志也不得绕过安全 serializer。
test("custom Fastify logger options still redact request credentials", async () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const app = Fastify({
    logger: createSafeRequestLoggerOptions(
      { level: "info", stream },
      "info",
    ),
  });
  app.get("/probe", async () => ({ ok: true }));
  await app.inject({
    method: "GET",
    url: "/probe?access_token=xiqu_custom_logger_secret&cursor=next",
  });
  await app.close();

  const output = chunks.join("");
  assert.doesNotMatch(output, /xiqu_custom_logger_secret/);
  assert.match(output, /access_token=%5BRedacted%5D&cursor=next/);
});

// 历史 logger instance 入口必须保留原 destination，同时让安全 child 覆盖可能泄密的请求 serializer。
test("custom Fastify logger instances still redact request credentials", async () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const loggerOwner = Fastify({ logger: { level: "info", stream } });
  const app = Fastify({
    ...createSafeFastifyLoggerConfiguration(loggerOwner.log, "info"),
  });
  app.get("/probe", async () => ({ ok: true }));
  await app.inject({
    method: "GET",
    url: "/probe?access_token=xiqu_logger_instance_secret&cursor=next",
  });
  await app.close();
  await loggerOwner.close();

  const output = chunks.join("");
  assert.doesNotMatch(output, /xiqu_logger_instance_secret/);
  assert.match(output, /access_token=%5BRedacted%5D&cursor=next/);
});
