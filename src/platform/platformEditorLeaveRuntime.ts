import type { PlatformSaveOutcome } from "../utils/platformOperations";

export type PlatformEditorLeaveFacts = {
  dirty: boolean;
  blockedReason: string | null;
};

export type PlatformEditorLeaveResult =
  | { status: "ready" }
  | { status: "blocked"; message: string };

export type PlatformEditorLeaveDependencies = {
  preparePendingEditors: () => boolean;
  waitForActiveSave: () => Promise<void>;
  getFacts: () => PlatformEditorLeaveFacts;
  save: () => Promise<PlatformSaveOutcome>;
  flushDraft: () => Promise<{ ok: boolean; message?: string }>;
  finalizeCleanExit: () => Promise<{ ok: boolean; message?: string }>;
  maxSaveAttempts?: number;
};

const DEFAULT_MAX_SAVE_ATTEMPTS = 4;
type PlatformSkippedSaveReason = Extract<
  PlatformSaveOutcome,
  { status: "skipped" }
>["reason"];

// 离开事务只协调现有保存能力，不复制 revision、租约或冲突处理。每轮都重新读取事实，
// 因为等待网络期间产生的新编辑必须进入下一批保存，不能被上一批确认顺带带出编辑器。
export async function preparePlatformEditorLeave(
  dependencies: PlatformEditorLeaveDependencies,
): Promise<PlatformEditorLeaveResult> {
  try {
    return await runPlatformEditorLeave(dependencies);
  } catch (error) {
    return preserveBlockedLeave(
      dependencies,
      error instanceof Error ? error.message : "离开前保存发生未知错误。",
    );
  }
}

async function runPlatformEditorLeave(
  dependencies: PlatformEditorLeaveDependencies,
): Promise<PlatformEditorLeaveResult> {
  if (!dependencies.preparePendingEditors()) {
    return preserveBlockedLeave(
      dependencies,
      "当前文字输入尚未完成，请先修正或确认输入内容后再返回资源管理器。",
    );
  }

  const maxSaveAttempts = Math.max(1, dependencies.maxSaveAttempts ?? DEFAULT_MAX_SAVE_ATTEMPTS);
  for (let attempt = 0; attempt < maxSaveAttempts; attempt += 1) {
    // 自动保存可能已经先一步启动；必须等待同一 single-flight，而不是把 busy 当成保存成功。
    await dependencies.waitForActiveSave();
    const facts = dependencies.getFacts();
    if (facts.blockedReason) {
      return preserveBlockedLeave(dependencies, facts.blockedReason);
    }
    if (!facts.dirty) {
      const finalized = await dependencies.finalizeCleanExit();
      return finalized.ok
        ? { status: "ready" }
        : {
            status: "blocked",
            message: `服务器已保存，但退出前的本机同步清理未完成：${finalized.message ?? "未知错误"}`,
          };
    }

    const outcome = await dependencies.save();
    if (outcome.status === "saved" || outcome.status === "rebased") {
      // saved 只确认冻结批次；rebased 还没有提交重建后的命令，两者都必须回到循环重新审计最新状态。
      continue;
    }
    if (outcome.status === "skipped") {
      if (outcome.reason === "clean" || outcome.reason === "busy") {
        continue;
      }
      return preserveBlockedLeave(dependencies, describeSkippedSave(outcome.reason));
    }
    return preserveBlockedLeave(dependencies, outcome.message);
  }

  return preserveBlockedLeave(
    dependencies,
    "保存期间仍有新的修改进入。为避免遗漏内容，已留在编辑器，请停止编辑后再次返回。",
  );
}

async function preserveBlockedLeave(
  dependencies: PlatformEditorLeaveDependencies,
  message: string,
): Promise<PlatformEditorLeaveResult> {
  // 浏览器草稿只是失败保护，不能替代权威服务器保存；附加失败原因便于用户判断是否可以安全关闭页面。
  const draft = await dependencies.flushDraft().catch((error: unknown) => ({
    ok: false,
    message: error instanceof Error ? error.message : "浏览器恢复草稿写入失败。",
  }));
  return {
    status: "blocked",
    message: draft.ok
      ? `${message}\n当前修改已保留为本机恢复草稿。`
      : `${message}\n本机恢复草稿也未能写入：${draft.message ?? "未知错误"}`,
  };
}

function describeSkippedSave(
  reason: Exclude<PlatformSkippedSaveReason, "clean" | "busy">,
) {
  if (reason === "read-only") return "当前文件已经变为只读，未保存修改不能自动提交。";
  if (reason === "transient-edit") return "当前拖拽或缩放尚未结束，请完成操作后再返回。";
  return "当前会话不是可保存的平台文件，未执行服务器保存。";
}
