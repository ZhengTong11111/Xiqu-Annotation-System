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
  | "write_gate_busy"
  | "external_media_unavailable"
  | "external_service_unavailable"
  | "analysis_source_missing"
  | "analysis_audio_forbidden"
  | "analysis_tool_unavailable"
  | "analysis_failed"
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

// 写许可池或维护切换暂时繁忙时返回可重试 503，避免调用方把基础设施反压误判为 revision 冲突。
export function writeGateBusy(message: string, details: unknown = undefined) {
  return new HttpError(503, "write_gate_busy", message, details);
}

// 外部媒资不可用与供应商服务故障分开编码，便于客户端区分换资源和稍后重试。
export function externalMediaUnavailable(
  message: string,
  details: unknown = undefined,
) {
  return new HttpError(409, "external_media_unavailable", message, details);
}

export function externalServiceUnavailable(
  message: string,
  details: unknown = undefined,
) {
  return new HttpError(503, "external_service_unavailable", message, details);
}

export function analysisSourceMissing(message: string, details: unknown = undefined) {
  return new HttpError(409, "analysis_source_missing", message, details);
}

export function analysisAudioForbidden(message: string, details: unknown = undefined) {
  return new HttpError(403, "analysis_audio_forbidden", message, details);
}
