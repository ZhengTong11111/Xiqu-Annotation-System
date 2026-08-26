import { createHash } from "node:crypto";
import {
  MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS,
  MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA,
} from "@xiqu/shared";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";

export type AnalysisAudioSettingMigrationBlockCode =
  | "annotation_inactive_or_missing"
  | "primary_media_missing_or_inactive"
  | "override_media_missing_or_inactive"
  | "override_source_not_audio"
  | "primary_source_offset_conflict"
  | "existing_track_offset_conflict"
  | "existing_track_disabled"
  | "settings_offset_conflict"
  | "track_limit_exceeded"
  | "invalid_setting_shape"
  | "audio_track_structure_invalid";

export type AnalysisAudioSettingMigrationTrackFact = {
  id: string;
  kind: "original" | "vocal" | "accompaniment" | "denoised" | "reference" | "custom";
  audioMediaResourceId: string | null;
  offsetSeconds: number;
  sortOrder: number;
  enabled: boolean;
};

export type AnalysisAudioSettingMigrationFact = {
  annotationFileId: string;
  mode: "auto" | "media_override";
  overrideMediaResourceId: string | null;
  offsetSeconds: number;
  updatedBy: string;
  updatedAt: string;
  annotationActive: boolean;
  primaryMediaResourceId: string | null;
  primaryMediaActive: boolean;
  overrideMediaActive: boolean;
  overrideMediaKind: "video" | "audio" | null;
  /** 只参与计划 fingerprint 和执行时名称生成，不进入公开 plan item。 */
  overrideMediaName: string | null;
  existingTracks: AnalysisAudioSettingMigrationTrackFact[];
};

export type AnalysisAudioSettingMigrationAction =
  | "no_action"
  | "reuse_track"
  | "create_track"
  | "blocked";

export type AnalysisAudioSettingMigrationItemPlan = {
  annotationFileId: string;
  primaryMediaResourceId: string | null;
  overrideMediaResourceId: string | null;
  action: AnalysisAudioSettingMigrationAction;
  existingTrackId: string | null;
  blockCodes: AnalysisAudioSettingMigrationBlockCode[];
};

export type AnalysisAudioSettingMigrationPlan = {
  version: 1;
  fingerprint: string;
  settingCount: number;
  createTrackCount: number;
  reuseCount: number;
  noActionCount: number;
  blockedCount: number;
  items: AnalysisAudioSettingMigrationItemPlan[];
};

type MutableItem = AnalysisAudioSettingMigrationItemPlan & {
  sourceGroupKey: string | null;
};

/**
 * 纯计划器只消费有限数据库事实。任何无法无损映射的设置都形成稳定阻断码，
 * execute 必须拒绝整个计划，不能在同一批旧设置中只迁移“看起来容易”的部分。
 */
export function buildAnalysisAudioSettingMigrationPlan(
  inputFacts: readonly AnalysisAudioSettingMigrationFact[],
): AnalysisAudioSettingMigrationPlan {
  const facts = [...inputFacts]
    .map(normalizeFact)
    .sort((left, right) => left.annotationFileId.localeCompare(right.annotationFileId));
  const items = facts.map(buildInitialItem);
  applyCrossSettingOffsetConflicts(facts, items);
  applyTrackLimitBlocks(facts, items);

  const publicItems = items.map(({ sourceGroupKey: _sourceGroupKey, ...item }) => ({
    ...item,
    blockCodes: [...item.blockCodes].sort(),
  }));
  const createGroups = new Set(
    items
      .filter((item) => item.action === "create_track" && item.blockCodes.length === 0)
      .map((item) => item.sourceGroupKey)
      .filter((key): key is string => key !== null),
  );
  const normalizedFacts = facts.map((fact) => ({
    ...fact,
    existingTracks: [...fact.existingTracks].sort(compareTrackFacts),
  }));
  const fingerprint = createHash("sha256")
    .update(stableJsonStringify({
      version: 1,
      facts: normalizedFacts,
      items: publicItems,
    }))
    .digest("hex");
  return {
    version: 1,
    fingerprint,
    settingCount: facts.length,
    createTrackCount: createGroups.size,
    reuseCount: publicItems.filter(({ action }) => action === "reuse_track").length,
    noActionCount: publicItems.filter(({ action }) => action === "no_action").length,
    blockedCount: publicItems.filter(({ action }) => action === "blocked").length,
    items: publicItems,
  };
}

function buildInitialItem(fact: AnalysisAudioSettingMigrationFact): MutableItem {
  const item: MutableItem = {
    annotationFileId: fact.annotationFileId,
    primaryMediaResourceId: fact.primaryMediaResourceId,
    overrideMediaResourceId: fact.overrideMediaResourceId,
    action: "blocked",
    existingTrackId: null,
    blockCodes: [],
    sourceGroupKey: createSourceGroupKey(fact),
  };
  if (!fact.annotationActive) item.blockCodes.push("annotation_inactive_or_missing");
  if (!fact.primaryMediaResourceId || !fact.primaryMediaActive) {
    item.blockCodes.push("primary_media_missing_or_inactive");
  }
  if (!hasValidSettingShape(fact)) item.blockCodes.push("invalid_setting_shape");
  if (
    fact.primaryMediaResourceId &&
    fact.primaryMediaActive &&
    !hasValidTrackStructure(fact.existingTracks)
  ) {
    item.blockCodes.push("audio_track_structure_invalid");
  }
  if (fact.mode === "auto") {
    if (!sameOffset(fact.offsetSeconds, 0)) {
      item.blockCodes.push("primary_source_offset_conflict");
    }
    item.action = item.blockCodes.length === 0 ? "no_action" : "blocked";
    return item;
  }
  if (!fact.overrideMediaResourceId || !fact.overrideMediaActive) {
    item.blockCodes.push("override_media_missing_or_inactive");
  } else if (
    fact.overrideMediaResourceId !== fact.primaryMediaResourceId &&
    fact.overrideMediaKind !== "audio"
  ) {
    // 旧 VOD 视频可供 worker 临时提取声音，但没有稳定 JobId，不能变成可试听音轨。
    item.blockCodes.push("override_source_not_audio");
  }
  if (
    fact.primaryMediaResourceId &&
    fact.overrideMediaResourceId === fact.primaryMediaResourceId
  ) {
    if (!sameOffset(fact.offsetSeconds, 0)) {
      item.blockCodes.push("primary_source_offset_conflict");
    } else {
      item.existingTrackId = fact.existingTracks.find(({ kind }) => kind === "original")?.id ?? null;
    }
  } else if (fact.overrideMediaResourceId) {
    const existing = fact.existingTracks.find(
      ({ audioMediaResourceId }) => audioMediaResourceId === fact.overrideMediaResourceId,
    );
    if (existing) {
      item.existingTrackId = existing.id;
      if (!sameOffset(existing.offsetSeconds, fact.offsetSeconds)) {
        item.blockCodes.push("existing_track_offset_conflict");
      }
      if (!existing.enabled) item.blockCodes.push("existing_track_disabled");
    }
  }
  if (item.blockCodes.length > 0) {
    item.action = "blocked";
  } else if (item.existingTrackId) {
    item.action = "reuse_track";
  } else {
    item.action = "create_track";
  }
  return item;
}

function applyCrossSettingOffsetConflicts(
  facts: readonly AnalysisAudioSettingMigrationFact[],
  items: MutableItem[],
) {
  const offsetsBySource = new Map<string, Set<number>>();
  for (const fact of facts) {
    const key = createSourceGroupKey(fact);
    if (!key || fact.mode !== "media_override") continue;
    const offsets = offsetsBySource.get(key) ?? new Set<number>();
    offsets.add(normalizeSignedZero(fact.offsetSeconds));
    offsetsBySource.set(key, offsets);
  }
  for (const item of items) {
    if (!item.sourceGroupKey || (offsetsBySource.get(item.sourceGroupKey)?.size ?? 0) <= 1) continue;
    addBlock(item, "settings_offset_conflict");
  }
}

function applyTrackLimitBlocks(
  facts: readonly AnalysisAudioSettingMigrationFact[],
  items: MutableItem[],
) {
  const factsByAnnotation = new Map(facts.map((fact) => [fact.annotationFileId, fact]));
  const createGroupsByPrimary = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.action !== "create_track" || !item.primaryMediaResourceId || !item.sourceGroupKey) continue;
    const groups = createGroupsByPrimary.get(item.primaryMediaResourceId) ?? new Set<string>();
    groups.add(item.sourceGroupKey);
    createGroupsByPrimary.set(item.primaryMediaResourceId, groups);
  }
  for (const [primaryMediaResourceId, groups] of createGroupsByPrimary) {
    const representative = items
      .filter((item) => item.primaryMediaResourceId === primaryMediaResourceId)
      .map((item) => factsByAnnotation.get(item.annotationFileId))
      .find((fact): fact is AnalysisAudioSettingMigrationFact => Boolean(fact));
    if (
      representative &&
      representative.existingTracks.length + groups.size <= MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA
    ) continue;
    for (const item of items) {
      if (
        item.primaryMediaResourceId === primaryMediaResourceId &&
        item.action === "create_track"
      ) addBlock(item, "track_limit_exceeded");
    }
  }
}

function addBlock(item: MutableItem, code: AnalysisAudioSettingMigrationBlockCode) {
  if (!item.blockCodes.includes(code)) item.blockCodes.push(code);
  item.action = "blocked";
}

function hasValidSettingShape(fact: AnalysisAudioSettingMigrationFact) {
  if (
    !Number.isFinite(fact.offsetSeconds) ||
    Math.abs(fact.offsetSeconds) > MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS
  ) return false;
  if (fact.mode === "auto") {
    return fact.overrideMediaResourceId === null;
  }
  return fact.overrideMediaResourceId !== null;
}

function hasValidTrackStructure(tracks: readonly AnalysisAudioSettingMigrationTrackFact[]) {
  const sorted = [...tracks].sort(compareTrackFacts);
  return sorted.filter(({ kind }) => kind === "original").length === 1 &&
    sorted.every((track, index) =>
      track.sortOrder === index &&
      Number.isFinite(track.offsetSeconds) &&
      (track.kind !== "original" ||
        (track.audioMediaResourceId === null && sameOffset(track.offsetSeconds, 0))));
}

function createSourceGroupKey(fact: AnalysisAudioSettingMigrationFact) {
  if (!fact.primaryMediaResourceId || !fact.overrideMediaResourceId) return null;
  return JSON.stringify([fact.primaryMediaResourceId, fact.overrideMediaResourceId]);
}

function normalizeFact(fact: AnalysisAudioSettingMigrationFact) {
  return {
    ...fact,
    offsetSeconds: normalizeSignedZero(fact.offsetSeconds),
    existingTracks: fact.existingTracks.map((track) => ({
      ...track,
      offsetSeconds: normalizeSignedZero(track.offsetSeconds),
    })),
  };
}

function compareTrackFacts(
  left: AnalysisAudioSettingMigrationTrackFact,
  right: AnalysisAudioSettingMigrationTrackFact,
) {
  return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
}

function normalizeSignedZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function sameOffset(left: number, right: number) {
  return Object.is(normalizeSignedZero(left), normalizeSignedZero(right));
}
