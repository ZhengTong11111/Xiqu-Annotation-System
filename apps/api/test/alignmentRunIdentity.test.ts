import assert from "node:assert/strict";
import test from "node:test";
import { createAlignmentRunIdentity } from "../src/alignmentRunIdentity.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

test("对齐身份对配置键顺序稳定且任一语义输入变化都会改变执行身份", () => {
  const base = createInput();
  const expected = createAlignmentRunIdentity(base);
  const reordered = createAlignmentRunIdentity({
    ...base,
    config: { decoder: { beamSize: 8, language: "zh" }, sampleRate: 16_000 },
  });
  assert.deepEqual(reordered, expected);
  assert.match(expected.configHash, /^[0-9a-f]{64}$/u);
  assert.match(expected.identityHash, /^[0-9a-f]{64}$/u);
  assert.equal(expected.deduplicationKey, `force-alignment:v1:${expected.identityHash}`);

  const variations = [
    { inputRevision: 13 },
    { inputTextFingerprint: HASH_C },
    { inputSentenceCount: 5 },
    { inputCharacterCount: 43 },
    { sourceMediaResourceId: "media-2" },
    { sourceFingerprint: HASH_C },
    { mediaAudioTrackId: "track-2" },
    { audioOffsetMicros: 10_001n },
    { mediaAnalysisFingerprint: null },
    { modelName: "mfa" },
    { modelVersion: "model-v2" },
    { dictionaryVersion: "dict-v2" },
    { codeVersion: "code-v2" },
    { config: { sampleRate: 22_050, decoder: { language: "zh", beamSize: 8 } } },
  ];
  for (const variation of variations) {
    const actual = createAlignmentRunIdentity({ ...base, ...variation });
    assert.notEqual(actual.identityHash, expected.identityHash, JSON.stringify(variation, bigintReplacer));
  }
});

test("对齐身份严格拒绝额外字段、越界值、非 JSON 配置和受保护配置", () => {
  const base = createInput();
  assert.throws(() => createAlignmentRunIdentity({ ...base, actorUserId: "user-1" }), /未支持的字段/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, inputRevision: 0 }), /inputRevision/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, sourceFingerprint: HASH_A.toUpperCase() }), /SHA-256/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, audioOffsetMicros: 1.25 }), /整数微秒/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, audioOffsetMicros: 86_400_000_001n }), /整数微秒/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, config: new Date() }), /普通 JSON 对象/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, config: { threshold: Number.NaN } }), /普通 JSON 值/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, config: { accessToken: "secret" } }), /凭据/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, config: { endpoint: "https://example.test/model" } }), /不能保存 URL/u);
  assert.throws(() => createAlignmentRunIdentity({ ...base, config: { text: "字".repeat(13_000) } }), /容量上限/u);
});

test("返回配置与调用方引用隔离且身份产物不包含正文或 URL", () => {
  const config = { sampleRate: 16_000, decoder: { language: "zh", beamSize: 8 } };
  const prepared = createAlignmentRunIdentity({ ...createInput(), config });
  config.decoder.beamSize = 99;
  assert.deepEqual(prepared.config, {
    decoder: { beamSize: 8, language: "zh" },
    sampleRate: 16_000,
  });
  assert.doesNotMatch(JSON.stringify(prepared), /https?:|PlayAuth|AccessKey|sentence text/iu);
});

function createInput() {
  return {
    annotationFileId: "annotation-1",
    inputRevision: 12,
    inputTextFingerprint: HASH_A,
    inputSentenceCount: 4,
    inputCharacterCount: 42,
    sourceMediaResourceId: "media-1",
    sourceFingerprint: HASH_B,
    mediaAudioTrackId: "track-1",
    audioOffsetMicros: 10_000n,
    mediaAnalysisFingerprint: HASH_C,
    modelName: "kunqu-aligner",
    modelVersion: "model-v1",
    dictionaryVersion: "dict-v1",
    codeVersion: "code-v1",
    config: { sampleRate: 16_000, decoder: { language: "zh", beamSize: 8 } },
  };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
