import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { StorageSizeLimitError } from "../src/objectStorage.js";
import { S3ObjectStorage } from "../src/s3ObjectStorage.js";
import { publishRemoteBackupPackage } from "../src/backup/remoteBackupService.js";
import { verifyRemoteBackup } from "../src/backup/remoteBackupVerifier.js";

const TEST_ACCESS_KEY = "S3RVER";
const TEST_SECRET_KEY = "S3RVER";
const TEST_REGION = "us-east-1";
const TEST_BUCKET = "xiqu-storage-test";

// 文件级夹具由 before/after 管理，测试用例只操作各自隔离的逻辑 prefix。
let sharedFixture: Awaited<ReturnType<typeof createS3Fixture>>;

// 整个协议文件只启动一个 SeaweedFS，避免反复 SIGTERM 子进程造成测试运行器提前结束。
test.before(async () => {
  sharedFixture = await createS3Fixture();
});

// 所有场景结束后统一释放 SDK、服务进程和临时卷目录。
test.after(async () => {
  await sharedFixture.close();
});

// S3 协议夹具在随机端口和临时目录运行，每个测试进程结束时完整关闭并清理。
test("S3 适配器完成 staged、promote、Range、list 与 delete 全生命周期", async () => {
  const fixture = sharedFixture;
  const content = Buffer.from("0123456789-昆曲", "utf8");
  const staged = await runProtocolStep("upload staged object", () =>
    fixture.storage.putStagedObject(
      "2026-08-03/test.mp4",
      Readable.from([content]),
      1024,
    ), fixture.readLog);
  assert.equal(staged.size, content.length);
  assert.deepEqual(Buffer.from(staged.header), content);
  assert.equal((await runProtocolStep("list staged object", () =>
    fixture.storage.listStoredObjects())).length, 1);
  assert.equal(await runProtocolStep("head staged object", () =>
    fixture.storage.objectExists(staged.stagedStorageKey)), true);

  await runProtocolStep("promote staged object", () =>
    fixture.storage.promoteStagedObject(staged));
  assert.equal(await fixture.storage.objectExists(staged.stagedStorageKey), false);
  assert.equal(await fixture.storage.objectExists(staged.finalStorageKey), true);
  assert.equal(
    (await streamToBuffer(await fixture.storage.getObjectStream(staged.finalStorageKey))).toString("utf8"),
    content.toString("utf8"),
  );
  assert.equal(
    (await streamToBuffer(await fixture.storage.getObjectStream(
      staged.finalStorageKey,
      { start: 2, end: 5 },
    ))).toString("utf8"),
    "2345",
  );

  // prefix 外对象不属于本适配器命名空间，生命周期列表不得越界返回。
  await fixture.client.send(new PutObjectCommand({
    Bucket: TEST_BUCKET,
    Key: "outside/object.bin",
    Body: Buffer.from("outside"),
  }));
  const listed = await fixture.storage.listStoredObjects();
  assert.deepEqual(listed.map((object) => object.storageKey), [staged.finalStorageKey]);
  await fixture.storage.deleteObject(staged.finalStorageKey);
  assert.equal(await fixture.storage.objectExists(staged.finalStorageKey), false);
});

// 超限必须传播统一业务错误，并清除 staged/final；缺失 bucket 的 readiness 也必须真实失败。
test("S3 适配器超限失败不留对象且 readiness 反映 bucket 状态", async () => {
  const fixture = sharedFixture;
  await assert.rejects(
    fixture.storage.putStagedObject(
      "2026-08-03/too-large.mp4",
      Readable.from([Buffer.from("123456")]),
      3,
    ),
    StorageSizeLimitError,
  );
  assert.deepEqual(await fixture.storage.listStoredObjects(), []);
  await fixture.storage.checkReadiness();
  const missingBucketStorage = new S3ObjectStorage({
    ...fixture.options,
    bucket: "missing-bucket",
  });
  await assert.rejects(missingBucketStorage.checkReadiness());
});

// 远端备份协议在两个隔离 prefix 间真实传输，manifest-last 与 verifier 不依赖内存替身。
test("S3 隔离命名空间可发布并校验远端备份包", async () => {
  const fixture = sharedFixture;
  const workDirectory = await mkdtemp(path.join(tmpdir(), "xiqu-s3-backup-work-"));
  try {
    const sourceStorage = new S3ObjectStorage({ ...fixture.options, prefix: "platform-source" });
    const backupStorage = new S3ObjectStorage({ ...fixture.options, prefix: "platform-backups" });
    const media = Buffer.from("remote-media-content");
    const sourceObject = await sourceStorage.putStagedObject(
      "media/test.mp4",
      Readable.from([media]),
      media.length,
    );
    await sourceStorage.promoteStagedObject(sourceObject);
    const dumpPath = path.join(workDirectory, "database.dump");
    await writeFile(dumpPath, "remote-database-dump");
    const backupId = "xiqu-backup-2026-08-03T00-00-00-000Z-protocol";

    const result = await publishRemoteBackupPackage({
      databaseSummary: {
        resourceCount: 1,
        annotationFileCount: 0,
        mediaFileCount: 1,
        fileObjectCount: 1,
        fileObjects: [{
          storageKey: "media/test.mp4",
          size: media.length,
          checksum: sourceObject.checksum,
        }],
      },
      operator: {
        id: "admin-id",
        accountName: "admin",
        displayName: "系统管理员",
        roles: ["super_admin"],
      },
      sourceStorage,
      backupStorage,
      backupId,
      dumpPath,
      databaseIdentity: {
        host: "localhost",
        port: 54329,
        database: "xiqu_platform",
        schema: "public",
      },
      postgresToolVersion: "pg_dump (PostgreSQL) 16.14",
      maintenanceReason: "S3 协议测试",
    });
    assert.equal(result.manifest.objects.count, 1);
    assert.equal((await verifyRemoteBackup(backupStorage, backupId)).valid, true);
    assert.deepEqual(
      (await sourceStorage.listStoredObjects()).map((object) => object.storageKey),
      ["media/test.mp4"],
    );
    assert.equal(
      (await backupStorage.listStoredObjects()).some((object) =>
        object.storageKey === `${backupId}/manifest.json`),
      true,
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

// 夹具使用官方客户端创建 bucket，适配器和测试准备共享同一真实 S3 HTTP 协议边界。
async function createS3Fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "xiqu-seaweedfs-"));
  const ports = await reserveFreePorts(8);
  const endpoint = `http://127.0.0.1:${ports[3]}`;
  const server = spawn(process.env.XIQU_WEED_BIN ?? "weed", [
    "server",
    `-dir=${directory}`,
    "-ip=127.0.0.1",
    "-ip.bind=127.0.0.1",
    "-master.telemetry=false",
    // 测试卷只有小对象；降低卷上限并允许当前低空间开发机完成真实协议验证。
    "-master.volumeSizeLimitMB=10",
    "-volume.max=5",
    "-volume.minFreeSpace=0",
    `-master.port=${ports[0]}`,
    `-master.port.grpc=${ports[4]}`,
    `-volume.port=${ports[1]}`,
    `-volume.port.grpc=${ports[5]}`,
    `-filer.port=${ports[2]}`,
    `-filer.port.grpc=${ports[6]}`,
    "-s3",
    `-s3.port=${ports[3]}`,
    `-s3.port.grpc=${ports[7]}`,
  ], {
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: TEST_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: TEST_SECRET_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverDiagnostics = captureProcessLog(server);
  const options = {
    endpoint,
    region: TEST_REGION,
    bucket: TEST_BUCKET,
    accessKeyId: TEST_ACCESS_KEY,
    secretAccessKey: TEST_SECRET_KEY,
    forcePathStyle: true,
    prefix: "platform",
  } as const;
  const client = new S3Client({
    endpoint,
    region: TEST_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: TEST_ACCESS_KEY,
      secretAccessKey: TEST_SECRET_KEY,
    },
  });
  try {
    await waitForS3AndCreateBucket(client, server, serverDiagnostics);
  } catch (error) {
    // 启动失败也必须释放 SDK、子进程和临时目录，不能只在成功返回的 fixture.close 中清理。
    client.destroy();
    await stopProcess(server);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const storage = new S3ObjectStorage(options);
  return {
    client,
    options,
    readLog: serverDiagnostics.read,
    storage,
    // 先释放 SDK socket，再关闭协议服务并删除临时对象目录。
    close: async () => {
      client.destroy();
      await stopProcess(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// 随机空闲端口分别供 master/volume/filer/S3 及其 gRPC 服务使用，避免污染开发常用端口。
async function reserveFreePorts(count: number) {
  const reservations = Array.from({ length: count }, () => createServer());
  try {
    // 同时占住全部端口，避免逐个释放时操作系统立即复用同一个随机端口。
    await Promise.all(reservations.map(async (server) => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }));
    return reservations.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法分配 S3 测试端口。");
      return address.port;
    });
  } finally {
    // 只有收集完全部唯一端口后才统一释放，SeaweedFS 随后立即绑定。
    await Promise.all(reservations.map((server) => new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    })));
  }
}

// SeaweedFS 启动包含多个内部服务；轮询真实 CreateBucket，不能只用固定 sleep 猜测就绪时间。
async function waitForS3AndCreateBucket(
  client: S3Client,
  process: ChildProcess,
  diagnostics: ReturnType<typeof captureProcessLog>,
) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (diagnostics.getStartError()) {
      throw new Error(`无法启动 SeaweedFS：${diagnostics.read()}`);
    }
    if (process.exitCode !== null) {
      throw new Error(`SeaweedFS 提前退出（${process.exitCode}）：${diagnostics.read()}`);
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`SeaweedFS S3 未按时就绪：${String(lastError)}；${diagnostics.read()}`);
}

// 子进程日志只保留尾部诊断，避免测试失败时输出无界服务日志。
function captureProcessLog(process: ChildProcess) {
  let log = "";
  let startError: Error | null = null;
  const append = (chunk: Buffer) => {
    log = `${log}${chunk.toString("utf8")}`.slice(-8_000);
  };
  process.stdout?.on("data", append);
  process.stderr?.on("data", append);
  process.on("error", (error) => {
    startError = error;
    append(Buffer.from(error.message));
  });
  return {
    read: () => log,
    getStartError: () => startError,
  };
}

// 正常发送 SIGTERM；若服务没有及时退出，再使用 SIGKILL，避免测试留下后台进程。
async function stopProcess(process: ChildProcess) {
  if (process.exitCode !== null || process.pid === undefined) return;
  process.kill("SIGTERM");
  const exited = once(process, "exit");
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
  if (await Promise.race([exited.then(() => "exited" as const), timeout]) === "timeout") {
    process.kill("SIGKILL");
    await once(process, "exit");
  }
}

// 测试读取器只聚合小型夹具内容，生产下载仍由 Fastify 直接流式发送。
async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// 协议步骤失败时补充操作名称，同时用 cause 保留 SDK 原始错误和元数据。
async function runProtocolStep<T>(
  label: string,
  operation: () => Promise<T>,
  readLog?: () => string,
) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`S3 协议步骤失败：${label}${readLog ? `；${readLog()}` : ""}`, { cause: error });
  }
}
