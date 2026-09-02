import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  buildAlignmentTextProjection,
  canonicalAlignmentTrainingJson,
  type ProjectData,
} from "@xiqu/document-model";
import type { ReadyAnalysisAudioSource } from "../src/analysisAudioSourceResolver.js";
import {
  prepareAlignmentTrainingSource,
  prepareAlignmentTrainingTarget,
} from "../src/alignmentTrainingExportInput.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("训练目标只接受与原 run 完全一致的文本投影", () => {
  const project = createProject();
  const projection = buildAlignmentTextProjection(project);
  assert.equal(projection.ok, true);
  if (!projection.ok) return;

  const prepared = prepareAlignmentTrainingTarget(project, {
    inputTextFingerprint: sha256(canonicalAlignmentTrainingJson(projection.projection)),
    inputSentenceCount: projection.sentenceCount,
    inputCharacterCount: projection.characterCount,
  }, sha256);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.value.snapshot.sentences[0]?.characters[0]?.characterId, "legacy-character-1");

  const changedText = structuredClone(project);
  changedText.characterAnnotations[0]!.char = "改";
  assert.deepEqual(prepareAlignmentTrainingTarget(changedText, {
    inputTextFingerprint: sha256(canonicalAlignmentTrainingJson(projection.projection)),
    inputSentenceCount: projection.sentenceCount,
    inputCharacterCount: projection.characterCount,
  }, sha256), { ok: false, code: "target_projection_mismatch" });
});

test("上传音频来源只冻结对象身份且严格复核微秒偏移", () => {
  const source = createReadySource("uploaded");
  const prepared = prepareAlignmentTrainingSource(source, 12_500n, sha256);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.value.snapshot.kind, "uploaded");
  assert.equal(prepared.value.sourceFileId, source.media.file?.id);
  assert.equal(JSON.stringify(prepared.value).includes("storage/private"), false);

  assert.deepEqual(
    prepareAlignmentTrainingSource(source, 12_499n, sha256),
    { ok: false, code: "source_snapshot_invalid" },
  );
});

test("VOD 来源快照不包含临时播放地址、凭据或浏览器会话", () => {
  const source = createReadySource("aliyun_vod");
  const prepared = prepareAlignmentTrainingSource(source, 12_500n, sha256);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.value.snapshot.kind, "aliyun_vod");
  assert.equal(prepared.value.sourceFileId, null);
  const serialized = JSON.stringify(prepared.value);
  for (const forbidden of ["https://", "playAuth", "AccessKey", "storageKey"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

function createProject(): ProjectData {
  return {
    video: { url: "", name: "训练样本", source: "url", filePath: "" },
    sentenceAnnotationConfig: { roleOptions: ["生"] },
    subtitleLines: [{
      id: "legacy-sentence-1",
      text: "唱",
      startTime: 0,
      endTime: 2,
      deliveryMode: "sung",
      roleTypes: ["生"],
    }],
    characterAnnotations: [{
      id: "legacy-character-1",
      lineId: "legacy-sentence-1",
      char: "唱",
      startTime: 0.5,
      endTime: 1.5,
      tone: null,
    }],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [],
    customTracks: [],
    activeTrackOrder: [],
  };
}

function createReadySource(kind: "uploaded" | "aliyun_vod"): ReadyAnalysisAudioSource {
  const resourceId = randomUUID();
  return {
    offsetSeconds: 0.0125,
    mediaFingerprint: "a".repeat(64),
    sourceVodRenditionJobId: kind === "aliyun_vod" ? "job-stable-1" : null,
    media: {
      resourceId,
      sourceType: kind,
      mediaKind: "audio",
      mimeType: kind === "uploaded" ? "audio/mpeg" : null,
      size: kind === "uploaded" ? 1_024n : null,
      duration: 12.5,
      aliyunVodVideoId: kind === "aliyun_vod" ? "vod-stable-1" : null,
      aliyunVodRegion: kind === "aliyun_vod" ? "cn-shanghai" : null,
      resource: {
        name: "训练来源",
        type: "media_file",
        archivedAt: null,
        trashedAt: null,
      },
      file: kind === "uploaded" ? {
        id: randomUUID(),
        storageKey: "storage/private/source.mp3",
        checksum: "b".repeat(64),
        size: 1_024n,
      } : null,
    },
  };
}
