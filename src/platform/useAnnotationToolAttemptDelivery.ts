import { useCallback, useEffect, useMemo } from "react";
import type { AnnotationToolAttemptState } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { createAnnotationToolAttemptDeliveryCoordinator } from "./annotationToolAttemptDelivery";

/** Workspace 级 hook 以账号为生命周期边界；文件切换不会暂停该账号其他文件的离线续传。 */
export function useAnnotationToolAttemptDelivery(input: {
  client: PlatformClient;
  userId: string | null;
}) {
  const coordinator = useMemo(() => input.userId
    ? createAnnotationToolAttemptDeliveryCoordinator({
        client: input.client,
        userId: input.userId,
      })
    : null, [input.client, input.userId]);

  useEffect(() => {
    coordinator?.start();
    return () => coordinator?.dispose();
  }, [coordinator]);

  const record = useCallback((attempt: AnnotationToolAttemptState) => {
    coordinator?.enqueue(attempt);
  }, [coordinator]);
  const ensureDelivered = useCallback((attemptIds: readonly string[]) =>
    coordinator
      ? coordinator.ensureDelivered(attemptIds)
      : Promise.resolve({ unavailableAttemptIds: [...attemptIds] }), [coordinator]);
  return useMemo(() => ({ record, ensureDelivered }), [ensureDelivered, record]);
}
