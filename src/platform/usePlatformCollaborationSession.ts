import { useEffect, useRef, useState } from "react";
import {
  ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX,
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  type AnnotationCollaborationServerMessage,
} from "@xiqu/shared";
import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import {
  createPlatformCollaborationRuntime,
  type PlatformCollaborationRuntime,
  type PlatformCollaborationStatus,
} from "./platformCollaborationRuntime";

type UsePlatformCollaborationSessionOptions = {
  client: PlatformClient | null;
  annotationFileId: string | null;
  enabled: boolean;
  online: boolean;
  onMessage: (message: AnnotationCollaborationServerMessage) => void;
  onError: (error: unknown) => void;
};

// React hook 只适配平台客户端与浏览器 WebSocket；重连、超时和迟到回调由纯运行时统一管理。
export function usePlatformCollaborationSession(
  options: UsePlatformCollaborationSessionOptions,
): PlatformCollaborationStatus {
  const [status, setStatus] = useState<PlatformCollaborationStatus>("disabled");
  const clientRef = useRef(options.client);
  const messageRef = useRef(options.onMessage);
  const errorRef = useRef(options.onError);
  const runtimeRef = useRef<PlatformCollaborationRuntime | null>(null);
  clientRef.current = options.client;
  messageRef.current = options.onMessage;
  errorRef.current = options.onError;

  function ensureRuntime() {
    if (runtimeRef.current) return runtimeRef.current;
    runtimeRef.current = createPlatformCollaborationRuntime({
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      random: Math.random,
      requestTicket: async (facts) => {
        const client = clientRef.current;
        if (!client) throw new Error("平台客户端已离开当前编辑会话。");
        return client.issueAnnotationCollaborationTicket(facts.sessionKey);
      },
      createSocket: (ticket) => {
        const client = clientRef.current;
        if (!client) throw new Error("平台客户端已离开当前编辑会话。");
        // 一次性票据走 WebSocket 子协议头，避免 upgrade URL 被常规访问日志完整记录。
        return new WebSocket(
          client.createAnnotationCollaborationWebSocketUrl(ticket),
          [
            ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
            `${ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`,
          ],
        );
      },
      isPermanentTicketError: (error) =>
        error instanceof PlatformApiError && [401, 403, 404].includes(error.status),
      onStatusChange: setStatus,
      onMessage: (message) => messageRef.current(message),
      onError: (error) => errorRef.current(error),
    });
    return runtimeRef.current;
  }

  useEffect(() => {
    ensureRuntime().update({
      enabled: options.enabled,
      online: options.online,
      sessionKey: options.annotationFileId ?? "local",
    });
  }, [options.annotationFileId, options.enabled, options.online]);

  // Strict Effects 的第二次 setup 必须创建新实例，旧 socket generation 已失效且不可复活。
  useEffect(() => () => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);

  return status;
}
