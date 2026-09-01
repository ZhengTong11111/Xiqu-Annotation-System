// Web 层只复用共享 document-model 的领域算法，不维护第二套平均分配规则。
export {
  resetSentenceCharactersToEvenTiming,
  type SentenceCharacterTimingResetIssue,
  type SentenceCharacterTimingResetResult,
} from "@xiqu/document-model";
