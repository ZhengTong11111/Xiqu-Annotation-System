import type { ApiObservability } from "./observability.js";
import {
  parseSerializedAnnotationPresenceEventEnvelope,
  serializeAnnotationPresenceEventEnvelope,
  type AnnotationPresenceChangedEvent,
} from "./annotationPresenceEventEnvelope.js";
import {
  PostgresCoalescedEventBus,
  type PostgresCoalescedEventBusOptions,
  type PostgresEventTransport,
} from "./postgresCoalescedEventBus.js";

export type AnnotationPresenceInvalidationPublisher = {
  publishPresenceChanged: (annotationFileId: string) => void;
};

type DeliveryResult = "accepted" | "duplicate";

type AnnotationPresenceEventBusOptions = {
  transport: PostgresEventTransport;
  channel: string;
  deliver: (event: AnnotationPresenceChangedEvent) => DeliveryResult;
  observability: Pick<
    ApiObservability,
    | "setAnnotationPresenceBusConnected"
    | "setAnnotationPresenceBusPendingFiles"
    | "recordAnnotationPresenceBusPublish"
    | "recordAnnotationPresenceBusInbound"
    | "recordAnnotationPresenceBusReconnect"
  >;
  logger: PostgresCoalescedEventBusOptions<AnnotationPresenceChangedEvent, DeliveryResult>["logger"];
  instanceId?: string;
  maxPendingFiles?: number;
  setTimer?: PostgresCoalescedEventBusOptions<AnnotationPresenceChangedEvent, DeliveryResult>["setTimer"];
  clearTimer?: PostgresCoalescedEventBusOptions<AnnotationPresenceChangedEvent, DeliveryResult>["clearTimer"];
  random?: () => number;
};

/**
 * Presence bus 只广播文件级 invalidation；成员名单必须由接收实例重新查询 PostgreSQL。
 */
export class PostgresAnnotationPresenceEventBus
implements AnnotationPresenceInvalidationPublisher {
  private readonly core: PostgresCoalescedEventBus<AnnotationPresenceChangedEvent, DeliveryResult>;

  constructor(options: AnnotationPresenceEventBusOptions) {
    this.core = new PostgresCoalescedEventBus({
      transport: options.transport,
      channel: options.channel,
      getKey: (event) => event.annotationFileId,
      // 同文件 invalidation 没有内容差异；保留任意一个即可表达“重新读取”。
      coalesce: (_existing, incoming) => incoming,
      serialize: serializeAnnotationPresenceEventEnvelope,
      parse: parseSerializedAnnotationPresenceEventEnvelope,
      deliver: options.deliver,
      metrics: {
        setConnected: (connected) => options.observability.setAnnotationPresenceBusConnected(connected),
        setPendingKeys: (count) => options.observability.setAnnotationPresenceBusPendingFiles(count),
        recordPublish: (result) => options.observability.recordAnnotationPresenceBusPublish(result),
        recordInbound: (result) => options.observability.recordAnnotationPresenceBusInbound(result),
        recordReconnect: () => options.observability.recordAnnotationPresenceBusReconnect(),
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

  publishPresenceChanged(annotationFileId: string) {
    this.core.publish({ annotationFileId });
  }

  close() {
    return this.core.close();
  }
}
