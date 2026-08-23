import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_SENTENCE_ROLE_OPTION_LENGTH,
  MAX_SENTENCE_ROLE_OPTIONS,
} from "../types";
import type { SentenceRoleDropEdge } from "../utils/sentenceRoleReorder";

const SENTENCE_ROLE_DRAG_KIND = "sentence-role-option";

type SentenceRoleDragData = {
  kind: typeof SENTENCE_ROLE_DRAG_KIND;
  role: string;
};

type SentenceAnnotationSettingsDialogProps = {
  open: boolean;
  roleOptions: string[];
  onOpenChange: (open: boolean) => void;
  onAdd: (name: string) => Promise<boolean>;
  onRename: (previousName: string, name: string) => Promise<boolean>;
  onReorder: (
    sourceRole: string,
    targetRole: string,
    edge: SentenceRoleDropEdge,
  ) => Promise<boolean>;
  onRemove: (role: string, replacement: string | null) => Promise<boolean>;
  disabledReason?: string;
};

type SentenceRoleOptionRowProps = {
  role: string;
  index: number;
  roleCount: number;
  draft: string;
  controlsDisabled: boolean;
  dragDisabledReason?: string;
  onDraftChange: (value: string) => void;
  onCommitRename: (role: string, candidate: string) => void;
  onRestoreDraft: () => void;
  onReorder: (sourceRole: string, targetRole: string, edge: SentenceRoleDropEdge) => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
};

function parseSentenceRoleDragData(
  value: Record<string | symbol, unknown>,
): SentenceRoleDragData | null {
  if (value.kind !== SENTENCE_ROLE_DRAG_KIND || typeof value.role !== "string") return null;
  return value as SentenceRoleDragData;
}

function getSentenceRoleDropEdge(element: HTMLElement, clientY: number): SentenceRoleDropEdge {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

function SentenceRoleOptionRow({
  role,
  index,
  roleCount,
  draft,
  controlsDisabled,
  dragDisabledReason,
  onDraftChange,
  onCommitRename,
  onRestoreDraft,
  onReorder,
  onMove,
  onRemove,
}: SentenceRoleOptionRowProps) {
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const [handleElement, setHandleElement] = useState<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropEdge, setDropEdge] = useState<SentenceRoleDropEdge | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    if (!rowElement || !handleElement) return;

    // Atlaskit 只负责稳定的原生拖放生命周期；实际排序仍由纯函数和结构事务完成。
    return combine(
      draggable({
        element: rowElement,
        dragHandle: handleElement,
        canDrag: () => !dragDisabledReason,
        getInitialData: (): SentenceRoleDragData => ({
          kind: SENTENCE_ROLE_DRAG_KIND,
          role,
        }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: rowElement,
        canDrop: ({ source }) => {
          const sourceData = parseSentenceRoleDragData(source.data);
          return !dragDisabledReason && sourceData !== null && sourceData.role !== role;
        },
        onDragEnter: ({ location }) => {
          setDropEdge(getSentenceRoleDropEdge(rowElement, location.current.input.clientY));
        },
        onDrag: ({ location }) => {
          setDropEdge(getSentenceRoleDropEdge(rowElement, location.current.input.clientY));
        },
        onDragLeave: () => setDropEdge(null),
        onDrop: ({ source, location }) => {
          setDropEdge(null);
          const sourceData = parseSentenceRoleDragData(source.data);
          if (!sourceData || sourceData.role === role) return;
          onReorderRef.current(
            sourceData.role,
            role,
            getSentenceRoleDropEdge(rowElement, location.current.input.clientY),
          );
        },
      }),
    );
  }, [dragDisabledReason, handleElement, role, rowElement]);

  return (
    <div
      ref={setRowElement}
      className={[
        "sentence-role-row",
        dragging ? "is-dragging" : "",
        dropEdge ? `drop-${dropEdge}` : "",
      ].join(" ")}
    >
      <button
        ref={setHandleElement}
        type="button"
        className="sentence-role-drag-handle"
        aria-label={`拖动“${role}”调整顺序`}
        title={dragDisabledReason ?? "拖动调整顺序"}
        disabled={Boolean(dragDisabledReason)}
      >
        <GripVertical size={16} />
      </button>
      <input
        value={draft}
        maxLength={MAX_SENTENCE_ROLE_OPTION_LENGTH}
        aria-label={`角色行当 ${index + 1}`}
        disabled={controlsDisabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={(event) => onCommitRename(role, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            onRestoreDraft();
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="icon-button"
        title="上移"
        disabled={controlsDisabled || index === 0}
        onClick={() => onMove("up")}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="icon-button"
        title="下移"
        disabled={controlsDisabled || index === roleCount - 1}
        onClick={() => onMove("down")}
      >
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        className="icon-button danger"
        title="删除"
        disabled={controlsDisabled}
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

export function SentenceAnnotationSettingsDialog({
  open,
  roleOptions,
  onOpenChange,
  onAdd,
  onRename,
  onReorder,
  onRemove,
  disabledReason,
}: SentenceAnnotationSettingsDialogProps) {
  const [drafts, setDrafts] = useState(roleOptions);
  const [newRoleName, setNewRoleName] = useState("");
  const [removeRole, setRemoveRole] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationPendingRef = useRef(false);

  useEffect(() => {
    setDrafts(roleOptions);
    setValidationMessage(null);
    if (removeRole && !roleOptions.includes(removeRole)) setRemoveRole(null);
  }, [removeRole, roleOptions]);

  const removedRole = removeRole && roleOptions.includes(removeRole) ? removeRole : null;
  const replacementOptions = roleOptions.filter((role) => role !== removedRole);
  const hasUnsavedDraft = drafts.length !== roleOptions.length || drafts.some(
    (draft, index) => draft !== roleOptions[index],
  );
  const controlsDisabled = mutationPending || Boolean(disabledReason);
  const dragDisabledReason = disabledReason
    ?? (mutationPending ? "正在保存角色设置" : undefined)
    ?? (removedRole ? "请先完成或取消删除操作" : undefined)
    ?? (hasUnsavedDraft ? "请先确认正在编辑的角色名称" : undefined);

  // 所有角色配置操作串行等待结构事务结果，失败时保留用户输入并显示可见反馈。
  const runMutation = async (
    task: () => Promise<boolean>,
    onSuccess?: () => void,
  ) => {
    if (mutationPendingRef.current || disabledReason) return false;
    mutationPendingRef.current = true;
    setMutationPending(true);
    setValidationMessage(null);
    try {
      const saved = await task();
      if (saved) {
        onSuccess?.();
      } else {
        setValidationMessage("角色设置未能保存，请确认协作状态后重试。");
      }
      return saved;
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "角色设置保存失败。");
      return false;
    } finally {
      mutationPendingRef.current = false;
      setMutationPending(false);
    }
  };

  const addRole = () => {
    const normalized = newRoleName.trim();
    if (!normalized) return;
    if (roleOptions.length >= MAX_SENTENCE_ROLE_OPTIONS) {
      setValidationMessage(`角色行当最多可设置 ${MAX_SENTENCE_ROLE_OPTIONS} 项。`);
      return;
    }
    if (roleOptions.includes(normalized)) {
      setValidationMessage("角色行当名称不能重复。");
      return;
    }
    void runMutation(() => onAdd(normalized), () => setNewRoleName(""));
  };

  // 重命名先在对话框内校验，避免失焦后输入框保留一个实际未保存的名称。
  const commitRename = async (previousName: string, candidate: string) => {
    const index = roleOptions.indexOf(previousName);
    const normalized = candidate.trim();
    if (!normalized || roleOptions.some((role, roleIndex) =>
      roleIndex !== index && role === normalized)) {
      setDrafts((current) => current.map((value, roleIndex) =>
        roleIndex === index ? previousName : value));
      setValidationMessage(!normalized ? "角色行当名称不能为空。" : "角色行当名称不能重复。");
      return;
    }
    if (normalized === previousName) return;
    const saved = await runMutation(() => onRename(previousName, normalized));
    if (!saved) {
      setDrafts((current) => current.map((value, roleIndex) =>
        roleIndex === index ? previousName : value));
    }
  };

  const reorderRole = (
    sourceRole: string,
    targetRole: string,
    edge: SentenceRoleDropEdge,
  ) => {
    void runMutation(() => onReorder(sourceRole, targetRole, edge));
  };

  const moveRoleWithButton = (role: string, index: number, direction: "up" | "down") => {
    const targetRole = roleOptions[direction === "up" ? index - 1 : index + 1];
    if (!targetRole) return;
    reorderRole(role, targetRole, direction === "up" ? "before" : "after");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutationPendingRef.current) onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sentence-settings-overlay" />
        <Dialog.Content className="sentence-settings-dialog" aria-describedby="sentence-settings-description">
          <header className="sentence-settings-header">
            <div>
              <Dialog.Title>句级标注设置</Dialog.Title>
              <Dialog.Description id="sentence-settings-description">
                管理当前项目可选的角色行当；拖动或使用方向按钮调整句级菜单顺序。
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" title="关闭" disabled={mutationPending}>
              <X size={17} />
            </Dialog.Close>
          </header>

          {disabledReason ? <p className="sentence-role-disabled-note">{disabledReason}</p> : null}
          <div className="sentence-role-list" aria-busy={mutationPending}>
            {roleOptions.length === 0 ? (
              <p className="sentence-role-empty">尚未设置角色行当。</p>
            ) : roleOptions.map((role, index) => (
              <SentenceRoleOptionRow
                key={role}
                role={role}
                index={index}
                roleCount={roleOptions.length}
                draft={drafts[index] ?? role}
                controlsDisabled={controlsDisabled}
                dragDisabledReason={dragDisabledReason}
                onDraftChange={(value) => setDrafts((current) => {
                  const next = [...current];
                  next[index] = value;
                  return next;
                })}
                onCommitRename={(previousName, candidate) => {
                  void commitRename(previousName, candidate);
                }}
                onRestoreDraft={() => setDrafts((current) => current.map((value, optionIndex) =>
                  optionIndex === index ? role : value))}
                onReorder={reorderRole}
                onMove={(direction) => moveRoleWithButton(role, index, direction)}
                onRemove={() => {
                  setRemoveRole(role);
                  setReplacement("");
                }}
              />
            ))}
          </div>

          <div className="sentence-role-add-row">
            <input
              value={newRoleName}
              maxLength={MAX_SENTENCE_ROLE_OPTION_LENGTH}
              placeholder="新角色行当"
              disabled={controlsDisabled}
              onChange={(event) => setNewRoleName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addRole();
              }}
            />
            <button
              type="button"
              onClick={addRole}
              disabled={controlsDisabled || !newRoleName.trim() || roleOptions.length >= MAX_SENTENCE_ROLE_OPTIONS}
            >
              <Plus size={16} />
              新增
            </button>
          </div>
          {validationMessage ? (
            <p className="sentence-role-validation" role="alert">{validationMessage}</p>
          ) : null}
          {mutationPending ? <p className="sentence-role-pending" role="status">正在保存角色设置...</p> : null}

          {removedRole ? (
            <div className="sentence-role-remove-confirmation">
              <strong>删除“{removedRole}”</strong>
              <p>已使用该行当的句子需要选择替代项，或清空后重新标注。</p>
              <select
                value={replacement}
                disabled={controlsDisabled}
                onChange={(event) => setReplacement(event.target.value)}
              >
                <option value="">清空这些句子的角色行当</option>
                {replacementOptions.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <div className="sentence-role-remove-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={controlsDisabled}
                  onClick={() => setRemoveRole(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void runMutation(
                      () => onRemove(removedRole, replacement || null),
                      () => setRemoveRole(null),
                    );
                  }}
                >
                  确认删除
                </button>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
