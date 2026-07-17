import { Prisma, type User, type UserRole } from "@prisma/client";
import type {
  ApiAnnotationDocument,
  ApiAnnotationMode,
  ApiAnnotationOperation,
  ApiAnnotationProject,
  ApiAnnotationSnapshot,
  ApiAnnotationVersion,
  ApiAuditLogEntry,
  ApiFileObject,
  ApiMediaAsset,
  ApiPermissionGrant,
  ApiProcessingJob,
  ApiRole,
  ApiUser,
} from "./domain.js";

export type UserWithRoles = User & {
  roles: UserRole[];
};

export type GrantRecord = {
  userId: string;
  actions: string[];
};

export type ProjectSummaryRecord = {
  id: string;
  title: string;
  mediaAssetId: string;
  ownerUserId: string;
  updatedAt: Date;
  _count?: {
    documents: number;
  };
};

export const documentInclude = {
  project: {
    include: {
      mediaAsset: true,
      _count: { select: { documents: true } },
    },
  },
  latestSnapshot: true,
  grants: true,
} satisfies Prisma.AnnotationDocumentInclude;

export type DocumentWithDetails = Prisma.AnnotationDocumentGetPayload<{ include: typeof documentInclude }>;

export function expandDocument(document: DocumentWithDetails): ApiAnnotationDocument {
  if (!document.latestSnapshot) {
    throw new Error("标注文档缺少快照。");
  }
  return {
    ...toDocumentSummary(document),
    project: toProjectSummary(document.project),
    mediaAsset: toMediaAsset(document.project.mediaAsset),
    grants: document.grants.map((grant) => toGrant(grant)),
    latestSnapshot: toSnapshot(document.latestSnapshot),
  };
}

export function createGrantData(
  userId: string,
  projectId: string,
  documentId: string,
  actions: ApiPermissionGrant["actions"],
) {
  return {
    userId,
    projectId,
    documentId,
    actions,
    trackIds: [],
  };
}

export function toGrantCreateData(grant: ApiPermissionGrant, projectId: string, documentId: string) {
  return {
    userId: grant.userId,
    projectId: grant.scope.projectId ?? projectId,
    documentId: grant.scope.documentId ?? documentId,
    actions: grant.actions,
    startTime: grant.scope.timeRange?.startTime ?? null,
    endTime: grant.scope.timeRange?.endTime ?? null,
    trackIds: grant.scope.trackScope?.trackIds ?? [],
    expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
  };
}

export function toPublicUser(user: UserWithRoles): ApiUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: user.roles.map((role) => role.role as ApiRole),
  };
}

export function toFileObject(file: Prisma.FileObjectGetPayload<Record<string, never>>): ApiFileObject {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    storageKey: file.storageKey,
    checksum: file.checksum,
    createdAt: file.createdAt.toISOString(),
  };
}

export function toMediaAsset(mediaAsset: Prisma.MediaAssetGetPayload<Record<string, never>>): ApiMediaAsset {
  return {
    id: mediaAsset.id,
    title: mediaAsset.title,
    description: mediaAsset.description,
    primaryFileId: mediaAsset.primaryFileId,
    createdAt: mediaAsset.createdAt.toISOString(),
    updatedAt: mediaAsset.updatedAt.toISOString(),
  };
}

export function toProjectSummary(project: ProjectSummaryRecord): ApiAnnotationProject {
  return {
    id: project.id,
    title: project.title,
    mediaAssetId: project.mediaAssetId,
    ownerUserId: project.ownerUserId,
    documentCount: project._count?.documents ?? 0,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function toDocumentSummary(
  document: Prisma.AnnotationDocumentGetPayload<Record<string, never>>,
): Omit<ApiAnnotationDocument, "project" | "mediaAsset" | "grants" | "latestSnapshot"> {
  return {
    id: document.id,
    projectId: document.projectId,
    title: document.title,
    mode: document.mode as ApiAnnotationMode,
    currentVersionId: document.currentVersionId,
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function toSnapshot(snapshot: Prisma.AnnotationSnapshotGetPayload<Record<string, never>>): ApiAnnotationSnapshot {
  return {
    id: snapshot.id,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    payload: snapshot.payload,
    createdBy: snapshot.createdBy,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

export function toVersion(version: Prisma.AnnotationVersionGetPayload<{ include: { snapshot: true } }>): ApiAnnotationVersion {
  return {
    id: version.id,
    documentId: version.documentId,
    name: version.name,
    description: version.description,
    revision: version.revision,
    snapshot: toSnapshot(version.snapshot),
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toGrant(grant: Prisma.PermissionGrantGetPayload<Record<string, never>>): ApiPermissionGrant {
  return {
    id: grant.id,
    userId: grant.userId,
    actions: grant.actions as ApiPermissionGrant["actions"],
    scope: {
      projectId: grant.projectId ?? undefined,
      documentId: grant.documentId ?? undefined,
      timeRange: typeof grant.startTime === "number" && typeof grant.endTime === "number"
        ? { startTime: grant.startTime, endTime: grant.endTime }
        : undefined,
      trackScope: grant.trackIds.length ? { trackIds: grant.trackIds } : undefined,
    },
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
  };
}

export function toProcessingJob(job: Prisma.ProcessingJobGetPayload<Record<string, never>>): ApiProcessingJob {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    inputFileIds: job.inputFileIds,
    outputFileIds: job.outputFileIds,
    documentId: job.documentId,
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    errorMessage: job.errorMessage,
  };
}

export function toJsonPayload(payload: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(payload ?? {})) as Prisma.InputJsonValue;
}

// Prisma AuditLog 行到 API DTO 的映射。
// detail 字段在 Prisma 是 JsonValue，直接转为 unknown；API 侧不做进一步解释。
export function toAuditLogEntry(row: { id: string; action: string; actorUserId: string | null; projectId: string | null; documentId: string | null; fileId: string | null; versionId: string | null; jobId: string | null; targetType: string | null; targetId: string | null; detail: unknown; ipAddress: string | null; userAgent: string | null; createdAt: Date }): ApiAuditLogEntry {
  return {
    id: row.id,
    action: row.action as ApiAuditLogEntry["action"],
    actorUserId: row.actorUserId,
    projectId: row.projectId,
    documentId: row.documentId,
    fileId: row.fileId,
    versionId: row.versionId,
    jobId: row.jobId,
    targetType: row.targetType,
    targetId: row.targetId,
    detail: row.detail,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

// Prisma AnnotationOperation 行到 API DTO 的映射。
export function toAnnotationOperation(row: { id: string; documentId: string; actorUserId: string; baseRevision: number; localRevision: number | null; serverRevision: number | null; action: string; payload: unknown; status: string; createdAt: Date }): ApiAnnotationOperation {
  return {
    id: row.id,
    documentId: row.documentId,
    actorUserId: row.actorUserId,
    baseRevision: row.baseRevision,
    localRevision: row.localRevision,
    serverRevision: row.serverRevision,
    action: row.action,
    payload: row.payload,
    status: row.status as ApiAnnotationOperation["status"],
    createdAt: row.createdAt.toISOString(),
  };
}
