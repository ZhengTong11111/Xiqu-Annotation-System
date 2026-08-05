import { createHash } from "node:crypto";
import type {
  ObjectStorage,
  StoredObjectSummary,
} from "../objectStorage.js";
import {
  buildRemoteBackupPackageFiles,
  formatRemoteBackupError,
  readRemoteBackupManifest,
} from "./remoteBackupPackage.js";
import {
  isProductionRemoteBackupId,
  remoteBackupKeys,
} from "./remoteBackupPaths.js";
import type { RemoteBackupRetentionPolicy } from "./remoteBackupRetentionPolicy.js";

export type RemoteBackupPackageStatus =
  | "complete"
  | "incomplete"
  | "invalid_manifest"
  | "inconsistent";

export type RemoteBackupLifecyclePackage = {
  backupId: string;
  status: RemoteBackupPackageStatus;
  createdAt: string | null;
  lastModifiedAt: string;
  objectCount: number;
  totalBytes: number;
  cleanupEligible: boolean;
  reason: string;
};

export type RemoteBackupLifecycleReport = {
  generatedAt: string;
  policy: RemoteBackupRetentionPolicy;
  planToken: string;
  packages: RemoteBackupLifecyclePackage[];
  unrecognized: { objectCount: number; totalBytes: number };
  eligible: { packageCount: number; objectCount: number; totalBytes: number };
};

export type RemoteBackupCleanupResult = {
  planToken: string;
  packages: Array<{
    backupId: string;
    status: "deleted" | "failed";
    deletedObjectCount: number;
    deletedBytes: number;
    errors: string[];
  }>;
  deletedPackageCount: number;
  failedPackageCount: number;
  deletedObjectCount: number;
  deletedBytes: number;
};

type InspectedPackage = {
  summary: RemoteBackupLifecyclePackage;
  objects: StoredObjectSummary[];
  manifestKey: string | null;
};

type LifecyclePlan = {
  report: RemoteBackupLifecycleReport;
  packages: InspectedPackage[];
};

// 生命周期服务只管理独立备份命名空间，不连接业务数据库或改变平台维护状态。
export class RemoteBackupLifecycleService {
  constructor(
    private readonly storage: Pick<
      ObjectStorage,
      "getObjectStream" | "listStoredObjects" | "deleteObject"
    >,
  ) {}

  async inspect(
    policy: RemoteBackupRetentionPolicy,
    now = new Date(),
  ): Promise<RemoteBackupLifecycleReport> {
    return (await this.buildPlan(policy, now)).report;
  }

  // cleanup 重新生成完整计划并核对 token；远端状态或策略变化时在第一次删除前拒绝执行。
  async cleanup(
    policy: RemoteBackupRetentionPolicy,
    expectedPlanToken: string,
    confirm: boolean,
    now = new Date(),
  ): Promise<RemoteBackupCleanupResult> {
    if (!confirm) throw new Error("清理远端备份需要显式确认。 ");
    if (!/^[0-9a-f]{64}$/.test(expectedPlanToken)) {
      throw new Error("远端备份清理 plan token 无效。 ");
    }
    const plan = await this.buildPlan(policy, now);
    if (plan.report.planToken !== expectedPlanToken) {
      throw new Error("远端备份状态或保留策略已变化，请重新执行 inspect。 ");
    }

    const packageResults: RemoteBackupCleanupResult["packages"] = [];
    for (const inspected of plan.packages.filter(({ summary }) => summary.cleanupEligible)) {
      packageResults.push(await this.deletePackage(inspected));
    }
    return {
      planToken: plan.report.planToken,
      packages: packageResults,
      deletedPackageCount: packageResults.filter(({ status }) => status === "deleted").length,
      failedPackageCount: packageResults.filter(({ status }) => status === "failed").length,
      deletedObjectCount: packageResults.reduce((sum, item) => sum + item.deletedObjectCount, 0),
      deletedBytes: packageResults.reduce((sum, item) => sum + item.deletedBytes, 0),
    };
  }

  // 一次 list 结果按 production backup id 分组；每个完整候选只额外读取自己的 manifest。
  private async buildPlan(
    policy: RemoteBackupRetentionPolicy,
    now: Date,
  ): Promise<LifecyclePlan> {
    const listed = [...await this.storage.listStoredObjects()]
      .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    const groups = new Map<string, StoredObjectSummary[]>();
    const unrecognized: StoredObjectSummary[] = [];
    for (const object of listed) {
      const separatorIndex = object.storageKey.indexOf("/");
      const backupId = separatorIndex > 0
        ? object.storageKey.slice(0, separatorIndex)
        : "";
      // 只有 `<production-id>/...` 才是包对象；根级同名普通对象必须留在只报告集合。
      if (!isProductionRemoteBackupId(backupId)) {
        unrecognized.push(object);
        continue;
      }
      const group = groups.get(backupId) ?? [];
      group.push(object);
      groups.set(backupId, group);
    }

    const inspected: InspectedPackage[] = [];
    for (const [backupId, objects] of groups) {
      inspected.push(await this.inspectPackage(backupId, objects, policy, now));
    }

    // 完整包统一按 manifest 时间排序，至少保护最新 N 个；list 返回顺序不能影响保留结论。
    const completePackages = inspected
      .filter(({ summary }) => summary.status === "complete")
      .sort((left, right) => {
        const timeDifference = Date.parse(right.summary.createdAt!) -
          Date.parse(left.summary.createdAt!);
        return timeDifference || left.summary.backupId.localeCompare(right.summary.backupId);
      });
    const retentionCutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1_000;
    for (const [index, entry] of completePackages.entries()) {
      if (index < policy.minimumRetained) {
        entry.summary.reason = `属于最新 ${policy.minimumRetained} 个完整备份，必须保留。`;
      } else if (Date.parse(entry.summary.createdAt!) >= retentionCutoff) {
        entry.summary.reason = `完整备份仍在 ${policy.retentionDays} 天保留期内。`;
      } else {
        entry.summary.cleanupEligible = true;
        entry.summary.reason = "完整备份已超过保留期且不属于最少保留集合。";
      }
    }

    const packages = inspected.sort((left, right) =>
      left.summary.backupId.localeCompare(right.summary.backupId));
    const planToken = createPlanToken(policy, packages, unrecognized);
    const eligiblePackages = packages.filter(({ summary }) => summary.cleanupEligible);
    return {
      packages,
      report: {
        generatedAt: now.toISOString(),
        policy,
        planToken,
        packages: packages.map(({ summary }) => summary),
        unrecognized: summarizeObjects(unrecognized),
        eligible: {
          packageCount: eligiblePackages.length,
          objectCount: eligiblePackages.reduce((sum, item) => sum + item.objects.length, 0),
          totalBytes: eligiblePackages.reduce(
            (sum, item) => sum + summarizeObjects(item.objects).totalBytes,
            0,
          ),
        },
      },
    };
  }

  // 单包分类只信任有效 manifest 与精确 key 集合；坏包保留给人工诊断而不是自动删除。
  private async inspectPackage(
    backupId: string,
    objects: StoredObjectSummary[],
    policy: RemoteBackupRetentionPolicy,
    now: Date,
  ): Promise<InspectedPackage> {
    const objectSummary = summarizeObjects(objects);
    const lastModifiedAt = new Date(Math.max(
      ...objects.map(({ modifiedAt }) => modifiedAt.getTime()),
    )).toISOString();
    const manifestKey = remoteBackupKeys.manifest(backupId);
    const manifestObject = objects.find(({ storageKey }) => storageKey === manifestKey);
    if (!manifestObject) {
      const eligible = Date.parse(lastModifiedAt) < now.getTime() - policy.incompleteGraceMs;
      return {
        objects,
        manifestKey: null,
        summary: {
          backupId,
          status: "incomplete",
          createdAt: null,
          lastModifiedAt,
          ...objectSummary,
          cleanupEligible: eligible,
          reason: eligible
            ? "未完成备份的全部对象均已超过宽限期。"
            : "未完成备份仍在宽限期内，可能正在创建。",
        },
      };
    }

    let manifest;
    try {
      manifest = await readRemoteBackupManifest(this.storage, backupId);
    } catch (error) {
      return {
        objects,
        manifestKey,
        summary: {
          backupId,
          status: "invalid_manifest",
          createdAt: null,
          lastModifiedAt,
          ...objectSummary,
          cleanupEligible: false,
          reason: `manifest 无法安全解析，仅报告：${formatRemoteBackupError(error)}`,
        },
      };
    }

    const packageFiles = buildRemoteBackupPackageFiles(backupId, manifest);
    const expectedSizes = new Map(packageFiles.map(({ remoteKey, entry }) => [
      remoteKey,
      entry.size,
    ]));
    const expectedKeys = new Set([manifestKey, ...expectedSizes.keys()]);
    const actualByKey = new Map(objects.map((object) => [object.storageKey, object]));
    const exactSet = expectedKeys.size === actualByKey.size &&
      [...expectedKeys].every((key) => actualByKey.has(key)) &&
      [...expectedSizes].every(([key, expectedSize]) =>
        actualByKey.get(key)?.size === expectedSize);
    return {
      objects,
      manifestKey,
      summary: {
        backupId,
        status: exactSet ? "complete" : "inconsistent",
        createdAt: manifest.createdAt,
        lastModifiedAt,
        ...objectSummary,
        cleanupEligible: false,
        reason: exactSet
          ? "完整备份等待统一保留策略判断。"
          : "manifest 声明与实际对象集合不一致，仅报告。",
      },
    };
  }

  // 完整包先删除 manifest 再删 payload；未完成包没有提交标志，可直接逐项幂等清理。
  private async deletePackage(
    inspected: InspectedPackage,
  ): Promise<RemoteBackupCleanupResult["packages"][number]> {
    const orderedObjects = [...inspected.objects].sort((left, right) => {
      if (left.storageKey === inspected.manifestKey) return -1;
      if (right.storageKey === inspected.manifestKey) return 1;
      return left.storageKey.localeCompare(right.storageKey);
    });
    const errors: string[] = [];
    let deletedObjectCount = 0;
    let deletedBytes = 0;
    for (const [index, object] of orderedObjects.entries()) {
      try {
        await this.storage.deleteObject(object.storageKey);
        deletedObjectCount += 1;
        deletedBytes += object.size;
      } catch (error) {
        errors.push(`${object.storageKey}：${formatRemoteBackupError(error)}`);
        // 完整包的 manifest 删除失败时保持所有 payload 原样，不能暴露“看似完整但已缺文件”的包。
        if (index === 0 && object.storageKey === inspected.manifestKey) break;
      }
    }
    return {
      backupId: inspected.summary.backupId,
      status: errors.length === 0 ? "deleted" : "failed",
      deletedObjectCount,
      deletedBytes,
      errors,
    };
  }
}

// token 覆盖策略、全部对象事实、分类和最终 eligibility，但排除 generatedAt 以保持同状态重复扫描稳定。
function createPlanToken(
  policy: RemoteBackupRetentionPolicy,
  packages: InspectedPackage[],
  unrecognized: StoredObjectSummary[],
) {
  const stableState = {
    policy,
    packages: packages.map(({ summary, objects, manifestKey }) => ({
      summary,
      manifestKey,
      objects: objects.map(toStableObject),
    })),
    unrecognized: unrecognized.map(toStableObject),
  };
  return createHash("sha256").update(JSON.stringify(stableState)).digest("hex");
}

// 对象摘要进入指纹前转换成稳定 JSON；Date 对象不能依赖隐式序列化约定。
function toStableObject(object: StoredObjectSummary) {
  return {
    storageKey: object.storageKey,
    size: object.size,
    modifiedAt: object.modifiedAt.toISOString(),
    staged: object.staged,
  };
}

// 汇总统一使用安全整数相加，报告不携带对象正文或远端服务内部标识。
function summarizeObjects(objects: StoredObjectSummary[]) {
  let totalBytes = 0;
  for (const object of objects) {
    if (!Number.isSafeInteger(object.size) || object.size < 0 ||
      !Number.isSafeInteger(totalBytes + object.size)) {
      throw new Error("远端备份对象字节汇总超过 JavaScript 安全整数范围。 ");
    }
    totalBytes += object.size;
  }
  return {
    objectCount: objects.length,
    totalBytes,
  };
}
