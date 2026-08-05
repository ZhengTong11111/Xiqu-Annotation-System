import type { Prisma } from "@prisma/client";
import {
  isReplayableAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
  type AnnotationOperationRecord,
} from "@xiqu/shared";

export type AnnotationOperationRow = {
  id: string;
  annotationFileId: string;
  actorUserId: string;
  clientOperationId: string;
  requestHash: string;
  sequence: number;
  baseRevision: number;
  localRevision: number | null;
  action: string;
  payload: Prisma.JsonValue;
  status: "accepted" | "rejected" | "superseded";
  committedRevision: number | null;
  committedAt: Date | null;
  createdAt: Date;
};

// 接收日志、committed feed 与原子提交响应必须使用同一映射，避免同一数据库行出现不同重放声明。
export function mapAnnotationOperationRecord(
  row: AnnotationOperationRow,
): AnnotationOperationRecord {
  return {
    id: row.id,
    annotationFileId: row.annotationFileId,
    actorUserId: row.actorUserId,
    clientOperationId: row.clientOperationId,
    sequence: row.sequence,
    baseRevision: row.baseRevision,
    localRevision: row.localRevision,
    action: row.action,
    payload: row.payload,
    status: row.status,
    commitState: row.committedRevision === null ? "accepted" : "committed",
    committedRevision: row.committedRevision,
    committedAt: row.committedAt?.toISOString() ?? null,
    replayability: parseAnnotationCommandEnvelope(row.payload)?.command.type === row.action &&
      isReplayableAnnotationCommandEnvelope(row.payload)
      ? "domain_command"
      : "requires_snapshot",
    createdAt: row.createdAt.toISOString(),
  };
}
