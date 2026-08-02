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

export type ResourceListPage = {
  items: ResourceEntry[];
  breadcrumbs: ResourceBreadcrumb[];
  nextCursor: string | null;
};

export type AnnotationFile<TPayload = unknown> = {
  resource: ResourceEntry;
  payload: TPayload;
  revision: number;
  mediaResourceId?: string | null;
  lastEditor: UserReference;
  lastSavedAt: string;
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

export type StoredFileObject = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum?: string | null;
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

export type AuditLogEntry = {
  id: string;
  action: string;
  actorUserId?: string | null;
  resourceId?: string | null;
  fileId?: string | null;
  targetUserId?: string | null;
  detail?: unknown;
  createdAt: string;
};

export type AnnotationOperationRecord = {
  id: string;
  annotationFileId: string;
  actorUserId: string;
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
  status: "accepted" | "rejected" | "superseded";
  createdAt: string;
};
