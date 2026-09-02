import {
  MAX_ANNOTATION_COMMAND_ITEMS,
  MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
  buildTimelineTimingUpdateEnvelope,
  type TimelineTimingCommandEnvelope,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import type { AlignmentPredictionArtifact } from "./alignmentPrediction.js";
import { buildAlignmentTextProjection } from "./alignmentTextProjection.js";
import type { ProjectData } from "./projectData.js";

export const MAX_ALIGNMENT_APPLICATION_CHARACTERS =
  MAX_ANNOTATION_COMMAND_ITEMS * MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS;

export type AlignmentPredictionApplicationPlan = {
  commands: TimelineTimingCommandEnvelope[];
  appliedCharacterCount: number;
};

export type AlignmentPredictionApplicationPlanResult =
  | { status: "ready"; plan: AlignmentPredictionApplicationPlan }
  | { status: "no_changes" }
  | { status: "identity_mismatch"; entityId?: string }
  | { status: "too_large"; characterCount: number }
  | { status: "project_not_alignable"; code: string };

/**
 * 把已经通过 artifact parser 的预测映射为普通逐字 timing command。
 * 句级边界只用于验证稳定身份，本轮不会修改句级时间，确保应用自身不使同一 run 的文本投影失效。
 */
export function buildAlignmentPredictionApplicationPlan(
  project: ProjectData,
  prediction: AlignmentPredictionArtifact,
): AlignmentPredictionApplicationPlanResult {
  const projectionResult = buildAlignmentTextProjection(project);
  if (!projectionResult.ok) {
    return { status: "project_not_alignable", code: projectionResult.code };
  }
  const projection = projectionResult.projection;
  if (projection.sentences.length !== prediction.sentences.length) {
    return { status: "identity_mismatch" };
  }

  // 大型折子戏可能包含数万逐字块；先建立稳定身份索引，避免逐字 find 退化成 O(n²)。
  const charactersById = new Map(
    project.characterAnnotations.map((character) => [character.id, character] as const),
  );
  const changedItems: TimelineTimingUpdateItem[] = [];
  for (let sentenceIndex = 0; sentenceIndex < projection.sentences.length; sentenceIndex += 1) {
    const expectedSentence = projection.sentences[sentenceIndex]!;
    const predictedSentence = prediction.sentences[sentenceIndex]!;
    if (
      expectedSentence.sentenceId !== predictedSentence.sentenceId ||
      expectedSentence.characters.length !== predictedSentence.characters.length
    ) {
      return { status: "identity_mismatch", entityId: expectedSentence.sentenceId };
    }
    for (let characterIndex = 0; characterIndex < expectedSentence.characters.length; characterIndex += 1) {
      const expectedCharacter = expectedSentence.characters[characterIndex]!;
      const predictedCharacter = predictedSentence.characters[characterIndex]!;
      if (expectedCharacter.characterId !== predictedCharacter.characterId) {
        return { status: "identity_mismatch", entityId: expectedCharacter.characterId };
      }
      const currentCharacter = charactersById.get(expectedCharacter.characterId);
      if (!currentCharacter) {
        return { status: "identity_mismatch", entityId: expectedCharacter.characterId };
      }
      const after = {
        startTime: predictedCharacter.startMicros / 1_000_000,
        endTime: predictedCharacter.endMicros / 1_000_000,
      };
      if (
        currentCharacter.startTime === after.startTime &&
        currentCharacter.endTime === after.endTime
      ) continue;
      changedItems.push({
        entityType: "character",
        entityId: currentCharacter.id,
        before: {
          startTime: currentCharacter.startTime,
          endTime: currentCharacter.endTime,
        },
        after,
      });
    }
  }

  if (changedItems.length === 0) return { status: "no_changes" };
  if (changedItems.length > MAX_ALIGNMENT_APPLICATION_CHARACTERS) {
    return { status: "too_large", characterCount: changedItems.length };
  }

  // 先做全局稳定排序再分块，确保同一 base/prediction 的网络重试生成完全相同的 operation 序列。
  changedItems.sort((left, right) => left.entityId.localeCompare(right.entityId));
  const commands: TimelineTimingCommandEnvelope[] = [];
  for (let offset = 0; offset < changedItems.length; offset += MAX_ANNOTATION_COMMAND_ITEMS) {
    const envelope = buildTimelineTimingUpdateEnvelope(
      changedItems.slice(offset, offset + MAX_ANNOTATION_COMMAND_ITEMS),
    );
    // 输入已去除 no-op 且通过 prediction parser；此处失败说明共享命令预算/合同发生漂移。
    if (!envelope) return { status: "identity_mismatch" };
    commands.push(envelope);
  }
  return {
    status: "ready",
    plan: { commands, appliedCharacterCount: changedItems.length },
  };
}
