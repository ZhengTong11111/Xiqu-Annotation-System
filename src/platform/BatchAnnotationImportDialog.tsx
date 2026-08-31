import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  FileJson2,
  Film,
  FolderOpen,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ResourceEntry } from "@xiqu/shared";
import type { ProjectData } from "../types";
import type { PlatformClient } from "../api/platformClient";
import {
  isProjectFileLike,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import { prepareProjectForServer } from "./platformProjectPayload";
import {
  buildBatchAnnotationImportContainerPlan,
  collectBatchImportResources,
  completeBatchAnnotationImportPlan,
  getLeadingImportNumber,
  type BatchAnnotationImportPlanRow,
  type BatchAnnotationImportPlanStatus,
  type BatchAnnotationImportSource,
} from "./annotationBatchImport";

type Props = {
  client: PlatformClient;
  files: readonly File[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => Promise<void> | void;
};

type ImportOutcome = {
  status: "importing" | "succeeded" | "failed";
  error?: string;
};

// 批量窗口编排既有资源读取和管理员专用的逐文件创建 API。每份标注仍由服务端独立复核管理员角色、
// 目标目录、名称、create_child 和媒体 read/download，前端匹配结果从不替代权威权限判断。
export function BatchAnnotationImportDialog(props: Props) {
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<BatchAnnotationImportPlanRow<ProjectData>[]>([]);
  const [outcomes, setOutcomes] = useState<Map<number, ImportOutcome>>(new Map());

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    setLoading(true);
    setImporting(false);
    setLoadError(null);
    setRows([]);
    setOutcomes(new Map());

    const orderedFiles = [...props.files].sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    void prepareBatchPlan(props.client, orderedFiles).then((plan) => {
      if (!active) return;
      setRows(plan);
    }).catch((error: unknown) => {
      if (active) setLoadError(describeError(error));
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [props.client, props.files, props.open]);

  const summary = useMemo(() => {
    const ready = rows.filter(({ status }) => status === "ready").length;
    let succeeded = 0;
    let failed = 0;
    for (const outcome of outcomes.values()) {
      if (outcome.status === "succeeded") succeeded += 1;
      if (outcome.status === "failed") failed += 1;
    }
    return { ready, skipped: rows.length - ready, succeeded, failed };
  }, [outcomes, rows]);
  const pendingRows = rows.filter((row) =>
    row.status === "ready" && outcomes.get(row.index)?.status !== "succeeded");

  async function importReadyRows() {
    if (loading || importing || !pendingRows.length) return;
    setImporting(true);
    try {
      for (const row of pendingRows) {
        if (!row.project || !row.container || !row.media) continue;
        setOutcome(row.index, { status: "importing" });
        try {
          await props.client.createBatchImportedAnnotationFile({
            parentId: row.container.id,
            name: row.fileName,
            payload: prepareProjectForServer(row.project),
            mediaResourceId: row.media.id,
          });
          setOutcome(row.index, { status: "succeeded" });
        } catch (error) {
          // 单项失败不阻断后续文件；已经确认成功的项目不会在本窗口内重复提交。
          setOutcome(row.index, { status: "failed", error: describeError(error) });
        }
      }
      // 即使所有响应都报错也刷新一次：网络中断可能发生在服务端提交之后，目录读取才是创建事实的最终展示。
      await props.onCompleted();
    } finally {
      setImporting(false);
    }
  }

  function setOutcome(index: number, outcome: ImportOutcome) {
    setOutcomes((current) => {
      const next = new Map(current);
      next.set(index, outcome);
      return next;
    });
  }

  const allReadySucceeded = summary.ready > 0 && summary.succeeded === summary.ready;
  return <Dialog.Root
    open={props.open}
    onOpenChange={(open) => {
      if (!importing) props.onOpenChange(open);
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="system-diagnostics-backdrop" />
      <Dialog.Content className="batch-annotation-import-dialog">
        <header className="system-diagnostics-header">
          <div>
            <FileJson2 size={20} />
            <div>
              <Dialog.Title>批量导入标注 JSON</Dialog.Title>
              <Dialog.Description>按开头编号精确匹配顶层项目或文件夹，再关联该目录中的同编号视频</Dialog.Description>
            </div>
          </div>
          <div className="system-diagnostics-header-actions">
            <Dialog.Close asChild>
              <button type="button" title="关闭" disabled={importing}><X size={17} /></button>
            </Dialog.Close>
          </div>
        </header>

        <div className="batch-annotation-import-summary">
          <span>已选择 <strong>{props.files.length}</strong> 份 JSON</span>
          {!loading && !loadError ? <>
            <span className="ready">可导入 <strong>{summary.ready}</strong></span>
            <span>需处理 <strong>{summary.skipped}</strong></span>
            {summary.succeeded ? <span className="succeeded">已成功 <strong>{summary.succeeded}</strong></span> : null}
            {summary.failed ? <span className="failed">失败 <strong>{summary.failed}</strong></span> : null}
          </> : null}
        </div>

        {loadError ? <div className="resource-error-banner" role="alert">{loadError}</div> : null}
        <div className="batch-annotation-import-table-wrap" aria-busy={loading || importing}>
          {loading ? <div className="batch-annotation-import-loading"><LoaderCircle size={18} />正在解析 JSON、匹配项目并读取对应视频…</div> : null}
          {!loading && rows.length ? <table className="batch-annotation-import-table">
            <thead><tr><th>标注 JSON</th><th>编号</th><th>目标项目 / 文件夹</th><th>匹配视频</th><th>状态</th></tr></thead>
            <tbody>{rows.map((row) => {
              const outcome = outcomes.get(row.index);
              const presentation = presentRow(row, outcome);
              return <tr key={`${row.index}:${row.fileName}`} className={presentation.tone}>
                <td title={row.fileName}><FileJson2 size={15} /><span>{row.fileName}</span></td>
                <td><code>{row.number ?? "—"}</code></td>
                <td title={row.containerCandidateNames.join("；")}>
                  {row.container ? <><FolderOpen size={15} /><span>{row.container.name}</span></> : <span>{row.containerCandidateNames.join("；") || "—"}</span>}
                </td>
                <td title={row.mediaCandidateNames.join("；")}>
                  {row.media ? <><Film size={15} /><span>{row.media.name}</span></> : <span>{row.mediaCandidateNames.join("；") || "—"}</span>}
                </td>
                <td title={presentation.detail ?? undefined}>
                  {presentation.tone === "succeeded" ? <CheckCircle2 size={15} /> : null}
                  {presentation.tone === "failed" || presentation.tone === "skipped" ? <AlertTriangle size={15} /> : null}
                  {presentation.tone === "importing" ? <LoaderCircle size={15} /> : null}
                  <span>{presentation.label}</span>
                  {presentation.detail ? <small>{presentation.detail}</small> : null}
                </td>
              </tr>;
            })}</tbody>
          </table> : null}
        </div>

        <footer className="batch-annotation-import-actions">
          <span>项目/文件夹或视频未唯一匹配的文件不会导入，可整理编号或权限后重试。</span>
          <Dialog.Close asChild><button type="button" disabled={importing}>{allReadySucceeded ? "完成" : "关闭"}</button></Dialog.Close>
          <button
            type="button"
            className="platform-primary-button"
            disabled={loading || importing || Boolean(loadError) || !pendingRows.length}
            onClick={() => void importReadyRows()}
          >
            {importing
              ? "正在逐项导入…"
              : summary.failed
                ? `重试未成功项（${pendingRows.length}）`
                : `导入可匹配项（${pendingRows.length}）`}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

async function prepareBatchPlan(
  client: PlatformClient,
  files: readonly File[],
): Promise<BatchAnnotationImportPlanRow<ProjectData>[]> {
  const [sources, projects, folders] = await Promise.all([
    prepareSources(files),
    collectRootContainers(client, "project"),
    collectRootContainers(client, "folder"),
  ]);
  const containerRows = buildBatchAnnotationImportContainerPlan(
    sources,
    [...projects, ...folders],
  );
  const targetById = new Map<string, ResourceEntry>();
  for (const row of containerRows) {
    if (row.status === "container_ready" && row.container) {
      targetById.set(row.container.id, row.container);
    }
  }
  const videoEntries = await mapWithConcurrency(
    [...targetById.values()],
    6,
    async (container) => {
      const number = getLeadingImportNumber(container.name)!;
      const videos = await collectBatchImportResources(
        (cursor) => client.listResources({
          parentId: container.id,
          view: "children",
          query: number,
          type: "media_file",
          sortBy: "name",
          direction: "asc",
          cursor: cursor ?? undefined,
          limit: 200,
        }),
        (resource) => resource.type === "media_file" && resource.mediaKind === "video",
        `“${container.name}”内的同编号媒体`,
      );
      return [container.id, videos] as const;
    },
  );
  return completeBatchAnnotationImportPlan(containerRows, new Map(videoEntries));
}

async function collectRootContainers(
  client: PlatformClient,
  type: "project" | "folder",
): Promise<ResourceEntry[]> {
  return collectBatchImportResources(
    (cursor) => client.listResources({
      parentId: null,
      view: "children",
      type,
      sortBy: "name",
      direction: "asc",
      cursor: cursor ?? undefined,
      limit: 200,
    }),
    (resource) => resource.type === type,
    type === "project" ? "顶层项目" : "顶层文件夹",
  );
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function prepareSources(
  files: readonly File[],
): Promise<BatchAnnotationImportSource<ProjectData>[]> {
  return Promise.all(files.map(async (file) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isProjectFileLike(parsed)) {
        throw new Error("不是有效的标注项目文件。");
      }
      return {
        fileName: file.name,
        project: normalizeImportedProjectFile(parsed).project,
      };
    } catch (error) {
      return { fileName: file.name, project: null, parseError: describeError(error) };
    }
  }));
}

function presentRow(
  row: BatchAnnotationImportPlanRow<ProjectData>,
  outcome: ImportOutcome | undefined,
): { tone: "ready" | "skipped" | "importing" | "succeeded" | "failed"; label: string; detail: string | null } {
  if (outcome?.status === "importing") return { tone: "importing", label: "正在导入", detail: null };
  if (outcome?.status === "succeeded") return { tone: "succeeded", label: "导入成功", detail: null };
  if (outcome?.status === "failed") return { tone: "failed", label: "导入失败", detail: outcome.error ?? null };
  if (row.status === "ready") return { tone: "ready", label: "可以导入", detail: null };
  return { tone: "skipped", label: statusLabel(row.status), detail: row.detail };
}

function statusLabel(status: BatchAnnotationImportPlanStatus): string {
  switch (status) {
    case "ready": return "可以导入";
    case "parse_error": return "JSON 无效";
    case "missing_number": return "缺少开头编号";
    case "duplicate_file_name": return "JSON 重名";
    case "missing_container": return "未找到目标目录";
    case "container_permission_denied": return "目标目录权限不足";
    case "ambiguous_container": return "目标目录不唯一";
    case "missing_video": return "未找到视频";
    case "video_permission_denied": return "视频权限不足";
    case "ambiguous_video": return "匹配不唯一";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "批量导入发生未知错误。";
}
