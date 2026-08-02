import type { PrismaClient, ResourceType } from "@prisma/client";
import type {
  StorageOrphanCategory,
  SystemDiagnosticAlert,
  SystemDiagnostics,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { forbidden } from "./errors.js";
import type { HealthService } from "./healthService.js";
import type { MaintenanceCoordinator } from "./maintenanceCoordinator.js";
import type { ObjectLifecycleService } from "./objectLifecycleService.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import type { ObjectStorage } from "./objectStorage.js";
import type { UploadPolicy } from "./uploadPolicy.js";

// 统计结果始终补齐所有固定类别，空类别也返回 0，前端无需处理缺失键。
const RESOURCE_TYPES: ResourceType[] = [
  "folder",
  "project",
  "annotation_file",
  "media_file",
];
const ORPHAN_CATEGORIES: StorageOrphanCategory[] = [
  "staged_binary",
  "orphan_binary",
  "unreferenced_file",
  "missing_binary",
];

// 系统诊断聚合只读运行信息；权限判断和告警规则都留在服务端，前端只负责展示。
export class SystemDiagnosticsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly storage: Pick<ObjectStorage, "listStoredObjects">,
    private readonly objectLifecycle: ObjectLifecycleService,
    private readonly health: HealthService,
    private readonly maintenance: MaintenanceCoordinator,
    private readonly policy: UploadPolicy,
  ) {}

  async getDiagnostics(user: ApiUser): Promise<SystemDiagnostics> {
    if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以查看系统诊断。");
    }

    // 各统计互不写入也不需要一致事务快照，并行读取可避免管理页串行等待十余次数据库往返。
    const [
      health,
      activeResources,
      trashedResources,
      resourcesByType,
      platformUsage,
      accountUsage,
      fileObjects,
      mediaFiles,
      annotationFiles,
      recoverySnapshots,
      jobGroups,
      diskObjects,
      orphanReport,
      recentOperations,
      maintenance,
    ] = await Promise.all([
      this.health.getReadiness(),
      this.prisma.resourceEntry.count({ where: { trashedAt: null } }),
      this.prisma.resourceEntry.count({ where: { trashedAt: { not: null } } }),
      this.prisma.resourceEntry.groupBy({
        by: ["type"],
        where: { trashedAt: null },
        _count: { _all: true },
      }),
      this.prisma.fileObject.aggregate({ _sum: { size: true } }),
      this.prisma.fileObject.aggregate({
        where: { ownerUserId: user.id },
        _sum: { size: true },
      }),
      this.prisma.fileObject.count(),
      this.prisma.mediaFile.count(),
      this.prisma.annotationFile.count(),
      this.prisma.annotationRecoverySnapshot.count(),
      this.prisma.processingJob.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.storage.listStoredObjects(),
      this.objectLifecycle.inspect(user),
      this.prisma.auditLog.findMany({
        where: {
          action: { in: ["media_upload", "storage_orphan_cleanup"] },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { action: true, detail: true, createdAt: true },
      }),
      this.maintenance.getStatus(user),
    ]);

    const byType = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, 0])) as
      Record<ResourceType, number>;
    for (const group of resourcesByType) byType[group.type] = group._count._all;

    const jobs = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const group of jobGroups) jobs[group.status] = group._count._all;

    const issuesByCategory = Object.fromEntries(
      ORPHAN_CATEGORIES.map((category) => [category, 0]),
    ) as Record<StorageOrphanCategory, number>;
    for (const item of orphanReport.items) issuesByCategory[item.category] += 1;

    const finalObjects = diskObjects.filter((object) => !object.staged);
    const stagedObjects = diskObjects.filter((object) => object.staged);
    const capacity = {
      platformUsedBytes: platformUsage._sum.size ?? 0,
      platformQuotaBytes: this.policy.platformQuotaBytes,
      accountUsedBytes: accountUsage._sum.size ?? 0,
      accountQuotaBytes: this.policy.userQuotaBytes,
    };
    const cleanupEligibleCount = orphanReport.items.filter(
      (item) => item.cleanupEligible,
    ).length;

    // 告警阈值由服务端集中生成，避免不同管理员客户端对同一容量给出矛盾结论。
    const alerts = buildDiagnosticAlerts({
      health,
      capacity,
      issuesByCategory,
      cleanupEligibleCount,
      queuedJobs: jobs.queued,
      failedJobs: jobs.failed,
    });

    return {
      generatedAt: new Date().toISOString(),
      health,
      capacity,
      resources: {
        active: activeResources,
        trashed: trashedResources,
        byType,
        fileObjects,
        mediaFiles,
        annotationFiles,
        recoverySnapshots,
      },
      storage: {
        finalObjectCount: finalObjects.length,
        finalObjectBytes: sumObjectBytes(finalObjects),
        stagedObjectCount: stagedObjects.length,
        stagedObjectBytes: sumObjectBytes(stagedObjects),
        issuesByCategory,
        cleanupEligibleCount,
      },
      jobs,
      alerts,
      recentOperations: recentOperations.map((entry) => ({
        action: entry.action as "media_upload" | "storage_orphan_cleanup",
        createdAt: entry.createdAt.toISOString(),
        summary: summarizeOperation(entry.action, entry.detail),
      })),
      maintenance,
    };
  }
}

type AlertInput = Pick<SystemDiagnostics, "health" | "capacity"> & {
  issuesByCategory: Record<StorageOrphanCategory, number>;
  cleanupEligibleCount: number;
  queuedJobs: number;
  failedJobs: number;
};

// 容量、对象一致性和任务问题使用稳定 code，便于未来接告警系统而不解析中文文案。
function buildDiagnosticAlerts(input: AlertInput): SystemDiagnosticAlert[] {
  const alerts: SystemDiagnosticAlert[] = [];
  if (input.health.status === "unavailable") {
    alerts.push({
      code: "dependency_unavailable",
      severity: "critical",
      message: "数据库或对象存储当前不可用。",
    });
  }
  appendCapacityAlert(
    alerts,
    "platform_storage",
    "平台存储",
    input.capacity.platformUsedBytes,
    input.capacity.platformQuotaBytes,
  );
  appendCapacityAlert(
    alerts,
    "account_storage",
    "当前账号存储",
    input.capacity.accountUsedBytes,
    input.capacity.accountQuotaBytes,
  );
  if (input.issuesByCategory.missing_binary > 0) {
    alerts.push({
      code: "missing_binary",
      severity: "critical",
      message: `有 ${input.issuesByCategory.missing_binary} 个数据库文件缺少二进制对象，需人工恢复。`,
    });
  }
  if (input.cleanupEligibleCount > 0) {
    alerts.push({
      code: "cleanup_available",
      severity: "warning",
      message: `有 ${input.cleanupEligibleCount} 个超过宽限期的确定孤儿可清理。`,
    });
  }
  if (input.failedJobs > 0) {
    alerts.push({
      code: "failed_jobs",
      severity: "warning",
      message: `有 ${input.failedJobs} 个后端任务失败。`,
    });
  }
  if (input.queuedJobs > 20) {
    alerts.push({
      code: "job_backlog",
      severity: "warning",
      message: `有 ${input.queuedJobs} 个任务正在排队，可能存在积压。`,
    });
  }
  return alerts;
}

// 容量达到 80% 提醒、95% 升级为严重告警，阈值对平台和账号保持一致。
function appendCapacityAlert(
  alerts: SystemDiagnosticAlert[],
  code: string,
  label: string,
  used: number,
  quota: number,
) {
  const ratio = quota > 0 ? used / quota : 0;
  if (ratio < 0.8) return;
  alerts.push({
    code: `${code}_${ratio >= 0.95 ? "critical" : "warning"}`,
    severity: ratio >= 0.95 ? "critical" : "warning",
    message: `${label}已使用 ${Math.round(ratio * 100)}%。`,
  });
}

// 对象字节汇总只处理存储层安全摘要，不读取二进制内容。
function sumObjectBytes(objects: Array<{ size: number }>) {
  return objects.reduce((total, object) => total + object.size, 0);
}

// 运维事件只输出计数摘要，避免把 audit detail 中未来可能新增的内部标识直接送到浏览器。
function summarizeOperation(action: string, detail: unknown) {
  if (action === "media_upload") return "媒体上传已提交";
  if (!detail || typeof detail !== "object") return "对象孤儿清理已执行";
  const values = detail as Record<string, unknown>;
  const binaries = numberValue(values.deletedBinaryCount);
  const files = numberValue(values.deletedFileObjectCount);
  return `对象孤儿清理：删除 ${binaries} 个二进制、${files} 条文件元数据`;
}

// 审计 detail 是未知 JSON；摘要只接受有限数值并安全回退为零。
function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
