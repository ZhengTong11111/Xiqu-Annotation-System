import type {
  FastifyBaseLogger,
  FastifyServerOptions,
} from "fastify";

// 请求日志安全常量集中定义，保证默认配置与注入 logger 使用完全相同的凭据边界。
const LOG_REDACTION_ORIGIN = "http://xiqu.invalid";
const REDACTED_QUERY_VALUE = "[Redacted]";
const REQUIRED_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
];

/**
 * 默认日志与调用方注入的 Pino 配置都必须经过同一安全装配边界。
 * `false` 仍可用于安静测试；其他配置会保留原有输出目标和额外脱敏规则，但请求 URL 序列化器不可覆盖。
 */
export function createSafeRequestLoggerOptions(
  configured: FastifyServerOptions["logger"],
  defaultLevel: string,
): FastifyServerOptions["logger"] {
  if (configured === false) return false;
  const options = configured && typeof configured === "object" ? configured : {};
  const configuredRedact = options.redact;
  const configuredRedactObject = configuredRedact && !Array.isArray(configuredRedact)
    ? configuredRedact
    : {};
  const configuredPaths = Array.isArray(configuredRedact)
    ? configuredRedact
    : configuredRedact?.paths ?? [];
  return {
    ...options,
    level: options.level ?? defaultLevel,
    redact: {
      ...configuredRedactObject,
      paths: [...new Set([...configuredPaths, ...REQUIRED_REDACTION_PATHS])],
      censor: REDACTED_QUERY_VALUE,
    },
    serializers: {
      ...options.serializers,
      req: serializeRequestForLogging,
    },
  };
}

/**
 * 兼容历史上允许注入 Fastify/Pino logger instance 的装配入口。
 * 实例不能重新创建以免丢失调用方的 destination；改用安全 child 覆盖请求 serializer。
 */
export function createSafeFastifyLoggerConfiguration(
  configured: FastifyServerOptions["logger"] | FastifyBaseLogger | undefined,
  defaultLevel: string,
): Pick<FastifyServerOptions, "logger" | "loggerInstance"> {
  if (isFastifyBaseLogger(configured)) {
    return {
      loggerInstance: configured.child({}, {
        serializers: { req: serializeRequestForLogging },
      }),
    };
  }
  return {
    logger: createSafeRequestLoggerOptions(configured, defaultLevel),
  };
}

/**
 * Fastify/Pino 的默认请求日志会记录完整 URL。媒体下载仍兼容历史查询参数鉴权时，
 * 必须在进入日志序列化器前移除凭据，避免 session token 落入 journald 或日志采集器。
 */
export function sanitizeRequestUrlForLogging(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, LOG_REDACTION_ORIGIN);
    if (!parsed.searchParams.has("access_token")) return rawUrl;
    parsed.searchParams.set("access_token", REDACTED_QUERY_VALUE);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // raw.url 正常情况下始终是合法 URL；解析失败时仍做保守的文本脱敏。
    return rawUrl.replace(
      /([?&]access_token=)[^&#]*/giu,
      `$1${REDACTED_QUERY_VALUE}`,
    );
  }
}

/** 把原始请求压缩成固定安全字段，并在任何日志输出前清理查询参数凭据。 */
function serializeRequestForLogging(request: {
  method?: string;
  url?: string;
  headers: { host?: string };
  socket: { remoteAddress?: string; remotePort?: number };
}) {
  return {
    method: request.method,
    url: sanitizeRequestUrlForLogging(request.url ?? ""),
    host: request.headers.host,
    remoteAddress: request.socket.remoteAddress,
    remotePort: request.socket.remotePort,
  };
}

/** 用 Fastify logger 的必需 child 能力区分实例与普通 Pino 配置对象。 */
function isFastifyBaseLogger(
  configured: FastifyServerOptions["logger"] | FastifyBaseLogger | undefined,
): configured is FastifyBaseLogger {
  return Boolean(
    configured &&
    typeof configured === "object" &&
    "child" in configured &&
    typeof configured.child === "function",
  );
}
