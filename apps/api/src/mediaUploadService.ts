import path from "node:path";
import type { Readable } from "node:stream";
import type { ResourceEntry } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { HttpError, uploadTooLarge, unsupportedMedia } from "./errors.js";
import type { ApiObservability, UploadMetricResult } from "./observability.js";
import type { ResourceService } from "./resourceService.js";
import {
  LocalObjectStorage,
  StorageSizeLimitError,
  type StagedBinary,
} from "./storage.js";
import {
  detectAndValidateMedia,
  normalizeUploadName,
  type UploadPolicy,
} from "./uploadPolicy.js";

export type MediaUploadLogger = {
  error(error: unknown, message: string): void;
};

// 媒体上传编排集中处理文件系统与数据库之间的发布和补偿，路由不自行拼接半套事务。
export class MediaUploadService {
  constructor(
    private readonly resources: ResourceService,
    private readonly storage: LocalObjectStorage,
    private readonly policy: UploadPolicy,
    private readonly observability?: ApiObservability,
  ) {}

  async upload(
    user: ApiUser,
    input: {
      parentId: string;
      name: string;
      stream: Readable;
      wasTruncated: () => boolean;
    },
    logger: MediaUploadLogger,
  ): Promise<ResourceEntry> {
    let staged: StagedBinary | null = null;
    let promoted = false;
    let databaseCommitted = false;
    try {
      const name = normalizeUploadName(input.name);
      await this.resources.prepareMediaUpload(user, input.parentId, name);

      // 暂存 key 沿用经过校验的展示扩展；实际类型在发布前仍必须由二进制签名确认。
      const requestedExtension = path.extname(name).slice(1).toLowerCase();
      const finalStorageKey = this.storage.createStorageKey(requestedExtension);
      staged = await this.storage.putStagedObject(
        finalStorageKey,
        input.stream,
        this.policy.maxUploadBytes,
      );
      // @fastify/multipart 可能只截断流而不抛错；必须在发布前检查其最终状态。
      if (input.wasTruncated()) {
        throw uploadTooLarge("媒体文件超过单文件上传限制。", {
          maxBytes: this.policy.maxUploadBytes,
        });
      }
      if (staged.size === 0) {
        throw unsupportedMedia("不能上传空媒体文件。");
      }
      const detected = await detectAndValidateMedia(name, staged.header);
      await this.storage.promoteStagedObject(staged);
      promoted = true;
      const resourceId = await this.resources.commitUploadedMedia(user, {
        parentId: input.parentId,
        name,
        mimeType: detected.mimeType,
        size: staged.size,
        storageKey: staged.finalStorageKey,
        checksum: staged.checksum,
        userQuotaBytes: this.policy.userQuotaBytes,
        platformQuotaBytes: this.policy.platformQuotaBytes,
      });
      databaseCommitted = true;
      // 成功字节必须在数据库提交后计入，配额或事务失败不能污染容量吞吐指标。
      this.observability?.recordUpload("success", staged.size);
      return await this.resources.getResource(user, resourceId);
    } catch (error) {
      // 失败发生在哪个阶段并不影响调用方：已产生的暂存/最终对象都要做幂等补偿。
      const cleanupKey = staged
        ? (promoted ? staged.finalStorageKey : staged.stagedStorageKey)
        : null;
      if (cleanupKey && !databaseCommitted) {
        await this.storage.deleteObject(cleanupKey).catch((cleanupError) => {
          this.observability?.recordCompensationFailure(
            promoted ? "final" : "staged",
          );
          logger.error(cleanupError, "清理失败媒体上传对象时发生错误");
        });
      }
      if (error instanceof StorageSizeLimitError) {
        this.observability?.recordUpload("too_large");
        throw uploadTooLarge("媒体文件超过单文件上传限制。", {
          maxBytes: this.policy.maxUploadBytes,
        });
      }
      // 数据库已提交后若 DTO 映射失败，HTTP 指标会记录 500；上传本身不能再重复记成失败。
      if (!databaseCommitted) {
        this.observability?.recordUpload(classifyUploadFailure(error));
      }
      throw error;
    }
  }
}

// 上传指标使用固定低基数类别，绝不把文件名、用户或错误文案作为 label。
function classifyUploadFailure(error: unknown): UploadMetricResult {
  if (!(error instanceof HttpError)) return "internal";
  if (error.code === "upload_too_large") return "too_large";
  if (error.code === "unsupported_media") return "unsupported_media";
  if (error.code === "bad_request") return "validation";
  if (error.code === "storage_quota_exceeded") return "quota";
  if (error.code === "forbidden" || error.code === "permission_scope_violation") {
    return "forbidden";
  }
  if (error.code === "conflict") return "conflict";
  return "internal";
}
