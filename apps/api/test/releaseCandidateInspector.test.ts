import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectReleaseCandidate,
  parseReleaseCandidateArguments,
  ReleaseCandidateInspectionError,
} from "../src/releaseCandidateInspector.js";

test("候选参数必须使用显式绝对目录", () => {
  assert.deepEqual(
    parseReleaseCandidateArguments(["--release-dir", "/opt/xiqu/releases/candidate"]),
    { releaseDir: "/opt/xiqu/releases/candidate" },
  );
  assert.deepEqual(
    parseReleaseCandidateArguments(["--release-dir=/opt/xiqu/releases/candidate"]),
    { releaseDir: "/opt/xiqu/releases/candidate" },
  );
  assert.throws(() => parseReleaseCandidateArguments([]), /--release-dir/);
  assert.throws(() => parseReleaseCandidateArguments(["--release-dir", "relative"]), /绝对路径/);
  assert.throws(() => parseReleaseCandidateArguments(["--unknown"]), /未知参数/);
});

test("完整候选验证运行文件、依赖、migration 和内部 workspace 链接", async () => {
  const releaseDir = await createCandidate();
  try {
    const report = await inspectReleaseCandidate(releaseDir);
    assert.equal(report.runtimeDependencyCount, 1);
    assert.equal(report.migrationCount, 1);
    assert.ok(report.checkedRequiredPaths > 20);
    assert.equal(report.releaseDir, await realpath(releaseDir));
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
});

test("缺失运行文件和本地状态一次性形成脱敏问题列表", async () => {
  const releaseDir = await createCandidate();
  try {
    await rm(path.join(releaseDir, "dist/api/server.js"));
    await writeFile(path.join(releaseDir, ".env.production"), "SECRET=must-not-appear\n");
    await mkdir(path.join(releaseDir, "data"));
    const error = await captureInspectionError(releaseDir);
    assert.deepEqual(
      new Set(error.issues.map((issue) => issue.code)),
      new Set(["forbidden_state", "required_path_missing"]),
    );
    assert.doesNotMatch(error.message, /must-not-appear|SECRET=/);
    assert.match(error.message, /dist\/api\/server\.js/);
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
});

test("workspace 链接不得逃出不可变 release", async () => {
  const releaseDir = await createCandidate();
  const externalDir = await mkdtemp(path.join(tmpdir(), "xiqu-release-external-"));
  try {
    const workspaceLink = path.join(releaseDir, "node_modules/@xiqu/shared");
    await rm(workspaceLink);
    await symlink(externalDir, workspaceLink);
    const error = await captureInspectionError(releaseDir);
    assert.ok(error.issues.some((issue) => issue.code === "workspace_link_escape"));
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("普通运行文件和 migration 也不得通过符号链接逃出候选", async () => {
  const releaseDir = await createCandidate();
  const externalDir = await mkdtemp(path.join(tmpdir(), "xiqu-release-external-"));
  try {
    const externalServer = path.join(externalDir, "server.js");
    const externalMigration = path.join(externalDir, "migration.sql");
    await writeFile(externalServer, "external\n");
    await writeFile(externalMigration, "-- external\n");
    await rm(path.join(releaseDir, "dist/api/server.js"));
    await rm(path.join(releaseDir, "prisma/migrations/20260101000000_init/migration.sql"));
    await symlink(externalServer, path.join(releaseDir, "dist/api/server.js"));
    await symlink(
      externalMigration,
      path.join(releaseDir, "prisma/migrations/20260101000000_init/migration.sql"),
    );

    const error = await captureInspectionError(releaseDir);
    assert.ok(error.issues.some(
      (issue) => issue.code === "required_path_escape" && issue.path === "dist/api/server.js",
    ));
    assert.ok(error.issues.some(
      (issue) => issue.code === "required_path_escape" && issue.path.endsWith("migration.sql"),
    ));
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("workspace 入口必须是真实目录且候选路径必须存在", async () => {
  const releaseDir = await createCandidate();
  try {
    const workspacePath = path.join(releaseDir, "node_modules/@xiqu/shared");
    await rm(workspacePath);
    await writeFile(workspacePath, "not-a-directory\n");
    const error = await captureInspectionError(releaseDir);
    assert.ok(error.issues.some(
      (issue) => issue.code === "required_path_type" && issue.path === "node_modules/@xiqu/shared",
    ));
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }

  await assert.rejects(
    inspectReleaseCandidate(path.join(tmpdir(), "xiqu-release-does-not-exist")),
    (error: unknown) =>
      error instanceof ReleaseCandidateInspectionError &&
      error.issues.some((issue) => issue.code === "candidate_missing"),
  );
});

test("坏 package.json 与缺失生产依赖不能伪装成完整候选", async () => {
  const releaseDir = await createCandidate();
  try {
    await writeFile(path.join(releaseDir, "package.json"), "{");
    const invalid = await captureInspectionError(releaseDir);
    assert.ok(invalid.issues.some((issue) => issue.code === "package_json_invalid"));

    await writeJson(path.join(releaseDir, "package.json"), {
      dependencies: { fastify: "1.0.0", "missing-runtime": "1.0.0" },
    });
    const missing = await captureInspectionError(releaseDir);
    assert.ok(missing.issues.some(
      (issue) => issue.code === "runtime_dependency_missing" && issue.path.includes("missing-runtime"),
    ));
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
});

async function createCandidate() {
  const releaseDir = await mkdtemp(path.join(tmpdir(), "xiqu-release-candidate-"));
  const files = [
    "package-lock.json",
    "prisma.config.ts",
    "prisma/schema.prisma",
    "prisma/migrations/migration_lock.toml",
    "prisma/migrations/20260101000000_init/migration.sql",
    "packages/shared/package.json",
    "packages/shared/dist/index.js",
    "packages/document-model/package.json",
    "packages/document-model/dist/index.js",
    "dist/index.html",
    "dist/assets/index.js",
    "dist/api/server.js",
    "dist/api/analysisWorkerCli.js",
    "dist/api/backup/cli.js",
    "dist/api/prismaClientSchemaGuardCli.js",
    "dist/api/releaseCandidateInspectorCli.js",
    "dist/api/releaseSwitchCli.js",
    "scripts/checkDeployment.mjs",
    "scripts/deploymentCheck.mjs",
    "node_modules/@prisma/client/package.json",
    "node_modules/.prisma/client/schema.prisma",
    "node_modules/fastify/package.json",
  ];
  for (const relativePath of files) {
    const absolutePath = path.join(releaseDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "fixture\n");
  }
  await writeJson(path.join(releaseDir, "package.json"), {
    dependencies: { fastify: "1.0.0" },
  });
  await mkdir(path.join(releaseDir, "node_modules/@xiqu"), { recursive: true });
  await symlink("../../packages/shared", path.join(releaseDir, "node_modules/@xiqu/shared"));
  await symlink(
    "../../packages/document-model",
    path.join(releaseDir, "node_modules/@xiqu/document-model"),
  );
  return releaseDir;
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function captureInspectionError(releaseDir: string) {
  try {
    await inspectReleaseCandidate(releaseDir);
  } catch (error) {
    assert.ok(error instanceof ReleaseCandidateInspectionError);
    return error;
  }
  assert.fail("预期候选检查失败。");
}
