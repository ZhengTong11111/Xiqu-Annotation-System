import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SystemDiagnostics } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type SystemDiagnosticsDialogProps = {
  client: PlatformClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 管理员诊断面板集中呈现服务端运行结论，不在浏览器复制配额、孤儿或健康判断规则。
export function SystemDiagnosticsDialog(
  props: SystemDiagnosticsDialogProps,
) {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [switchingMaintenance, setSwitchingMaintenance] = useState(false);
  const [maintenanceDraft, setMaintenanceDraft] = useState<"enable" | "disable" | null>(null);
  const [maintenanceReason, setMaintenanceReason] = useState("");

  // 刷新使用一次原子状态切换，旧诊断保留到新响应到达，避免面板闪空。
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDiagnostics(await props.client.getSystemDiagnostics());
    } catch (nextError) {
      setError(describeDiagnosticsError(nextError));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    // Dialog 关闭时不轮询；每次重新打开读取当前容量和对象状态。
    if (!props.open) return;
    setNotice(null);
    setMaintenanceDraft(null);
    setMaintenanceReason("");
    void load();
  }, [load, props.open]);

  // 清理命令需要用户二次确认，成功后立即重扫，避免继续展示过期计数。
  async function cleanupEligibleObjects() {
    if (!diagnostics?.storage.cleanupEligibleCount || cleaning) return;
    const confirmed = window.confirm(
      `确认清理 ${diagnostics.storage.cleanupEligibleCount} 个超过宽限期的确定孤儿？缺失二进制不会被删除。`,
    );
    if (!confirmed) return;
    setCleaning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await props.client.cleanupStorageOrphans();
      setNotice(
        `已删除 ${result.deletedBinaryCount} 个二进制对象和 ${result.deletedFileObjectCount} 条无引用文件记录。`,
      );
      await load();
    } catch (nextError) {
      setError(describeDiagnosticsError(nextError));
    } finally {
      setCleaning(false);
    }
  }

  // 先展开面板内确认区，不依赖浏览器原生 prompt/confirm，便于管理员核对原因和风险。
  function beginMaintenanceChange() {
    if (!diagnostics || switchingMaintenance) return;
    setMaintenanceDraft(diagnostics.maintenance.enabled ? "disable" : "enable");
    setMaintenanceReason("");
    setError(null);
    setNotice(null);
  }

  // 确认命令只使用受控输入；服务端仍会再次校验管理员身份和原因长度。
  async function submitMaintenanceChange() {
    if (!diagnostics || !maintenanceDraft || switchingMaintenance) return;
    const enabling = maintenanceDraft === "enable";
    const reason = maintenanceReason.trim();
    if (enabling && !reason) {
      setError("进入维护模式前必须填写维护原因。");
      return;
    }
    setSwitchingMaintenance(true);
    setError(null);
    setNotice(null);
    try {
      const status = await props.client.setPlatformMaintenance({
        enabled: enabling,
        reason: enabling ? reason : null,
      });
      setNotice(status.enabled ? "平台已进入维护模式。" : "平台已恢复写入。");
      setMaintenanceDraft(null);
      setMaintenanceReason("");
      await load();
    } catch (nextError) {
      setError(describeDiagnosticsError(nextError));
    } finally {
      setSwitchingMaintenance(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop" />
        <Dialog.Content className="system-diagnostics-dialog">
          <header className="system-diagnostics-header">
            <div>
              <ServerCog size={20} />
              <div>
                <Dialog.Title>系统诊断</Dialog.Title>
                <Dialog.Description>
                  数据库、对象存储、容量与后台任务
                </Dialog.Description>
              </div>
            </div>
            <div className="system-diagnostics-header-actions">
              <button
                type="button"
                title="刷新诊断"
                disabled={loading || cleaning}
                onClick={() => void load()}
              >
                <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
              </button>
              <Dialog.Close asChild>
                <button type="button" title="关闭诊断"><X size={17} /></button>
              </Dialog.Close>
            </div>
          </header>

          <div className="system-diagnostics-content">
            {error ? <div className="resource-error-banner">{error}</div> : null}
            {notice ? <div className="system-diagnostics-notice">{notice}</div> : null}
            {!diagnostics && loading ? (
              <div className="system-diagnostics-loading">正在读取系统状态…</div>
            ) : null}
            {diagnostics ? (
              <>
                {/* 维护状态置于首位，管理员进入诊断后能立即判断平台是否允许写入。 */}
                <DiagnosticSection icon={<ShieldAlert size={17} />} title="维护状态">
                  <div
                    className="system-maintenance-status"
                    data-active={diagnostics.maintenance.enabled}
                  >
                    <div>
                      <strong>
                        {diagnostics.maintenance.enabled ? "维护中" : "正常写入"}
                      </strong>
                      <span>
                        {diagnostics.maintenance.enabled
                          ? diagnostics.maintenance.reason ?? "未记录原因"
                          : "新的编辑、上传和资源操作可正常提交"}
                      </span>
                      {diagnostics.maintenance.startedAt ? (
                        <small>
                          {formatDiagnosticTime(diagnostics.maintenance.startedAt)}
                          {diagnostics.maintenance.startedBy
                            ? ` · ${diagnostics.maintenance.startedBy.displayName}`
                            : ""}
                        </small>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={switchingMaintenance || loading}
                      onClick={beginMaintenanceChange}
                    >
                      {switchingMaintenance
                        ? "正在切换"
                        : diagnostics.maintenance.enabled
                          ? "恢复写入"
                          : "进入维护"}
                    </button>
                  </div>
                  {maintenanceDraft ? (
                    /* 维护确认区保留在状态卡下方，避免原生弹窗脱离诊断上下文。 */
                    <div className="system-maintenance-confirmation">
                      <strong>
                        {maintenanceDraft === "enable" ? "确认进入维护" : "确认恢复写入"}
                      </strong>
                      <p>
                        {maintenanceDraft === "enable"
                          ? "平台会先等待在途写入完成，随后拒绝新的编辑、上传和资源变更；读取仍然可用。"
                          : "请确认备份或维护操作已经结束，恢复后新的写入会立即放行。"}
                      </p>
                      {maintenanceDraft === "enable" ? (
                        <label>
                          <span>维护原因</span>
                          <textarea
                            autoFocus
                            maxLength={240}
                            placeholder="例如：执行数据库与对象存储一致性备份"
                            value={maintenanceReason}
                            onChange={(event) => setMaintenanceReason(event.target.value)}
                          />
                          <small>{maintenanceReason.length} / 240</small>
                        </label>
                      ) : null}
                      <div className="system-maintenance-confirmation-actions">
                        <button
                          type="button"
                          disabled={switchingMaintenance}
                          onClick={() => {
                            setMaintenanceDraft(null);
                            setMaintenanceReason("");
                          }}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="is-primary"
                          disabled={switchingMaintenance || (
                            maintenanceDraft === "enable" && !maintenanceReason.trim()
                          )}
                          onClick={() => void submitMaintenanceChange()}
                        >
                          {switchingMaintenance ? "正在切换" : "确认执行"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </DiagnosticSection>

                {/* 就绪状态明确区分数据库与对象存储，方便管理员快速定位不可用组件。 */}
                <DiagnosticSection icon={<Activity size={17} />} title="服务状态">
                  <div className="system-health-list">
                    <HealthRow
                      label="PostgreSQL"
                      status={diagnostics.health.components?.database.status ?? "unavailable"}
                      latency={diagnostics.health.components?.database.latencyMs ?? 0}
                    />
                    <HealthRow
                      label="对象存储"
                      status={diagnostics.health.components?.storage.status ?? "unavailable"}
                      latency={diagnostics.health.components?.storage.latencyMs ?? 0}
                    />
                  </div>
                </DiagnosticSection>

                {/* 容量进度使用唯一 FileObject 口径，与上传事务中的 quota 判断保持一致。 */}
                <DiagnosticSection icon={<HardDrive size={17} />} title="容量">
                  <CapacityRow
                    label="平台"
                    used={diagnostics.capacity.platformUsedBytes}
                    quota={diagnostics.capacity.platformQuotaBytes}
                  />
                  <CapacityRow
                    label="当前账号"
                    used={diagnostics.capacity.accountUsedBytes}
                    quota={diagnostics.capacity.accountQuotaBytes}
                  />
                </DiagnosticSection>

                <div className="system-diagnostics-columns">
                  <DiagnosticSection icon={<Database size={17} />} title="数据摘要">
                    <MetricLine label="活动资源" value={diagnostics.resources.active} />
                    <MetricLine label="回收站根项" value={diagnostics.resources.trashed} />
                    <MetricLine label="标注文件" value={diagnostics.resources.annotationFiles} />
                    <MetricLine label="媒体文件" value={diagnostics.resources.mediaFiles} />
                    <MetricLine label="恢复快照" value={diagnostics.resources.recoverySnapshots} />
                    <MetricLine label="唯一文件对象" value={diagnostics.resources.fileObjects} />
                  </DiagnosticSection>
                  <DiagnosticSection icon={<ServerCog size={17} />} title="后台任务">
                    <MetricLine label="排队" value={diagnostics.jobs.queued} />
                    <MetricLine label="运行" value={diagnostics.jobs.running} />
                    <MetricLine label="成功" value={diagnostics.jobs.succeeded} />
                    <MetricLine label="失败" value={diagnostics.jobs.failed} />
                    <MetricLine label="本实例写许可" value={diagnostics.writeGate.active} />
                    <MetricLine label="等待写许可" value={diagnostics.writeGate.waiting} />
                    <MetricLine
                      label="最老许可"
                      value={`${Math.round(diagnostics.writeGate.oldestActiveAgeMs)} ms`}
                    />
                  </DiagnosticSection>
                </div>

                {/* 聚合诊断只说明任务链路是否收敛；具体任务与治理动作继续由后台任务中心负责。 */}
                <DiagnosticSection icon={<TimerReset size={17} />} title="任务可靠性">
                  <div
                    className="system-job-reliability-status"
                    data-state={diagnostics.reliability.state}
                  >
                    <strong>
                      {diagnostics.reliability.state === "healthy"
                        ? "运行正常"
                        : diagnostics.reliability.state === "attention"
                          ? "需要关注"
                          : "处理链路可能停滞"}
                    </strong>
                    <span>{diagnostics.reliability.summary}</span>
                  </div>
                  <div className="system-diagnostics-columns system-job-reliability-grid">
                    <div>
                      <MetricLine
                        label="最老排队"
                        value={formatDiagnosticDuration(diagnostics.reliability.oldestQueuedAgeMs)}
                      />
                      <MetricLine
                        label="最老活动心跳"
                        value={formatDiagnosticDuration(diagnostics.reliability.oldestActiveHeartbeatAgeMs)}
                      />
                      <MetricLine
                        label="最老取消请求"
                        value={formatDiagnosticDuration(diagnostics.reliability.oldestCancellingAgeMs)}
                      />
                      <MetricLine
                        label="陈旧 claim"
                        value={diagnostics.reliability.staleClaims.running + diagnostics.reliability.staleClaims.cancelling}
                      />
                    </div>
                    <div>
                      <MetricLine
                        label={`近 ${diagnostics.reliability.recentWindowMinutes} 分钟成功`}
                        value={diagnostics.reliability.recentOutcomes.succeeded}
                      />
                      <MetricLine label="近期失败" value={diagnostics.reliability.recentOutcomes.failed} />
                      <MetricLine label="近期取消" value={diagnostics.reliability.recentOutcomes.cancelled} />
                      <MetricLine
                        label="平均排队"
                        value={formatDiagnosticDuration(diagnostics.reliability.averageDurationsMs.queueWait)}
                      />
                      <MetricLine
                        label="平均运行"
                        value={formatDiagnosticDuration(diagnostics.reliability.averageDurationsMs.run)}
                      />
                      <MetricLine
                        label="平均取消收敛"
                        value={formatDiagnosticDuration(diagnostics.reliability.averageDurationsMs.cancellation)}
                      />
                    </div>
                  </div>
                </DiagnosticSection>

                {/* 对象一致性仅展示分类计数；具体 storage key 不进入这个常规管理视图。 */}
                <DiagnosticSection icon={<HardDrive size={17} />} title="对象一致性">
                  <div className="system-diagnostics-columns">
                    <div>
                      <MetricLine label="最终对象" value={diagnostics.storage.finalObjectCount} />
                      <MetricLine label="暂存对象" value={diagnostics.storage.stagedObjectCount} />
                      <MetricLine label="磁盘孤儿" value={diagnostics.storage.issuesByCategory.orphan_binary} />
                    </div>
                    <div>
                      <MetricLine label="无引用文件" value={diagnostics.storage.issuesByCategory.unreferenced_file} />
                      <MetricLine label="缺失二进制" value={diagnostics.storage.issuesByCategory.missing_binary} />
                      <MetricLine label="可清理" value={diagnostics.storage.cleanupEligibleCount} />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="system-diagnostics-cleanup"
                    disabled={!diagnostics.storage.cleanupEligibleCount || cleaning}
                    onClick={() => void cleanupEligibleObjects()}
                  >
                    <Trash2 size={15} />
                    {cleaning ? "正在清理" : "清理合格孤儿"}
                  </button>
                </DiagnosticSection>

                <DiagnosticSection icon={<AlertTriangle size={17} />} title="告警">
                  {diagnostics.alerts.length ? (
                    <div className="system-alert-list">
                      {diagnostics.alerts.map((alert) => (
                        <div key={alert.code} data-severity={alert.severity}>
                          <AlertTriangle size={15} /> {alert.message}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="system-diagnostics-empty">
                      <CheckCircle2 size={15} /> 当前没有运行告警
                    </div>
                  )}
                </DiagnosticSection>

                <DiagnosticSection icon={<Activity size={17} />} title="最近运维事件">
                  {diagnostics.recentOperations.length ? (
                    <div className="system-operation-list">
                      {diagnostics.recentOperations.map((event, index) => (
                        <div key={`${event.createdAt}-${event.action}-${index}`}>
                          <time>{formatDiagnosticTime(event.createdAt)}</time>
                          <span>{event.summary}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="system-diagnostics-empty">尚无上传或清理事件</div>
                  )}
                </DiagnosticSection>
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// 诊断分区提供一致的图标、标题和内容层级，避免页面退化成杂乱统计卡片。
function DiagnosticSection(props: {
  icon: JSX.Element;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="system-diagnostics-section">
      <h3>{props.icon}{props.title}</h3>
      {props.children}
    </section>
  );
}

// 健康行把组件状态、中文结论和实际探针耗时放在同一可扫描行中。
function HealthRow(props: {
  label: string;
  status: "ok" | "unavailable";
  latency: number;
}) {
  return (
    <div className="system-health-row" data-status={props.status}>
      {props.status === "ok"
        ? <CheckCircle2 size={16} />
        : <AlertTriangle size={16} />}
      <strong>{props.label}</strong>
      <span>{props.status === "ok" ? "正常" : "不可用"}</span>
      <small>{props.latency.toFixed(2)} ms</small>
    </div>
  );
}

// 容量行统一换算显示单位，progress 仅表达服务端已经确定的占用比例。
function CapacityRow(props: { label: string; used: number; quota: number }) {
  const ratio = props.quota > 0 ? Math.min(1, props.used / props.quota) : 0;
  return (
    <div className="system-capacity-row">
      <div>
        <strong>{props.label}</strong>
        <span>{formatBytes(props.used)} / {formatBytes(props.quota)}</span>
      </div>
      <progress max={1} value={ratio} />
    </div>
  );
}

// 诊断键值项共用紧凑布局；value 允许携带单位，但不在组件内猜测数值含义。
function MetricLine(props: { label: string; value: ReactNode }) {
  return <div className="system-metric-line"><span>{props.label}</span><strong>{props.value}</strong></div>;
}

// 字节显示只影响 UI，不参与服务端配额或告警计算。
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

// 空样本显示为短横线，避免把“没有活动任务”误读为一次耗时为零的任务。
function formatDiagnosticDuration(durationMs: number | null) {
  if (durationMs === null) return "—";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  if (durationMs < 3_600_000) return `${(durationMs / 60_000).toFixed(1)} min`;
  return `${(durationMs / 3_600_000).toFixed(1)} h`;
}

// 运维事件使用用户本地时区显示，原始 ISO 时间仍由 API 保留。
function formatDiagnosticTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

// API 客户端已把结构化错误转成 Error；未知异常使用稳定的用户提示兜底。
function describeDiagnosticsError(error: unknown) {
  return error instanceof Error ? error.message : "读取系统诊断失败。";
}
