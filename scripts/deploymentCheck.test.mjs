import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedNodeVersion,
  parseDeploymentCheckArguments,
  runDeploymentCheck,
  validateHealthPayload,
} from "./deploymentCheck.mjs";

test("部署参数要求纯 origin 并限制超时", () => {
  assert.deepEqual(
    parseDeploymentCheckArguments([
      "--base-url",
      "https://annotation.example.org/",
      "--timeout-ms",
      "1500",
    ]),
    { baseUrl: "https://annotation.example.org", timeoutMs: 1500 },
  );
  assert.throws(() => parseDeploymentCheckArguments([]), /--base-url/);
  assert.throws(
    () => parseDeploymentCheckArguments(["--base-url", "https://example.org/app"]),
    /纯 HTTP\(S\) origin/,
  );
  assert.throws(
    () => parseDeploymentCheckArguments(["--base-url", "https://example.org", "--timeout-ms", "50"]),
    /--timeout-ms/,
  );
  assert.deepEqual(
    parseDeploymentCheckArguments([
      "--base-url=https://annotation.example.org",
      "--timeout-ms=2000",
    ]),
    { baseUrl: "https://annotation.example.org", timeoutMs: 2000 },
  );
});

test("运行时版本检查拒绝 Node 22 以下版本", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.18.0"));
  assert.throws(() => assertSupportedNodeVersion("20.19.0"), /Node.js 22/);
});

test("健康响应必须使用平台 envelope、服务名和预期状态", () => {
  assert.doesNotThrow(() => validateHealthPayload({
    data: { status: "ready", service: "xiqu-platform-api" },
  }, "ready", "API readiness"));
  assert.throws(
    () => validateHealthPayload({ status: "ready" }, "ready", "API readiness"),
    /data envelope/,
  );
  assert.throws(
    () => validateHealthPayload({
      data: { status: "ready", service: "another-service" },
    }, "ready", "API readiness"),
    /错误服务/,
  );
});

test("完整 smoke check 只访问首页和两个健康端点", async () => {
  const visited = [];
  const fetchImplementation = async (url) => {
    visited.push(url);
    if (url.endsWith("/")) {
      return new Response('<!doctype html><div id="root"></div>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const status = url.endsWith("/live") ? "ok" : "ready";
    return Response.json({ data: { status, service: "xiqu-platform-api" } });
  };
  const results = await runDeploymentCheck({
    baseUrl: "https://annotation.example.org",
    fetchImplementation,
  });
  assert.equal(results.length, 3);
  assert.deepEqual(visited, [
    "https://annotation.example.org/",
    "https://annotation.example.org/api/health/live",
    "https://annotation.example.org/api/health/ready",
  ]);
});

test("readiness 非 2xx 时部署检查整体失败", async () => {
  const fetchImplementation = async (url) => {
    if (url.endsWith("/")) {
      return new Response('<div id="root"></div>', {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.endsWith("/live")) {
      return Response.json({ data: { status: "ok", service: "xiqu-platform-api" } });
    }
    return Response.json(
      { data: { status: "unavailable", service: "xiqu-platform-api" } },
      { status: 503 },
    );
  };
  await assert.rejects(
    () => runDeploymentCheck({ baseUrl: "https://annotation.example.org", fetchImplementation }),
    /readiness 返回 HTTP 503/,
  );
});
