import type {
  AnnotationToolAttemptEntryPoint,
  AnnotationToolAttemptExternalOutcome,
  AnnotationToolAttemptReasonCode,
  AnnotationToolAttemptState,
} from "@xiqu/shared";
import { createRuntimeUuid } from "../utils/runtimeUuid";

const MAX_CHARACTER_COUNT = 10_000;
const MAX_SENTENCE_DURATION_MS = 86_400_000;

/** 只保存模型改进所需的有界数值与身份，不复制句子正文、ProjectData 或命令内容。 */
export function createSentenceCharacterTimingAttempt(input: {
  annotationFileId: string;
  sentenceId: string;
  entryPoint: AnnotationToolAttemptEntryPoint;
  characterCount: number;
  sentenceDurationSeconds: number;
  suppressPrompt: boolean;
  id?: string;
  now?: Date;
}): AnnotationToolAttemptState {
  return {
    id: input.id ?? createRuntimeUuid(),
    eventName: "sentence_character_even_timing_reset",
    annotationFileId: input.annotationFileId,
    sentenceId: input.sentenceId,
    entryPoint: input.entryPoint,
    invokedAt: (input.now ?? new Date()).toISOString(),
    confirmedAt: null,
    finishedAt: null,
    outcome: null,
    suppressPrompt: input.suppressPrompt,
    characterCount: clampInteger(input.characterCount, MAX_CHARACTER_COUNT),
    sentenceDurationMs: Number.isFinite(input.sentenceDurationSeconds)
      ? clampInteger(Math.round(input.sentenceDurationSeconds * 1_000), MAX_SENTENCE_DURATION_MS)
      : 0,
    details: null,
  };
}

export function confirmSentenceCharacterTimingAttempt(
  attempt: AnnotationToolAttemptState,
  input: { suppressPrompt: boolean; now?: Date },
): AnnotationToolAttemptState {
  const confirmedAt = toIsoAtLeast(input.now ?? new Date(), attempt.invokedAt);
  return {
    ...attempt,
    confirmedAt: attempt.confirmedAt ?? confirmedAt,
    suppressPrompt: attempt.suppressPrompt || input.suppressPrompt,
  };
}

export function finishSentenceCharacterTimingAttempt(
  attempt: AnnotationToolAttemptState,
  outcome: AnnotationToolAttemptExternalOutcome,
  reasonCode: AnnotationToolAttemptReasonCode,
  now = new Date(),
): AnnotationToolAttemptState {
  const finishedAt = toIsoAtLeast(now, attempt.confirmedAt ?? attempt.invokedAt);
  return {
    ...attempt,
    finishedAt,
    outcome,
    details: { reasonCode },
  };
}

function clampInteger(value: number, maximum: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}

// 系统时钟被校准回拨时仍保持生命周期单调，避免一条有效本地事实被 shared parser 拒绝。
function toIsoAtLeast(value: Date, lowerBound: string) {
  return new Date(Math.max(value.getTime(), new Date(lowerBound).getTime())).toISOString();
}
