import { createHash } from "node:crypto";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";

export type MediaAnalysisMigrationRunFact = {
  id: string;
  sourceMediaResourceId: string;
  sourceFingerprint: string;
  persistedMediaFingerprint: string | null;
  algorithmVersion: string;
  configHash: string;
  configFingerprint: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  supersededByRunId: string | null;
  activeJobCount: number;
  assetCount: number;
  assetFactsFingerprint: string;
  assetValidation: "valid" | "invalid";
};

export type MediaAnalysisMigrationBlockCode =
  | "active_job"
  | "asset_validation_failed"
  | "config_mismatch"
  | "media_fingerprint_missing"
  | "invalid_supersession";

export type MediaAnalysisMigrationGroupPlan = {
  identity: string;
  canonicalRunId: string | null;
  duplicateRunIds: string[];
  backfillRunIds: string[];
  blockCodes: MediaAnalysisMigrationBlockCode[];
};

export type MediaAnalysisMigrationPlan = {
  version: 1;
  fingerprint: string;
  runCount: number;
  duplicateGroupCount: number;
  actionableGroupCount: number;
  blockedGroupCount: number;
  groups: MediaAnalysisMigrationGroupPlan[];
};

// 归并 identity 使用稳定 JSON 元组，资源 id 或 fingerprint 内的分隔符不会造成碰撞。
export function createMediaAnalysisMigrationIdentity(
  fact: Pick<
    MediaAnalysisMigrationRunFact,
    "sourceMediaResourceId" | "sourceFingerprint" | "algorithmVersion" | "configHash"
  >,
) {
  return JSON.stringify([
    fact.sourceMediaResourceId,
    fact.sourceFingerprint,
    fact.algorithmVersion,
    fact.configHash,
  ]);
}

// 纯计划器不读取数据库或对象存储，确保 dry-run 与 execute 使用完全相同的分组和 canonical 规则。
export function buildMediaAnalysisMigrationPlan(
  facts: readonly MediaAnalysisMigrationRunFact[],
): MediaAnalysisMigrationPlan {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const invalidSupersessionIds = new Set<string>();
  for (const fact of facts) {
    if (!fact.supersededByRunId) continue;
    const target = byId.get(fact.supersededByRunId);
    if (
      !target ||
      target.supersededByRunId !== null ||
      createMediaAnalysisMigrationIdentity(target) !== createMediaAnalysisMigrationIdentity(fact)
    ) {
      invalidSupersessionIds.add(fact.id);
    }
  }

  const grouped = new Map<string, MediaAnalysisMigrationRunFact[]>();
  for (const fact of facts) {
    const identity = createMediaAnalysisMigrationIdentity(fact);
    const group = grouped.get(identity) ?? [];
    group.push(fact);
    grouped.set(identity, group);
  }

  const groups: MediaAnalysisMigrationGroupPlan[] = [];
  for (const [identity, allRuns] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const activeRuns = allRuns.filter((fact) => fact.supersededByRunId === null);
    const blockCodes = new Set<MediaAnalysisMigrationBlockCode>();
    if (allRuns.some((fact) => invalidSupersessionIds.has(fact.id))) {
      blockCodes.add("invalid_supersession");
    }
    if (activeRuns.some((fact) => fact.activeJobCount > 0 || fact.status === "queued" || fact.status === "running")) {
      blockCodes.add("active_job");
    }
    if (new Set(activeRuns.map((fact) => fact.configFingerprint)).size > 1) {
      blockCodes.add("config_mismatch");
    }
    if (activeRuns.some((fact) => fact.assetValidation === "invalid")) {
      blockCodes.add("asset_validation_failed");
    }
    if (activeRuns.some((fact) => !/^[a-f0-9]{64}$/u.test(fact.sourceFingerprint))) {
      blockCodes.add("media_fingerprint_missing");
    }

    const sorted = [...activeRuns].sort(compareCanonicalCandidates);
    const canonical = sorted[0] ?? null;
    groups.push({
      identity: createHash("sha256").update(identity).digest("hex"),
      canonicalRunId: canonical?.id ?? null,
      duplicateRunIds: sorted.slice(1).map((fact) => fact.id).sort(),
      backfillRunIds: canonical && canonical.persistedMediaFingerprint !== canonical.sourceFingerprint
        ? [canonical.id]
        : [],
      blockCodes: [...blockCodes].sort(),
    });
  }

  const normalizedFacts = [...facts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((fact) => ({ ...fact }));
  const normalizedGroups = groups.map((group) => ({ ...group }));
  const fingerprint = createHash("sha256")
    .update(stableJsonStringify({ version: 1, facts: normalizedFacts, groups: normalizedGroups }))
    .digest("hex");
  return {
    version: 1,
    fingerprint,
    runCount: facts.length,
    duplicateGroupCount: groups.filter((group) => group.duplicateRunIds.length > 0).length,
    actionableGroupCount: groups.filter((group) =>
      (group.duplicateRunIds.length > 0 || group.backfillRunIds.length > 0) &&
      group.blockCodes.length === 0).length,
    blockedGroupCount: groups.filter((group) => group.blockCodes.length > 0).length,
    groups,
  };
}

function compareCanonicalCandidates(
  left: MediaAnalysisMigrationRunFact,
  right: MediaAnalysisMigrationRunFact,
) {
  const statusRank = (status: MediaAnalysisMigrationRunFact["status"]) =>
    status === "succeeded" ? 0 : status === "failed" ? 1 : 2;
  const rankDifference = statusRank(left.status) - statusRank(right.status);
  if (rankDifference !== 0) return rankDifference;
  for (const key of ["completedAt", "updatedAt", "createdAt"] as const) {
    const difference = (right[key] ?? "").localeCompare(left[key] ?? "");
    if (difference !== 0) return difference;
  }
  return left.id.localeCompare(right.id);
}
