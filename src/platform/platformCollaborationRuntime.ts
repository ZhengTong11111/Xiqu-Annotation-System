import {
  parseAnnotationCollaborationServerMessage,
  type AnnotationCollaborationServerMessage,
  type AnnotationCollaborationTicket,
  type AnnotationPlayheadUpdateMessage,
} from "@xiqu/shared";

export type PlatformCollaborationStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export type PlatformCollaborationFacts = {
  enabled: boolean;
  online: boolean;
  sessionKey: string;
};

type SocketEventMap = {
  open: Event;
  message: { data: unknown };
  close: { code: number };
  error: Event;
};

export type PlatformCollaborationSocket = {
  addEventListener: <TType extends keyof SocketEventMap>(
    type: TType,
    listener: (event: SocketEventMap[TType]) => void,
  ) => void;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
};

type RuntimeDependencies = {
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  random: () => number;
  now?: () => number;
  requestTicket: (facts: PlatformCollaborationFacts) => Promise<AnnotationCollaborationTicket>;
  createSocket: (
    ticket: AnnotationCollaborationTicket,
    facts: PlatformCollaborationFacts,
  ) => PlatformCollaborationSocket;
  isPermanentTicketError: (error: unknown) => boolean;
  onStatusChange: (status: PlatformCollaborationStatus) => void;
  onMessage: (message: AnnotationCollaborationServerMessage) => void;
  onError: (error: unknown) => void;
};

export type PlatformCollaborationRuntime = {
  update: (facts: PlatformCollaborationFacts) => void;
  updatePlayhead: (playhead: { time: number; playing: boolean }) => void;
  dispose: () => void;
};

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PERMANENT_CLOSE_CODES = new Set([4400, 4403]);
const PLAYHEAD_SEND_INTERVAL_MS = 125;
const PLAYHEAD_KEEPALIVE_MS = 2_000;
const PLAYHEAD_MAX_BUFFERED_BYTES = 256 * 1_024;

// 运行时独占 ticket、socket、重连 timer 与 generation；React 只更新事实，不直接操纵连接。
export function createPlatformCollaborationRuntime(
  dependencies: RuntimeDependencies,
): PlatformCollaborationRuntime {
  let facts: PlatformCollaborationFacts | null = null;
  let socket: PlatformCollaborationSocket | null = null;
  let timerId: number | null = null;
  let generation = 0;
  let reconnectAttempt = 0;
  let disposed = false;
  let halted = false;
  let status: PlatformCollaborationStatus = "disabled";
  let sessionReady = false;
  let playheadTimerId: number | null = null;
  let playheadKeepaliveTimerId: number | null = null;
  let latestPlayhead: { time: number; playing: boolean } | null = null;
  let lastPlayheadSentAt = Number.NEGATIVE_INFINITY;
  let playheadSequence = 0;
  const now = dependencies.now ?? Date.now;

  function setStatus(nextStatus: PlatformCollaborationStatus) {
    if (status === nextStatus) return;
    status = nextStatus;
    dependencies.onStatusChange(nextStatus);
  }

  function clearTimer() {
    if (timerId === null) return;
    dependencies.clearTimer(timerId);
    timerId = null;
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    clearPlayheadTimers();
    sessionReady = false;
    playheadSequence = 0;
    lastPlayheadSentAt = Number.NEGATIVE_INFINITY;
    current?.close(1000, "session_replaced");
  }

  function clearPlayheadTimers() {
    if (playheadTimerId !== null) dependencies.clearTimer(playheadTimerId);
    if (playheadKeepaliveTimerId !== null) dependencies.clearTimer(playheadKeepaliveTimerId);
    playheadTimerId = null;
    playheadKeepaliveTimerId = null;
  }

  function sendLatestPlayhead() {
    const currentSocket = socket;
    if (
      !sessionReady || !latestPlayhead || !currentSocket ||
      currentSocket.readyState !== currentSocket.OPEN
    ) return false;
    // transient 帧允许丢弃；浏览器发送缓冲过高时保留最新候选，避免积压过期播放位置。
    if (currentSocket.bufferedAmount > PLAYHEAD_MAX_BUFFERED_BYTES) return false;
    playheadSequence += 1;
    const message: AnnotationPlayheadUpdateMessage = {
      version: 1,
      type: "presence.playhead.update",
      sequence: playheadSequence,
      time: latestPlayhead.time,
      playing: latestPlayhead.playing,
    };
    try {
      currentSocket.send(JSON.stringify(message));
      lastPlayheadSentAt = now();
      return true;
    } catch (error) {
      dependencies.onError(error);
      return false;
    }
  }

  function schedulePlayheadSend() {
    if (!sessionReady || playheadTimerId !== null) return;
    const delay = Math.max(0, PLAYHEAD_SEND_INTERVAL_MS - (now() - lastPlayheadSentAt));
    playheadTimerId = dependencies.setTimer(() => {
      playheadTimerId = null;
      sendLatestPlayhead();
    }, delay);
  }

  function schedulePlayheadKeepalive() {
    if (!sessionReady || playheadKeepaliveTimerId !== null) return;
    playheadKeepaliveTimerId = dependencies.setTimer(() => {
      playheadKeepaliveTimerId = null;
      if (!sessionReady) return;
      sendLatestPlayhead();
      schedulePlayheadKeepalive();
    }, PLAYHEAD_KEEPALIVE_MS);
  }

  function isEligible(value: PlatformCollaborationFacts | null) {
    return Boolean(value?.enabled && value.online);
  }

  function scheduleReconnect(requestGeneration: number) {
    if (disposed || generation !== requestGeneration || !isEligible(facts)) return;
    clearTimer();
    reconnectAttempt += 1;
    setStatus("reconnecting");
    const base = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt - 1, 5),
    );
    const delay = Math.round(base * (0.8 + dependencies.random() * 0.4));
    timerId = dependencies.setTimer(() => {
      timerId = null;
      connect();
    }, delay);
  }

  function connect() {
    if (disposed || halted || !facts || !isEligible(facts) || socket) return;
    clearTimer();
    const requestFacts = facts;
    const requestGeneration = generation;
    setStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

    // 票据请求本身可能挂起；超时废弃该 generation，迟到明文票据不得再创建旧文件 socket。
    timerId = dependencies.setTimer(() => {
      timerId = null;
      if (disposed || generation !== requestGeneration || socket) return;
      generation += 1;
      scheduleReconnect(generation);
    }, CONNECT_TIMEOUT_MS);

    void dependencies.requestTicket(requestFacts)
      .then((ticket) => {
        if (
          disposed ||
          generation !== requestGeneration ||
          !factsMatch(facts, requestFacts) ||
          !isEligible(facts)
        ) return;
        clearTimer();
        const nextSocket = dependencies.createSocket(ticket, requestFacts);
        socket = nextSocket;
        let ready = false;
        let connectionClosed = false;

        const failProtocol = (message: string) => {
          halted = true;
          dependencies.onError(new Error(message));
          nextSocket.close(4400, "invalid_server_protocol");
          setStatus("error");
        };

        nextSocket.addEventListener("open", () => {
          if (generation !== requestGeneration || disposed) {
            nextSocket.close(1000, "stale_session");
            return;
          }
          // connected 必须等待严格的 session.ready，TCP open 本身不证明服务端已消费票据。
          clearTimer();
          timerId = dependencies.setTimer(() => {
            timerId = null;
            if (!ready && socket === nextSocket) {
              dependencies.onError(new Error("协作服务未在时限内确认会话。"));
              nextSocket.close(1013, "session_ready_timeout");
            }
          }, CONNECT_TIMEOUT_MS);
        });
        nextSocket.addEventListener("message", (event) => {
          if (disposed || generation !== requestGeneration || socket !== nextSocket) return;
          if (typeof event.data !== "string") {
            failProtocol("协作服务返回了非文本消息。");
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(event.data);
          } catch {
            failProtocol("协作服务返回了无效 JSON。");
            return;
          }
          const message = parseAnnotationCollaborationServerMessage(decoded);
          if (!message || message.annotationFileId !== requestFacts.sessionKey) {
            failProtocol("协作服务消息不符合当前文件协议。");
            return;
          }
          if (message.type === "session.ready") {
            if (ready) {
              failProtocol("协作服务重复发送会话就绪消息。");
              return;
            }
            ready = true;
            sessionReady = true;
            clearTimer();
            reconnectAttempt = 0;
            setStatus("connected");
            sendLatestPlayhead();
            schedulePlayheadKeepalive();
          } else if (!ready) {
            failProtocol("协作服务在会话就绪前发送了业务通知。");
            return;
          }
          dependencies.onMessage(message);
        });
        nextSocket.addEventListener("error", (event) => {
          if (!connectionClosed && generation === requestGeneration) dependencies.onError(event);
        });
        nextSocket.addEventListener("close", (event) => {
          if (connectionClosed) return;
          connectionClosed = true;
          clearTimer();
          clearPlayheadTimers();
          sessionReady = false;
          if (socket === nextSocket) socket = null;
          if (disposed || generation !== requestGeneration || !isEligible(facts)) return;
          if (PERMANENT_CLOSE_CODES.has(event.code)) {
            halted = true;
            setStatus("error");
            return;
          }
          scheduleReconnect(requestGeneration);
        });
        // WebSocket 握手本身也必须有时限；否则浏览器可能永久停留在 connecting 且无法取得新票据。
        timerId = dependencies.setTimer(() => {
          timerId = null;
          if (socket !== nextSocket || ready) return;
          dependencies.onError(new Error("协作 WebSocket 握手超时。"));
          nextSocket.close(1013, "websocket_open_timeout");
        }, CONNECT_TIMEOUT_MS);
      })
      .catch((error: unknown) => {
        clearTimer();
        if (disposed || generation !== requestGeneration || !factsMatch(facts, requestFacts)) return;
        dependencies.onError(error);
        if (dependencies.isPermanentTicketError(error)) {
          halted = true;
          setStatus("error");
          return;
        }
        scheduleReconnect(requestGeneration);
      });
  }

  return {
    update(nextFacts) {
      if (disposed) return;
      const sessionChanged = !facts || facts.sessionKey !== nextFacts.sessionKey;
      const becameOffline = Boolean(facts?.online && !nextFacts.online);
      const becameEligible = !isEligible(facts) && isEligible(nextFacts);
      facts = nextFacts;
      if (sessionChanged || becameOffline || !nextFacts.enabled) {
        generation += 1;
        reconnectAttempt = 0;
        halted = false;
        clearTimer();
        closeSocket();
      }
      if (!nextFacts.enabled) {
        setStatus("disabled");
        return;
      }
      if (!nextFacts.online) {
        setStatus("offline");
        return;
      }
      if (!halted && (sessionChanged || becameEligible || (!socket && timerId === null))) connect();
    },

    updatePlayhead(playhead) {
      if (disposed || !Number.isFinite(playhead.time) || playhead.time < 0) return;
      latestPlayhead = { time: playhead.time, playing: playhead.playing };
      schedulePlayheadSend();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearTimer();
      closeSocket();
      setStatus("disabled");
    },
  };
}

function factsMatch(
  current: PlatformCollaborationFacts | null,
  request: PlatformCollaborationFacts,
) {
  return Boolean(current && current.sessionKey === request.sessionKey);
}
