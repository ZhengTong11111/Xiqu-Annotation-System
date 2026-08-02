import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  StorageSizeLimitError,
  type ObjectReadRange,
  type ObjectStorage,
  type StagedBinary,
  type StoredObjectSummary,
} from "./objectStorage.js";

const MEDIA_HEADER_BYTES = 8_192;
const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

// S3 配置只包含适配器运行所需字段；凭据永远不进入后端描述、日志或业务 DTO。
export type S3ObjectStorageOptions = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix?: string;
};

// S3-compatible 适配器把数据库逻辑 key 映射到 bucket/prefix，并保持 staged publish 语义。
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly options: S3ObjectStorageOptions) {
    this.prefix = normalizePrefix(options.prefix);
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  // 描述只用于诊断和能力判断，不暴露 access key、secret 或签名信息。
  describeBackend() {
    const endpoint = this.options.endpoint ?? "aws";
    const scopedBucket = this.prefix
      ? `${this.options.bucket}/${this.prefix}`
      : this.options.bucket;
    return {
      kind: "remote" as const,
      provider: "s3-compatible",
      location: `${endpoint}/${scopedBucket}`,
    };
  }

  // 逻辑 key 延续本地日期/UUID 形状，切换后端不会改变数据库内容语义。
  createStorageKey(extension: string) {
    const safeExtension = /^[a-z0-9]{1,12}$/.test(extension)
      ? `.${extension}`
      : "";
    return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${safeExtension}`;
  }

  // 输入流一边计算业务摘要和签名头，一边交给 SDK multipart uploader，避免整文件驻留内存。
  async putStagedObject(
    finalStorageKey: string,
    stream: Readable,
    maxBytes: number,
  ): Promise<StagedBinary> {
    const safeFinalKey = validateLogicalKey(finalStorageKey);
    const stagedStorageKey = `${safeFinalKey}.upload-${randomUUID()}`;
    const remoteStagedKey = this.toRemoteKey(stagedStorageKey);
    const hash = createHash("sha256");
    const headerChunks: Buffer[] = [];
    let headerSize = 0;
    let size = 0;

    // Transform 是唯一字节计数点；业务上限在数据离开进程前生效。
    const validationStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new StorageSizeLimitError("上传文件超过单文件限制。"));
          return;
        }
        hash.update(chunk);
        if (headerSize < MEDIA_HEADER_BYTES) {
          const headerChunk = chunk.subarray(0, MEDIA_HEADER_BYTES - headerSize);
          headerChunks.push(headerChunk);
          headerSize += headerChunk.length;
        }
        callback(null, chunk);
      },
    });
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.options.bucket,
        Key: remoteStagedKey,
        Body: validationStream,
      },
      queueSize: 2,
      partSize: MIN_MULTIPART_PART_SIZE,
      leavePartsOnError: false,
    });

    const uploadPromise = upload.done();
    try {
      // pipeline 负责把源流错误传播给上传；SDK Promise 同时覆盖远端协议失败。
      await Promise.all([
        pipeline(stream, validationStream),
        uploadPromise,
      ]);
    } catch (error) {
      // SDK abort 与幂等删除共同清理 multipart/单对象残留，原始错误继续交给上传业务层分类。
      await upload.abort().catch(() => undefined);
      await uploadPromise.catch(() => undefined);
      await this.deleteObject(stagedStorageKey).catch(() => undefined);
      stream.destroy();
      validationStream.destroy();
      throw error;
    }
    return {
      finalStorageKey: safeFinalKey,
      stagedStorageKey,
      checksum: hash.digest("hex"),
      size,
      header: Buffer.concat(headerChunks),
    };
  }

  // S3 没有 rename；server-side copy 完整成功后再删 staged，final 不会暴露半对象。
  async promoteStagedObject(staged: StagedBinary) {
    const finalKey = this.toRemoteKey(staged.finalStorageKey);
    const stagedKey = this.toRemoteKey(staged.stagedStorageKey);
    await this.client.send(new CopyObjectCommand({
      Bucket: this.options.bucket,
      Key: finalKey,
      CopySource: encodeCopySource(this.options.bucket, stagedKey),
    }));
    await this.deleteObject(staged.stagedStorageKey);
  }

  // 远端响应建立后才返回 Node Readable，使认证/网络/404 在 Fastify 发送响应头前失败。
  async getObjectStream(storageKey: string, range?: ObjectReadRange) {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: this.toRemoteKey(storageKey),
      Range: range ? formatRange(range) : undefined,
    }));
    if (!(response.Body instanceof Readable)) {
      throw new Error("S3 对象响应不是可用的 Node.js 读取流。");
    }
    return response.Body;
  }

  // 只有明确的对象不存在响应返回 false；认证、网络和服务端故障必须继续上抛。
  async objectExists(storageKey: string) {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.options.bucket,
        Key: this.toRemoteKey(storageKey),
      }));
      return true;
    } catch (error) {
      if (isMissingS3Object(error)) return false;
      throw error;
    }
  }

  // DeleteObject 在 S3 中天然幂等，适合上传失败补偿和孤儿清理重试。
  async deleteObject(storageKey: string) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.options.bucket,
      Key: this.toRemoteKey(storageKey),
    }));
  }

  // readiness 只验证 bucket 可访问，不扫描对象或执行写入探针。
  async checkReadiness() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }

  // 生命周期审计通过官方 paginator 扫描完整 prefix，并只向业务层返回逻辑 key。
  async listStoredObjects(): Promise<StoredObjectSummary[]> {
    const objects: StoredObjectSummary[] = [];
    const paginator = paginateListObjectsV2(
      { client: this.client },
      { Bucket: this.options.bucket, Prefix: this.remotePrefix() },
    );
    for await (const page of paginator) {
      for (const object of page.Contents ?? []) {
        if (!object.Key || object.Size === undefined || !object.LastModified) {
          throw new Error("S3 对象列表缺少 key、size 或修改时间。");
        }
        const storageKey = this.fromRemoteKey(object.Key);
        objects.push({
          storageKey,
          size: object.Size,
          modifiedAt: object.LastModified,
          staged: storageKey.includes(".upload-"),
        });
      }
    }
    return objects;
  }

  // 所有远端命令共用一处 prefix 映射和逻辑 key 校验，防止不同方法形成越界差异。
  private toRemoteKey(storageKey: string) {
    const safeKey = validateLogicalKey(storageKey);
    return this.prefix ? `${this.prefix}/${safeKey}` : safeKey;
  }

  // 列表结果必须严格属于当前 prefix；异常服务响应不能越过租户根。
  private fromRemoteKey(remoteKey: string) {
    if (!this.prefix) return validateLogicalKey(remoteKey);
    const expectedPrefix = `${this.prefix}/`;
    if (!remoteKey.startsWith(expectedPrefix)) {
      throw new Error("S3 返回了当前存储前缀之外的对象。");
    }
    return validateLogicalKey(remoteKey.slice(expectedPrefix.length));
  }

  private remotePrefix() {
    return this.prefix ? `${this.prefix}/` : undefined;
  }
}

// prefix 只允许普通目录段，不接受绝对路径、反斜杠和父级跳转。
function normalizePrefix(prefix: string | undefined) {
  if (!prefix) return "";
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  validatePathSegments(normalized, "S3 对象前缀");
  return normalized;
}

// 数据库逻辑 key 必须是非空相对 POSIX 路径，所有适配器方法共享这个信任边界。
function validateLogicalKey(storageKey: string) {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("\\")) {
    throw new Error("非法 S3 对象 key。");
  }
  validatePathSegments(storageKey, "S3 对象 key");
  return storageKey;
}

// 路径段拒绝空值、点目录和 NUL，避免 prefix/key 规范化产生同名或越界对象。
function validatePathSegments(value: string, label: string) {
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error(`${label}包含非法路径段。`);
  }
}

// HTTP Range 使用闭区间；提前拒绝坏值，避免不同 S3 服务产生不一致解释。
function formatRange(range: ObjectReadRange) {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
    range.start < 0 || range.end < range.start) {
    throw new Error("非法对象读取范围。");
  }
  return `bytes=${range.start}-${range.end}`;
}

// CopySource 的 bucket/key 各段按 URI 规则编码，保留层级分隔符供 S3 解析。
function encodeCopySource(bucket: string, key: string) {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

// SDK 错误只在明确 404/NoSuchKey/NotFound 时解释为对象不存在。
function isMissingS3Object(error: unknown) {
  if (!(error instanceof Error)) return false;
  const metadata = "$metadata" in error
    ? (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
    : undefined;
  return metadata?.httpStatusCode === 404 || error.name === "NoSuchKey" || error.name === "NotFound";
}
