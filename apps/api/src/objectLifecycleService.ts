import type { PrismaClient } from "@prisma/client";
import type {
  StorageOrphanCleanupResult,
  StorageOrphanReport,
  StorageOrphanSummary,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { forbidden } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import type { ObjectStorage } from "./objectStorage.js";
import type { UploadPolicy } from "./uploadPolicy.js";

// 对象生命周期服务只处理“确定无引用且超过宽限期”的孤儿；缺失二进制只报告，不静默删学术元数据。
export class ObjectLifecycleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly storage: Pick<ObjectStorage, "listStoredObjects" | "deleteObject">,
    private readonly policy: UploadPolicy,
  ) {}

  async inspect(user: ApiUser, now = new Date()): Promise<StorageOrphanReport> {
    this.assertAdministrator(user);
    const cutoff = new Date(now.getTime() - this.policy.orphanGraceMs);
    const [diskObjects, files, analysisAssets, alignmentArtifacts, trainingArtifacts] =
      await Promise.all([
        this.storage.listStoredObjects(),
        this.prisma.fileObject.findMany({
          include: {
            _count: {
              select: {
                mediaFiles: true,
                alignmentTrainingInputs: true,
              },
            },
          },
        }),
        this.prisma.mediaAnalysisAsset.findMany({
          select: {
            id: true,
            storageKey: true,
            size: true,
            kind: true,
            preset: true,
            level: true,
            tileIndex: true,
            createdAt: true,
          },
        }),
        this.prisma.alignmentArtifact.findMany({
          select: {
            id: true,
            storageKey: true,
            size: true,
            kind: true,
            createdAt: true,
          },
        }),
        this.prisma.alignmentTrainingPackageArtifact.findMany({
          select: {
            id: true,
            storageKey: true,
            size: true,
            exportId: true,
            createdAt: true,
          },
        }),
      ]);
    const filesByKey = new Map(files.map((file) => [file.storageKey, file]));
    const analysisAssetsByKey = new Map(
      analysisAssets.map((asset) => [asset.storageKey, asset]),
    );
    const alignmentArtifactsByKey = new Map(
      alignmentArtifacts.map((artifact) => [artifact.storageKey, artifact]),
    );
    const trainingArtifactsByKey = new Map(
      trainingArtifacts.map((artifact) => [artifact.storageKey, artifact]),
    );
    const diskKeys = new Set(diskObjects
      .filter((object) => !object.staged)
      .map((object) => object.storageKey));
    const summaries: StorageOrphanSummary[] = [];

    // 最终对象可能由上传文件、分析瓦片、对齐预测或不可变训练包引用；任一数据库事实都必须阻止孤儿清理。
    for (const object of diskObjects) {
      const category = object.staged
        ? "staged_binary"
        : filesByKey.has(object.storageKey) ||
            analysisAssetsByKey.has(object.storageKey) ||
            alignmentArtifactsByKey.has(object.storageKey) ||
            trainingArtifactsByKey.has(object.storageKey)
          ? null
          : "orphan_binary";
      if (!category) continue;
      summaries.push({
        category,
        storageKey: object.storageKey,
        size: object.size,
        createdAt: object.modifiedAt.toISOString(),
        cleanupEligible: object.modifiedAt < cutoff,
      });
    }

    // 训练输入冻结后会长期引用原始上传对象；只要媒体或训练样本任一引用存在，就不能按孤儿清理。
    for (const file of files) {
      const hasDatabaseReference = file._count.mediaFiles > 0 ||
        file._count.alignmentTrainingInputs > 0;
      if (!hasDatabaseReference) {
        summaries.push({
          category: "unreferenced_file",
          fileId: file.id,
          name: file.name,
          storageKey: file.storageKey,
          size: Number(file.size),
          createdAt: file.createdAt.toISOString(),
          cleanupEligible: file.createdAt < cutoff,
        });
      } else if (!diskKeys.has(file.storageKey)) {
        summaries.push({
          category: "missing_binary",
          fileId: file.id,
          name: file.name,
          storageKey: file.storageKey,
          size: Number(file.size),
          createdAt: file.createdAt.toISOString(),
          cleanupEligible: false,
        });
      }
    }

    // 分析资产是可再生数据，但数据库事实仍需诚实报告缺失对象，不能把缺失悄悄当成正常缓存淘汰。
    for (const asset of analysisAssets) {
      if (diskKeys.has(asset.storageKey)) continue;
      summaries.push({
        category: "missing_binary",
        analysisAssetId: asset.id,
        name: `${asset.kind}/${asset.preset}/L${asset.level}/T${asset.tileIndex}`,
        storageKey: asset.storageKey,
        size: Number(asset.size),
        createdAt: asset.createdAt.toISOString(),
        cleanupEligible: false,
      });
    }
    // 对齐 prediction 既可能供在线应用，也可能被训练冻结引用；缺失时只能报告，绝不能当孤儿清理。
    for (const artifact of alignmentArtifacts) {
      if (diskKeys.has(artifact.storageKey)) continue;
      summaries.push({
        category: "missing_binary",
        alignmentArtifactId: artifact.id,
        name: `强制对齐 ${artifact.kind}`,
        storageKey: artifact.storageKey,
        size: Number(artifact.size),
        createdAt: artifact.createdAt.toISOString(),
        cleanupEligible: false,
      });
    }
    // 训练包是不可再生研究交付物；对象缺失只报告，不删除或重建数据库 manifest。
    for (const artifact of trainingArtifacts) {
      if (diskKeys.has(artifact.storageKey)) continue;
      summaries.push({
        category: "missing_binary",
        alignmentTrainingArtifactId: artifact.id,
        name: `训练包 ${artifact.exportId}`,
        storageKey: artifact.storageKey,
        size: Number(artifact.size),
        createdAt: artifact.createdAt.toISOString(),
        cleanupEligible: false,
      });
    }
    return {
      generatedAt: now.toISOString(),
      graceMs: this.policy.orphanGraceMs,
      items: summaries,
    };
  }

  async cleanup(user: ApiUser): Promise<StorageOrphanCleanupResult> {
    const report = await this.inspect(user);
    const eligible = report.items.filter((item) => item.cleanupEligible);
    let deletedBinaryCount = 0;
    let deletedFileObjectCount = 0;

    // 文件系统孤儿可直接幂等删除；它们没有数据库身份，下一次扫描可重试失败项。
    for (const item of eligible) {
      if (item.category === "orphan_binary" || item.category === "staged_binary") {
        await this.storage.deleteObject(item.storageKey);
        deletedBinaryCount += 1;
      }
    }

    // 删除前同时复核媒体和训练输入引用，防止扫描完成后新冻结的训练样本被误删来源对象。
    for (const item of eligible) {
      if (item.category !== "unreferenced_file" || !item.fileId) continue;
      const deleted = await this.prisma.fileObject.deleteMany({
        where: {
          id: item.fileId,
          mediaFiles: { none: {} },
          alignmentTrainingInputs: { none: {} },
        },
      });
      if (deleted.count === 0) continue;
      deletedFileObjectCount += 1;
      await this.storage.deleteObject(item.storageKey);
      deletedBinaryCount += 1;
    }

    await this.prisma.auditLog.create({
      data: {
        action: "storage_orphan_cleanup",
        actorUserId: user.id,
        detail: {
          inspectedCount: report.items.length,
          eligibleCount: eligible.length,
          deletedBinaryCount,
          deletedFileObjectCount,
        },
      },
    });
    return {
      inspectedCount: report.items.length,
      eligibleCount: eligible.length,
      deletedBinaryCount,
      deletedFileObjectCount,
    };
  }

  private assertAdministrator(user: ApiUser) {
    if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以审计和清理对象存储。");
    }
  }
}
