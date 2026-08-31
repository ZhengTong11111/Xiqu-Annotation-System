import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";

export const MAX_BATCH_ANNOTATION_FILES = 300;
export const MAX_BATCH_IMPORT_RESOURCE_PAGES = 25;

export type BatchAnnotationImportSource<TProject> = {
  fileName: string;
  project: TProject | null;
  parseError?: string;
};

export type BatchAnnotationImportPlanStatus =
  | "ready"
  | "parse_error"
  | "missing_number"
  | "duplicate_file_name"
  | "missing_container"
  | "container_permission_denied"
  | "ambiguous_container"
  | "missing_video"
  | "video_permission_denied"
  | "ambiguous_video";

type BatchAnnotationImportContainerPlanStatus =
  | Exclude<BatchAnnotationImportPlanStatus, "ready" | "missing_video" | "video_permission_denied" | "ambiguous_video">
  | "container_ready";

export type BatchAnnotationImportContainerPlanRow<TProject> = {
  index: number;
  fileName: string;
  number: string | null;
  project: TProject | null;
  status: BatchAnnotationImportContainerPlanStatus;
  container: ResourceEntry | null;
  containerCandidateNames: string[];
  detail: string | null;
};

export type BatchAnnotationImportPlanRow<TProject> = {
  index: number;
  fileName: string;
  number: string | null;
  project: TProject | null;
  status: BatchAnnotationImportPlanStatus;
  container: ResourceEntry | null;
  containerCandidateNames: string[];
  media: ResourceEntry | null;
  mediaCandidateNames: string[];
  detail: string | null;
};

export class BatchImportResourceScanLimitError extends Error {}

// 编号是文件名最开头的连续 ASCII 数字。保留前导零，避免 001、01、1 被错误视为同一资源。
export function getLeadingImportNumber(fileName: string): string | null {
  return /^(\d+)/u.exec(fileName)?.[1] ?? null;
}

// 唯一匹配不能建立在不完整分页上。调用方分别以 project/folder/media 类型查询，collector 只负责
// 完整消费一个有界查询并去重；超过 5,000 个候选时要求用户拆分资源结构后重试。
export async function collectBatchImportResources(
  fetchPage: (cursor: string | null) => Promise<ResourceListPage>,
  accepts: (resource: ResourceEntry) => boolean,
  scopeLabel: string,
  maxPages = MAX_BATCH_IMPORT_RESOURCE_PAGES,
): Promise<ResourceEntry[]> {
  const resources: ResourceEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchPage(cursor);
    for (const resource of page.items) {
      if (!accepts(resource) || seen.has(resource.id)) continue;
      seen.add(resource.id);
      resources.push(resource);
    }
    cursor = page.nextCursor;
    if (!cursor) return resources;
  }

  throw new BatchImportResourceScanLimitError(
    `${scopeLabel}超过 ${maxPages * 200} 项，无法在有界扫描内确认编号唯一性。请整理目录后重试。`,
  );
}

export function buildBatchAnnotationImportContainerPlan<TProject>(
  sources: readonly BatchAnnotationImportSource<TProject>[],
  containers: readonly ResourceEntry[],
): BatchAnnotationImportContainerPlanRow<TProject>[] {
  const duplicateFileNames = countValues(sources.map(({ fileName }) => fileName));
  const containersByNumber = new Map<string, ResourceEntry[]>();
  for (const container of containers) {
    if (container.type !== "project" && container.type !== "folder") continue;
    const number = getLeadingImportNumber(container.name);
    if (!number) continue;
    const matches = containersByNumber.get(number) ?? [];
    matches.push(container);
    containersByNumber.set(number, matches);
  }

  return sources.map((source, index) => {
    const number = getLeadingImportNumber(source.fileName);
    const base = {
      index,
      fileName: source.fileName,
      number,
      project: source.project,
      container: null,
      containerCandidateNames: [] as string[],
      detail: null,
    };
    if (source.parseError || !source.project) {
      return {
        ...base,
        status: "parse_error" as const,
        detail: source.parseError ?? "JSON 不是有效的标注项目文件。",
      };
    }
    if (!number) {
      return {
        ...base,
        status: "missing_number" as const,
        detail: "文件名必须以连续数字编号开头。",
      };
    }
    if ((duplicateFileNames.get(source.fileName) ?? 0) > 1) {
      return {
        ...base,
        status: "duplicate_file_name" as const,
        detail: "本批次中存在同名 JSON，目标目录不能创建两个同名资源。",
      };
    }

    const numberedContainers = containersByNumber.get(number) ?? [];
    if (!numberedContainers.length) {
      return {
        ...base,
        status: "missing_container" as const,
        detail: `所有项目根目录中没有以编号 ${number} 开头的项目或文件夹。`,
      };
    }
    const writableContainers = numberedContainers.filter(({ permission }) =>
      permission.capabilities.includes("create_child"));
    if (!writableContainers.length) {
      return {
        ...base,
        status: "container_permission_denied" as const,
        containerCandidateNames: numberedContainers.map(({ name }) => name),
        detail: "同编号项目或文件夹存在，但当前账号没有新建子文件权限。",
      };
    }
    if (writableContainers.length > 1) {
      return {
        ...base,
        status: "ambiguous_container" as const,
        containerCandidateNames: writableContainers.map(({ name }) => name),
        detail: `找到 ${writableContainers.length} 个可写的同编号项目或文件夹，无法唯一匹配。`,
      };
    }
    return {
      ...base,
      status: "container_ready" as const,
      container: writableContainers[0]!,
      containerCandidateNames: [writableContainers[0]!.name],
    };
  });
}

export function completeBatchAnnotationImportPlan<TProject>(
  containerRows: readonly BatchAnnotationImportContainerPlanRow<TProject>[],
  videosByContainerId: ReadonlyMap<string, readonly ResourceEntry[]>,
): BatchAnnotationImportPlanRow<TProject>[] {
  return containerRows.map((row) => {
    const base = {
      index: row.index,
      fileName: row.fileName,
      number: row.number,
      project: row.project,
      container: row.container,
      containerCandidateNames: row.containerCandidateNames,
      media: null,
      mediaCandidateNames: [] as string[],
      detail: row.detail,
    };
    if (row.status !== "container_ready" || !row.container || !row.number) {
      return { ...base, status: row.status as BatchAnnotationImportPlanStatus };
    }

    const numberedVideos = (videosByContainerId.get(row.container.id) ?? []).filter((video) =>
      video.type === "media_file" &&
      video.mediaKind === "video" &&
      getLeadingImportNumber(video.name) === row.number);
    if (!numberedVideos.length) {
      return {
        ...base,
        status: "missing_video" as const,
        detail: `目标目录中没有以编号 ${row.number} 开头的视频。`,
      };
    }
    const bindableVideos = numberedVideos.filter(({ permission }) =>
      permission.capabilities.includes("read") &&
      permission.capabilities.includes("download"));
    if (!bindableVideos.length) {
      return {
        ...base,
        status: "video_permission_denied" as const,
        mediaCandidateNames: numberedVideos.map(({ name }) => name),
        detail: "同编号视频存在，但当前账号没有关联所需的下载权限。",
      };
    }
    if (bindableVideos.length > 1) {
      return {
        ...base,
        status: "ambiguous_video" as const,
        mediaCandidateNames: bindableVideos.map(({ name }) => name),
        detail: `目标目录中找到 ${bindableVideos.length} 个可关联的同编号视频，无法唯一匹配。`,
      };
    }
    return {
      ...base,
      status: "ready" as const,
      media: bindableVideos[0]!,
      mediaCandidateNames: [bindableVideos[0]!.name],
      detail: null,
    };
  });
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
