type EventTargetPort = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

type VisibilityDocumentPort = EventTargetPort & {
  visibilityState: string;
};

type SubscribeMediaPlaybackRecoveryInput = {
  windowTarget: EventTargetPort;
  documentTarget: VisibilityDocumentPort;
  onRecover: () => void;
};

/**
 * 当前 HTTP IP 与未来 HTTPS 域名都支持这些普通生命周期事件。
 * helper 只负责把事件合并成恢复提示，凭据、播放意图和 single-flight 仍由 backend/runtime 所有。
 */
export function subscribeToMediaPlaybackRecovery(
  input: SubscribeMediaPlaybackRecoveryInput,
) {
  const handleOnline: EventListener = () => input.onRecover();
  const handlePageShow: EventListener = () => input.onRecover();
  const handleVisibilityChange: EventListener = () => {
    if (input.documentTarget.visibilityState === "visible") input.onRecover();
  };
  input.windowTarget.addEventListener("online", handleOnline);
  input.windowTarget.addEventListener("pageshow", handlePageShow);
  input.documentTarget.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    input.windowTarget.removeEventListener("online", handleOnline);
    input.windowTarget.removeEventListener("pageshow", handlePageShow);
    input.documentTarget.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
