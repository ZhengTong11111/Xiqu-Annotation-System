import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PLATFORM_VOD_IMPORT_STATE_VERSION = 1;
export const PLATFORM_VOD_IMPORT_PLAN_VERSION = 1;
export const MAX_PLATFORM_VOD_IMPORT_ROWS = 300;

const REQUIRED_COLUMNS = ["project_name", "video_path", "json_path"] as const;
const OPTIONAL_COLUMNS = ["video_name", "json_name", "vod_title"] as const;
const ALLOWED_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

export type PlatformResource = {
  id: string;
  parentId: string | null;
  type: "project" | "folder" | "media_file" | "annotation_file";
  name: string;
  mediaSourceType?: "uploaded" | "aliyun_vod" | null;
  mediaKind?: "video" | "audio" | null;
};

export type AnnotationBinding =
  | { status: "bound"; mediaResourceId: string }
  | { status: "unbound" };

export type VodVideoStatus =
  | "Uploading"
  | "UploadFail"
  | "UploadSucc"
  | "Transcoding"
  | "TranscodeFail"
  | "Blocked"
  | "Normal";

export type VodVideo = {
  videoId: string;
  referenceId: string;
  status: VodVideoStatus;
  title: string;
};

export type VodUploadCheckpoint = {
  file: string;
  name: string;
  fileSize: number;
  partSize: number;
  uploadId: string;
  doneParts: Array<{ number: number; etag: string }>;
};

export type ImportStateRow = {
  rowIdentity: string;
  videoSha256: string | null;
  jsonSha256: string | null;
  vodReferenceId: string | null;
  projectResourceId?: string;
  vodVideoId?: string;
  uploadCheckpoint?: VodUploadCheckpoint | null;
  mediaResourceId?: string;
  annotationResourceId?: string;
  completedAt?: string;
};

export type ImportState = {
  version: typeof PLATFORM_VOD_IMPORT_STATE_VERSION;
  rows: Record<string, ImportStateRow>;
};

export type PreparedManifestRow = {
  rowNumber: number;
  rowIdentity: string;
  projectName: string;
  videoPath: string | null;
  jsonPath: string | null;
  videoIssue: string | null;
  jsonIssue: string | null;
  videoName: string;
  jsonName: string;
  vodTitle: string;
  videoSize: number | null;
  videoSha256: string | null;
  jsonSha256: string | null;
  vodReferenceId: string | null;
  payload: unknown | null;
};

export type PlatformImportPort = {
  listRootProjects(): Promise<PlatformResource[]>;
  listChildren(parentId: string): Promise<PlatformResource[]>;
  getAnnotationBinding(annotationResourceId: string): Promise<AnnotationBinding>;
  createProject(name: string): Promise<PlatformResource>;
  createVodMedia(input: {
    parentId: string;
    name: string;
    videoId: string;
  }): Promise<PlatformResource>;
  createAnnotation(input: {
    parentId: string;
    name: string;
    payload: unknown;
    mediaResourceId: string;
  }): Promise<{ resource: PlatformResource }>;
};

export type VodImportPort = {
  findByReferenceId(referenceId: string): Promise<VodVideo | null>;
  ensureNormalVideo(
    row: PreparedManifestRow,
    state: ImportStateRow | null,
    onCheckpoint: (update: {
      videoId: string;
      uploadCheckpoint: VodUploadCheckpoint | null;
    }) => Promise<void>,
  ): Promise<{ videoId: string; uploaded: boolean }>;
};

export type ImportStatePort = {
  current(): ImportState;
  update(rowIdentity: string, update: Partial<ImportStateRow>): Promise<ImportStateRow>;
};

export type ImportPlanRow = {
  rowNumber: number;
  rowIdentity: string;
  projectName: string;
  videoName: string;
  jsonName: string;
  videoPath: string | null;
  jsonPath: string | null;
  videoIssue: string | null;
  jsonIssue: string | null;
  videoSize: number | null;
  videoSha256: string | null;
  jsonSha256: string | null;
  vodReferenceId: string | null;
  project: {
    action: "create" | "reuse";
    resourceId: string | null;
  };
  video: {
    action:
      | "reuse_platform"
      | "upload_vod_and_register"
      | "reuse_vod_and_register"
      | "wait_vod_and_register"
      | "resume_vod_and_register"
      | "skip_invalid_path"
      | "blocked_existing_conflict";
    mediaResourceId: string | null;
    vodVideoId: string | null;
    vodStatus: VodVideoStatus | null;
  };
  annotation: {
    action: "create" | "reuse" | "skip_invalid_path" | "skip_no_media";
    resourceId: string | null;
  };
  warnings: string[];
  blockers: string[];
};

export type ImportPlan = {
  version: typeof PLATFORM_VOD_IMPORT_PLAN_VERSION;
  baseUrl: string;
  region: string;
  manifestPath: string;
  statePath: string;
  rows: ImportPlanRow[];
  summary: {
    rowCount: number;
    blockedRowCount: number;
    createProjectCount: number;
    uploadVodCount: number;
    registerMediaCount: number;
    createAnnotationCount: number;
    skippedVideoCount: number;
    skippedAnnotationCount: number;
  };
  fingerprint: string;
};

export type ExecuteImportResult = {
  completedRows: Array<{
    rowNumber: number;
    projectResourceId: string;
    mediaResourceId: string | null;
    annotationResourceId: string | null;
  }>;
};

export async function prepareManifest(
  csvPath: string,
  normalizePayload: (value: unknown) => unknown,
): Promise<PreparedManifestRow[]> {
  const absoluteCsvPath = path.resolve(csvPath);
  const csvDirectory = path.dirname(absoluteCsvPath);
  const text = await readFile(absoluteCsvPath, "utf8");
  const records = parseCsv(text);
  if (records.length < 2) throw new Error("CSV 必须包含表头和至少一行数据。");
  if (records.length - 1 > MAX_PLATFORM_VOD_IMPORT_ROWS) {
    throw new Error(`CSV 一次最多允许 ${MAX_PLATFORM_VOD_IMPORT_ROWS} 行。`);
  }

  const headers = records[0]!.map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/u, "").trim() : value.trim());
  if (new Set(headers).size !== headers.length) throw new Error("CSV 表头不能重复。");
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.includes(required)) throw new Error(`CSV 缺少必填列：${required}。`);
  }
  const unknownHeaders = headers.filter((header) => !ALLOWED_COLUMNS.has(header));
  if (unknownHeaders.length > 0) {
    throw new Error(`CSV 包含未知列：${unknownHeaders.join("、")}。`);
  }

  const seenProjectNames = new Set<string>();
  const prepared: PreparedManifestRow[] = [];
  for (const [dataIndex, values] of records.slice(1).entries()) {
    const rowNumber = dataIndex + 2;
    if (values.length !== headers.length) {
      throw new Error(`CSV 第 ${rowNumber} 行列数与表头不一致。`);
    }
    const record = Object.fromEntries(headers.map((header, index) => [
      header,
      values[index]?.trim() ?? "",
    ]));
    if (!record.project_name) throw new Error(`CSV 第 ${rowNumber} 行的 project_name 不能为空。`);
    const projectName = record.project_name!;
    if (seenProjectNames.has(projectName)) {
      throw new Error(`CSV 中项目名称重复：${projectName}。每个项目必须只有一行。`);
    }
    seenProjectNames.add(projectName);

    const [video, json] = await Promise.all([
      inspectVideoPath(csvDirectory, record.video_path ?? ""),
      inspectJsonPath(csvDirectory, record.json_path ?? "", normalizePayload),
    ]);
    const videoName = record.video_name || projectName;
    const jsonName = record.json_name || (json.path ? path.basename(json.path) : "");
    const vodTitle = record.vod_title || videoName;
    assertResourceName(videoName, "video_name", rowNumber);
    if (jsonName) assertResourceName(jsonName, "json_name", rowNumber);
    if (vodTitle.length > 128) throw new Error(`CSV 第 ${rowNumber} 行的 vod_title 超过 128 字符。`);
    const vodReferenceId = video.sha256 ? createVodReferenceId(video.sha256) : null;
    const rowIdentity = sha256Json({
      projectName,
      videoName,
      jsonName,
      vodTitle,
      videoPath: video.path,
      jsonPath: json.path,
      videoIssue: video.issue,
      jsonIssue: json.issue,
      videoSha256: video.sha256,
      jsonSha256: json.sha256,
      vodReferenceId,
    });
    prepared.push({
      rowNumber,
      rowIdentity,
      projectName,
      videoPath: video.path,
      jsonPath: json.path,
      videoIssue: video.issue,
      jsonIssue: json.issue,
      videoName,
      jsonName,
      vodTitle,
      videoSize: video.size,
      videoSha256: video.sha256,
      jsonSha256: json.sha256,
      vodReferenceId,
      payload: json.payload,
    });
  }
  return prepared;
}

export async function buildImportPlan(input: {
  baseUrl: string;
  region: string;
  manifestPath: string;
  statePath: string;
  rows: PreparedManifestRow[];
  platform: PlatformImportPort;
  vod: VodImportPort;
  state: ImportState;
}): Promise<ImportPlan> {
  const roots = await input.platform.listRootProjects();
  const rootsByName = groupByName(roots);
  const planRows: ImportPlanRow[] = [];

  for (const row of input.rows) {
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (row.videoIssue) warnings.push(`跳过视频：${row.videoIssue}`);
    if (row.jsonIssue) warnings.push(`跳过 JSON：${row.jsonIssue}`);
    const rootMatches = rootsByName.get(row.projectName) ?? [];
    if (rootMatches.length > 1) blockers.push("顶层项目同名候选不唯一。");
    const project = rootMatches.length === 1 ? rootMatches[0]! : null;
    const projectPlan: ImportPlanRow["project"] = project
      ? { action: "reuse", resourceId: project.id }
      : { action: "create", resourceId: null };
    let videoPlan: ImportPlanRow["video"] | null = null;
    let annotationPlan: ImportPlanRow["annotation"] = {
      action: row.jsonIssue ? "skip_invalid_path" : "create",
      resourceId: null,
    };

    if (project) {
      const children = await input.platform.listChildren(project.id);
      const videoMatches = children.filter(({ name }) => name === row.videoName);
      if (row.videoIssue) {
        if (videoMatches.length === 1 && isCompatibleVodMedia(videoMatches[0]!)) {
          videoPlan = {
            action: "reuse_platform",
            mediaResourceId: videoMatches[0]!.id,
            vodVideoId: null,
            vodStatus: null,
          };
          warnings.push("本地视频无效，但复用项目内唯一同名平台 VOD 媒体。");
        } else {
          videoPlan = skippedVideoPlan();
          if (videoMatches.length > 0) {
            warnings.push("本地视频无效，且同名平台资源不能唯一、安全复用；保持现状并跳过媒体。");
          }
        }
      } else if (videoMatches.length > 1) {
        blockers.push("项目内视频资源同名候选不唯一。");
        videoPlan = blockedVideoPlan();
      } else if (videoMatches.length === 1) {
        const media = videoMatches[0]!;
        if (!isCompatibleVodMedia(media)) {
          blockers.push("项目内同名资源不是阿里云 VOD 视频，禁止替换或复用。");
          videoPlan = blockedVideoPlan();
        } else {
          videoPlan = {
            action: "reuse_platform",
            mediaResourceId: media.id,
            vodVideoId: null,
            vodStatus: null,
          };
          warnings.push("复用同名平台 VOD 媒体；公开资源 DTO 不暴露 VideoId，无法比对本地视频哈希。");
        }
      } else {
        videoPlan = row.videoIssue
          ? skippedVideoPlan()
          : await planVodCreation(row, input.vod, input.state.rows[row.rowIdentity] ?? null, blockers);
      }

      if (!row.jsonIssue && videoPlan.action !== "skip_invalid_path" &&
        videoPlan.action !== "blocked_existing_conflict") {
        const annotationMatches = children.filter(({ name }) => name === row.jsonName);
        if (annotationMatches.length > 1) {
          blockers.push("项目内标注文件同名候选不唯一。");
        } else if (annotationMatches.length === 1) {
          const annotation = annotationMatches[0]!;
          if (annotation.type !== "annotation_file") {
            blockers.push("项目内同名资源不是标注文件，禁止覆盖。");
          } else if (!videoPlan?.mediaResourceId) {
            blockers.push("标注文件已存在，但目标媒体尚未在平台登记；禁止改绑或覆盖。");
          } else {
            const binding = await input.platform.getAnnotationBinding(annotation.id);
            if (binding.status !== "bound") {
              blockers.push("同名标注文件已存在但未绑定媒体；禁止原地改绑。");
            } else if (binding.mediaResourceId !== videoPlan.mediaResourceId) {
              blockers.push("同名标注文件已绑定其他媒体；禁止覆盖或改绑。");
            } else {
              annotationPlan = { action: "reuse", resourceId: annotation.id };
              warnings.push("复用同名标注文件；为避免下载 ProjectData，不比较服务端 JSON 内容。");
            }
          }
        }
      } else if (!row.jsonIssue) {
        annotationPlan = { action: "skip_no_media", resourceId: null };
        warnings.push("JSON 有效，但没有可复用或可创建的媒体；跳过标注文件以避免无媒体绑定。");
      }
    }
    videoPlan ??= row.videoIssue
      ? skippedVideoPlan()
      : await planVodCreation(
        row,
        input.vod,
        input.state.rows[row.rowIdentity] ?? null,
        blockers,
      );
    if (annotationPlan.action === "create" &&
      (videoPlan.action === "skip_invalid_path" || videoPlan.action === "blocked_existing_conflict")) {
      annotationPlan = { action: "skip_no_media", resourceId: null };
      warnings.push("JSON 有效，但没有可复用或可创建的媒体；跳过标注文件以避免无媒体绑定。");
    }

    planRows.push({
      rowNumber: row.rowNumber,
      rowIdentity: row.rowIdentity,
      projectName: row.projectName,
      videoName: row.videoName,
      jsonName: row.jsonName,
      videoPath: row.videoPath,
      jsonPath: row.jsonPath,
      videoIssue: row.videoIssue,
      jsonIssue: row.jsonIssue,
      videoSize: row.videoSize,
      videoSha256: row.videoSha256,
      jsonSha256: row.jsonSha256,
      vodReferenceId: row.vodReferenceId,
      project: projectPlan,
      video: videoPlan,
      annotation: annotationPlan,
      warnings,
      blockers,
    });
  }

  const summary = {
    rowCount: planRows.length,
    blockedRowCount: planRows.filter(({ blockers }) => blockers.length > 0).length,
    createProjectCount: planRows.filter(({ project }) => project.action === "create").length,
    uploadVodCount: planRows.filter(({ video }) =>
      video.action === "upload_vod_and_register" || video.action === "resume_vod_and_register").length,
    registerMediaCount: planRows.filter(({ video }) =>
      video.action !== "reuse_platform" && video.action !== "skip_invalid_path" &&
      video.action !== "blocked_existing_conflict").length,
    createAnnotationCount: planRows.filter(({ annotation }) => annotation.action === "create").length,
    skippedVideoCount: planRows.filter(({ video }) => video.action === "skip_invalid_path").length,
    skippedAnnotationCount: planRows.filter(({ annotation }) =>
      annotation.action === "skip_invalid_path" || annotation.action === "skip_no_media").length,
  };
  const unsigned: Omit<ImportPlan, "fingerprint"> = {
    version: PLATFORM_VOD_IMPORT_PLAN_VERSION,
    baseUrl: input.baseUrl.replace(/\/$/u, ""),
    region: input.region,
    manifestPath: path.resolve(input.manifestPath),
    statePath: path.resolve(input.statePath),
    rows: planRows,
    summary,
  };
  return { ...unsigned, fingerprint: sha256Json(unsigned) };
}

export async function executeImport(input: {
  rows: PreparedManifestRow[];
  platform: PlatformImportPort;
  vod: VodImportPort;
  state: ImportStatePort;
  onProgress?: (message: string) => void;
}): Promise<ExecuteImportResult> {
  const completedRows: ExecuteImportResult["completedRows"] = [];
  for (const row of input.rows) {
    input.onProgress?.(`第 ${row.rowNumber} 行：检查项目。`);
    const project = await ensureProject(row, input.platform);
    await input.state.update(row.rowIdentity, {
      projectResourceId: project.id,
      videoSha256: row.videoSha256,
      jsonSha256: row.jsonSha256,
      vodReferenceId: row.vodReferenceId,
    });

    input.onProgress?.(`第 ${row.rowNumber} 行：检查 VOD 媒体。`);
    const media = await ensureMedia(row, project.id, input.platform, input.vod, input.state);
    if (media) await input.state.update(row.rowIdentity, { mediaResourceId: media.id });

    input.onProgress?.(`第 ${row.rowNumber} 行：检查标注 JSON。`);
    const annotation = await ensureAnnotation(row, project.id, media?.id ?? null, input.platform);
    await input.state.update(row.rowIdentity, {
      ...(annotation ? { annotationResourceId: annotation.id } : {}),
      completedAt: new Date().toISOString(),
      uploadCheckpoint: null,
    });
    completedRows.push({
      rowNumber: row.rowNumber,
      projectResourceId: project.id,
      mediaResourceId: media?.id ?? null,
      annotationResourceId: annotation?.id ?? null,
    });
  }
  return { completedRows };
}

export function emptyImportState(): ImportState {
  return { version: PLATFORM_VOD_IMPORT_STATE_VERSION, rows: {} };
}

export function parseImportState(value: unknown): ImportState {
  if (!isRecord(value) || value.version !== PLATFORM_VOD_IMPORT_STATE_VERSION || !isRecord(value.rows)) {
    throw new Error("批量导入状态文件格式不正确。");
  }
  const rows: Record<string, ImportStateRow> = {};
  for (const [identity, raw] of Object.entries(value.rows)) {
    if (!/^[a-f0-9]{64}$/u.test(identity) || !isRecord(raw)) {
      throw new Error("批量导入状态文件包含无效行身份。");
    }
    const videoSha256 = nullableSha256(raw.videoSha256, "videoSha256");
    const jsonSha256 = nullableSha256(raw.jsonSha256, "jsonSha256");
    const vodReferenceId = nullableString(raw.vodReferenceId, "vodReferenceId");
    rows[identity] = {
      rowIdentity: identity,
      videoSha256,
      jsonSha256,
      vodReferenceId,
      ...(optionalString(raw.projectResourceId) ? { projectResourceId: raw.projectResourceId as string } : {}),
      ...(optionalString(raw.vodVideoId) ? { vodVideoId: raw.vodVideoId as string } : {}),
      ...(raw.uploadCheckpoint === null ? { uploadCheckpoint: null } : {}),
      ...(optionalString(raw.mediaResourceId) ? { mediaResourceId: raw.mediaResourceId as string } : {}),
      ...(optionalString(raw.annotationResourceId)
        ? { annotationResourceId: raw.annotationResourceId as string }
        : {}),
      ...(optionalString(raw.completedAt) ? { completedAt: raw.completedAt as string } : {}),
    };
    if (raw.uploadCheckpoint !== undefined && raw.uploadCheckpoint !== null) {
      rows[identity]!.uploadCheckpoint = parseCheckpoint(raw.uploadCheckpoint);
    }
  }
  return { version: PLATFORM_VOD_IMPORT_STATE_VERSION, rows };
}

export function createVodReferenceId(videoSha256: string) {
  if (!/^[a-f0-9]{64}$/u.test(videoSha256)) throw new Error("视频 SHA-256 不正确。");
  return `xiqu_${videoSha256.slice(0, 59)}`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0) throw new Error("CSV 引号只能出现在字段开头。");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号。");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows.filter((values, index) =>
    index === 0 || values.some((value) => value.trim().length > 0));
}

async function planVodCreation(
  row: PreparedManifestRow,
  vod: VodImportPort,
  state: ImportStateRow | null,
  blockers: string[],
): Promise<ImportPlanRow["video"]> {
  if (!row.vodReferenceId) throw new Error(`第 ${row.rowNumber} 行：有效视频缺少 VOD ReferenceId。`);
  const existing = await vod.findByReferenceId(row.vodReferenceId);
  if (!existing) {
    return {
      action: "upload_vod_and_register",
      mediaResourceId: null,
      vodVideoId: null,
      vodStatus: null,
    };
  }
  if (existing.status === "Normal") {
    return {
      action: "reuse_vod_and_register",
      mediaResourceId: null,
      vodVideoId: existing.videoId,
      vodStatus: existing.status,
    };
  }
  if (existing.status === "UploadSucc" || existing.status === "Transcoding") {
    return {
      action: "wait_vod_and_register",
      mediaResourceId: null,
      vodVideoId: existing.videoId,
      vodStatus: existing.status,
    };
  }
  if (existing.status === "Uploading" || existing.status === "UploadFail") {
    if (state?.vodVideoId === existing.videoId && state.uploadCheckpoint) {
      return {
        action: "resume_vod_and_register",
        mediaResourceId: null,
        vodVideoId: existing.videoId,
        vodStatus: existing.status,
      };
    }
    blockers.push("同一 ReferenceId 的 VOD 媒资处于未完成上传状态，但本地没有所属断点；为避免并发覆写，拒绝接管。");
    return {
      action: "wait_vod_and_register",
      mediaResourceId: null,
      vodVideoId: existing.videoId,
      vodStatus: existing.status,
    };
  }
  blockers.push(`同一 ReferenceId 的 VOD 媒资状态为 ${existing.status}，禁止覆盖或重建。`);
  return {
    action: "wait_vod_and_register",
    mediaResourceId: null,
    vodVideoId: existing.videoId,
    vodStatus: existing.status,
  };
}

function skippedVideoPlan(): ImportPlanRow["video"] {
  return {
    action: "skip_invalid_path",
    mediaResourceId: null,
    vodVideoId: null,
    vodStatus: null,
  };
}

function blockedVideoPlan(): ImportPlanRow["video"] {
  return {
    action: "blocked_existing_conflict",
    mediaResourceId: null,
    vodVideoId: null,
    vodStatus: null,
  };
}

async function ensureProject(row: PreparedManifestRow, platform: PlatformImportPort) {
  const matches = (await platform.listRootProjects()).filter(({ name }) => name === row.projectName);
  if (matches.length > 1) throw new Error(`第 ${row.rowNumber} 行：顶层项目同名候选不唯一。`);
  if (matches.length === 1) return matches[0]!;
  try {
    return await platform.createProject(row.projectName);
  } catch {
    const after = (await platform.listRootProjects()).filter(({ name }) => name === row.projectName);
    if (after.length === 1) return after[0]!;
    throw new Error(`第 ${row.rowNumber} 行：创建项目失败，且无法确认服务器是否已提交。`);
  }
}

async function ensureMedia(
  row: PreparedManifestRow,
  projectResourceId: string,
  platform: PlatformImportPort,
  vod: VodImportPort,
  state: ImportStatePort,
) {
  const matches = (await platform.listChildren(projectResourceId)).filter(({ name }) => name === row.videoName);
  if (row.videoIssue || !row.videoPath || !row.videoSha256 || !row.vodReferenceId || row.videoSize === null) {
    if (matches.length === 1 && isCompatibleVodMedia(matches[0]!)) return matches[0]!;
    return null;
  }
  if (matches.length > 1) throw new Error(`第 ${row.rowNumber} 行：项目内视频同名候选不唯一。`);
  if (matches.length === 1) {
    if (!isCompatibleVodMedia(matches[0]!)) {
      throw new Error(`第 ${row.rowNumber} 行：同名资源不是阿里云 VOD 视频，拒绝覆盖。`);
    }
    return matches[0]!;
  }

  const currentState = state.current().rows[row.rowIdentity] ?? null;
  const ensured = await vod.ensureNormalVideo(row, currentState, async (update) => {
    await state.update(row.rowIdentity, {
      vodVideoId: update.videoId,
      uploadCheckpoint: update.uploadCheckpoint,
      videoSha256: row.videoSha256,
      jsonSha256: row.jsonSha256,
      vodReferenceId: row.vodReferenceId,
    });
  });
  await state.update(row.rowIdentity, {
    vodVideoId: ensured.videoId,
    uploadCheckpoint: null,
  });
  try {
    return await platform.createVodMedia({
      parentId: projectResourceId,
      name: row.videoName,
      videoId: ensured.videoId,
    });
  } catch {
    throw new Error(
      `第 ${row.rowNumber} 行：登记平台 VOD 媒体失败或响应不明确；不会猜测提交结果，请重新 dry-run。`,
    );
  }
}

async function ensureAnnotation(
  row: PreparedManifestRow,
  projectResourceId: string,
  mediaResourceId: string | null,
  platform: PlatformImportPort,
) {
  if (row.jsonIssue || !row.jsonPath || !row.jsonName || row.payload === null) return null;
  if (!mediaResourceId) return null;
  const matches = (await platform.listChildren(projectResourceId)).filter(({ name }) => name === row.jsonName);
  if (matches.length > 1) throw new Error(`第 ${row.rowNumber} 行：项目内标注同名候选不唯一。`);
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (existing.type !== "annotation_file") {
      throw new Error(`第 ${row.rowNumber} 行：同名资源不是标注文件，拒绝覆盖。`);
    }
    const binding = await platform.getAnnotationBinding(existing.id);
    if (binding.status !== "bound" || binding.mediaResourceId !== mediaResourceId) {
      throw new Error(`第 ${row.rowNumber} 行：同名标注已存在但媒体绑定不一致，拒绝覆盖或改绑。`);
    }
    return existing;
  }
  try {
    return (await platform.createAnnotation({
      parentId: projectResourceId,
      name: row.jsonName,
      payload: row.payload,
      mediaResourceId,
    })).resource;
  } catch {
    throw new Error(
      `第 ${row.rowNumber} 行：创建标注失败或响应不明确；不会猜测提交结果，请重新 dry-run。`,
    );
  }
}

async function inspectVideoPath(directory: string, rawPath: string): Promise<{
  path: string | null;
  issue: string | null;
  size: number | null;
  sha256: string | null;
}> {
  if (!rawPath) return { path: null, issue: "video_path 为空。", size: null, sha256: null };
  const resolved = resolveManifestPath(directory, rawPath);
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      return { path: resolved, issue: "video_path 不是普通文件。", size: null, sha256: null };
    }
    if (info.size <= 0) {
      return { path: resolved, issue: "视频文件为空。", size: 0, sha256: null };
    }
    return { path: resolved, issue: null, size: info.size, sha256: await sha256File(resolved) };
  } catch {
    return { path: resolved, issue: "video_path 不存在或不可读取。", size: null, sha256: null };
  }
}

async function inspectJsonPath(
  directory: string,
  rawPath: string,
  normalizePayload: (value: unknown) => unknown,
): Promise<{
  path: string | null;
  issue: string | null;
  sha256: string | null;
  payload: unknown | null;
}> {
  if (!rawPath) return { path: null, issue: "json_path 为空。", sha256: null, payload: null };
  const resolved = resolveManifestPath(directory, rawPath);
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      return { path: resolved, issue: "json_path 不是普通文件。", sha256: null, payload: null };
    }
    const text = await readFile(resolved, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { path: resolved, issue: "JSON 文件无法解析。", sha256: null, payload: null };
    }
    if (!isProjectFileLike(parsed)) {
      return { path: resolved, issue: "JSON 不是可识别的标注项目文件。", sha256: null, payload: null };
    }
    let payload: unknown;
    try {
      payload = normalizePayload(parsed);
    } catch {
      return { path: resolved, issue: "JSON 项目规范化失败。", sha256: null, payload: null };
    }
    return { path: resolved, issue: null, sha256: await sha256File(resolved), payload };
  } catch {
    return { path: resolved, issue: "json_path 不存在或不可读取。", sha256: null, payload: null };
  }
}

function isProjectFileLike(value: unknown) {
  if (!isRecord(value)) return false;
  if (isRecord(value.project)) return true;
  return [
    "video",
    "videoUrl",
    "subtitleLines",
    "characterAnnotations",
    "builtinTracks",
    "customTracks",
  ].some((key) => key in value);
}

function resolveManifestPath(directory: string, value: string) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(directory, value);
}

function assertResourceName(value: string, column: string, rowNumber: number) {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`CSV 第 ${rowNumber} 行的 ${column} 不是有效资源名称。`);
  }
}

function isCompatibleVodMedia(resource: PlatformResource) {
  return resource.type === "media_file" &&
    resource.mediaSourceType === "aliyun_vod" &&
    resource.mediaKind === "video";
}

function groupByName(resources: PlatformResource[]) {
  const grouped = new Map<string, PlatformResource[]>();
  for (const resource of resources) {
    const matches = grouped.get(resource.name) ?? [];
    matches.push(resource);
    grouped.set(resource.name, matches);
  }
  return grouped;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function parseCheckpoint(value: unknown): VodUploadCheckpoint {
  if (!isRecord(value) ||
    !optionalString(value.file) ||
    !optionalString(value.name) ||
    typeof value.fileSize !== "number" ||
    typeof value.partSize !== "number" ||
    !optionalString(value.uploadId) ||
    !Array.isArray(value.doneParts)) {
    throw new Error("批量导入状态文件包含无效上传断点。");
  }
  const doneParts = value.doneParts.map((part) => {
    if (!isRecord(part) || typeof part.number !== "number" || !optionalString(part.etag)) {
      throw new Error("批量导入状态文件包含无效分片断点。");
    }
    return { number: part.number, etag: part.etag as string };
  });
  return {
    file: value.file as string,
    name: value.name as string,
    fileSize: value.fileSize,
    partSize: value.partSize,
    uploadId: value.uploadId as string,
    doneParts,
  };
}

function nullableSha256(value: unknown, name: string) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`批量导入状态文件的 ${name} 不正确。`);
  }
  return value;
}

function nullableString(value: unknown, name: string) {
  if (value === null) return null;
  if (!optionalString(value)) throw new Error(`批量导入状态文件的 ${name} 不正确。`);
  return value;
}

function optionalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
