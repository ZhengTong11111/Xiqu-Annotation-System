import type { AlignmentTextProjection } from "./alignmentTextProjection.js";

export const ALIGNMENT_PREDICTION_FORMAT_VERSION = 1 as const;
export const ALIGNMENT_PREDICTION_MIME_TYPE = "application/vnd.xiqu.alignment-prediction+json";
export const MAX_ALIGNMENT_CANDIDATES_PER_CHARACTER = 3;

export type AlignmentBoundaryCandidate = {
  startMicros: number;
  endMicros: number;
  confidence: number;
};

export type AlignmentCharacterPrediction = AlignmentBoundaryCandidate & {
  characterId: string;
  candidates: AlignmentBoundaryCandidate[];
};

export type AlignmentSentencePrediction = AlignmentBoundaryCandidate & {
  sentenceId: string;
  characters: AlignmentCharacterPrediction[];
};

/** 模型执行器只返回边界结果；run 身份由 worker 从数据库权威事实补入。 */
export type AlignmentExecutorOutput = {
  version: 1;
  sentences: AlignmentSentencePrediction[];
};

/** 对象存储中的版本化预测文件不复制正文，只保留稳定实体 ID 与项目时间轴边界。 */
export type AlignmentPredictionArtifact = AlignmentExecutorOutput & {
  runId: string;
  inputRevision: number;
  inputTextFingerprint: string;
  audioOffsetMicros: number;
};

export type AlignmentPredictionValidationResult =
  | { ok: true; prediction: AlignmentPredictionArtifact }
  | {
      ok: false;
      code:
        | "alignment_prediction_invalid"
        | "alignment_prediction_identity_mismatch"
        | "alignment_prediction_timing_invalid";
      entityId?: string;
    };

/**
 * 在发布前把不受信任的模型输出收敛为唯一格式。
 * 校验同时绑定当前 projection，确保模型不能漏字、换序、伪造实体或把边界写到句子范围之外。
 */
export function buildAlignmentPredictionArtifact(input: {
  runId: string;
  inputRevision: number;
  inputTextFingerprint: string;
  audioOffsetMicros: number;
  projection: AlignmentTextProjection;
  executorOutput: unknown;
}): AlignmentPredictionValidationResult {
  if (
    !isBoundedId(input.runId) ||
    !Number.isSafeInteger(input.inputRevision) ||
    input.inputRevision < 1 ||
    !/^[0-9a-f]{64}$/u.test(input.inputTextFingerprint) ||
    !Number.isSafeInteger(input.audioOffsetMicros)
  ) return { ok: false, code: "alignment_prediction_invalid" };

  const parsed = parseExecutorOutput(input.executorOutput);
  if (!parsed) return { ok: false, code: "alignment_prediction_invalid" };
  if (parsed.sentences.length !== input.projection.sentences.length) {
    return { ok: false, code: "alignment_prediction_identity_mismatch" };
  }

  const normalizedSentences: AlignmentSentencePrediction[] = [];
  for (let sentenceIndex = 0; sentenceIndex < input.projection.sentences.length; sentenceIndex += 1) {
    const expectedSentence = input.projection.sentences[sentenceIndex]!;
    const predictedSentence = parsed.sentences[sentenceIndex]!;
    if (
      predictedSentence.sentenceId !== expectedSentence.sentenceId ||
      predictedSentence.characters.length !== expectedSentence.characters.length
    ) {
      return {
        ok: false,
        code: "alignment_prediction_identity_mismatch",
        entityId: expectedSentence.sentenceId,
      };
    }
    if (!isBoundaryWithin(
      predictedSentence,
      expectedSentence.startMicros,
      expectedSentence.endMicros,
    )) {
      return {
        ok: false,
        code: "alignment_prediction_timing_invalid",
        entityId: expectedSentence.sentenceId,
      };
    }

    let previousCharacterEnd = predictedSentence.startMicros;
    const normalizedCharacters: AlignmentCharacterPrediction[] = [];
    for (let characterIndex = 0; characterIndex < expectedSentence.characters.length; characterIndex += 1) {
      const expectedCharacter = expectedSentence.characters[characterIndex]!;
      const predictedCharacter = predictedSentence.characters[characterIndex]!;
      if (predictedCharacter.characterId !== expectedCharacter.characterId) {
        return {
          ok: false,
          code: "alignment_prediction_identity_mismatch",
          entityId: expectedCharacter.characterId,
        };
      }
      if (
        !isBoundaryWithin(
          predictedCharacter,
          predictedSentence.startMicros,
          predictedSentence.endMicros,
        ) ||
        predictedCharacter.startMicros < previousCharacterEnd
      ) {
        return {
          ok: false,
          code: "alignment_prediction_timing_invalid",
          entityId: expectedCharacter.characterId,
        };
      }
      if (predictedCharacter.candidates.some((candidate) => !isBoundaryWithin(
        candidate,
        predictedSentence.startMicros,
        predictedSentence.endMicros,
      ))) {
        return {
          ok: false,
          code: "alignment_prediction_timing_invalid",
          entityId: expectedCharacter.characterId,
        };
      }
      previousCharacterEnd = predictedCharacter.endMicros;
      normalizedCharacters.push({
        characterId: predictedCharacter.characterId,
        startMicros: predictedCharacter.startMicros,
        endMicros: predictedCharacter.endMicros,
        confidence: predictedCharacter.confidence,
        candidates: predictedCharacter.candidates.map((candidate) => ({ ...candidate })),
      });
    }
    normalizedSentences.push({
      sentenceId: predictedSentence.sentenceId,
      startMicros: predictedSentence.startMicros,
      endMicros: predictedSentence.endMicros,
      confidence: predictedSentence.confidence,
      characters: normalizedCharacters,
    });
  }

  return {
    ok: true,
    prediction: {
      version: ALIGNMENT_PREDICTION_FORMAT_VERSION,
      runId: input.runId,
      inputRevision: input.inputRevision,
      inputTextFingerprint: input.inputTextFingerprint,
      audioOffsetMicros: input.audioOffsetMicros,
      sentences: normalizedSentences,
    },
  };
}

/** D2d 和离线检查共用严格解析器；未知字段或非规范数字一律拒绝。 */
export function parseAlignmentPredictionArtifact(value: unknown): AlignmentPredictionArtifact | null {
  if (!isExactObject(value, [
    "version",
    "runId",
    "inputRevision",
    "inputTextFingerprint",
    "audioOffsetMicros",
    "sentences",
  ])) return null;
  if (
    value.version !== ALIGNMENT_PREDICTION_FORMAT_VERSION ||
    !isBoundedId(value.runId) ||
    !Number.isSafeInteger(value.inputRevision) ||
    (value.inputRevision as number) < 1 ||
    typeof value.inputTextFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.inputTextFingerprint) ||
    !Number.isSafeInteger(value.audioOffsetMicros) ||
    !Array.isArray(value.sentences)
  ) return null;
  const output = parseExecutorOutput({ version: 1, sentences: value.sentences });
  if (!output) return null;
  return {
    version: 1,
    runId: value.runId,
    inputRevision: value.inputRevision as number,
    inputTextFingerprint: value.inputTextFingerprint,
    audioOffsetMicros: value.audioOffsetMicros as number,
    sentences: output.sentences,
  };
}

function parseExecutorOutput(value: unknown): AlignmentExecutorOutput | null {
  if (!isExactObject(value, ["version", "sentences"]) ||
      value.version !== 1 || !Array.isArray(value.sentences)) return null;
  const sentences: AlignmentSentencePrediction[] = [];
  for (const sentence of value.sentences) {
    if (!isExactObject(sentence, [
      "sentenceId", "startMicros", "endMicros", "confidence", "characters",
    ]) || !isBoundedId(sentence.sentenceId) || !isBoundary(sentence) ||
        !Array.isArray(sentence.characters)) return null;
    const characters: AlignmentCharacterPrediction[] = [];
    for (const character of sentence.characters) {
      if (!isExactObject(character, [
        "characterId", "startMicros", "endMicros", "confidence", "candidates",
      ]) || !isBoundedId(character.characterId) || !isBoundary(character) ||
          !Array.isArray(character.candidates) ||
          character.candidates.length > MAX_ALIGNMENT_CANDIDATES_PER_CHARACTER) return null;
      const candidates: AlignmentBoundaryCandidate[] = [];
      for (const candidate of character.candidates) {
        if (!isExactObject(candidate, ["startMicros", "endMicros", "confidence"]) ||
            !isBoundary(candidate)) return null;
        candidates.push({
          startMicros: candidate.startMicros,
          endMicros: candidate.endMicros,
          confidence: candidate.confidence,
        });
      }
      characters.push({
        characterId: character.characterId,
        startMicros: character.startMicros,
        endMicros: character.endMicros,
        confidence: character.confidence,
        candidates,
      });
    }
    sentences.push({
      sentenceId: sentence.sentenceId,
      startMicros: sentence.startMicros,
      endMicros: sentence.endMicros,
      confidence: sentence.confidence,
      characters,
    });
  }
  return { version: 1, sentences };
}

function isBoundary(value: Record<string, unknown>): value is Record<string, unknown> & AlignmentBoundaryCandidate {
  return Number.isSafeInteger(value.startMicros) &&
    Number.isSafeInteger(value.endMicros) &&
    (value.startMicros as number) >= 0 &&
    (value.endMicros as number) >= (value.startMicros as number) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1;
}

function isBoundaryWithin(
  boundary: AlignmentBoundaryCandidate,
  minimumMicros: number,
  maximumMicros: number,
) {
  return boundary.startMicros >= minimumMicros && boundary.endMicros <= maximumMicros;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000]/u.test(value);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
