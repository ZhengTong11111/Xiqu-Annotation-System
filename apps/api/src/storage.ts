import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type StoredBinary = {
  storageKey: string;
  checksum: string;
  size: number;
};

export class LocalObjectStorage {
  private readonly rootDir: string;

  constructor(rootDir = process.env.XIQU_STORAGE_ROOT ?? "./data/storage") {
    this.rootDir = path.resolve(rootDir);
  }

  createStorageKey(originalName: string) {
    const extension = path.extname(originalName).slice(0, 24);
    return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
  }

  async putObject(storageKey: string, stream: Readable): Promise<StoredBinary> {
    const targetPath = this.resolveStoragePath(storageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });

    const hash = createHash("sha256");
    let size = 0;
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(stream, hashingStream, createWriteStream(targetPath));
    return {
      storageKey,
      checksum: hash.digest("hex"),
      size,
    };
  }

  getObjectStream(storageKey: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolveStoragePath(storageKey), range);
  }

  private resolveStoragePath(storageKey: string) {
    const normalized = path.normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, "");
    const targetPath = path.resolve(this.rootDir, normalized);
    if (!targetPath.startsWith(this.rootDir)) {
      throw new Error("非法文件存储路径。");
    }
    return targetPath;
  }
}
