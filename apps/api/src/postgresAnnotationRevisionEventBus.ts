import type { Pool } from "pg";
import type {
  AnnotationRevisionEvent,
  AnnotationRevisionPublisher,
} from "./annotationCollaborationHub.js";
import type { ApiObservability } from "./observability.js";
import {
  parseSerializedAnnotationRevisionEventEnvelope,
  serializeAnnotationRevisionEventEnvelope,
} from "./annotationRevisionEventEnvelope.js";
import {
  createPostgresEventTransport,
  PostgresCoalescedEventBus,
  type PostgresCoalescedEventBusOptions,
  type PostgresEventTransport,
} from "./postgresCoalescedEventBus.js";

export type AnnotationRevisionEventTransport = PostgresEventTransport;

type AnnotationRevisionEventBusOptions = {
  transport: AnnotationRevisionEventTransport;
  channel: string;
  deliver: (event: AnnotationRevisionEvent) => "accepted" | "duplicate";
  observability: Pick<
    ApiObservability,
    | "setAnnotationRevisionBusConnected"
    | "setAnnotationRevisionBusPendingFiles"
    | "recordAnnotationRevisionBusPublish"
    | "recordAnnotationRevisionBusInbound"
    | "recordAnnotationRevisionBusReconnect"
  >;
  logger: PostgresCoalescedEventBusOptions<AnnotationRevisionEvent, "accepted" | "duplicate">["logger"];
  instanceId?: string;
  maxPendingFiles?: number;
  setTimer?: PostgresCoalescedEventBusOptions<AnnotationRevisionEvent, "accepted" | "duplicate">["setTimer"];
  clearTimer?: PostgresCoalescedEventBusOptions<AnnotationRevisionEvent, "accepted" | "duplicate">["clearTimer"];
  random?: () => number;
};

/**
 * revision 包装器只定义“同文件保留最高 revision”和指标映射。
 * LISTEN 生命周期、有界队列与重连由共享 PostgreSQL event-bus 核心维护。
 */
export class PostgresAnnotationRevisionEventBus implements AnnotationRevisionPublisher {
  private readonly core: PostgresCoalescedEventBus<
    AnnotationRevisionEvent,
    "accepted" | "duplicate"
  >;

  constructor(options: AnnotationRevisionEventBusOptions) {
    this.core = new PostgresCoalescedEventBus({
      transport: options.transport,
      channel: options.channel,
      getKey: (event) => event.annotationFileId,
      coalesce: (existing, incoming) => incoming.revision > existing.revision
        ? incoming
        : existing,
      serialize: serializeAnnotationRevisionEventEnvelope,
      parse: (payload) => {
        const envelope = parseSerializedAnnotationRevisionEventEnvelope(payload);
        return envelope
          ? {
              annotationFileId: envelope.annotationFileId,
              revision: envelope.revision,
              operationCursor: envelope.operationCursor,
            }
          : null;
      },
      deliver: options.deliver,
      metrics: {
        setConnected: (connected) =>
          options.observability.setAnnotationRevisionBusConnected(connected),
        setPendingKeys: (count) =>
          options.observability.setAnnotationRevisionBusPendingFiles(count),
        recordPublish: (result) =>
          options.observability.recordAnnotationRevisionBusPublish(result),
        recordInbound: (result) =>
          options.observability.recordAnnotationRevisionBusInbound(result),
        recordReconnect: () => options.observability.recordAnnotationRevisionBusReconnect(),
      },
      logger: options.logger,
      instanceId: options.instanceId,
      maxPendingKeys: options.maxPendingFiles,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      random: options.random,
    });
  }

  start() {
    return this.core.start();
  }

  publishRevisionAdvanced(event: AnnotationRevisionEvent) {
    this.core.publish(event);
  }

  close() {
    return this.core.close();
  }
}

export function createPostgresAnnotationRevisionTransport(pool: Pool) {
  return createPostgresEventTransport(pool);
}
