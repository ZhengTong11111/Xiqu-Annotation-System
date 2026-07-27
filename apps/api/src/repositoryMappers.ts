import { Prisma } from "@prisma/client";
import type {
  AnnotationProjectSummary,
  AnnotationVersion,
  AnnotationVersionSummary,
  AnnotationWorkspace,
  AnnotationWorkspaceSummary,
  EffectiveWorkspacePermission,
  ProjectCapability,
  ProjectVersion,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";

export const userReferenceSelect = {
  id: true,
  accountName: true,
  displayName: true,
} satisfies Prisma.UserSelect;

export const workspaceSummaryInclude = {
  owner: { select: userReferenceSelect },
  creator: { select: userReferenceSelect },
  latestSnapshot: true,
  _count: { select: { versions: true } },
} satisfies Prisma.AnnotationWorkspaceInclude;

export const annotationVersionInclude = {
  snapshot: true,
  creator: { select: userReferenceSelect },
  workspace: {
    include: {
      owner: { select: userReferenceSelect },
    },
  },
} satisfies Prisma.AnnotationVersionInclude;

export const projectVersionInclude = {
  creator: { select: userReferenceSelect },
  publisher: { select: userReferenceSelect },
  sourceVersion: {
    include: {
      creator: { select: userReferenceSelect },
      snapshot: true,
    },
  },
} satisfies Prisma.ProjectVersionInclude;

export type WorkspaceWithSummary = Prisma.AnnotationWorkspaceGetPayload<{
  include: typeof workspaceSummaryInclude;
}>;

export type AnnotationVersionWithDetails = Prisma.AnnotationVersionGetPayload<{
  include: typeof annotationVersionInclude;
}>;

export type ProjectVersionWithDetails = Prisma.ProjectVersionGetPayload<{
  include: typeof projectVersionInclude;
}>;

export function toPublicUser(user: {
  id: string;
  accountName: string;
  displayName: string;
  roles: Array<{ role: string }>;
}): ApiUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: user.roles.map((entry) => entry.role) as ApiUser["roles"],
  };
}

export function toJsonPayload(payload: unknown): Prisma.InputJsonValue {
  return payload as Prisma.InputJsonValue;
}

export function toFile(file: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum: string | null;
  createdAt: Date;
}) {
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

export function toMediaAsset(asset: {
  id: string;
  title: string;
  description: string | null;
  primaryFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: asset.id,
    title: asset.title,
    description: asset.description,
    primaryFileId: asset.primaryFileId,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

export function toProjectSummary(
  project: {
    id: string;
    title: string;
    mediaAssetId: string;
    ownerUserId: string;
    primaryWorkspaceId: string | null;
    currentProjectVersionId: string | null;
    updatedAt: Date;
    _count: {
      workspaces: number;
      annotationVersions: number;
      projectVersions: number;
      members: number;
    };
  },
  capabilities: ProjectCapability[],
): AnnotationProjectSummary {
  return {
    id: project.id,
    title: project.title,
    mediaAssetId: project.mediaAssetId,
    ownerUserId: project.ownerUserId,
    workspaceCount: project._count.workspaces,
    annotationVersionCount: project._count.annotationVersions,
    projectVersionCount: project._count.projectVersions,
    memberCount: project._count.members + 1,
    primaryWorkspaceId: project.primaryWorkspaceId,
    currentProjectVersionId: project.currentProjectVersionId,
    currentUserCapabilities: capabilities,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function toWorkspaceSummary(
  workspace: WorkspaceWithSummary,
  permission: EffectiveWorkspacePermission,
): AnnotationWorkspaceSummary {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    name: workspace.name,
    workspaceType: workspace.workspaceType,
    status: workspace.status,
    owner: workspace.owner,
    creator: workspace.creator,
    forkedFromVersionId: workspace.forkedFromVersionId,
    latestRevision: workspace.latestSnapshot?.revision ?? 0,
    versionCount: workspace._count.versions,
    submittedAt: workspace.submittedAt?.toISOString() ?? null,
    archivedAt: workspace.archivedAt?.toISOString() ?? null,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
    permission,
  };
}

export function toWorkspace<TPayload>(
  workspace: WorkspaceWithSummary & {
    project: {
      id: string;
      title: string;
      mediaAssetId: string;
      ownerUserId: string;
      primaryWorkspaceId: string | null;
      currentProjectVersionId: string | null;
      updatedAt: Date;
      mediaAsset: {
        id: string;
        title: string;
        description: string | null;
        primaryFileId: string | null;
        createdAt: Date;
        updatedAt: Date;
      };
      _count: {
        workspaces: number;
        annotationVersions: number;
        projectVersions: number;
        members: number;
      };
    };
  },
  permission: EffectiveWorkspacePermission,
  projectCapabilities: ProjectCapability[],
): AnnotationWorkspace<TPayload> {
  if (!workspace.latestSnapshot) {
    throw new Error("标注工作区缺少 latest snapshot。");
  }
  return {
    ...toWorkspaceSummary(workspace, permission),
    project: toProjectSummary(workspace.project, projectCapabilities),
    mediaAsset: toMediaAsset(workspace.project.mediaAsset),
    latestSnapshot: {
      id: workspace.latestSnapshot.id,
      workspaceId: workspace.latestSnapshot.workspaceId,
      revision: workspace.latestSnapshot.revision,
      payload: workspace.latestSnapshot.payload as TPayload,
      createdBy: workspace.latestSnapshot.createdBy,
      createdAt: workspace.latestSnapshot.createdAt.toISOString(),
    },
  };
}

export function toAnnotationVersionSummary(
  version: {
    id: string;
    projectId: string;
    workspaceId: string;
    snapshotId: string;
    parentVersionId: string | null;
    name: string;
    description: string | null;
    kind: "checkpoint" | "submission";
    status: "active" | "archived";
    completedAt: Date;
    archivedAt: Date | null;
    createdAt: Date;
    snapshot: { revision: number };
    creator: { id: string; accountName: string; displayName: string };
  },
): AnnotationVersionSummary {
  return {
    id: version.id,
    projectId: version.projectId,
    workspaceId: version.workspaceId,
    snapshotId: version.snapshotId,
    parentVersionId: version.parentVersionId,
    name: version.name,
    description: version.description,
    kind: version.kind,
    status: version.status,
    revision: version.snapshot.revision,
    creator: version.creator,
    completedAt: version.completedAt.toISOString(),
    archivedAt: version.archivedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toAnnotationVersion<TPayload>(
  version: AnnotationVersionWithDetails,
): AnnotationVersion<TPayload> {
  return {
    ...toAnnotationVersionSummary(version),
    snapshot: {
      id: version.snapshot.id,
      workspaceId: version.snapshot.workspaceId,
      revision: version.snapshot.revision,
      payload: version.snapshot.payload as TPayload,
      createdBy: version.snapshot.createdBy,
      createdAt: version.snapshot.createdAt.toISOString(),
    },
    workspace: {
      id: version.workspace.id,
      name: version.workspace.name,
      workspaceType: version.workspace.workspaceType,
      status: version.workspace.status,
      owner: version.workspace.owner,
    },
  };
}

export function toProjectVersion(version: ProjectVersionWithDetails): ProjectVersion {
  return {
    id: version.id,
    projectId: version.projectId,
    sourceVersionId: version.sourceVersionId,
    sequence: version.sequence,
    name: version.name,
    description: version.description,
    status: version.status,
    sourceVersion: toAnnotationVersionSummary(version.sourceVersion),
    creator: version.creator,
    publisher: version.publisher,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    archivedAt: version.archivedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}
