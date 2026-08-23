import { BadgeCheck, Eye, MinusCircle, Pencil } from "lucide-react";
import type {
  ResourceCapability,
  ResourceType,
} from "@xiqu/shared";
import {
  canDelegateResourcePermissionPreset,
  canDelegateResourceReviewChange,
  supportsResourceReviewAddon,
  type ResourcePermissionPreset,
  type ResourcePermissionPresetMatch,
} from "./resourcePermissionPresets";

// 三档可见文案和图标只在一个展示组件中维护，实际 capability 映射继续归纯 preset helper 所有。
const SIMPLE_PERMISSION_OPTIONS = [
  {
    preset: "none",
    label: "不额外授权",
    description: "角色或父目录权限仍有效",
    icon: MinusCircle,
  },
  {
    preset: "view",
    label: "仅查看",
    description: "查看、播放与下载",
    icon: Eye,
  },
  {
    preset: "edit",
    label: "可编辑",
    description: "编辑、下载及文件操作",
    icon: Pencil,
  },
] as const;

type Props = {
  name: string;
  ariaLabel: string;
  value: ResourcePermissionPresetMatch;
  canReview: boolean;
  existingCanReview?: boolean;
  resourceType: ResourceType;
  actorCapabilities?: readonly ResourceCapability[];
  disabled?: boolean;
  onChange: (preset: ResourcePermissionPreset) => void;
  onReviewChange: (canReview: boolean) => void;
};

// 该组件只负责“基础三选一 + 审核附加项”的受控展示，不保存 ACL 或推断最终有效权限。
export function ResourcePermissionPresetSelector(props: Props) {
  const reviewSupported = supportsResourceReviewAddon(props.resourceType);
  const nextReviewValue = !props.canReview;
  const reviewDelegatable = props.actorCapabilities
    ? canDelegateResourceReviewChange(
        props.actorCapabilities,
        props.existingCanReview ?? props.canReview,
        nextReviewValue,
      )
    : true;
  const reviewDisabled = Boolean(props.disabled) ||
    props.value === "custom" ||
    !reviewSupported ||
    !reviewDelegatable;

  return (
    <div className="resource-simple-permission-selector">
      <span className="resource-permission-group-label">基础权限</span>
      <div className="resource-permission-presets" role="radiogroup" aria-label={props.ariaLabel}>
        {SIMPLE_PERMISSION_OPTIONS.map((option) => {
          const Icon = option.icon;
          const delegatable = props.actorCapabilities
            ? canDelegateResourcePermissionPreset(
                props.actorCapabilities,
                option.preset,
                props.resourceType,
              )
            : true;
          const optionDisabled = Boolean(props.disabled) || !delegatable;
          return (
            <label
              key={option.preset}
              className={[
                "resource-permission-preset",
                props.value === option.preset ? "selected" : "",
                optionDisabled ? "disabled" : "",
              ].filter(Boolean).join(" ")}
              title={!delegatable
                ? "你不能授予自己并不拥有的完整权限预设"
                : undefined}
            >
              <input
                type="radio"
                name={props.name}
                value={option.preset}
                checked={props.value === option.preset}
                disabled={optionDisabled}
                onChange={() => props.onChange(option.preset)}
              />
              <Icon size={16} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>

      {/* 审核保持独立 checkbox；custom 未经明确基础预设覆盖时不允许在极简模式局部改写。 */}
      <span className="resource-permission-group-label addon">附加权限</span>
      <label
        className={[
          "resource-permission-review-addon",
          props.canReview ? "selected" : "",
          reviewDisabled ? "disabled" : "",
        ].filter(Boolean).join(" ")}
        title={getReviewDisabledReason({
          custom: props.value === "custom",
          reviewSupported,
          reviewDelegatable,
        })}
      >
        <input
          type="checkbox"
          checked={props.canReview}
          disabled={reviewDisabled}
          onChange={(event) => props.onReviewChange(event.target.checked)}
        />
        <BadgeCheck size={17} />
        <span>
          <strong>可审核</strong>
          <small>{reviewSupported
            ? "允许确认或评论标注范围；同时需要查看权限"
            : "媒体资源没有标注审核操作"}</small>
        </span>
      </label>
    </div>
  );
}

function getReviewDisabledReason(input: {
  custom: boolean;
  reviewSupported: boolean;
  reviewDelegatable: boolean;
}): string | undefined {
  if (!input.reviewSupported) return "媒体资源不适用审核权限";
  if (input.custom) return "请先选择一个基础权限预设，或在详细模式中编辑";
  if (!input.reviewDelegatable) return "你不能新增自己并不拥有的审核能力";
  return undefined;
}
