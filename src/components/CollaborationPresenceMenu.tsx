import { Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationPresenceMember } from "@xiqu/shared";
import { buildCollaborationPresenceView } from "../platform/collaborationPresenceView";

type CollaborationPresenceMenuProps = {
  members: AnnotationPresenceMember[];
  currentUserId?: string;
  showRemoteCollaborationHints: boolean;
  sharePointerAndSelection: boolean;
  onShowRemoteCollaborationHintsChange?: (visible: boolean) => void;
  onSharePointerAndSelectionChange?: (enabled: boolean) => void;
};

/** 在线成员入口只展示同文件最小身份信息，不承担权限编辑或文档同步状态。 */
export function CollaborationPresenceMenu({
  members,
  currentUserId,
  showRemoteCollaborationHints,
  sharePointerAndSelection,
  onShowRemoteCollaborationHintsChange,
  onSharePointerAndSelectionChange,
}: CollaborationPresenceMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewMembers = useMemo(
    () => buildCollaborationPresenceView(members, currentUserId),
    [currentUserId, members],
  );

  // 弹层打开时统一监听外部点击和 Escape，关闭后立即卸载全局事件。
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="collaboration-presence-menu">
      {/* 入口只控制展示，不改变连接、权限或保存状态。 */}
      <button
        type="button"
        className="collaboration-presence-trigger"
        aria-expanded={open}
        title="查看当前标注文件的在线成员"
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={14} aria-hidden="true" />
        <span>{viewMembers.length} 人在线</span>
      </button>
      {open ? (
        <div className="collaboration-presence-popover" role="dialog" aria-label="在线成员">
          <div className="collaboration-presence-heading">当前文件在线成员</div>
          {viewMembers.length ? viewMembers.map((member) => (
            <div key={member.userId} className="collaboration-presence-member">
              <span className="collaboration-presence-avatar" aria-hidden="true">
                {member.avatarLabel}
              </span>
              <span className="collaboration-presence-identity">
                <strong>
                  {member.displayName}
                  {member.isCurrentUser ? <small>我</small> : null}
                </strong>
                <span>
                  {member.accountName}
                  {member.connectionCount > 1 ? ` · ${member.connectionCount} 个窗口` : ""}
                </span>
              </span>
            </div>
          )) : (
            <div className="collaboration-presence-empty">正在获取在线成员…</div>
          )}
          {/* 两个开关分别控制本地呈现和对外共享，不能把隐藏 UI 误当成退出协作会话。 */}
          <div className="collaboration-presence-options">
            <label>
              <input
                type="checkbox"
                checked={showRemoteCollaborationHints}
                onChange={(event) => onShowRemoteCollaborationHintsChange?.(event.target.checked)}
              />
              <span>显示远端播放头、鼠标与选区</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={sharePointerAndSelection}
                onChange={(event) => onSharePointerAndSelectionChange?.(event.target.checked)}
              />
              <span>共享我的鼠标与选区摘要</span>
            </label>
          </div>
          <div className="collaboration-presence-note">在线状态不会改变文件权限或保存结果。</div>
        </div>
      ) : null}
    </div>
  );
}
