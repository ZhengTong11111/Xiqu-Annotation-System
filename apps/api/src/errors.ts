export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upload_too_large"
  | "unsupported_media"
  | "storage_quota_exceeded"
  | "permission_scope_violation"
  | "maintenance_mode"
  | "internal_error";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details: unknown = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details: unknown = undefined) {
  return new HttpError(400, "bad_request", message, details);
}

export function unauthorized(message = "请先登录。") {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "当前账号没有执行此操作的权限。") {
  return new HttpError(403, "forbidden", message);
}

export function permissionScopeViolation(message: string, details: unknown) {
  return new HttpError(403, "permission_scope_violation", message, details);
}

export function notFound(message: string) {
  return new HttpError(404, "not_found", message);
}

export function conflict(message: string, details: unknown = undefined) {
  return new HttpError(409, "conflict", message, details);
}

// 上传错误使用稳定 code，前端无需从中文文案猜测失败类型。
export function uploadTooLarge(message: string, details: unknown = undefined) {
  return new HttpError(413, "upload_too_large", message, details);
}

export function unsupportedMedia(message: string, details: unknown = undefined) {
  return new HttpError(400, "unsupported_media", message, details);
}

export function storageQuotaExceeded(
  message: string,
  details: unknown = undefined,
) {
  return new HttpError(409, "storage_quota_exceeded", message, details);
}

// 维护状态拒绝新写入但保留读取，503 表示调用方可在维护结束后安全重试。
export function maintenanceMode(message: string, details: unknown = undefined) {
  return new HttpError(503, "maintenance_mode", message, details);
}
