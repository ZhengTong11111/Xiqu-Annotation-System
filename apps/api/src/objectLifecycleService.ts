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
    const [diskObjects, files] = await Promise.all([
      this.storage.listStoredObjects(),
      this.prisma.fileObject.findMany({
        include: { _count: { select: { mediaFiles: true } } },
      }),
    ]);
    const filesByKey = new Map(files.map((file) => [file.storageKey, file]));
    const diskKeys = new Set(diskObjects
      .filter((object) => !object.staged)
      .map((object) => object.storageKey));
    const summaries: StorageOrphanSummary[] = [];

    // 磁盘扫描区分过期暂存和没有 FileObject 的最终对象，宽限期内对象只报告而不允许 cleanup。
    for (const object of diskObjects) {
      const category = object.staged
        ? "staged_binary"
        : filesByKey.has(object.storageKey)
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

    // 数据库对象没有媒体引用时可清理；引用存在但磁盘缺失时只产生恢复诊断。
    for (const file of files) {
      if (file._count.mediaFiles === 0) {
        summaries.push({
          category: "unreferenced_file",
          fileId: file.id,
          name: file.name,
          storageKey: file.storageKey,
          size: file.size,
          createdAt: file.createdAt.toISOString(),
          cleanupEligible: file.createdAt < cutoff,
        });
      } else if (!diskKeys.has(file.storageKey)) {
        summaries.push({
          category: "missing_binary",
          fileId: file.id,
          name: file.name,
          storageKey: file.storageKey,
          size: file.size,
          createdAt: file.createdAt.toISOString(),
          cleanupEligible: false,
        });
      }
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

    // 无引用 FileObject 在事务内再次复核引用数，防止使用过期 dry-run 结论删除后来被引用的对象。
    for (const item of eligible) {
      if (item.category !== "unreferenced_file" || !item.fileId) continue;
      const deleted = await this.prisma.fileObject.deleteMany({
        where: { id: item.fileId, mediaFiles: { none: {} } },
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
    if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以审计和清理对象存储。");
    }
  }
}
