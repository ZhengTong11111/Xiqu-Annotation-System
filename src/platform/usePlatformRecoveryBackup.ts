import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectData } from "../types";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import { createRuntimeUuid } from "../utils/runtimeUuid";
import type { PlatformEditorSession } from "./PlatformWorkspace";
import { isPlatformMaintenanceError } from "./platformMaintenanceSaveWarning";
import {
  createPlatformRecoveryBackupRuntime,
  DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES,
  PLATFORM_RECOVERY_BACKUP_THRESHOLDS,
  type PlatformRecoveryBackupPreferences,
  type PlatformRecoveryBackupRuntime,
  type PlatformRecoveryBackupState,
} from "./platformRecoveryBackupRuntime";

const PREFERENCE_KEY_PREFIX = "xiqu-platform-recovery-backup:";

export function usePlatformRecoveryBackup(input: {
  session: PlatformEditorSession | null;
  online: boolean;
  buildPayload: () => { sourceRevision: number; payload: ProjectData };
}) {
  const preferenceKey = input.session
    ? `${PREFERENCE_KEY_PREFIX}${input.session.currentUserId}`
    : null;
  const [preferences, setPreferencesState] = useState<PlatformRecoveryBackupPreferences>(() =>
    loadPreferences(preferenceKey));
  const [state, setState] = useState<PlatformRecoveryBackupState>({
    status: "idle",
    failureCount: 0,
  });
  const runtimeRef = useRef<PlatformRecoveryBackupRuntime<ProjectData> | null>(null);
  const buildPayloadRef = useRef(input.buildPayload);
  buildPayloadRef.current = input.buildPayload;

  // 账号或文件切换会结束旧失败周期；晚到的服务器响应不能改变新编辑会话的提示。
  useEffect(() => {
    setPreferencesState(loadPreferences(preferenceKey));
    setState({ status: "idle", failureCount: 0 });
    runtimeRef.current?.dispose();
    if (!input.session) {
      runtimeRef.current = null;
      return;
    }
    const session = input.session;
    const runtime = createPlatformRecoveryBackupRuntime<ProjectData>({
      createId: createRuntimeUuid,
      createBackup: async (request) => {
        const result = await session.client.createAnnotationRecoveryBackup(
          session.annotationFileId,
          request,
        );
        return { fileName: result.file.resource.name };
      },
      // 维护门禁与离线相同：本地草稿继续保留，等待后续在线保存动作再补建，不向用户谎报永久失败。
      shouldDeferError: isPlatformMaintenanceError,
      onStateChange: setState,
    });
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [input.session?.annotationFileId, input.session?.currentUserId, preferenceKey]);

  useEffect(() => {
    runtimeRef.current?.update({ ...preferences, online: input.online });
  }, [input.online, preferences]);

  const setPreferences = useCallback((next: PlatformRecoveryBackupPreferences) => {
    setPreferencesState(next);
    if (preferenceKey) {
      window.localStorage.setItem(preferenceKey, JSON.stringify(next));
    }
  }, [preferenceKey]);

  const recordSaveOutcome = useCallback(async (outcome: PlatformSaveOutcome) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.recordSaveOutcome(outcome, (clientBackupId, failureCount) => {
      const current = buildPayloadRef.current();
      return {
        clientBackupId,
        sourceRevision: current.sourceRevision,
        failureCount,
        payload: current.payload,
      };
    });
  }, []);

  return { preferences, setPreferences, state, recordSaveOutcome };
}

function loadPreferences(key: string | null): PlatformRecoveryBackupPreferences {
  if (!key || typeof window === "undefined") {
    return DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<PlatformRecoveryBackupPreferences> | null;
    const failureThreshold = PLATFORM_RECOVERY_BACKUP_THRESHOLDS.find(
      (value) => value === parsed?.failureThreshold,
    );
    return {
      enabled: typeof parsed?.enabled === "boolean"
        ? parsed.enabled
        : DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES.enabled,
      failureThreshold: failureThreshold
        ?? DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES.failureThreshold,
    };
  } catch {
    return DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES;
  }
}
