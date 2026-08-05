import type { ApiObservability } from "./observability.js";
import {
  parseSerializedAnnotationRemoteActivityEventEnvelope,
  serializeAnnotationRemoteActivityEventEnvelope,
  type AnnotationRemoteActivityEvent,
} from "./annotationRemoteActivityEventEnvelope.js";
import {
  PostgresCoalescedEventBus,
  type PostgresCoalescedEventBusOptions,
  type PostgresEventTransport,
} from "./postgresCoalescedEventBus.js";

export type AnnotationRemoteActivityPublisher = {
  publishRemoteActivity: (event: AnnotationRemoteActivityEvent) => void;
};

type ActivityBusOptions = {
  transport: PostgresEventTransport;
  channel: string;
  deliver: (event: AnnotationRemoteActivityEvent) => "accepted" | "duplicate";
  observability: Pick<
    ApiObservability,
    | "setAnnotationRemoteActivityBusConnected"
    | "setAnnotationRemoteActivityBusPendingSessions"
    | "recordAnnotationRemoteActivityBusPublish"
    | "recordAnnotationRemoteActivityBusInbound"
    | "recordAnnotationRemoteActivityBusReconnect"
  >;
  logger: PostgresCoalescedEventBusOptions<AnnotationRemoteActivityEvent, "accepted" | "duplicate">["logger"];
  instanceId?: string;
  maxPendingSessions?: number;
};

// 高频活动按“文件 + 连接会话”合并，只保留 sequence 更新的一帧或 clear。
export class PostgresAnnotationRemoteActivityEventBus implements AnnotationRemoteActivityPublisher {
  private readonly core: PostgresCoalescedEventBus<AnnotationRemoteActivityEvent, "accepted" | "duplicate">;

  constructor(options: ActivityBusOptions) {
    this.core = new PostgresCoalescedEventBus({
      transport: options.transport,
      channel: options.channel,
      getKey: (event) => `${event.annotationFileId}\u0000${event.activitySessionId}`,
      coalesce: (existing, incoming) => incoming.sequence >= existing.sequence ? incoming : existing,
      serialize: serializeAnnotationRemoteActivityEventEnvelope,
      parse: parseSerializedAnnotationRemoteActivityEventEnvelope,
      deliver: options.deliver,
      metrics: {
        setConnected: options.observability.setAnnotationRemoteActivityBusConnected.bind(options.observability),
        setPendingKeys: options.observability.setAnnotationRemoteActivityBusPendingSessions.bind(options.observability),
        recordPublish: options.observability.recordAnnotationRemoteActivityBusPublish.bind(options.observability),
        recordInbound: options.observability.recordAnnotationRemoteActivityBusInbound.bind(options.observability),
        recordReconnect: options.observability.recordAnnotationRemoteActivityBusReconnect.bind(options.observability),
      },
      logger: options.logger,
      instanceId: options.instanceId,
      maxPendingKeys: options.maxPendingSessions,
    });
  }

  start() {
    return this.core.start();
  }

  publishRemoteActivity(event: AnnotationRemoteActivityEvent) {
    this.core.publish(event);
  }

  close() {
    return this.core.close();
  }
}
