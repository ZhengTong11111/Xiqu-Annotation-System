import type {
  BanyanMarkStateSnapshot,
  BanyanSectionStateSnapshot,
  GongcheSymbolLifecycleSnapshot,
} from "@xiqu/shared";
import type { BanyanMark, BanyanSection, GongcheSymbol } from "../types";

// state 与 lifecycle 共用这些规范快照，避免同一复合实体在两种命令中出现字段漂移。
export function createGongcheSymbolSnapshot(symbol: GongcheSymbol): GongcheSymbolLifecycleSnapshot {
  return {
    id: symbol.id,
    label: symbol.label,
    notation: symbol.notation ?? null,
    rawText: symbol.rawText ?? null,
    parenthesized: symbol.parenthesized ?? false,
    startTime: symbol.startTime,
    endTime: symbol.endTime,
    assetUrl: symbol.assetUrl ?? null,
  };
}

export function restoreGongcheSymbolSnapshot(snapshot: GongcheSymbolLifecycleSnapshot): GongcheSymbol {
  return {
    id: snapshot.id,
    label: snapshot.label,
    notation: snapshot.notation ?? "",
    rawText: snapshot.rawText ?? snapshot.label,
    parenthesized: snapshot.parenthesized,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    assetUrl: snapshot.assetUrl,
  };
}

export function createBanyanSectionSnapshot(section: BanyanSection): BanyanSectionStateSnapshot {
  return {
    id: section.id,
    name: section.name,
    startTime: section.startTime,
    endTime: section.endTime,
    cycleType: section.cycleType,
    freeRhythm: section.freeRhythm,
    beatCount: section.beatCount ?? null,
    hasZengBan: section.hasZengBan ?? null,
    source: section.source ?? null,
    comment: section.comment ?? null,
  };
}

export function restoreBanyanSectionSnapshot(snapshot: BanyanSectionStateSnapshot): BanyanSection {
  return {
    id: snapshot.id,
    name: snapshot.name,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    cycleType: snapshot.cycleType,
    freeRhythm: snapshot.freeRhythm,
    ...(snapshot.beatCount === null ? {} : { beatCount: snapshot.beatCount }),
    ...(snapshot.hasZengBan === null ? {} : { hasZengBan: snapshot.hasZengBan }),
    ...(snapshot.source === null ? {} : { source: snapshot.source }),
    ...(snapshot.comment === null ? {} : { comment: snapshot.comment }),
  };
}

export function createBanyanMarkSnapshot(mark: BanyanMark): BanyanMarkStateSnapshot {
  return {
    id: mark.id,
    sectionId: mark.sectionId ?? null,
    time: mark.time,
    estimatedTime: mark.estimatedTime,
    sourceSymbol: mark.sourceSymbol,
    sourceTokenIndex: mark.sourceTokenIndex ?? null,
    sourceKey: mark.sourceKey ?? null,
    role: mark.role,
    subtype: mark.subtype,
    segment: mark.segment,
    beatIndex: mark.beatIndex ?? null,
    cycleIndex: mark.cycleIndex ?? null,
    strength: mark.strength ?? null,
    attachment: mark.attachment,
    linkedGongcheAnnotationId: mark.linkedGongcheAnnotationId ?? null,
    linkedGongcheSymbolId: mark.linkedGongcheSymbolId ?? null,
    linkedGongcheSymbolIds: mark.linkedGongcheSymbolIds ? [...mark.linkedGongcheSymbolIds] : null,
    confidence: mark.confidence,
    manualOffset: mark.manualOffset ?? null,
    durationHint: mark.durationHint ?? null,
    orphaned: mark.orphaned ?? false,
    comment: mark.comment ?? null,
  };
}

export function restoreBanyanMarkSnapshot(snapshot: BanyanMarkStateSnapshot): BanyanMark {
  return {
    id: snapshot.id,
    sectionId: snapshot.sectionId,
    time: snapshot.time,
    estimatedTime: snapshot.estimatedTime,
    sourceSymbol: snapshot.sourceSymbol,
    ...(snapshot.sourceTokenIndex === null ? {} : { sourceTokenIndex: snapshot.sourceTokenIndex }),
    ...(snapshot.sourceKey === null ? {} : { sourceKey: snapshot.sourceKey }),
    role: snapshot.role,
    subtype: snapshot.subtype,
    segment: snapshot.segment,
    beatIndex: snapshot.beatIndex,
    cycleIndex: snapshot.cycleIndex,
    ...(snapshot.strength === null ? {} : { strength: snapshot.strength }),
    attachment: snapshot.attachment,
    linkedGongcheAnnotationId: snapshot.linkedGongcheAnnotationId,
    linkedGongcheSymbolId: snapshot.linkedGongcheSymbolId,
    ...(snapshot.linkedGongcheSymbolIds === null
      ? {}
      : { linkedGongcheSymbolIds: [...snapshot.linkedGongcheSymbolIds] }),
    confidence: snapshot.confidence,
    ...(snapshot.manualOffset === null ? {} : { manualOffset: snapshot.manualOffset }),
    durationHint: snapshot.durationHint,
    orphaned: snapshot.orphaned,
    ...(snapshot.comment === null ? {} : { comment: snapshot.comment }),
  };
}
