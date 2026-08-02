import type { ObjectStorage } from "./objectStorage.js";
import { S3ObjectStorage, type S3ObjectStorageOptions } from "./s3ObjectStorage.js";
import { LocalObjectStorage } from "./storage.js";

// composition root 通过显式 backend 选择唯一生产实现；未知值 fail closed，不能悄悄把远端配置写回本地。
export function createObjectStorageFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ObjectStorage {
  const configured = environment.XIQU_OBJECT_STORAGE_BACKEND;
  const backend = configured === undefined ? "local" : configured.trim();
  if (backend === "local") {
    return new LocalObjectStorage(environment.XIQU_STORAGE_ROOT);
  }
  if (backend === "s3") {
    return new S3ObjectStorage(parseS3Options(environment));
  }
  throw new Error(
    `不支持对象存储后端“${backend || "<empty>"}”；当前可用值为 local、s3。`,
  );
}

// S3 配置在 client 构造前一次校验，错误只指出字段名，不回显任何凭据值。
function parseS3Options(environment: NodeJS.ProcessEnv): S3ObjectStorageOptions {
  const bucket = requireEnvironmentValue(environment, "XIQU_S3_BUCKET");
  const region = requireEnvironmentValue(environment, "XIQU_S3_REGION");
  const accessKeyId = requireEnvironmentValue(environment, "XIQU_S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnvironmentValue(environment, "XIQU_S3_SECRET_ACCESS_KEY");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("XIQU_S3_BUCKET 不是有效的 S3 bucket 名称。");
  }
  const endpoint = parseOptionalEndpoint(environment.XIQU_S3_ENDPOINT);
  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBoolean(
      environment.XIQU_S3_FORCE_PATH_STYLE,
      endpoint !== undefined,
      "XIQU_S3_FORCE_PATH_STYLE",
    ),
    prefix: environment.XIQU_S3_PREFIX?.trim() || undefined,
  };
}

// 必填值统一拒绝未配置和纯空白，避免 SDK 在首次请求时才暴露模糊认证错误。
function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`缺少对象存储配置 ${name}。`);
  return value;
}

// 自托管 endpoint 只接受无凭据的 HTTP(S) URL，秘密必须使用专用环境变量传入。
function parseOptionalEndpoint(rawValue: string | undefined) {
  const value = rawValue?.trim();
  if (!value) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("XIQU_S3_ENDPOINT 不是有效 URL。");
  }
  if (!(["http:", "https:"] as string[]).includes(endpoint.protocol) ||
    endpoint.username || endpoint.password) {
    throw new Error("XIQU_S3_ENDPOINT 必须是无内嵌凭据的 HTTP(S) URL。");
  }
  return endpoint.toString().replace(/\/$/, "");
}

// 布尔环境变量只接受 true/false，拼写错误不能静默改变寻址方式。
function parseBoolean(rawValue: string | undefined, fallback: boolean, name: string) {
  if (rawValue === undefined) return fallback;
  const value = rawValue.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} 只能是 true 或 false。`);
}
