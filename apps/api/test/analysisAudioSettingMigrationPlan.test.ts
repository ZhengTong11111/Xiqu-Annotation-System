import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA } from "@xiqu/shared";
import {
  buildAnalysisAudioSettingMigrationPlan,
  type AnalysisAudioSettingMigrationFact,
} from "../src/analysisAudioSettingMigrationPlan.js";

function createFact(
  overrides: Partial<AnalysisAudioSettingMigrationFact> = {},
): AnalysisAudioSettingMigrationFact {
  return {
    annotationFileId: "annotation-1",
    mode: "media_override",
    overrideMediaResourceId: "audio-1",
    offsetSeconds: 0.25,
    updatedBy: "user-1",
    updatedAt: "2026-08-26T00:00:00.000Z",
    annotationActive: true,
    primaryMediaResourceId: "video-1",
    primaryMediaActive: true,
    overrideMediaActive: true,
    overrideMediaKind: "audio",
    overrideMediaName: "分离人声.mp3",
    existingTracks: [{
      id: "track-original",
      kind: "original",
      audioMediaResourceId: null,
      offsetSeconds: 0,
      sortOrder: 0,
      enabled: true,
    }],
    ...overrides,
  };
}

test("auto 与主媒体零偏移分别不创建和复用原声音轨", () => {
  const autoPlan = buildAnalysisAudioSettingMigrationPlan([
    createFact({
      mode: "auto",
      overrideMediaResourceId: null,
      offsetSeconds: 0,
      overrideMediaActive: false,
      overrideMediaKind: null,
      overrideMediaName: null,
    }),
  ]);
  assert.equal(autoPlan.items[0]?.action, "no_action");
  assert.equal(autoPlan.createTrackCount, 0);

  const originalPlan = buildAnalysisAudioSettingMigrationPlan([
    createFact({
      overrideMediaResourceId: "video-1",
      overrideMediaKind: "video",
      offsetSeconds: 0,
    }),
  ]);
  assert.equal(originalPlan.items[0]?.action, "reuse_track");
  assert.equal(originalPlan.items[0]?.existingTrackId, "track-original");
});

test("纯音频覆盖可创建新关系，已有同偏移关系则幂等复用", () => {
  const createPlan = buildAnalysisAudioSettingMigrationPlan([createFact()]);
  assert.equal(createPlan.items[0]?.action, "create_track");
  assert.equal(createPlan.createTrackCount, 1);

  const reusePlan = buildAnalysisAudioSettingMigrationPlan([
    createFact({
      existingTracks: [
        ...createFact().existingTracks,
        {
          id: "track-vocal",
          kind: "reference",
          audioMediaResourceId: "audio-1",
          offsetSeconds: 0.25,
          sortOrder: 1,
          enabled: true,
        },
      ],
    }),
  ]);
  assert.equal(reusePlan.items[0]?.action, "reuse_track");
  assert.equal(reusePlan.items[0]?.existingTrackId, "track-vocal");
  assert.equal(reusePlan.createTrackCount, 0);
});

test("同源已有不同偏移和多份设置不同偏移都阻断", () => {
  const existingConflict = buildAnalysisAudioSettingMigrationPlan([
    createFact({
      existingTracks: [
        ...createFact().existingTracks,
        {
          id: "track-vocal",
          kind: "reference",
          audioMediaResourceId: "audio-1",
          offsetSeconds: 0,
          sortOrder: 1,
          enabled: true,
        },
      ],
    }),
  ]);
  assert.deepEqual(existingConflict.items[0]?.blockCodes, ["existing_track_offset_conflict"]);

  const settingsConflict = buildAnalysisAudioSettingMigrationPlan([
    createFact(),
    createFact({ annotationFileId: "annotation-2", offsetSeconds: 0.5 }),
  ]);
  assert.equal(settingsConflict.blockedCount, 2);
  assert.ok(settingsConflict.items.every(({ blockCodes }) =>
    blockCodes.includes("settings_offset_conflict")));
});

test("已有同源音轨被禁用时保留管理员意图并阻断迁移", () => {
  const plan = buildAnalysisAudioSettingMigrationPlan([
    createFact({
      existingTracks: [
        ...createFact().existingTracks,
        {
          id: "track-disabled",
          kind: "reference",
          audioMediaResourceId: "audio-1",
          offsetSeconds: 0.25,
          sortOrder: 1,
          enabled: false,
        },
      ],
    }),
  ]);
  assert.deepEqual(plan.items[0]?.blockCodes, ["existing_track_disabled"]);
});

test("VOD 视频覆盖、非零主来源、无效活动状态和坏结构均 fail closed", () => {
  const plan = buildAnalysisAudioSettingMigrationPlan([
    createFact({ overrideMediaKind: "video" }),
    createFact({
      annotationFileId: "annotation-2",
      overrideMediaResourceId: "video-1",
      overrideMediaKind: "audio",
      offsetSeconds: 1,
    }),
    createFact({ annotationFileId: "annotation-3", annotationActive: false }),
    createFact({
      annotationFileId: "annotation-4",
      existingTracks: [],
    }),
  ]);
  assert.ok(plan.items[0]?.blockCodes.includes("override_source_not_audio"));
  assert.ok(plan.items[1]?.blockCodes.includes("primary_source_offset_conflict"));
  assert.ok(plan.items[2]?.blockCodes.includes("annotation_inactive_or_missing"));
  assert.ok(plan.items[3]?.blockCodes.includes("audio_track_structure_invalid"));
});

test("超过共享音轨上限时所有待创建来源均阻断", () => {
  const existingTracks = Array.from({ length: MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA }, (_, index) => ({
    id: index === 0 ? "track-original" : `track-${index}`,
    kind: index === 0 ? "original" as const : "reference" as const,
    audioMediaResourceId: index === 0 ? null : `existing-audio-${index}`,
    offsetSeconds: 0,
    sortOrder: index,
    enabled: true,
  }));
  const plan = buildAnalysisAudioSettingMigrationPlan([
    createFact({ existingTracks }),
  ]);
  assert.deepEqual(plan.items[0]?.blockCodes, ["track_limit_exceeded"]);
});

test("计划与输入顺序无关，任何参与迁移的事实变化都会改变 fingerprint", () => {
  const first = createFact();
  const second = createFact({
    annotationFileId: "annotation-2",
    overrideMediaResourceId: "audio-2",
    overrideMediaName: "伴奏.mp3",
  });
  const forward = buildAnalysisAudioSettingMigrationPlan([first, second]);
  const reverse = buildAnalysisAudioSettingMigrationPlan([second, first]);
  assert.equal(forward.fingerprint, reverse.fingerprint);
  assert.notEqual(
    forward.fingerprint,
    buildAnalysisAudioSettingMigrationPlan([
      first,
      { ...second, overrideMediaName: "更新后的伴奏.mp3" },
    ]).fingerprint,
  );
});
