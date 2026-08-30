import type { ApiUser } from "../domain.js";
import type { MaintenanceCoordinator } from "../maintenanceCoordinator.js";

export type BackupMaintenanceMode = "managed" | "require_existing";

export type BackupMaintenanceWindow = {
  ownedByBackup: boolean;
};

type BackupMaintenanceCoordinator = Pick<
  MaintenanceCoordinator,
  "getStatus" | "setMaintenance"
>;

/**
 * 备份可独立接管维护，也可复用部署流程已经排空的维护窗口。
 * 复用必须由同一操作员建立，避免一个命令借用他人的维护事实后读取不一致数据。
 */
export async function enterBackupMaintenanceWindow(options: {
  maintenance: BackupMaintenanceCoordinator;
  operator: ApiUser;
  reason: string;
  mode: BackupMaintenanceMode;
}): Promise<BackupMaintenanceWindow> {
  const existingStatus = await options.maintenance.getStatus(options.operator);
  if (options.mode === "require_existing") {
    if (!existingStatus.enabled) {
      throw new Error("备份要求复用既有维护窗口，但平台当前未处于维护模式。 ");
    }
    if (existingStatus.startedBy?.id !== options.operator.id) {
      throw new Error("既有维护窗口不是由当前备份操作员建立，拒绝复用。 ");
    }
    return { ownedByBackup: false };
  }
  if (existingStatus.enabled) {
    throw new Error("平台已处于维护模式；请显式使用既有维护窗口模式。 ");
  }
  await options.maintenance.setMaintenance(options.operator, {
    enabled: true,
    reason: options.reason,
  });
  return { ownedByBackup: true };
}

/**
 * 只有备份自己建立的窗口才由备份恢复写入；外部部署窗口始终交还给部署流程继续持有。
 */
export async function leaveBackupMaintenanceWindow(options: {
  maintenance: BackupMaintenanceCoordinator;
  operator: ApiUser;
  window: BackupMaintenanceWindow;
  operationError: unknown;
  keepMaintenanceOnFailure: boolean;
  failureMessage: string;
}) {
  if (!options.window.ownedByBackup) return;
  if (options.operationError && options.keepMaintenanceOnFailure) return;
  try {
    await options.maintenance.setMaintenance(options.operator, { enabled: false });
  } catch (maintenanceError) {
    if (options.operationError) {
      throw new AggregateError(
        [options.operationError, maintenanceError],
        options.failureMessage,
      );
    }
    throw maintenanceError;
  }
}
