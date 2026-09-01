import { z } from "zod";
import {
  ANNOTATION_RANGE_COMMENT_KINDS,
  ANNOTATION_REVIEW_DOMAINS,
  ANNOTATION_REVIEW_PACKAGE_FORMAT,
  ANNOTATION_REVIEW_PACKAGE_MAX_RECORDS,
  ANNOTATION_REVIEW_PACKAGE_VERSION,
  type AnnotationConfirmationRecord,
  type AnnotationRangeCommentRecord,
  type AnnotationReviewPackageV1,
} from "@xiqu/shared";
import {
  getAnnotationConfirmationLifecycle,
  validateAnnotationConfirmationDraft,
} from "./annotationConfirmations.js";
import {
  getAnnotationRangeCommentLifecycle,
  validateAnnotationRangeCommentDraft,
} from "./annotationRangeComments.js";

const MAX_PACKAGE_NAME_LENGTH = 500;
const MAX_IDENTIFIER_LENGTH = 200;

const identifierSchema = z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH);
const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "时间必须是有效 ISO 日期。",
).transform((value) => new Date(value).toISOString());
const userReferenceSchema = z.object({
  id: identifierSchema,
  displayName: z.string().trim().min(1).max(200),
  accountName: z.string().trim().min(1).max(200),
});
const targetsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("domains"),
    domains: z.array(z.enum(ANNOTATION_REVIEW_DOMAINS)).min(1),
  }),
  z.object({
    mode: z.literal("tracks"),
    trackIds: z.array(identifierSchema).min(1),
  }),
]);
const scopeSchema = z.object({
  startTime: z.number().finite().nonnegative(),
  endTime: z.number().finite().positive(),
  targets: targetsSchema,
});
const confirmationSchema = z.object({
  id: identifierSchema,
  annotationFileId: identifierSchema,
  confirmedRevision: z.number().int().positive(),
  scope: scopeSchema,
  note: z.string().max(2_000).nullable().optional(),
  createdBy: userReferenceSchema,
  createdAt: timestampSchema,
  revokedAt: timestampSchema.nullable().optional(),
  revokedBy: userReferenceSchema.nullable().optional(),
  revokeReason: z.string().max(2_000).nullable().optional(),
});
const rangeRecordSchema = z.object({
  id: identifierSchema,
  annotationFileId: identifierSchema,
  commentedRevision: z.number().int().positive(),
  scope: scopeSchema,
  kind: z.enum(ANNOTATION_RANGE_COMMENT_KINDS),
  body: z.string().trim().min(1).max(4_000),
  createdBy: userReferenceSchema,
  createdAt: timestampSchema,
  withdrawnAt: timestampSchema.nullable().optional(),
  withdrawnBy: userReferenceSchema.nullable().optional(),
  withdrawReason: z.string().max(2_000).nullable().optional(),
});
const packageSchema = z.object({
  format: z.literal(ANNOTATION_REVIEW_PACKAGE_FORMAT),
  version: z.literal(ANNOTATION_REVIEW_PACKAGE_VERSION),
  exportedAt: timestampSchema,
  source: z.object({
    annotationFileId: identifierSchema,
    annotationFileName: z.string().trim().min(1).max(MAX_PACKAGE_NAME_LENGTH),
    revision: z.number().int().positive(),
  }),
  counts: z.object({
    confirmations: z.number().int().nonnegative(),
    rangeRecords: z.number().int().nonnegative(),
  }),
  records: z.object({
    confirmations: z.array(confirmationSchema),
    rangeRecords: z.array(rangeRecordSchema),
  }),
});

export type AnnotationReviewPackageParseResult =
  | { ok: true; value: AnnotationReviewPackageV1 }
  | { ok: false; issues: string[] };

// 审核包只在这一处从 unknown 进入领域模型；解析同时规范化时间与用户引用并拒绝半截生命周期。
export function parseAnnotationReviewPackage(value: unknown): AnnotationReviewPackageParseResult {
  const parsed = packageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((issue) =>
        `${issue.path.join(".") || "reviewPackage"}: ${issue.message}`),
    };
  }

  const reviewPackage = parsed.data as AnnotationReviewPackageV1;
  const issues = validatePackageRecords(reviewPackage);
  return issues.length ? { ok: false, issues } : { ok: true, value: reviewPackage };
}

// 指纹输入排除导出时间，但保留来源身份、revision 和全部事实；同一内容反复导出只形成一个目标关联。
export function buildAnnotationReviewPackageFingerprintInput(
  reviewPackage: AnnotationReviewPackageV1,
): string {
  return stableJsonStringify({
    format: reviewPackage.format,
    version: reviewPackage.version,
    source: reviewPackage.source,
    counts: reviewPackage.counts,
    records: reviewPackage.records,
  });
}

function validatePackageRecords(reviewPackage: AnnotationReviewPackageV1): string[] {
  const issues: string[] = [];
  const total = reviewPackage.records.confirmations.length + reviewPackage.records.rangeRecords.length;
  if (total === 0) issues.push("审核包至少需要包含一条确认、评论或反馈记录。");
  if (total > ANNOTATION_REVIEW_PACKAGE_MAX_RECORDS) {
    issues.push(`审核包最多允许 ${ANNOTATION_REVIEW_PACKAGE_MAX_RECORDS} 条记录。`);
  }
  if (
    reviewPackage.counts.confirmations !== reviewPackage.records.confirmations.length ||
    reviewPackage.counts.rangeRecords !== reviewPackage.records.rangeRecords.length
  ) {
    issues.push("审核包 counts 与实际记录数量不一致。");
  }

  const identities = new Set<string>();
  for (const record of reviewPackage.records.confirmations) {
    validateRecordIdentity(record, "confirmation", reviewPackage.source.annotationFileId, identities, issues);
    const draft = validateAnnotationConfirmationDraft(record);
    if (!draft.ok) issues.push(...draft.issues.map((issue) => `确认 ${record.id}: ${issue.message}`));
    const lifecycle = getAnnotationConfirmationLifecycle(record);
    if (!lifecycle.ok) issues.push(...lifecycle.issues.map((issue) => `确认 ${record.id}: ${issue.message}`));
    if (record.confirmedRevision > reviewPackage.source.revision) {
      issues.push(`确认 ${record.id} 的 revision 晚于来源文件 revision。`);
    }
  }
  for (const record of reviewPackage.records.rangeRecords) {
    validateRecordIdentity(record, "range_record", reviewPackage.source.annotationFileId, identities, issues);
    const draft = validateAnnotationRangeCommentDraft(record);
    if (!draft.ok) issues.push(...draft.issues.map((issue) => `范围记录 ${record.id}: ${issue.message}`));
    const lifecycle = getAnnotationRangeCommentLifecycle(record);
    if (!lifecycle.ok) issues.push(...lifecycle.issues.map((issue) => `范围记录 ${record.id}: ${issue.message}`));
    if (record.commentedRevision > reviewPackage.source.revision) {
      issues.push(`范围记录 ${record.id} 的 revision 晚于来源文件 revision。`);
    }
  }
  return issues.slice(0, 50);
}

function validateRecordIdentity(
  record: AnnotationConfirmationRecord | AnnotationRangeCommentRecord,
  kind: "confirmation" | "range_record",
  sourceFileId: string,
  identities: Set<string>,
  issues: string[],
) {
  if (record.annotationFileId !== sourceFileId) {
    issues.push(`记录 ${record.id} 不属于审核包声明的来源文件。`);
  }
  const identity = `${kind}:${record.id}`;
  if (identities.has(identity)) issues.push(`审核包包含重复记录 ${identity}。`);
  identities.add(identity);
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
