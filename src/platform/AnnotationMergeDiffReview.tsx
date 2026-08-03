import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectData } from "../types";
import type {
  AnnotationDiffGroup,
  AnnotationDiffResult,
} from "./annotationDiff";
import {
  AnnotationDiffReview,
  type AnnotationDiffReviewEntry,
  type AnnotationDiffReviewSideAction,
} from "./AnnotationDiffReview";
import { getAnnotationDiffEntryKey } from "./annotationDiffTimeline";
import {
  getAnnotationMergePlanFingerprint,
  getAnnotationMergePreparationState,
  normalizeMergeConflictResolutions,
  setMergeConflictResolution,
  type AnnotationMergeConflictResolutions,
} from "./annotationMergeConflict";
import {
  buildAnnotationMergePlan,
  type AnnotationMergeDirection,
} from "./annotationMergePlan";
import {
  getMergeGroupSelectionState,
  isMergeEntrySelectable,
  normalizeMergeSelection,
  setMergeEntrySelection,
  setMergeGroupSelection,
} from "./annotationMergeSelection";
import { AnnotationMergePlanPanel } from "./AnnotationMergePlanPanel";

export type AnnotationMergeReviewModel = {
  diff: AnnotationDiffResult;
  leftProject: ProjectData;
  rightProject: ProjectData;
};

export type AnnotationMergeReviewIntent = {
  direction: AnnotationMergeDirection;
  selectedEntryKeys: string[];
  conflictResolutions: AnnotationMergeConflictResolutions;
  planFingerprint: string;
};

// 共享审阅层只拥有选择、计划和人工冲突决定；资源读取、草稿存储与编辑器打开由外层编排。
export function AnnotationMergeDiffReview(props: {
  comparison: AnnotationMergeReviewModel;
  expandedDomains: ReadonlySet<string>;
  openingSide: "left" | "right" | null;
  sideActions: readonly AnnotationDiffReviewSideAction[];
  leftName: string;
  rightName: string;
  allowedDirections: readonly AnnotationMergeDirection[];
  onToggleDomain: (domain: AnnotationDiffGroup["domain"]) => void;
  onExpandDomain: (domain: AnnotationDiffGroup["domain"]) => void;
  onPrepare: (intent: AnnotationMergeReviewIntent) => Promise<
    { ok: true } | { ok: false; message: string }
  >;
  onPreparingChange?: (preparing: boolean) => void;
}) {
  const initialDirection = props.allowedDirections[0] ?? "left-to-right";
  const allowedDirectionKey = props.allowedDirections.join("|");
  const [mergeDirection, setMergeDirection] = useState(initialDirection);
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<Set<string>>(new Set());
  const [conflictResolutions, setConflictResolutions] =
    useState<AnnotationMergeConflictResolutions>({});
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const mergePlan = useMemo(() => buildAnnotationMergePlan({
    leftProject: props.comparison.leftProject,
    rightProject: props.comparison.rightProject,
    diff: props.comparison.diff,
    direction: mergeDirection,
    selectedEntryKeys: [...selectedEntryKeys],
  }), [mergeDirection, props.comparison, selectedEntryKeys]);
  const preparationState = useMemo(() => getAnnotationMergePreparationState(
    mergePlan,
    conflictResolutions,
  ), [conflictResolutions, mergePlan]);

  // 新比较模型或受限方向变化时重置旧选择，避免把另一会话的稳定 key 带进当前计划。
  useEffect(() => {
    const fallbackDirection = props.allowedDirections.includes(mergeDirection)
      ? mergeDirection
      : initialDirection;
    setMergeDirection(fallbackDirection);
    setSelectedEntryKeys(new Set());
    setConflictResolutions({});
    setPreparationError(null);
    setPreparing(false);
    props.onPreparingChange?.(false);
  }, [allowedDirectionKey, initialDirection, props.comparison]);

  // 每次选择或方向生成新计划，只保留仍属于当前冲突集合的人工决定。
  useEffect(() => {
    setConflictResolutions((current) =>
      normalizeMergeConflictResolutions(mergePlan, current));
    setPreparationError(null);
  }, [mergePlan]);

  // 外层会重新读取权威数据；共享层只提交排序后的用户意图和当前计划指纹。
  const prepareMerge = async () => {
    if (!preparationState.canPrepare || preparing) return;
    setPreparing(true);
    props.onPreparingChange?.(true);
    setPreparationError(null);
    const result = await props.onPrepare({
      direction: mergeDirection,
      selectedEntryKeys: [...selectedEntryKeys].sort(),
      conflictResolutions,
      planFingerprint: getAnnotationMergePlanFingerprint(mergePlan),
    });
    if (!result.ok) {
      setPreparationError(result.message);
      setPreparing(false);
      props.onPreparingChange?.(false);
    }
  };

  return (
    <AnnotationDiffReview
      diff={props.comparison.diff}
      expandedDomains={props.expandedDomains}
      openingSide={props.openingSide}
      sideActions={props.sideActions}
      onToggleDomain={props.onToggleDomain}
      onExpandDomain={props.onExpandDomain}
      beforeGroups={<AnnotationMergePlanPanel
        direction={mergeDirection}
        allowedDirections={props.allowedDirections}
        leftFileName={props.leftName}
        rightFileName={props.rightName}
        selectedEntryCount={selectedEntryKeys.size}
        plan={mergePlan}
        conflictResolutions={conflictResolutions}
        preparationState={preparationState}
        preparing={preparing}
        preparationError={preparationError}
        onDirectionChange={(direction) => {
          if (!props.allowedDirections.includes(direction)) return;
          setMergeDirection(direction);
          setPreparationError(null);
          setSelectedEntryKeys((current) =>
            normalizeMergeSelection(props.comparison.diff, direction, current));
        }}
        onClearSelection={() => setSelectedEntryKeys(new Set())}
        onResolveConflict={(entryKey, resolution) => {
          setConflictResolutions((current) =>
            setMergeConflictResolution(current, entryKey, resolution));
          setPreparationError(null);
        }}
        onPrepare={() => void prepareMerge()}
      />}
      renderGroupControl={(group) => (
        <MergeGroupCheckbox
          state={getMergeGroupSelectionState(
            selectedEntryKeys,
            group,
            mergeDirection,
          )}
          label={`${group.label}整合选择`}
          onChange={(selected) => setSelectedEntryKeys((current) =>
            setMergeGroupSelection(current, group, mergeDirection, selected))}
        />
      )}
      renderEntryControl={(entry) => (
        <MergeEntryCheckbox
          entry={entry}
          direction={mergeDirection}
          selected={selectedEntryKeys.has(getAnnotationDiffEntryKey(entry))}
          onChange={(selected) => setSelectedEntryKeys((current) =>
            setMergeEntrySelection(current, getAnnotationDiffEntryKey(entry), selected))}
        />
      )}
    />
  );
}

// 单项复选框只允许当前来源侧真实存在的变化实体进入整合计划。
function MergeEntryCheckbox(props: {
  entry: AnnotationDiffReviewEntry;
  direction: AnnotationMergeDirection;
  selected: boolean;
  onChange: (selected: boolean) => void;
}) {
  const selectable = isMergeEntrySelectable(props.entry, props.direction);
  return (
    <label
      className="annotation-comparison-merge-checkbox"
      title={selectable
        ? "加入选择性整合预检"
        : getMergeDisabledReason(props.entry, props.direction)}
    >
      <input
        type="checkbox"
        checked={props.selected}
        disabled={!selectable}
        aria-label={`${props.entry.label || props.entry.identity}加入整合预检`}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

// 原生 checkbox 的 indeterminate 通过 DOM 属性同步，分组状态仍由纯 helper 唯一计算。
function MergeGroupCheckbox(props: {
  state: ReturnType<typeof getMergeGroupSelectionState>;
  label: string;
  onChange: (selected: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = props.state.indeterminate;
  }, [props.state.indeterminate]);
  return (
    <label
      className="annotation-comparison-group-selection"
      title={props.state.selectableCount > 0
        ? "选择或取消该领域全部可整合差异"
        : "该领域没有当前方向可整合的差异"}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={props.state.checked}
        disabled={props.state.selectableCount === 0}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.state.selectedCount}/{props.state.selectableCount}</span>
    </label>
  );
}

// 禁用原因按来源方向解释，固定方向草稿审阅也不会误把服务器独有实体当成本地来源。
function getMergeDisabledReason(
  entry: AnnotationDiffReviewEntry,
  direction: AnnotationMergeDirection,
) {
  if (entry.domain === "project") return "项目与媒体设置不能作为局部实体整合";
  if (entry.changeType === "unchanged") return "未变化实体只会在需要时作为自动依赖";
  return direction === "left-to-right"
    ? "该实体只存在于右侧，左侧没有可整合来源"
    : "该实体只存在于左侧，右侧没有可整合来源";
}
