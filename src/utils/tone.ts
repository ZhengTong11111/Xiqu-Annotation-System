import type {
  CharacterAnnotation,
  CharacterToneInfo,
  SubtitleLine,
  ToneBase,
  ToneClass,
  YxlzShangSubtype,
} from "../types";

// 《韵学骊珠》四声阴阳八类的中文标签。
export const TONE_CLASS_LABELS: Record<ToneClass, string> = {
  yin_ping: "阴平",
  yang_ping: "阳平",
  yin_shang: "阴上",
  yang_shang: "阳上",
  yin_qu: "阴去",
  yang_qu: "阳去",
  yin_ru: "阴入",
  yang_ru: "阳入",
};

// 上声在原书的细分标签；阴阳通用在八类系统中落到 yang_shang。
export const YXLZ_SHANG_SUBTYPE_LABELS: Record<YxlzShangSubtype, string> = {
  yin_shang: "阴上",
  yang_shang: "阳上",
  yinyang_tongyong: "阴阳通用",
};

const TONE_CLASS_VALUES: readonly ToneClass[] = [
  "yin_ping",
  "yang_ping",
  "yin_shang",
  "yang_shang",
  "yin_qu",
  "yang_qu",
  "yin_ru",
  "yang_ru",
];

const YXLZ_SHANG_SUBTYPE_VALUES: readonly YxlzShangSubtype[] = [
  "yin_shang",
  "yang_shang",
  "yinyang_tongyong",
];

// 八类按调类（平上去入）拆分，供 isShangToneClass 判定上声使用。
// 舒声（平上去）与入声的区分即由 ToneBase 体现：ru 为入声，其余为舒声。
const TONE_CLASS_BASE: Record<ToneClass, ToneBase> = {
  yin_ping: "ping",
  yang_ping: "ping",
  yin_shang: "shang",
  yang_shang: "shang",
  yin_qu: "qu",
  yang_qu: "qu",
  yin_ru: "ru",
  yang_ru: "ru",
};

export function isToneClass(value: unknown): value is ToneClass {
  return typeof value === "string" && (TONE_CLASS_VALUES as readonly string[]).includes(value);
}

export function isYxlzShangSubtype(value: unknown): value is YxlzShangSubtype {
  return (
    typeof value === "string" &&
    (YXLZ_SHANG_SUBTYPE_VALUES as readonly string[]).includes(value)
  );
}

export function isShangToneClass(toneClass: ToneClass): boolean {
  return TONE_CLASS_BASE[toneClass] === "shang";
}

// 严格校验整块四声信息：toneClass 必须合法；subtype 一旦出现必须合法且只允许在上声。
// 上声缺少 subtype 在此视为合法（由 normalize 补默认值），不当作非法数据。
export function isValidCharacterToneInfo(value: unknown): value is CharacterToneInfo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CharacterToneInfo>;
  if (!isToneClass(candidate.toneClass)) {
    return false;
  }
  if (candidate.yxlzShangSubtype !== undefined) {
    if (!isYxlzShangSubtype(candidate.yxlzShangSubtype)) {
      return false;
    }
    // subtype 只对上声有意义；出现在非上声上是非法组合。
    if (!isShangToneClass(candidate.toneClass)) {
      return false;
    }
  }
  return true;
}

// 单字四声显示标签：上声“阴阳通用”单独显示，其余按八类标签。
// 传入非法数据时返回占位符，避免 UI 直接崩在坏数据上。
export function getCharacterToneLabel(tone: CharacterToneInfo | null | undefined): string {
  if (!tone || !isValidCharacterToneInfo(tone)) {
    return "—";
  }
  if (tone.toneClass === "yang_shang" && tone.yxlzShangSubtype === "yinyang_tongyong") {
    return YXLZ_SHANG_SUBTYPE_LABELS.yinyang_tongyong;
  }
  return TONE_CLASS_LABELS[tone.toneClass];
}

// 上声按原书层级补默认 subtype：阴上补 yin_shang，阳上补 yang_shang。
// 阴阳通用不会走到这里，因为它本身已带 subtype。
function getDefaultShangSubtype(toneClass: ToneClass): YxlzShangSubtype {
  return toneClass === "yin_shang" ? "yin_shang" : "yang_shang";
}

// 把上声归一化为带 subtype 的规范形态，供 normalize 路径复用。
export function normalizeShangSubtype(tone: CharacterToneInfo): CharacterToneInfo {
  if (!isShangToneClass(tone.toneClass)) {
    return tone;
  }
  if (isYxlzShangSubtype(tone.yxlzShangSubtype)) {
    return tone;
  }
  return {
    toneClass: tone.toneClass,
    yxlzShangSubtype: getDefaultShangSubtype(tone.toneClass),
  };
}

// 编辑用下拉选项：把 8 类与上声“阴阳通用”展开成 9 个可选项，再加一个“未标注”。
// 选项的 value 是稳定 key；tone 是选中后要写入逐字块的四声信息（null 表示清除）。
export type ToneSelectOption = {
  value: string;
  label: string;
  tone: CharacterToneInfo | null;
};

export const TONE_SELECT_OPTIONS: readonly ToneSelectOption[] = [
  { value: "", label: "未标注", tone: null },
  { value: "yin_ping", label: "阴平", tone: { toneClass: "yin_ping" } },
  { value: "yang_ping", label: "阳平", tone: { toneClass: "yang_ping" } },
  {
    value: "yin_shang",
    label: "阴上",
    tone: { toneClass: "yin_shang", yxlzShangSubtype: "yin_shang" },
  },
  {
    value: "yang_shang",
    label: "阳上",
    tone: { toneClass: "yang_shang", yxlzShangSubtype: "yang_shang" },
  },
  {
    value: "yinyang_tongyong",
    label: "阴阳通用（上）",
    tone: { toneClass: "yang_shang", yxlzShangSubtype: "yinyang_tongyong" },
  },
  { value: "yin_qu", label: "阴去", tone: { toneClass: "yin_qu" } },
  { value: "yang_qu", label: "阳去", tone: { toneClass: "yang_qu" } },
  { value: "yin_ru", label: "阴入", tone: { toneClass: "yin_ru" } },
  { value: "yang_ru", label: "阳入", tone: { toneClass: "yang_ru" } },
];

// 由当前四声信息反查下拉选项的 value。
// 阴阳通用与普通阳上共用 toneClass "yang_shang"，需要靠 subtype 单独识别。
export function getToneSelectValue(tone: CharacterToneInfo | null | undefined): string {
  if (!tone || !isValidCharacterToneInfo(tone)) {
    return "";
  }
  if (tone.toneClass === "yang_shang" && tone.yxlzShangSubtype === "yinyang_tongyong") {
    return "yinyang_tongyong";
  }
  return tone.toneClass;
}

// 由下拉选项 value 取要写入的四声信息；未知 value 视为清除。
export function getToneInfoForSelectValue(value: string): CharacterToneInfo | null {
  return TONE_SELECT_OPTIONS.find((option) => option.value === value)?.tone ?? null;
}

// 句级四声预览：按时间顺序汇总该句下属逐字块的四声，不复制存储。
// 未标注或非法数据用占位符表示，便于在预览中一眼看出缺口。
export type LineTonePreviewItem = {
  char: string;
  label: string;
  toneClass: ToneClass | null;
};

export function buildLineTonePreview(
  line: SubtitleLine,
  characterAnnotations: CharacterAnnotation[],
): LineTonePreviewItem[] {
  return characterAnnotations
    .filter((character) => character.lineId === line.id)
    .sort((left, right) => left.startTime - right.startTime)
    .map((character) => {
      const tone = character.tone ?? null;
      if (!isValidCharacterToneInfo(tone)) {
        return { char: character.char, label: "—", toneClass: null };
      }
      return {
        char: character.char,
        label: getCharacterToneLabel(tone),
        toneClass: tone.toneClass,
      };
    });
}
