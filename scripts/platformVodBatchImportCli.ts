#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import CredentialPackage from "@alicloud/credentials";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import VodPackage, {
  CreateUploadVideoRequest,
  GetVideoInfosRequest,
  RefreshUploadVideoRequest,
} from "@alicloud/vod20170321";
import { readBootstrapPasswordFromStdin } from "../apps/api/src/bootstrapAdminArguments.js";
import { prepareProjectForServer } from "../src/platform/platformProjectPayload.js";
import { normalizeImportedProjectFile } from "../src/utils/projectFile.js";
import {
  buildImportPlan,
  emptyImportState,
  executeImport,
  parseImportState,
  prepareManifest,
  type AnnotationBinding,
  type ImportState,
  type ImportStatePort,
  type ImportStateRow,
  type PlatformImportPort,
  type PlatformResource,
  type PreparedManifestRow,
  type VodImportPort,
  type VodUploadCheckpoint,
  type VodVideo,
  type VodVideoStatus,
} from "./platformVodBatchImportCore.js";

type CliCommand = {
  mode: "dry-run" | "execute";
  csvPath: string;
  baseUrl: string;
  accountName: string;
  region: string;
  statePath: string;
  planFingerprint: string | null;
  readyTimeoutMs: number;
  partSize: number;
  parallel: number;
};

type PlatformApiEnvelope<T> = { data: T } | { error: { code: string; message: string } };

type OssCheckpoint = {
  file: string;
  name: string;
  fileSize: number;
  partSize: number;
  uploadId: string;
  doneParts: Array<{ number: number; etag: string }>;
};

type OssClient = {
  multipartUpload(
    name: string,
    filePath: string,
    options: {
      parallel: number;
      partSize: number;
      timeout: number;
      checkpoint?: OssCheckpoint;
      progress: (percentage: number, checkpoint?: OssCheckpoint) => Promise<void>;
    },
  ): Promise<unknown>;
};

type OssConstructor = new (options: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  secure: boolean;
  timeout: number;
  retryMax: number;
}) => OssClient;

type UploadGrant = {
  videoId: string;
  uploadAddress: string;
  uploadAuth: string;
};

type UploadableManifestRow = PreparedManifestRow & {
  videoPath: string;
  videoSize: number;
  videoSha256: string;
  vodReferenceId: string;
};

type DecodedUploadAddress = {
  Endpoint: string;
  Bucket: string;
  FileName: string;
};

type DecodedUploadAuth = {
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
};

const require = createRequire(import.meta.url);
const Credential = (CredentialPackage as unknown as {
  default: typeof CredentialPackage;
}).default;
const VodClient = (VodPackage as unknown as {
  default: typeof VodPackage;
}).default;

class SafeCliError extends Error {}

async function run() {
  const command = parseArguments(process.argv.slice(2));
  const password = await readBootstrapPasswordFromStdin(process.stdin);
  if (!password) throw new SafeCliError("平台密码必须通过 stdin 提供。");

  const stateFile = await FileImportState.open(command.statePath, command.mode === "execute");
  try {
    const rows = await prepareManifest(command.csvPath, (value) =>
      prepareProjectForServer(normalizeImportedProjectFile(value).project));
    const platform = new HttpPlatformImportPort(command.baseUrl);
    await platform.login(command.accountName, password);
    const capabilities = await platform.getMediaProviderCapabilities();
    if (!capabilities.aliyunVod.enabled || capabilities.aliyunVod.region !== command.region) {
      throw new SafeCliError(
        `平台阿里云 VOD 区域不匹配：期望 ${command.region}，平台为 ${capabilities.aliyunVod.region ?? "未启用"}。`,
      );
    }
    const vod = new AliyunVodImportPort({
      region: command.region,
      readyTimeoutMs: command.readyTimeoutMs,
      partSize: command.partSize,
      parallel: command.parallel,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    const plan = await buildImportPlan({
      baseUrl: command.baseUrl,
      region: command.region,
      manifestPath: command.csvPath,
      statePath: command.statePath,
      rows,
      platform,
      vod,
      state: stateFile.current(),
    });

    if (command.mode === "dry-run") {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (plan.summary.blockedRowCount > 0) process.exitCode = 2;
      return;
    }
    if (command.planFingerprint !== plan.fingerprint) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      throw new SafeCliError(
        "计划 fingerprint 已变化；禁止执行。请重新 dry-run 并人工核对新计划。",
      );
    }
    if (plan.summary.blockedRowCount > 0) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      throw new SafeCliError("计划包含阻断项；未执行任何资源创建。",
      );
    }

    const result = await executeImport({
      rows,
      platform,
      vod,
      state: stateFile,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      planFingerprint: plan.fingerprint,
      completedRowCount: result.completedRows.length,
      completedRows: result.completedRows,
      statePath: path.resolve(command.statePath),
    }, null, 2)}\n`);
  } finally {
    await stateFile.close();
  }
}

class HttpPlatformImportPort implements PlatformImportPort {
  private accessToken: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async login(accountName: string, password: string) {
    const response = await this.request<{
      accessToken: string;
      user: { roles: string[] };
    }>("/auth/login", {
      method: "POST",
      body: { accountName, password },
      authenticated: false,
    });
    if (!response.user.roles.some((role) => role === "admin" || role === "super_admin")) {
      throw new SafeCliError("批量标注导入要求 admin 或 super_admin 账号。");
    }
    this.accessToken = response.accessToken;
  }

  getMediaProviderCapabilities() {
    return this.request<{
      aliyunVod: { enabled: boolean; region: string | null };
    }>("/media-providers");
  }

  listRootProjects() {
    return this.listResources({ view: "all_projects" });
  }

  listChildren(parentId: string) {
    return this.listResources({ parentId, view: "children" });
  }

  async getAnnotationBinding(annotationResourceId: string): Promise<AnnotationBinding> {
    const response = await this.requestAllowingError<{
      primaryMediaResourceId: string;
    }>(`/annotation-files/${encodeURIComponent(annotationResourceId)}/audio-playback-options`);
    if (response.ok) {
      return { status: "bound", mediaResourceId: response.data.primaryMediaResourceId };
    }
    if (response.status === 400 && response.error.message === "标注文件尚未关联主媒体。") {
      return { status: "unbound" };
    }
    throw new SafeCliError(`读取标注媒体绑定失败：${response.error.code}。`);
  }

  createProject(name: string) {
    return this.request<PlatformResource>("/resources", {
      method: "POST",
      body: { parentId: null, type: "project", name },
    });
  }

  createVodMedia(input: { parentId: string; name: string; videoId: string }) {
    return this.request<PlatformResource>("/media-files/aliyun-vod", {
      method: "POST",
      body: input,
    });
  }

  createAnnotation(input: {
    parentId: string;
    name: string;
    payload: unknown;
    mediaResourceId: string;
  }) {
    return this.request<{ resource: PlatformResource }>("/annotation-files/batch-import-item", {
      method: "POST",
      body: input,
    });
  }

  private async listResources(filters: { view: string; parentId?: string }) {
    const items: PlatformResource[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({
        view: filters.view,
        sortBy: "name",
        direction: "asc",
        limit: "200",
      });
      if (filters.parentId) query.set("parentId", filters.parentId);
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<{
        items: PlatformResource[];
        nextCursor: string | null;
      }>(`/resources?${query}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  private async request<T>(
    requestPath: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const response = await this.requestAllowingError<T>(requestPath, options);
    if (!response.ok) {
      throw new SafeCliError(`平台 API 请求失败：${response.error.code}（HTTP ${response.status}）。`);
    }
    return response.data;
  }

  private async requestAllowingError<T>(
    requestPath: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<
    | { ok: true; status: number; data: T }
    | { ok: false; status: number; error: { code: string; message: string } }
  > {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.authenticated !== false) {
      if (!this.accessToken) throw new SafeCliError("平台登录会话尚未建立。");
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${requestPath}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new SafeCliError("平台 API 网络请求失败；不会假定写入未发生，请重新运行以读取权威状态。");
    }
    const payload = await response.json().catch(() => null) as PlatformApiEnvelope<T> | null;
    if (response.ok && payload && "data" in payload) {
      return { ok: true, status: response.status, data: payload.data };
    }
    const error = payload && "error" in payload
      ? payload.error
      : { code: `http_${response.status}`, message: "平台 API 返回无效错误响应。" };
    return { ok: false, status: response.status, error };
  }
}

class AliyunVodImportPort implements VodImportPort {
  private readonly client: InstanceType<typeof VodClient>;
  private readonly readyTimeoutMs: number;
  private readonly partSize: number;
  private readonly parallel: number;
  private readonly onProgress: (message: string) => void;

  constructor(options: {
    region: string;
    readyTimeoutMs: number;
    partSize: number;
    parallel: number;
    onProgress: (message: string) => void;
  }) {
    const credential = new Credential();
    this.client = new VodClient(new OpenApiConfig({
      credential,
      regionId: options.region,
    }));
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.partSize = options.partSize;
    this.parallel = options.parallel;
    this.onProgress = options.onProgress;
  }

  async findByReferenceId(referenceId: string): Promise<VodVideo | null> {
    try {
      const response = await this.client.getVideoInfos(new GetVideoInfosRequest({
        referenceIds: referenceId,
      }));
      const matches = (response.body?.videoList ?? []).filter((video: { referenceId?: string }) =>
        video.referenceId === referenceId);
      if (matches.length > 1) {
        throw new SafeCliError("阿里云 VOD ReferenceId 返回多个媒资，拒绝继续。");
      }
      if (matches.length === 0) return null;
      const video = matches[0]!;
      if (!video.videoId || !video.title || !isVodStatus(video.status)) {
        throw new SafeCliError("阿里云 VOD 返回了不完整的媒资元数据。");
      }
      return {
        videoId: video.videoId,
        referenceId,
        status: video.status,
        title: video.title,
      };
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      throw new SafeCliError("查询阿里云 VOD ReferenceId 失败。");
    }
  }

  async ensureNormalVideo(
    row: PreparedManifestRow,
    state: ImportStateRow | null,
    onCheckpoint: (update: {
      videoId: string;
      uploadCheckpoint: VodUploadCheckpoint | null;
    }) => Promise<void>,
  ) {
    assertUploadableRow(row);
    let video = await this.findByReferenceId(row.vodReferenceId);
    let uploaded = false;
    if (!video) {
      const grant = await this.createUpload(row);
      await onCheckpoint({ videoId: grant.videoId, uploadCheckpoint: null });
      await this.uploadWithGrant(row, grant, null, onCheckpoint);
      uploaded = true;
      video = await this.waitForNormal(row.vodReferenceId);
    } else if (video.status === "Normal") {
      return { videoId: video.videoId, uploaded: false };
    } else if (video.status === "UploadSucc" || video.status === "Transcoding") {
      video = await this.waitForNormal(row.vodReferenceId);
    } else if (video.status === "Uploading" || video.status === "UploadFail") {
      if (state?.vodVideoId !== video.videoId) {
        throw new SafeCliError(
          "VOD 媒资处于未完成上传状态，但本地状态不拥有该 VideoId；拒绝接管或覆盖。",
        );
      }
      const grant = await this.refreshUpload(video.videoId);
      await this.uploadWithGrant(row, grant, state.uploadCheckpoint ?? null, onCheckpoint);
      uploaded = true;
      video = await this.waitForNormal(row.vodReferenceId);
    } else {
      throw new SafeCliError(`VOD 媒资状态为 ${video.status}，拒绝覆盖或重建。`);
    }
    return { videoId: video.videoId, uploaded };
  }

  private async createUpload(row: UploadableManifestRow): Promise<UploadGrant> {
    try {
      const response = await this.client.createUploadVideo(new CreateUploadVideoRequest({
        title: row.vodTitle,
        fileName: path.basename(row.videoPath),
        fileSize: row.videoSize,
        referenceId: row.vodReferenceId,
      }));
      return parseUploadGrant(response.body, null);
    } catch (error) {
      if (error instanceof SafeCliError) throw error;
      // CreateUploadVideo 的响应可能在服务端成功后丢失；调用方重跑时必须用 ReferenceId 查证，不能盲目重试。
      throw new SafeCliError("创建 VOD 上传凭据失败或响应不明确；请重新 dry-run 通过 ReferenceId 查证。");
    }
  }

  private async refreshUpload(videoId: string): Promise<UploadGrant> {
    try {
      const response = await this.client.refreshUploadVideo(new RefreshUploadVideoRequest({
        videoId,
      }));
      return parseUploadGrant(response.body, videoId);
    } catch {
      throw new SafeCliError("刷新 VOD 上传凭据失败。");
    }
  }

  private async uploadWithGrant(
    row: UploadableManifestRow,
    initialGrant: UploadGrant,
    initialCheckpoint: VodUploadCheckpoint | null,
    onCheckpoint: (update: {
      videoId: string;
      uploadCheckpoint: VodUploadCheckpoint | null;
    }) => Promise<void>,
  ) {
    let grant = initialGrant;
    let checkpoint = initialCheckpoint;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const address = decodeBase64Json<DecodedUploadAddress>(grant.uploadAddress, [
        "Endpoint",
        "Bucket",
        "FileName",
      ]);
      const auth = decodeBase64Json<DecodedUploadAuth>(grant.uploadAuth, [
        "AccessKeyId",
        "AccessKeySecret",
        "SecurityToken",
      ]);
      const endpoint = address.Endpoint.replace(/^https?:\/\//u, "");
      const Oss = loadOssConstructor();
      const oss = new Oss({
        endpoint,
        bucket: address.Bucket,
        accessKeyId: auth.AccessKeyId,
        accessKeySecret: auth.AccessKeySecret,
        stsToken: auth.SecurityToken,
        secure: true,
        timeout: 120_000,
        retryMax: 3,
      });
      try {
        await oss.multipartUpload(address.FileName, row.videoPath, {
          parallel: this.parallel,
          partSize: this.partSize,
          timeout: 120_000,
          ...(checkpoint ? { checkpoint } : {}),
          progress: async (percentage, nextCheckpoint) => {
            if (nextCheckpoint) {
              checkpoint = normalizeCheckpoint(nextCheckpoint, row);
              await onCheckpoint({
                videoId: grant.videoId,
                uploadCheckpoint: checkpoint,
              });
            }
            this.onProgress(
              `第 ${row.rowNumber} 行：VOD 上传 ${Math.floor(percentage * 100)}%。`,
            );
          },
        });
        await onCheckpoint({ videoId: grant.videoId, uploadCheckpoint: null });
        return;
      } catch (error) {
        if (attempt === 0 && isExpiredUploadCredential(error)) {
          grant = await this.refreshUpload(grant.videoId);
          continue;
        }
        throw new SafeCliError(
          `第 ${row.rowNumber} 行：VOD 分片上传中断；已保存断点，重新 dry-run 后可安全续传。`,
        );
      }
    }
  }

  private async waitForNormal(referenceId: string) {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const video = await this.findByReferenceId(referenceId);
      if (!video) throw new SafeCliError("VOD 上传后无法按 ReferenceId 找到媒资。");
      if (video.status === "Normal") return video;
      if (video.status === "Blocked" || video.status === "UploadFail" ||
        video.status === "TranscodeFail") {
        throw new SafeCliError(`VOD 媒资进入终止状态 ${video.status}，拒绝登记平台资源。`);
      }
      this.onProgress(`VOD 媒资处理中（${video.status}），等待可用。`);
      await delay(10_000);
    }
    throw new SafeCliError("等待 VOD 媒资变为 Normal 超时；状态已保留，稍后重新 dry-run 即可续办。");
  }
}

class FileImportState implements ImportStatePort {
  private value: ImportState;
  private readonly lockHandle: Awaited<ReturnType<typeof open>> | null;

  private constructor(
    private readonly statePath: string,
    value: ImportState,
    lockHandle: Awaited<ReturnType<typeof open>> | null,
  ) {
    this.value = value;
    this.lockHandle = lockHandle;
  }

  static async open(statePath: string, writable: boolean) {
    const absolutePath = path.resolve(statePath);
    let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
    if (writable) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      try {
        lockHandle = await open(`${absolutePath}.lock`, "wx", 0o600);
      } catch {
        throw new SafeCliError("状态文件锁已存在；拒绝并发执行同一批次。");
      }
    }
    try {
      const text = await readFile(absolutePath, "utf8");
      return new FileImportState(absolutePath, parseImportState(JSON.parse(text)), lockHandle);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new FileImportState(absolutePath, emptyImportState(), lockHandle);
      }
      await lockHandle?.close();
      if (lockHandle) await unlink(`${absolutePath}.lock`).catch(() => undefined);
      if (error instanceof SafeCliError || error instanceof Error) throw error;
      throw new SafeCliError("无法读取状态文件。");
    }
  }

  current() {
    return this.value;
  }

  async update(rowIdentity: string, update: Partial<ImportStateRow>) {
    if (!this.lockHandle) throw new SafeCliError("dry-run 模式禁止写状态文件。");
    const current = this.value.rows[rowIdentity];
    const videoSha256 = stateUpdateValue(update, current, "videoSha256");
    const jsonSha256 = stateUpdateValue(update, current, "jsonSha256");
    const vodReferenceId = stateUpdateValue(update, current, "vodReferenceId");
    const next: ImportStateRow = {
      ...current,
      ...update,
      rowIdentity,
      videoSha256,
      jsonSha256,
      vodReferenceId,
    };
    this.value = {
      version: 1,
      rows: { ...this.value.rows, [rowIdentity]: next },
    };
    await writeJsonAtomically(this.statePath, this.value);
    return next;
  }

  async close() {
    if (!this.lockHandle) return;
    await this.lockHandle.close();
    await unlink(`${this.statePath}.lock`).catch(() => undefined);
  }
}

function parseArguments(args: string[]): CliCommand {
  const mode = args.shift();
  if (mode !== "dry-run" && mode !== "execute") throw new SafeCliError(usage());
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new SafeCliError(usage());
    }
    if (values.has(key)) throw new SafeCliError(`参数重复：${key}。`);
    values.set(key, value);
  }
  const allowed = new Set([
    "--csv",
    "--base-url",
    "--account",
    "--region",
    "--state",
    "--plan-fingerprint",
    "--ready-timeout-seconds",
    "--part-size-mib",
    "--parallel",
  ]);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new SafeCliError(`未知参数：${unknown.join("、")}。`);
  const csvPath = requiredArgument(values, "--csv");
  const baseUrl = normalizeBaseUrl(requiredArgument(values, "--base-url"));
  const accountName = requiredArgument(values, "--account");
  const region = requiredArgument(values, "--region");
  const statePath = values.get("--state") ?? `${csvPath}.xiqu-vod-import-state.json`;
  const planFingerprint = values.get("--plan-fingerprint") ?? null;
  if (mode === "execute" && !/^[a-f0-9]{64}$/u.test(planFingerprint ?? "")) {
    throw new SafeCliError("execute 必须提供 dry-run 返回的完整 --plan-fingerprint。");
  }
  if (mode === "dry-run" && planFingerprint !== null) {
    throw new SafeCliError("dry-run 不接受 --plan-fingerprint。");
  }
  const readyTimeoutSeconds = optionalInteger(
    values.get("--ready-timeout-seconds"),
    1_800,
    60,
    7_200,
    "ready-timeout-seconds",
  );
  const partSizeMib = optionalInteger(values.get("--part-size-mib"), 16, 1, 100, "part-size-mib");
  const parallel = optionalInteger(values.get("--parallel"), 4, 1, 8, "parallel");
  return {
    mode,
    csvPath,
    baseUrl,
    accountName,
    region,
    statePath,
    planFingerprint,
    readyTimeoutMs: readyTimeoutSeconds * 1_000,
    partSize: partSizeMib * 1024 * 1024,
    parallel,
  };
}

function normalizeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeCliError("--base-url 必须是有效 URL。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SafeCliError("--base-url 不能包含凭据、查询参数或片段。");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new SafeCliError("远程平台必须使用 HTTPS；仅 loopback 开发地址允许 HTTP。");
  }
  return url.toString().replace(/\/$/u, "");
}

function parseUploadGrant(
  body: { videoId?: string; uploadAddress?: string; uploadAuth?: string } | undefined,
  expectedVideoId: string | null,
): UploadGrant {
  const videoId = body?.videoId;
  if (!videoId || !body?.uploadAddress || !body.uploadAuth ||
    (expectedVideoId && videoId !== expectedVideoId)) {
    throw new SafeCliError("阿里云 VOD 返回了无效上传凭据。");
  }
  return { videoId, uploadAddress: body.uploadAddress, uploadAuth: body.uploadAuth };
}

function decodeBase64Json<T extends Record<string, unknown>>(
  encoded: string,
  requiredKeys: string[],
): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
  } catch {
    throw new SafeCliError("阿里云 VOD 上传凭据无法解析。");
  }
  if (!isRecord(value) || requiredKeys.some((key) =>
    typeof value[key] !== "string" || (value[key] as string).length === 0)) {
    throw new SafeCliError("阿里云 VOD 上传凭据缺少必要字段。");
  }
  return value as T;
}

function normalizeCheckpoint(checkpoint: OssCheckpoint, row: UploadableManifestRow): VodUploadCheckpoint {
  if (checkpoint.file !== row.videoPath ||
    typeof checkpoint.name !== "string" ||
    checkpoint.fileSize !== row.videoSize ||
    !Number.isInteger(checkpoint.partSize) ||
    typeof checkpoint.uploadId !== "string" ||
    !Array.isArray(checkpoint.doneParts)) {
    throw new SafeCliError("OSS SDK 返回了无效上传断点。");
  }
  return {
    file: checkpoint.file,
    name: checkpoint.name,
    fileSize: checkpoint.fileSize,
    partSize: checkpoint.partSize,
    uploadId: checkpoint.uploadId,
    doneParts: checkpoint.doneParts.map(({ number, etag }) => ({ number, etag })),
  };
}

function isExpiredUploadCredential(error: unknown) {
  if (!isRecord(error)) return false;
  return error.code === "SecurityTokenExpired" || error.code === "InvalidSecurityToken";
}

function isVodStatus(value: unknown): value is VodVideoStatus {
  return value === "Uploading" || value === "UploadFail" || value === "UploadSucc" ||
    value === "Transcoding" || value === "TranscodeFail" || value === "Blocked" ||
    value === "Normal";
}

async function writeJsonAtomically(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

function usage() {
  return "用法：platform-import:vod -- dry-run|execute --csv <清单.csv> --base-url <https://站点/api> --account <账号> --region <VOD区域> [--state <状态.json>] [execute: --plan-fingerprint <sha256>]；平台密码从 stdin 读取。";
}

function requiredArgument(values: Map<string, string>, key: string) {
  const value = values.get(key)?.trim();
  if (!value) throw new SafeCliError(`缺少参数 ${key}。`);
  return value;
}

function optionalInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SafeCliError(`--${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return parsed;
}

function stateUpdateValue<K extends "videoSha256" | "jsonSha256" | "vodReferenceId">(
  update: Partial<ImportStateRow>,
  current: ImportStateRow | undefined,
  key: K,
): ImportStateRow[K] {
  if (Object.prototype.hasOwnProperty.call(update, key)) {
    const value = update[key];
    if (value === undefined) throw new SafeCliError(`写入状态前缺少 ${key}。`);
    return value as ImportStateRow[K];
  }
  if (current) return current[key];
  throw new SafeCliError(`写入状态前缺少 ${key}。`);
}

function loadOssConstructor(): OssConstructor {
  try {
    return require("ali-oss") as OssConstructor;
  } catch {
    throw new SafeCliError("无法加载阿里云 OSS 上传 SDK；尚未开始分片上传。");
  }
}

function assertUploadableRow(row: PreparedManifestRow): asserts row is UploadableManifestRow {
  if (row.videoIssue || !row.videoPath || row.videoSize === null ||
    !row.videoSha256 || !row.vodReferenceId) {
    throw new SafeCliError(`第 ${row.rowNumber} 行：无有效视频，禁止调用 VOD 上传。`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

await run().catch((error: unknown) => {
  const message = error instanceof SafeCliError || error instanceof Error
    ? error.message
    : "未知错误";
  process.stderr.write(`批量导入失败：${message}\n`);
  process.exitCode = 1;
});
