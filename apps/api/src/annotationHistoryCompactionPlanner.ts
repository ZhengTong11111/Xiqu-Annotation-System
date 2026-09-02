import type { ProjectData } from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import {
  createAnnotationHistoryCanonicalHash,
  measureAnnotationHistoryJsonBytes,
} from "./annotationHistoryCanonicalHash.js";
import {
  DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY,
  selectRequiredInlineSnapshots,
  validateAnnotationHistoryCompactionPolicy,
  type AnnotationHistoryCompactionPolicy,
  type AnnotationHistoryKeepReason,
} from "./annotationHistoryCompactionPolicy.js";
import {
  buildAnnotationHistoryRecipe,
  buildAnnotationHistoryRevisionValidations,
  replayAnnotationHistoryToRevision,
  toAnnotationHistoryPolicyRevisionFact,
} from "./annotationHistoryCompactionReplay.js";
import {
  ANNOTATION_HISTORY_COMPACTION_PLAN_VERSION,
  MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE,
  MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE,
  type AnnotationHistoryBlockCode,
  type AnnotationHistoryCompactionPlan,
  type AnnotationHistoryCompactionPlannerOptions,
  type AnnotationHistoryCompactionRepository,
  type AnnotationHistoryFilePlan,
  type AnnotationHistoryLoadedSnapshot,
  type AnnotationHistorySnapshotDecision,
  type AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";

export {
  ANNOTATION_HISTORY_COMPACTION_PLAN_VERSION,
  MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE,
  MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE,
};
export type {
  AnnotationHistoryBlockCode,
  AnnotationHistoryCompactionPlan,
  AnnotationHistoryCompactionPlannerOptions,
  AnnotationHistoryCompactionRepository,
  AnnotationHistoryFilePlan,
  AnnotationHistoryOperationFact,
  AnnotationHistorySnapshotDecision,
  AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";

/**
 * HC1 规划器只依赖只读 repository，并在内存中复用正式领域 command adapter。
 * repository 异常只阻断当前文件；任何结果都不包含标注正文或完整 operation payload。
 */
export class AnnotationHistoryCompactionPlanner {
  constructor(private readonly repository: AnnotationHistoryCompactionRepository) {}

  async plan(options: AnnotationHistoryCompactionPlannerOptions): Promise<AnnotationHistoryCompactionPlan> {
    validatePlannerLimits(options);
    const now = options.now ?? new Date();
    const policy = options.policy ?? DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY;
    validateAnnotationHistoryCompactionPolicy(policy);
    if (!Number.isFinite(now.getTime())) throw new Error("恢复历史规划时间无效。");
    const fileIds = options.annotationFileId
      ? [options.annotationFileId]
      : await this.listFileIds(options.limitFiles ?? null, options.signal);
    const files: AnnotationHistoryFilePlan[] = [];
    for (const annotationFileId of fileIds) {
      if (options.signal?.aborted) break;
      try {
        const file = await this.planFile(annotationFileId, {
          maxRevisionsPerFile: options.maxRevisionsPerFile,
          maxOperationsPerFile: options.maxOperationsPerFile,
          policy,
          now,
          signal: options.signal,
        });
        files.push(file);
      } catch {
        // 单文件读取失败不能终止整个全库 dry-run；稳定错误码不泄露数据库异常或 payload。
        files.push(createRepositoryFailureFilePlan(annotationFileId));
      }
      const latest = files.at(-1)!;
      options.onFilePlanned?.({
        annotationFileId,
        completedFileCount: files.length,
        snapshotCount: latest.snapshotCount,
      });
    }
    return {
      version: ANNOTATION_HISTORY_COMPACTION_PLAN_VERSION,
      mode: "dry-run",
      generatedAt: now.toISOString(),
      interrupted: options.signal?.aborted ?? false,
      policy: { ...policy },
      limits: {
        maxRevisionsPerFile: options.maxRevisionsPerFile,
        maxOperationsPerFile: options.maxOperationsPerFile,
        limitFiles: options.limitFiles ?? null,
      },
      files,
      summary: summarizeFilePlans(files),
    };
  }

  private async listFileIds(limitFiles: number | null, signal?: AbortSignal) {
    const fileIds: string[] = [];
    let afterId: string | null = null;
    while (!signal?.aborted && (limitFiles === null || fileIds.length < limitFiles)) {
      const take = Math.min(100, limitFiles === null ? 100 : limitFiles - fileIds.length);
      const page = await this.repository.listAnnotationFileIds({ afterId, take });
      if (page.length === 0) break;
      fileIds.push(...page);
      afterId = page.at(-1) ?? null;
      if (page.length < take) break;
    }
    return fileIds;
  }

  private async planFile(
    annotationFileId: string,
    options: {
      maxRevisionsPerFile: number;
      maxOperationsPerFile: number;
      policy: AnnotationHistoryCompactionPolicy;
      now: Date;
      signal?: AbortSignal;
    },
  ): Promise<AnnotationHistoryFilePlan> {
    const snapshotPage = await this.repository.listSnapshots({
      annotationFileId,
      maxRevisions: options.maxRevisionsPerFile,
    });
    const snapshots = validateSnapshotFacts(snapshotPage.items);
    if (snapshots.length === 0) return createEmptyFilePlan(annotationFileId, snapshotPage.truncated);
    const firstRevision = snapshots[0]!.revision;
    const lastRevision = snapshots.at(-1)!.revision;
    const operationPage = await this.repository.listCommittedOperations({
      annotationFileId,
      fromRevisionExclusive: firstRevision,
      toRevisionInclusive: lastRevision,
      maxOperations: options.maxOperationsPerFile,
    });
    const protectedRevisionPage = await this.repository.listProtectedRevisions({
      annotationFileId,
      maxRevisions: options.maxRevisionsPerFile,
    });
    const protectedRevisions = protectedRevisionPage.revisions;
    const revisionValidations = buildAnnotationHistoryRevisionValidations(
      annotationFileId,
      operationPage.items,
      firstRevision,
      lastRevision,
    );
    const requiredInline = selectRequiredInlineSnapshots({
      snapshots,
      revisions: [...revisionValidations.values()].map(toAnnotationHistoryPolicyRevisionFact),
      protectedRevisions,
      now: options.now,
      policy: options.policy,
    });
    const snapshotRevisionSet = new Set(snapshots.map((snapshot) => snapshot.revision));

    const decisions: AnnotationHistorySnapshotDecision[] = [];
    let currentProject: ProjectData | null = null;
    let currentRevision: number | null = null;
    let checkpoint: AnnotationHistorySnapshotFact | null = null;
    for (const snapshot of snapshots) {
      if (options.signal?.aborted) break;
      let keepReasons = [...(requiredInline.get(snapshot.revision) ?? [])].sort();
      if (snapshotPage.truncated && snapshot === snapshots.at(-1)) {
        keepReasons = keepReasons.filter((reason) => reason !== "last_snapshot");
        keepReasons.push("scan_boundary");
      }
      const checkpointUnavailable = keepReasons.length === 0 &&
        (currentProject === null || currentRevision === null || !checkpoint);
      const mustLoadInline = protectedRevisionPage.truncated || keepReasons.length > 0 || checkpointUnavailable;
      if (mustLoadInline) {
        const loaded = await this.loadSnapshot(annotationFileId, snapshot);
        const blockCodes = new Set<AnnotationHistoryBlockCode>();
        if (protectedRevisionPage.truncated) blockCodes.add("protected_revision_scan_truncated");
        if (checkpointUnavailable) blockCodes.add("checkpoint_unavailable");
        if (!loaded.project) {
          blockCodes.add(loaded.payload === null
            ? "snapshot_payload_missing"
            : "snapshot_payload_invalid");
        }
        decisions.push(buildInlineDecision(snapshot, keepReasons, loaded, [...blockCodes]));
        if (loaded.project) {
          currentProject = loaded.project;
          currentRevision = snapshot.revision;
          checkpoint = snapshot;
        } else {
          currentProject = null;
          currentRevision = null;
          checkpoint = null;
        }
        continue;
      }

      if (currentProject === null || currentRevision === null || checkpoint === null) {
        throw new Error("恢复历史规划器内部检查点状态不完整。");
      }

      const replay = replayAnnotationHistoryToRevision({
        project: currentProject,
        fromRevision: currentRevision,
        toRevision: snapshot.revision,
        revisions: revisionValidations,
        operationScanTruncated: operationPage.truncated,
      });
      const loaded = await this.loadSnapshot(annotationFileId, snapshot);
      const replayBlockCodes = [...replay.blockCodes];
      if (!loaded.project) {
        replayBlockCodes.push(loaded.payload === null
          ? "snapshot_payload_missing"
          : "snapshot_payload_invalid");
      }
      const replayHash = replay.project
        ? createAnnotationHistoryCanonicalHash(replay.project)
        : null;
      if (replayHash && loaded.payloadHash && replayHash !== loaded.payloadHash) {
        replayBlockCodes.push("canonical_hash_mismatch");
      }
      const uniqueBlockCodes = [...new Set(replayBlockCodes)].sort() as AnnotationHistoryBlockCode[];
      if (uniqueBlockCodes.length === 0 && replay.project && loaded.payloadHash && checkpoint) {
        const recipe = buildAnnotationHistoryRecipe({
          checkpoint,
          target: snapshot,
          targetPayloadHash: loaded.payloadHash,
          revisions: revisionValidations,
        });
        decisions.push({
          snapshotId: snapshot.id,
          revision: snapshot.revision,
          decision: "reconstructible",
          keepReasons: [],
          blockCodes: [],
          payloadBytes: loaded.payloadBytes,
          payloadHash: loaded.payloadHash,
          recipe,
        });
        currentProject = replay.project;
        currentRevision = snapshot.revision;
        continue;
      }

      // 候选失败后保留其原始 payload，并把它作为新的可信检查点；后续 revision 不会被同一坏区间连带污染。
      decisions.push(buildInlineDecision(snapshot, [], loaded, uniqueBlockCodes));
      if (loaded.project) {
        currentProject = loaded.project;
        currentRevision = snapshot.revision;
        checkpoint = snapshot;
      } else {
        currentProject = null;
        currentRevision = null;
        checkpoint = null;
      }
    }

    if (snapshotPage.truncated && decisions.length > 0) {
      const terminal = decisions.at(-1)!;
      terminal.decision = "blocked";
      terminal.blockCodes = [...new Set([...terminal.blockCodes, "snapshot_scan_truncated"])].sort() as AnnotationHistoryBlockCode[];
      terminal.recipe = null;
    }
    const payloadBytes = decisions.reduce((total, decision) => total + decision.payloadBytes, 0);
    const estimatedRecipeBytes = decisions.reduce(
      (total, decision) => total + (decision.recipe?.estimatedBytes ?? 0),
      0,
    );
    const reconstructiblePayloadBytes = decisions.reduce(
      (total, decision) => total + (decision.decision === "reconstructible" ? decision.payloadBytes : 0),
      0,
    );
    const recipes = decisions.flatMap((decision) => decision.recipe ? [decision.recipe] : []);
    return {
      annotationFileId,
      snapshotCount: decisions.length,
      operationCount: operationPage.items.length,
      protectedRevisionCount: protectedRevisions.size,
      protectedRevisionScanTruncated: protectedRevisionPage.truncated,
      unmatchedProtectedRevisions: [...protectedRevisions]
        .filter((revision) => !snapshotRevisionSet.has(revision))
        .sort((left, right) => left - right),
      snapshotScanTruncated: snapshotPage.truncated,
      operationScanTruncated: operationPage.truncated,
      payloadBytes,
      estimatedRecipeBytes,
      estimatedReclaimableBytes: Math.max(0, reconstructiblePayloadBytes - estimatedRecipeBytes),
      maxReplayRevisionDistance: Math.max(
        0,
        ...recipes.map((recipe) => recipe.operationRevisionEnd - recipe.checkpointRevision),
      ),
      maxReplayOperationCount: Math.max(0, ...recipes.map((recipe) => recipe.operationCount)),
      blockCodeCounts: countBlockCodes(decisions),
      decisions,
      errorCode: null,
    };
  }

  private async loadSnapshot(
    annotationFileId: string,
    snapshot: AnnotationHistorySnapshotFact,
  ): Promise<AnnotationHistoryLoadedSnapshot> {
    const payload = await this.repository.loadSnapshotPayload({
      annotationFileId,
      snapshotId: snapshot.id,
    });
    if (payload === null) {
      return { payload: null, payloadBytes: 0, payloadHash: "", project: null };
    }
    const payloadBytes = measureAnnotationHistoryJsonBytes(payload);
    const payloadHash = createAnnotationHistoryCanonicalHash(payload);
    const parsed = parseCurrentProjectData(payload);
    return {
      payload,
      payloadBytes,
      payloadHash,
      project: parsed.success ? parsed.data : null,
    };
  }
}

// 所有无法证明的候选仍保留原 payload；blocked 是诊断结论，不代表已改写存储模式。
function buildInlineDecision(
  snapshot: AnnotationHistorySnapshotFact,
  keepReasons: AnnotationHistoryKeepReason[],
  loaded: AnnotationHistoryLoadedSnapshot,
  blockCodes: AnnotationHistoryBlockCode[],
): AnnotationHistorySnapshotDecision {
  return {
    snapshotId: snapshot.id,
    revision: snapshot.revision,
    decision: blockCodes.length > 0 ? "blocked" : "keep_inline",
    keepReasons: [...new Set(keepReasons)].sort(),
    blockCodes: [...new Set(blockCodes)].sort() as AnnotationHistoryBlockCode[],
    payloadBytes: loaded.payloadBytes,
    payloadHash: loaded.payloadHash || null,
    recipe: null,
  };
}

// 即使数据库当前有唯一约束，dry-run 仍显式复核 revision，防止异常导入历史被静默排序掩盖。
function validateSnapshotFacts(facts: readonly AnnotationHistorySnapshotFact[]) {
  const sorted = [...facts].sort((left, right) => left.revision - right.revision);
  const revisions = new Set<number>();
  for (const snapshot of sorted) {
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 1 || revisions.has(snapshot.revision)) {
      throw new Error("恢复快照 revision 元数据无效或重复。");
    }
    revisions.add(snapshot.revision);
  }
  return sorted;
}

// 内存上限属于算法合同，不能只依赖 CLI；测试或未来调用者同样必须受约束。
function validatePlannerLimits(options: AnnotationHistoryCompactionPlannerOptions) {
  for (const [name, value] of [
    ["maxRevisionsPerFile", options.maxRevisionsPerFile],
    ["maxOperationsPerFile", options.maxOperationsPerFile],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数。`);
  }
  if (options.maxRevisionsPerFile > MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE) {
    throw new Error(`maxRevisionsPerFile 不能超过 ${MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE}。`);
  }
  if (options.maxOperationsPerFile > MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE) {
    throw new Error(`maxOperationsPerFile 不能超过 ${MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE}。`);
  }
  if (options.limitFiles !== undefined && (!Number.isInteger(options.limitFiles) || options.limitFiles <= 0)) {
    throw new Error("limitFiles 必须是正整数。");
  }
}

// 空文件仍返回完整、可聚合的报告结构，调用者无需猜测缺省字段。
function createEmptyFilePlan(
  annotationFileId: string,
  snapshotScanTruncated: boolean,
): AnnotationHistoryFilePlan {
  return {
    annotationFileId,
    snapshotCount: 0,
    operationCount: 0,
    protectedRevisionCount: 0,
    protectedRevisionScanTruncated: false,
    unmatchedProtectedRevisions: [],
    snapshotScanTruncated,
    operationScanTruncated: false,
    payloadBytes: 0,
    estimatedRecipeBytes: 0,
    estimatedReclaimableBytes: 0,
    maxReplayRevisionDistance: 0,
    maxReplayOperationCount: 0,
    blockCodeCounts: {},
    decisions: [],
    errorCode: null,
  };
}

// 数据库异常不透传原始消息，只把当前文件标成稳定读取失败。
function createRepositoryFailureFilePlan(annotationFileId: string): AnnotationHistoryFilePlan {
  return { ...createEmptyFilePlan(annotationFileId, false), errorCode: "repository_read_failed" };
}

// 汇总只累加计数和容量，不把单文件 payload 或 operation 带入顶层报告。
function summarizeFilePlans(files: readonly AnnotationHistoryFilePlan[]) {
  const decisions = files.flatMap((file) => file.decisions);
  return {
    fileCount: files.length,
    snapshotCount: decisions.length,
    operationCount: files.reduce((total, file) => total + file.operationCount, 0),
    keepInlineCount: decisions.filter((decision) => decision.decision === "keep_inline").length,
    reconstructibleCount: decisions.filter((decision) => decision.decision === "reconstructible").length,
    blockedCount: decisions.filter((decision) => decision.decision === "blocked").length,
    payloadBytes: files.reduce((total, file) => total + file.payloadBytes, 0),
    estimatedRecipeBytes: files.reduce((total, file) => total + file.estimatedRecipeBytes, 0),
    estimatedReclaimableBytes: files.reduce((total, file) => total + file.estimatedReclaimableBytes, 0),
    maxReplayRevisionDistance: Math.max(0, ...files.map((file) => file.maxReplayRevisionDistance)),
    maxReplayOperationCount: Math.max(0, ...files.map((file) => file.maxReplayOperationCount)),
    blockCodeCounts: mergeBlockCodeCounts(files.map((file) => file.blockCodeCounts)),
  };
}

// 阻断码计数帮助校准生产策略，同时保持原因集合为固定低基数字段。
function countBlockCodes(decisions: readonly AnnotationHistorySnapshotDecision[]) {
  const counts: Partial<Record<AnnotationHistoryBlockCode, number>> = {};
  for (const decision of decisions) {
    for (const code of decision.blockCodes) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

// 多文件汇总复用同一固定枚举，禁止把错误文本用作动态键。
function mergeBlockCodeCounts(
  sources: ReadonlyArray<Partial<Record<AnnotationHistoryBlockCode, number>>>,
) {
  const counts: Partial<Record<AnnotationHistoryBlockCode, number>> = {};
  for (const source of sources) {
    for (const [code, count] of Object.entries(source) as Array<[AnnotationHistoryBlockCode, number]>) {
      counts[code] = (counts[code] ?? 0) + count;
    }
  }
  return counts;
}
