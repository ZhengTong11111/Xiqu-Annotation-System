import { Prisma, type PrismaClient } from "@prisma/client";
import {
  areProjectValuesEqual,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import type {
  CreateAnnotationRecoveryBackupRequest,
  ResourceCapability,
} from "@xiqu/shared";
import { createHash } from "node:crypto";
import { lockActiveAnnotationFileForWrite } from "./annotationFileWriteLock.js";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const RECOVERY_BACKUP_FOLDER_NAME = "backup";
const MAX_RECOVERY_BACKUP_FAILURE_COUNT = 10_000;
const MAX_RECOVERY_BACKUP_VALIDATION_ISSUES = 20;

export type AnnotationRecoveryBackupCreation = {
  backupResourceId: string;
  folderId: string;
  replayed: boolean;
};

/**
 * 连续保存失败的恢复副本使用独立服务边界：它只从源文件推导目标，不能退化为任意目录写入接口。
 */
export class AnnotationRecoveryBackupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async create(
    user: ApiUser,
    sourceResourceId: string,
    input: CreateAnnotationRecoveryBackupRequest<unknown>,
  ): Promise<AnnotationRecoveryBackupCreation> {
    await this.access.assertCapability(user, sourceResourceId, "write");
    const parsedPayload = parseCurrentProjectData(input.payload);
    if (!parsedPayload.success) {
      throw badRequest("恢复备份中的标注文档格式无效。", {
        issues: parsedPayload.issues.slice(0, MAX_RECOVERY_BACKUP_VALIDATION_ISSUES),
      });
    }
    this.assertRequestFacts(input);

    const backupResourceId = createRecoveryBackupResourceId(
      sourceResourceId,
      user.id,
      input.clientBackupId,
    );
    return this.prisma.$transaction(async (transaction) => {
      const sourceFile = await lockActiveAnnotationFileForWrite(
        transaction,
        this.access,
        user,
        sourceResourceId,
      );
      if (input.sourceRevision > sourceFile.revision) {
        throw conflict("恢复备份引用的源文件版本晚于服务器当前版本。", {
          expectedMaximumRevision: sourceFile.revision,
          receivedRevision: input.sourceRevision,
        });
      }
      const project = await this.findActiveOwningProject(transaction, sourceResourceId);

      // 稳定资源 id 把同一失败周期的响应丢失变成精确重放；payload 不同则拒绝模糊复用。
      const existing = await transaction.resourceEntry.findUnique({
        where: { id: backupResourceId },
        select: {
          id: true,
          type: true,
          ownerUserId: true,
          trashedAt: true,
          annotationFile: { select: { payload: true } },
          parent: {
            select: {
              id: true,
              parentId: true,
              type: true,
              name: true,
              archivedAt: true,
              trashedAt: true,
            },
          },
        },
      });
      if (existing) {
        if (
          existing.type !== "annotation_file" ||
          existing.ownerUserId !== user.id ||
          existing.trashedAt ||
          !existing.annotationFile ||
          !areProjectValuesEqual(existing.annotationFile.payload, parsedPayload.data) ||
          existing.parent?.parentId !== project.id ||
          existing.parent.type !== "folder" ||
          existing.parent.name.toLowerCase() !== RECOVERY_BACKUP_FOLDER_NAME ||
          existing.parent.archivedAt ||
          existing.parent.trashedAt
        ) {
          throw conflict("恢复备份幂等请求与已存在资源不一致，请重新触发备份。");
        }
        return { backupResourceId, folderId: existing.parent.id, replayed: true };
      }

      await lockParentNamespaces(transaction, [project.id]);
      let backupFolder = await transaction.resourceEntry.findFirst({
        where: {
          parentId: project.id,
          name: { equals: RECOVERY_BACKUP_FOLDER_NAME, mode: "insensitive" },
          trashedAt: null,
        },
        select: { id: true, type: true, archivedAt: true },
      });
      if (backupFolder && (backupFolder.type !== "folder" || backupFolder.archivedAt)) {
        throw conflict("项目中已存在不可复用的 backup 同名资源，请先重命名或恢复该资源。");
      }
      if (!backupFolder) {
        backupFolder = await transaction.resourceEntry.create({
          data: {
            parentId: project.id,
            type: "folder",
            name: RECOVERY_BACKUP_FOLDER_NAME,
            // 共享恢复目录归项目所有者，普通编辑者不能因触发备份而取得目录管理权。
            ownerUserId: project.ownerUserId,
          },
          select: { id: true, type: true, archivedAt: true },
        });
      }
      await this.ensureFolderReadable(
        transaction,
        backupFolder.id,
        project.ownerUserId,
        user,
      );
      await lockParentNamespaces(transaction, [backupFolder.id]);

      const createdAt = new Date();
      const source = await transaction.resourceEntry.findUniqueOrThrow({
        where: { id: sourceResourceId },
        select: { name: true },
      });
      const backupName = await availableRecoveryBackupName(
        transaction,
        backupFolder.id,
        source.name,
        user.accountName,
        createdAt,
      );
      await transaction.resourceEntry.create({
        data: {
          id: backupResourceId,
          parentId: backupFolder.id,
          type: "annotation_file",
          name: backupName,
          ownerUserId: user.id,
        },
      });
      // 恢复文件主实体显式顺序写入，保持事务原子且避免单连接上的 nested write 并发。
      await transaction.annotationFile.create({
        data: {
          resourceId: backupResourceId,
          payload: parsedPayload.data as Prisma.InputJsonValue,
          mediaResourceId: sourceFile.mediaResourceId,
          lastEditedBy: user.id,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "resource_create",
          actorUserId: user.id,
          resourceId: backupResourceId,
          detail: {
            type: "annotation_file",
            reason: "automatic_recovery_backup",
            sourceAnnotationFileId: sourceResourceId,
            sourceRevision: input.sourceRevision,
            serverRevision: sourceFile.revision,
            failureCount: input.failureCount,
            clientBackupId: input.clientBackupId,
          },
        },
      });
      return { backupResourceId, folderId: backupFolder.id, replayed: false };
    });
  }

  private assertRequestFacts(input: CreateAnnotationRecoveryBackupRequest<unknown>) {
    if (
      !Number.isInteger(input.sourceRevision) ||
      input.sourceRevision < 1 ||
      !Number.isInteger(input.failureCount) ||
      input.failureCount < 1 ||
      input.failureCount > MAX_RECOVERY_BACKUP_FAILURE_COUNT
    ) {
      throw badRequest("恢复备份的版本或失败次数无效。");
    }
    if (!isRecoveryBackupClientId(input.clientBackupId)) {
      throw badRequest("恢复备份的失败周期编号无效。");
    }
  }

  // 文件夹嵌套和项目嵌套均选择离源文件最近的活动 project，避免备份漂移到资源树根。
  private async findActiveOwningProject(
    transaction: Prisma.TransactionClient,
    sourceResourceId: string,
  ) {
    let currentId: string | null = sourceResourceId;
    const visited = new Set<string>();
    while (currentId) {
      if (visited.has(currentId)) throw conflict("资源目录存在循环，无法创建恢复备份。");
      visited.add(currentId);
      const current: {
        id: string;
        parentId: string | null;
        type: "folder" | "project" | "annotation_file" | "media_file";
        ownerUserId: string;
        archivedAt: Date | null;
        trashedAt: Date | null;
      } | null = await transaction.resourceEntry.findUnique({
        where: { id: currentId },
        select: {
          id: true,
          parentId: true,
          type: true,
          ownerUserId: true,
          archivedAt: true,
          trashedAt: true,
        },
      });
      if (!current || current.archivedAt || current.trashedAt) {
        throw notFound("源标注文件不在活动项目中。");
      }
      if (current.type === "project") return current;
      currentId = current.parentId;
    }
    throw conflict("源标注文件没有所属项目，无法创建项目恢复备份。");
  }

  private async ensureFolderReadable(
    transaction: Prisma.TransactionClient,
    folderId: string,
    folderOwnerUserId: string,
    user: ApiUser,
  ) {
    if (folderOwnerUserId === user.id || this.access.hasFullResourceAccess(user)) return;
    const effective = await this.access.getEffectivePermission(user, folderId, transaction);
    if (effective.capabilities.includes("read")) return;
    const direct = await transaction.resourcePermission.findUnique({
      where: { resourceId_userId: { resourceId: folderId, userId: user.id } },
    });
    const capabilities = [...new Set([
      ...(direct?.capabilities as ResourceCapability[] | undefined ?? []),
      "read" as const,
    ])];
    await transaction.resourcePermission.upsert({
      where: { resourceId_userId: { resourceId: folderId, userId: user.id } },
      update: { capabilities: this.access.toDatabaseCapabilities(capabilities) },
      create: {
        resourceId: folderId,
        userId: user.id,
        capabilities: this.access.toDatabaseCapabilities(capabilities),
        // 该直接授权只允许进入恢复目录，不向其中其他账号的备份传播额外能力。
        inheritToChildren: false,
        createdBy: user.id,
      },
    });
  }
}

async function lockParentNamespaces(
  transaction: Prisma.TransactionClient,
  parentIds: Array<string | null>,
) {
  const lockKeys = [...new Set(parentIds.map((id) =>
    `xiqu:resource-parent:${id ?? "<root>"}`))].sort();
  for (const lockKey of lockKeys) {
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock(hashtext(${lockKey}))
    `;
  }
}

async function availableRecoveryBackupName(
  transaction: Prisma.TransactionClient,
  parentId: string,
  sourceName: string,
  accountName: string,
  createdAt: Date,
) {
  const sourceStem = sourceName.toLowerCase().endsWith(".json")
    ? sourceName.slice(0, -5)
    : sourceName;
  const safeAccountName = accountName.replace(/[^A-Za-z0-9._-]+/g, "_") || "user";
  const timestamp = formatRecoveryBackupTimestamp(createdAt);
  const suffix = `.backup.${safeAccountName}.${timestamp}`;
  for (let index = 0; index < 1_000; index += 1) {
    const collisionSuffix = index === 0 ? "" : `-${index + 1}`;
    const stem = sourceStem.slice(
      0,
      Math.max(1, 180 - suffix.length - collisionSuffix.length - ".json".length),
    );
    const name = `${stem}${suffix}${collisionSuffix}.json`;
    const exists = await transaction.resourceEntry.findFirst({
      where: {
        parentId,
        name: { equals: name, mode: "insensitive" },
        trashedAt: null,
      },
      select: { id: true },
    });
    if (!exists) return validateResourceName(name);
  }
  throw conflict("无法生成可用的恢复备份文件名。");
}

function validateResourceName(value: string) {
  const name = value.trim();
  if (!name || name.length > 180 || /[\/\\\0]/.test(name)) {
    throw badRequest("资源名称不能为空、不能超过 180 字，且不能含路径分隔符。");
  }
  return name;
}

function isRecoveryBackupClientId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// 自定义 UUID v8 由服务端命名空间事实推导，便于请求响应丢失后安全重放同一资源创建。
function createRecoveryBackupResourceId(
  sourceResourceId: string,
  actorUserId: string,
  clientBackupId: string,
) {
  const bytes = createHash("sha256")
    .update("xiqu:annotation-recovery-backup:v1\0")
    .update(sourceResourceId)
    .update("\0")
    .update(actorUserId)
    .update("\0")
    .update(clientBackupId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatRecoveryBackupTimestamp(value: Date) {
  const compact = value.toISOString().replace(/[-:TZ.]/g, "");
  return `${compact.slice(0, 8)}-${compact.slice(8, 14)}-${compact.slice(14, 17)}`;
}
