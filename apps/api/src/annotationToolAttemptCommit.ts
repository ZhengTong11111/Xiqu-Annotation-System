import type {
  AnnotationOperation,
  AnnotationToolAttempt,
  Prisma,
} from "@prisma/client";
import {
  areProjectValuesEqual,
  resetSentenceCharactersToEvenTiming,
  type GongcheAnnotation,
  type ProjectData,
} from "@xiqu/document-model";
import {
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  type AtomicAnnotationCommandOperation,
} from "@xiqu/shared";
import { conflict } from "./errors.js";

export type PreparedAnnotationToolAttemptBinding = {
  operationIndex: number;
  attempt: AnnotationToolAttempt;
};

/**
 * 先按 UUID 稳定顺序锁定 attempt，再读取完整身份。批量送达和 command commit 使用同一 advisory key，
 * 多标签页迟到上报不能在绑定事务中间改写生命周期。
 */
export async function prepareAnnotationToolAttemptBindings(
  transaction: Prisma.TransactionClient,
  input: {
    actorUserId: string;
    annotationFileId: string;
    operations: readonly AtomicAnnotationCommandOperation[];
  },
): Promise<Map<number, PreparedAnnotationToolAttemptBinding>> {
  const indexedIds = input.operations.flatMap((operation, operationIndex) =>
    operation.toolAttemptId ? [{ operationIndex, attemptId: operation.toolAttemptId }] : []);
  if (indexedIds.length === 0) return new Map();

  for (const attemptId of indexedIds.map(({ attemptId }) => attemptId).sort()) {
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock(hashtext(${`xiqu:annotation-tool-attempt:${attemptId}`}))
    `;
  }
  const rows = await transaction.annotationToolAttempt.findMany({
    where: { id: { in: indexedIds.map(({ attemptId }) => attemptId) } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bindings = new Map<number, PreparedAnnotationToolAttemptBinding>();
  for (const { operationIndex, attemptId } of indexedIds) {
    const attempt = byId.get(attemptId);
    // 所有身份不匹配统一为同一稳定冲突，不向调用者泄漏另一个账号或文件的 attempt 是否存在。
    if (
      !attempt ||
      attempt.actorUserId !== input.actorUserId ||
      attempt.annotationFileId !== input.annotationFileId ||
      attempt.eventName !== "sentence_character_even_timing_reset" ||
      !attempt.confirmedAt ||
      attempt.outcome !== null ||
      attempt.finishedAt !== null ||
      attempt.annotationOperationId !== null ||
      attempt.committedRevision !== null
    ) {
      throw toolAttemptConflict("tool_attempt_not_bindable");
    }
    bindings.set(operationIndex, { operationIndex, attempt });
  }
  return bindings;
}

/**
 * 工具 operation 必须恰好产生 canonical 逐字平均结果。工尺时间可以随父字联动，
 * 但不能借同一 transaction 增删工尺实体、改正文，或改动其他父块的工尺数据。
 */
export function validateAnnotationToolAttemptCommand(
  binding: PreparedAnnotationToolAttemptBinding,
  operation: AtomicAnnotationCommandOperation,
  beforeProject: ProjectData,
  afterProject: ProjectData,
) {
  if (operation.payload.command.type !== ANNOTATION_TRANSACTION_APPLY_COMMAND) {
    throw toolAttemptConflict("tool_attempt_command_type_mismatch");
  }
  const { attempt } = binding;
  const sentence = beforeProject.subtitleLines.find(({ id }) => id === attempt.sentenceId);
  const canonical = resetSentenceCharactersToEvenTiming(beforeProject, attempt.sentenceId);
  if (
    !sentence ||
    !canonical.ok ||
    !canonical.changed ||
    canonical.characterIds.length !== attempt.characterCount ||
    Math.round((sentence.endTime - sentence.startTime) * 1_000) !== attempt.sentenceDurationMs
  ) {
    throw toolAttemptConflict("tool_attempt_source_mismatch");
  }

  // canonical project 已覆盖全部句级和逐字约束；先排除工尺数组，可证明命令没有夹带其他 ProjectData 修改。
  const canonicalCore = { ...canonical.project, gongcheAnnotations: [] };
  const afterCore = { ...afterProject, gongcheAnnotations: [] };
  if (!areProjectValuesEqual(canonicalCore, afterCore)) {
    throw toolAttemptConflict("tool_attempt_result_mismatch");
  }
  assertOnlyTargetGongcheTimingChanged(
    beforeProject.gongcheAnnotations,
    afterProject.gongcheAnnotations,
    new Set(canonical.characterIds),
  );
}

/** operation 行创建成功后在同一事务内终结旁表；任一 update 失败会连同文件 revision 一起回滚。 */
export async function commitAnnotationToolAttemptBinding(
  transaction: Prisma.TransactionClient,
  binding: PreparedAnnotationToolAttemptBinding,
  operation: Pick<AnnotationOperation, "id" | "committedRevision">,
  committedAt: Date,
) {
  if (operation.committedRevision === null) throw new Error("工具尝试不能绑定未提交 operation。");
  const finishedAt = new Date(Math.max(
    committedAt.getTime(),
    binding.attempt.confirmedAt?.getTime() ?? committedAt.getTime(),
  ));
  const updated = await transaction.annotationToolAttempt.updateMany({
    where: {
      id: binding.attempt.id,
      outcome: null,
      finishedAt: null,
      annotationOperationId: null,
      committedRevision: null,
    },
    data: {
      outcome: "committed",
      finishedAt,
      annotationOperationId: operation.id,
      committedRevision: operation.committedRevision,
    },
  });
  if (updated.count !== 1) throw toolAttemptConflict("tool_attempt_commit_race");
}

/** 精确幂等重放还需复核旁表指向同一 operation/revision，不能只相信历史 request hash。 */
export async function assertReplayedAnnotationToolAttemptBindings(
  transaction: Prisma.TransactionClient,
  operations: readonly AtomicAnnotationCommandOperation[],
  operationRows: readonly Pick<AnnotationOperation, "id" | "committedRevision">[],
) {
  const expected = operations.flatMap((operation, index) =>
    operation.toolAttemptId ? [{
      attemptId: operation.toolAttemptId,
      operationId: operationRows[index]?.id,
      committedRevision: operationRows[index]?.committedRevision,
    }] : []);
  if (expected.length === 0) return;
  const attempts = await transaction.annotationToolAttempt.findMany({
    where: { id: { in: expected.map(({ attemptId }) => attemptId) } },
  });
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  if (expected.some(({ attemptId, operationId, committedRevision }) => {
    const attempt = byId.get(attemptId);
    return !attempt ||
      attempt.outcome !== "committed" ||
      attempt.annotationOperationId !== operationId ||
      attempt.committedRevision !== committedRevision;
  })) {
    throw toolAttemptConflict("tool_attempt_replay_mismatch");
  }
}

function assertOnlyTargetGongcheTimingChanged(
  beforeItems: readonly GongcheAnnotation[],
  afterItems: readonly GongcheAnnotation[],
  characterIds: ReadonlySet<string>,
) {
  if (beforeItems.length !== afterItems.length) {
    throw toolAttemptConflict("tool_attempt_gongche_scope_mismatch");
  }
  for (const [index, before] of beforeItems.entries()) {
    const after = afterItems[index];
    if (!after || before.id !== after.id) {
      throw toolAttemptConflict("tool_attempt_gongche_scope_mismatch");
    }
    const belongsToResetCharacter =
      before.parentTrackId === "character-track" && characterIds.has(before.parentBlockId);
    if (belongsToResetCharacter) {
      if (!areProjectValuesEqual(stripGongcheTiming(before), stripGongcheTiming(after))) {
        throw toolAttemptConflict("tool_attempt_gongche_scope_mismatch");
      }
      continue;
    }
    if (!areProjectValuesEqual(before, after)) {
      throw toolAttemptConflict("tool_attempt_gongche_scope_mismatch");
    }
  }
}

// 关联工尺的时间由既有同步器和 command adapter 负责；这里仅去掉允许变化的时间字段后核对静态身份与正文。
function stripGongcheTiming(value: GongcheAnnotation) {
  return {
    ...value,
    startTime: 0,
    endTime: 0,
    symbols: value.symbols.map((symbol) => ({ ...symbol, startTime: 0, endTime: 0 })),
  };
}

function toolAttemptConflict(code: string) {
  return conflict("工具尝试与本次标注命令不匹配。", { code });
}
