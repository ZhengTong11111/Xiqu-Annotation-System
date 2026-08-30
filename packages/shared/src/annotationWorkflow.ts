import type {
  AnnotationWorkflowStatus,
  ResourceCapability,
} from "./platform.js";

export type AnnotationWorkflowTransition =
  | { kind: "unchanged" }
  | { kind: "allowed"; requiredCapability: Extract<ResourceCapability, "write" | "review"> }
  | { kind: "invalid_order" };

/**
 * 文件工作流只允许相邻阶段转换：编辑者负责“是否完成标注”，审核者负责“是否完成审核”。
 * API 与前端共用这一纯合同，界面禁用项不能与服务端真实门禁逐渐漂移。
 */
export function getAnnotationWorkflowTransition(
  current: AnnotationWorkflowStatus,
  target: AnnotationWorkflowStatus,
): AnnotationWorkflowTransition {
  if (current === target) return { kind: "unchanged" };
  if (
    (current === "unannotated" && target === "annotated") ||
    (current === "annotated" && target === "unannotated")
  ) {
    return { kind: "allowed", requiredCapability: "write" };
  }
  if (
    (current === "annotated" && target === "reviewed") ||
    (current === "reviewed" && target === "annotated")
  ) {
    return { kind: "allowed", requiredCapability: "review" };
  }
  return { kind: "invalid_order" };
}
