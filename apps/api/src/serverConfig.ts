import { isIP } from "node:net";
import type { AliyunVodWebPlayerLicense } from "@xiqu/shared";

const DEFAULT_DEVELOPMENT_DATABASE_URL =
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";
const DEFAULT_API_PORT = 4317;

export type ApiCorsOriginPolicy = true | false | string[];

export type AliyunVodRuntimeConfig =
  | { enabled: false; region: null; webPlayerLicense: null }
  | {
      enabled: true;
      region: string;
      webPlayerLicense: AliyunVodWebPlayerLicense | null;
    };

export type ApiServerRuntimeConfig = {
  port: number;
  host: string;
  databaseUrl: string;
  seedDevelopmentData: boolean;
  corsOrigin: ApiCorsOriginPolicy;
  aliyunVod: AliyunVodRuntimeConfig;
  forceAlignmentRequestsEnabled: boolean;
};

/**
 * 解析 API 进程的启动配置。
 *
 * 生产环境在这里统一 fail closed，避免 server、测试和部署脚本各自解释环境变量，最终产生不同的安全默认值。
 */
export function loadApiServerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiServerRuntimeConfig {
  const production = environment.NODE_ENV === "production";
  return {
    port: parsePort(environment.PORT),
    host: parseHost(environment.HOST, production),
    databaseUrl: parseDatabaseUrl(environment.DATABASE_URL, production),
    seedDevelopmentData: parseStrictBoolean(
      "XIQU_SEED_DEVELOPMENT_DATA",
      environment.XIQU_SEED_DEVELOPMENT_DATA,
      !production,
    ),
    corsOrigin: parseCorsOrigins(environment.XIQU_CORS_ORIGINS, production),
    aliyunVod: parseAliyunVodConfig(environment),
    // D2c 执行器接入前保持关闭；显式 true 才允许创建可被 worker 消费的任务。
    forceAlignmentRequestsEnabled: parseStrictBoolean(
      "XIQU_FORCE_ALIGNMENT_REQUESTS_ENABLED",
      environment.XIQU_FORCE_ALIGNMENT_REQUESTS_ENABLED,
      false,
    ),
  };
}

// VOD 是否启用必须显式声明；region 是可公开配置，凭据则完全交给阿里云默认凭据链。
function parseAliyunVodConfig(
  environment: NodeJS.ProcessEnv,
): AliyunVodRuntimeConfig {
  const enabled = parseStrictBoolean(
    "XIQU_ALIYUN_VOD_ENABLED",
    environment.XIQU_ALIYUN_VOD_ENABLED,
    false,
  );
  if (!enabled) return { enabled: false, region: null, webPlayerLicense: null };

  const region = environment.XIQU_ALIYUN_VOD_REGION?.trim() ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region) || region.length > 64) {
    throw new Error("启用阿里云 VOD 时必须提供有效的 XIQU_ALIYUN_VOD_REGION。");
  }
  return {
    enabled: true,
    region,
    webPlayerLicense: parseAliyunVodWebPlayerLicense(environment),
  };
}

/**
 * Web License 会发送给浏览器，不属于 AccessKey 一类服务端秘密；但仍由部署配置统一提供，
 * 避免账号专属授权信息被硬编码进前端包。domain/key 必须成对出现，缺一项时启动即失败。
 */
function parseAliyunVodWebPlayerLicense(
  environment: NodeJS.ProcessEnv,
): AliyunVodWebPlayerLicense | null {
  const rawDomain = environment.XIQU_ALIYUN_VOD_WEB_LICENSE_DOMAIN;
  const rawKey = environment.XIQU_ALIYUN_VOD_WEB_LICENSE_KEY;
  if (rawDomain === undefined && rawKey === undefined) return null;
  if (rawDomain === undefined || rawKey === undefined) {
    throw new Error(
      "XIQU_ALIYUN_VOD_WEB_LICENSE_DOMAIN 与 XIQU_ALIYUN_VOD_WEB_LICENSE_KEY 必须同时设置。",
    );
  }

  const domain = rawDomain.trim().toLowerCase();
  const key = rawKey.trim();
  const isHostname = domain === "localhost" ||
    isIP(domain) !== 0 ||
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain);
  if (!isHostname) {
    throw new Error(
      "XIQU_ALIYUN_VOD_WEB_LICENSE_DOMAIN 只能填写不含协议、端口、路径或通配符的域名/IP。",
    );
  }
  if (!key || key.length > 2_048 || /\s/.test(key)) {
    throw new Error("XIQU_ALIYUN_VOD_WEB_LICENSE_KEY 格式不正确。");
  }
  return { domain, key };
}

// 生产默认只监听 loopback；需要容器或内网监听时必须显式给出 IP，不能依赖含糊 DNS 名称。
function parseHost(rawValue: string | undefined, production: boolean) {
  if (rawValue === undefined) return production ? "127.0.0.1" : "0.0.0.0";
  const host = rawValue.trim();
  if (!host || isIP(host) === 0) {
    throw new Error("HOST 必须是有效的 IPv4 或 IPv6 地址。");
  }
  return host;
}

// 端口必须在操作系统可监听范围内；Number("abc")/小数/空字符串都不能静默进入 Fastify。
function parsePort(rawValue: string | undefined) {
  if (rawValue === undefined) return DEFAULT_API_PORT;
  if (!rawValue.trim()) throw new Error("PORT 不能为空。");
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数。");
  }
  return port;
}

// 开发环境保留开箱即用的本机数据库；生产环境必须由部署者明确绑定数据库。
function parseDatabaseUrl(rawValue: string | undefined, production: boolean) {
  if (rawValue === undefined) {
    if (production) throw new Error("生产环境必须显式设置 DATABASE_URL。");
    return DEFAULT_DEVELOPMENT_DATABASE_URL;
  }
  const databaseUrl = rawValue.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL 不能为空。");
  return databaseUrl;
}

// 安全开关只接受完整 true/false，避免 yes、1 或拼写错误被误判为已关闭。
function parseStrictBoolean(
  name: string,
  rawValue: string | undefined,
  fallback: boolean,
) {
  if (rawValue === undefined) return fallback;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${name} 只接受 true 或 false。`);
}

/**
 * 同源生产部署默认不注册 CORS；显式跨源部署只能提供有限的 HTTP(S) origin 列表。
 * 通配符与 credentials 组合并不安全，因此这里主动拒绝，而不是交给运行时模糊处理。
 */
function parseCorsOrigins(
  rawValue: string | undefined,
  production: boolean,
): ApiCorsOriginPolicy {
  if (rawValue === undefined) return production ? false : true;
  if (!rawValue.trim()) throw new Error("XIQU_CORS_ORIGINS 不能为空。");

  const origins = rawValue.split(",").map((value) => value.trim());
  const normalized = origins.map((origin) => normalizeCorsOrigin(origin));
  return [...new Set(normalized)];
}

function normalizeCorsOrigin(rawOrigin: string) {
  if (!rawOrigin || rawOrigin === "*") {
    throw new Error("XIQU_CORS_ORIGINS 不允许空 origin 或通配符 *。");
  }
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error(`XIQU_CORS_ORIGINS 包含无效 origin：${rawOrigin}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin === "null"
  ) {
    throw new Error(`XIQU_CORS_ORIGINS 只能包含纯 HTTP(S) origin：${rawOrigin}`);
  }
  return url.origin;
}
