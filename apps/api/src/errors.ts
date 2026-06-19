export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
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

export function notFound(message: string) {
  return new HttpError(404, "not_found", message);
}

export function conflict(message: string, details: unknown = undefined) {
  return new HttpError(409, "conflict", message, details);
}
