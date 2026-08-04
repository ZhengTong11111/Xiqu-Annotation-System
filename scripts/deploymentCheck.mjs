const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 解析 smoke-check 参数。
 * 部署检查故意要求显式 base URL，避免操作员在错误环境上得到一份看似成功的报告。
 */
export function parseDeploymentCheckArguments(argumentsList) {
  let baseUrl;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    // npm 与运维脚本常使用 --name=value；两种标准长参数写法必须得到同一严格校验。
    if (argument.startsWith("--base-url=")) {
      baseUrl = argument.slice("--base-url=".length);
      continue;
    }
    if (argument.startsWith("--timeout-ms=")) {
      timeoutMs = Number(argument.slice("--timeout-ms=".length));
      continue;
    }
    if (argument === "--base-url") {
      baseUrl = argumentsList[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutMs = Number(argumentsList[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (!baseUrl) throw new Error("必须通过 --base-url 指定部署地址。");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("--timeout-ms 必须是 100 到 60000 之间的整数。");
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), timeoutMs };
}

// Node 22 是后端依赖和内置 fetch/AbortSignal.timeout 的共同运行时底线。
export function assertSupportedNodeVersion(version) {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`部署检查需要 Node.js 22 或更高版本，当前为 ${version}。`);
  }
}

/**
 * 依次检查静态站点、进程存活和外部依赖就绪。
 * 返回稳定摘要供 CLI 展示；任何一项失败都会抛错并使进程以非零状态退出。
 */
export async function runDeploymentCheck({
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImplementation = fetch,
}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const results = [];

  const page = await fetchWithTimeout(
    fetchImplementation,
    new URL("/", `${normalizedBaseUrl}/`).toString(),
    timeoutMs,
  );
  const html = await requireSuccessfulText(page, "Web 首页");
  const contentType = page.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html") || !/<div\s+id=["']root["']/.test(html)) {
    throw new Error("Web 首页未返回预期的 HTML 应用入口。");
  }
  results.push({ name: "Web 首页", status: page.status });

  for (const endpoint of [
    { name: "API liveness", path: "/api/health/live", expectedStatus: "ok" },
    { name: "API readiness", path: "/api/health/ready", expectedStatus: "ready" },
  ]) {
    const response = await fetchWithTimeout(
      fetchImplementation,
      new URL(endpoint.path, `${normalizedBaseUrl}/`).toString(),
      timeoutMs,
    );
    const payload = await requireSuccessfulJson(response, endpoint.name);
    validateHealthPayload(payload, endpoint.expectedStatus, endpoint.name);
    results.push({ name: endpoint.name, status: response.status });
  }
  return results;
}

// 健康接口经过 Fastify 统一 data envelope；smoke check 同时验证 envelope 和服务身份，防止代理到错误服务。
export function validateHealthPayload(payload, expectedStatus, label) {
  if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
    throw new Error(`${label} 未返回平台 data envelope。`);
  }
  if (
    payload.data.status !== expectedStatus ||
    payload.data.service !== "xiqu-platform-api"
  ) {
    throw new Error(`${label} 状态异常或指向了错误服务。`);
  }
}

function normalizeBaseUrl(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`部署地址无效：${rawValue}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base-url 必须是纯 HTTP(S) origin，不能包含凭据、路径、查询或片段。");
  }
  return url.origin;
}

async function fetchWithTimeout(fetchImplementation, url, timeoutMs) {
  try {
    return await fetchImplementation(url, {
      headers: { Accept: "application/json, text/html;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法访问 ${url}：${message}`);
  }
}

async function requireSuccessfulText(response, label) {
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}。`);
  return response.text();
}

async function requireSuccessfulJson(response, label) {
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}。`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} 未返回有效 JSON。`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
