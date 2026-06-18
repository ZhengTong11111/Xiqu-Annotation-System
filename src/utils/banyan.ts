import type {
  BanyanMark,
  BanyanSection,
  GongcheAnnotation,
  ProjectData,
} from "../types";
import { getProjectDuration } from "./project";

export type GenerateBanyanMarksResult = {
  project: ProjectData;
  stats: {
    created: number;
    updated: number;
    preserved: number;
    orphaned: number;
    sectionCreated: boolean;
  };
};

type BanyanCandidate = Omit<BanyanMark, "id" | "sectionId" | "confidence" | "manualOffset" | "orphaned">;

const BANYAN_CORE_TOKEN_PATTERN = /[1-8]/g;

export function generateBanyanMarksFromGongche(project: ProjectData): GenerateBanyanMarksResult {
  const sortedGongche = [...(project.gongcheAnnotations ?? [])].sort((left, right) => left.startTime - right.startTime);
  const candidates = inferBanyanCandidates(sortedGongche);
  const sectionResult = ensureBanyanSection(project.banyanSections ?? [], candidates, project);
  const sectionId = sectionResult.section?.id ?? null;
  const candidateKeys = new Set(candidates.map((candidate) => candidate.sourceKey).filter(Boolean));
  const existingBySourceKey = new Map(
    (project.banyanMarks ?? [])
      .filter((mark) => mark.sourceKey)
      .map((mark) => [mark.sourceKey, mark]),
  );
  const nextMarks: BanyanMark[] = [];
  const stats = {
    created: 0,
    updated: 0,
    preserved: 0,
    orphaned: 0,
    sectionCreated: sectionResult.created,
  };

  for (const candidate of candidates) {
    const existing = candidate.sourceKey ? existingBySourceKey.get(candidate.sourceKey) : null;
    if (!existing) {
      stats.created += 1;
      nextMarks.push({
        ...candidate,
        id: `banyan-mark-${crypto.randomUUID()}`,
        sectionId,
        confidence: "auto",
        manualOffset: 0,
        orphaned: false,
      });
      continue;
    }

    const isManuallyAdjusted = existing.confidence === "manual" || existing.confidence === "reviewed";
    if (isManuallyAdjusted) {
      stats.preserved += 1;
      nextMarks.push({
        ...existing,
        ...candidate,
        id: existing.id,
        sectionId: existing.sectionId ?? sectionId,
        time: existing.time,
        estimatedTime: candidate.estimatedTime,
        confidence: existing.confidence,
        manualOffset: existing.time - candidate.estimatedTime,
        orphaned: false,
        comment: existing.comment,
      });
    } else {
      stats.updated += 1;
      nextMarks.push({
        ...existing,
        ...candidate,
        id: existing.id,
        sectionId: existing.sectionId ?? sectionId,
        time: candidate.estimatedTime,
        estimatedTime: candidate.estimatedTime,
        confidence: "auto",
        manualOffset: 0,
        orphaned: false,
        comment: existing.comment,
      });
    }
  }

  for (const existing of project.banyanMarks ?? []) {
    if (existing.sourceKey && candidateKeys.has(existing.sourceKey)) {
      continue;
    }
    if (existing.sourceKey && !candidateKeys.has(existing.sourceKey)) {
      stats.orphaned += existing.orphaned ? 0 : 1;
      nextMarks.push({
        ...existing,
        orphaned: true,
      });
      continue;
    }
    nextMarks.push(existing);
  }

  return {
    project: {
      ...project,
      banyanSections: sectionResult.sections,
      banyanMarks: sortBanyanMarks(nextMarks),
    },
    stats,
  };
}

export function getBanyanMarkDisplayLabel(mark: BanyanMark) {
  if (mark.subtype === "smallEye") {
    return "小眼";
  }
  return getBanyanSubtypeLabel(mark.subtype);
}

export function getBanyanSubtypeLabel(subtype: BanyanMark["subtype"]) {
  const labels: Record<BanyanMark["subtype"], string> = {
    mainBan: "正板",
    headBan: "头板",
    waistBan: "腰板",
    bottomBan: "底板",
    zengBan: "赠板",
    waistZengBan: "腰赠板",
    middleEye: "中眼",
    smallEye: "小眼（头末眼）",
    sideHeadTailEye: "侧头末眼",
    sideMiddleEye: "侧中眼",
    phraseBoundary: "句读",
    unknown: "未定",
  };
  return labels[subtype];
}

export function getBanyanRoleLabel(role: BanyanMark["role"]) {
  if (role === "ban") {
    return "板";
  }
  if (role === "yan") {
    return "眼";
  }
  return "辅助";
}

export function getBanyanConfidenceLabel(confidence: BanyanMark["confidence"]) {
  if (confidence === "manual") {
    return "手动";
  }
  if (confidence === "reviewed") {
    return "已检查";
  }
  return "自动";
}

function inferBanyanCandidates(gongcheAnnotations: GongcheAnnotation[]) {
  const rawCandidates = gongcheAnnotations.flatMap((annotation) =>
    [...annotation.symbols]
      .sort((left, right) => left.startTime - right.startTime)
      .flatMap((symbol) => {
        const notation = symbol.notation ?? "";
        const matches = Array.from(notation.matchAll(BANYAN_CORE_TOKEN_PATTERN));
        const symbolDuration = Math.max(symbol.endTime - symbol.startTime, 0.001);
        return matches.map((match, tokenIndex) => {
          const sourceSymbol = match[0];
          const estimatedTime = matches.length <= 1
            ? symbol.startTime
            : symbol.startTime + (symbolDuration * tokenIndex) / matches.length;
          return {
            sourceSymbol,
            sourceTokenIndex: tokenIndex,
            sourceKey: `${annotation.id}:${symbol.id}:${tokenIndex}:${sourceSymbol}`,
            time: estimatedTime,
            estimatedTime,
            linkedGongcheAnnotationId: annotation.id,
            linkedGongcheSymbolId: symbol.id,
            linkedGongcheSymbolIds: [symbol.id],
            durationHint: notation,
            attachment: "on_note" as const,
          };
        });
      }),
  ).sort((left, right) => left.estimatedTime - right.estimatedTime);

  return rawCandidates.map((candidate): BanyanCandidate => ({
    ...candidate,
    ...inferBanyanSemantics(candidate.sourceSymbol),
  }));
}

function inferBanyanSemantics(
  sourceSymbol: string,
): Pick<BanyanCandidate, "role" | "subtype" | "segment" | "beatIndex" | "strength"> {
  if (sourceSymbol === "1") {
    return {
      role: "ban",
      subtype: "mainBan",
      segment: "main",
      beatIndex: 1,
      strength: "strong",
    };
  }
  if (sourceSymbol === "3") {
    return {
      role: "yan",
      subtype: "middleEye",
      segment: "main",
      beatIndex: 3,
      strength: "medium",
    };
  }
  if (sourceSymbol === "4") {
    return {
      role: "ban",
      subtype: "zengBan",
      segment: "zeng",
      beatIndex: 1,
      strength: "strong",
    };
  }
  if (sourceSymbol === "5") {
    return {
      role: "ban",
      subtype: "bottomBan",
      segment: "main",
      beatIndex: 1,
      strength: "strong",
    };
  }
  if (sourceSymbol === "6") {
    return {
      role: "yan",
      subtype: "sideHeadTailEye",
      segment: "main",
      beatIndex: 2,
      strength: "weak",
    };
  }
  if (sourceSymbol === "7") {
    return {
      role: "yan",
      subtype: "sideMiddleEye",
      segment: "main",
      beatIndex: 3,
      strength: "medium",
    };
  }
  if (sourceSymbol === "8") {
    return {
      role: "ban",
      subtype: "waistZengBan",
      segment: "zeng",
      beatIndex: 1,
      strength: "strong",
    };
  }
  if (sourceSymbol === "2") {
    return {
      role: "yan",
      subtype: "smallEye",
      segment: "main",
      beatIndex: 2,
      strength: "weak",
    };
  }
  return {
    role: "auxiliary",
    subtype: "unknown",
    segment: "unknown",
    beatIndex: null,
    strength: "unknown",
  };
}

function ensureBanyanSection(
  sections: BanyanSection[],
  candidates: BanyanCandidate[],
  project: ProjectData,
) {
  if (sections.length > 0 || candidates.length === 0) {
    return {
      sections,
      section: sections[0] ?? null,
      created: false,
    };
  }
  const startTime = Math.max(0, candidates[0].estimatedTime);
  const endTime = Math.max(
    startTime,
    candidates[candidates.length - 1].estimatedTime,
    getProjectDuration(project),
  );
  const section: BanyanSection = {
    id: `banyan-section-${crypto.randomUUID()}`,
    name: "板眼区段",
    startTime,
    endTime,
    cycleType: "yi_ban_san_yan_zeng",
    freeRhythm: false,
    beatCount: 8,
    hasZengBan: true,
    source: "gongche-notation",
    comment: "由工尺谱 notation 自动生成的默认板眼区段，可按曲牌继续细分。",
  };
  return {
    sections: [section],
    section,
    created: true,
  };
}

function sortBanyanMarks(marks: BanyanMark[]) {
  return [...marks].sort((left, right) => left.time - right.time);
}
