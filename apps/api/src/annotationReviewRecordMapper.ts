import {
  AnnotationConfirmationDomain as DbAnnotationConfirmationDomain,
  Prisma,
} from "@prisma/client";
import type {
  AnnotationConfirmationDomain,
  AnnotationConfirmationRecord,
  AnnotationRangeCommentRecord,
} from "@xiqu/shared";
import { toPublicUser } from "./repositoryMappers.js";

export const annotationConfirmationInclude = {
  creator: { include: { roles: true } },
  revoker: { include: { roles: true } },
} satisfies Prisma.AnnotationConfirmationInclude;

export const annotationRangeCommentInclude = {
  creator: { include: { roles: true } },
  withdrawer: { include: { roles: true } },
} satisfies Prisma.AnnotationRangeCommentInclude;

export type AnnotationConfirmationRow = Prisma.AnnotationConfirmationGetPayload<{
  include: typeof annotationConfirmationInclude;
}>;
export type AnnotationRangeCommentRow = Prisma.AnnotationRangeCommentGetPayload<{
  include: typeof annotationRangeCommentInclude;
}>;

const SHARED_CONFIRMATION_DOMAINS: Record<
  DbAnnotationConfirmationDomain,
  AnnotationConfirmationDomain
> = {
  subtitle_lines: "subtitle_lines",
  character_annotations: "character_annotations",
  gongche_annotations: "gongche_annotations",
  banyan_sections: "banyan_sections",
  banyan_marks: "banyan_marks",
  custom_tracks: "custom_tracks",
  custom_blocks: "custom_blocks",
  attached_points: "attached_points",
};

// 原生审核事实与重新链接来源核验共用同一出站映射，避免同一数据库行生成两种 JSON 语义。
export function mapAnnotationConfirmation(
  row: AnnotationConfirmationRow,
): AnnotationConfirmationRecord {
  const targets = row.targetMode === "domains"
    ? {
        mode: "domains" as const,
        domains: row.domains.map((domain) => SHARED_CONFIRMATION_DOMAINS[domain]),
      }
    : row.targetMode === "tracks"
      ? { mode: "tracks" as const, trackIds: [...row.trackIds] }
      : { mode: "all" as const };
  const base = {
    id: row.id,
    annotationFileId: row.annotationFileId,
    confirmedRevision: row.confirmedRevision,
    scope: { startTime: row.startTime, endTime: row.endTime, targets },
    note: row.note,
    createdBy: toPublicUser(row.creator),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.revokedAt && row.revoker) {
    return {
      ...base,
      revokedAt: row.revokedAt.toISOString(),
      revokedBy: toPublicUser(row.revoker),
      revokeReason: row.revokeReason,
    };
  }
  return { ...base, revokedAt: null, revokedBy: null, revokeReason: null };
}

export function mapAnnotationRangeComment(
  row: AnnotationRangeCommentRow,
): AnnotationRangeCommentRecord {
  const targets = row.targetMode === "domains"
    ? {
        mode: "domains" as const,
        domains: row.domains.map((domain) => SHARED_CONFIRMATION_DOMAINS[domain]),
      }
    : row.targetMode === "tracks"
      ? { mode: "tracks" as const, trackIds: [...row.trackIds] }
      : { mode: "all" as const };
  const base = {
    id: row.id,
    annotationFileId: row.annotationFileId,
    commentedRevision: row.commentedRevision,
    scope: { startTime: row.startTime, endTime: row.endTime, targets },
    kind: row.kind,
    body: row.body,
    createdBy: toPublicUser(row.creator),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.withdrawnAt && row.withdrawer) {
    return {
      ...base,
      withdrawnAt: row.withdrawnAt.toISOString(),
      withdrawnBy: toPublicUser(row.withdrawer),
      withdrawReason: row.withdrawReason,
    };
  }
  return { ...base, withdrawnAt: null, withdrawnBy: null, withdrawReason: null };
}
