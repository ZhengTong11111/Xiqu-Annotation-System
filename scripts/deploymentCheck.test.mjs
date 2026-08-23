import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

// 本地开发命令必须消费 README 要求创建的 .env，避免 API 与 worker 静默退回默认配置。
test("本地后端开发命令统一读取根目录环境文件", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  for (const scriptName of ["dev:api", "dev:analysis-worker"]) {
    const script = packageJson.scripts?.[scriptName];
    assert.equal(typeof script, "string");
    assert.match(script, /node --env-file-if-exists=\.env --import tsx/);
  }
});

// 生产 release 不复制 apps/ TypeScript 源码，所有运维命令必须只依赖已验收的 dist 产物。
test("生产维护与备份命令只调用编译后 CLI", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const operationScripts = Object.entries(packageJson.scripts ?? {})
    .filter(([name]) => name.startsWith("maintenance:") || name.startsWith("backup:"));
  assert.ok(operationScripts.length > 0);
  for (const [name, script] of operationScripts) {
    assert.equal(typeof script, "string", `${name} 必须是可执行脚本`);
    assert.match(script, /^node dist\/api\/backup\/cli\.js\s/u, `${name} 不能依赖生产 release 外的源码`);
    assert.doesNotMatch(script, /\btsx\b|apps\/api\/src/u);
  }
});

// Prisma 7 配置和 npm workspace 产物都是生产运行时依赖，部署清单缺项会导致 migration 或服务启动失败。
test("单服务器 release 清单包含 Prisma 配置与 workspace 构建产物", async () => {
  const deploymentGuide = await readFile(
    new URL("../docs/server-deployment.md", import.meta.url),
    "utf8",
  );
  const releaseCopyCommand = deploymentGuide.match(
    /sudo cp -a ([\s\S]*?)\s+"\/opt\/xiqu\/releases\/\$RELEASE_ID\/"/u,
  )?.[1];
  assert.equal(typeof releaseCopyCommand, "string");
  for (const requiredPath of [
    "package.json",
    "package-lock.json",
    "prisma.config.ts",
    "prisma",
    "packages",
    "dist",
    "node_modules",
  ]) {
    assert.match(releaseCopyCommand, new RegExp(`(?:^|\\s)${requiredPath.replace(".", "\\.")}(?:\\s|$)`));
  }
});

// 锁文件不变并不代表 Prisma Client 可复用；schema 变更必须进入构建和候选切换门禁。
test("生产构建与候选 release 都校验 Prisma Client schema", async () => {
  const [packageJsonText, deploymentGuide] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/server-deployment.md", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  assert.match(
    packageJson.scripts?.build ?? "",
    /db:generate && npm run prisma:check-generated/u,
  );
  assert.equal(
    packageJson.scripts?.["release:check"],
    "node dist/api/prismaClientSchemaGuardCli.js",
  );
  assert.match(deploymentGuide, /npm run release:check/u);
  assert.match(deploymentGuide, /不能只因 `package-lock\.json` 未变化/u);
});

// 对象恢复通过同级 staging 原子发布，手册必须先提供服务账号可写的专用父目录。
test("恢复演练示例为原子 staging 提供可写父目录", async () => {
  const deploymentGuide = await readFile(
    new URL("../docs/server-deployment.md", import.meta.url),
    "utf8",
  );
  assert.match(
    deploymentGuide,
    /install -d -o xiqu -g xiqu -m 750 \/var\/lib\/xiqu-platform\/restore-drill\n/u,
  );
  assert.match(
    deploymentGuide,
    /--target-storage \/var\/lib\/xiqu-platform\/restore-drill\/storage/u,
  );
  assert.doesNotMatch(deploymentGuide, /--target-storage \/var\/lib\/xiqu-platform\/restore-drill-storage/u);
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

// 单服务器模板必须提供一致的应用层和代理层上限，防止大文件在 Nginx 提前收到 413。
test("单服务器环境与 Nginx 模板使用相同上传上限", async () => {
  const [environment, nginx] = await Promise.all([
    readFile(new URL("../deploy/single-server/xiqu-platform.env.example", import.meta.url), "utf8"),
    readFile(new URL("../deploy/single-server/nginx.conf.example", import.meta.url), "utf8"),
  ]);
  const environmentBytes = Number(
    environment.match(/^XIQU_MAX_UPLOAD_BYTES=(\d+)$/m)?.[1],
  );
  const nginxMatch = nginx.match(/client_max_body_size\s+(\d+)([mg]);/i);
  assert.ok(Number.isSafeInteger(environmentBytes) && environmentBytes > 0);
  assert.ok(nginxMatch);
  const nginxUnitBytes = nginxMatch[2]?.toLowerCase() === "g"
    ? 1024 * 1024 * 1024
    : 1024 * 1024;
  const nginxBytes = Number(nginxMatch[1]) * nginxUnitBytes;
  assert.equal(nginxBytes, environmentBytes);
});

// 冷加载加速依赖代理层对单瓦片和批量响应流式压缩，不能只在开发服务器中偶然生效。
test("单服务器 Nginx 模板压缩全部媒体分析 MIME", async () => {
  const nginx = await readFile(
    new URL("../deploy/single-server/nginx.conf.example", import.meta.url),
    "utf8",
  );
  assert.match(nginx, /gzip\s+on;/u);
  for (const mimeType of [
    "application/vnd.xiqu.waveform-tile",
    "application/vnd.xiqu.spectrogram-tile",
    "application/vnd.xiqu.pitch-tile",
    "application/vnd.xiqu.media-analysis-batch",
  ]) {
    assert.match(nginx, new RegExp(mimeType.replaceAll(".", "\\."), "u"));
  }
});
