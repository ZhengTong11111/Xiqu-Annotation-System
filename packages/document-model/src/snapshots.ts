import type {
  AnnotationSnapshot,
  AnnotationVersion,
  AnnotationVersionKind,
  AnnotationWorkspaceSummary,
} from "@xiqu/shared";

export type CreateSnapshotInput<TPayload> = {
  workspaceId: string;
  payload: TPayload;
  revision: number;
  userId: string;
  now?: Date;
};

export type CreateVersionInput<TPayload> = {
  projectId: string;
  workspace: AnnotationWorkspaceSummary;
  snapshot: AnnotationSnapshot<TPayload>;
  name: string;
  description?: string | null;
  kind?: AnnotationVersionKind;
  parentVersionId?: string | null;
  userId: string;
  now?: Date;
};

export function createAnnotationSnapshot<TPayload>({
  workspaceId,
  payload,
  revision,
  userId,
  now = new Date(),
}: CreateSnapshotInput<TPayload>): AnnotationSnapshot<TPayload> {
  return {
    id: createStableEnoughId("snapshot"),
    workspaceId,
    revision,
    payload,
    createdBy: userId,
    createdAt: now.toISOString(),
  };
}

export function createAnnotationVersion<TPayload>({
  projectId,
  workspace,
  snapshot,
  name,
  description = null,
  kind = "checkpoint",
  parentVersionId = null,
  userId,
  now = new Date(),
}: CreateVersionInput<TPayload>): AnnotationVersion<TPayload> {
  const completedAt = now.toISOString();
  return {
    id: createStableEnoughId("version"),
    projectId,
    workspaceId: workspace.id,
    snapshotId: snapshot.id,
    parentVersionId,
    name,
    description,
    kind,
    status: "active",
    revision: snapshot.revision,
    snapshot,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      workspaceType: workspace.workspaceType,
      status: workspace.status,
      owner: workspace.owner,
    },
    creator: {
      id: userId,
      accountName: "",
      displayName: "",
    },
    completedAt,
    archivedAt: null,
    createdAt: completedAt,
  };
}

function createStableEnoughId(prefix: string) {
  // 该 helper 只用于不落库的 document-model 测试；真正平台记录始终由数据库生成 UUID。
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
