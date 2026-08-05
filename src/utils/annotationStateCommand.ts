// 复合状态 builder/resolver/writer 由共享领域包统一实现，旧路径仅维持现有调用兼容。
export {
  applyAnnotationStateItems,
  buildProjectAnnotationStateCommand,
  buildProjectAnnotationStateEnvelope,
  resolveProjectAnnotationState,
} from "@xiqu/document-model";
export type { AnnotationStateTarget } from "@xiqu/document-model";
