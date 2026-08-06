import { PlatformApiError } from "../api/platformClient";

export const PLATFORM_MAINTENANCE_ERROR_CODE = "maintenance_mode";

export const PLATFORM_MAINTENANCE_SAVE_ERROR_MESSAGE =
  "服务器正在维护，当前修改暂时无法自动保存到服务器；本地恢复草稿将继续保留。";

// 维护错误既可能位于标准 error code，也可能由旧接口放在 details.code 中；两种合同都要稳定识别。
export function isPlatformMaintenanceError(error: unknown): boolean {
  if (!(error instanceof PlatformApiError)) return false;
  if (error.code === PLATFORM_MAINTENANCE_ERROR_CODE) return true;
  if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) return false;
  return (error.details as { code?: unknown }).code === PLATFORM_MAINTENANCE_ERROR_CODE;
}
