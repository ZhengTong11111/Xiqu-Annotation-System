import type { Prisma } from "@prisma/client";
import {
  ALIGNMENT_QUALITY_ISSUE_CODES,
  ALIGNMENT_TRAINING_CANDIDATE_SIGNALS,
  parseTimelineTimingCommandEnvelope,
  type AlignmentQualityIssueCode,
  type AlignmentQualityVerdict,
  type AlignmentTrainingCandidate,
} from "@xiqu/shared";
import { readPredictionQualitySummary } from "./alignmentArtifactMetadata.js";

export type AlignmentTrainingEvidenceApplication = {
  id: string;
  alignmentRunId: string;
  alignmentArtifactId: string;
  baseRevision: number;
  committedRevision: number;
  createdAt: Date;
  runManifest: Prisma.JsonValue;
  currentAssessments: ReadonlyArray<{
    id: string;
    verdict: AlignmentQualityVerdict;
    issueCodes: AlignmentQualityIssueCode[];
  }>;
};

export type AlignmentTrainingEvidenceOperation = {
  committedRevision: number | null;
  action: string;
  payload: unknown;
  alignmentApplicationId: string | null;
};

export type DerivedAlignmentTrainingEvidence = {
  candidate: AlignmentTrainingCandidate;
  quality: {
    verdict: AlignmentQualityVerdict;
    issueCodes: AlignmentQualityIssueCode[];
    assessmentIds: string[];
  };
};

/**
 * 候选页与冻结事务必须共用这一份纯派生规则。输入只含有界数据库事实，
 * 输出不携带 operation payload、正文、账号或对象位置。
 */
export function deriveAlignmentTrainingEvidence(
  application: AlignmentTrainingEvidenceApplication,
  observationEndRevision: number,
  operations: readonly AlignmentTrainingEvidenceOperation[],
  scanComplete: boolean,
): DerivedAlignmentTrainingEvidence {
  // 观察窗口只统计本次应用之后、下一次应用之前的普通人工操作；自动应用命令不算人工修订。
  const relevant = operations.filter((operation) =>
    operation.committedRevision !== null &&
    operation.committedRevision > application.committedRevision &&
    operation.committedRevision <= observationEndRevision &&
    operation.alignmentApplicationId === null);
  const editedCharacters = new Set<string>();
  let timingOperationCount = 0;
  let totalBoundaryDeltaMicros = 0;
  let maxBoundaryDeltaMicros = 0;
  let documentChanged = false;
  let invalid = false;

  for (const operation of relevant) {
    if (operation.action !== "timeline.items.timing.update") {
      documentChanged = true;
      continue;
    }
    const envelope = parseTimelineTimingCommandEnvelope(operation.payload);
    if (!envelope) {
      invalid = true;
      continue;
    }
    let hasCharacterTiming = false;
    let hasOtherTiming = false;
    for (const item of envelope.command.items) {
      if (item.entityType !== "character") {
        hasOtherTiming = true;
        continue;
      }
      hasCharacterTiming = true;
      editedCharacters.add(item.entityId);
      for (const delta of [
        Math.abs(item.after.startTime - item.before.startTime),
        Math.abs(item.after.endTime - item.before.endTime),
      ]) {
        const micros = Math.round(delta * 1_000_000);
        totalBoundaryDeltaMicros += micros;
        maxBoundaryDeltaMicros = Math.max(maxBoundaryDeltaMicros, micros);
      }
    }
    if (hasCharacterTiming) timingOperationCount += 1;
    if (hasOtherTiming) documentChanged = true;
  }
  if (!Number.isSafeInteger(totalBoundaryDeltaMicros)) invalid = true;

  const prediction = readPredictionQualitySummary(application.runManifest);
  const issueSet = new Set<AlignmentQualityIssueCode>();
  const assessmentIds: string[] = [];
  const assessments = { correct: 0, needsAdjustment: 0, unusable: 0 };
  for (const assessment of application.currentAssessments) {
    assessmentIds.push(assessment.id);
    if (assessment.verdict === "correct") assessments.correct += 1;
    else if (assessment.verdict === "needs_adjustment") assessments.needsAdjustment += 1;
    else assessments.unusable += 1;
    for (const issue of assessment.issueCodes) issueSet.add(issue);
  }
  const issueCodes = ALIGNMENT_QUALITY_ISSUE_CODES.filter((issue) => issueSet.has(issue));
  const signals = ALIGNMENT_TRAINING_CANDIDATE_SIGNALS.filter((signal) => {
    if (signal === "low_prediction_confidence") {
      return prediction.status === "ready" && prediction.summary.lowConfidenceCharacterCount > 0;
    }
    if (signal === "ambiguous_prediction") {
      return prediction.status === "ready" && prediction.summary.closeAlternativeCharacterCount > 0;
    }
    if (signal === "manual_timing_adjustment") return !invalid && editedCharacters.size > 0;
    if (signal === "negative_quality_assessment") {
      return assessments.needsAdjustment + assessments.unusable > 0;
    }
    return documentChanged;
  });
  const manualTiming = {
    operationCount: invalid ? 0 : timingOperationCount,
    editedCharacterCount: invalid ? 0 : editedCharacters.size,
    totalBoundaryDeltaMicros: invalid ? 0 : totalBoundaryDeltaMicros,
    maxBoundaryDeltaMicros: invalid ? 0 : maxBoundaryDeltaMicros,
  };

  return {
    candidate: {
      alignmentApplicationId: application.id,
      alignmentRunId: application.alignmentRunId,
      alignmentArtifactId: application.alignmentArtifactId,
      baseRevision: application.baseRevision,
      committedRevision: application.committedRevision,
      observationEndRevision,
      createdAt: application.createdAt.toISOString(),
      predictionSummaryState: prediction.status,
      predictionSummary: prediction.status === "ready" ? prediction.summary : null,
      manualTiming,
      assessments: { ...assessments, issueCodes },
      documentChangedAfterApplication: documentChanged,
      evidenceState: invalid ? "invalid" : scanComplete ? "complete" : "partial",
      signals: [...signals],
      // 保留既有候选页语义；冻结服务另以 assessmentIds 判定真正的 unrated。
      unrated: signals.length === 0 && assessments.correct === 0,
    },
    quality: {
      verdict: assessments.unusable > 0
        ? "unusable"
        : assessments.needsAdjustment > 0
          ? "needs_adjustment"
          : "correct",
      issueCodes,
      assessmentIds: assessmentIds.sort(),
    },
  };
}
