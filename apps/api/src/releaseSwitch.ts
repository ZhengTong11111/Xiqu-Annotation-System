import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  inspectReleaseCandidate,
  type ReleaseCandidateReport,
} from "./releaseCandidateInspector.js";

export type ReleaseSwitchOptions = {
  currentLink: string;
  expectedCurrent: string;
  newRelease: string;
};

export type ReleaseSwitchReport = {
  currentLink: string;
  previousRelease: string;
  activeRelease: string;
  checkedRequiredPaths: number;
  runtimeDependencyCount: number;
  migrationCount: number;
};

export class ReleaseSwitchError extends Error {
  constructor(
    readonly code:
      | "invalid_path"
      | "switch_locked"
      | "current_not_symlink"
      | "release_missing"
      | "release_not_directory"
      | "current_drift"
      | "same_release"
      | "release_root_mismatch"
      | "switch_publish_failed"
      | "switch_committed_cleanup_failed",
    message: string,
    readonly switched = false,
  ) {
    super(message);
    this.name = "ReleaseSwitchError";
  }
}

type ReleaseSwitchDependencies = {
  inspectCandidate?: typeof inspectReleaseCandidate;
  renameLink?: typeof rename;
  createOperationId?: () => string;
};

export function parseReleaseSwitchArguments(argumentsList: string[]): ReleaseSwitchOptions {
  const values = new Map<string, string>();
  const setValue = (name: string, value: string) => {
    if (values.has(name)) throw new Error(`参数 --${name} 不能重复提供。`);
    values.set(name, value);
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    const matched = argument.match(/^--(current-link|expected-current|new-release)=(.*)$/u);
    if (matched) {
      setValue(matched[1]!, matched[2]!);
      continue;
    }
    if (["--current-link", "--expected-current", "--new-release"].includes(argument)) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少参数值。`);
      setValue(argument.slice(2), value);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }

  const options = {
    currentLink: values.get("current-link"),
    expectedCurrent: values.get("expected-current"),
    newRelease: values.get("new-release"),
  };
  for (const [name, value] of Object.entries(options)) {
    if (!value) throw new Error(`必须提供 --${toKebabCase(name)}。`);
    if (!path.isAbsolute(value)) {
      throw new Error(`--${toKebabCase(name)} 必须使用绝对路径。`);
    }
  }
  return {
    currentLink: path.resolve(options.currentLink!),
    expectedCurrent: path.resolve(options.expectedCurrent!),
    newRelease: path.resolve(options.newRelease!),
  };
}

/**
 * 在一个受控边界内校验候选并替换 current symlink。
 * 固定锁只协调本工具的并发调用；部署手册因此不再保留可绕过锁的裸 ln 切换路径。
 */
export async function switchRelease(
  input: ReleaseSwitchOptions,
  dependencies: ReleaseSwitchDependencies = {},
): Promise<ReleaseSwitchReport> {
  const options = normalizeSwitchOptions(input);
  const inspectCandidate = dependencies.inspectCandidate ?? inspectReleaseCandidate;
  const renameLink = dependencies.renameLink ?? rename;
  const operationId = (dependencies.createOperationId ?? randomUUID)();
  const lockPath = `${options.currentLink}.switch.lock`;
  const temporaryLink = `${options.currentLink}.switch-${operationId}`;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryLinkCreated = false;
  let switched = false;
  let report: ReleaseSwitchReport | undefined;
  let primaryError: unknown;

  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, operationId })}\n`);
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new ReleaseSwitchError(
          "switch_locked",
          `release 切换锁已存在：${lockPath}。确认没有切换进程后再人工处理陈旧锁。`,
        );
      }
      throw error;
    }

    const currentStat = await lstat(options.currentLink).catch(() => undefined);
    if (!currentStat?.isSymbolicLink()) {
      throw new ReleaseSwitchError("current_not_symlink", "current 必须是现有符号链接。");
    }

    const [currentRelease, expectedCurrent, newRelease] = await Promise.all([
      resolveReleaseDirectory(options.currentLink, "current"),
      resolveReleaseDirectory(options.expectedCurrent, "expected-current"),
      resolveReleaseDirectory(options.newRelease, "new-release"),
    ]);
    if (currentRelease !== expectedCurrent) {
      throw new ReleaseSwitchError(
        "current_drift",
        `current 已不再指向期望旧 release：${currentRelease}。请重新读取部署事实，禁止覆盖。`,
      );
    }
    if (newRelease === currentRelease) {
      throw new ReleaseSwitchError("same_release", "新旧 release 不能是同一目录。");
    }
    if (path.dirname(newRelease) !== path.dirname(currentRelease)) {
      throw new ReleaseSwitchError(
        "release_root_mismatch",
        "新旧 release 必须是同一不可变 releases 根目录下的直接子目录。",
      );
    }

    const candidateReport = await inspectCandidate(newRelease);
    if (candidateReport.releaseDir !== newRelease) {
      throw new ReleaseSwitchError("invalid_path", "候选检查返回了不同的真实 release 目录。");
    }

    // 候选检查可能耗时；发布前再次读取 current，缩小迟到操作覆盖其他切换的竞态窗口。
    const currentBeforePublish = await resolveReleaseDirectory(options.currentLink, "current");
    if (currentBeforePublish !== expectedCurrent) {
      throw new ReleaseSwitchError(
        "current_drift",
        `候选检查期间 current 已切换到 ${currentBeforePublish}，本次操作已停止。`,
      );
    }

    await symlink(newRelease, temporaryLink, "dir");
    temporaryLinkCreated = true;
    try {
      await renameLink(temporaryLink, options.currentLink);
    } catch {
      // 本地文件系统调用也可能出现“已提交但响应不确定”；以 current 的真实目标判定最终事实。
      const activeAfterError = await realpath(options.currentLink).catch(() => undefined);
      if (activeAfterError !== newRelease) {
        throw new ReleaseSwitchError(
          "switch_publish_failed",
          "原子发布 current 失败或结果不确定；保持维护并重新读取 current。",
        );
      }
    }
    temporaryLinkCreated = false;
    switched = true;

    const activeRelease = await resolveReleaseDirectory(options.currentLink, "current");
    if (activeRelease !== newRelease) {
      throw new ReleaseSwitchError(
        "switch_publish_failed",
        "current 发布后未指向目标 release，必须保持维护并人工核查。",
        true,
      );
    }
    report = buildSwitchReport(options.currentLink, currentRelease, activeRelease, candidateReport);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (temporaryLinkCreated) {
    await unlink(temporaryLink).catch((error) => cleanupErrors.push(error));
  }
  if (lockHandle) {
    await lockHandle.close().catch((error) => cleanupErrors.push(error));
    await unlink(lockPath).catch((error) => cleanupErrors.push(error));
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "release 切换失败，且本次临时项未能完全清理。",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new ReleaseSwitchError(
      "switch_committed_cleanup_failed",
      "release 已完成切换，但本次锁或临时链接清理失败；保持维护并人工核查。",
      switched,
    );
  }
  return report!;
}

function normalizeSwitchOptions(options: ReleaseSwitchOptions): ReleaseSwitchOptions {
  for (const [name, value] of Object.entries(options)) {
    if (!path.isAbsolute(value)) {
      throw new ReleaseSwitchError("invalid_path", `${name} 必须使用绝对路径。`);
    }
  }
  return {
    currentLink: path.resolve(options.currentLink),
    expectedCurrent: path.resolve(options.expectedCurrent),
    newRelease: path.resolve(options.newRelease),
  };
}

async function resolveReleaseDirectory(value: string, label: string) {
  let resolved: string;
  try {
    resolved = await realpath(value);
  } catch {
    throw new ReleaseSwitchError("release_missing", `${label} release 不存在或不可读取。`);
  }
  const resolvedStat = await stat(resolved);
  if (!resolvedStat.isDirectory()) {
    throw new ReleaseSwitchError("release_not_directory", `${label} release 必须是目录。`);
  }
  return resolved;
}

function buildSwitchReport(
  currentLink: string,
  previousRelease: string,
  activeRelease: string,
  candidate: ReleaseCandidateReport,
): ReleaseSwitchReport {
  return {
    currentLink,
    previousRelease,
    activeRelease,
    checkedRequiredPaths: candidate.checkedRequiredPaths,
    runtimeDependencyCount: candidate.runtimeDependencyCount,
    migrationCount: candidate.migrationCount,
  };
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function toKebabCase(value: string) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}
