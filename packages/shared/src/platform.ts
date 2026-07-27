export type PlatformRole =
  | "super_admin"
  | "admin"
  | "teacher"
  | "ta"
  | "annotator"
  | "reviewer"
  | "service";

export type PermissionAction =
  | "view"
  | "edit"
  | "comment"
  | "submit"
  | "review"
  | "merge"
  | "confirm"
  | "manage";

export type AnnotationMode = "independent" | "collaborative";

export type TimeRangeScope = {
  startTime: number;
  endTime: number;
};

export type TrackScope = {
  trackIds: string[];
};

export type PermissionScope = {
  projectId?: string;
  documentId?: string;
  timeRange?: TimeRangeScope;
  trackScope?: TrackScope;
};

// PATCH 请求需要能够显式清空时间或轨道范围；undefined 表示“不修改”，null 表示“清空”。
export type MutablePermissionScope = {
  timeRange?: TimeRangeScope | null;
  trackScope?: TrackScope | null;
};

// 合并后可用于前端展示的紧凑范围。
export type MergedScope = {
  trackIds: string[];
  timeRanges: TimeRangeScope[];
};

// 有效权限摘要：前端不需要重新猜角色和 grant，后端仍以原始 user/grants 为最终可信输入。
export type EffectiveDocumentPermission = {
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
  isUnrestrictedViewer: boolean;
  isUnrestrictedEditor: boolean;
  isUnrestrictedManager: boolean;
  source: "admin" | "owner" | "grant" | "none";
  editScopes: MergedScope[];
  viewScopes: MergedScope[];
  manageScopes: MergedScope[];
};

// 保存差异描述：拆分整份 snapshot 的变动为可独立校验的 mutation。
export type ProjectMutation = {
  kind: string;
  action: "create" | "update" | "delete" | "move" | "structure";
  trackIds: string[];
  timeRange?: {
    startTime: number;
    endTime: number;
  };
  requiresManage: boolean;
  entityId?: string;
  summary?: string;
};

// 保存越权的错误响应中返回的违规摘要。
export type MutationScopeViolation = {
  kind: string;
  trackIds: string[];
  timeRange?: {
    startTime: number;
    endTime: number;
  };
};

// 用于 API 接收的 grant 操作请求。
export type CreateGrantRequest = {
  userId: string;
  actions: PermissionAction[];
  scope?: PermissionScope;
  expiresAt?: string | null;
};

export type UpdateGrantRequest = {
  actions?: PermissionAction[];
  scope?: MutablePermissionScope;
  expiresAt?: string | null;
};

export type GrantSummary = {
  id: string;
  userId: string;
  displayName?: string;
  accountName?: string;
  actions: PermissionAction[];
  scope: PermissionScope;
  expiresAt?: string | null;
  createdAt: string;
};

export type PermissionGrant = {
  id: string;
  userId: string;
  actions: PermissionAction[];
  scope: PermissionScope;
  expiresAt?: string | null;
  createdAt: string;
};

export type PlatformUser = {
  id: string;
  displayName: string;
  accountName: string;
  roles: PlatformRole[];
};

export type CourseMemberRole = "instructor" | "assistant" | "student";
export type CourseStatus = "active" | "archived";
export type AssignmentStatus = "draft" | "published" | "closed";
export type AssignmentRecipientStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "returned";

export type CourseSummary = {
  id: string;
  title: string;
  description?: string | null;
  status: CourseStatus;
  ownerUserId: string;
  currentUserRole: CourseMemberRole;
  memberCount: number;
  assignmentCount: number;
  updatedAt: string;
};

export type CourseMember = {
  id: string;
  userId: string;
  accountName: string;
  displayName: string;
  platformRoles: PlatformRole[];
  role: CourseMemberRole;
  createdAt: string;
};

export type AssignmentScope = {
  timeRange?: TimeRangeScope;
  trackIds: string[];
};

export type AssignmentSummary = {
  id: string;
  courseId: string;
  projectId: string;
  sourceDocumentId: string;
  sourceSnapshotId: string;
  sourceRevision: number;
  title: string;
  description?: string | null;
  status: AssignmentStatus;
  startAt?: string | null;
  dueAt?: string | null;
  scope: AssignmentScope;
  recipientCount: number;
  submittedCount: number;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssignmentRecipient = {
  id: string;
  assignmentId: string;
  userId: string;
  accountName: string;
  displayName: string;
  documentId?: string | null;
  status: AssignmentRecipientStatus;
  assignedAt?: string | null;
  firstEditedAt?: string | null;
  lastActivityAt?: string | null;
  submittedAt?: string | null;
  returnedAt?: string | null;
  feedback?: string | null;
};

export type MyAssignment = {
  assignment: AssignmentSummary;
  courseTitle: string;
  recipient: AssignmentRecipient;
};

export type PermissionTrackOption = {
  id: string;
  label: string;
  kind: "builtin" | "custom" | "attached-point" | "branch" | "derived";
};

export type MediaAsset = {
  id: string;
  title: string;
  description?: string | null;
  primaryFileId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredFileObject = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum?: string | null;
  createdAt: string;
};

export type AnnotationProjectSummary = {
  id: string;
  title: string;
  mediaAssetId: string;
  ownerUserId: string;
  documentCount: number;
  updatedAt: string;
};

export type AnnotationDocumentSummary = {
  id: string;
  projectId: string;
  title: string;
  mode: AnnotationMode;
  currentVersionId?: string | null;
  updatedAt: string;
};

export type AnnotationDocumentSnapshot<TPayload = unknown> = {
  id: string;
  documentId: string;
  revision: number;
  payload: TPayload;
  createdBy: string;
  createdAt: string;
};

export type AnnotationVersion<TPayload = unknown> = {
  id: string;
  documentId: string;
  name: string;
  description?: string | null;
  revision: number;
  snapshot: AnnotationDocumentSnapshot<TPayload>;
  createdBy: string;
  createdAt: string;
};

export type AnnotationDocument<TPayload = unknown> = AnnotationDocumentSummary & {
  project: AnnotationProjectSummary;
  mediaAsset: MediaAsset;
  grants: PermissionGrant[];
  latestSnapshot: AnnotationDocumentSnapshot<TPayload>;
};

export type ConfirmedRange = {
  id: string;
  projectId: string;
  documentId: string;
  timeRange: TimeRangeScope;
  trackScope: TrackScope;
  confirmedBy: string;
  confirmedAt: string;
  comment?: string | null;
};

export type ProcessingJobType =
  | "pitch_extraction"
  | "spectrogram_generation"
  | "staff_notation_render"
  | "gongche_render"
  | "pose_estimation"
  | "video_transcode"
  | "audio_extract"
  | "annotation_export";

export type ProcessingJobStatus = "queued" | "running" | "succeeded" | "failed";

// 审计日志：记录平台关键操作的追溯信息。
export type AuditAction =
  | "auth_login"
  | "file_upload"
  | "media_create"
  | "project_create"
  | "document_create"
  | "document_save"
  | "version_create"
  | "version_restore"
  | "job_create"
  | "permission_grant_create"
  | "permission_grant_update"
  | "permission_grant_revoke"
  | "permission_denied"
  | "course_create"
  | "course_member_add"
  | "course_member_update"
  | "course_member_remove"
  | "assignment_create"
  | "assignment_update"
  | "assignment_publish"
  | "assignment_submit"
  | "assignment_return";

export type AuditLogEntry = {
  id: string;
  action: AuditAction;
  actorUserId: string | null;
  projectId?: string | null;
  documentId?: string | null;
  fileId?: string | null;
  versionId?: string | null;
  jobId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
};

// 标注操作日志：记录客户端提交的每次编辑 operation。
export type AnnotationOperationStatus = "accepted" | "rejected" | "superseded";

export type AnnotationOperationRecord = {
  id: string;
  documentId: string;
  actorUserId: string;
  baseRevision: number;
  localRevision?: number | null;
  serverRevision?: number | null;
  action: string;
  payload: unknown;
  status: AnnotationOperationStatus;
  createdAt: string;
};

export type ProcessingJob = {
  id: string;
  type: ProcessingJobType;
  status: ProcessingJobStatus;
  inputFileIds: string[];
  outputFileIds: string[];
  documentId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
};
