import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildImportPlan,
  createVodReferenceId,
  emptyImportState,
  executeImport,
  parseCsv,
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
} from "./platformVodBatchImportCore.js";

test("CSV parser accepts quoted commas and embedded newlines", () => {
  assert.deepEqual(
    parseCsv('project_name,video_path,json_path\r\n"项目,一",video.mp4,"note\n1.json"\r\n'),
    [
      ["project_name", "video_path", "json_path"],
      ["项目,一", "video.mp4", "note\n1.json"],
    ],
  );
});

test("manifest preparation resolves relative paths and derives stable VOD identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xiqu-vod-manifest-"));
  await writeFile(path.join(directory, "video.mp4"), "video bytes");
  await writeFile(path.join(directory, "annotation.json"), JSON.stringify({ video: {} }));
  await writeFile(
    path.join(directory, "manifest.csv"),
    "project_name,video_path,json_path\n项目一,video.mp4,annotation.json\n",
  );

  const [row] = await prepareManifest(path.join(directory, "manifest.csv"), (value) => value);
  assert.ok(row);
  assert.equal(row.projectName, "项目一");
  assert.equal(row.videoName, "项目一");
  assert.equal(row.jsonName, "annotation.json");
  assert.equal(row.videoPath, path.join(directory, "video.mp4"));
  assert.ok(row.videoSha256);
  assert.equal(row.vodReferenceId, createVodReferenceId(row.videoSha256));
  assert.match(row.rowIdentity, /^[a-f0-9]{64}$/u);
});

test("manifest keeps empty and invalid paths as per-artifact skip reasons", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xiqu-vod-invalid-manifest-"));
  await mkdir(path.join(directory, "video-directory"));
  await writeFile(path.join(directory, "invalid.json"), "not-json");
  await writeFile(
    path.join(directory, "manifest.csv"),
    "project_name,video_path,json_path\n空路径,,\n坏路径,missing.mp4,missing.json\n坏文件,video-directory,invalid.json\n",
  );

  const rows = await prepareManifest(path.join(directory, "manifest.csv"), (value) => value);
  assert.equal(rows.length, 3);
  assert.match(rows[0]!.videoIssue ?? "", /为空/u);
  assert.match(rows[0]!.jsonIssue ?? "", /为空/u);
  assert.match(rows[1]!.videoIssue ?? "", /不存在或不可读取/u);
  assert.match(rows[1]!.jsonIssue ?? "", /不存在或不可读取/u);
  assert.match(rows[2]!.videoIssue ?? "", /不是普通文件/u);
  assert.match(rows[2]!.jsonIssue ?? "", /无法解析/u);
});

test("dry-run skips invalid video and JSON without making the row a blocker", async () => {
  const row: PreparedManifestRow = {
    ...manifestRow(),
    videoPath: null,
    jsonPath: null,
    videoIssue: "video_path 为空。",
    jsonIssue: "json_path 为空。",
    videoSize: null,
    videoSha256: null,
    jsonSha256: null,
    vodReferenceId: null,
    payload: null,
    jsonName: "",
  };
  const vod = new FakeVod();
  vod.failOnLookup = true;
  const plan = await buildImportPlan(planInput(row, new FakePlatform(), vod));

  assert.equal(plan.summary.blockedRowCount, 0);
  assert.equal(plan.rows[0]?.project.action, "create");
  assert.equal(plan.rows[0]?.video.action, "skip_invalid_path");
  assert.equal(plan.rows[0]?.annotation.action, "skip_invalid_path");
  assert.equal(vod.lookupCount, 0);
});

test("execution creates only the project when both artifact paths are invalid", async () => {
  const row: PreparedManifestRow = {
    ...manifestRow(),
    videoPath: null,
    jsonPath: null,
    videoIssue: "video_path 为空。",
    jsonIssue: "json_path 为空。",
    videoSize: null,
    videoSha256: null,
    jsonSha256: null,
    vodReferenceId: null,
    payload: null,
    jsonName: "",
  };
  const platform = new FakePlatform();
  const vod = new FakeVod();
  const result = await executeImport({ rows: [row], platform, vod, state: new MemoryState() });

  assert.deepEqual(platform.createCounts, { project: 1, media: 0, annotation: 0 });
  assert.equal(vod.ensureCount, 0);
  assert.equal(result.completedRows[0]?.mediaResourceId, null);
  assert.equal(result.completedRows[0]?.annotationResourceId, null);
});

test("valid JSON is skipped when invalid video has no reusable platform media", async () => {
  const row: PreparedManifestRow = {
    ...manifestRow(),
    videoPath: null,
    videoIssue: "video_path 为空。",
    videoSize: null,
    videoSha256: null,
    vodReferenceId: null,
  };
  const plan = await buildImportPlan(planInput(row, new FakePlatform(), new FakeVod()));
  assert.equal(plan.rows[0]?.video.action, "skip_invalid_path");
  assert.equal(plan.rows[0]?.annotation.action, "skip_no_media");
});

test("invalid video can reuse one compatible platform VOD and create valid JSON", async () => {
  const row: PreparedManifestRow = {
    ...manifestRow(),
    videoPath: null,
    videoIssue: "video_path 为空。",
    videoSize: null,
    videoSha256: null,
    vodReferenceId: null,
  };
  const platform = new FakePlatform({
    resources: [
      resource("project-1", null, "project", row.projectName),
      resource("media-1", "project-1", "media_file", row.videoName, {
        mediaSourceType: "aliyun_vod",
        mediaKind: "video",
      }),
    ],
  });
  const vod = new FakeVod();
  vod.failOnLookup = true;

  const plan = await buildImportPlan(planInput(row, platform, vod));
  assert.equal(plan.rows[0]?.video.action, "reuse_platform");
  assert.equal(plan.rows[0]?.annotation.action, "create");
  const result = await executeImport({ rows: [row], platform, vod, state: new MemoryState() });
  assert.equal(result.completedRows[0]?.mediaResourceId, "media-1");
  assert.equal(platform.createCounts.annotation, 1);
  assert.equal(vod.lookupCount, 0);
  assert.equal(vod.ensureCount, 0);
});

test("invalid video ignores incompatible same-name platform resources instead of overwriting", async () => {
  const row: PreparedManifestRow = {
    ...manifestRow(),
    videoPath: null,
    videoIssue: "video_path 为空。",
    videoSize: null,
    videoSha256: null,
    vodReferenceId: null,
  };
  const platform = new FakePlatform({
    resources: [
      resource("project-1", null, "project", row.projectName),
      resource("folder-1", "project-1", "folder", row.videoName),
    ],
  });
  const plan = await buildImportPlan(planInput(row, platform, new FakeVod()));
  assert.equal(plan.summary.blockedRowCount, 0);
  assert.equal(plan.rows[0]?.video.action, "skip_invalid_path");
  assert.equal(plan.rows[0]?.annotation.action, "skip_no_media");

  await executeImport({ rows: [row], platform, vod: new FakeVod(), state: new MemoryState() });
  assert.deepEqual(platform.createCounts, { project: 0, media: 0, annotation: 0 });
});

test("dry-run reuses an exact project, VOD media, and consistently bound annotation", async () => {
  const row = manifestRow();
  const platform = new FakePlatform({
    resources: [
      resource("project-1", null, "project", row.projectName),
      resource("media-1", "project-1", "media_file", row.videoName, {
        mediaSourceType: "aliyun_vod",
        mediaKind: "video",
      }),
      resource("annotation-1", "project-1", "annotation_file", row.jsonName),
    ],
    bindings: { "annotation-1": { status: "bound", mediaResourceId: "media-1" } },
  });
  const vod = new FakeVod();
  vod.failOnLookup = true;

  const plan = await buildImportPlan(planInput(row, platform, vod));
  assert.equal(plan.summary.blockedRowCount, 0);
  assert.equal(plan.rows[0]?.project.action, "reuse");
  assert.equal(plan.rows[0]?.video.action, "reuse_platform");
  assert.equal(plan.rows[0]?.annotation.action, "reuse");
  assert.equal(vod.lookupCount, 0, "existing platform VOD must avoid a supplier upload lookup");
});

test("dry-run blocks an existing annotation bound to a different medium", async () => {
  const row = manifestRow();
  const platform = new FakePlatform({
    resources: [
      resource("project-1", null, "project", row.projectName),
      resource("media-1", "project-1", "media_file", row.videoName, {
        mediaSourceType: "aliyun_vod",
        mediaKind: "video",
      }),
      resource("annotation-1", "project-1", "annotation_file", row.jsonName),
    ],
    bindings: { "annotation-1": { status: "bound", mediaResourceId: "other-media" } },
  });
  const plan = await buildImportPlan(planInput(row, platform, new FakeVod()));
  assert.equal(plan.summary.blockedRowCount, 1);
  assert.match(plan.rows[0]!.blockers.join(" "), /禁止覆盖或改绑/u);
});

test("execution creates missing objects once and a second run performs no writes", async () => {
  const row = manifestRow();
  const platform = new FakePlatform();
  const vod = new FakeVod();
  const state = new MemoryState();

  const first = await executeImport({ rows: [row], platform, vod, state });
  assert.equal(first.completedRows.length, 1);
  assert.deepEqual(platform.createCounts, { project: 1, media: 1, annotation: 1 });
  assert.equal(vod.ensureCount, 1);

  const second = await executeImport({ rows: [row], platform, vod, state });
  assert.equal(second.completedRows.length, 1);
  assert.deepEqual(platform.createCounts, { project: 1, media: 1, annotation: 1 });
  assert.equal(vod.ensureCount, 1, "existing platform media must suppress a second VOD upload");
});

test("execution never changes an existing incompatible same-name resource", async () => {
  const row = manifestRow();
  const platform = new FakePlatform({
    resources: [
      resource("project-1", null, "project", row.projectName),
      resource("wrong-1", "project-1", "folder", row.videoName),
    ],
  });
  const vod = new FakeVod();

  await assert.rejects(
    executeImport({ rows: [row], platform, vod, state: new MemoryState() }),
    /拒绝覆盖/u,
  );
  assert.deepEqual(platform.createCounts, { project: 0, media: 0, annotation: 0 });
  assert.equal(vod.ensureCount, 0);
});

function manifestRow(): PreparedManifestRow {
  const videoSha256 = "a".repeat(64);
  return {
    rowNumber: 2,
    rowIdentity: "b".repeat(64),
    projectName: "001项目",
    videoPath: "/safe/video.mp4",
    jsonPath: "/safe/annotation.json",
    videoIssue: null,
    jsonIssue: null,
    videoName: "001项目",
    jsonName: "001.json",
    vodTitle: "001项目",
    videoSize: 123,
    videoSha256,
    jsonSha256: "c".repeat(64),
    vodReferenceId: createVodReferenceId(videoSha256),
    payload: { video: {} },
  };
}

function planInput(
  row: PreparedManifestRow,
  platform: PlatformImportPort,
  vod: VodImportPort,
) {
  return {
    baseUrl: "https://example.test/api",
    region: "cn-shanghai",
    manifestPath: "/safe/manifest.csv",
    statePath: "/safe/state.json",
    rows: [row],
    platform,
    vod,
    state: emptyImportState(),
  };
}

function resource(
  id: string,
  parentId: string | null,
  type: PlatformResource["type"],
  name: string,
  extra: Partial<PlatformResource> = {},
): PlatformResource {
  return { id, parentId, type, name, ...extra };
}

class FakePlatform implements PlatformImportPort {
  readonly resources: PlatformResource[];
  readonly bindings: Record<string, AnnotationBinding>;
  readonly createCounts = { project: 0, media: 0, annotation: 0 };

  constructor(options: {
    resources?: PlatformResource[];
    bindings?: Record<string, AnnotationBinding>;
  } = {}) {
    this.resources = [...(options.resources ?? [])];
    this.bindings = { ...(options.bindings ?? {}) };
  }

  async listRootProjects() {
    return this.resources.filter(({ parentId, type }) => parentId === null && type === "project");
  }

  async listChildren(parentId: string) {
    return this.resources.filter((resource) => resource.parentId === parentId);
  }

  async getAnnotationBinding(annotationResourceId: string) {
    return this.bindings[annotationResourceId] ?? { status: "unbound" as const };
  }

  async createProject(name: string) {
    this.createCounts.project += 1;
    const created = resource(`project-${this.createCounts.project}`, null, "project", name);
    this.resources.push(created);
    return created;
  }

  async createVodMedia(input: { parentId: string; name: string; videoId: string }) {
    this.createCounts.media += 1;
    const created = resource(
      `media-${this.createCounts.media}`,
      input.parentId,
      "media_file",
      input.name,
      { mediaSourceType: "aliyun_vod", mediaKind: "video" },
    );
    this.resources.push(created);
    return created;
  }

  async createAnnotation(input: {
    parentId: string;
    name: string;
    payload: unknown;
    mediaResourceId: string;
  }) {
    this.createCounts.annotation += 1;
    const created = resource(
      `annotation-${this.createCounts.annotation}`,
      input.parentId,
      "annotation_file",
      input.name,
    );
    this.resources.push(created);
    this.bindings[created.id] = { status: "bound", mediaResourceId: input.mediaResourceId };
    return { resource: created };
  }
}

class FakeVod implements VodImportPort {
  lookupCount = 0;
  ensureCount = 0;
  failOnLookup = false;
  existing: VodVideo | null = null;

  async findByReferenceId() {
    this.lookupCount += 1;
    if (this.failOnLookup) throw new Error("unexpected lookup");
    return this.existing;
  }

  async ensureNormalVideo(
    row: PreparedManifestRow,
    _state: ImportStateRow | null,
    onCheckpoint: (update: {
      videoId: string;
      uploadCheckpoint: VodUploadCheckpoint | null;
    }) => Promise<void>,
  ) {
    this.ensureCount += 1;
    await onCheckpoint({ videoId: `vod-${row.rowNumber}`, uploadCheckpoint: null });
    return { videoId: `vod-${row.rowNumber}`, uploaded: true };
  }
}

class MemoryState implements ImportStatePort {
  private value: ImportState = emptyImportState();

  current() {
    return this.value;
  }

  async update(rowIdentity: string, update: Partial<ImportStateRow>) {
    const current = this.value.rows[rowIdentity];
    const next = {
      ...current,
      ...update,
      rowIdentity,
      videoSha256: Object.prototype.hasOwnProperty.call(update, "videoSha256")
        ? update.videoSha256 ?? null
        : current?.videoSha256 ?? null,
      jsonSha256: Object.prototype.hasOwnProperty.call(update, "jsonSha256")
        ? update.jsonSha256 ?? null
        : current?.jsonSha256 ?? null,
      vodReferenceId: Object.prototype.hasOwnProperty.call(update, "vodReferenceId")
        ? update.vodReferenceId ?? null
        : current?.vodReferenceId ?? null,
    };
    this.value = { version: 1, rows: { ...this.value.rows, [rowIdentity]: next } };
    return next;
  }
}
