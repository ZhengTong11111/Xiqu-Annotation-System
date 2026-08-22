import { Eye, MinusCircle, Pencil } from "lucide-react";
import type {
  ResourceCapability,
  ResourceType,
} from "@xiqu/shared";
import {
  canDelegateResourcePermissionPreset,
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
  resourceType: ResourceType;
  actorCapabilities?: readonly ResourceCapability[];
  disabled?: boolean;
  onChange: (preset: ResourcePermissionPreset) => void;
};

// 该组件只负责受控单选展示；它不保存 ACL，也不推断角色、继承、owner 或最终有效权限。
export function ResourcePermissionPresetSelector(props: Props) {
  return (
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
  );
}
