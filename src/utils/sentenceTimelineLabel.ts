export type SentenceTimelineLabelDetail = "full" | "role" | "text";

const TIMELINE_LABEL_FONT_SIZE = 11;
const TIMELINE_LABEL_HORIZONTAL_CHROME = 22;
const TIMELINE_LABEL_SEPARATOR_WIDTH = 13;

function getTimelineLabelCharacterUnits(character: string) {
  if (/\s/u.test(character)) return 0.35;
  if (/[\u0000-\u007f]/u.test(character)) return 0.58;
  if (/[，。！？、；：“”‘’（）《》【】]/u.test(character)) return 0.72;
  return 1;
}

// 时间轴主要显示中文，但也可能混入数字和拉丁字母；按视觉字宽估算比直接使用字符串长度更稳定。
export function estimateSentenceTimelineTextWidth(text: string) {
  return Array.from(text).reduce(
    (width, character) => width + getTimelineLabelCharacterUnits(character) * TIMELINE_LABEL_FONT_SIZE,
    0,
  );
}

export function resolveSentenceTimelineLabelDetail(input: {
  blockWidth: number;
  sentenceText: string;
  deliveryLabel: string;
  roleLabel: string;
}): SentenceTimelineLabelDetail {
  const availableContentWidth = Math.max(0, input.blockWidth - TIMELINE_LABEL_HORIZONTAL_CHROME);
  const sentenceWidth = estimateSentenceTimelineTextWidth(input.sentenceText);
  const roleWidth = estimateSentenceTimelineTextWidth(input.roleLabel);
  const deliveryWidth = estimateSentenceTimelineTextWidth(input.deliveryLabel);

  // 只有完整句子和全部分类都能放下时才增加元数据；否则先保角色，最后只保留句子。
  if (
    deliveryWidth + roleWidth + sentenceWidth + TIMELINE_LABEL_SEPARATOR_WIDTH * 2 <=
    availableContentWidth
  ) {
    return "full";
  }
  if (roleWidth + sentenceWidth + TIMELINE_LABEL_SEPARATOR_WIDTH <= availableContentWidth) {
    return "role";
  }
  return "text";
}
