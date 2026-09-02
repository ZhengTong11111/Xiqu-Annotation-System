import type { PrismaClient } from "@prisma/client";

export const MAX_ANNOTATION_HISTORY_DEPENDENCY_RECIPES = 10_000;

export type AnnotationHistoryDependencyIssueCode =
  | "checkpoint_missing"
  | "malformed_recipe"
  | "recipe_scan_truncated";

export type AnnotationHistoryDependencyRecipeRow = {
  id: string;
  annotationFileId: string;
  revision: number;
  checkpointSnapshotId: string | null;
  operationRevisionStart: number | null;
  operationRevisionEnd: number | null;
  operationSequenceStart: number | null;
  operationSequenceEnd: number | null;
  operationCount: number | null;
  compactionVersion: number | null;
  compactedAt: Date | null;
};

export type AnnotationHistoryDependencyRange = {
  recipeSnapshotId: string;
  checkpointSnapshotId: string;
  operationRevisionStart: number;
  operationRevisionEnd: number;
  operationSequenceStart: number;
  operationSequenceEnd: number;
};

export type AnnotationHistoryDependencyProtection = {
  valid: boolean;
  truncated: boolean;
  issues: Array<{
    code: AnnotationHistoryDependencyIssueCode;
    snapshotId: string | null;
  }>;
  checkpointSnapshotIds: Set<string>;
  operationRanges: AnnotationHistoryDependencyRange[];
};

/**
 * 将轻量 recipe 元数据收敛为生命周期保护集合。任一坏 recipe 都会使结果整体失效，
 * 后续清理器必须据此停止，而不能跳过坏行后继续删除其他依赖。
 */
export function buildAnnotationHistoryDependencyProtection(input: {
  annotationFileId: string;
  rows: AnnotationHistoryDependencyRecipeRow[];
  checkpointRevisions: ReadonlyMap<string, number>;
  truncated?: boolean;
}): AnnotationHistoryDependencyProtection {
  const issues: AnnotationHistoryDependencyProtection["issues"] = [];
  const checkpointSnapshotIds = new Set<string>();
  const operationRanges: AnnotationHistoryDependencyRange[] = [];

  if (input.truncated) {
    issues.push({ code: "recipe_scan_truncated", snapshotId: null });
  }

  for (const row of input.rows) {
    const checkpointId = normalizeIdentifier(row.checkpointSnapshotId);
    const checkpointRevision = checkpointId
      ? input.checkpointRevisions.get(checkpointId)
      : undefined;
    if (row.annotationFileId !== input.annotationFileId || !isValidRecipe(row, checkpointRevision)) {
      issues.push({ code: "malformed_recipe", snapshotId: normalizeIdentifier(row.id) });
      continue;
    }
    if (!checkpointId || checkpointRevision === undefined) {
      issues.push({ code: "checkpoint_missing", snapshotId: normalizeIdentifier(row.id) });
      continue;
    }

    checkpointSnapshotIds.add(checkpointId);
    operationRanges.push({
      recipeSnapshotId: row.id,
      checkpointSnapshotId: checkpointId,
      operationRevisionStart: row.operationRevisionStart!,
      operationRevisionEnd: row.operationRevisionEnd!,
      operationSequenceStart: row.operationSequenceStart!,
      operationSequenceEnd: row.operationSequenceEnd!,
    });
  }

  return {
    valid: issues.length === 0,
    truncated: Boolean(input.truncated),
    issues,
    checkpointSnapshotIds,
    operationRanges,
  };
}

/**
 * 当前只查询 reconstructible 行及其 checkpoint 身份，不读取 payload、operation body 或审核正文。
 * 多取一行只用于识别截断；超过上限时结果 fail closed，禁止生命周期任务继续清理。
 */
export async function loadAnnotationHistoryDependencyProtection(
  prisma: PrismaClient,
  input: {
    annotationFileId: string;
    maxRecipes?: number;
  },
): Promise<AnnotationHistoryDependencyProtection> {
  const maxRecipes = input.maxRecipes ?? MAX_ANNOTATION_HISTORY_DEPENDENCY_RECIPES;
  if (!Number.isInteger(maxRecipes) || maxRecipes < 1 || maxRecipes > MAX_ANNOTATION_HISTORY_DEPENDENCY_RECIPES) {
    throw new Error("恢复历史依赖扫描上限无效。");
  }

  const rows = await prisma.annotationRecoverySnapshot.findMany({
    where: {
      annotationFileId: input.annotationFileId,
      storageMode: "reconstructible",
    },
    select: {
      id: true,
      annotationFileId: true,
      revision: true,
      checkpointSnapshotId: true,
      operationRevisionStart: true,
      operationRevisionEnd: true,
      operationSequenceStart: true,
      operationSequenceEnd: true,
      operationCount: true,
      compactionVersion: true,
      compactedAt: true,
    },
    orderBy: [{ revision: "asc" }, { id: "asc" }],
    take: maxRecipes + 1,
  });
  const truncated = rows.length > maxRecipes;
  const boundedRows = rows.slice(0, maxRecipes);
  const checkpointIds = [...new Set(boundedRows.flatMap((row) => {
    const id = normalizeIdentifier(row.checkpointSnapshotId);
    return id ? [id] : [];
  }))];
  const checkpoints = checkpointIds.length === 0
    ? []
    : await prisma.annotationRecoverySnapshot.findMany({
        where: {
          annotationFileId: input.annotationFileId,
          id: { in: checkpointIds },
        },
        select: { id: true, revision: true },
      });

  return buildAnnotationHistoryDependencyProtection({
    annotationFileId: input.annotationFileId,
    rows: boundedRows,
    checkpointRevisions: new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.revision])),
    truncated,
  });
}

/** 依赖模型无效时保护全部 snapshot，避免调用方误把“不完整信息”理解成“没有依赖”。 */
export function isAnnotationHistorySnapshotProtected(
  protection: AnnotationHistoryDependencyProtection,
  snapshotId: string,
): boolean {
  const normalizedId = normalizeIdentifier(snapshotId);
  return !protection.valid || !normalizedId || protection.checkpointSnapshotIds.has(normalizedId);
}

/** 只要候选 operation 区间与任一 recipe 区间相交就必须保留；无效模型同样保护全部。 */
export function isAnnotationHistoryOperationRangeProtected(
  protection: AnnotationHistoryDependencyProtection,
  input: { revisionStart: number; revisionEnd: number; sequenceStart: number; sequenceEnd: number },
): boolean {
  if (
    !protection.valid ||
    !isPositiveInteger(input.revisionStart) ||
    !isPositiveInteger(input.revisionEnd) ||
    !isPositiveInteger(input.sequenceStart) ||
    !isPositiveInteger(input.sequenceEnd) ||
    input.revisionStart > input.revisionEnd ||
    input.sequenceStart > input.sequenceEnd
  ) {
    return true;
  }
  return protection.operationRanges.some((range) =>
    rangesOverlap(input.revisionStart, input.revisionEnd, range.operationRevisionStart, range.operationRevisionEnd) &&
    rangesOverlap(input.sequenceStart, input.sequenceEnd, range.operationSequenceStart, range.operationSequenceEnd));
}

function isValidRecipe(
  row: AnnotationHistoryDependencyRecipeRow,
  checkpointRevision: number | undefined,
): boolean {
  const rowId = normalizeIdentifier(row.id);
  const checkpointId = normalizeIdentifier(row.checkpointSnapshotId);
  if (
    !rowId ||
    rowId !== row.id ||
    !checkpointId ||
    checkpointId !== row.checkpointSnapshotId ||
    checkpointId === rowId ||
    !isPositiveInteger(row.revision) ||
    !isPositiveInteger(row.operationRevisionStart) ||
    !isPositiveInteger(row.operationRevisionEnd) ||
    !isPositiveInteger(row.operationSequenceStart) ||
    !isPositiveInteger(row.operationSequenceEnd) ||
    !isPositiveInteger(row.operationCount) ||
    !isPositiveInteger(row.compactionVersion) ||
    !row.compactedAt ||
    !Number.isFinite(row.compactedAt.getTime())
  ) {
    return false;
  }
  const sequenceSpan = row.operationSequenceEnd - row.operationSequenceStart + 1;
  const intrinsicRangeValid = row.operationRevisionStart <= row.operationRevisionEnd &&
    row.operationRevisionEnd === row.revision &&
    row.operationSequenceStart <= row.operationSequenceEnd &&
    row.operationCount <= sequenceSpan;
  if (!intrinsicRangeValid || checkpointRevision === undefined) return intrinsicRangeValid;
  return checkpointRevision < row.operationRevisionStart;
}

function isPositiveInteger(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeIdentifier(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}
