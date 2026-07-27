import type {
  AnnotationOperationRecord,
  AnnotationProjectSummary,
  AnnotationVersion,
  AnnotationWorkspace,
  AuditLogEntry,
  MediaAsset,
  PlatformRole,
  ProcessingJob,
  ProjectVersion,
  StoredFileObject,
} from "@xiqu/shared";

export type ApiRole = PlatformRole;

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

export type ApiFileObject = StoredFileObject;
export type ApiMediaAsset = MediaAsset;
export type ApiAnnotationProject = AnnotationProjectSummary;
export type ApiAnnotationWorkspace = AnnotationWorkspace;
export type ApiAnnotationVersion = AnnotationVersion;
export type ApiProjectVersion = ProjectVersion;
export type ApiAuditLogEntry = AuditLogEntry;
export type ApiAnnotationOperation = AnnotationOperationRecord;
export type ApiProcessingJob = ProcessingJob;
