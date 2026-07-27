export type PlatformRole =
  | "super_admin"
  | "admin"
  | "teacher"
  | "ta"
  | "annotator"
  | "reviewer"
  | "service";

export type PlatformUser = {
  id: string;
  displayName: string;
  accountName: string;
  roles: PlatformRole[];
};

export type UserReference = Pick<
  PlatformUser,
  "id" | "displayName" | "accountName"
>;

export type TimeRangeScope = {
  startTime: number;
  endTime: number;
};

export type TrackScope = {
  trackIds: string[];
};

export type MutableProjectScope = {
  timeRange?: TimeRangeScope | null;
  trackScope?: TrackScope | null;
};

export type ProjectMemberRole = "manager" | "reviewer" | "annotator" | "viewer";

export type ProjectCapability =
  | "view_project"
  | "create_workspace"
  | "fork_version"
  | "complete_version"
  | "submit_version"
  | "review_versions"
  | "create_project_version"
  | "publish_project_version"
  | "manage_all_versions"
  | "manage_members";

// 前端角色预设、API 校验和管理员全权限必须共享同一份能力目录，
// 否则新增能力时很容易出现“按钮可见但后端拒绝”或反向漏权。
export const PROJECT_CAPABILITIES: readonly ProjectCapability[] = [
  "view_project",
  "create_workspace",
  "fork_version",
  "complete_version",
  "submit_version",
  "review_versions",
  "create_project_version",
  "publish_project_version",
  "manage_all_versions",
  "manage_members",
];

export const DEFAULT_PROJECT_ROLE_CAPABILITIES: Readonly<
  Record<ProjectMemberRole, readonly ProjectCapability[]>
> = {
  manager: PROJECT_CAPABILITIES,
  reviewer: [
    "view_project",
    "review_versions",
    "create_project_version",
    "manage_all_versions",
  ],
  annotator: [
    "view_project",
    "create_workspace",
    "fork_version",
    "complete_version",
    "submit_version",
  ],
  viewer: ["view_project"],
};

export type ProjectMember = {
  id: string;
  projectId: string;
  userId: string;
  accountName: string;
  displayName: string;
  platformRoles: PlatformRole[];
  role: ProjectMemberRole | "owner";
  capabilities: ProjectCapability[];
  timeRange?: TimeRangeScope | null;
  trackIds: string[];
  expiresAt?: string | null;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EffectiveProjectPermission = {
  source: "admin" | "owner" | "membership" | "none";
  capabilities: ProjectCapability[];
  timeRange?: TimeRangeScope | null;
  trackIds: string[];
  expiresAt?: string | null;
};

export type EffectiveWorkspacePermission = EffectiveProjectPermission & {
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
  isWorkspaceOwner: boolean;
};

export type PermissionTrackOption = {
  id: string;
  label: string;
  kind: "builtin" | "custom" | "attached-point" | "branch" | "derived";
};

// 保存差异描述由 document-model 生成，后端据此检查成员的时间和轨道范围。
export type ProjectMutation = {
  kind: string;
  action: "create" | "update" | "delete" | "move" | "structure";
  trackIds: string[];
  timeRange?: TimeRangeScope;
  requiresManage: boolean;
  entityId?: string;
  summary?: string;
};

export type MutationScopeViolation = {
  kind: string;
  trackIds: string[];
  timeRange?: TimeRangeScope;
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
  workspaceCount: number;
  annotationVersionCount: number;
  projectVersionCount: number;
  memberCount: number;
  primaryWorkspaceId?: string | null;
  currentProjectVersionId?: string | null;
  currentUserCapabilities: ProjectCapability[];
  updatedAt: string;
};

export type WorkspaceType = "main" | "personal" | "collaborative";
export type WorkspaceStatus = "active" | "submitted" | "archived";

export type AnnotationWorkspaceSummary = {
  id: string;
  projectId: string;
  name: string;
  workspaceType: WorkspaceType;
  status: WorkspaceStatus;
  owner: UserReference;
  creator: UserReference;
  forkedFromVersionId?: string | null;
  latestRevision: number;
  versionCount: number;
  submittedAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  permission: EffectiveWorkspacePermission;
};

export type AnnotationSnapshot<TPayload = unknown> = {
  id: string;
  workspaceId: string;
  revision: number;
  payload: TPayload;
  createdBy: string;
  createdAt: string;
};

export type AnnotationWorkspace<TPayload = unknown> =
  AnnotationWorkspaceSummary & {
    project: AnnotationProjectSummary;
    mediaAsset: MediaAsset;
    latestSnapshot: AnnotationSnapshot<TPayload>;
  };

export type AnnotationVersionKind = "checkpoint" | "submission";
export type AnnotationVersionStatus = "active" | "archived";

export type AnnotationVersionSummary = {
  id: string;
  projectId: string;
  workspaceId: string;
  snapshotId: string;
  parentVersionId?: string | null;
  name: string;
  description?: string | null;
  kind: AnnotationVersionKind;
  status: AnnotationVersionStatus;
  revision: number;
  creator: UserReference;
  completedAt: string;
  archivedAt?: string | null;
  createdAt: string;
};

export type AnnotationVersion<TPayload = unknown> =
  AnnotationVersionSummary & {
    snapshot: AnnotationSnapshot<TPayload>;
    workspace: Pick<
      AnnotationWorkspaceSummary,
      "id" | "name" | "workspaceType" | "status" | "owner"
    >;
  };

export type ProjectVersionStatus =
  | "candidate"
  | "published"
  | "superseded"
  | "archived";

export type ProjectVersion = {
  id: string;
  projectId: string;
  sourceVersionId: string;
  sequence: number;
  name: string;
  description?: string | null;
  status: ProjectVersionStatus;
  sourceVersion: AnnotationVersionSummary;
  creator: UserReference;
  publisher?: UserReference | null;
  publishedAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
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

export type AuditAction =
  | "auth_login"
  | "file_upload"
  | "media_create"
  | "project_create"
  | "workspace_create"
  | "workspace_save"
  | "workspace_status_update"
  | "annotation_version_create"
  | "annotation_version_archive"
  | "annotation_version_fork"
  | "project_version_create"
  | "project_version_publish"
  | "project_version_archive"
  | "job_create"
  | "permission_denied"
  | "project_member_add"
  | "project_member_update"
  | "project_member_remove";

export type AuditLogEntry = {
  id: string;
  action: AuditAction;
  actorUserId: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  annotationVersionId?: string | null;
  projectVersionId?: string | null;
  fileId?: string | null;
  jobId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
};

export type AnnotationOperationStatus = "accepted" | "rejected" | "superseded";

export type AnnotationOperationRecord = {
  id: string;
  workspaceId: string;
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
  workspaceId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
};
