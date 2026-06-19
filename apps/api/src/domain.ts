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
