export type ApiRole =
  | "super_admin"
  | "admin"
  | "teacher"
  | "ta"
  | "annotator"
  | "reviewer"
  | "service";

export type ApiUser = {
  id: string;
  accountName: string;
  displayName: string;
  roles: ApiRole[];
};

export type ApiSession = {
  token: string;
  userId: string;
  createdAt: string;
};

export type ApiMediaAsset = {
  id: string;
  title: string;
  description: string | null;
  primaryFileId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiFileObject = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum: string | null;
  createdAt: string;
};

export type ApiAnnotationProject = {
  id: string;
  title: string;
  mediaAssetId: string;
  ownerUserId: string;
  documentCount: number;
  updatedAt: string;
};

export type ApiAnnotationMode = "independent" | "collaborative";

export type ApiPermissionGrant = {
  id: string;
  userId: string;
  actions: Array<"view" | "edit" | "comment" | "submit" | "review" | "merge" | "confirm" | "manage">;
  scope: {
    projectId?: string;
    documentId?: string;
    timeRange?: {
      startTime: number;
      endTime: number;
    };
    trackScope?: {
      trackIds: string[];
    };
  };
  expiresAt: string | null;
  createdAt: string;
};

export type ApiAnnotationSnapshot = {
  id: string;
  documentId: string;
  revision: number;
  payload: unknown;
  createdBy: string;
  createdAt: string;
};

export type ApiAnnotationDocument = {
  id: string;
  projectId: string;
  title: string;
  mode: ApiAnnotationMode;
  currentVersionId: string | null;
  updatedAt: string;
  project: ApiAnnotationProject;
  mediaAsset: ApiMediaAsset;
  grants: ApiPermissionGrant[];
  latestSnapshot: ApiAnnotationSnapshot;
};

export type ApiAnnotationVersion = {
  id: string;
  documentId: string;
  name: string;
  description: string | null;
  revision: number;
  snapshot: ApiAnnotationSnapshot;
  createdBy: string;
  createdAt: string;
};

export type ApiAuditLogEntry = {
  id: string;
  action:
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
    | "permission_denied";
  actorUserId: string | null;
  projectId: string | null;
  documentId: string | null;
  fileId: string | null;
  versionId: string | null;
  jobId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type ApiAnnotationOperation = {
  id: string;
  documentId: string;
  actorUserId: string;
  baseRevision: number;
  localRevision: number | null;
  serverRevision: number | null;
  action: string;
  payload: unknown;
  status: "accepted" | "rejected" | "superseded";
  createdAt: string;
};

export type ApiProcessingJob = {
  id: string;
  type:
    | "pitch_extraction"
    | "spectrogram_generation"
    | "staff_notation_render"
    | "gongche_render"
    | "pose_estimation"
    | "video_transcode"
    | "audio_extract"
    | "annotation_export";
  status: "queued" | "running" | "succeeded" | "failed";
  inputFileIds: string[];
  outputFileIds: string[];
  documentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
};
