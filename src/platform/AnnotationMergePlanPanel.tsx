import {
  AlertTriangle,
  CircleEqual,
  GitMerge,
  ListChecks,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AnnotationDiffDomain } from "./annotationDiff";
import type {
  AnnotationMergeDirection,
  AnnotationMergePlan,
  AnnotationMergePlanItem,
} from "./annotationMergePlan";
import type {
  AnnotationMergeConflictResolution,
  AnnotationMergeConflictResolutions,
  AnnotationMergePreparationState,
} from "./annotationMergeConflict";

const INITIAL_VISIBLE_ITEMS = 40;
const VISIBLE_ITEM_STEP = 100;

const DOMAIN_LABELS: Record<AnnotationDiffDomain, string> = {
  project: "项目与媒体",
  subtitle_lines: "句级字幕",
  characters: "逐字标注",
  gongche: "工尺谱",
  banyan_sections: "板眼区段",
  banyan_marks: "板眼标记",
  custom_tracks: "自定义轨道",
  custom_blocks: "自定义标注块",
  attached_points: "附属打点",
};

// 预检面板只展示纯计划结果，不拥有 payload、依赖推断或任何保存命令。
export function AnnotationMergePlanPanel(props: {
  direction: AnnotationMergeDirection;
  allowedDirections?: readonly AnnotationMergeDirection[];
  leftFileName: string;
  rightFileName: string;
  selectedEntryCount: number;
  plan: AnnotationMergePlan;
  conflictResolutions: AnnotationMergeConflictResolutions;
  preparationState: AnnotationMergePreparationState;
  preparing: boolean;
  preparationError: string | null;
  onDirectionChange: (direction: AnnotationMergeDirection) => void;
  onClearSelection: () => void;
  onResolveConflict: (
    entryKey: string,
    resolution: AnnotationMergeConflictResolution,
  ) => void;
  onPrepare: () => void;
}) {
  const allowedDirections = props.allowedDirections ?? ["left-to-right", "right-to-left"];
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEMS);
  const visibleItems = useMemo(() =>
    props.plan.items
      .filter(({ action }) => action !== "replace-conflict")
      .slice(0, visibleItemLimit),
  [props.plan.items, visibleItemLimit]);
  const conflicts = useMemo(() => props.plan.items.filter(({ action }) =>
    action === "replace-conflict"), [props.plan.items]);
  const nonConflictItemCount = props.plan.items.length - conflicts.length;

  // 每次方向或选择生成新计划时收起长列表，避免旧的展开量拖慢新的预检。
  useEffect(() => {
    setVisibleItemLimit(INITIAL_VISIBLE_ITEMS);
  }, [props.direction, props.selectedEntryCount]);

  return (
    <section className="annotation-merge-plan" aria-labelledby="annotation-merge-plan-title">
      {/* 标题区明确标记当前仍是应用前草稿，避免用户把预检误认为已经写入目标文件。 */}
      <header className="annotation-merge-plan-header">
        <span>
          <GitMerge size={16} />
          <strong id="annotation-merge-plan-title">选择性整合预检</strong>
          <small>未应用</small>
        </span>
        {props.selectedEntryCount > 0 ? (
          <button type="button" onClick={props.onClearSelection}>
            <Trash2 size={13} /> 清空选择
          </button>
        ) : null}
      </header>

      {/* 分段控件同时写明来源和目标文件，箭头不作为唯一方向提示。 */}
      <div className="annotation-merge-direction" role="group" aria-label="整合方向">
        {allowedDirections.includes("left-to-right") ? (
          <DirectionButton
            selected={props.direction === "left-to-right"}
            sideLabel="左侧"
            commandLabel="整合到右侧"
            sourceName={props.leftFileName}
            targetName={props.rightFileName}
            onClick={() => props.onDirectionChange("left-to-right")}
          />
        ) : null}
        {allowedDirections.includes("right-to-left") ? (
          <DirectionButton
            selected={props.direction === "right-to-left"}
            sideLabel="右侧"
            commandLabel="整合到左侧"
            sourceName={props.rightFileName}
            targetName={props.leftFileName}
            onClick={() => props.onDirectionChange("right-to-left")}
          />
        ) : null}
      </div>

      {props.selectedEntryCount === 0 ? (
        <p className="annotation-merge-empty">
          <ListChecks size={16} />
          在下方差异条目左侧勾选需要整合的实体；时间筛选和条目导航不会改变这里的选择。
        </p>
      ) : (
        <>
          {/* 摘要完全来自计划器，UI 不根据行数或变化类型二次推断。 */}
          <div className="annotation-merge-summary">
            <span><strong>{props.plan.counts.selected}</strong> 用户选择</span>
            <span><strong>{props.plan.counts.dependencies}</strong> 自动依赖</span>
            <span className="action-add"><strong>{props.plan.counts.additions}</strong> 新增</span>
            <span className="action-conflict"><strong>{props.plan.counts.conflicts}</strong> 待决冲突</span>
            <span className="action-equal"><strong>{props.plan.counts.alreadyEqual}</strong> 目标已相同</span>
          </div>

          {/* 结构 issue 会阻断准备按钮，不能让半成品项目进入目标编辑器。 */}
          {props.plan.issues.length > 0 ? (
            <div className="annotation-merge-issues" role="alert">
              <strong><AlertTriangle size={14} /> 发现 {props.plan.issues.length} 个结构问题</strong>
              {props.plan.issues.map((issue) => (
                <span key={`${issue.code}:${issue.entryKey}`}>{issue.message}</span>
              ))}
            </div>
          ) : null}

          {/* 冲突决策独立于普通计划列表，所有冲突都保持可见并要求用户显式选择。 */}
          {conflicts.length > 0 ? (
            <div className="annotation-merge-conflicts">
              <strong>逐项处理内容冲突</strong>
              {conflicts.map((item) => (
                <div key={item.entryKey} className="annotation-merge-conflict-row">
                  <span>
                    <strong>{item.label || item.identity}</strong>
                    <small>{DOMAIN_LABELS[item.domain]}</small>
                  </span>
                  <div role="group" aria-label={`${item.label}冲突处理`}>
                    <ConflictChoice
                      selected={props.conflictResolutions[item.entryKey] === "take-source"}
                      label="采用来源"
                      onClick={() => props.onResolveConflict(item.entryKey, "take-source")}
                    />
                    <ConflictChoice
                      selected={props.conflictResolutions[item.entryKey] === "keep-target"}
                      label="保留目标"
                      onClick={() => props.onResolveConflict(item.entryKey, "keep-target")}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="annotation-merge-item-list">
            {visibleItems.map((item) => (
              <MergePlanItem key={item.entryKey} item={item} />
            ))}
          </div>
          {visibleItems.length < nonConflictItemCount ? (
            <button
              type="button"
              className="annotation-merge-show-more"
              onClick={() => setVisibleItemLimit((current) =>
                Math.min(nonConflictItemCount, current + VISIBLE_ITEM_STEP))}
            >
              再显示 {Math.min(
                VISIBLE_ITEM_STEP,
                nonConflictItemCount - visibleItems.length,
              )} 项
            </button>
          ) : null}

          <p className="annotation-merge-readonly-note">
            准备后将打开目标编辑器；在编辑器再次确认前，不会修改文档历史或保存服务端修订。
          </p>

          {/* 准备按钮只建立会话草稿；结构问题或未决冲突都会使用纯状态统一阻断。 */}
          {props.preparationError ? (
            <p className="annotation-merge-preparation-error" role="alert">
              <AlertTriangle size={14} /> {props.preparationError}
            </p>
          ) : null}
          <button
            type="button"
            className="annotation-merge-prepare"
            disabled={!props.preparationState.canPrepare || props.preparing}
            onClick={props.onPrepare}
          >
            <GitMerge size={14} />
            {props.preparing ? "正在复核最新文件…" : "准备整合草稿"}
          </button>
        </>
      )}
    </section>
  );
}

// 二选一冲突控件使用显式 pressed 状态，不以按钮位置暗示当前决定。
function ConflictChoice(props: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.selected ? "selected" : ""}
      aria-pressed={props.selected}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

// 方向按钮使用稳定三行布局，长文件名只在最下行省略，不挤压命令文字。
function DirectionButton(props: {
  selected: boolean;
  sideLabel: string;
  commandLabel: string;
  sourceName: string;
  targetName: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.selected ? "selected" : ""}
      aria-pressed={props.selected}
      onClick={props.onClick}
      title={`${props.sourceName} 整合到 ${props.targetName}`}
    >
      <span>{props.sideLabel}</span>
      <strong>{props.commandLabel}</strong>
      <small>{props.sourceName} → {props.targetName}</small>
    </button>
  );
}

// 单项行用角色和目标动作解释计划来源，不暴露内部对象或完整标注内容。
function MergePlanItem(props: { item: AnnotationMergePlanItem }) {
  return (
    <div className={`annotation-merge-item role-${props.item.role} action-${props.item.action}`}>
      <span className="annotation-merge-item-icon" aria-hidden="true">
        <MergeActionIcon action={props.item.action} />
      </span>
      <span>
        <strong title={props.item.label}>{props.item.label || props.item.identity}</strong>
        <small>{DOMAIN_LABELS[props.item.domain]} · {props.item.role === "selected" ? "用户选择" : "自动依赖"}</small>
      </span>
      <em>{formatMergeAction(props.item.action)}</em>
      {props.item.requiredBy.length > 0 ? (
        <small>被 {props.item.requiredBy.length} 项引用</small>
      ) : <small />}
    </div>
  );
}

// 目标动作图标只编码计划器已经判定的动作，不在展示层重新解释冲突。
function MergeActionIcon(props: { action: AnnotationMergePlanItem["action"] }) {
  if (props.action === "add") return <Plus size={13} />;
  if (props.action === "replace-conflict") return <AlertTriangle size={13} />;
  return <CircleEqual size={13} />;
}

// 动作文案与计划器枚举保持一一对应，供预检列表稳定展示。
function formatMergeAction(action: AnnotationMergePlanItem["action"]) {
  if (action === "add") return "加入目标";
  if (action === "replace-conflict") return "待决冲突";
  return "目标已相同";
}
