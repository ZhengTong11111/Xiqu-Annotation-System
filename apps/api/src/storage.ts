import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MEDIA_HEADER_BYTES = 8_192;

export type StagedBinary = {
  finalStorageKey: string;
  stagedStorageKey: string;
  checksum: string;
  size: number;
  header: Uint8Array;
};

export type StoredObjectSummary = {
  storageKey: string;
  size: number;
  modifiedAt: Date;
  staged: boolean;
};

export class StorageSizeLimitError extends Error {}

export class LocalObjectStorage {
  private readonly rootDir: string;

  constructor(rootDir = process.env.XIQU_STORAGE_ROOT ?? "./data/storage") {
    this.rootDir = path.resolve(rootDir);
  }

  // 最终 key 不再复用原文件扩展名，扩展由签名检测通过后统一传入。
  createStorageKey(extension: string) {
    const safeExtension = /^[a-z0-9]{1,12}$/.test(extension)
      ? `.${extension}`
      : "";
    return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${safeExtension}`;
  }

  // 上传先写同目录暂存对象；流中同时完成限字节、checksum 和签名头捕获。
  async putStagedObject(
    finalStorageKey: string,
    stream: Readable,
    maxBytes: number,
  ): Promise<StagedBinary> {
    const stagedStorageKey = `${finalStorageKey}.upload-${randomUUID()}`;
    const targetPath = this.resolveStoragePath(stagedStorageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });

    const hash = createHash("sha256");
    const headerChunks: Buffer[] = [];
    let headerSize = 0;
    let size = 0;
    const validationStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new StorageSizeLimitError("上传文件超过单文件限制。"));
          return;
        }
        hash.update(chunk);
        if (headerSize < MEDIA_HEADER_BYTES) {
          const remaining = MEDIA_HEADER_BYTES - headerSize;
          const headerChunk = chunk.subarray(0, remaining);
          headerChunks.push(headerChunk);
          headerSize += headerChunk.length;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, validationStream, createWriteStream(targetPath, {
        flags: "wx",
      }));
    } catch (error) {
      // 流中断或超限都可能留下半文件；失败返回前必须完成幂等清理。
      await rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      finalStorageKey,
      stagedStorageKey,
      checksum: hash.digest("hex"),
      size,
      header: Buffer.concat(headerChunks),
    };
  }

  // 暂存与最终对象位于同一文件系统，rename 提供不会暴露半文件的原子发布边界。
  async promoteStagedObject(staged: StagedBinary) {
    await rename(
      this.resolveStoragePath(staged.stagedStorageKey),
      this.resolveStoragePath(staged.finalStorageKey),
    );
  }

  getObjectStream(storageKey: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolveStoragePath(storageKey), range);
  }

  async objectExists(storageKey: string) {
    try {
      const metadata = await stat(this.resolveStoragePath(storageKey));
      return metadata.isFile();
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  async deleteObject(storageKey: string) {
    await rm(this.resolveStoragePath(storageKey), { force: true });
  }

  // readiness 只验证根目录可读写，不递归扫描对象，避免高频探针随资产数量变慢。
  async checkReadiness() {
    await mkdir(this.rootDir, { recursive: true });
    const metadata = await stat(this.rootDir);
    if (!metadata.isDirectory()) {
      throw new Error("对象存储根位置不是目录。");
    }
    await access(this.rootDir, constants.R_OK | constants.W_OK);
  }

  // 生命周期审计只返回安全相对 key；符号链接不跟随，避免越过存储根目录。
  async listStoredObjects(): Promise<StoredObjectSummary[]> {
    const objects: StoredObjectSummary[] = [];
    await mkdir(this.rootDir, { recursive: true });
    await this.walkDirectory(this.rootDir, objects);
    return objects;
  }

  private async walkDirectory(
    directory: string,
    output: StoredObjectSummary[],
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        await this.walkDirectory(absolutePath, output);
      } else if (metadata.isFile()) {
        const storageKey = path.relative(this.rootDir, absolutePath)
          .split(path.sep)
          .join("/");
        output.push({
          storageKey,
          size: metadata.size,
          modifiedAt: metadata.mtime,
          staged: storageKey.includes(".upload-"),
        });
      }
    }
  }

  private resolveStoragePath(storageKey: string) {
    const targetPath = path.resolve(this.rootDir, storageKey);
    const relative = path.relative(this.rootDir, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("非法文件存储路径。");
    }
    return targetPath;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
