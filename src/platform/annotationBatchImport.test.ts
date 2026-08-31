import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import {
  BatchImportResourceScanLimitError,
  MAX_BATCH_ANNOTATION_FILES,
  buildBatchAnnotationImportContainerPlan,
  collectBatchImportResources,
  completeBatchAnnotationImportPlan,
  getLeadingImportNumber,
} from "./annotationBatchImport";

const container = (
  id: string,
  name: string,
  options: { type?: "project" | "folder"; writable?: boolean } = {},
) => ({
  id,
  name,
  type: options.type ?? "project",
  permission: {
    capabilities: options.writable === false ? ["read"] : ["read", "create_child"],
  },
}) as ResourceEntry;

const media = (
  id: string,
  name: string,
  options: { kind?: "video" | "audio"; download?: boolean } = {},
) => ({
  id,
  name,
  type: "media_file",
  mediaKind: options.kind ?? "video",
  permission: {
    capabilities: options.download === false ? ["read"] : ["read", "download"],
  },
}) as ResourceEntry;

const page = (items: ResourceEntry[], nextCursor: string | null): ResourceListPage => ({
  items,
  breadcrumbs: [],
  nextCursor,
});

test("提取文件名开头编号并保留前导零", () => {
  assert.equal(MAX_BATCH_ANNOTATION_FILES, 300);
  assert.equal(getLeadingImportNumber("001_牡丹亭.json"), "001");
  assert.equal(getLeadingImportNumber("0010-视频.mp4"), "0010");
  assert.equal(getLeadingImportNumber("牡丹亭001.json"), null);
  assert.equal(getLeadingImportNumber(" 001.json"), null);
});

test("JSON 先精确匹配顶层项目或文件夹，再匹配该目录下的同编号视频", () => {
  const sources = [
    { fileName: "001_标注.json", project: { id: "project-1" } },
    { fileName: "01_标注.json", project: { id: "project-2" } },
  ];
  const containerRows = buildBatchAnnotationImportContainerPlan(sources, [
    container("container-001", "001_牡丹亭"),
    container("container-0010", "0010_长生殿"),
    container("container-01", "01_西厢记", { type: "folder" }),
  ]);
  const rows = completeBatchAnnotationImportPlan(containerRows, new Map([
    ["container-001", [media("video-001", "001_录像.mp4"), media("video-0010", "0010_录像.mp4")]],
    ["container-01", [media("video-01", "01_录像.mp4")]],
  ]));

  assert.deepEqual(rows.map(({ status, container: target, media: matched }) => [
    status,
    target?.id,
    matched?.id,
  ]), [
    ["ready", "container-001", "video-001"],
    ["ready", "container-01", "video-01"],
  ]);
});

test("目标目录缺失、权限不足或编号不唯一时不会继续匹配视频", () => {
  const rows = buildBatchAnnotationImportContainerPlan([
    { fileName: "002_a.json", project: {} },
    { fileName: "003_a.json", project: {} },
    { fileName: "004_a.json", project: {} },
    { fileName: "坏文件.json", project: null, parseError: "格式错误" },
    { fileName: "无编号.json", project: {} },
    { fileName: "005_a.json", project: {} },
    { fileName: "005_a.json", project: {} },
  ], [
    container("container-002-a", "002_a"),
    container("container-002-b", "002_b", { type: "folder" }),
    container("container-003", "003_a", { writable: false }),
  ]);

  assert.deepEqual(rows.map(({ status }) => status), [
    "ambiguous_container",
    "container_permission_denied",
    "missing_container",
    "parse_error",
    "missing_number",
    "duplicate_file_name",
    "duplicate_file_name",
  ]);
});

test("目标目录内视频缺失、权限不足或编号不唯一时不会导入", () => {
  const containerRows = buildBatchAnnotationImportContainerPlan([
    { fileName: "006_a.json", project: {} },
    { fileName: "007_a.json", project: {} },
    { fileName: "008_a.json", project: {} },
  ], [
    container("container-006", "006_a"),
    container("container-007", "007_a"),
    container("container-008", "008_a"),
  ]);
  const rows = completeBatchAnnotationImportPlan(containerRows, new Map([
    ["container-007", [media("video-007", "007_a.mp4", { download: false })]],
    ["container-008", [media("video-008-a", "008_a.mp4"), media("video-008-b", "008_b.mp4")]],
  ]));
  assert.deepEqual(rows.map(({ status }) => status), [
    "missing_video",
    "video_permission_denied",
    "ambiguous_video",
  ]);
});

test("资源扫描读完全部分页、按类型过滤并去重", async () => {
  const pages = new Map<string | null, ResourceListPage>([
    [null, page([container("project-1", "001"), media("video", "001.mp4")], "next")],
    ["next", page([container("project-1", "001"), container("folder-2", "002", { type: "folder" })], null)],
  ]);
  const containers = await collectBatchImportResources(
    async (cursor) => pages.get(cursor)!,
    (resource) => resource.type === "project" || resource.type === "folder",
    "测试容器",
    2,
  );
  assert.deepEqual(containers.map(({ id }) => id), ["project-1", "folder-2"]);
});

test("资源超过扫描上限时拒绝基于不完整结果匹配", async () => {
  await assert.rejects(
    collectBatchImportResources(
      async (cursor) => page([container(`project-${cursor ?? "root"}`, "001")], "more"),
      () => true,
      "测试容器",
      2,
    ),
    BatchImportResourceScanLimitError,
  );
});
