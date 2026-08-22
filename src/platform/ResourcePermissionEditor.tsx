import {
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  RESOURCE_CAPABILITIES,
  type ResourceCapability,
  type ResourceEntry,
  type ResourcePermissionMatrixRow,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  canDelegateResourcePermissionPreset,
  classifyResourcePermissionPreset,
  getResourcePermissionPresetCapabilities,
  RESOURCE_CAPABILITY_LABELS,
  type ResourcePermissionPreset,
} from "./resourcePermissionPresets";
import { ResourcePermissionPresetSelector } from "./ResourcePermissionPresetSelector";

// 权限区只切换展示复杂度；两种模式继续编辑同一条直接 ACL。
type PermissionEditorMode = "simple" | "detailed";

// 资源 Inspector 的权限模块独立拥有矩阵读取与行级编辑，服务端仍负责最终 ACL 计算和委派校验。
export function ResourcePermissionEditor(props: {
  client: PlatformClient;
  resource: ResourceEntry;
  readOnly: boolean;
  refreshVersion?: number;
  onChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [mode, setMode] = useState<PermissionEditorMode>("simple");
  const [matrix, setMatrix] = useState<ResourcePermissionMatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [inheritanceBusy, setInheritanceBusy] = useState(false);
  const [mutatingUserIds, setMutatingUserIds] = useState<Set<string>>(() => new Set());
  const requestGenerationRef = useRef(0);
  const inheritanceGenerationRef = useRef(0);
  const canManage = !props.readOnly && props.resource.permission.canManagePermissions;
  const mutationBusy = mutatingUserIds.size > 0;

  // 每次读取都绑定当前资源 generation，切换资源后迟到响应不能覆盖新的权限矩阵。
  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    if (!canManage) {
      setMatrix([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const nextMatrix = await props.client.listResourcePermissions(props.resource.id);
      if (generation === requestGenerationRef.current) setMatrix(nextMatrix);
    } catch (error) {
      if (generation === requestGenerationRef.current) props.onError(describeError(error));
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [canManage, props.client, props.onError, props.refreshVersion, props.resource.id]);

  // 资源或管理资格变化时重新读取；cleanup 使旧请求的成功与失败回调一起失效。
  useEffect(() => {
    void load();
    return () => {
      requestGenerationRef.current += 1;
      inheritanceGenerationRef.current += 1;
    };
  }, [load]);

  // 权限写入成功后先刷新资源本身，再重新读取服务端计算出的 direct/effective 权限。
  const handlePermissionChanged = useCallback(async () => {
    await props.onChanged();
    await load();
  }, [load, props.onChanged]);

  // 汇总所有账号行的写入状态，避免保存途中切换模式或刷新后出现两套草稿交错。
  const handleRowBusyChange = useCallback((userId: string, busy: boolean) => {
    setMutatingUserIds((current) => {
      if (current.has(userId) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  // 资源级继承开关只在详细模式编辑，避免某个账号行暗中改变所有账号的继承结果。
  async function updateResourceInheritance(inheritFromParent: boolean) {
    if (inheritanceBusy) return;
    const generation = ++inheritanceGenerationRef.current;
    setInheritanceBusy(true);
    try {
      await props.client.updateResourceInheritance(props.resource.id, {
        breakPermissionInheritance: !inheritFromParent,
      });
      if (generation !== inheritanceGenerationRef.current) return;
      await handlePermissionChanged();
    } catch (error) {
      if (generation === inheritanceGenerationRef.current) props.onError(describeError(error));
    } finally {
      if (generation === inheritanceGenerationRef.current) setInheritanceBusy(false);
    }
  }

  return (
    <>
      {/* 标题区把展示模式与刷新命令并列，极简模式不会改变底层 ACL 合同。 */}
      <div className="resource-inspector-section-heading resource-permission-heading">
        <div>
          <strong>账号权限</strong>
          <span>当前选中资源的逐账号授权</span>
        </div>
        {canManage ? (
          <div className="resource-permission-heading-actions">
            <div className="resource-permission-mode-switch" role="group" aria-label="权限编辑模式">
              <button
                type="button"
                className={mode === "simple" ? "active" : ""}
                aria-pressed={mode === "simple"}
                disabled={mutationBusy || inheritanceBusy}
                onClick={() => setMode("simple")}
              >
                极简
              </button>
              <button
                type="button"
                className={mode === "detailed" ? "active" : ""}
                aria-pressed={mode === "detailed"}
                disabled={mutationBusy || inheritanceBusy}
                onClick={() => setMode("detailed")}
              >
                详细
              </button>
            </div>
            <button
              type="button"
              className="resource-permission-refresh"
              onClick={() => void load()}
              disabled={loading || mutationBusy || inheritanceBusy}
              title="刷新权限"
              aria-label="刷新权限"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        ) : null}
      </div>

      {/* 无管理能力时只展示当前账号自身的有效权限，不能请求完整账号矩阵。 */}
      {!canManage && !props.readOnly ? (
        <div className="resource-permission-readonly">
          你拥有：{formatCapabilities(props.resource.permission.capabilities)}
        </div>
      ) : null}
      {loading ? <div className="resource-permission-readonly">正在读取账号权限...</div> : null}

      {canManage ? (
        <>
          {/* 极简模式只解释资源级继承状态；修改该全局开关需进入详细模式。 */}
          {mode === "detailed" ? (
            <label className="resource-inheritance-toggle">
              <input
                type="checkbox"
                checked={!props.resource.breakPermissionInheritance}
                disabled={inheritanceBusy}
                onChange={(event) => void updateResourceInheritance(event.target.checked)}
              />
              继承父目录权限
            </label>
          ) : (
            <div className="resource-permission-inheritance-status">
              {props.resource.breakPermissionInheritance
                ? "当前资源已停止继承父目录权限"
                : "当前资源会继承父目录权限；可在详细模式调整"}
            </div>
          )}
          <div className="resource-permission-list">
            {matrix.map((row) => (
              <PermissionRow
                key={`${props.resource.id}:${row.user.id}`}
                client={props.client}
                resource={props.resource}
                row={row}
                mode={mode}
                onChanged={handlePermissionChanged}
                onBusyChange={handleRowBusyChange}
                onError={props.onError}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

// 单个账号行在两种模式之间共享 capabilities、直接授权存在性和向下传递设置。
function PermissionRow(props: {
  client: PlatformClient;
  resource: ResourceEntry;
  row: ResourcePermissionMatrixRow;
  mode: PermissionEditorMode;
  onChanged: () => void | Promise<void>;
  onBusyChange: (userId: string, busy: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hasDirectGrant, setHasDirectGrant] = useState(Boolean(props.row.directPermission));
  const [capabilities, setCapabilities] = useState<ResourceCapability[]>(
    props.row.directPermission?.capabilities ?? [],
  );
  const [inheritToChildren, setInheritToChildren] = useState(
    props.row.directPermission?.inheritToChildren ?? true,
  );
  const [busy, setBusy] = useState(false);
  const mutationGenerationRef = useRef(0);
  const privileged = props.row.effectivePermission.isOwner ||
    props.row.effectivePermission.source === "admin";
  const presetMatch = hasDirectGrant
    ? classifyResourcePermissionPreset(capabilities, props.resource.type)
    : "none";
  const residualAccessDescription = getResidualAccessDescription(props.row);

  // 本地与父面板共用一个 busy 入口，防止异常或迟到请求只清理其中一侧。
  const updateBusy = useCallback((nextBusy: boolean) => {
    setBusy(nextBusy);
    props.onBusyChange(props.row.user.id, nextBusy);
  }, [props.onBusyChange, props.row.user.id]);

  // 服务端矩阵刷新或资源切换后重建本地草稿，并让旧资源上的迟到写入回调失效。
  useEffect(() => {
    mutationGenerationRef.current += 1;
    setHasDirectGrant(Boolean(props.row.directPermission));
    setCapabilities(props.row.directPermission?.capabilities ?? []);
    setInheritToChildren(props.row.directPermission?.inheritToChildren ?? true);
    updateBusy(false);
    return () => {
      // 卸载时令未完成写入的回调失效，并释放父面板的模式切换门禁。
      mutationGenerationRef.current += 1;
      props.onBusyChange(props.row.user.id, false);
    };
  }, [props.resource.id, props.row, updateBusy]);

  // 选择标准预设只更新本地草稿；用户仍需点击保存才会改变服务器 ACL。
  function selectPreset(preset: ResourcePermissionPreset) {
    if (preset === "none") {
      setHasDirectGrant(false);
      setCapabilities([]);
      return;
    }
    setHasDirectGrant(true);
    setCapabilities(getResourcePermissionPresetCapabilities(preset, props.resource.type));
  }

  // 保存根据草稿存在性选择 upsert 或 DELETE，绝不以空 capability grant 模拟“不额外授权”。
  async function savePermission() {
    if (busy) return;
    const generation = ++mutationGenerationRef.current;
    updateBusy(true);
    try {
      if (hasDirectGrant) {
        await props.client.upsertResourcePermission(
          props.resource.id,
          props.row.user.id,
          { capabilities, inheritToChildren },
        );
      } else if (props.row.directPermission) {
        await props.client.removeResourcePermission(props.resource.id, props.row.user.id);
      }
      if (generation !== mutationGenerationRef.current) return;
      await props.onChanged();
    } catch (error) {
      if (generation === mutationGenerationRef.current) props.onError(describeError(error));
    } finally {
      if (generation === mutationGenerationRef.current) updateBusy(false);
    }
  }

  // 详细模式保留原有即时移除命令，同时复用同一 busy/generation 保护。
  async function removeDirectPermission() {
    if (busy || !props.row.directPermission) return;
    const generation = ++mutationGenerationRef.current;
    updateBusy(true);
    try {
      await props.client.removeResourcePermission(props.resource.id, props.row.user.id);
      if (generation !== mutationGenerationRef.current) return;
      await props.onChanged();
    } catch (error) {
      if (generation === mutationGenerationRef.current) props.onError(describeError(error));
    } finally {
      if (generation === mutationGenerationRef.current) updateBusy(false);
    }
  }

  return (
    <section className="resource-permission-row">
      {/* 摘要始终显示服务端有效权限来源，不把当前未保存的预设伪装成已经生效。 */}
      <button
        type="button"
        className="resource-permission-summary"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="resource-user-avatar">{props.row.user.displayName.slice(0, 1)}</span>
        <span>
          <strong>{props.row.user.displayName}</strong>
          <small>{getPermissionSummary(props.row)}</small>
        </span>
        <ChevronRight size={15} className={expanded ? "expanded" : ""} />
      </button>

      {expanded && !privileged ? (
        <div className="resource-permission-editor" aria-busy={busy}>
          {props.mode === "simple" ? (
            <>
              {/* 极简模式只暴露三个可解释预设，自定义授权必须由用户明确覆盖。 */}
              <ResourcePermissionPresetSelector
                name={`resource-permission-${props.resource.id}-${props.row.user.id}`}
                ariaLabel={`${props.row.user.displayName}的权限预设`}
                value={presetMatch}
                resourceType={props.resource.type}
                actorCapabilities={props.resource.permission.capabilities}
                disabled={busy}
                onChange={selectPreset}
              />
              {presetMatch === "custom" ? (
                <div className="resource-permission-preset-note">
                  当前为自定义细分权限；切换详细模式查看，或选择一个预设覆盖。
                </div>
              ) : null}
              {!hasDirectGrant ? (
                <div className="resource-permission-preset-note">
                  {residualAccessDescription ?? "保存后将不再为此资源设置直接授权。"}
                </div>
              ) : null}
              {canDelegateResourcePermissionPreset(
                props.resource.permission.capabilities,
                "edit",
                props.resource.type,
              ) ? null : (
                <div className="resource-permission-preset-note warning">
                  你不能授予完整“可编辑”预设，请使用详细模式选择可委派能力。
                </div>
              )}
            </>
          ) : (
            <>
              {/* 详细模式完整保留九种 capability 和向下传递设置。 */}
              <div className="resource-capability-grid">
                {RESOURCE_CAPABILITIES.map((capability) => (
                  <label key={capability}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(capability)}
                      disabled={busy}
                      onChange={(event) => {
                        setHasDirectGrant(true);
                        setCapabilities((current) => event.target.checked
                          ? [...current, capability]
                          : current.filter((item) => item !== capability));
                      }}
                    />
                    {RESOURCE_CAPABILITY_LABELS[capability]}
                  </label>
                ))}
              </div>
              <label className="resource-inheritance-toggle compact">
                <input
                  type="checkbox"
                  checked={inheritToChildren}
                  disabled={busy}
                  onChange={(event) => setInheritToChildren(event.target.checked)}
                />
                授权传递给子文件
              </label>
            </>
          )}

          {/* 两种模式共享保存命令；详细模式额外保留原有立即移除入口。 */}
          <div className="resource-permission-actions">
            {props.mode === "detailed" && props.row.directPermission ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void removeDirectPermission()}
              >
                移除直接授权
              </button>
            ) : <span />}
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void savePermission()}
            >
              {busy ? "正在保存..." : "保存权限"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// 摘要区区分 owner、管理员、直接授权、角色基线和继承来源，避免“尚未授权”掩盖有效访问。
function getPermissionSummary(row: ResourcePermissionMatrixRow): string {
  if (row.effectivePermission.isOwner) return "所有者 · 完整权限";
  if (row.effectivePermission.source === "admin") return "系统管理员 · 完整权限";
  if (row.directPermission) return "当前资源直接授权";
  if (row.effectivePermission.source === "role") return "教师角色自动查看";
  if (row.effectivePermission.source === "inherited") {
    return `继承：${row.effectivePermission.inheritedFrom.map((item) => item.resourceName).join("、")}`;
  }
  return "尚未直接授权";
}

// 删除直接 ACL 前先解释仍会保留的角色或父目录权限，不能把“无直接授权”描述成“完全无权限”。
function getResidualAccessDescription(row: ResourcePermissionMatrixRow): string | null {
  const sources: string[] = [];
  if (row.user.roles.includes("teacher")) sources.push("教师角色仍提供查看、播放与下载");
  if (row.effectivePermission.inheritedFrom.length) {
    sources.push(`仍继承自：${row.effectivePermission.inheritedFrom.map((item) => item.resourceName).join("、")}`);
  }
  return sources.length ? sources.join("；") : null;
}

// 只读摘要保持 capability 的权威顺序，并在空集合时给出明确文本。
function formatCapabilities(capabilities: readonly ResourceCapability[]): string {
  return capabilities.map((capability) => RESOURCE_CAPABILITY_LABELS[capability]).join("、") || "无权限";
}

// 网络和服务端稳定错误信息原样交给 Inspector 顶部反馈区显示。
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "权限操作失败，请稍后重试。";
}
