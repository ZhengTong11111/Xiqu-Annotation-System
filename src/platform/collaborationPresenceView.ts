import type { AnnotationPresenceMember } from "@xiqu/shared";

export type CollaborationPresenceViewMember = AnnotationPresenceMember & {
  isCurrentUser: boolean;
  avatarLabel: string;
};

// 展示层按“自己优先、名称稳定排序”组织成员，不改变服务端权威快照。
export function buildCollaborationPresenceView(
  members: AnnotationPresenceMember[],
  currentUserId?: string,
): CollaborationPresenceViewMember[] {
  return members
    .map((member) => ({
      ...member,
      isCurrentUser: member.userId === currentUserId,
      avatarLabel: Array.from(member.displayName.trim())[0] ?? "用",
    }))
    .sort((left, right) =>
      Number(right.isCurrentUser) - Number(left.isCurrentUser) ||
      left.displayName.localeCompare(right.displayName, "zh-CN") ||
      left.userId.localeCompare(right.userId));
}
