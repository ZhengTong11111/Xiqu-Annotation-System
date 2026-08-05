// Web 历史提取仍沿用旧路径，但 builder/resolver 的唯一实现由共享领域包负责。
export {
  buildProjectTimelineTimingCommand,
  getGongcheTimingTargetsForParents,
  resolveProjectTimelineTiming,
} from "@xiqu/document-model";
export type { TimelineTimingTarget } from "@xiqu/document-model";
