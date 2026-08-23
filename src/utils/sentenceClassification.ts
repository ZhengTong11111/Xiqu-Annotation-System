import type {
  SentenceAnnotationConfig,
  SentenceDeliveryMode,
  SubtitleLine,
} from "../types";

export type SentenceClassificationIssue = "delivery_mode_missing" | "role_type_missing" | "role_type_invalid";

export const SENTENCE_DELIVERY_MODE_OPTIONS: ReadonlyArray<{
  value: SentenceDeliveryMode;
  label: string;
}> = [
  { value: "spoken", label: "念白" },
  { value: "sung", label: "唱" },
];

export function getSentenceDeliveryModeLabel(value: SentenceDeliveryMode | null) {
  return SENTENCE_DELIVERY_MODE_OPTIONS.find((option) => option.value === value)?.label ?? "未选择";
}

// 完成度由唯一纯函数判定，列表、时间轴和属性面板不能各自复制一套宽松规则。
export function getSentenceClassificationIssues(
  line: SubtitleLine,
  config: SentenceAnnotationConfig,
): SentenceClassificationIssue[] {
  const issues: SentenceClassificationIssue[] = [];
  if (line.deliveryMode !== "spoken" && line.deliveryMode !== "sung") {
    issues.push("delivery_mode_missing");
  }
  if (!line.roleType) {
    issues.push("role_type_missing");
  } else if (!config.roleOptions.includes(line.roleType)) {
    issues.push("role_type_invalid");
  }
  return issues;
}

export function isSentenceClassificationComplete(
  line: SubtitleLine,
  config: SentenceAnnotationConfig,
) {
  return getSentenceClassificationIssues(line, config).length === 0;
}
