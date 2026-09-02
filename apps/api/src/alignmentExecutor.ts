import type { Readable } from "node:stream";
import type {
  AlignmentExecutorOutput,
  AlignmentTextProjection,
} from "@xiqu/document-model";

export type ForceAlignmentAudioInput =
  | { kind: "uploaded"; stream: Readable }
  | { kind: "vod"; url: string };

export type ForceAlignmentExecutorInput = {
  projection: AlignmentTextProjection;
  audioOffsetMicros: number;
  audio: ForceAlignmentAudioInput;
  model: {
    name: string;
    version: string;
    dictionaryVersion: string;
    codeVersion: string;
    config: Record<string, unknown>;
  };
};

/**
 * 模型实现的最小端口。执行器不持有数据库或对象存储能力，只能返回待校验的预测值。
 * 生产执行器可以在后续通过进程/容器适配该接口；测试实现不得进入 composition root。
 */
export interface ForceAlignmentExecutor {
  execute(
    input: ForceAlignmentExecutorInput,
    signal: AbortSignal,
  ): Promise<AlignmentExecutorOutput | unknown>;
}

export class ForceAlignmentExecutorError extends Error {
  constructor(readonly code:
    | "alignment_executor_unavailable"
    | "alignment_execution_failed"
    | "alignment_temporary_cleanup_failed") {
    super(`Force alignment executor failed: ${code}`);
  }
}
