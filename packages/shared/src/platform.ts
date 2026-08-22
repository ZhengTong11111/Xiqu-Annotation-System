export type PlatformRole =
  | "super_admin"
  | "admin"
  | "teacher"
  | "annotator"
  | "reviewer"
  | "service";

export type PlatformUser = {
  id: string;
  displayName: string;
  accountName: string;
  roles: PlatformRole[];
};

export type ManagedAccount = PlatformUser & {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ManagedAccountPage = {
  items: ManagedAccount[];
  nextCursor: string | null;
};

export type UserReference = Pick<
  PlatformUser,
  "id" | "displayName" | "accountName"
>;

export type ResourceType =
  | "folder"
  | "project"
  | "annotation_file"
  | "media_file";

export type ResourceCapability =
  | "read"
  | "write"
  | "review"
  | "create_child"
  | "copy"
  | "move"
  | "delete"
  | "download"
  | "manage_permissions";

export const RESOURCE_CAPABILITIES: readonly ResourceCapability[] = [
  "read",
  "write",
  "review",
  "create_child",
  "copy",
  "move",
  "delete",
  "download",
  "manage_permissions",
];

export type ResourcePermissionSource =
  | "admin"
  | "owner"
  | "role"
  | "direct"
  | "inherited"
  | "none";

export type EffectiveResourcePermission = {
  source: ResourcePermissionSource;
  capabilities: ResourceCapability[];
  inheritedFrom: Array<{
    resourceId: string;
    resourceName: string;
    capabilities: ResourceCapability[];
  }>;
  isOwner: boolean;
  canManagePermissions: boolean;
};

export type ResourceEntry = {
  id: string;
  parentId?: string | null;
  type: ResourceType;
  name: string;
  owner: UserReference;
  breakPermissionInheritance: boolean;
  archivedAt?: string | null;
  trashedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  childCount: number;
  size?: number | null;
  mimeType?: string | null;
  mediaSourceType?: MediaSourceType | null;
  mediaKind?: MediaKind | null;
  duration?: number | null;
  revision?: number | null;
  favorite: boolean;
  permission: EffectiveResourcePermission;
};

export type ResourceBreadcrumb = Pick<
  ResourceEntry,
  "id" | "parentId" | "type" | "name"
>;

export type ResourcePermissionRecord = {
  id: string;
  resourceId: string;
  user: PlatformUser;
  capabilities: ResourceCapability[];
  inheritToChildren: boolean;
  expiresAt?: string | null;
  createdBy: UserReference;
  createdAt: string;
  updatedAt: string;
};

export type ResourcePermissionMatrixRow = {
  user: PlatformUser;
  directPermission?: ResourcePermissionRecord | null;
  effectivePermission: EffectiveResourcePermission;
};

export type ResourceListView =
  | "children"
  | "all_projects"
  | "recent"
  | "favorites"
  | "shared"
  | "archived"
  | "trash";

export type ResourceSortField = "name" | "createdAt" | "updatedAt" | "size";
export type SortDirection = "asc" | "desc";

export type MediaSourceType = "uploaded" | "aliyun_vod";
export type MediaKind = "video" | "audio";

export type ResourceListPage = {
  items: ResourceEntry[];
  breadcrumbs: ResourceBreadcrumb[];
  nextCursor: string | null;
};

// 集中权限面板只读取项目选择所需的轻量事实，避免提前展开每个项目的完整账号矩阵。
export type PermissionManagementProject = {
  id: string;
  name: string;
  path: ResourceBreadcrumb[];
  owner: UserReference;
  updatedAt: string;
};

export type PermissionManagementProjectPage = {
  items: PermissionManagementProject[];
  nextCursor: string | null;
};

export type AnnotationFile<TPayload = unknown> = {
  resource: ResourceEntry;
  payload: TPayload;
  revision: number;
  operationCursor: string;
  mediaResourceId?: string | null;
  media?: AnnotationMediaReference | null;
  lastEditor: UserReference;
  lastSavedAt: string;
};

type AnnotationMediaReferenceBase = {
  resourceId: string;
  name: string;
  mediaKind: MediaKind;
  duration: number | null;
};

export type AnnotationMediaReference =
  | (AnnotationMediaReferenceBase & {
      sourceType: "uploaded";
      fileId: string;
      mimeType: string;
      size: number;
    })
  | (AnnotationMediaReferenceBase & {
      sourceType: "aliyun_vod";
      videoId: string;
      region: string;
    });

export type AnalysisAudioMode = "auto" | "media_override";
export type MediaAnalysisAssetKind = "waveform" | "spectrogram" | "pitch";

export type AnalysisAudioSetting = {
  mode: AnalysisAudioMode;
  overrideMediaResourceId: string | null;
  offsetSeconds: number;
  updatedAt: string | null;
};

export type ResolvedAnalysisAudioSource =
  | {
      status: "ready";
      mode: AnalysisAudioMode;
      mediaResourceId: string;
      mediaName: string;
      sourceType: MediaSourceType;
      mediaKind: MediaKind;
      duration: number | null;
      offsetSeconds: number;
    }
  | {
      status: "unavailable";
      mode: AnalysisAudioMode;
      code:
        | "analysis_source_missing"
        | "analysis_audio_forbidden"
        | "analysis_source_invalid";
      offsetSeconds: number;
    };

export type MediaAnalysisAssetDescriptor = {
  id: string;
  kind: MediaAnalysisAssetKind;
  preset: string;
  level: number;
  tileIndex: number;
  startTime: number;
  endTime: number;
  mimeType: string;
  size: number;
};

export type MediaAnalysisRun = {
  id: string;
  status: ProcessingJobStatus;
  progress: number;
  errorCode: string | null;
  sourceMediaResourceId: string;
  sourceMode: AnalysisAudioMode;
  sourceOffsetSeconds: number;
  algorithmVersion: string;
  /** 本次 run 的分析瓦片时长；客户端据此兼容不同历史分析粒度。 */
  tileDurationSeconds: number;
  duration: number | null;
  sampleRate: number | null;
  assetCounts: Partial<Record<MediaAnalysisAssetKind, number>>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AnnotationMediaAnalysisStatus = {
  setting: AnalysisAudioSetting;
  resolvedSource: ResolvedAnalysisAudioSource;
  currentRun: MediaAnalysisRun | null;
};

// 恢复快照摘要用于历史列表，刻意不携带大体积标注 payload。
export type AnnotationRecoverySnapshotSummary = {
  id: string;
  annotationFileId: string;
  revision: number;
  creator: UserReference;
  reason?: string | null;
  createdAt: string;
};

// 恢复快照详情只在用户主动预览单条历史时返回完整 payload。
export type AnnotationRecoverySnapshotDetail<TPayload = unknown> =
  AnnotationRecoverySnapshotSummary & {
    payload: TPayload;
  };

// 已确认标注范围使用稳定保存领域，不引用时间轴的派生伪轨或当前 UI 折叠状态。
export const ANNOTATION_CONFIRMATION_DOMAINS = [
  "subtitle_lines",
  "character_annotations",
  "gongche_annotations",
  "banyan_sections",
  "banyan_marks",
  "custom_tracks",
  "custom_blocks",
  "attached_points",
] as const;

export type AnnotationConfirmationDomain =
  (typeof ANNOTATION_CONFIRMATION_DOMAINS)[number];

// 作用域三种模式保持互斥，避免 domains 与 tracks 的交集/并集语义在客户端和服务端发生分歧。
export type AnnotationConfirmationTargets =
  | {
      mode: "all";
    }
  | {
      mode: "domains";
      domains: AnnotationConfirmationDomain[];
    }
  | {
      mode: "tracks";
      trackIds: string[];
    };

// 时间范围采用 [startTime, endTime) 半开区间；零时长点事件不属于本合同。
export type AnnotationConfirmationScope = {
  startTime: number;
  endTime: number;
  targets: AnnotationConfirmationTargets;
};

export type AnnotationConfirmationDraft = {
  annotationFileId: string;
  confirmedRevision: number;
  scope: AnnotationConfirmationScope;
  note?: string | null;
};

// 撤销字段作为判别联合成组出现，保留审核事实而不是原地删除记录。
export type AnnotationConfirmationRecord = AnnotationConfirmationDraft & {
  id: string;
  createdBy: UserReference;
  createdAt: string;
} & (
  | {
      revokedAt?: null;
      revokedBy?: null;
      revokeReason?: null;
    }
  | {
      revokedAt: string;
      revokedBy: UserReference;
      revokeReason?: string | null;
    }
);

export type AnnotationConfirmationLifecycle = "active" | "revoked";
export type AnnotationConfirmationFreshness = "current" | "stale";

// 列表携带服务器当前 revision，调用方据此用纯 helper 判断每条确认是否已过期。
export type AnnotationConfirmationList = {
  currentRevision: number;
  confirmations: AnnotationConfirmationRecord[];
};

export type ProcessingJobType =
  | "pitch_extraction"
  | "spectrogram_generation"
  | "staff_notation_render"
  | "gongche_render"
  | "pose_estimation"
  | "video_transcode"
  | "audio_extract"
  | "annotation_export"
  | "media_analysis";

export type ProcessingJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type ProcessingJob = {
  id: string;
  type: ProcessingJobType;
  status: ProcessingJobStatus;
  resourceId?: string | null;
  inputFileIds: string[];
  createdBy: string;
  progress: number;
  errorMessage?: string | null;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
};

// 审计动作列表同时供 API 运行时校验和管理界面筛选使用，避免前后端维护两份漂移枚举。
export const AUDIT_ACTIONS = [
  "auth_login",
  "account_create",
  "account_update",
  "account_password_reset",
  "account_password_change",
  "file_upload",
  "media_upload",
  "aliyun_vod_media_create",
  "resource_create",
  "resource_update",
  "resource_copy",
  "resource_move",
  "resource_trash",
  "resource_restore",
  "resource_delete",
  "annotation_file_save",
  "annotation_client_sync_failure",
  "annotation_mutation_lease_acquire",
  "annotation_mutation_lease_renew",
  "annotation_mutation_lease_release",
  "annotation_snapshot_restore",
  "annotation_confirmation_create",
  "annotation_confirmation_revoke",
  "resource_permission_upsert",
  "resource_permission_remove",
  "resource_inheritance_update",
  "annotation_media_bind",
  "annotation_media_unbind",
  "annotation_analysis_audio_update",
  "media_analysis_create",
  "job_create",
  "permission_denied",
  "storage_orphan_cleanup",
  "maintenance_enable",
  "maintenance_disable",
] as const;

export type AuditActionName = typeof AUDIT_ACTIONS[number];

export type AnnotationClientSyncFailureCategory =
  | "atomic_plan"
  | "atomic_protocol"
  | "draft_persistence"
  | "mutation_lease"
  | "auto_save_runtime"
  | "server_save"
  | "unknown";

export type AnnotationClientSyncFailureOperation = {
  operationId: string;
  action: string;
  commandType: string;
  baseRevision: number;
  localRevision: number;
  createdAt: string;
  targets: string[];
  // 调试阶段保留有界命令 envelope；凭据、鉴权值和 URL 必须在客户端与服务端双重脱敏。
  commandPayload?: unknown;
};

export type AnnotationClientSyncFailureMismatch = {
  path: string;
  savedValue: unknown;
  replayedValue: unknown;
  currentValue: unknown;
};

// 调试报告允许保留标注正文、before/after 和完整命令 envelope；鉴权凭据仍必须双重脱敏。
export type AnnotationClientSyncFailureReport = {
  schemaVersion: 1;
  clientRuntimeId: string;
  clientOccurredAt: string;
  category: AnnotationClientSyncFailureCategory;
  reason: string;
  errorMessage: string;
  localRevision: number;
  savedLocalRevision: number;
  documentRemoteRevision: number | null;
  appRemoteRevision: number;
  observedRemoteRevision: number;
  pendingOperationCount: number;
  hasUnsavedChanges: boolean;
  saveInFlight: boolean;
  online: boolean;
  mismatchFields: string[];
  mismatchDetails: AnnotationClientSyncFailureMismatch[];
  pendingOperations: AnnotationClientSyncFailureOperation[];
  pendingOperationsTruncated: boolean;
};

export type AnnotationClientSyncFailureReportResult = {
  recorded: boolean;
};

// 审计资源摘要只携带浏览所需身份，不展开资源树、权限或文件 payload。
export type AuditResourceReference = {
  id: string;
  name: string;
  type: ResourceType;
};

export type AuditLogEntry = {
  id: string;
  action: AuditActionName;
  actorUserId?: string | null;
  resourceId?: string | null;
  fileId?: string | null;
  targetUserId?: string | null;
  detail?: unknown;
  createdAt: string;
  actor?: UserReference | null;
  resource?: AuditResourceReference | null;
  targetUser?: UserReference | null;
};

// 审计列表以 opaque cursor 增量读取，调用方不能从 items 数量猜测是否还有下一页。
export type AuditLogPage = {
  items: AuditLogEntry[];
  nextCursor: string | null;
};

export type AnnotationOperationRecord = {
  id: string;
  annotationFileId: string;
  actorUserId: string;
  clientOperationId: string;
  sequence: number;
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
  status: "accepted" | "rejected" | "superseded";
  commitState: "accepted" | "committed";
  committedRevision: number | null;
  committedAt: string | null;
  replayability: "domain_command" | "requires_snapshot";
  createdAt: string;
};

// operation feed 始终按文件内 sequence 升序；nextCursor 也是客户端已观察事实的确认位置。
export type AnnotationOperationPage = {
  items: AnnotationOperationRecord[];
  nextCursor: string | null;
  hasMore: boolean;
};

// 已提交 feed 额外返回权威文件 revision，客户端可发现没有 operation 的 snapshot 推进。
export type AnnotationCommittedOperationPage = AnnotationOperationPage & {
  currentRevision: number;
};
