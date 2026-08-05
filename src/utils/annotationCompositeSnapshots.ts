// 工尺与板眼复合快照必须由 lifecycle/state 共用同一实现，旧路径只做窄转发。
export {
  createBanyanMarkSnapshot,
  createBanyanSectionSnapshot,
  createGongcheSymbolSnapshot,
  restoreBanyanMarkSnapshot,
  restoreBanyanSectionSnapshot,
  restoreGongcheSymbolSnapshot,
} from "@xiqu/document-model";
