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

export type AnnotationWorkflowStatus =
  | "unannotated"
  | "annotated"
  | "reviewed";

export type ProjectWorkflowGroup = "annotation" | "review";

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
    // 职责组与手工 ACL 共用有效权限并集，但保留来源供界面准确解释撤销边界。
    responsibilityGroup?: ProjectWorkflowGroup;
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
  // 工作流属于平台资源元数据，不进入 ProjectData 或 annotation revision。
  workflowStatus?: AnnotationWorkflowStatus | null;
  // 列表只携带标注组摘要；完整标注/审核组在项目 Inspector 中按需读取。
  annotationResponsibles?: UserReference[];
  favorite: boolean;
  permission: EffectiveResourcePermission;
};

export type ProjectWorkflowGroups = {
  projectResourceId: string;
  annotation: UserReference[];
  review: UserReference[];
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

export type MediaAnalysisAssetKind = "waveform" | "spectrogram" | "pitch";

export type ResolvedAnalysisAudioSource =
  | {
      status: "ready";
      mediaResourceId: string;
      mediaName: string;
      sourceType: MediaSourceType;
      mediaKind: MediaKind;
      duration: number | null;
      offsetSeconds: number;
    }
  | {
      status: "unavailable";
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
  sourceVodRenditionJobId: string | null;
  /** 当前音轨关系的时间偏移，是请求上下文投影，不属于共享 run 的持久化身份。 */
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
  audioTrackId: string;
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

// 恢复历史使用文件绑定的 opaque cursor；nextCursor 非空表示当前只加载了部分历史。
export type AnnotationRecoverySnapshotPage = {
  snapshots: AnnotationRecoverySnapshotSummary[];
  nextCursor: string | null;
};

// 恢复快照详情只在用户主动预览单条历史时返回完整 payload。
export type AnnotationRecoverySnapshotDetail<TPayload = unknown> =
  AnnotationRecoverySnapshotSummary & {
    payload: TPayload;
  };

// 审核范围使用稳定保存领域，不引用时间轴的派生伪轨或当前 UI 折叠状态。
export const ANNOTATION_REVIEW_DOMAINS = [
  "subtitle_lines",
  "character_annotations",
  "gongche_annotations",
  "banyan_sections",
  "banyan_marks",
  "custom_tracks",
  "custom_blocks",
  "attached_points",
] as const;

export type AnnotationReviewDomain =
  (typeof ANNOTATION_REVIEW_DOMAINS)[number];

// 作用域三种模式保持互斥，避免 domains 与 tracks 的交集/并集语义在客户端和服务端发生分歧。
export type AnnotationReviewTargets =
  | {
      mode: "all";
    }
  | {
      mode: "domains";
      domains: AnnotationReviewDomain[];
    }
  | {
      mode: "tracks";
      trackIds: string[];
    };

// 时间范围采用 [startTime, endTime) 半开区间；零时长点事件不属于本合同。
export type AnnotationReviewScope = {
  startTime: number;
  endTime: number;
  targets: AnnotationReviewTargets;
};

// 旧名称只作为确认 API 的源码兼容别名；新审核功能不得再复制一套范围合同。
export const ANNOTATION_CONFIRMATION_DOMAINS = ANNOTATION_REVIEW_DOMAINS;
export type AnnotationConfirmationDomain = AnnotationReviewDomain;
export type AnnotationConfirmationTargets = AnnotationReviewTargets;
export type AnnotationConfirmationScope = AnnotationReviewScope;

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

// 审核历史大页只供“加载全部/导出”使用；普通首屏仍应采用较小页面快速显示。
export const ANNOTATION_REVIEW_PAGE_MAX_LIMIT = 500;

// 确认页携带服务器当前 revision；opaque cursor 只能交回同一文件接口继续读取。
export type AnnotationConfirmationList = {
  currentRevision: number;
  confirmations: AnnotationConfirmationRecord[];
  nextCursor: string | null;
};

export const ANNOTATION_RANGE_COMMENT_KINDS = [
  "review_comment",
  "editor_feedback",
] as const;
export type AnnotationRangeCommentKind = typeof ANNOTATION_RANGE_COMMENT_KINDS[number];

export type AnnotationRangeCommentDraft = {
  annotationFileId: string;
  commentedRevision: number;
  scope: AnnotationReviewScope;
  kind: AnnotationRangeCommentKind;
  body: string;
};

// 审核评论与编辑反馈都是追加式范围事实；撤回只补充审计字段，不原地修改正文或删除记录。
export type AnnotationRangeCommentRecord = AnnotationRangeCommentDraft & {
  id: string;
  createdBy: UserReference;
  createdAt: string;
} & (
  | {
      withdrawnAt?: null;
      withdrawnBy?: null;
      withdrawReason?: null;
    }
  | {
      withdrawnAt: string;
      withdrawnBy: UserReference;
      withdrawReason?: string | null;
    }
);

export type AnnotationRangeCommentLifecycle = "active" | "withdrawn";
export type AnnotationRangeCommentFreshness = "current" | "stale";

export type AnnotationRangeCommentPage = {
  currentRevision: number;
  items: AnnotationRangeCommentRecord[];
  nextCursor: string | null;
};

// 审核包是跨文件重新建立来源关联的不可变交换合同，不是 ProjectData，也不能直接写回原生审核事实表。
export const ANNOTATION_REVIEW_PACKAGE_FORMAT = "xiqu.annotation-review-package";
export const ANNOTATION_REVIEW_PACKAGE_VERSION = 1;
export const ANNOTATION_REVIEW_PACKAGE_MAX_RECORDS = 1_000;

export type AnnotationReviewPackageV1 = {
  format: typeof ANNOTATION_REVIEW_PACKAGE_FORMAT;
  version: typeof ANNOTATION_REVIEW_PACKAGE_VERSION;
  exportedAt: string;
  source: {
    annotationFileId: string;
    annotationFileName: string;
    revision: number;
  };
  counts: {
    confirmations: number;
    rangeRecords: number;
  };
  records: {
    confirmations: AnnotationConfirmationRecord[];
    rangeRecords: AnnotationRangeCommentRecord[];
  };
};

export type AnnotationReviewLinkLifecycle = "active" | "revoked";

export type AnnotationReviewLinkRecord = {
  id: string;
  targetAnnotationFileId: string;
  source: AnnotationReviewPackageV1["source"];
  packageFingerprint: string;
  counts: AnnotationReviewPackageV1["counts"];
  reviewPackage: AnnotationReviewPackageV1;
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

export type AnnotationReviewLinkDryRun = {
  status: "ready" | "duplicate";
  target: {
    annotationFileId: string;
    annotationFileName: string;
    revision: number;
    duration: number;
  };
  source: AnnotationReviewPackageV1["source"];
  packageFingerprint: string;
  counts: AnnotationReviewPackageV1["counts"];
  matchedTrackIds: string[];
  duplicateLinkId: string | null;
  duplicateLifecycle: AnnotationReviewLinkLifecycle | null;
};

export type CreateAnnotationReviewLinkRequest = {
  targetRevision: number;
  reviewPackage: AnnotationReviewPackageV1;
};

export type RevokeAnnotationReviewLinkRequest = {
  reason?: string | null;
};

export const PROCESSING_JOB_TYPES = [
  "pitch_extraction",
  "spectrogram_generation",
  "staff_notation_render",
  "gongche_render",
  "pose_estimation",
  "video_transcode",
  "audio_extract",
  "annotation_export",
  "media_analysis",
  "force_alignment",
] as const;
export type ProcessingJobType = typeof PROCESSING_JOB_TYPES[number];

export const PROCESSING_JOB_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
] as const;
export type ProcessingJobStatus = typeof PROCESSING_JOB_STATUSES[number];

export type ProcessingJobCancellationMode = "user_request" | "admin_force";

export const PROCESSING_JOB_COMMAND_OUTCOMES = [
  "request_cancelled_execution_continues",
  "execution_cancelling",
  "execution_cancelled",
  "already_terminal",
  "request_already_cancelled",
  "retry_scheduled",
] as const;
export type ProcessingJobCommandOutcome = typeof PROCESSING_JOB_COMMAND_OUTCOMES[number];

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

export type ProcessingJobScope = "mine" | "related" | "all";

export type ProcessingJobContextResource = {
  id: string;
  name: string;
  type: ResourceType;
};

export type ProcessingJobRequestListItem = {
  requestId: string;
  requestedAt: string;
  cancelledAt: string | null;
  requester: UserReference;
  contextResource: ProcessingJobContextResource | null;
  job: {
    id: string;
    type: ProcessingJobType;
    status: ProcessingJobStatus;
    progress: number;
    errorCode: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
    cancelRequestedAt: string | null;
    cancellationMode: ProcessingJobCancellationMode | null;
  };
};

export type ProcessingJobPage = {
  items: ProcessingJobRequestListItem[];
  nextCursor: string | null;
};

export type ProcessingJobSummary = {
  scope: ProcessingJobScope;
  visibleRequestCount: number;
  activeRequestCount: number;
  byStatus: Record<ProcessingJobStatus, number>;
  isPartial: boolean;
};

export type ProcessingJobDetail = {
  job: ProcessingJobRequestListItem["job"];
  visibleRequests: Array<Omit<ProcessingJobRequestListItem, "job">>;
  visibleRequestCount: number;
  requestsTruncated: boolean;
};

export type ListProcessingJobsOptions = {
  scope?: ProcessingJobScope;
  status?: ProcessingJobStatus;
  type?: ProcessingJobType;
  query?: string;
  cursor?: string;
  limit?: number;
};

export type ProcessingJobCommandResult = {
  commandId: string;
  outcome: ProcessingJobCommandOutcome;
  requestId: string | null;
  jobId: string;
  resultJobId: string | null;
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
  "alignment_quality_assessment_upsert",
  "alignment_research_group_create",
  "project_alignment_research_groups_update",
  "alignment_training_export_freeze",
  "annotation_workflow_status_update",
  "project_workflow_groups_update",
  "annotation_client_sync_failure",
  "annotation_mutation_lease_acquire",
  "annotation_mutation_lease_renew",
  "annotation_mutation_lease_release",
  "annotation_snapshot_restore",
  "annotation_confirmation_create",
  "annotation_confirmation_revoke",
  "annotation_range_comment_create",
  "annotation_range_comment_withdraw",
  "annotation_range_feedback_create",
  "annotation_range_feedback_withdraw",
  "annotation_review_link_create",
  "annotation_review_link_revoke",
  "resource_permission_upsert",
  "resource_permission_remove",
  "resource_inheritance_update",
  "annotation_media_bind",
  "annotation_media_unbind",
  "annotation_analysis_audio_update",
  "media_audio_track_create",
  "media_audio_track_update",
  "media_audio_track_delete",
  "media_audio_track_reorder",
  "annotation_audio_preference_update",
  "media_analysis_migration_apply",
  "analysis_audio_setting_migration_apply",
  "media_analysis_create",
  "processing_job_request_cancel",
  "processing_job_force_cancel",
  "processing_job_retry",
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

export type AnnotationClientSyncFailurePlannerFailure = {
  operationId: string | null;
  operationIndex: number | null;
  issues: unknown;
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
  plannerFailure?: AnnotationClientSyncFailurePlannerFailure;
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
