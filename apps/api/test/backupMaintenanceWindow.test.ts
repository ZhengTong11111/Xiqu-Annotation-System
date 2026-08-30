import assert from "node:assert/strict";
import test from "node:test";
import type { ApiUser } from "../src/domain.js";
import type { MaintenanceCoordinator } from "../src/maintenanceCoordinator.js";
import {
  enterBackupMaintenanceWindow,
  leaveBackupMaintenanceWindow,
} from "../src/backup/backupMaintenanceWindow.js";

const OPERATOR: ApiUser = {
  id: "backup-operator",
  accountName: "backup.operator",
  displayName: "备份操作员",
  roles: ["super_admin"],
};

test("独立备份自行建立维护并在成功后恢复写入", async () => {
  const fake = createMaintenanceFake();
  const window = await enterBackupMaintenanceWindow({
    maintenance: fake.coordinator,
    operator: OPERATOR,
    reason: "独立备份",
    mode: "managed",
  });
  assert.equal(window.ownedByBackup, true);
  assert.deepEqual(fake.transitions.map(({ enabled }) => enabled), [true]);

  await leaveBackupMaintenanceWindow({
    maintenance: fake.coordinator,
    operator: OPERATOR,
    window,
    operationError: undefined,
    keepMaintenanceOnFailure: false,
    failureMessage: "测试恢复失败",
  });
  assert.deepEqual(fake.transitions.map(({ enabled }) => enabled), [true, false]);
});

test("部署备份复用同一操作员窗口且始终交还为启用状态", async () => {
  const fake = createMaintenanceFake({
    enabled: true,
    startedBy: { id: OPERATOR.id },
  });
  const window = await enterBackupMaintenanceWindow({
    maintenance: fake.coordinator,
    operator: OPERATOR,
    reason: "部署备份",
    mode: "require_existing",
  });
  assert.equal(window.ownedByBackup, false);

  await leaveBackupMaintenanceWindow({
    maintenance: fake.coordinator,
    operator: OPERATOR,
    window,
    operationError: new Error("注入备份失败"),
    keepMaintenanceOnFailure: false,
    failureMessage: "测试恢复失败",
  });
  assert.deepEqual(fake.transitions, []);
  assert.equal(fake.status.enabled, true);
});

test("复用模式拒绝缺失窗口或其他操作员建立的窗口", async () => {
  const disabled = createMaintenanceFake();
  await assert.rejects(
    enterBackupMaintenanceWindow({
      maintenance: disabled.coordinator,
      operator: OPERATOR,
      reason: "部署备份",
      mode: "require_existing",
    }),
    /当前未处于维护模式/,
  );

  const foreign = createMaintenanceFake({
    enabled: true,
    startedBy: { id: "another-operator" },
  });
  await assert.rejects(
    enterBackupMaintenanceWindow({
      maintenance: foreign.coordinator,
      operator: OPERATOR,
      reason: "部署备份",
      mode: "require_existing",
    }),
    /不是由当前备份操作员建立/,
  );
});

test("默认模式不静默接管既有窗口，失败保留选项只影响自有窗口", async () => {
  const existing = createMaintenanceFake({
    enabled: true,
    startedBy: { id: OPERATOR.id },
  });
  await assert.rejects(
    enterBackupMaintenanceWindow({
      maintenance: existing.coordinator,
      operator: OPERATOR,
      reason: "独立备份",
      mode: "managed",
    }),
    /显式使用既有维护窗口模式/,
  );

  const managed = createMaintenanceFake();
  const window = await enterBackupMaintenanceWindow({
    maintenance: managed.coordinator,
    operator: OPERATOR,
    reason: "独立备份",
    mode: "managed",
  });
  await leaveBackupMaintenanceWindow({
    maintenance: managed.coordinator,
    operator: OPERATOR,
    window,
    operationError: new Error("注入失败"),
    keepMaintenanceOnFailure: true,
    failureMessage: "测试恢复失败",
  });
  assert.deepEqual(managed.transitions.map(({ enabled }) => enabled), [true]);
  assert.equal(managed.status.enabled, true);
});

function createMaintenanceFake(initial?: {
  enabled: boolean;
  startedBy: { id: string } | null;
}) {
  const status = {
    enabled: initial?.enabled ?? false,
    reason: initial?.enabled ? "既有维护" : null,
    startedAt: initial?.enabled ? new Date().toISOString() : null,
    startedBy: initial?.startedBy
      ? { ...OPERATOR, id: initial.startedBy.id }
      : null,
    updatedAt: new Date().toISOString(),
  };
  const transitions: Array<{ enabled: boolean }> = [];
  const coordinator = {
    getStatus: async () => ({ ...status }),
    setMaintenance: async (_operator: ApiUser, input: { enabled: boolean; reason?: string }) => {
      transitions.push({ enabled: input.enabled });
      status.enabled = input.enabled;
      status.reason = input.enabled ? input.reason ?? null : null;
      status.startedAt = input.enabled ? new Date().toISOString() : null;
      status.startedBy = input.enabled ? OPERATOR : null;
      status.updatedAt = new Date().toISOString();
      return { ...status };
    },
  } as unknown as Pick<MaintenanceCoordinator, "getStatus" | "setMaintenance">;
  return { coordinator, status, transitions };
}
