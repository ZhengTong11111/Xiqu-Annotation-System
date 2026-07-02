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
