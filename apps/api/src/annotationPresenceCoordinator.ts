import type { AnnotationCollaborationHub } from "./annotationCollaborationHub.js";
import type { AnnotationPresenceService } from "./annotationPresenceService.js";

const PERIODIC_INVALIDATION_INTERVAL_MS = 20_000;

type RefreshState = {
  pending: boolean;
  promise: Promise<void>;
};

type AnnotationPresenceReader = Pick<AnnotationPresenceService, "listActive">;

/**
 * Coordinator 把有损文件级 invalidation 转成数据库权威成员快照。
 * 同文件查询 single-flight；查询中再次失效只追加一轮，旧结果不会越过更新后的结果成为最终状态。
 */
export class AnnotationPresenceCoordinator {
  private readonly refreshes = new Map<string, RefreshState>();
  private readonly lastPeriodicInvalidation = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly presence: AnnotationPresenceReader,
    private readonly hub: AnnotationCollaborationHub,
    private readonly logger: { error: (error: unknown, message?: string) => void },
  ) {}

  // 文件级失效只触发权威重读；同一文件同时最多运行一个查询循环。
  requestRefresh(annotationFileId: string): "accepted" | "duplicate" {
    if (this.closed || !this.hub.hasSubscribers(annotationFileId)) {
      this.lastPeriodicInvalidation.delete(annotationFileId);
      return "duplicate";
    }
    const active = this.refreshes.get(annotationFileId);
    if (active) {
      active.pending = true;
      return "duplicate";
    }
    const state: RefreshState = {
      pending: false,
      promise: Promise.resolve(),
    };
    state.promise = this.refreshLoop(annotationFileId, state)
      .finally(() => this.refreshes.delete(annotationFileId));
    this.refreshes.set(annotationFileId, state);
    return "accepted";
  }

  // 多个连接共享文件级周期门禁，避免每个 tab 都广播一次过期清理提示。
  claimPeriodicInvalidation(annotationFileId: string, now = Date.now()) {
    if (this.closed || !this.hub.hasSubscribers(annotationFileId)) return false;
    const previous = this.lastPeriodicInvalidation.get(annotationFileId) ?? 0;
    if (now - previous < PERIODIC_INVALIDATION_INTERVAL_MS) return false;
    this.lastPeriodicInvalidation.set(annotationFileId, now);
    return true;
  }

  // 关闭时等待已经开始的数据库读取收口，之后不再向 hub 投递快照。
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lastPeriodicInvalidation.clear();
    await Promise.allSettled([...this.refreshes.values()].map(({ promise }) => promise));
    this.refreshes.clear();
  }

  private async refreshLoop(annotationFileId: string, state: RefreshState) {
    do {
      state.pending = false;
      try {
        const members = await this.presence.listActive(annotationFileId);
        if (!this.closed && this.hub.hasSubscribers(annotationFileId)) {
          this.hub.deliverPresenceSnapshot(annotationFileId, members);
        }
      } catch (error) {
        this.logger.error(error, "annotation presence snapshot refresh failed");
      }
    } while (!this.closed && state.pending && this.hub.hasSubscribers(annotationFileId));
  }
}
