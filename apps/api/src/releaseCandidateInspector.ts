import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "prisma.config.ts",
  "prisma/schema.prisma",
  "prisma/migrations/migration_lock.toml",
  "packages/shared/package.json",
  "packages/shared/dist/index.js",
  "packages/document-model/package.json",
  "packages/document-model/dist/index.js",
  "dist/index.html",
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
] as const;

const REQUIRED_DIRECTORIES = [
  "prisma/migrations",
  "packages/shared/dist",
  "packages/document-model/dist",
  "dist/assets",
  "node_modules",
] as const;

const WORKSPACE_LINKS = [
  "node_modules/@xiqu/shared",
  "node_modules/@xiqu/document-model",
] as const;

const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  "package.json",
  "package-lock.json",
  "prisma.config.ts",
  "prisma",
  "packages",
  "dist",
  "node_modules",
  "scripts",
]);

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  "data",
  "backup",
  "backups",
  "draft",
  "drafts",
]);
const FORBIDDEN_SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const FORBIDDEN_FILE_NAMES = new Set(["CLAUDE_WORK.md"]);
const ALLOWED_RUNTIME_DIRECTORIES_WITH_STATE_NAMES = new Set([
  "dist/api/backup",
]);

export type ReleaseCandidateIssue = {
  code:
    | "candidate_missing"
    | "candidate_not_directory"
    | "required_path_missing"
    | "required_path_type"
    | "required_path_escape"
    | "forbidden_state"
    | "unexpected_top_level_entry"
    | "workspace_link_escape"
    | "package_json_invalid"
    | "runtime_dependency_missing"
    | "migration_missing";
  path: string;
  message: string;
};

export type ReleaseCandidateReport = {
  releaseDir: string;
  checkedRequiredPaths: number;
  runtimeDependencyCount: number;
  migrationCount: number;
};

export class ReleaseCandidateInspectionError extends Error {
  constructor(readonly issues: readonly ReleaseCandidateIssue[]) {
    super(formatInspectionIssues(issues));
    this.name = "ReleaseCandidateInspectionError";
  }
}

export function parseReleaseCandidateArguments(argumentsList: string[]) {
  let releaseDir: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument.startsWith("--release-dir=")) {
      releaseDir = argument.slice("--release-dir=".length);
      continue;
    }
    if (argument === "--release-dir") {
      releaseDir = argumentsList[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (!releaseDir) throw new Error("必须通过 --release-dir 指定候选 release 目录。");
  if (!path.isAbsolute(releaseDir)) {
    throw new Error("--release-dir 必须使用绝对路径，避免在错误工作目录检查候选。");
  }
  return { releaseDir: path.resolve(releaseDir) };
}

/**
 * 候选检查只验证发布目录自身的结构和链接归属。
 * Prisma Client/schema 一致性继续由 release:check 负责，避免形成第二套 schema 判定。
 */
export async function inspectReleaseCandidate(
  candidatePath: string,
): Promise<ReleaseCandidateReport> {
  const issues: ReleaseCandidateIssue[] = [];
  const resolvedInput = path.resolve(candidatePath);
  let releaseDir: string;
  try {
    const candidateStat = await stat(resolvedInput);
    if (!candidateStat.isDirectory()) {
      throw new ReleaseCandidateInspectionError([{
        code: "candidate_not_directory",
        path: ".",
        message: "候选路径不是目录。",
      }]);
    }
    releaseDir = await realpath(resolvedInput);
  } catch (error) {
    if (error instanceof ReleaseCandidateInspectionError) throw error;
    throw new ReleaseCandidateInspectionError([{
      code: "candidate_missing",
      path: ".",
      message: "候选目录不存在或不可读取。",
    }]);
  }

  const topLevelEntries = await readdir(releaseDir, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!ALLOWED_TOP_LEVEL_ENTRIES.has(entry.name)) {
      const lowerName = entry.name.toLowerCase();
      const forbidden =
        lowerName === ".env" ||
        lowerName.startsWith(".env.") ||
        FORBIDDEN_FILE_NAMES.has(entry.name) ||
        (entry.isDirectory() && FORBIDDEN_DIRECTORY_NAMES.has(lowerName)) ||
        (entry.isFile() && FORBIDDEN_SECRET_EXTENSIONS.has(path.extname(lowerName)));
      issues.push({
        code: forbidden ? "forbidden_state" : "unexpected_top_level_entry",
        path: entry.name,
        message: forbidden
          ? "候选根目录夹带本地状态、草稿或密钥类文件。"
          : "候选根目录包含发布清单之外的项目。",
      });
    }
  }

  for (const relativePath of REQUIRED_FILES) {
    await inspectRequiredPath(releaseDir, relativePath, "file", issues);
  }
  for (const relativePath of REQUIRED_DIRECTORIES) {
    await inspectRequiredPath(releaseDir, relativePath, "directory", issues);
  }

  // workspace 链接可以是符号链接或已物化目录，但真实目标必须留在同一不可变 release 内。
  for (const relativePath of WORKSPACE_LINKS) {
    await inspectWorkspacePath(releaseDir, relativePath, issues);
  }

  await scanForbiddenReleaseState(releaseDir, issues);
  const runtimeDependencyCount = await inspectRuntimeDependencies(releaseDir, issues);
  const migrationCount = await inspectMigrations(releaseDir, issues);

  if (issues.length > 0) {
    issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
    throw new ReleaseCandidateInspectionError(issues);
  }

  return {
    releaseDir,
    checkedRequiredPaths: REQUIRED_FILES.length + REQUIRED_DIRECTORIES.length + WORKSPACE_LINKS.length,
    runtimeDependencyCount,
    migrationCount,
  };
}

async function inspectRequiredPath(
  releaseDir: string,
  relativePath: string,
  expectedType: "file" | "directory",
  issues: ReleaseCandidateIssue[],
) {
  const absolutePath = path.join(releaseDir, relativePath);
  try {
    const target = await stat(absolutePath);
    const matches = expectedType === "file" ? target.isFile() : target.isDirectory();
    if (!matches) {
      issues.push({
        code: "required_path_type",
        path: relativePath,
        message: `必需路径必须是${expectedType === "file" ? "文件" : "目录"}。`,
      });
      return;
    }
    // 必需文件同样不得借符号链接逃出候选目录，否则删除工作树或旧 release 后会立即失效。
    const targetRealPath = await realpath(absolutePath);
    if (!isInside(releaseDir, targetRealPath)) {
      issues.push({
        code: "required_path_escape",
        path: relativePath,
        message: "必需路径指向候选 release 之外。",
      });
    }
  } catch {
    issues.push({
      code: "required_path_missing",
      path: relativePath,
      message: "缺少候选运行所需路径。",
    });
  }
}

async function inspectWorkspacePath(
  releaseDir: string,
  relativePath: string,
  issues: ReleaseCandidateIssue[],
) {
  const absolutePath = path.join(releaseDir, relativePath);
  try {
    await lstat(absolutePath);
    const target = await realpath(absolutePath);
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) {
      issues.push({
        code: "required_path_type",
        path: relativePath,
        message: "workspace 入口必须指向目录。",
      });
      return;
    }
    if (!isInside(releaseDir, target)) {
      issues.push({
        code: "workspace_link_escape",
        path: relativePath,
        message: "workspace 入口指向候选 release 之外。",
      });
    }
  } catch {
    issues.push({
      code: "required_path_missing",
      path: relativePath,
      message: "缺少 workspace 运行入口。",
    });
  }
}

async function inspectRuntimeDependencies(
  releaseDir: string,
  issues: ReleaseCandidateIssue[],
) {
  let packageJson: { dependencies?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(await readFile(path.join(releaseDir, "package.json"), "utf8"));
  } catch {
    issues.push({
      code: "package_json_invalid",
      path: "package.json",
      message: "package.json 不是有效 JSON。",
    });
    return 0;
  }
  const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
  for (const dependency of dependencies) {
    const packagePath = path.join("node_modules", ...dependency.split("/"), "package.json");
    try {
      const dependencyRealPath = await realpath(path.join(releaseDir, packagePath));
      if (!isInside(releaseDir, dependencyRealPath)) throw new Error("dependency escape");
      if (!(await stat(dependencyRealPath)).isFile()) throw new Error("dependency package is not file");
    } catch {
      issues.push({
        code: "runtime_dependency_missing",
        path: packagePath,
        message: "生产 runtime dependency 缺失或指向候选目录之外。",
      });
    }
  }
  return dependencies.length;
}

async function inspectMigrations(
  releaseDir: string,
  issues: ReleaseCandidateIssue[],
) {
  const migrationsRoot = path.join(releaseDir, "prisma/migrations");
  try {
    const entries = await readdir(migrationsRoot, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativeMigrationPath = path.join(
        "prisma/migrations",
        entry.name,
        "migration.sql",
      );
      try {
        const migrationPath = path.join(releaseDir, relativeMigrationPath);
        if (!(await stat(migrationPath)).isFile()) continue;
        if (!isInside(releaseDir, await realpath(migrationPath))) {
          issues.push({
            code: "required_path_escape",
            path: relativeMigrationPath,
            message: "正式 migration 指向候选 release 之外。",
          });
          continue;
        }
        count += 1;
      } catch {
        // 非 migration 目录不会被计数；至少一条正式 SQL 的总门禁在下方统一处理。
      }
    }
    if (count === 0) {
      issues.push({
        code: "migration_missing",
        path: "prisma/migrations",
        message: "候选目录没有正式 migration.sql。",
      });
    }
    return count;
  } catch {
    return 0;
  }
}

async function scanForbiddenReleaseState(
  releaseDir: string,
  issues: ReleaseCandidateIssue[],
) {
  const roots = ["prisma", "packages", "dist", "scripts"];
  for (const root of roots) {
    await walk(path.join(releaseDir, root), async (absolutePath, entry) => {
      const relativePath = path.relative(releaseDir, absolutePath);
      const lowerName = entry.name.toLowerCase();
      // 编译后的备份 CLI 是正式运行代码，不是候选夹带的备份数据；只精确放行这个已知目录。
      const isAllowedRuntimeDirectory = ALLOWED_RUNTIME_DIRECTORIES_WITH_STATE_NAMES.has(
        relativePath.split(path.sep).join("/"),
      );
      const forbidden =
        lowerName === ".env" ||
        lowerName.startsWith(".env.") ||
        FORBIDDEN_FILE_NAMES.has(entry.name) ||
        (entry.isDirectory() &&
          FORBIDDEN_DIRECTORY_NAMES.has(lowerName) &&
          !isAllowedRuntimeDirectory) ||
        (entry.isFile() && FORBIDDEN_SECRET_EXTENSIONS.has(path.extname(lowerName)));
      if (forbidden) {
        issues.push({
          code: "forbidden_state",
          path: relativePath,
          message: "候选目录夹带本地状态、草稿或密钥类文件。",
        });
      }
    });
  }
}

async function walk(
  root: string,
  visit: (absolutePath: string, entry: import("node:fs").Dirent) => Promise<void>,
) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    await visit(absolutePath, entry);
    // 不跟随符号链接递归，防止恶意候选把扫描引向 release 外部。
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await walk(absolutePath, visit);
    }
  }
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatInspectionIssues(issues: readonly ReleaseCandidateIssue[]) {
  const details = issues.map(
    (issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`,
  );
  return [`候选 release 检查失败（${issues.length} 项）。`, ...details].join("\n");
}
