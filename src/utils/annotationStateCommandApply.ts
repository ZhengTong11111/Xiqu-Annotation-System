// 状态命令原子 apply 的唯一实现位于 document-model；兼容文件只导出公开三态结果。
export { applyAnnotationStateCommandToProject } from "@xiqu/document-model";
export type { AnnotationStateCommandApplyResult } from "@xiqu/document-model";
