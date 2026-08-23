import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ANNOTATION_COLLABORATION_CLIENT_MESSAGE_MAX_BYTES,
  ANNOTATION_COLLABORATION_HEARTBEAT_MS,
  ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
  ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX,
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  type AnnotationCollaborationServerMessage,
  parseAnnotationCollaborationClientMessage,
} from "@xiqu/shared";
import { HttpError } from "./errors.js";
import type { PrismaPlatformRepository } from "./repository.js";
import { getCurrentUser } from "./requestAuthentication.js";
import type { AnnotationCollaborationTicketService } from "./annotationCollaborationTicketService.js";
import type { AnnotationCollaborationHub } from "./annotationCollaborationHub.js";
import type {
  AnnotationPresenceHandle,
  AnnotationPresenceService,
} from "./annotationPresenceService.js";
import type { AnnotationPresenceCoordinator } from "./annotationPresenceCoordinator.js";
import type { AnnotationPresenceInvalidationPublisher } from "./postgresAnnotationPresenceEventBus.js";
import type { AnnotationRemoteActivityPublisher } from "./postgresAnnotationRemoteActivityEventBus.js";
import { createAnnotationRemoteActivityRateLimiter } from "./annotationRemoteActivityRateLimiter.js";
import type { ApiObservability } from "./observability.js";

const AUTHENTICATION_CLOSE_CODE = 4401;
const AUTHORIZATION_CLOSE_CODE = 4403;
const PROTOCOL_CLOSE_CODE = 4400;
const REMOTE_ACTIVITY_MAX_BUFFERED_BYTES = 512 * 1_024;
type WebSocketRawData = Buffer | ArrayBuffer | Buffer[];

export function registerAnnotationCollaborationRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  tickets: AnnotationCollaborationTicketService,
  hub: AnnotationCollaborationHub,
  presence: AnnotationPresenceService,
  presenceCoordinator: AnnotationPresenceCoordinator,
  presenceEvents: AnnotationPresenceInvalidationPublisher,
  remoteActivityEvents: AnnotationRemoteActivityPublisher,
  observability: ApiObservability,
) {
  const activeFinalizers = new Set<() => Promise<void>>();
  const activeSetups = new Set<Promise<void>>();
  app.post<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/collaboration-ticket",
    async (request) => tickets.issue(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.get<{
    Params: { resourceId: string };
  }>(
    "/api/annotation-files/:resourceId/collaboration",
    { websocket: true },
    (socket, request) => {
      let alive = true;
      let unregister: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      let closed = false;
      let authorizationCheckInFlight = false;
      let presenceHandle: AnnotationPresenceHandle | null = null;
      let finalizePromise: Promise<void> | null = null;
      const activitySessionId = randomUUID();
      const activityRateLimiter = createAnnotationRemoteActivityRateLimiter();
      let sessionIdentity: { annotationFileId: string; userId: string } | null = null;
      let lastClientSequence = 0;
      let hasPublishedActivity = false;
      let sessionReadySent = false;
      const bufferedServerMessages: AnnotationCollaborationServerMessage[] = [];

      // close/error/撤权/app shutdown 共用一个异步 finalize，确保 presence 最多删除和发布一次。
      const finalize = () => {
        if (finalizePromise) return finalizePromise;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unregister?.();
        unregister = null;
        const handle = presenceHandle;
        presenceHandle = null;
        const activityIdentity = sessionIdentity;
        sessionIdentity = null;
        if (activityIdentity && hasPublishedActivity) {
          // clear 使用更高 sequence，并通过 tombstone 阻止跨实例迟到帧重新显示幽灵播放头。
          remoteActivityEvents.publishRemoteActivity({
            annotationFileId: activityIdentity.annotationFileId,
            activitySessionId,
            userId: activityIdentity.userId,
            sequence: lastClientSequence + 1,
            observedAt: new Date().toISOString(),
            activity: null,
          });
          hasPublishedActivity = false;
        }
        finalizePromise = (handle
          ? presence.leave(handle)
              .then((deleted) => {
                if (deleted) presenceEvents.publishPresenceChanged(handle.annotationFileId);
              })
              .catch((error: unknown) => {
                request.log.error(error, "annotation presence leave failed");
              })
          : Promise.resolve())
          .finally(() => activeFinalizers.delete(finalize));
        return finalizePromise;
      };
      const closeAndFinalize = (code: number, reason: string) => {
        socket.close(code, reason);
        // 服务端主动终止不能依赖对端完成 close handshake；已知失效路径立即收回数据库 presence。
        void finalize();
      };
      activeFinalizers.add(finalize);
      socket.on("close", () => void finalize());
      socket.on("error", () => void finalize());
      socket.on("pong", () => {
        alive = true;
      });
      socket.on("message", (rawData: WebSocketRawData, isBinary: boolean) => {
        if (!sessionIdentity || isBinary) {
          observability.recordAnnotationRemoteActivityClientMessage("invalid");
          closeAndFinalize(PROTOCOL_CLOSE_CODE, "invalid_client_message");
          return;
        }
        const byteLength = rawDataByteLength(rawData);
        if (byteLength > ANNOTATION_COLLABORATION_CLIENT_MESSAGE_MAX_BYTES) {
          observability.recordAnnotationRemoteActivityClientMessage("invalid");
          closeAndFinalize(PROTOCOL_CLOSE_CODE, "client_message_too_large");
          return;
        }
        const text = rawDataToText(rawData);
        let decoded: unknown;
        try {
          decoded = JSON.parse(text);
        } catch {
          observability.recordAnnotationRemoteActivityClientMessage("invalid");
          closeAndFinalize(PROTOCOL_CLOSE_CODE, "invalid_client_message");
          return;
        }
        const message = parseAnnotationCollaborationClientMessage(decoded);
        if (!message) {
          observability.recordAnnotationRemoteActivityClientMessage("invalid");
          closeAndFinalize(PROTOCOL_CLOSE_CODE, "invalid_client_message");
          return;
        }
        if (message.sequence <= lastClientSequence) {
          observability.recordAnnotationRemoteActivityClientMessage("duplicate");
          return;
        }
        // 即使该帧随后被限流，也推进已观察 sequence，避免旧帧绕过限流后重新被接受。
        lastClientSequence = message.sequence;
        if (!activityRateLimiter.accept(Date.now())) {
          observability.recordAnnotationRemoteActivityClientMessage("rate_limited");
          return;
        }
        hasPublishedActivity = true;
        observability.recordAnnotationRemoteActivityClientMessage("accepted");
        remoteActivityEvents.publishRemoteActivity({
          annotationFileId: sessionIdentity.annotationFileId,
          activitySessionId,
          userId: sessionIdentity.userId,
          sequence: message.sequence,
          observedAt: new Date().toISOString(),
          activity: message.activity,
        });
      });

      let setupPromise: Promise<void>;
      setupPromise = tickets.consume(
        getTicketFromSubprotocolHeader(request.headers["sec-websocket-protocol"]),
        request.params.resourceId,
      )
        .then(async (session) => {
          if (closed || socket.readyState !== socket.OPEN) return;
          const joinedPresence = await presence.join(session.user, session.annotationFileId);
          if (closed || socket.readyState !== socket.OPEN) {
            // join 等待期间浏览器可能已经关闭；立即删除新行，不等待 TTL 回收。
            if (await presence.leave(joinedPresence)) {
              presenceEvents.publishPresenceChanged(joinedPresence.annotationFileId);
            }
            return;
          }
          presenceHandle = joinedPresence;
          sessionIdentity = {
            annotationFileId: session.annotationFileId,
            userId: session.user.id,
          };
          let deliveryQueue = Promise.resolve();
          unregister = hub.subscribe(session.annotationFileId, {
            activitySessionId,
            // 已建立的长连接也必须响应撤权；发送前复核，不能把票据消费时的权限永久缓存。
            send: (message) => {
              // subscriber 必须先于第二次同步头读取注册。ready 发出前到达的 revision 先缓冲，
              // 避免“票据读取旧 revision -> 别人保存 -> 本连接才订阅”的永久漏通知窗口。
              if (!sessionReadySent) {
                bufferedServerMessages.push(message);
                return;
              }
              // 活动帧是有 TTL 的只读提示，沿用会话心跳授权；避免拖动时每帧查询数据库。
              if (message.type === "presence.timeline_activity.changed") {
                if (socket.bufferedAmount > REMOTE_ACTIVITY_MAX_BUFFERED_BYTES) return;
                sendMessage(socket, message);
                return;
              }
              // 同一连接串行复核与发送，避免连续保存时较晚 revision 越过较早 revision。
              deliveryQueue = deliveryQueue
                .then(async () => {
                  if (closed) return;
                  await tickets.assertReadable(session.user, session.annotationFileId);
                  sendMessage(socket, message);
                })
                .catch(() => closeAndFinalize(AUTHORIZATION_CLOSE_CODE, "permission_revoked"));
            },
            close: closeAndFinalize,
          });
          const currentHead = await tickets.readCurrentHead(
            session.user,
            session.annotationFileId,
          );
          if (closed || socket.readyState !== socket.OPEN) return;
          sendMessage(socket, {
            version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
            type: "session.ready",
            annotationFileId: session.annotationFileId,
            revision: currentHead.revision,
            operationCursor: currentHead.operationCursor,
            heartbeatIntervalMs: ANNOTATION_COLLABORATION_HEARTBEAT_MS,
          });
          sessionReadySent = true;
          // ready 已包含读取时刻之前的 revision。只补发更晚 revision；presence/activity
          // 使用随后发布的完整快照，避免把建连期间的过期瞬时状态重复送给客户端。
          for (const message of bufferedServerMessages.splice(0)) {
            if (
              message.type === "annotation.revision.advanced" &&
              message.revision > currentHead.revision
            ) {
              sendMessage(socket, message);
            } else if (message.type === "annotation.review.changed") {
              // 审核事实不推进 revision；建连期间的失效提示必须独立补发。
              sendMessage(socket, message);
            }
          }
          // 先注册 subscriber 再发布，当前连接和其他实例都会从数据库读取同一成员快照。
          presenceEvents.publishPresenceChanged(session.annotationFileId);
          // 原生 ping/pong 只检查连接活性，不混入应用层 revision 协议。
          heartbeat = setInterval(() => {
            if (!alive && !authorizationCheckInFlight) {
              socket.terminate();
              void finalize();
              return;
            }
            if (authorizationCheckInFlight) return;
            authorizationCheckInFlight = true;
            void tickets.assertReadable(session.user, session.annotationFileId)
              .then(async () => {
                if (closed || socket.readyState !== socket.OPEN) return;
                const handle = presenceHandle;
                if (!handle || !await presence.renew(handle)) {
                  closeAndFinalize(AUTHENTICATION_CLOSE_CODE, "presence_expired");
                  return;
                }
                // 每文件每 20 秒最多广播一次，用数据库重读清掉异常退出后已过期的其他 session。
                if (presenceCoordinator.claimPeriodicInvalidation(session.annotationFileId)) {
                  presenceEvents.publishPresenceChanged(session.annotationFileId);
                }
                alive = false;
                socket.ping();
              })
              .catch(() => closeAndFinalize(AUTHORIZATION_CLOSE_CODE, "permission_revoked"))
              .finally(() => {
                authorizationCheckInFlight = false;
              });
          }, ANNOTATION_COLLABORATION_HEARTBEAT_MS);
          heartbeat.unref();
        })
        .catch((error: unknown) => {
          if (closed || socket.readyState !== socket.OPEN) return;
          const closeCode = error instanceof HttpError && error.statusCode === 403
            ? AUTHORIZATION_CLOSE_CODE
            : error instanceof HttpError && error.statusCode === 401
              ? AUTHENTICATION_CLOSE_CODE
              : 1011;
          if (closeCode === 1011) request.log.error(error);
          closeAndFinalize(closeCode, closeCode === 1011 ? "session_failed" : "ticket_rejected");
        })
        .finally(() => activeSetups.delete(setupPromise));
      // app shutdown 还要等待票据消费/join 的迟到结果完成补偿，不能先断开 Prisma。
      activeSetups.add(setupPromise);
    },
  );

  return {
    async close() {
      // Hub 会先请求 socket close；这里直接调用所有 finalizer，保证 Fastify 关闭前尽量删除在线行。
      await Promise.allSettled([...activeFinalizers].map((finalize) => finalize()));
      await Promise.allSettled([...activeSetups]);
      activeFinalizers.clear();
      activeSetups.clear();
    },
  };
}

function rawDataToText(rawData: WebSocketRawData) {
  if (Array.isArray(rawData)) return Buffer.concat(rawData).toString("utf8");
  if (rawData instanceof ArrayBuffer) return Buffer.from(rawData).toString("utf8");
  return rawData.toString("utf8");
}

function rawDataByteLength(rawData: WebSocketRawData) {
  if (Array.isArray(rawData)) {
    return rawData.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return rawData.byteLength;
}

// 子协议头不会进入默认 URL 访问日志；稳定协议名与唯一票据项都必须存在。
function getTicketFromSubprotocolHeader(header: string | string[] | undefined) {
  const values = (Array.isArray(header) ? header : [header ?? ""])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL)) return "";
  const ticketValues = values.filter((value) =>
    value.startsWith(ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX)
  );
  if (ticketValues.length !== 1) return "";
  return ticketValues[0].slice(ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX.length);
}

function sendMessage(
  socket: { send: (data: string) => void; readyState: number; OPEN: number },
  message: AnnotationCollaborationServerMessage,
) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}
