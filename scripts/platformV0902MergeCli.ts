#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildProjectSnapshotBoundaryEnvelope,
  type AnnotationRecoverySnapshotDetail,
  type AnnotationRecoverySnapshotSummary,
} from "@xiqu/shared";
import type { ProjectData } from "@xiqu/document-model";
import { readBootstrapPasswordFromStdin } from "../apps/api/src/bootstrapAdminArguments.js";
import {
  MAX_PLATFORM_V0902_SCAN_RESOURCES,
  PLATFORM_GONGCHE_CHANGED_SKIP_REASON,
  PLATFORM_V0902_MERGE_PLAN_VERSION,
  PLATFORM_V0902_MERGE_STATE_VERSION,
  buildPlatformV0902PlanFingerprint,
  findCompletedPlatformV0902StateIssues,
  findSkippedPlatformV0902StateIssues,
  hasPlatformGongcheChanges,
  hashJson,
  mergeProjectPlatformFirst,
  normalizePlatformProjectPayload,
  parsePlatformV0902MergePlan,
  parsePlatformV0902MergeState,
  type PlatformV0902MergePlan,
  type PlatformV0902MergePlanRow,
  type PlatformV0902MergeState,
  type PlatformV0902MergeStateRow,
} from "./platformV0902MergeCore.js";

type Mode = "dry-run" | "execute" | "verify" | "live-test" | "add-test-references";
type Command = {
  mode: Mode;
  baseUrl: string;
  accountName: string;
  sourceDirectory: string | null;
  planPath: string | null;
  statePath: string | null;
  planFingerprint: string | null;
  sourceResourceId: string | null;
  testProjectId: string | null;
};

type ApiEnvelope<T> = { data: T } | { error: { code: string; message: string; details?: unknown } };

type Resource = {
  id: string;
  parentId: string | null;
  type: "project" | "folder" | "media_file" | "annotation_file";
  name: string;
  revision?: number | null;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string | null;
};

type AnnotationFile = {
  resource: Resource;
  revision: number;
  payload: unknown;
  mediaResourceId: string | null;
};

type ResourcePage = { items: Resource[]; nextCursor: string | null };

type LocalJson = {
  name: string;
  absolutePath: string;
  relativePath: string;
  rawHash: string;
  project: ProjectData;
  projectHash: string;
};

type LocalJsonPath = Pick<LocalJson, "name" | "absolutePath" | "relativePath">;

class SafeCliError extends Error {}

class HttpPlatformMergePort {
  private accessToken: string | null = null;

  constructor(readonly baseUrl: string) {}

  async login(accountName: string, password: string) {
    const login = await this.request<{
      accessToken: string;
      user: { roles: string[] };
    }>("/auth/login", {
      method: "POST",
      body: { accountName, password },
      authenticated: false,
    });
    if (!login.user.roles.includes("super_admin")) {
      throw new SafeCliError("v0902 合并工具要求 super_admin 账号。");
    }
    this.accessToken = login.accessToken;
  }

  getMaintenanceStatus() {
    return this.request<{ enabled: boolean; reason: string | null }>("/admin/maintenance");
  }

  async listResources(filters: { view: string; parentId?: string }): Promise<Resource[]> {
    const items: Resource[] = [];
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
      const page = await this.request<ResourcePage>(`/resources?${query}`);
      items.push(...page.items);
      cursor = page.nextCursor;
      if (items.length > MAX_PLATFORM_V0902_SCAN_RESOURCES) {
        throw new SafeCliError("单目录资源数超过安全扫描上限。");
      }
    } while (cursor);
    return items;
  }

  getAnnotationFile(resourceId: string) {
    return this.request<AnnotationFile>(`/annotation-files/${encodeURIComponent(resourceId)}`);
  }

  async listSnapshotsAtRevision(resourceId: string, revision: number) {
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const query = new URLSearchParams({ revision: String(revision), limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request<unknown>(
        `/annotation-files/${encodeURIComponent(resourceId)}/recovery-snapshots?${query}`,
      );
      // 部署本提交后的精确筛选合同直接返回数组。
      if (Array.isArray(response)) {
        return (response as AnnotationRecoverySnapshotSummary[])
          .filter((snapshot) => snapshot.revision === revision);
      }
      // 兼容线上旧版有界分页合同；旧 API 会忽略 revision，但接受 cursor。
      if (isRecord(response) && Array.isArray(response.snapshots)) {
        const snapshots = response.snapshots as AnnotationRecoverySnapshotSummary[];
        const matches = snapshots.filter((snapshot) => snapshot.revision === revision);
        if (matches.length > 0 || response.nextCursor === null) return matches;
        if (typeof response.nextCursor !== "string" || !response.nextCursor ||
          response.nextCursor === cursor || snapshots.length === 0) {
          throw new SafeCliError(`恢复快照旧版分页响应不完整，无法安全定位 revision ${revision}。`);
        }
        cursor = response.nextCursor;
        continue;
      }
      throw new SafeCliError("恢复快照列表响应格式不受支持；请先部署与本工具对应的 API。");
    }
    throw new SafeCliError(`恢复快照分页超过安全上限，无法定位 revision ${revision}。`);
  }

  listRevisionOneSnapshots(resourceId: string) {
    return this.listSnapshotsAtRevision(resourceId, 1);
  }

  getRecoverySnapshot(resourceId: string, snapshotId: string) {
    return this.request<AnnotationRecoverySnapshotDetail<unknown>>(
      `/annotation-files/${encodeURIComponent(resourceId)}` +
      `/recovery-snapshots/${encodeURIComponent(snapshotId)}`,
    );
  }

  acquireLease(resourceId: string, baseRevision: number) {
    return this.request<{ token: string; baseRevision: number; purpose: string }>(
      `/annotation-files/${encodeURIComponent(resourceId)}/mutation-lease`,
      { method: "POST", body: { baseRevision, purpose: "bulk_import" } },
    );
  }

  releaseLease(resourceId: string, token: string) {
    return this.request<void>(
      `/annotation-files/${encodeURIComponent(resourceId)}/mutation-lease`,
      { method: "DELETE", body: { token } },
    );
  }

  createBoundaryOperation(
    resourceId: string,
    input: {
      operationId: string;
      baseRevision: number;
      payload: unknown;
      mutationLeaseToken: string;
    },
  ) {
    return this.request<unknown>(`/annotation-files/${encodeURIComponent(resourceId)}/operations`, {
      method: "POST",
      body: {
        clientOperationId: input.operationId,
        baseRevision: input.baseRevision,
        localRevision: null,
        action: "annotation.project.snapshot.boundary",
        payload: input.payload,
        mutationLeaseToken: input.mutationLeaseToken,
      },
    });
  }

  saveMergedProject(
    resourceId: string,
    input: {
      baseRevision: number;
      payload: ProjectData;
      operationId: string;
      mutationLeaseToken: string;
    },
  ) {
    return this.request<AnnotationFile>(`/annotation-files/${encodeURIComponent(resourceId)}`, {
      method: "PUT",
      body: {
        baseRevision: input.baseRevision,
        payload: input.payload,
        clientOperationIds: [input.operationId],
        mutationLeaseToken: input.mutationLeaseToken,
      },
    });
  }

  renameResource(resourceId: string, name: string) {
    return this.request<Resource>(`/resources/${encodeURIComponent(resourceId)}`, {
      method: "PATCH",
      body: { name },
    });
  }

  createProject(name: string) {
    return this.request<Resource>("/resources", {
      method: "POST",
      body: { parentId: null, type: "project", name },
    });
  }

  createAnnotation(
    parentId: string,
    name: string,
    payload: unknown,
    mediaResourceId: string | null,
  ) {
    return this.request<AnnotationFile>("/annotation-files", {
      method: "POST",
      body: { parentId, name, payload, mediaResourceId },
    });
  }

  saveTestPlatformEdit(resourceId: string, baseRevision: number, payload: unknown) {
    return this.request<AnnotationFile>(`/annotation-files/${encodeURIComponent(resourceId)}`, {
      method: "PUT",
      body: { baseRevision, payload, clientOperationIds: [] },
    });
  }

  trashResource(resourceId: string) {
    return this.request<Resource>(`/resources/${encodeURIComponent(resourceId)}/trash`, {
      method: "POST",
    });
  }

  private async request<T>(
    requestPath: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.authenticated !== false) {
      if (!this.accessToken) throw new SafeCliError("平台客户端尚未登录。");
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${requestPath}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new SafeCliError(`平台请求失败：${error instanceof Error ? error.message : "网络错误"}`);
    }
    const text = await response.text();
    let envelope: ApiEnvelope<T>;
    try {
      envelope = text ? JSON.parse(text) as ApiEnvelope<T> : { data: undefined as T };
    } catch {
      throw new SafeCliError(`平台返回非 JSON 响应（HTTP ${response.status}）。`);
    }
    if (!response.ok || !("data" in envelope)) {
      const error = "error" in envelope ? envelope.error : null;
      throw new SafeCliError(
        `平台请求被拒绝（HTTP ${response.status}/${error?.code ?? "unknown"}）：` +
        `${error?.message ?? "无可识别错误信息"}`,
      );
    }
    return envelope.data;
  }
}

async function run() {
  const command = parseArguments(process.argv.slice(2));
  const password = await readBootstrapPasswordFromStdin(process.stdin);
  if (!password) throw new SafeCliError("平台密码必须通过 stdin 提供。");
  const platform = new HttpPlatformMergePort(command.baseUrl);
  await platform.login(command.accountName, password);

  if (command.mode === "dry-run") {
    const plan = await buildPlan({
      platform,
      sourceDirectory: command.sourceDirectory!,
      ...(command.sourceResourceId ? { onlyResourceId: command.sourceResourceId } : {}),
    });
    await writeJsonAtomically(command.planPath!, plan);
    process.stdout.write(`${JSON.stringify({
      mode: command.mode,
      planPath: path.resolve(command.planPath!),
      fingerprint: plan.fingerprint,
      summary: plan.summary,
      skippedRows: plan.rows.filter(({ action }) => action === "skipped").map((row) => ({
        resourceId: row.resourceId,
        path: row.platformPath,
        reason: row.skipReason,
      })),
      blockedRows: plan.rows.filter(({ action }) => action === "blocked").map((row) => ({
        resourceId: row.resourceId,
        path: row.platformPath,
        blockers: row.blockers,
      })),
    }, null, 2)}\n`);
    if (plan.summary.blockedCount > 0) process.exitCode = 2;
    return;
  }

  if (command.mode === "live-test") {
    await runLiveTest({
      platform,
      sourceDirectory: command.sourceDirectory!,
      sourceResourceId: command.sourceResourceId,
    });
    return;
  }
  if (command.mode === "add-test-references") {
    const result = await addTestReferences({
      platform,
      sourceDirectory: command.sourceDirectory!,
      sourceResourceId: command.sourceResourceId!,
      testProjectId: command.testProjectId!,
    });
    process.stdout.write(`${JSON.stringify({ mode: command.mode, ...result }, null, 2)}\n`);
    return;
  }

  const plan = parsePlatformV0902MergePlan(JSON.parse(await readFile(command.planPath!, "utf8")));
  if (plan.baseUrl !== command.baseUrl) throw new SafeCliError("计划文件不属于当前平台 URL。");
  if (command.planFingerprint !== plan.fingerprint) {
    throw new SafeCliError("命令提供的 fingerprint 与计划文件不一致。");
  }
  if (command.mode === "execute") {
    const stateFile = await MergeStateFile.open(command.statePath!, plan);
    try {
      const result = await executePlan({ platform, plan, stateFile });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await stateFile.close();
    }
    return;
  }
  const state = parsePlatformV0902MergeState(
    JSON.parse(await readFile(command.statePath!, "utf8")),
    plan,
  );
  const result = await verifyPlan({ platform, plan, state });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 3;
}

async function buildPlan(input: {
  platform: HttpPlatformMergePort;
  sourceDirectory: string;
  onlyResourceId?: string;
}): Promise<PlatformV0902MergePlan> {
  const sourceDirectory = path.resolve(input.sourceDirectory);
  // 先只发现路径；具体 JSON 仅在可信 base/current 证明该折并非工尺 skip 后才解析。
  const localFiles = await discoverLocalV0902Files(sourceDirectory);
  const localByName = new Map<string, LocalJsonPath[]>();
  for (const file of localFiles) {
    const values = localByName.get(file.name) ?? [];
    values.push(file);
    localByName.set(file.name, values);
  }
  const { resources, paths } = await scanAllActiveResources(input.platform);
  const childrenByParent = new Map<string, Resource[]>();
  for (const resource of resources) {
    if (!resource.parentId) continue;
    const children = childrenByParent.get(resource.parentId) ?? [];
    children.push(resource);
    childrenByParent.set(resource.parentId, children);
  }

  const candidates = resources.filter((resource) =>
    resource.type === "annotation_file" &&
    resource.revision !== null && resource.revision !== undefined && resource.revision > 1 &&
    /^\d+_v0901_.+\.json$/iu.test(resource.name) &&
    !/\.backup\./iu.test(resource.name) &&
    (!input.onlyResourceId || resource.id === input.onlyResourceId));
  if (input.onlyResourceId && candidates.length !== 1) {
    throw new SafeCliError("隔离测试文件没有作为唯一已修改 v0901 候选被发现。");
  }

  const usedLocalPaths = new Set<string>();
  const rows: PlatformV0902MergePlanRow[] = [];
  for (const candidate of candidates.sort((left, right) =>
    (paths.get(left.id) ?? left.name).localeCompare(paths.get(right.id) ?? right.name))) {
    const targetName = candidate.name.replace(/_v0901_/iu, "_v0902_");
    // 服务器身份/基线错误始终阻断；只为实际合并所需的本地/目标条件可被工尺 skip 覆盖。
    const sourceBlockers: string[] = [];
    const mergeBlockers: string[] = [];
    const localMatches = localByName.get(targetName) ?? [];
    if (localMatches.length !== 1) {
      mergeBlockers.push(localMatches.length === 0
        ? `本地缺少精确文件 ${targetName}`
        : `本地存在 ${localMatches.length} 个同名文件 ${targetName}`);
    }
    if (!candidate.parentId) sourceBlockers.push("标注文件没有有效父项目或文件夹。");
    const siblingCollision = candidate.parentId
      ? (childrenByParent.get(candidate.parentId) ?? []).find((resource) =>
        resource.id !== candidate.id && resource.name === targetName)
      : null;
    if (siblingCollision) mergeBlockers.push(`同级已经存在目标名称：${siblingCollision.id}`);

    let current: AnnotationFile | null = null;
    let baseSnapshot: AnnotationRecoverySnapshotDetail<unknown> | null = null;
    let currentProject: ProjectData | null = null;
    let baseProject: ProjectData | null = null;
    let mergedProject: ProjectData | null = null;
    let decisions: PlatformV0902MergePlanRow["decisions"] = null;
    let skipReason: string | null = null;
    try {
      current = await input.platform.getAnnotationFile(candidate.id);
      if (current.resource.trashedAt) sourceBlockers.push("候选文件已进入回收站。");
      if (current.resource.name !== candidate.name || current.revision !== candidate.revision) {
        sourceBlockers.push("扫描后文件名称或 revision 已变化。");
      }
      currentProject = normalizePlatformProjectPayload(current.payload);
      const summaries = await input.platform.listRevisionOneSnapshots(candidate.id);
      const revisionOne = summaries.filter(({ revision }) => revision === 1);
      if (revisionOne.length !== 1) {
        sourceBlockers.push(`revision 1 恢复快照数量为 ${revisionOne.length}，要求恰好一个。`);
      } else {
        baseSnapshot = await input.platform.getRecoverySnapshot(candidate.id, revisionOne[0]!.id);
        if (baseSnapshot.annotationFileId !== candidate.id || baseSnapshot.revision !== 1) {
          sourceBlockers.push("revision 1 恢复快照身份不匹配。");
        } else {
          baseProject = normalizePlatformProjectPayload(baseSnapshot.payload);
        }
      }
    } catch (error) {
      sourceBlockers.push(describeError(error));
    }
    const localPath = localMatches[0] ?? null;
    if (localPath) usedLocalPaths.add(localPath.absolutePath);
    if (baseProject && currentProject && hasPlatformGongcheChanges(baseProject, currentProject)) {
      skipReason = PLATFORM_GONGCHE_CHANGED_SKIP_REASON;
    }
    let local: LocalJson | null = null;
    if (!skipReason && localPath && localMatches.length === 1) {
      try {
        local = await readLocalV0902File(localPath);
      } catch (error) {
        mergeBlockers.push(describeError(error));
      }
    }
    if (!skipReason && baseProject && currentProject && local) {
      const result = mergeProjectPlatformFirst({
        base: baseProject,
        platform: currentProject,
        incoming: local.project,
      });
      decisions = result.decisions;
      if (result.ok) mergedProject = result.project;
      else if (result.disposition === "skipped") skipReason = result.issues.join("；");
      else mergeBlockers.push(...result.issues);
    }
    const currentHash = currentProject ? hashJson(currentProject) : "";
    const mergedHash = mergedProject ? hashJson(mergedProject) : null;
    const blockers = sourceBlockers.length > 0
      ? sourceBlockers
      : skipReason
        ? []
        : mergeBlockers;
    const action: PlatformV0902MergePlanRow["action"] = sourceBlockers.length > 0
      ? "blocked"
      : skipReason
        ? "skipped"
        : mergeBlockers.length > 0 || !mergedHash
          ? "blocked"
          : mergedHash === currentHash ? "rename_only" : "save_and_rename";
    rows.push({
      resourceId: candidate.id,
      parentId: candidate.parentId ?? "",
      platformPath: paths.get(candidate.id) ?? candidate.name,
      currentName: candidate.name,
      targetName,
      sourceRelativePath: localPath?.relativePath ?? targetName,
      currentRevision: current?.revision ?? Number(candidate.revision),
      mediaResourceId: current?.mediaResourceId ?? null,
      baseSnapshotId: baseSnapshot?.id ?? "",
      baseHash: baseProject ? hashJson(baseProject) : "",
      currentHash,
      incomingHash: local?.projectHash ?? "",
      mergedHash,
      action,
      skipReason,
      decisions,
      blockers: [...new Set(blockers)],
    });
  }

  const unsigned = {
    version: PLATFORM_V0902_MERGE_PLAN_VERSION,
    generatedAt: new Date().toISOString(),
    baseUrl: input.platform.baseUrl,
    sourceDirectory,
    rows,
    summary: {
      modifiedV0901Count: candidates.length,
      readyCount: rows.filter(({ action }) =>
        action === "save_and_rename" || action === "rename_only").length,
      saveCount: rows.filter(({ action }) => action === "save_and_rename").length,
      renameOnlyCount: rows.filter(({ action }) => action === "rename_only").length,
      skippedCount: rows.filter(({ action }) => action === "skipped").length,
      blockedCount: rows.filter(({ action }) => action === "blocked").length,
      unusedLocalJsonCount: localFiles.filter(({ absolutePath }) => !usedLocalPaths.has(absolutePath)).length,
    },
  } satisfies Omit<PlatformV0902MergePlan, "fingerprint">;
  return { ...unsigned, fingerprint: buildPlatformV0902PlanFingerprint(unsigned) };
}

async function executePlan(input: {
  platform: HttpPlatformMergePort;
  plan: PlatformV0902MergePlan;
  stateFile: MergeStateFile;
}) {
  if (input.plan.summary.blockedCount > 0 ||
    input.plan.rows.some(({ action }) => action === "blocked")) {
    throw new SafeCliError("计划包含阻断项，禁止执行。");
  }
  const maintenance = await input.platform.getMaintenanceStatus();
  if (maintenance.enabled) {
    throw new SafeCliError("平台内置维护模式已开启；普通 HTTP 写入被门禁阻止，禁止执行。");
  }
  const completed: Array<{ resourceId: string; name: string; revision: number }> = [];
  for (const row of input.plan.rows) {
    if (row.action === "skipped") continue;
    let stateRow = input.stateFile.get(row.resourceId);
    if (stateRow.status === "completed") {
      const current = await input.platform.getAnnotationFile(row.resourceId);
      const issues = findCompletedPlatformV0902StateIssues(
        row,
        stateRow,
        await currentFileFacts(input.platform, row, stateRow, current),
      );
      if (issues.length > 0) {
        throw new SafeCliError(`${row.platformPath} 的已完成状态与平台不一致：${issues.join("；")}。`);
      }
      completed.push({ resourceId: row.resourceId, name: current.resource.name, revision: current.revision });
      continue;
    }

    const local = await readPlannedLocalFile(input.plan.sourceDirectory, row);
    const baseSnapshot = await input.platform.getRecoverySnapshot(row.resourceId, row.baseSnapshotId);
    const baseProject = normalizePlatformProjectPayload(baseSnapshot.payload);
    if (baseSnapshot.revision !== 1 || hashJson(baseProject) !== row.baseHash) {
      throw new SafeCliError(`${row.platformPath} 的 v0901 基线已经不符合计划。`);
    }

    let current = await input.platform.getAnnotationFile(row.resourceId);
    if (current.mediaResourceId !== row.mediaResourceId || current.resource.parentId !== row.parentId) {
      throw new SafeCliError(`${row.platformPath} 的媒体绑定或父级已经变化。`);
    }
    if (stateRow.status === "saved_pending_rename") {
      if (hashJson(normalizePlatformProjectPayload(current.payload)) !== row.mergedHash ||
        current.revision !== stateRow.committedRevision) {
        throw new SafeCliError(`${row.platformPath} 保存后的断点状态无法验证。`);
      }
    } else {
      const currentProject = normalizePlatformProjectPayload(current.payload);
      if (current.resource.name !== row.currentName || current.revision !== row.currentRevision ||
        hashJson(currentProject) !== row.currentHash || local.projectHash !== row.incomingHash) {
        throw new SafeCliError(`${row.platformPath} 的平台或本地输入已变化；请重新 dry-run。`);
      }
      const merge = mergeProjectPlatformFirst({
        base: baseProject,
        platform: currentProject,
        incoming: local.project,
      });
      if (!merge.ok) throw new SafeCliError(`${row.platformPath} 重新合并失败：${merge.issues.join("；")}`);
      if (hashJson(merge.project) !== row.mergedHash) {
        throw new SafeCliError(`${row.platformPath} 的合并结果 fingerprint 已变化。`);
      }
      if (row.action === "save_and_rename") {
        current = await commitMergedProject(input.platform, row, stateRow, merge.project);
        stateRow = {
          ...stateRow,
          status: "saved_pending_rename",
          committedRevision: current.revision,
        };
        await input.stateFile.update(stateRow);
      }
    }

    await assertNoSiblingNameCollision(input.platform, row);
    if (current.resource.name !== row.targetName) {
      await input.platform.renameResource(row.resourceId, row.targetName);
    }
    const verified = await input.platform.getAnnotationFile(row.resourceId);
    if (verified.resource.id !== row.resourceId || verified.resource.name !== row.targetName ||
      verified.resource.parentId !== row.parentId || verified.mediaResourceId !== row.mediaResourceId ||
      hashJson(normalizePlatformProjectPayload(verified.payload)) !== row.mergedHash) {
      throw new SafeCliError(`${row.platformPath} 的保存后验证失败。`);
    }
    stateRow = {
      ...stateRow,
      status: "completed",
      committedRevision: verified.revision,
      completedAt: new Date().toISOString(),
    };
    await input.stateFile.update(stateRow);
    completed.push({ resourceId: row.resourceId, name: verified.resource.name, revision: verified.revision });
    process.stderr.write(`已完成 ${completed.length}/${input.plan.summary.readyCount}：${row.platformPath}\n`);
  }
  return {
    mode: "execute",
    planFingerprint: input.plan.fingerprint,
    completedCount: completed.length,
    skippedCount: input.plan.summary.skippedCount,
    completed,
  };
}

async function commitMergedProject(
  platform: HttpPlatformMergePort,
  row: PlatformV0902MergePlanRow,
  stateRow: PlatformV0902MergeStateRow,
  project: ProjectData,
) {
  const lease = await platform.acquireLease(row.resourceId, row.currentRevision);
  let committed = false;
  try {
    const boundary = buildProjectSnapshotBoundaryEnvelope(stateRow.operationId, "merge_project");
    if (!boundary) throw new SafeCliError("无法建立 merge_project 快照边界。");
    await platform.createBoundaryOperation(row.resourceId, {
      operationId: stateRow.operationId,
      baseRevision: row.currentRevision,
      payload: boundary,
      mutationLeaseToken: lease.token,
    });
    try {
      const saved = await platform.saveMergedProject(row.resourceId, {
        baseRevision: row.currentRevision,
        payload: project,
        operationId: stateRow.operationId,
        mutationLeaseToken: lease.token,
      });
      if (saved.revision !== row.currentRevision + 1 ||
        hashJson(normalizePlatformProjectPayload(saved.payload)) !== row.mergedHash) {
        throw new SafeCliError("服务器保存回包与预期合并结果不一致。");
      }
      committed = true;
      return saved;
    } catch (error) {
      const latest = await platform.getAnnotationFile(row.resourceId).catch(() => null);
      if (latest && latest.revision === row.currentRevision + 1 &&
        hashJson(normalizePlatformProjectPayload(latest.payload)) === row.mergedHash) {
        committed = true;
        return latest;
      }
      throw error;
    }
  } finally {
    if (!committed) await platform.releaseLease(row.resourceId, lease.token).catch(() => undefined);
  }
}

async function verifyPlan(input: {
  platform: HttpPlatformMergePort;
  plan: PlatformV0902MergePlan;
  state: PlatformV0902MergeState;
}) {
  const rows: Array<{
    resourceId: string;
    action: "save_and_rename" | "rename_only" | "skipped";
    name: string;
    revision: number | null;
    advancedAfterMerge: boolean;
    issues: string[];
  }> = [];
  for (const planRow of input.plan.rows.filter(({ action }) => action !== "blocked")) {
    const stateRow = input.state.rows[planRow.resourceId];
    const issues: string[] = [];
    let current: AnnotationFile | null = null;
    try {
      current = await input.platform.getAnnotationFile(planRow.resourceId);
      if (planRow.action === "skipped") {
        issues.push(...findSkippedPlatformV0902StateIssues(planRow, {
          name: current.resource.name,
          parentId: current.resource.parentId,
          mediaResourceId: current.mediaResourceId,
          revision: current.revision,
          projectHash: hashJson(normalizePlatformProjectPayload(current.payload)),
        }));
      } else {
        if (!stateRow) issues.push("状态文件缺少资源");
        else issues.push(...findCompletedPlatformV0902StateIssues(
          planRow,
          stateRow,
          await currentFileFacts(input.platform, planRow, stateRow, current),
        ));
        const snapshots = await input.platform.listRevisionOneSnapshots(planRow.resourceId);
        if (snapshots.filter(({ revision }) => revision === 1).length !== 1) {
          issues.push("revision 1 基线快照缺失");
        }
        await assertNoSiblingNameCollision(input.platform, planRow);
      }
    } catch (error) {
      issues.push(describeError(error));
    }
    rows.push({
      resourceId: planRow.resourceId,
      action: planRow.action,
      name: current?.resource.name ?? (planRow.action === "skipped" ? planRow.currentName : planRow.targetName),
      revision: current?.revision ?? null,
      advancedAfterMerge: planRow.action !== "skipped" && Boolean(
        stateRow?.committedRevision && current && current.revision > stateRow.committedRevision,
      ),
      issues,
    });
  }
  return {
    mode: "verify",
    ok: rows.every(({ issues }) => issues.length === 0),
    verifiedCount: rows.filter(({ action, issues }) => action !== "skipped" && issues.length === 0).length,
    skippedCount: input.plan.summary.skippedCount,
    verifiedSkippedCount: rows.filter(({ action, issues }) =>
      action === "skipped" && issues.length === 0).length,
    rows,
  };
}

async function currentFileFacts(
  platform: HttpPlatformMergePort,
  planRow: PlatformV0902MergePlanRow,
  stateRow: PlatformV0902MergeStateRow,
  file: AnnotationFile,
) {
  const facts = {
    name: file.resource.name,
    parentId: file.resource.parentId,
    mediaResourceId: file.mediaResourceId,
    revision: file.revision,
    projectHash: hashJson(normalizePlatformProjectPayload(file.payload)),
  };
  if (stateRow.committedRevision === undefined || file.revision <= stateRow.committedRevision) {
    return facts;
  }
  const summaries = await platform.listSnapshotsAtRevision(
    planRow.resourceId,
    stateRow.committedRevision,
  );
  if (summaries.length !== 1) return facts;
  const snapshot = await platform.getRecoverySnapshot(planRow.resourceId, summaries[0]!.id);
  if (snapshot.annotationFileId !== planRow.resourceId ||
    snapshot.revision !== stateRow.committedRevision) return facts;
  return {
    ...facts,
    committedRevisionProjectHash: hashJson(normalizePlatformProjectPayload(snapshot.payload)),
  };
}

async function runLiveTest(input: {
  platform: HttpPlatformMergePort;
  sourceDirectory: string;
  sourceResourceId: string | null;
}) {
  const { platform } = input;
  const maintenance = await platform.getMaintenanceStatus();
  if (maintenance.enabled) throw new SafeCliError("平台处于内置维护模式，不能创建隔离测试项目。");
  const sourcePlan = await buildPlan({
    platform,
    sourceDirectory: input.sourceDirectory,
    ...(input.sourceResourceId ? { onlyResourceId: input.sourceResourceId } : {}),
  });
  const sourceRow = sourcePlan.rows.find((row) =>
    (!input.sourceResourceId || row.resourceId === input.sourceResourceId) &&
    row.action === "save_and_rename" &&
    row.blockers.length === 0 &&
    row.currentHash !== row.baseHash);
  if (!sourceRow) {
    throw new SafeCliError(input.sourceResourceId
      ? "指定资源不是可安全复制演练的已修改 v0901 文件。"
      : "没有找到可安全复制演练的已修改 v0901 文件。");
  }

  // 原资源从此处起保持只读：测试项目只复制其 base/current/local 三份输入。
  const sourceCurrent = await platform.getAnnotationFile(sourceRow.resourceId);
  const sourceCurrentProject = normalizePlatformProjectPayload(sourceCurrent.payload);
  if (sourceCurrent.resource.name !== sourceRow.currentName ||
    sourceCurrent.revision !== sourceRow.currentRevision ||
    sourceCurrent.mediaResourceId !== sourceRow.mediaResourceId ||
    hashJson(sourceCurrentProject) !== sourceRow.currentHash) {
    throw new SafeCliError("选中的原平台文件在复制前已变化，请重新运行 live-test。");
  }
  const sourceBaseSnapshot = await platform.getRecoverySnapshot(
    sourceRow.resourceId,
    sourceRow.baseSnapshotId,
  );
  const sourceBaseProject = normalizePlatformProjectPayload(sourceBaseSnapshot.payload);
  if (sourceBaseSnapshot.revision !== 1 || hashJson(sourceBaseProject) !== sourceRow.baseHash) {
    throw new SafeCliError("选中的原平台文件缺少稳定的 revision 1 基线。");
  }

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const projectName = `__v0902三方合并人工复核_${sourceRow.currentName.slice(0, 60)}_${suffix}`;
  const directory = await mkdtemp(path.join(tmpdir(), "xiqu-v0902-live-test-"));
  let project: Resource | null = null;
  let testError: unknown = null;
  let keepForManualReview = false;
  try {
    project = await platform.createProject(projectName);
    const created = await platform.createAnnotation(
      project.id,
      sourceRow.currentName,
      sourceBaseProject,
      sourceRow.mediaResourceId,
    );
    const edited = await platform.saveTestPlatformEdit(
      created.resource.id,
      created.revision,
      sourceCurrentProject,
    );
    if (edited.revision !== 2) throw new SafeCliError("测试平台修改没有生成 revision 2。");

    const sourceLocal = await readPlannedLocalFile(sourcePlan.sourceDirectory, sourceRow);
    await writeFile(
      path.join(directory, sourceRow.targetName),
      JSON.stringify({ version: 7, project: sourceLocal.project }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const plan = await buildPlan({
      platform,
      sourceDirectory: directory,
      onlyResourceId: created.resource.id,
    });
    if (plan.summary.readyCount !== 1 || plan.summary.saveCount !== 1 ||
      plan.rows[0]?.mergedHash !== sourceRow.mergedHash) {
      throw new SafeCliError(`隔离测试 dry-run 未通过：${JSON.stringify(plan.summary)}`);
    }
    const planPath = path.join(directory, "plan.json");
    const statePath = path.join(directory, "state.json");
    await writeJsonAtomically(planPath, plan);
    const stateFile = await MergeStateFile.open(statePath, plan);
    try {
      await executePlan({ platform, plan, stateFile });
    } finally {
      await stateFile.close();
    }
    const state = parsePlatformV0902MergeState(JSON.parse(await readFile(statePath, "utf8")), plan);
    const verification = await verifyPlan({ platform, plan, state });
    if (!verification.ok) throw new SafeCliError("隔离测试 verify 未通过。");
    const final = await platform.getAnnotationFile(created.resource.id);
    if (final.resource.id !== created.resource.id || final.resource.name !== sourceRow.targetName ||
      final.revision !== 3 || final.mediaResourceId !== sourceRow.mediaResourceId ||
      hashJson(normalizePlatformProjectPayload(final.payload)) !== sourceRow.mergedHash) {
      throw new SafeCliError("隔离测试最终内容不符合选中真实三方输入的预期结果。");
    }
    const references = await addTestReferences({
      platform,
      sourceDirectory: sourcePlan.sourceDirectory,
      sourceResourceId: sourceRow.resourceId,
      testProjectId: project.id,
    });
    keepForManualReview = true;
    process.stdout.write(`${JSON.stringify({
      mode: "live-test",
      ok: true,
      sourceResourceId: sourceRow.resourceId,
      sourcePlatformPath: sourceRow.platformPath,
      sourceRevision: sourceRow.currentRevision,
      projectId: project.id,
      projectName,
      annotationFileId: final.resource.id,
      annotationFileName: final.resource.name,
      finalRevision: final.revision,
      resourceIdPreserved: true,
      mediaResourceIdPreserved: true,
      mergedHash: sourceRow.mergedHash,
      references: references.files,
      focusedAudit: references.focusedAudit,
      cleanup: "保留活动状态，等待人工复核",
    }, null, 2)}\n`);
  } catch (error) {
    testError = error;
  } finally {
    let cleanupError: unknown = null;
    if (project && !keepForManualReview) {
      try {
        await platform.trashResource(project.id);
        process.stderr.write(`失败的隔离测试项目已移入回收站：${project.id}\n`);
      } catch (error) {
        cleanupError = error;
      }
    }
    await rm(directory, { recursive: true, force: true });
    if (cleanupError) {
      throw new SafeCliError(
        `失败的隔离测试项目清理失败，请人工处理 ${project?.id ?? "unknown"}：${describeError(cleanupError)}`,
      );
    }
  }
  if (testError) throw testError;
}

async function addTestReferences(input: {
  platform: HttpPlatformMergePort;
  sourceDirectory: string;
  sourceResourceId: string;
  testProjectId: string;
}) {
  const source = await input.platform.getAnnotationFile(input.sourceResourceId);
  if (!/^\d+_v0901_.+\.json$/iu.test(source.resource.name) || source.revision <= 1) {
    throw new SafeCliError("对照来源必须是已修改的规范 v0901 标注文件。");
  }
  const snapshotSummaries = await input.platform.listRevisionOneSnapshots(input.sourceResourceId);
  const revisionOne = snapshotSummaries.filter(({ revision }) => revision === 1);
  if (revisionOne.length !== 1) {
    throw new SafeCliError(`对照来源的 revision 1 恢复快照数量为 ${revisionOne.length}，要求恰好一个。`);
  }
  const snapshot = await input.platform.getRecoverySnapshot(input.sourceResourceId, revisionOne[0]!.id);
  if (snapshot.annotationFileId !== input.sourceResourceId || snapshot.revision !== 1) {
    throw new SafeCliError("对照来源的 revision 1 恢复快照身份不匹配。");
  }
  const base = normalizePlatformProjectPayload(snapshot.payload);
  const platform = normalizePlatformProjectPayload(source.payload);
  const targetName = source.resource.name.replace(/_v0901_/iu, "_v0902_");
  const localFiles = await discoverLocalV0902Files(path.resolve(input.sourceDirectory));
  const incomingMatches = localFiles.filter(({ name }) => name === targetName);
  if (incomingMatches.length !== 1) {
    throw new SafeCliError(`本地对照文件 ${targetName} 数量为 ${incomingMatches.length}，要求恰好一个。`);
  }
  const incoming = (await readLocalV0902File(incomingMatches[0]!)).project;
  const merge = mergeProjectPlatformFirst({ base, platform, incoming });
  if (!merge.ok) {
    throw new SafeCliError(`三方对照无法安全合并：${merge.issues.join("；")}`);
  }
  const references = [
    {
      kind: "原始 v0901",
      name: `对照_1_原始v0901__${source.resource.name}`,
      payload: base,
    },
    {
      kind: "平台修改 v0901",
      name: `对照_2_平台修改v0901__${source.resource.name}`,
      payload: platform,
    },
    {
      kind: "本地 v0902",
      name: `对照_3_本地v0902__${targetName}`,
      payload: incoming,
    },
  ];
  const children = await input.platform.listResources({
    view: "children",
    parentId: input.testProjectId,
  });
  const existingByName = new Map(children.map((child) => [child.name, child]));
  const verifiedExisting = new Map<string, AnnotationFile>();
  // 在创建第一项之前验证全部冲突，确保名称占用不会留下半套对照文件。
  for (const reference of references) {
    const existing = existingByName.get(reference.name);
    if (!existing) continue;
    if (existing.type !== "annotation_file") {
      throw new SafeCliError(`测试项目中的对照名称已被非标注资源占用：${reference.name}`);
    }
    const file = await input.platform.getAnnotationFile(existing.id);
    if (file.resource.parentId !== input.testProjectId ||
      file.mediaResourceId !== source.mediaResourceId ||
      hashJson(normalizePlatformProjectPayload(file.payload)) !== hashJson(reference.payload)) {
      throw new SafeCliError(`测试项目中的既有对照与预期不一致，禁止覆盖：${reference.name}`);
    }
    verifiedExisting.set(reference.name, file);
  }

  const files = [];
  for (const reference of references) {
    const file = verifiedExisting.get(reference.name) ?? await input.platform.createAnnotation(
      input.testProjectId,
      reference.name,
      reference.payload,
      source.mediaResourceId,
    );
    files.push({
      kind: reference.kind,
      resourceId: file.resource.id,
      name: file.resource.name,
      revision: file.revision,
      hash: hashJson(normalizePlatformProjectPayload(file.payload)),
      reused: verifiedExisting.has(reference.name),
    });
  }
  return {
    ok: true,
    sourceResourceId: input.sourceResourceId,
    testProjectId: input.testProjectId,
    mediaResourceId: source.mediaResourceId,
    topLevelSources: classifyTopLevelSources({
      base,
      platform,
      incoming,
      merged: merge.project,
    }),
    focusedAudit: buildFocusedMergeAudit({
      base,
      platform,
      incoming,
      merged: merge.project,
    }),
    files,
  };
}

type FieldSource = "三方相同" | "v0902" | "平台修改" | "平台区间联动" |
  "平台与v0902相同" | "冲突取平台";

function buildFocusedMergeAudit(input: {
  base: ProjectData;
  platform: ProjectData;
  incoming: ProjectData;
  merged: ProjectData;
}) {
  const characterMaps = [input.base, input.platform, input.incoming]
    .map((project) => new Map(project.characterAnnotations.map((item) => [item.id, item])));
  const baseCharacterIds = new Set(characterMaps[0]!.keys());
  const platformCharacterIds = new Set(characterMaps[1]!.keys());
  const incomingCharacterIds = new Set(characterMaps[2]!.keys());
  const sharedPlatformIncomingIds = [...platformCharacterIds]
    .filter((id) => incomingCharacterIds.has(id));
  const characterFields = [];
  const characterGroups = [input.base, input.platform, input.incoming, input.merged]
    .map((project) => groupCharacterAuditByLine(project.characterAnnotations));
  const characterLineIds = [...new Set(characterGroups.flatMap((groups) => [...groups.keys()]))];
  const structuralChanges = [];
  for (const lineId of characterLineIds) {
    const baseGroup = characterGroups[0]!.get(lineId) ?? [];
    const platformGroup = characterGroups[1]!.get(lineId) ?? [];
    const incomingGroup = characterGroups[2]!.get(lineId) ?? [];
    const mergedGroup = characterGroups[3]!.get(lineId) ?? [];
    if (platformGroup.length !== baseGroup.length || incomingGroup.length !== baseGroup.length) {
      const source = platformGroup.length !== baseGroup.length ? "平台修改" : "v0902";
      const expected = source === "平台修改" ? platformGroup : incomingGroup;
      // 结构审计只核对该句拥有的字序列。合并结果会在平台 id 未改时采用
      // v0902 重建的字符 id，而每个字的时间等叶子字段仍各自按三方规则合并。
      const expectedCharacters = expected.map(({ char }) => char);
      const mergedCharacters = mergedGroup.map(({ char }) => char);
      structuralChanges.push({
        lineId,
        source,
        base: `${baseGroup.length}:${baseGroup.map(({ char }) => char).join("")}`,
        platform: `${platformGroup.length}:${platformGroup.map(({ char }) => char).join("")}`,
        v0902: `${incomingGroup.length}:${incomingGroup.map(({ char }) => char).join("")}`,
        merged: `${mergedGroup.length}:${mergedGroup.map(({ char }) => char).join("")}`,
        expectedApplied: valuesEqual(mergedCharacters, expectedCharacters),
      });
      continue;
    }
    for (let ordinal = 0; ordinal < baseGroup.length; ordinal += 1) {
      const item = baseGroup[ordinal]!;
      const platformItem = platformGroup[ordinal]!;
      const incomingItem = incomingGroup[ordinal]!;
      const mergedItem = mergedGroup[ordinal];
      if (!mergedItem) continue;
      const platformChangedTimeRange = !valuesEqual(item.startTime, platformItem.startTime) ||
        !valuesEqual(item.endTime, platformItem.endTime);
      for (const field of ["startTime", "endTime"] as const) {
        const source = platformChangedTimeRange &&
            valuesEqual(item[field], platformItem[field]) &&
            !valuesEqual(item[field], incomingItem[field])
          ? "平台区间联动"
          : classifyFieldSource(item[field], platformItem[field], incomingItem[field]);
        characterFields.push({
          id: incomingItem.id,
          char: mergedItem.char,
          lineId: item.lineId,
          ordinal: ordinal + 1,
          field,
          source,
          base: item[field],
          platform: platformItem[field],
          v0902: incomingItem[field],
          merged: mergedItem[field],
          expected: platformChangedTimeRange ? platformItem[field]
            : source === "v0902" ? incomingItem[field]
            : source === "三方相同" ? item[field]
              : platformItem[field],
        });
      }
    }
  }

  const sentenceMaps = [input.base, input.platform, input.incoming, input.merged]
    .map((project) => new Map(project.subtitleLines.map((item) => [item.id, item])));
  const sentenceFields = [];
  for (const item of input.base.subtitleLines) {
    const platformItem = sentenceMaps[1]!.get(item.id);
    const incomingItem = sentenceMaps[2]!.get(item.id);
    const mergedItem = sentenceMaps[3]!.get(item.id);
    if (!platformItem || !incomingItem || !mergedItem) continue;
    for (const field of ["deliveryMode", "roleTypes"] as const) {
      const source = classifyFieldSource(item[field], platformItem[field], incomingItem[field]);
      const expected = source === "v0902" ? incomingItem[field]
        : source === "三方相同" ? item[field]
          : platformItem[field];
      sentenceFields.push({
        id: item.id,
        text: item.text,
        startTime: item.startTime,
        field,
        source,
        base: item[field],
        platform: platformItem[field],
        v0902: incomingItem[field],
        merged: mergedItem[field],
        expected,
      });
    }
  }
  const summarize = <T extends { source: FieldSource; merged: unknown; expected: unknown }>(rows: T[]) => ({
    fieldCountBySource: countFieldSources(rows),
    allExpectedValuesApplied: rows.every(({ merged, expected }) => valuesEqual(merged, expected)),
    platformExamples: rows.filter(({ source }) =>
      source === "平台修改" || source === "平台区间联动" ||
      source === "冲突取平台").slice(0, 20),
    v0902Examples: rows.filter(({ source }) => source === "v0902").slice(0, 20),
  });
  return {
    characterTiming: {
      collectionCounts: {
        base: input.base.characterAnnotations.length,
        platform: input.platform.characterAnnotations.length,
        v0902: input.incoming.characterAnnotations.length,
        merged: input.merged.characterAnnotations.length,
        sharedPlatformIncomingIds: sharedPlatformIncomingIds.length,
        sharedAllThreeIds: sharedPlatformIncomingIds.filter((id) => baseCharacterIds.has(id)).length,
      },
      samples: {
        base: input.base.characterAnnotations.slice(0, 8).map(characterAuditSample),
        platform: input.platform.characterAnnotations.slice(0, 8).map(characterAuditSample),
        v0902: input.incoming.characterAnnotations.slice(0, 8).map(characterAuditSample),
        merged: input.merged.characterAnnotations.slice(0, 16).map(characterAuditSample),
      },
      structuralChanges,
      ...summarize(characterFields),
      allStructuralChangesApplied: structuralChanges.every(({ expectedApplied }) => expectedApplied),
    },
    sentenceClassification: summarize(sentenceFields),
  };
}

function groupCharacterAuditByLine(items: ProjectData["characterAnnotations"]) {
  const groups = new Map<string, ProjectData["characterAnnotations"]>();
  for (const item of items) {
    const group = groups.get(item.lineId) ?? [];
    group.push(item);
    groups.set(item.lineId, group);
  }
  return groups;
}

function characterAuditSample(item: ProjectData["characterAnnotations"][number]) {
  return {
    id: item.id,
    lineId: item.lineId,
    char: item.char,
    startTime: item.startTime,
    endTime: item.endTime,
  };
}

function classifyFieldSource(base: unknown, platform: unknown, incoming: unknown): FieldSource {
  if (valuesEqual(platform, base)) return valuesEqual(incoming, base) ? "三方相同" : "v0902";
  if (valuesEqual(incoming, base)) return "平台修改";
  if (valuesEqual(platform, incoming)) return "平台与v0902相同";
  return "冲突取平台";
}

function countFieldSources<T extends { source: FieldSource }>(rows: T[]) {
  const counts: Record<FieldSource, number> = {
    "三方相同": 0,
    "v0902": 0,
    "平台修改": 0,
    "平台区间联动": 0,
    "平台与v0902相同": 0,
    "冲突取平台": 0,
  };
  for (const row of rows) counts[row.source] += 1;
  return counts;
}

function valuesEqual(left: unknown, right: unknown) {
  return hashJson([left]) === hashJson([right]);
}

function classifyTopLevelSources(input: {
  base: ProjectData;
  platform: ProjectData;
  incoming: ProjectData;
  merged: ProjectData;
}) {
  return Object.keys(input.base).sort().map((key) => {
    const typedKey = key as keyof ProjectData;
    const baseHash = hashJson(input.base[typedKey]);
    const platformHash = hashJson(input.platform[typedKey]);
    const incomingHash = hashJson(input.incoming[typedKey]);
    const mergedHash = hashJson(input.merged[typedKey]);
    let source: "三方相同" | "v0902" | "平台修改" | "平台与v0902相同" | "冲突取平台" | "字段级混合";
    if (platformHash === baseHash && incomingHash === baseHash) source = "三方相同";
    else if (platformHash === baseHash) source = "v0902";
    else if (incomingHash === baseHash) source = "平台修改";
    else if (platformHash === incomingHash) source = "平台与v0902相同";
    else if (mergedHash === platformHash) source = "冲突取平台";
    else source = "字段级混合";
    return { field: key, source };
  });
}

class MergeStateFile {
  private constructor(
    private readonly filePath: string,
    private value: PlatformV0902MergeState,
    private readonly lockHandle: Awaited<ReturnType<typeof open>>,
  ) {}

  static async open(filePath: string, plan: PlatformV0902MergePlan) {
    const absolute = path.resolve(filePath);
    const lockPath = `${absolute}.lock`;
    await mkdir(path.dirname(absolute), { recursive: true });
    let lockHandle: Awaited<ReturnType<typeof open>>;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const owner = (await readFile(lockPath, "utf8").catch(() => "")).trim();
      const ownerHint = owner ? ` 锁记录：${owner}` : "";
      throw new SafeCliError(
        `状态文件锁已存在；禁止并发执行同一计划。请先确认原进程已经退出，再按手册移动锁文件：${lockPath}。${ownerHint}`,
      );
    }
    try {
      await lockHandle.writeFile(`${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        planFingerprint: plan.fingerprint,
      })}\n`, "utf8");
      await lockHandle.sync();
      let state: PlatformV0902MergeState;
      try {
        state = parsePlatformV0902MergeState(JSON.parse(await readFile(absolute, "utf8")), plan);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        state = {
          version: PLATFORM_V0902_MERGE_STATE_VERSION,
          planFingerprint: plan.fingerprint,
          rows: Object.fromEntries(plan.rows
            .filter(({ action }) => action !== "skipped" && action !== "blocked")
            .map((row) => [row.resourceId, {
              resourceId: row.resourceId,
              operationId: randomUUID(),
              status: "pending",
              expectedBaseRevision: row.currentRevision,
              mergedHash: row.mergedHash ?? "",
              targetName: row.targetName,
            }])),
        };
        await writeJsonAtomically(absolute, state);
      }
      return new MergeStateFile(absolute, state, lockHandle);
    } catch (error) {
      await lockHandle.close();
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  get(resourceId: string) {
    const row = this.value.rows[resourceId];
    if (!row) throw new SafeCliError(`状态文件缺少资源 ${resourceId}。`);
    return row;
  }

  async update(row: PlatformV0902MergeStateRow) {
    this.value = { ...this.value, rows: { ...this.value.rows, [row.resourceId]: row } };
    await writeJsonAtomically(this.filePath, this.value);
  }

  async close() {
    await this.lockHandle.close();
    await unlink(`${this.filePath}.lock`).catch(() => undefined);
  }
}

async function scanAllActiveResources(platform: HttpPlatformMergePort) {
  const roots = await platform.listResources({ view: "all_projects" });
  const resources: Resource[] = [...roots];
  const paths = new Map(roots.map((root) => [root.id, root.name]));
  const queue = roots.filter(({ type }) => type === "project" || type === "folder");
  const visited = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent.id)) throw new SafeCliError(`资源树出现循环：${parent.id}`);
    visited.add(parent.id);
    const children = await platform.listResources({ view: "children", parentId: parent.id });
    for (const child of children) {
      resources.push(child);
      paths.set(child.id, `${paths.get(parent.id) ?? parent.name} / ${child.name}`);
      if (child.type === "project" || child.type === "folder") queue.push(child);
      if (resources.length > MAX_PLATFORM_V0902_SCAN_RESOURCES) {
        throw new SafeCliError("活动资源树超过安全扫描上限。");
      }
    }
  }
  return { resources, paths };
}

async function discoverLocalV0902Files(directory: string): Promise<LocalJsonPath[]> {
  const root = await stat(directory).catch(() => null);
  if (!root?.isDirectory()) throw new SafeCliError(`本地 v0902 目录不存在：${directory}`);
  const files: LocalJsonPath[] = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new SafeCliError(`本地目录不允许符号链接：${absolutePath}`);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      if (!/^\d+_v0902_.+\.json$/iu.test(entry.name)) continue;
      files.push({
        name: entry.name,
        absolutePath,
        relativePath: path.relative(directory, absolutePath),
      });
      if (files.length > 1_000) throw new SafeCliError("本地 JSON 数量超过安全上限 1000。");
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readLocalV0902File(file: LocalJsonPath): Promise<LocalJson> {
  const text = await readFile(file.absolutePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SafeCliError(`本地 JSON 无法解析：${file.absolutePath}`);
  }
  let project: ProjectData;
  try {
    project = normalizePlatformProjectPayload(raw);
  } catch (error) {
    throw new SafeCliError(`本地 JSON 无法规范化：${file.absolutePath}：${describeError(error)}`);
  }
  return {
    ...file,
    rawHash: hashJson(raw),
    project,
    projectHash: hashJson(project),
  };
}

async function readPlannedLocalFile(sourceDirectory: string, row: PlatformV0902MergePlanRow) {
  const absolute = path.resolve(sourceDirectory, row.sourceRelativePath);
  const root = `${path.resolve(sourceDirectory)}${path.sep}`;
  if (!absolute.startsWith(root)) throw new SafeCliError("计划中的本地路径越过 source directory。");
  const file = await stat(absolute);
  if (!file.isFile()) throw new SafeCliError(`计划本地路径不是普通文件：${absolute}`);
  const raw = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  const project = normalizePlatformProjectPayload(raw);
  return { project, projectHash: hashJson(project) };
}

async function assertNoSiblingNameCollision(
  platform: HttpPlatformMergePort,
  row: PlatformV0902MergePlanRow,
) {
  const siblings = await platform.listResources({ view: "children", parentId: row.parentId });
  const collisions = siblings.filter((resource) =>
    resource.id !== row.resourceId && resource.name === row.targetName);
  if (collisions.length > 0) {
    throw new SafeCliError(`${row.platformPath} 同级出现目标名称冲突：${collisions.map(({ id }) => id).join("、")}`);
  }
}

async function writeJsonAtomically(filePath: string, value: unknown) {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, absolute);
}

function parseArguments(args: string[]): Command {
  const mode = args.shift() as Mode | undefined;
  if (mode !== "dry-run" && mode !== "execute" && mode !== "verify" &&
    mode !== "live-test" && mode !== "add-test-references") {
    throw new SafeCliError(usage());
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new SafeCliError(usage());
    }
    if (values.has(key)) throw new SafeCliError(`参数重复：${key}`);
    values.set(key, value);
  }
  const allowed = new Set([
    "--base-url",
    "--account",
    "--source-dir",
    "--plan",
    "--state",
    "--plan-fingerprint",
    "--resource-id",
    "--test-project-id",
  ]);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new SafeCliError(`未知参数：${unknown.join("、")}`);
  const baseUrl = normalizeBaseUrl(required(values, "--base-url"));
  const accountName = required(values, "--account");
  const sourceDirectory = values.get("--source-dir") ?? null;
  const planPath = values.get("--plan") ?? null;
  const statePath = values.get("--state") ?? (planPath ? `${planPath}.state.json` : null);
  const planFingerprint = values.get("--plan-fingerprint") ?? null;
  const sourceResourceId = values.get("--resource-id") ?? null;
  const testProjectId = values.get("--test-project-id") ?? null;
  if (mode === "dry-run" && (!sourceDirectory || !planPath || planFingerprint ||
    values.has("--state") || testProjectId)) {
    throw new SafeCliError("dry-run 要求 --source-dir 和 --plan，且不接受 --state/--plan-fingerprint。");
  }
  if ((mode === "execute" || mode === "verify") &&
    (!planPath || !statePath || !/^[a-f0-9]{64}$/u.test(planFingerprint ?? "") ||
      sourceDirectory || sourceResourceId || testProjectId)) {
    throw new SafeCliError("execute/verify 要求 --plan、--state、--plan-fingerprint，且不接受 --source-dir。");
  }
  if (mode === "live-test" && (!sourceDirectory || planPath || values.has("--state") ||
    planFingerprint || testProjectId)) {
    throw new SafeCliError("live-test 要求 --source-dir，可选 --resource-id，且不接受计划/状态参数。");
  }
  if (mode === "add-test-references" && (!sourceDirectory || !sourceResourceId || !testProjectId ||
    planPath || values.has("--state") || planFingerprint)) {
    throw new SafeCliError(
      "add-test-references 要求 --source-dir、--resource-id、--test-project-id，且不接受计划/状态参数。",
    );
  }
  return {
    mode,
    baseUrl,
    accountName,
    sourceDirectory,
    planPath,
    statePath,
    planFingerprint,
    sourceResourceId,
    testProjectId,
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
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new SafeCliError("远程平台必须使用 HTTPS；仅 loopback 允许 HTTP。");
  }
  return url.toString().replace(/\/$/u, "");
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw new SafeCliError(`缺少参数 ${key}。`);
  return value;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usage() {
  return "用法：platform-merge:v0902 -- dry-run|execute|verify|live-test --base-url <https://站点/api> --account <超管账号> ...；密码从 stdin 读取。";
}

run().catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode = 1;
});
