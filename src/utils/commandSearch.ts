import type { CommandDefinition } from "./commandCatalog";
import { buildPinyinIndex } from "./pinyin";

// 顶栏「搜索」菜单的匹配与排序算法。中文标注内容按字符处理，因此这里不做分词，
// 直接用子串匹配；normalize 只负责大小写和全角/半角归一，服务英文缩写（loop、f0、stft）。

export type CommandMatchField = "label" | "keyword" | "pinyin" | "path";

export type CommandMatch<T extends CommandDefinition = CommandDefinition> = {
  item: T;
  score: number;
  // 命中来源用于调试和潜在的结果分组展示，不参与排序以外的逻辑。
  matchedField: CommandMatchField;
};

const DEFAULT_RESULT_LIMIT = 40;
// 纯英文数字的查询才尝试拼音匹配；中文查询走原有子串匹配，完全不付出转换开销。
const LATIN_QUERY_PATTERN = /^[a-z0-9]+$/u;

// 归一化保持保守：只做 NFKC + 去空白 + 小写，不改变中文字符本身，避免破坏子串语义。
export function normalizeCommandQuery(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

// 单条命令的打分：标题命中权重最高，其次关键词，最后才是面包屑路径。
// 返回 null 表示未命中，调用方据此过滤。
function scoreCommand(
  definition: CommandDefinition,
  query: string,
): { score: number; matchedField: CommandMatchField } | null {
  const label = normalizeCommandQuery(definition.label);
  if (label === query) {
    return { score: 100, matchedField: "label" };
  }
  if (label.startsWith(query)) {
    return { score: 80, matchedField: "label" };
  }
  if (label.includes(query)) {
    return { score: 60, matchedField: "label" };
  }

  // 关键词命中：完全相等比子串更可信，用来把「loop」这类缩写顶到子串命中之上。
  let keywordScore = 0;
  for (const keyword of definition.keywords) {
    const normalized = normalizeCommandQuery(keyword);
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      keywordScore = Math.max(keywordScore, 45);
    } else if (normalized.includes(query)) {
      keywordScore = Math.max(keywordScore, 40);
    }
  }
  if (keywordScore > 0) {
    return { score: keywordScore, matchedField: "keyword" };
  }

  // 拼音命中排在关键词之后、路径之前：它是「不切输入法也能搜到」的兜底，
  // 但不应盖过显式登记的关键词。全拼优先于首字母，前缀优先于子串。
  if (LATIN_QUERY_PATTERN.test(query)) {
    const index = buildPinyinIndex([...definition.path, definition.label].join(""));
    if (index) {
      if (index.full.startsWith(query)) {
        return { score: 35, matchedField: "pinyin" };
      }
      if (index.initials.startsWith(query)) {
        return { score: 33, matchedField: "pinyin" };
      }
      if (index.full.includes(query)) {
        return { score: 31, matchedField: "pinyin" };
      }
      if (index.initials.includes(query)) {
        return { score: 29, matchedField: "pinyin" };
      }
    }
  }

  // 路径命中排在最后：搜「视图」应当能列出该菜单下所有项，但不该盖过标题精确匹配。
  for (const segment of definition.path) {
    if (normalizeCommandQuery(segment).includes(query)) {
      return { score: 25, matchedField: "path" };
    }
  }
  return null;
}

// 同分时的稳定次序：路径浅的更接近顶层入口，标题短的更可能是用户真正要找的那个；
// 最后用 id 兜底，保证不同浏览器上的排序完全一致。
function compareMatches(a: CommandMatch, b: CommandMatch) {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.item.path.length !== b.item.path.length) {
    return a.item.path.length - b.item.path.length;
  }
  if (a.item.label.length !== b.item.label.length) {
    return a.item.label.length - b.item.label.length;
  }
  return a.item.id.localeCompare(b.item.id);
}

// 搜索入口。空查询返回 featured 条目，让用户刚打开面板就能看到常用功能而不是空白。
export function searchCommands<T extends CommandDefinition>(
  definitions: T[],
  query: string,
  limit: number = DEFAULT_RESULT_LIMIT,
): CommandMatch<T>[] {
  const normalized = normalizeCommandQuery(query);
  if (!normalized) {
    return definitions
      .filter((definition) => definition.featured)
      .slice(0, limit)
      .map((item) => ({ item, score: 0, matchedField: "label" as const }));
  }

  const matches: CommandMatch<T>[] = [];
  for (const definition of definitions) {
    const scored = scoreCommand(definition, normalized);
    if (scored) {
      matches.push({ item: definition, score: scored.score, matchedField: scored.matchedField });
    }
  }
  matches.sort(compareMatches);
  return matches.slice(0, limit);
}
