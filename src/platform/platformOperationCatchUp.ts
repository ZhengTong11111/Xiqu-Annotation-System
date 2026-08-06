import type {
  AnnotationCommittedOperationPage,
  AnnotationOperationRecord,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import type { ProjectSyncStatus } from "../state/projectDocumentState";
import { applyAnnotationCommandToProject } from "../utils/annotationCommandApply";

export const PLATFORM_CATCH_UP_PAGE_SIZE = 200;
export const PLATFORM_CATCH_UP_MAX_PAGES = 10;

export type PlatformOperationCatchUpResult =
  | {
      status: "up_to_date";
      revision: number;
      cursor: string;
    }
  | {
      status: "applied";
      project: ProjectData;
      revision: number;
      cursor: string;
      operationCount: number;
    }
  | {
      status: "requires_snapshot";
      reason: PlatformCatchUpSnapshotReason;
    };

export type PlatformCatchUpSnapshotReason =
  | "revision_behind"
  | "revision_gap"
  | "invalid_page"
  | "pagination_limit"
  | "requires_snapshot_operation"
  | "command_precondition_failed";

type CatchUpInput = {
  annotationFileId: string;
  project: ProjectData;
  knownRevision: number;
  cursor: string;
  listPage: (
    annotationFileId: string,
    options: { cursor: string; limit: number },
  ) => Promise<AnnotationCommittedOperationPage>;
  maxPages?: number;
};

export type PlatformOperationCatchUpEligibilityFacts = {
  hasUnsavedChanges: boolean;
  pendingOperationCount: number;
  hasTransientEdit: boolean;
  hasInlineEdit: boolean;
  hasPendingMergeDraft: boolean;
  syncStatus: ProjectSyncStatus;
  saveInFlight: boolean;
  mediaBindingBusy: boolean;
};

// 同步错误不应把完全干净的客户端永久锁死；此处集中定义权威追赶资格，防止 UI 与状态机各自维护条件。
// 只要仍有任何本地修改或交互上下文，就继续 fail closed，绝不以远端结果覆盖浏览器中的未提交工作。
export function canAttemptPlatformOperationCatchUp(
  facts: PlatformOperationCatchUpEligibilityFacts,
): boolean {
  const canRecoverFromStatus = facts.syncStatus === "saved" || facts.syncStatus === "error";
  return canRecoverFromStatus &&
    !facts.hasUnsavedChanges &&
    facts.pendingOperationCount === 0 &&
    !facts.hasTransientEdit &&
    !facts.hasInlineEdit &&
    !facts.hasPendingMergeDraft &&
    !facts.saveInFlight &&
    !facts.mediaBindingBusy;
}

// committed feed 先完整验证并在局部项目上顺序重放；只有整个 revision 链闭合后才向调用方交付新项目。
export async function catchUpCommittedAnnotationOperations({
  annotationFileId,
  project,
  knownRevision,
  cursor,
  listPage,
  maxPages = PLATFORM_CATCH_UP_MAX_PAGES,
}: CatchUpInput): Promise<PlatformOperationCatchUpResult> {
  let nextCursor = cursor;
  let latestServerRevision = knownRevision;
  const operations: AnnotationOperationRecord[] = [];

  // 一次检查最多读取固定页数，避免异常服务端或超活跃文件让前台轮询无限占用主线程。
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await listPage(annotationFileId, {
      cursor: nextCursor,
      limit: PLATFORM_CATCH_UP_PAGE_SIZE,
    });
    if (
      !isValidRevision(page.currentRevision) ||
      page.currentRevision < knownRevision ||
      page.currentRevision < latestServerRevision
    ) {
      return { status: "requires_snapshot", reason: "revision_behind" };
    }
    latestServerRevision = Math.max(latestServerRevision, page.currentRevision);

    // 页内事实必须与 committed 合同一致；客户端不修补坏顺序或伪造缺失字段。
    if (!isValidCommittedPage(
      page,
      annotationFileId,
      knownRevision,
      operations[operations.length - 1],
    )) {
      return { status: "requires_snapshot", reason: "invalid_page" };
    }
    operations.push(...page.items);

    if (!page.hasMore) {
      nextCursor = page.nextCursor ?? nextCursor;
      break;
    }
    if (page.items.length === 0) {
      return { status: "requires_snapshot", reason: "invalid_page" };
    }
    if (!page.nextCursor || page.nextCursor === nextCursor) {
      return { status: "requires_snapshot", reason: "invalid_page" };
    }
    nextCursor = page.nextCursor;

    if (pageIndex === maxPages - 1) {
      return { status: "requires_snapshot", reason: "pagination_limit" };
    }
  }

  if (latestServerRevision === knownRevision && operations.length === 0) {
    return { status: "up_to_date", revision: knownRevision, cursor: nextCursor };
  }

  // 每一个已推进 revision 都必须有可见 committed operation；无操作保存或竞态一律重取权威快照。
  const revisions = new Set(operations.map((operation) => operation.committedRevision));
  for (let revision = knownRevision + 1; revision <= latestServerRevision; revision += 1) {
    if (!revisions.has(revision)) {
      return { status: "requires_snapshot", reason: "revision_gap" };
    }
  }

  let nextProject = project;
  for (const operation of operations) {
    if (operation.replayability !== "domain_command") {
      return { status: "requires_snapshot", reason: "requires_snapshot_operation" };
    }
    const applied = applyAnnotationCommandToProject(nextProject, operation.payload);
    if (applied.status !== "applied") {
      return { status: "requires_snapshot", reason: "command_precondition_failed" };
    }
    nextProject = applied.project;
  }

  return {
    status: "applied",
    project: nextProject,
    revision: latestServerRevision,
    cursor: nextCursor,
    operationCount: operations.length,
  };
}

// 数值字段来自网络边界，必须在参与排序和 revision 循环前收窄为非负安全整数。
function isValidRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// committed 页要求全局严格递增，且不能混入 accepted/rejected 或属于其他文件的记录。
function isValidCommittedPage(
  page: AnnotationCommittedOperationPage,
  annotationFileId: string,
  knownRevision: number,
  previousOperation?: AnnotationOperationRecord,
): boolean {
  let previous = previousOperation;
  for (const operation of page.items) {
    if (
      operation.commitState !== "committed" ||
      operation.status !== "accepted" ||
      operation.annotationFileId !== annotationFileId ||
      operation.committedRevision === null ||
      !isValidRevision(operation.committedRevision) ||
      operation.committedRevision <= knownRevision ||
      operation.committedRevision > page.currentRevision ||
      !Number.isSafeInteger(operation.sequence) ||
      operation.sequence <= 0 ||
      (previous && compareCommittedOrder(previous, operation) >= 0)
    ) {
      return false;
    }
    previous = operation;
  }
  return true;
}

// committed revision 是第一排序键，acceptance sequence 只稳定同一 revision 内的顺序。
function compareCommittedOrder(
  left: AnnotationOperationRecord,
  right: AnnotationOperationRecord,
): number {
  const leftRevision = left.committedRevision ?? -1;
  const rightRevision = right.committedRevision ?? -1;
  return leftRevision - rightRevision || left.sequence - right.sequence;
}
