// 生命周期 resolver/builder/writer 已迁入共享领域包；旧路径仅维持 App、结构事务和测试兼容。
export {
  applyAnnotationLifecycleItems,
  buildProjectAnnotationLifecycleCommand,
  buildProjectAnnotationLifecycleEnvelope,
  resolveProjectAnnotationLifecycleTarget,
  validateProjectAnnotationReferences,
} from "@xiqu/document-model";
export type { AnnotationLifecycleTarget } from "@xiqu/document-model";
