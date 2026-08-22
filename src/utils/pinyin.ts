import * as TinyPinyinNamespace from "tiny-pinyin";

// tiny-pinyin 是 `module.exports = {}` 形式的 CJS 包。Node ESM 与 Vite 对它的命名导出
// 提升行为不一致（Node 下 namespace 上没有 parse，只有 default），因此在这里做一次互操作回落。
type TinyPinyinApi = {
  parse: (str: string) => { type: 1 | 2 | 3; source: string; target: string }[];
};

const TinyPinyin: TinyPinyinApi =
  (TinyPinyinNamespace as unknown as { default?: TinyPinyinApi }).default ??
  (TinyPinyinNamespace as unknown as TinyPinyinApi);

// 汉字转拼音索引，专供顶栏搜索使用：把中文标题和面包屑折成可用英文字母匹配的两条串，
// 让用户在不切输入法的情况下也能找到功能。tiny-pinyin 只做无声调转换，
// 对搜索匹配来说足够，且 dist 体积很小，不会明显拖累首屏包。

export type PinyinIndex = {
  // 全拼，例如「选中块时更新循环范围」→ xuanzhongkuaishigengxinxunhuanfanwei
  full: string;
  // 首字母，例如同一条 → xzksgxxhfw
  initials: string;
};

const CHINESE_PATTERN = /[一-龥]/u;
// 只保留字母和数字，丢掉空格与标点，避免「播放速度 0.5x」这类混排在匹配时被分隔符打断。
const KEEP_PATTERN = /[^a-z0-9]/gu;

// 命令目录规模有界（静态项 + 每条轨道若干字段），用带上限的 Map 缓存即可；
// 超过上限直接清空，避免长会话里不断新建轨道导致缓存无限增长。
const PINYIN_CACHE = new Map<string, PinyinIndex | null>();
const PINYIN_CACHE_LIMIT = 2000;

// tiny-pinyin 的 token.type：2 表示汉字，其余为原样透传的非汉字片段。
const CHINESE_TOKEN_TYPE = 2;

export function buildPinyinIndex(text: string): PinyinIndex | null {
  const cached = PINYIN_CACHE.get(text);
  if (cached !== undefined) {
    return cached;
  }
  // 纯英文/数字的条目不需要拼音索引，原有的标题与关键词匹配已经覆盖。
  const index = CHINESE_PATTERN.test(text) ? convert(text) : null;
  if (PINYIN_CACHE.size >= PINYIN_CACHE_LIMIT) {
    PINYIN_CACHE.clear();
  }
  PINYIN_CACHE.set(text, index);
  return index;
}

function convert(text: string): PinyinIndex {
  let full = "";
  let initials = "";
  for (const token of TinyPinyin.parse(text)) {
    if (token.type === CHINESE_TOKEN_TYPE) {
      const syllable = token.target.toLowerCase();
      full += syllable;
      initials += syllable.charAt(0);
    } else {
      // 非汉字片段在两条串里都原样保留，使「1x」「F0」等仍可被同一条查询命中。
      const raw = token.source.toLowerCase();
      full += raw;
      initials += raw;
    }
  }
  return {
    full: full.replace(KEEP_PATTERN, ""),
    initials: initials.replace(KEEP_PATTERN, ""),
  };
}
