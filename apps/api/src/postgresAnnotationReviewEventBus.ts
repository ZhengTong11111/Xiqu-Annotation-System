import type { AnnotationReviewEvent, AnnotationReviewPublisher } from "./annotationCollaborationHub.js";
import {
  parseSerializedAnnotationReviewEventEnvelope,
  serializeAnnotationReviewEventEnvelope,
} from "./annotationReviewEventEnvelope.js";
import {
  PostgresCoalescedEventBus,
  type PostgresCoalescedEventBusOptions,
  type PostgresEventTransport,
} from "./postgresCoalescedEventBus.js";

type DeliveryResult = "accepted" | "duplicate";

// 同一文件的连续审核变化可合并为一次失效提示；客户端随后通过 HTTP 读取完整权威列表。
export class PostgresAnnotationReviewEventBus implements AnnotationReviewPublisher {
  private readonly core: PostgresCoalescedEventBus<AnnotationReviewEvent, DeliveryResult>;

  constructor(options: {
    transport: PostgresEventTransport;
    channel: string;
    deliver: (event: AnnotationReviewEvent) => DeliveryResult;
    logger: PostgresCoalescedEventBusOptions<AnnotationReviewEvent, DeliveryResult>["logger"];
  }) {
    this.core = new PostgresCoalescedEventBus({
      transport: options.transport,
      channel: options.channel,
      getKey: (event) => event.annotationFileId,
      coalesce: (_existing, incoming) => incoming,
      serialize: serializeAnnotationReviewEventEnvelope,
      parse: (payload) => {
        const envelope = parseSerializedAnnotationReviewEventEnvelope(payload);
        return envelope ? {
          annotationFileId: envelope.annotationFileId,
          eventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
        } : null;
      },
      deliver: options.deliver,
      // 审核失效共用成熟总线，但不虚构 revision 指标；专项指标可在有运维需求时补充。
      metrics: {
        setConnected: () => undefined,
        setPendingKeys: () => undefined,
        recordPublish: () => undefined,
        recordInbound: () => undefined,
        recordReconnect: () => undefined,
      },
      logger: options.logger,
    });
  }

  start() { return this.core.start(); }
  publishReviewChanged(event: AnnotationReviewEvent) { this.core.publish(event); }
  close() { return this.core.close(); }
}
