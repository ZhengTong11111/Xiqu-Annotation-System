import type {
  AssignmentRecipientStatus,
  CourseMemberRole,
} from "@xiqu/shared";

export function canCourseRoleManageAssignments(role: CourseMemberRole) {
  return role === "instructor" || role === "assistant";
}

export function canCourseRoleManageMembers(role: CourseMemberRole) {
  return role === "instructor";
}

/**
 * 作业接收状态只允许沿显式工作流前进，避免路由或 UI 各自实现一套状态机。
 * returned 再次保存后会回到 in_progress，随后可以再次提交。
 */
export function canTransitionAssignmentRecipient(
  from: AssignmentRecipientStatus,
  to: AssignmentRecipientStatus,
) {
  const transitions: Record<AssignmentRecipientStatus, AssignmentRecipientStatus[]> = {
    pending: ["assigned"],
    assigned: ["in_progress", "submitted"],
    in_progress: ["submitted"],
    submitted: ["returned"],
    returned: ["in_progress", "submitted"],
  };
  return transitions[from].includes(to);
}

export function isAssignmentRecipientWritable(
  status: AssignmentRecipientStatus,
) {
  return status !== "submitted";
}
