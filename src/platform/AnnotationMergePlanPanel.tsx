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
  leftFileName: string;
  rightFileName: string;
  selectedEntryCount: number;
  plan: AnnotationMergePlan;
  onDirectionChange: (direction: AnnotationMergeDirection) => void;
  onClearSelection: () => void;
}) {
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEMS);
  const visibleItems = useMemo(() =>
    props.plan.items.slice(0, visibleItemLimit),
  [props.plan.items, visibleItemLimit]);

  // 每次方向或选择生成新计划时收起长列表，避免旧的展开量拖慢新的预检。
  useEffect(() => {
    setVisibleItemLimit(INITIAL_VISIBLE_ITEMS);
  }, [props.direction, props.selectedEntryCount]);

  return (
    <section className="annotation-merge-plan" aria-labelledby="annotation-merge-plan-title">
      {/* 标题区明确标记只读属性，避免用户把预检误认为已经写入目标文件。 */}
      <header className="annotation-merge-plan-header">
        <span>
          <GitMerge size={16} />
          <strong id="annotation-merge-plan-title">选择性整合预检</strong>
          <small>只读</small>
        </span>
        {props.selectedEntryCount > 0 ? (
          <button type="button" onClick={props.onClearSelection}>
            <Trash2 size={13} /> 清空选择
          </button>
        ) : null}
      </header>

      {/* 分段控件同时写明来源和目标文件，箭头不作为唯一方向提示。 */}
      <div className="annotation-merge-direction" role="group" aria-label="整合方向">
        <DirectionButton
          selected={props.direction === "left-to-right"}
          sideLabel="左侧"
          commandLabel="整合到右侧"
          sourceName={props.leftFileName}
          targetName={props.rightFileName}
          onClick={() => props.onDirectionChange("left-to-right")}
        />
        <DirectionButton
          selected={props.direction === "right-to-left"}
          sideLabel="右侧"
          commandLabel="整合到左侧"
          sourceName={props.rightFileName}
          targetName={props.leftFileName}
          onClick={() => props.onDirectionChange("right-to-left")}
        />
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

          {/* 结构 issue 会阻断后续应用，但本阶段不渲染任何执行按钮。 */}
          {props.plan.issues.length > 0 ? (
            <div className="annotation-merge-issues" role="alert">
              <strong><AlertTriangle size={14} /> 发现 {props.plan.issues.length} 个结构问题</strong>
              {props.plan.issues.map((issue) => (
                <span key={`${issue.code}:${issue.entryKey}`}>{issue.message}</span>
              ))}
            </div>
          ) : null}

          <div className="annotation-merge-item-list">
            {visibleItems.map((item) => (
              <MergePlanItem key={item.entryKey} item={item} />
            ))}
          </div>
          {visibleItems.length < props.plan.items.length ? (
            <button
              type="button"
              className="annotation-merge-show-more"
              onClick={() => setVisibleItemLimit((current) =>
                Math.min(props.plan.items.length, current + VISIBLE_ITEM_STEP))}
            >
              再显示 {Math.min(
                VISIBLE_ITEM_STEP,
                props.plan.items.length - visibleItems.length,
              )} 项
            </button>
          ) : null}

          <p className="annotation-merge-readonly-note">
            {props.plan.counts.conflicts > 0
              ? "目标已有不同内容；本阶段仅标出冲突，尚未选择保留目标或采用来源。"
              : "预检未发现内容冲突。"}
            当前不会修改、保存或创建左右文件的新修订。
          </p>
        </>
      )}
    </section>
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
