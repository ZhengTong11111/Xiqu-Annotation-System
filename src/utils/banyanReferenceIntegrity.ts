// 板眼到工尺的引用校验/修复已经共享，Web 不得形成第二套断链策略。
export {
  repairBanyanGongcheReferences,
  validateBanyanGongcheReferences,
} from "@xiqu/document-model";
export type { BanyanReferenceRepairResult } from "@xiqu/document-model";
