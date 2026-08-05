import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Readable } from "node:stream";

// 大型媒体和 dump 使用流式 SHA-256，避免备份期间把完整文件读入内存。
export async function digestFile(filePath: string) {
  const digest = await digestReadable(createReadStream(filePath));
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size !== digest.size) {
    throw new Error(`文件在校验期间发生变化：“${filePath}”。`);
  }
  return digest;
}

// 远端或本地对象流共用同一 SHA-256 实现，业务校验不需要知道对象后端路径。
export async function digestReadable(stream: Readable) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

// SHA-256 字符串在读取外部 manifest 时需要严格校验，不能接受截断或其他算法结果。
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// 发布前显式同步文件内容，避免进程退出或断电后只留下已改名但尚未落盘的数据。
export async function syncFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// POSIX 目录 fsync 保障 rename 元数据耐久；Windows 不支持该调用时由文件系统自身承担目录提交。
export async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
