import { useEffect, useMemo, useState } from "react";
import type {
  AnnotationProjectSummary,
  AnnotationVersionSummary,
  AnnotationWorkspaceSummary,
  PermissionTrackOption,
  PlatformUser,
  ProjectCapability,
  ProjectMember,
  ProjectMemberRole,
} from "@xiqu/shared";
import {
  DEFAULT_PROJECT_ROLE_CAPABILITIES,
  PROJECT_CAPABILITIES,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type ProjectPermissionWorkspaceProps = {
  client: PlatformClient;
  projects: AnnotationProjectSummary[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onProjectsChanged: () => Promise<void> | void;
  onError: (message: string | null) => void;
};

type MemberDraft = {
  role: ProjectMemberRole;
  capabilities: ProjectCapability[];
  startTime: string;
  endTime: string;
  trackIds: string[];
  expiresAt: string;
};

const CAPABILITY_LABELS: Record<ProjectCapability, string> = {
  view_project: "查看项目",
  create_workspace: "创建和编辑自己的工作区",
  fork_version: "Fork 已完成版本",
  complete_version: "完成标注版本",
  submit_version: "提交工作区",
  review_versions: "审查成员版本",
  create_project_version: "建立项目候选版本",
  publish_project_version: "发布项目版本",
  manage_all_versions: "管理所有工作区与版本",
  manage_members: "管理项目成员",
};

const CAPABILITY_OPTIONS = PROJECT_CAPABILITIES.map((value) => ({
  value,
  label: CAPABILITY_LABELS[value],
}));

export function ProjectPermissionWorkspace({
  client,
  projects,
  selectedProjectId,
  onSelectProject,
  onOpenWorkspace,
  onProjectsChanged,
  onError,
}: ProjectPermissionWorkspaceProps) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [directoryUsers, setDirectoryUsers] = useState<PlatformUser[]>([]);
  const [tracks, setTracks] = useState<PermissionTrackOption[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<ProjectMemberRole>("annotator");
  const [draft, setDraft] = useState<MemberDraft>(
    emptyDraft("annotator"),
  );
  const [memberWorkspaces, setMemberWorkspaces] = useState<
    AnnotationWorkspaceSummary[]
  >([]);
  const [memberVersions, setMemberVersions] = useState<
    AnnotationVersionSummary[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ??
    projects[0] ??
    null;
  const selectedMember =
    members.find((member) => member.id === selectedMemberId) ?? null;
  const canManageMembers =
    selectedProject?.currentUserCapabilities.includes("manage_members") ??
    false;
  const availableUsers = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.userId));
    return directoryUsers.filter((user) => !memberIds.has(user.id));
  }, [directoryUsers, members]);

  useEffect(() => {
    if (!selectedProject) {
      setMembers([]);
      setSelectedMemberId(null);
      return;
    }
    // 权限管理接口只对 manage_members 开放。没有该能力时直接呈现只读说明，
    // 不先发送一个必然 403 的请求，避免把正常的权限边界误显示成全局错误。
    if (!selectedProject.currentUserCapabilities.includes("manage_members")) {
      setMembers([]);
      setDirectoryUsers([]);
      setTracks([]);
      setSelectedMemberId(null);
      return;
    }
    void loadProjectAdministration(selectedProject.id);
  }, [selectedProject?.id, canManageMembers]);

  useEffect(() => {
    if (!selectedProject || !selectedMember) {
      setMemberWorkspaces([]);
      setMemberVersions([]);
      return;
    }
    setDraft(draftFromMember(selectedMember));
    void loadMemberResults(selectedProject.id, selectedMember.userId);
  }, [selectedProject?.id, selectedMember?.id]);

  async function loadProjectAdministration(projectId: string) {
    setIsLoading(true);
    onError(null);
    try {
      const [nextMembers, nextUsers, nextTracks] = await Promise.all([
        client.listProjectMembers(projectId),
        client.listDirectoryUsers({ projectId, limit: 100 }),
        client.listPermissionTracks(projectId),
      ]);
      setMembers(nextMembers);
      setDirectoryUsers(nextUsers);
      setTracks(nextTracks);
      setSelectedMemberId((current) =>
        current && nextMembers.some((member) => member.id === current)
          ? current
          : nextMembers[0]?.id ?? null
      );
      setNewUserId((current) =>
        current && nextUsers.some((user) => user.id === current)
          ? current
          : nextUsers.find((candidate) =>
              !nextMembers.some((member) => member.userId === candidate.id)
            )?.id ?? ""
      );
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadMemberResults(projectId: string, userId: string) {
    try {
      const [workspaces, versions] = await Promise.all([
        client.listProjectWorkspaces(projectId, { ownerUserId: userId }),
        client.listProjectAnnotationVersions(projectId, {
          createdBy: userId,
        }),
      ]);
      setMemberWorkspaces(workspaces);
      setMemberVersions(versions);
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function handleAddMember() {
    if (!selectedProject || !newUserId) return;
    setIsSaving(true);
    onError(null);
    try {
      await client.addProjectMember(selectedProject.id, {
        userId: newUserId,
        role: newRole,
        capabilities: [...DEFAULT_PROJECT_ROLE_CAPABILITIES[newRole]],
      });
      await loadProjectAdministration(selectedProject.id);
      await onProjectsChanged();
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveMember() {
    if (!selectedProject || !selectedMember || selectedMember.isOwner) return;
    const timeRange = parseTimeRange(draft.startTime, draft.endTime);
    if (timeRange === "invalid") {
      onError("时间范围必须同时填写，并满足 0 ≤ 开始秒数 < 结束秒数。");
      return;
    }
    setIsSaving(true);
    onError(null);
    try {
      await client.updateProjectMember(
        selectedProject.id,
        selectedMember.id,
        {
          role: draft.role,
          capabilities: draft.capabilities,
          scope: {
            timeRange,
            trackScope: draft.trackIds.length
              ? { trackIds: draft.trackIds }
              : null,
          },
          expiresAt: draft.expiresAt
            ? new Date(draft.expiresAt).toISOString()
            : null,
        },
      );
      await loadProjectAdministration(selectedProject.id);
      await onProjectsChanged();
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemoveMember() {
    if (
      !selectedProject ||
      !selectedMember ||
      selectedMember.isOwner ||
      !window.confirm(
        `确认移除“${selectedMember.displayName}”？其历史版本会保留，活动工作区将归档。`,
      )
    ) {
      return;
    }
    setIsSaving(true);
    onError(null);
    try {
      await client.removeProjectMember(
        selectedProject.id,
        selectedMember.id,
      );
      await loadProjectAdministration(selectedProject.id);
      await onProjectsChanged();
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="platform-permission-workspace">
      <div className="platform-permission-projects">
        <div className="platform-permission-column-header">
          <div>
            <span className="platform-kicker">Projects</span>
            <h1>项目权限管理</h1>
          </div>
        </div>
        <div className="platform-permission-scroll">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={
                project.id === selectedProject?.id ? "selected" : ""
              }
              onClick={() => onSelectProject(project.id)}
            >
              <strong>{project.title}</strong>
              <span>{project.memberCount} 名成员</span>
            </button>
          ))}
        </div>
      </div>

      <div className="platform-permission-detail">
        <div className="platform-permission-column-header">
          <div>
            <span className="platform-kicker">Members & Results</span>
            <h1>{selectedProject?.title ?? "未选择项目"}</h1>
          </div>
          <button
            type="button"
            onClick={() =>
              selectedProject &&
              void loadProjectAdministration(selectedProject.id)}
            disabled={!selectedProject || !canManageMembers || isLoading}
          >
            刷新
          </button>
        </div>

        <div className="platform-permission-scroll">
          {!canManageMembers
            ? (
                <p className="platform-muted">
                  当前账号没有管理此项目成员的权限。
                </p>
              )
            : null}

          <section className="platform-member-add-panel">
            <h2>添加项目成员</h2>
            <div className="platform-member-add-grid">
              <select
                value={newUserId}
                onChange={(event) => setNewUserId(event.target.value)}
                disabled={!canManageMembers || isSaving}
              >
                <option value="">选择尚未加入的账号</option>
                {availableUsers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName} · {candidate.accountName}
                  </option>
                ))}
              </select>
              <select
                value={newRole}
                onChange={(event) =>
                  setNewRole(event.target.value as ProjectMemberRole)}
                disabled={!canManageMembers || isSaving}
              >
                <option value="manager">项目管理员</option>
                <option value="reviewer">审核者</option>
                <option value="annotator">标注者</option>
                <option value="viewer">只读成员</option>
              </select>
              <button
                type="button"
                onClick={() => void handleAddMember()}
                disabled={!canManageMembers || !newUserId || isSaving}
              >
                添加成员
              </button>
            </div>
          </section>

          <div className="platform-member-management-grid">
            <section className="platform-member-list">
              <h2>项目成员</h2>
              {members.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className={member.id === selectedMember?.id ? "selected" : ""}
                  onClick={() => setSelectedMemberId(member.id)}
                >
                  <strong>{member.displayName}</strong>
                  <span>
                    {member.accountName} · {roleLabel(member.role)}
                  </span>
                </button>
              ))}
            </section>

            <section className="platform-member-editor">
              <div className="platform-detail-title">
                <h2>
                  {selectedMember
                    ? `编辑：${selectedMember.displayName}`
                    : "请选择成员"}
                </h2>
                <span>
                  {selectedMember?.isOwner
                    ? "项目所有者拥有完整权限"
                    : "所有设置只作用于当前选中账号"}
                </span>
              </div>

              {selectedMember
                ? (
                    <>
                      <label>
                        项目角色
                        <select
                          value={draft.role}
                          onChange={(event) => {
                            const role = event.target.value as ProjectMemberRole;
                            setDraft((current) => ({
                              ...current,
                              role,
                              capabilities: [
                                ...DEFAULT_PROJECT_ROLE_CAPABILITIES[role],
                              ],
                            }));
                          }}
                          disabled={selectedMember.isOwner || isSaving}
                        >
                          <option value="manager">项目管理员</option>
                          <option value="reviewer">审核者</option>
                          <option value="annotator">标注者</option>
                          <option value="viewer">只读成员</option>
                        </select>
                      </label>

                      <fieldset className="platform-capability-grid">
                        <legend>项目能力</legend>
                        {CAPABILITY_OPTIONS.map((option) => (
                          <label key={option.value}>
                            <input
                              type="checkbox"
                              checked={draft.capabilities.includes(option.value)}
                              onChange={() =>
                                setDraft((current) => ({
                                  ...current,
                                  capabilities: toggleValue(
                                    current.capabilities,
                                    option.value,
                                  ),
                                }))}
                              disabled={selectedMember.isOwner || isSaving}
                            />
                            {option.label}
                          </label>
                        ))}
                      </fieldset>

                      <div className="platform-scope-grid">
                        <label>
                          开始秒数
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={draft.startTime}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                startTime: event.target.value,
                              }))}
                            disabled={selectedMember.isOwner || isSaving}
                          />
                        </label>
                        <label>
                          结束秒数
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={draft.endTime}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                endTime: event.target.value,
                              }))}
                            disabled={selectedMember.isOwner || isSaving}
                          />
                        </label>
                        <label>
                          有效期
                          <input
                            type="datetime-local"
                            value={draft.expiresAt}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                expiresAt: event.target.value,
                              }))}
                            disabled={selectedMember.isOwner || isSaving}
                          />
                        </label>
                      </div>

                      <fieldset className="platform-track-scope-list">
                        <legend>允许编辑的轨道</legend>
                        <p>不勾选表示全部轨道。</p>
                        {tracks.map((track) => (
                          <label key={track.id}>
                            <input
                              type="checkbox"
                              checked={draft.trackIds.includes(track.id)}
                              onChange={() =>
                                setDraft((current) => ({
                                  ...current,
                                  trackIds: toggleValue(
                                    current.trackIds,
                                    track.id,
                                  ),
                                }))}
                              disabled={selectedMember.isOwner || isSaving}
                            />
                            {track.label}
                          </label>
                        ))}
                      </fieldset>

                      <div className="platform-action-row">
                        <button
                          type="button"
                          onClick={() => void handleSaveMember()}
                          disabled={selectedMember.isOwner || isSaving}
                        >
                          保存当前账号权限
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void handleRemoveMember()}
                          disabled={selectedMember.isOwner || isSaving}
                        >
                          移出项目
                        </button>
                      </div>
                    </>
                  )
                : null}
            </section>
          </div>

          <section className="platform-member-results">
            <div className="platform-detail-title">
              <h2>当前成员的标注成果</h2>
              <span>
                {selectedMember
                  ? `${selectedMember.displayName} · ${memberWorkspaces.length} 个工作区 · ${memberVersions.length} 个版本`
                  : "请选择成员"}
              </span>
            </div>
            <h3>工作区</h3>
            <div className="platform-version-list">
              {memberWorkspaces.map((workspace) => (
                <article key={workspace.id} className="platform-version-item">
                  <div>
                    <strong>{workspace.name}</strong>
                    <span>
                      revision {workspace.latestRevision} · {workspace.status} ·{" "}
                      {formatDate(workspace.updatedAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(workspace.id)}
                  >
                    只读查看
                  </button>
                </article>
              ))}
              {selectedMember && !memberWorkspaces.length
                ? <p className="platform-muted">该成员还没有工作区。</p>
                : null}
            </div>
            <h3>完成版本</h3>
            <div className="platform-version-list">
              {memberVersions.map((version) => (
                <article key={version.id} className="platform-version-item">
                  <div>
                    <strong>{version.name}</strong>
                    <span>
                      revision {version.revision} ·{" "}
                      {formatDate(version.completedAt)}
                    </span>
                  </div>
                </article>
              ))}
              {selectedMember && !memberVersions.length
                ? <p className="platform-muted">该成员还没有完成版本。</p>
                : null}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function emptyDraft(role: ProjectMemberRole): MemberDraft {
  return {
    role,
    capabilities: [...DEFAULT_PROJECT_ROLE_CAPABILITIES[role]],
    startTime: "",
    endTime: "",
    trackIds: [],
    expiresAt: "",
  };
}

function draftFromMember(member: ProjectMember): MemberDraft {
  return {
    role: member.role === "owner" ? "manager" : member.role,
    capabilities: member.capabilities,
    startTime: member.timeRange ? String(member.timeRange.startTime) : "",
    endTime: member.timeRange ? String(member.timeRange.endTime) : "",
    trackIds: member.trackIds,
    expiresAt: member.expiresAt
      ? toDateTimeLocal(member.expiresAt)
      : "",
  };
}

function parseTimeRange(start: string, end: string) {
  if (!start && !end) return null;
  const startTime = Number(start);
  const endTime = Number(end);
  if (
    !start ||
    !end ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime < 0 ||
    endTime <= startTime
  ) {
    return "invalid" as const;
  }
  return { startTime, endTime };
}

function toggleValue<T>(values: T[], value: T) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function roleLabel(role: ProjectMember["role"]) {
  return {
    owner: "所有者",
    manager: "项目管理员",
    reviewer: "审核者",
    annotator: "标注者",
    viewer: "只读成员",
  }[role];
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "项目权限请求失败。";
}
