import type {
  AnnotationCollaborationServerMessage,
  AnnotationPresenceMember,
  AnnotationRemoteTimelineActivityMessage,
  AnnotationRevisionAdvancedMessage,
} from "@xiqu/shared";

export type AnnotationRevisionEvent = Omit<
  AnnotationRevisionAdvancedMessage,
  "version" | "type"
>;

export type AnnotationRevisionPublisher = {
  publishRevisionAdvanced: (event: AnnotationRevisionEvent) => void;
};

export type AnnotationRevisionDeliveryResult = "accepted" | "duplicate";

export type AnnotationCollaborationSubscriber = {
  activitySessionId?: string;
  send: (event: AnnotationCollaborationServerMessage) => void;
  close: (code: number, reason: string) => void;
};

export class AnnotationCollaborationHub {
  private readonly subscribers = new Map<string, Set<AnnotationCollaborationSubscriber>>();
  private readonly latestRevision = new Map<string, number>();
  private readonly latestPresenceFingerprint = new Map<string, string>();
  private readonly latestActivitySequence = new Map<string, number>();

  subscribe(annotationFileId: string, subscriber: AnnotationCollaborationSubscriber) {
    const fileSubscribers = this.subscribers.get(annotationFileId) ??
      new Set<AnnotationCollaborationSubscriber>();
    fileSubscribers.add(subscriber);
    this.subscribers.set(annotationFileId, fileSubscribers);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      fileSubscribers.delete(subscriber);
      if (!fileSubscribers.size) {
        this.subscribers.delete(annotationFileId);
        // 最后一个本地订阅者离开后，旧 fingerprint 不再代表下一批会话已经收到首帧。
        // 清除它可保证相同成员结构的快速重连仍会收到权威 presence snapshot。
        this.latestPresenceFingerprint.delete(annotationFileId);
      }
    };
  }

  hasSubscribers(annotationFileId: string) {
    return Boolean(this.subscribers.get(annotationFileId)?.size);
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

  deliverPresenceSnapshot(
    annotationFileId: string,
    members: AnnotationPresenceMember[],
    generatedAt = new Date().toISOString(),
  ): AnnotationRevisionDeliveryResult {
    // lastSeenAt 会在 heartbeat 时变化，但成员身份未变；fingerprint 只描述 UI 可见的成员结构。
    const fingerprint = JSON.stringify(members.map((member) => [
      member.userId,
      member.accountName,
      member.displayName,
      member.connectionCount,
    ]));
    if (this.latestPresenceFingerprint.get(annotationFileId) === fingerprint) return "duplicate";
    this.latestPresenceFingerprint.set(annotationFileId, fingerprint);
    const message: AnnotationCollaborationServerMessage = {
      version: 1,
      type: "presence.snapshot",
      annotationFileId,
      generatedAt,
      members,
    };
    for (const subscriber of this.subscribers.get(annotationFileId) ?? []) {
      try {
        subscriber.send(message);
      } catch {
        subscriber.close(1011, "presence_delivery_failed");
      }
    }
    return "accepted";
  }

  deliverRemoteActivity(
    event: Omit<AnnotationRemoteTimelineActivityMessage, "version" | "type">,
  ): AnnotationRevisionDeliveryResult {
    const eventKey = `${event.annotationFileId}\u0000${event.activitySessionId}`;
    const previousSequence = this.latestActivitySequence.get(eventKey) ?? 0;
    if (event.sequence <= previousSequence) return "duplicate";
    this.latestActivitySequence.set(eventKey, event.sequence);
    // clear 也保留 sequence tombstone，防止跨实例乱序的旧播放头重新复活。
    trimOldestEntries(this.latestActivitySequence, 10_000);
    const message: AnnotationRemoteTimelineActivityMessage = {
      version: 1,
      type: "presence.timeline_activity.changed",
      ...event,
    };
    for (const subscriber of this.subscribers.get(event.annotationFileId) ?? []) {
      if (subscriber.activitySessionId === event.activitySessionId) continue;
      try {
        subscriber.send(message);
      } catch {
        subscriber.close(1011, "remote_activity_delivery_failed");
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
    this.latestPresenceFingerprint.clear();
    this.latestActivitySequence.clear();
  }
}

function trimOldestEntries(values: Map<string, number>, maximum: number) {
  while (values.size > maximum) {
    const oldest = values.keys().next().value;
    if (typeof oldest !== "string") return;
    values.delete(oldest);
  }
}
