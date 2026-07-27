import { useEffect, useMemo, useState } from "react";
import type {
  AnnotationDocumentSummary,
  AnnotationProjectSummary,
  AssignmentRecipient,
  AssignmentSummary,
  CourseMember,
  CourseMemberRole,
  CourseSummary,
  MyAssignment,
  PermissionTrackOption,
  PlatformUser,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type CourseWorkspaceProps = {
  client: PlatformClient;
  projects: AnnotationProjectSummary[];
  documentsByProjectId: Record<string, AnnotationDocumentSummary[]>;
  user: PlatformUser;
  onOpenDocument: (documentId: string) => Promise<void>;
  onError: (message: string) => void;
};

export function CourseWorkspace({
  client,
  projects,
  documentsByProjectId,
  user,
  onOpenDocument,
  onError,
}: CourseWorkspaceProps) {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [members, setMembers] = useState<CourseMember[]>([]);
  const [directory, setDirectory] = useState<PlatformUser[]>([]);
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [myAssignments, setMyAssignments] = useState<MyAssignment[]>([]);
  const [recipients, setRecipients] = useState<AssignmentRecipient[]>([]);
  const [tracks, setTracks] = useState<PermissionTrackOption[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [selectedAssignmentId, setSelectedAssignmentId] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<CourseMemberRole>("student");
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentDescription, setAssignmentDescription] = useState("");
  const [assignmentStartAt, setAssignmentStartAt] = useState("");
  const [sourceDocumentId, setSourceDocumentId] = useState("");
  const [recipientUserIds, setRecipientUserIds] = useState<string[]>([]);
  const [trackIds, setTrackIds] = useState<string[]>([]);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [editingAssignmentId, setEditingAssignmentId] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const allDocuments = useMemo(
    () => projects.flatMap((project) =>
      (documentsByProjectId[project.id] ?? []).map((document) => ({
        ...document,
        projectTitle: project.title,
      }))),
    [documentsByProjectId, projects],
  );
  const selectedDocument = allDocuments.find((item) => item.id === sourceDocumentId);
  const selectedCourse = courses.find((course) => course.id === selectedCourseId);
  const canManageCourse = Boolean(
    selectedCourse && selectedCourse.currentUserRole !== "student",
  );
  const canManageMembers = user.roles.some((role) =>
    role === "super_admin" || role === "admin") ||
    selectedCourse?.currentUserRole === "instructor";
  const studentMembers = members.filter((member) => member.role === "student");
  const canCreateCourse = user.roles.some((role) =>
    role === "super_admin" || role === "admin" || role === "teacher" || role === "ta");
  const canAssignInstructor = user.roles.some((role) =>
    role === "super_admin" || role === "admin") ||
    selectedCourse?.currentUserRole === "instructor";

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    if (!selectedCourseId) return;
    void loadCourse(selectedCourseId);
  }, [selectedCourseId]);

  useEffect(() => {
    if (!selectedAssignmentId || !canManageCourse) {
      setRecipients([]);
      return;
    }
    void client.listAssignmentRecipients(selectedAssignmentId)
      .then(setRecipients)
      .catch((error) => onError(toMessage(error)));
  }, [selectedAssignmentId, canManageCourse]);

  useEffect(() => {
    if (!sourceDocumentId) {
      setTracks([]);
      return;
    }
    void client.listPermissionTracks(sourceDocumentId)
      .then((nextTracks) => {
        setTracks(nextTracks);
        setTrackIds((current) =>
          editingAssignmentId ? current : nextTracks.map((track) => track.id));
      })
      .catch((error) => onError(toMessage(error)));
  }, [sourceDocumentId]);

  async function loadOverview() {
    setIsBusy(true);
    try {
      const [nextCourses, nextMine] = await Promise.all([
        client.listCourses(),
        client.listMyAssignments(),
      ]);
      setCourses(nextCourses);
      setMyAssignments(nextMine);
      setSelectedCourseId((current) => current || nextCourses[0]?.id || "");
      // 学生账号无课程管理权限，目录接口会返回 403；管理目录只在需要时加载。
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function loadCourse(courseId: string) {
    try {
      const [nextMembers, nextAssignments] = await Promise.all([
        client.listCourseMembers(courseId),
        client.listCourseAssignments(courseId),
      ]);
      setMembers(nextMembers);
      setAssignments(nextAssignments);
      // 切换课程后清空旧课程的接收者，避免误把其他课程学生带进新草稿。
      setRecipientUserIds([]);
      if (
        user.roles.some((role) => role === "super_admin" || role === "admin") ||
        courses.find((course) => course.id === courseId)?.currentUserRole === "instructor"
      ) {
        setDirectory(await client.listDirectoryUsers({ courseId }));
      } else {
        setDirectory([]);
      }
      setSelectedAssignmentId((current) =>
        nextAssignments.some((item) => item.id === current)
          ? current
          : nextAssignments[0]?.id ?? "");
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function createCourse() {
    if (!courseTitle.trim()) return;
    setIsBusy(true);
    try {
      const course = await client.createCourse({ title: courseTitle.trim() });
      setCourseTitle("");
      await loadOverview();
      setSelectedCourseId(course.id);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function addMember() {
    if (!selectedCourseId || !memberUserId) return;
    try {
      const existing = members.find((member) => member.userId === memberUserId);
      if (existing) {
        await client.updateCourseMember(selectedCourseId, existing.id, { role: memberRole });
      } else {
        await client.addCourseMember(selectedCourseId, {
          userId: memberUserId,
          role: memberRole,
        });
      }
      setMemberUserId("");
      await loadCourse(selectedCourseId);
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function createAssignment() {
    if (!selectedCourseId || !selectedDocument || !assignmentTitle.trim()) return;
    setIsBusy(true);
    try {
      const request = {
        title: assignmentTitle.trim(),
        description: assignmentDescription.trim() || null,
        projectId: selectedDocument.projectId,
        sourceDocumentId: selectedDocument.id,
        startAt: assignmentStartAt ? new Date(assignmentStartAt).toISOString() : null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        scope: {
          startTime: startTime === "" ? null : Number(startTime),
          endTime: endTime === "" ? null : Number(endTime),
          trackIds,
        },
        recipientUserIds,
      };
      if (editingAssignmentId) {
        await client.updateDraftAssignment(editingAssignmentId, {
          title: request.title,
          description: request.description,
          startAt: request.startAt,
          dueAt: request.dueAt,
          scope: request.scope,
          recipientUserIds: request.recipientUserIds,
        });
      } else {
        await client.createAssignment(selectedCourseId, request);
      }
      setAssignmentTitle("");
      setAssignmentDescription("");
      setAssignmentStartAt("");
      setDueAt("");
      setEditingAssignmentId("");
      await loadCourse(selectedCourseId);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function removeMember(member: CourseMember) {
    if (!selectedCourseId || !window.confirm(`确定从课程中移除“${member.displayName}”吗？`)) return;
    try {
      await client.removeCourseMember(selectedCourseId, member.id);
      await loadCourse(selectedCourseId);
      await loadOverview();
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function beginEditAssignment(assignment: AssignmentSummary) {
    try {
      const pendingRecipients = await client.listAssignmentRecipients(assignment.id);
      setSelectedAssignmentId(assignment.id);
      setEditingAssignmentId(assignment.id);
      setAssignmentTitle(assignment.title);
      setAssignmentDescription(assignment.description ?? "");
      setAssignmentStartAt(toLocalDateTimeInput(assignment.startAt));
      setDueAt(toLocalDateTimeInput(assignment.dueAt));
      setSourceDocumentId(assignment.sourceDocumentId);
      setStartTime(assignment.scope.timeRange ? String(assignment.scope.timeRange.startTime) : "");
      setEndTime(assignment.scope.timeRange ? String(assignment.scope.timeRange.endTime) : "");
      setTrackIds(assignment.scope.trackIds);
      setRecipientUserIds(pendingRecipients.map((recipient) => recipient.userId));
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function publishAssignment(assignmentId: string) {
    if (!window.confirm("发布后将为每名学生生成独立文档，确定继续吗？")) return;
    try {
      await client.publishAssignment(assignmentId);
      await loadCourse(selectedCourseId);
      setSelectedAssignmentId(assignmentId);
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function submitAssignment(assignmentId: string) {
    if (!window.confirm("请先确认已经保存最新修改。提交后将暂时不能继续修改，确定提交吗？")) {
      return;
    }
    try {
      await client.submitAssignment(assignmentId);
      await loadOverview();
    } catch (error) {
      onError(toMessage(error));
    }
  }

  async function returnRecipient(recipient: AssignmentRecipient) {
    const feedback = window.prompt("退回说明（可留空）", recipient.feedback ?? "");
    if (feedback === null) return;
    try {
      await client.returnAssignment(recipient.assignmentId, recipient.id, { feedback });
      setRecipients(await client.listAssignmentRecipients(recipient.assignmentId));
    } catch (error) {
      onError(toMessage(error));
    }
  }

  return (
    <section className="platform-course-workspace">
      <div className="platform-section-header">
        <div>
          <span className="platform-kicker">Course Assignments</span>
          <h1>课程与独立标注作业</h1>
        </div>
        <button type="button" onClick={() => void loadOverview()} disabled={isBusy}>刷新</button>
      </div>

      <section className="platform-assignment-section">
        <h2>我的作业</h2>
        <div className="platform-assignment-list">
          {myAssignments.map(({ assignment, courseTitle: name, recipient }) => (
            <article key={recipient.id} className="platform-assignment-card">
              <div>
                <strong>{assignment.title}</strong>
                <span>{name} · {recipientStatusLabel(recipient.status)}</span>
                <small>{assignment.dueAt ? `截止 ${formatDate(assignment.dueAt)}` : "未设置截止时间"}</small>
                {recipient.feedback ? <small>退回说明：{recipient.feedback}</small> : null}
              </div>
              <div className="platform-action-row">
                <button type="button" disabled={!recipient.documentId} onClick={() => recipient.documentId && void onOpenDocument(recipient.documentId)}>
                  打开
                </button>
                <button type="button" disabled={recipient.status === "submitted" || !recipient.documentId} onClick={() => void submitAssignment(assignment.id)}>
                  提交
                </button>
              </div>
            </article>
          ))}
          {!myAssignments.length ? <p className="platform-muted">当前账号没有待办作业。</p> : null}
        </div>
      </section>

      <div className="platform-course-grid">
        <aside className="platform-list-panel">
          <h2>课程</h2>
          {courses.map((course) => (
            <button key={course.id} type="button" className={course.id === selectedCourseId ? "selected" : ""} onClick={() => setSelectedCourseId(course.id)}>
              <strong>{course.title}</strong>
              <span>{course.memberCount} 名成员 · {course.assignmentCount} 个作业</span>
            </button>
          ))}
          {canCreateCourse ? <div className="platform-inline-form">
            <input value={courseTitle} onChange={(event) => setCourseTitle(event.target.value)} placeholder="新课程名称" />
            <button type="button" onClick={() => void createCourse()}>新建</button>
          </div> : null}
        </aside>

        <div className="platform-detail-panel">
          <h2>{selectedCourse?.title ?? "请选择课程"}</h2>
          {canManageCourse ? (
            <>
              {canManageMembers ? <div className="platform-inline-form">
                <select value={memberUserId} onChange={(event) => {
                  const userId = event.target.value;
                  setMemberUserId(userId);
                  const existing = members.find((member) => member.userId === userId);
                  if (existing) setMemberRole(existing.role);
                }}>
                  <option value="">选择账号</option>
                  {directory.map((item) => (
                    <option key={item.id} value={item.id}>{item.displayName}（{item.accountName}）</option>
                  ))}
                </select>
                <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as CourseMemberRole)}>
                  <option value="student">学生</option>
                  <option value="assistant">助教</option>
                  {canAssignInstructor ? <option value="instructor">教师</option> : null}
                </select>
                <button type="button" onClick={() => void addMember()}>新增或更新成员</button>
              </div> : null}
              <div className="platform-member-strip">
                {members.map((member) => (
                  <span key={member.id}>
                    {member.displayName} · {courseRoleLabel(member.role)}
                    {canManageMembers && member.userId !== selectedCourse?.ownerUserId ? (
                      <button type="button" title="移除成员" onClick={() => void removeMember(member)}>×</button>
                    ) : null}
                  </span>
                ))}
              </div>
              <div className="platform-assignment-form">
                <input value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} placeholder="作业标题" />
                <input value={assignmentDescription} onChange={(event) => setAssignmentDescription(event.target.value)} placeholder="作业说明（可选）" />
                <select disabled={Boolean(editingAssignmentId)} value={sourceDocumentId} onChange={(event) => setSourceDocumentId(event.target.value)}>
                  <option value="">选择基准文档</option>
                  {allDocuments.map((document) => <option key={document.id} value={document.id}>{document.projectTitle} / {document.title}</option>)}
                </select>
                <input type="number" min="0" step="0.01" value={startTime} onChange={(event) => setStartTime(event.target.value)} placeholder="开始秒数（可选）" />
                <input type="number" min="0" step="0.01" value={endTime} onChange={(event) => setEndTime(event.target.value)} placeholder="结束秒数（可选）" />
                <label>开始时间<input type="datetime-local" value={assignmentStartAt} onChange={(event) => setAssignmentStartAt(event.target.value)} /></label>
                <label>截止时间<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
                <div className="platform-check-grid">
                  {tracks.map((track) => (
                    <label key={track.id}>
                      <input type="checkbox" checked={trackIds.includes(track.id)} onChange={() => setTrackIds((current) => current.includes(track.id) ? current.filter((id) => id !== track.id) : [...current, track.id])} />
                      {track.label}
                    </label>
                  ))}
                </div>
                <div className="platform-check-grid">
                  {studentMembers.map((member) => (
                    <label key={member.id}>
                      <input type="checkbox" checked={recipientUserIds.includes(member.userId)} onChange={() => setRecipientUserIds((current) => current.includes(member.userId) ? current.filter((id) => id !== member.userId) : [...current, member.userId])} />
                      {member.displayName}
                    </label>
                  ))}
                </div>
                <div className="platform-action-row">
                  <button type="button" disabled={!recipientUserIds.length || isBusy} onClick={() => void createAssignment()}>
                    {editingAssignmentId ? "保存草稿修改" : "创建作业草稿"}
                  </button>
                  {editingAssignmentId ? <button type="button" onClick={() => setEditingAssignmentId("")}>取消编辑</button> : null}
                </div>
              </div>
            </>
          ) : null}

          <div className="platform-assignment-list">
            {assignments.map((assignment) => (
              <article key={assignment.id} className={`platform-assignment-card ${assignment.id === selectedAssignmentId ? "selected" : ""}`} onClick={() => setSelectedAssignmentId(assignment.id)}>
                <div>
                  <strong>{assignment.title}</strong>
                  <span>{assignment.status === "draft" ? "草稿" : "已发布"} · {assignment.submittedCount}/{assignment.recipientCount} 已提交</span>
                  <small>
                    基准版本 r{assignment.sourceRevision}
                    {assignment.dueAt && new Date(assignment.dueAt).getTime() < Date.now()
                      ? " · 已逾期"
                      : ""}
                  </small>
                </div>
                {assignment.status === "draft" && canManageCourse ? (
                  <div className="platform-action-row">
                    <button type="button" onClick={(event) => { event.stopPropagation(); void beginEditAssignment(assignment); }}>编辑</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); void publishAssignment(assignment.id); }}>发布</button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          {recipients.length ? (
            <div className="platform-progress-table">
              {recipients.map((recipient) => (
                <div key={recipient.id}>
                  <strong>{recipient.displayName}（{recipient.accountName}）</strong>
                  <span>{recipientStatusLabel(recipient.status)}</span>
                  <span>{recipient.firstEditedAt ? `首次 ${formatDate(recipient.firstEditedAt)}` : "尚未开始"}</span>
                  <span>{recipient.lastActivityAt ? `最近 ${formatDate(recipient.lastActivityAt)}` : "无活动"}</span>
                  <span>{recipient.submittedAt ? `提交 ${formatDate(recipient.submittedAt)}` : "未提交"}</span>
                  <button type="button" disabled={!recipient.documentId} onClick={() => recipient.documentId && void onOpenDocument(recipient.documentId)}>查看</button>
                  <button type="button" disabled={recipient.status !== "submitted"} onClick={() => void returnRecipient(recipient)}>退回</button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "课程作业操作失败。";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}

function toLocalDateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function courseRoleLabel(role: CourseMemberRole) {
  return role === "instructor" ? "教师" : role === "assistant" ? "助教" : "学生";
}

function recipientStatusLabel(status: AssignmentRecipient["status"]) {
  const labels: Record<AssignmentRecipient["status"], string> = {
    pending: "待发布",
    assigned: "未开始",
    in_progress: "进行中",
    submitted: "已提交",
    returned: "已退回",
  };
  return labels[status];
}
