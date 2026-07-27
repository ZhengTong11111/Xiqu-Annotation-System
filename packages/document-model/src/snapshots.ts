import type {
  AnnotationDocumentSnapshot,
  AnnotationVersion,
} from "@xiqu/shared";

export type CreateSnapshotInput<TPayload> = {
  documentId: string;
  payload: TPayload;
  revision: number;
  userId: string;
  now?: Date;
};

export type CreateVersionInput<TPayload> = {
  snapshot: AnnotationDocumentSnapshot<TPayload>;
  name: string;
  description?: string | null;
  userId: string;
  now?: Date;
};

export function createAnnotationSnapshot<TPayload>({
  documentId,
  payload,
  revision,
  userId,
  now = new Date(),
}: CreateSnapshotInput<TPayload>): AnnotationDocumentSnapshot<TPayload> {
  return {
    id: createStableEnoughId("snapshot"),
    documentId,
    revision,
    payload,
    createdBy: userId,
    createdAt: now.toISOString(),
  };
}

export function createAnnotationVersion<TPayload>({
  snapshot,
  name,
  description = null,
  userId,
  now = new Date(),
}: CreateVersionInput<TPayload>): AnnotationVersion<TPayload> {
  return {
    id: createStableEnoughId("version"),
    documentId: snapshot.documentId,
    name,
    description,
    revision: snapshot.revision,
    snapshot,
    createdBy: userId,
    createdAt: now.toISOString(),
  };
}

function createStableEnoughId(prefix: string) {
  // 这里刻意不绑定浏览器或 Node 的 crypto，实现跨前后端可复用的临时 ID。
  // 真正落库后应由数据库/服务端统一生成不可碰撞 ID。
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
