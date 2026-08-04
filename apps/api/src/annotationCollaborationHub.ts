import type { AnnotationRevisionAdvancedMessage } from "@xiqu/shared";

export type AnnotationRevisionEvent = Omit<
  AnnotationRevisionAdvancedMessage,
  "version" | "type"
>;

export type AnnotationRevisionPublisher = {
  publishRevisionAdvanced: (event: AnnotationRevisionEvent) => void;
};

export type AnnotationRevisionDeliveryResult = "accepted" | "duplicate";

type Subscriber = {
  send: (event: AnnotationRevisionAdvancedMessage) => void;
  close: (code: number, reason: string) => void;
};

export class AnnotationCollaborationHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly latestRevision = new Map<string, number>();

  subscribe(annotationFileId: string, subscriber: Subscriber) {
    const fileSubscribers = this.subscribers.get(annotationFileId) ?? new Set<Subscriber>();
    fileSubscribers.add(subscriber);
    this.subscribers.set(annotationFileId, fileSubscribers);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      fileSubscribers.delete(subscriber);
      if (!fileSubscribers.size) this.subscribers.delete(annotationFileId);
    };
  }

  deliverRevisionAdvanced(event: AnnotationRevisionEvent): AnnotationRevisionDeliveryResult {
    const previous = this.latestRevision.get(event.annotationFileId) ?? 0;
    if (event.revision <= previous) return "duplicate";
    this.latestRevision.set(event.annotationFileId, event.revision);
    const message: AnnotationRevisionAdvancedMessage = {
      version: 1,
      type: "annotation.revision.advanced",
      ...event,
    };
    // 单个慢连接的发送失败不能阻止同文件其他浏览器收到权威失效通知。
    for (const subscriber of this.subscribers.get(event.annotationFileId) ?? []) {
      try {
        subscriber.send(message);
      } catch {
        subscriber.close(1011, "revision_delivery_failed");
      }
    }
    return "accepted";
  }

  closeAll() {
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) subscriber.close(1001, "server_shutdown");
    }
    this.subscribers.clear();
    this.latestRevision.clear();
  }
}
