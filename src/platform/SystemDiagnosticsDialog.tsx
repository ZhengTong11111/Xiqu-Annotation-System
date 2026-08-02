import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ServerCog,
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
                  </DiagnosticSection>
                </div>

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

// 诊断数量项共用紧凑键值布局，避免为每个数字制造卡片。
function MetricLine(props: { label: string; value: number }) {
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
