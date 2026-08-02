import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { badRequest, unsupportedMedia } from "./errors.js";

const GIB = 1024 * 1024 * 1024;
const MAX_DATABASE_FILE_BYTES = 2_000_000_000;

export type UploadPolicy = {
  maxUploadBytes: number;
  userQuotaBytes: number;
  platformQuotaBytes: number;
  orphanGraceMs: number;
};

export type DetectedMedia = {
  extension: string;
  mimeType: string;
};

// 签名检测结果与用户文件名允许使用的扩展名集中维护，避免 route 与 storage 各自放宽规则。
const MEDIA_EXTENSION_ALIASES: Record<string, ReadonlySet<string>> = {
  mp4: new Set(["mp4", "m4v", "m4a"]),
  m4a: new Set(["m4a", "mp4"]),
  m4v: new Set(["m4v", "mp4"]),
  mov: new Set(["mov"]),
  webm: new Set(["webm"]),
  mkv: new Set(["mkv"]),
  avi: new Set(["avi"]),
  mp3: new Set(["mp3"]),
  wav: new Set(["wav"]),
  flac: new Set(["flac"]),
  ogg: new Set(["ogg", "oga", "ogv", "opus"]),
  oga: new Set(["oga", "ogg"]),
  ogv: new Set(["ogv", "ogg"]),
  opus: new Set(["opus", "ogg"]),
  aac: new Set(["aac"]),
};

const ALLOWED_MEDIA_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/ogg",
  "audio/opus",
  "audio/aac",
  "audio/mp4",
]);

// 环境配置在应用启动时一次性校验，错误配置应阻止服务启动而不是悄悄回退。
export function loadUploadPolicy(
  overrides: Partial<UploadPolicy> = {},
): UploadPolicy {
  const policy = {
    maxUploadBytes: overrides.maxUploadBytes ?? readPositiveInteger(
      "XIQU_MAX_UPLOAD_BYTES",
      GIB,
    ),
    userQuotaBytes: overrides.userQuotaBytes ?? readPositiveInteger(
      "XIQU_USER_STORAGE_QUOTA_BYTES",
      20 * GIB,
    ),
    platformQuotaBytes: overrides.platformQuotaBytes ?? readPositiveInteger(
      "XIQU_PLATFORM_STORAGE_QUOTA_BYTES",
      200 * GIB,
    ),
    orphanGraceMs: overrides.orphanGraceMs ?? readPositiveInteger(
      "XIQU_ORPHAN_GRACE_MS",
      24 * 60 * 60 * 1000,
    ),
  };
  if (policy.maxUploadBytes > MAX_DATABASE_FILE_BYTES) {
    throw new Error(
      `XIQU_MAX_UPLOAD_BYTES 不能超过 ${MAX_DATABASE_FILE_BYTES}；当前数据库 size 尚未迁移为 BigInt。`,
    );
  }
  if (policy.userQuotaBytes > policy.platformQuotaBytes) {
    throw new Error("用户存储配额不能大于平台存储配额。");
  }
  return policy;
}

// 资源名既用于展示也用于扩展校验；禁止浏览器传入路径或控制字符。
export function normalizeUploadName(value: string) {
  const name = value.trim();
  if (
    !name ||
    name.length > 180 ||
    /[\/\\\0\u0001-\u001f\u007f]/.test(name) ||
    path.basename(name) !== name
  ) {
    throw badRequest("媒体名称不能为空、不能超过 180 字，且不能含路径或控制字符。");
  }
  return name;
}

// MIME 声明可被客户端伪造；这里只信任 file-type 从二进制签名得出的媒体类别。
export async function detectAndValidateMedia(
  name: string,
  header: Uint8Array,
): Promise<DetectedMedia> {
  const detected = await fileTypeFromBuffer(header);
  if (!detected || !ALLOWED_MEDIA_MIME_TYPES.has(detected.mime)) {
    throw unsupportedMedia("文件内容不是受支持的音频或视频格式。");
  }
  const extension = path.extname(name).slice(1).toLowerCase();
  const aliases = MEDIA_EXTENSION_ALIASES[detected.ext];
  if (!extension || !aliases?.has(extension)) {
    throw unsupportedMedia("文件扩展名与实际媒体内容不一致。", {
      detectedExtension: detected.ext,
    });
  }
  return { extension: detected.ext, mimeType: detected.mime };
}

// 数值环境变量禁止小数、零和非安全整数，防止容量边界因隐式转换失效。
function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正安全整数。`);
  }
  return value;
}
