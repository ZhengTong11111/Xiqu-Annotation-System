import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ObjectStorage, StagedBinary } from "../objectStorage.js";

const PROBE_CONTENT = Buffer.from("xiqu-remote-storage-capability-check-v1", "utf8");
const PROBE_RANGE = { start: 5, end: 17 } as const;

// 单项检查结果保持有界且不携带对象内容，便于把脱敏 JSON 保存为部署验收证据。
export type RemoteStorageCapabilityCheckItem = {
  name: string;
  passed: true;
};

// 成功报告只公开安全后端描述和能力结论；凭据只存在于存储适配器内部。
export type RemoteStorageCapabilityReport = {
  format: "xiqu-remote-storage-capability-check";
  version: 1;
  startedAt: string;
  completedAt: string;
  backend: ReturnType<ObjectStorage["describeBackend"]>;
  passed: true;
  cleaned: true;
  checks: RemoteStorageCapabilityCheckItem[];
};

// 远端能力检查只依赖稳定对象存储端口，因此同一套流程可用于 AWS、MinIO 和协议测试替身。
export async function checkRemoteStorageCapabilities(
  storage: ObjectStorage,
  now: () => Date = () => new Date(),
): Promise<RemoteStorageCapabilityReport> {
  const startedAt = now().toISOString();
  const probeRoot = `.acceptance/${randomUUID()}`;
  const finalStorageKey = `${probeRoot}/probe.bin`;
  const checksum = createHash("sha256").update(PROBE_CONTENT).digest("hex");
  const checks: RemoteStorageCapabilityCheckItem[] = [];
  let staged: StagedBinary | undefined;
  let operationError: unknown;

  try {
    // readiness 单独执行，能够把 bucket 访问问题与后续对象级权限问题区分开。
    await storage.checkReadiness();
    recordPassed(checks, "bucket_readiness");

    // staged 上传同时验证流式写入、大小、摘要和适配器返回的发布合同。
    staged = await storage.putStagedObject(
      finalStorageKey,
      Readable.from([PROBE_CONTENT]),
      PROBE_CONTENT.length,
    );
    assertEqual(staged.finalStorageKey, finalStorageKey, "暂存对象返回了错误的 final key。");
    assertEqual(staged.size, PROBE_CONTENT.length, "暂存对象大小与探针内容不一致。");
    assertEqual(staged.checksum, checksum, "暂存对象摘要与探针内容不一致。");
    recordPassed(checks, "staged_upload");

    // HEAD 与 LIST 都必须看见暂存对象，避免只验证写入却遗漏巡检所需权限。
    assertEqual(
      await storage.objectExists(staged.stagedStorageKey),
      true,
      "HEAD 未找到刚上传的暂存对象。",
    );
    recordPassed(checks, "staged_head");
    assertListed(await storage.listStoredObjects(), staged.stagedStorageKey);
    recordPassed(checks, "staged_list");

    // promote 覆盖 server-side copy 和暂存对象删除，发布后只能保留 final 对象。
    await storage.promoteStagedObject(staged);
    assertEqual(
      await storage.objectExists(staged.stagedStorageKey),
      false,
      "发布后暂存对象仍然存在。",
    );
    assertEqual(
      await storage.objectExists(finalStorageKey),
      true,
      "发布后 final 对象不存在。",
    );
    recordPassed(checks, "server_side_publish");

    // 完整 GET 与 Range GET 分别覆盖恢复下载和媒体/协议分段读取能力。
    const downloaded = await readBoundedStream(
      await storage.getObjectStream(finalStorageKey),
      PROBE_CONTENT.length,
    );
    assertEqual(downloaded.equals(PROBE_CONTENT), true, "完整 GET 内容校验失败。");
    recordPassed(checks, "full_read");
    const ranged = await readBoundedStream(
      await storage.getObjectStream(finalStorageKey, PROBE_RANGE),
      PROBE_RANGE.end - PROBE_RANGE.start + 1,
    );
    assertEqual(
      ranged.equals(PROBE_CONTENT.subarray(PROBE_RANGE.start, PROBE_RANGE.end + 1)),
      true,
      "Range GET 内容校验失败。",
    );
    recordPassed(checks, "range_read");

    // 正常路径主动删除 final，并用 LIST/HEAD 证明探针命名空间没有残留。
    await storage.deleteObject(finalStorageKey);
    assertEqual(await storage.objectExists(finalStorageKey), false, "DELETE 后 final 对象仍然存在。");
    assertProbeRootEmpty(await storage.listStoredObjects(), probeRoot);
    recordPassed(checks, "delete_and_verify_empty");
  } catch (error) {
    operationError = error;
  }

  // finally 等价的补偿阶段重复删除两个可能 key；S3 DeleteObject 幂等，因此成功和失败路径都可安全执行。
  const cleanupErrors = await cleanupProbeObjects(storage, [
    staged?.stagedStorageKey,
    finalStorageKey,
  ]);
  if (operationError !== undefined || cleanupErrors.length > 0) {
    const errors = operationError === undefined
      ? cleanupErrors
      : [operationError, ...cleanupErrors];
    throw new AggregateError(errors, "远端对象存储能力检查失败，已尝试清理探针对象。");
  }

  return {
    format: "xiqu-remote-storage-capability-check",
    version: 1,
    startedAt,
    completedAt: now().toISOString(),
    backend: storage.describeBackend(),
    passed: true,
    cleaned: true,
    checks,
  };
}

// 成功项由统一 helper 写入，报告不会混入 SDK 响应或动态对象 key。
function recordPassed(
  checks: RemoteStorageCapabilityCheckItem[],
  name: string,
) {
  checks.push({ name, passed: true });
}

// 协议断言只抛出人工可读的固定消息，避免把远端响应或秘密值拼进错误文本。
function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(message);
}

// LIST 结果必须包含指定逻辑 key；大小和修改时间由适配器本身负责结构校验。
function assertListed(
  objects: Awaited<ReturnType<ObjectStorage["listStoredObjects"]>>,
  expectedKey: string,
) {
  if (!objects.some(({ storageKey }) => storageKey === expectedKey)) {
    throw new Error("LIST 未找到刚上传的暂存对象。");
  }
}

// 验收结束只检查本次 UUID 根，不能要求整个备份 prefix 为空。
function assertProbeRootEmpty(
  objects: Awaited<ReturnType<ObjectStorage["listStoredObjects"]>>,
  probeRoot: string,
) {
  if (objects.some(({ storageKey }) => storageKey.startsWith(`${probeRoot}/`))) {
    throw new Error("验收探针目录仍有对象残留。");
  }
}

// 小型探针仍设置严格读取上限，异常服务不能借能力检查向进程持续灌入数据。
async function readBoundedStream(stream: Readable, expectedBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > expectedBytes) {
      stream.destroy();
      throw new Error("对象读取超过预期探针大小。");
    }
    chunks.push(buffer);
  }
  if (totalBytes !== expectedBytes) {
    throw new Error("对象读取长度与预期探针大小不一致。");
  }
  return Buffer.concat(chunks);
}

// 两个逻辑 key 独立补偿，确保一个删除失败不会阻止另一个对象的清理尝试。
async function cleanupProbeObjects(
  storage: ObjectStorage,
  storageKeys: Array<string | undefined>,
) {
  const errors: unknown[] = [];
  const uniqueKeys = [...new Set(storageKeys.filter((key): key is string => Boolean(key)))];
  for (const storageKey of uniqueKeys) {
    try {
      await storage.deleteObject(storageKey);
    } catch (error) {
      errors.push(new Error(`清理验收探针对象失败：${safeErrorMessage(error)}`));
    }
  }
  return errors;
}

// 错误归一化只保留普通 message，禁止序列化 SDK 元数据、请求对象或环境配置。
function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知对象存储错误";
}
