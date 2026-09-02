import type { AlignmentPredictionArtifact } from "./alignmentPrediction.js";

export const ALIGNMENT_QUALITY_CONFIDENCE_SCALE = 1_000_000;
export const ALIGNMENT_LOW_CONFIDENCE_PPM = 600_000;
export const ALIGNMENT_CLOSE_ALTERNATIVE_GAP_PPM = 100_000;

export type AlignmentPredictionQualitySummary = {
  version: 1;
  sentenceCount: number;
  characterCount: number;
  sentenceConfidenceMeanPpm: number | null;
  sentenceConfidenceMinPpm: number | null;
  characterConfidenceMeanPpm: number | null;
  characterConfidenceMinPpm: number | null;
  lowConfidenceCharacterCount: number;
  alternativeCandidateCharacterCount: number;
  closeAlternativeCharacterCount: number;
  maxAlternativeBoundaryDeltaMicros: number;
};

/**
 * 发布期只保留固定整数统计，避免候选查询反复下载预测对象，也不把实体身份或候选数组复制进数据库。
 */
export function buildAlignmentPredictionQualitySummary(
  prediction: AlignmentPredictionArtifact,
): AlignmentPredictionQualitySummary {
  let sentenceConfidenceTotal = 0;
  let sentenceConfidenceMinimum = ALIGNMENT_QUALITY_CONFIDENCE_SCALE;
  let characterCount = 0;
  let characterConfidenceTotal = 0;
  let characterConfidenceMinimum = ALIGNMENT_QUALITY_CONFIDENCE_SCALE;
  let lowConfidenceCharacterCount = 0;
  let alternativeCandidateCharacterCount = 0;
  let closeAlternativeCharacterCount = 0;
  let maxAlternativeBoundaryDeltaMicros = 0;

  for (const sentence of prediction.sentences) {
    const sentenceConfidence = toConfidencePpm(sentence.confidence);
    sentenceConfidenceTotal += sentenceConfidence;
    sentenceConfidenceMinimum = Math.min(sentenceConfidenceMinimum, sentenceConfidence);

    for (const character of sentence.characters) {
      const characterConfidence = toConfidencePpm(character.confidence);
      characterCount += 1;
      characterConfidenceTotal += characterConfidence;
      characterConfidenceMinimum = Math.min(characterConfidenceMinimum, characterConfidence);
      if (characterConfidence < ALIGNMENT_LOW_CONFIDENCE_PPM) {
        lowConfidenceCharacterCount += 1;
      }
      if (character.candidates.length === 0) continue;
      alternativeCandidateCharacterCount += 1;
      let hasCloseAlternative = false;
      for (const candidate of character.candidates) {
        const candidateConfidence = toConfidencePpm(candidate.confidence);
        if (Math.abs(candidateConfidence - characterConfidence) <= ALIGNMENT_CLOSE_ALTERNATIVE_GAP_PPM) {
          hasCloseAlternative = true;
        }
        maxAlternativeBoundaryDeltaMicros = Math.max(
          maxAlternativeBoundaryDeltaMicros,
          Math.abs(candidate.startMicros - character.startMicros),
          Math.abs(candidate.endMicros - character.endMicros),
        );
      }
      if (hasCloseAlternative) closeAlternativeCharacterCount += 1;
    }
  }

  const sentenceCount = prediction.sentences.length;
  return {
    version: 1,
    sentenceCount,
    characterCount,
    sentenceConfidenceMeanPpm: meanOrNull(sentenceConfidenceTotal, sentenceCount),
    sentenceConfidenceMinPpm: sentenceCount === 0 ? null : sentenceConfidenceMinimum,
    characterConfidenceMeanPpm: meanOrNull(characterConfidenceTotal, characterCount),
    characterConfidenceMinPpm: characterCount === 0 ? null : characterConfidenceMinimum,
    lowConfidenceCharacterCount,
    alternativeCandidateCharacterCount,
    closeAlternativeCharacterCount,
    maxAlternativeBoundaryDeltaMicros,
  };
}

/** 后续查询只能读取严格摘要；额外字段和不可能的计数组合均视为不可用。 */
export function parseAlignmentPredictionQualitySummary(
  value: unknown,
): AlignmentPredictionQualitySummary | null {
  if (!isExactObject(value, [
    "version",
    "sentenceCount",
    "characterCount",
    "sentenceConfidenceMeanPpm",
    "sentenceConfidenceMinPpm",
    "characterConfidenceMeanPpm",
    "characterConfidenceMinPpm",
    "lowConfidenceCharacterCount",
    "alternativeCandidateCharacterCount",
    "closeAlternativeCharacterCount",
    "maxAlternativeBoundaryDeltaMicros",
  ]) || value.version !== 1) return null;

  const sentenceCount = parseCount(value.sentenceCount);
  const characterCount = parseCount(value.characterCount);
  const sentenceMean = parseNullableConfidence(value.sentenceConfidenceMeanPpm);
  const sentenceMin = parseNullableConfidence(value.sentenceConfidenceMinPpm);
  const characterMean = parseNullableConfidence(value.characterConfidenceMeanPpm);
  const characterMin = parseNullableConfidence(value.characterConfidenceMinPpm);
  const lowCount = parseCount(value.lowConfidenceCharacterCount);
  const alternativeCount = parseCount(value.alternativeCandidateCharacterCount);
  const closeCount = parseCount(value.closeAlternativeCharacterCount);
  const maximumDelta = parseCount(value.maxAlternativeBoundaryDeltaMicros);
  if (
    sentenceCount === null || characterCount === null ||
    sentenceMean === undefined || sentenceMin === undefined ||
    characterMean === undefined || characterMin === undefined ||
    lowCount === null || alternativeCount === null || closeCount === null || maximumDelta === null ||
    !isConfidencePairValid(sentenceCount, sentenceMean, sentenceMin) ||
    !isConfidencePairValid(characterCount, characterMean, characterMin) ||
    lowCount > characterCount || alternativeCount > characterCount || closeCount > alternativeCount ||
    (alternativeCount === 0 && maximumDelta !== 0)
  ) return null;

  return {
    version: 1,
    sentenceCount,
    characterCount,
    sentenceConfidenceMeanPpm: sentenceMean,
    sentenceConfidenceMinPpm: sentenceMin,
    characterConfidenceMeanPpm: characterMean,
    characterConfidenceMinPpm: characterMin,
    lowConfidenceCharacterCount: lowCount,
    alternativeCandidateCharacterCount: alternativeCount,
    closeAlternativeCharacterCount: closeCount,
    maxAlternativeBoundaryDeltaMicros: maximumDelta,
  };
}

function toConfidencePpm(value: number) {
  return Math.round(value * ALIGNMENT_QUALITY_CONFIDENCE_SCALE);
}

function meanOrNull(total: number, count: number) {
  return count === 0 ? null : Math.round(total / count);
}

function parseCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function parseNullableConfidence(value: unknown) {
  if (value === null) return null;
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= ALIGNMENT_QUALITY_CONFIDENCE_SCALE
    ? value as number
    : undefined;
}

function isConfidencePairValid(
  count: number,
  mean: number | null,
  minimum: number | null,
) {
  if (count === 0) return mean === null && minimum === null;
  return mean !== null && minimum !== null && minimum <= mean;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
