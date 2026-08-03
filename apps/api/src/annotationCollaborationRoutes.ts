import type { FastifyInstance } from "fastify";
import {
  ANNOTATION_COLLABORATION_HEARTBEAT_MS,
  ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
  ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX,
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  type AnnotationCollaborationServerMessage,
} from "@xiqu/shared";
import { HttpError } from "./errors.js";
import type { PrismaPlatformRepository } from "./repository.js";
import { getCurrentUser } from "./requestAuthentication.js";
import type { AnnotationCollaborationTicketService } from "./annotationCollaborationTicketService.js";
import type { AnnotationCollaborationHub } from "./annotationCollaborationHub.js";

const AUTHENTICATION_CLOSE_CODE = 4401;
const AUTHORIZATION_CLOSE_CODE = 4403;
const PROTOCOL_CLOSE_CODE = 4400;

export function registerAnnotationCollaborationRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  tickets: AnnotationCollaborationTicketService,
  hub: AnnotationCollaborationHub,
) {
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

      // 消费票据期间也先安装全部事件处理器，避免客户端提早关闭时留下订阅或 timer。
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unregister?.();
        unregister = null;
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      socket.on("pong", () => {
        alive = true;
      });
      // R5b1 不接受客户端业务消息；写入必须继续通过已有 HTTP API。
      socket.on("message", () => {
        socket.close(PROTOCOL_CLOSE_CODE, "client_messages_not_supported");
      });

      void tickets.consume(
        getTicketFromSubprotocolHeader(request.headers["sec-websocket-protocol"]),
        request.params.resourceId,
      )
        .then((session) => {
          if (closed || socket.readyState !== socket.OPEN) return;
          sendMessage(socket, {
            version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
            type: "session.ready",
            annotationFileId: session.annotationFileId,
            revision: session.revision,
            operationCursor: session.operationCursor,
            heartbeatIntervalMs: ANNOTATION_COLLABORATION_HEARTBEAT_MS,
          });
          let deliveryQueue = Promise.resolve();
          unregister = hub.subscribe(session.annotationFileId, {
            // 已建立的长连接也必须响应撤权；发送前复核，不能把票据消费时的权限永久缓存。
            send: (message) => {
              // 同一连接串行复核与发送，避免连续保存时较晚 revision 越过较早 revision。
              deliveryQueue = deliveryQueue
                .then(async () => {
                  if (closed) return;
                  await tickets.assertReadable(session.user, session.annotationFileId);
                  sendMessage(socket, message);
                })
                .catch(() => socket.close(AUTHORIZATION_CLOSE_CODE, "permission_revoked"));
            },
            close: (code, reason) => socket.close(code, reason),
          });
          // 原生 ping/pong 只检查连接活性，不混入应用层 revision 协议。
          heartbeat = setInterval(() => {
            if (!alive && !authorizationCheckInFlight) {
              socket.terminate();
              cleanup();
              return;
            }
            if (authorizationCheckInFlight) return;
            authorizationCheckInFlight = true;
            void tickets.assertReadable(session.user, session.annotationFileId)
              .then(() => {
                if (closed || socket.readyState !== socket.OPEN) return;
                alive = false;
                socket.ping();
              })
              .catch(() => socket.close(AUTHORIZATION_CLOSE_CODE, "permission_revoked"))
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
          socket.close(closeCode, closeCode === 1011 ? "session_failed" : "ticket_rejected");
        });
    },
  );
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
