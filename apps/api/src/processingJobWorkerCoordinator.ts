export type ProcessingJobWorkerAdapter = {
  recoverStaleJobs(): Promise<number>;
  processNext(workerId: string, signal?: AbortSignal): Promise<boolean>;
};

/**
 * 一个 worker 进程只保留一个轮询 owner；协调器用轮转优先级组合不同任务适配器，
 * 防止持续产生的媒体任务让强制对齐长期饥饿。
 */
export class ProcessingJobWorkerCoordinator implements ProcessingJobWorkerAdapter {
  private nextAdapterIndex = 0;

  constructor(private readonly adapters: readonly ProcessingJobWorkerAdapter[]) {
    if (adapters.length === 0) throw new Error("后台任务 worker 至少需要一个任务适配器。");
  }

  async recoverStaleJobs() {
    let recovered = 0;
    for (const adapter of this.adapters) recovered += await adapter.recoverStaleJobs();
    return recovered;
  }

  async processNext(workerId: string, signal?: AbortSignal) {
    for (let offset = 0; offset < this.adapters.length; offset += 1) {
      const index = (this.nextAdapterIndex + offset) % this.adapters.length;
      if (await this.adapters[index]!.processNext(workerId, signal)) {
        this.nextAdapterIndex = (index + 1) % this.adapters.length;
        return true;
      }
    }
    return false;
  }
}
