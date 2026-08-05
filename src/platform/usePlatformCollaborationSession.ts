import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX,
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  type AnnotationCollaborationServerMessage,
  type AnnotationPresenceMember,
} from "@xiqu/shared";
import { PlatformApiError, type PlatformClient } from "../api/platformClient";
import {
  createPlatformCollaborationRuntime,
  type PlatformCollaborationRuntime,
  type PlatformCollaborationStatus,
} from "./platformCollaborationRuntime";
import {
  applyRemoteTimelineActivityMessage,
  buildRemoteTimelineActivityView,
  pruneRemoteTimelineActivityRegistry,
  type RemoteTimelineActivityRegistry,
  type RemoteTimelineActivityView,
} from "./remoteTimelineActivityRegistry";
import type { AnnotationTimelineActivity } from "@xiqu/shared";

type UsePlatformCollaborationSessionOptions = {
  client: PlatformClient | null;
  annotationFileId: string | null;
  enabled: boolean;
  online: boolean;
  currentUserId: string | null;
  onMessage: (message: AnnotationCollaborationServerMessage) => void;
  onError: (error: unknown) => void;
};

// React hook 只适配平台客户端与浏览器 WebSocket；重连、超时和迟到回调由纯运行时统一管理。
export function usePlatformCollaborationSession(
  options: UsePlatformCollaborationSessionOptions,
): {
  status: PlatformCollaborationStatus;
  members: AnnotationPresenceMember[];
  remoteActivities: RemoteTimelineActivityView[];
  updatePlayhead: (playhead: { time: number; playing: boolean }) => void;
  updatePointer: (pointer: { time: number } | null) => void;
  updateSelection: (selection: AnnotationTimelineActivity["selection"]) => void;
} {
  const [status, setStatus] = useState<PlatformCollaborationStatus>("disabled");
  const [members, setMembers] = useState<AnnotationPresenceMember[]>([]);
  const [remoteRegistry, setRemoteRegistry] = useState<RemoteTimelineActivityRegistry>(new Map());
  const [viewClockMs, setViewClockMs] = useState(() => Date.now());
  const clientRef = useRef(options.client);
  const messageRef = useRef(options.onMessage);
  const errorRef = useRef(options.onError);
  const runtimeRef = useRef<PlatformCollaborationRuntime | null>(null);
  clientRef.current = options.client;
  messageRef.current = options.onMessage;
  errorRef.current = options.onError;

  // 每个 React 会话只创建一个纯运行时，依赖通过 ref 获取最新平台客户端和回调。
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
      onStatusChange: (nextStatus) => {
        setStatus(nextStatus);
        // 断线、换文件或重连时旧快照不再可信，宁可暂时显示空列表也不能保留幽灵在线成员。
        if (nextStatus !== "connected") setMembers([]);
        if (nextStatus !== "connected") setRemoteRegistry(new Map());
      },
      onMessage: (message) => {
        if (message.type === "presence.snapshot") setMembers(message.members);
        if (message.type === "presence.timeline_activity.changed") {
          setRemoteRegistry((current) => applyRemoteTimelineActivityMessage(current, message, Date.now()));
          setViewClockMs(Date.now());
        }
        messageRef.current(message);
      },
      onError: (error) => errorRef.current(error),
    });
    return runtimeRef.current;
  }

  // 平台文件、联网或启用事实变化时更新同一运行时；文件切换由 generation 隔离迟到消息。
  useEffect(() => {
    ensureRuntime().update({
      enabled: options.enabled,
      online: options.online,
      sessionKey: options.annotationFileId ?? "local",
    });
  }, [options.annotationFileId, options.enabled, options.online]);

  // 单个全局清理时钟回收异常断线留下的活动帧，不为每条远端线创建 timer。
  useEffect(() => {
    if (status !== "connected" || remoteRegistry.size === 0) return;
    const timerId = window.setInterval(() => {
      const nextNow = Date.now();
      setViewClockMs(nextNow);
      setRemoteRegistry((current) => pruneRemoteTimelineActivityRegistry(current, nextNow));
    }, 1_000);
    return () => window.clearInterval(timerId);
  }, [remoteRegistry.size, status]);

  // Strict Effects 的第二次 setup 必须创建新实例，旧 socket generation 已失效且不可复活。
  useEffect(() => () => {
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
  }, []);

  const remoteActivities = useMemo(
    () => buildRemoteTimelineActivityView(remoteRegistry, members, options.currentUserId, viewClockMs),
    [members, options.currentUserId, remoteRegistry, viewClockMs],
  );
  const updatePlayhead = useCallback((playhead: { time: number; playing: boolean }) => {
    runtimeRef.current?.updatePlayhead(playhead);
  }, []);
  const updatePointer = useCallback((pointer: { time: number } | null) => {
    runtimeRef.current?.updatePointer(pointer);
  }, []);
  const updateSelection = useCallback((selection: AnnotationTimelineActivity["selection"]) => {
    runtimeRef.current?.updateSelection(selection);
  }, []);

  return { status, members, remoteActivities, updatePlayhead, updatePointer, updateSelection };
}
