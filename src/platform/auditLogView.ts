import type {
  AuditActionName,
  AuditLogEntry,
  UserReference,
} from "@xiqu/shared";

// 中文动作标签是审计 UI 的唯一翻译表；未知未来动作由调用方回退原始值。
export const AUDIT_ACTION_LABELS: Record<AuditActionName, string> = {
  auth_login: "账号登录",
  account_create: "创建账号",
  account_update: "更新账号",
  account_password_reset: "管理员重置密码",
  account_password_change: "账号修改密码",
  file_upload: "文件上传",
  media_upload: "媒体上传",
  aliyun_vod_media_create: "接入阿里云 VOD",
  resource_create: "新建资源",
  resource_update: "更新资源",
  resource_copy: "复制资源",
  resource_move: "移动资源",
  resource_trash: "移入回收站",
  resource_restore: "恢复资源",
  resource_delete: "删除资源",
  annotation_file_save: "保存标注",
  annotation_client_sync_failure: "客户端同步失败",
  annotation_mutation_lease_acquire: "取得结构变更租约",
  annotation_mutation_lease_renew: "续期结构变更租约",
  annotation_mutation_lease_release: "释放结构变更租约",
  annotation_snapshot_restore: "恢复标注快照",
  annotation_confirmation_create: "确认标注范围",
  annotation_confirmation_revoke: "撤销标注确认",
  annotation_range_comment_create: "创建范围评论",
  annotation_range_comment_withdraw: "撤回范围评论",
  resource_permission_upsert: "更新资源权限",
  resource_permission_remove: "移除资源权限",
  resource_inheritance_update: "更新权限继承",
  annotation_media_bind: "关联标注媒体",
  annotation_media_unbind: "解除标注媒体",
  annotation_analysis_audio_update: "更新分析音频来源",
  media_analysis_create: "创建媒体分析",
  job_create: "创建后台任务",
  permission_denied: "权限拒绝",
  storage_orphan_cleanup: "清理孤儿对象",
  maintenance_enable: "进入维护模式",
  maintenance_disable: "退出维护模式",
};

// 动作格式化保留未知字符串，后端新增 action 时旧前端仍能诚实展示。
export function formatAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditActionName] ?? action;
}

// 账号摘要优先显示人类可读名称，账号已删除时保留原始 id 供追溯。
export function formatAuditUser(
  user: UserReference | null | undefined,
  userId: string | null | undefined,
): string {
  if (user) return `${user.displayName} (${user.accountName})`;
  return userId ? `已不存在 · ${shortenIdentifier(userId)}` : "系统";
}

// 资源摘要在关系已被删除时仍显示审计行保存的资源 id。
export function formatAuditResource(entry: AuditLogEntry): string {
  if (entry.resource) return entry.resource.name;
  if (entry.resourceId) return `已不存在 · ${shortenIdentifier(entry.resourceId)}`;
  if (entry.fileId) return `文件对象 · ${shortenIdentifier(entry.fileId)}`;
  return "全局";
}

// detail 只生成有界单行摘要，完整 JSON 仍留在 CSV 导出，不撑高表格或制造大量 DOM。
export function summarizeAuditDetail(detail: unknown, maximum = 180): string {
  if (detail === null || detail === undefined) return "";
  let serialized = "";
  try {
    serialized = typeof detail === "string"
      ? detail
      : JSON.stringify(detail);
  } catch {
    return "无法显示详情";
  }
  const singleLine = serialized.replace(/\s+/g, " ").trim();
  return singleLine.length > maximum
    ? `${singleLine.slice(0, maximum - 1)}…`
    : singleLine;
}

// 本地时间用于操作台扫描；完整 ISO 时间保留在 title 和导出文件中。
export function formatAuditTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

// 长 UUID 在紧凑表格中只显示两端，完整值仍可从导出取得。
function shortenIdentifier(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}
