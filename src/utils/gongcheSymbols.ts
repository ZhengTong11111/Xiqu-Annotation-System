import type { GongcheSymbol } from "../types";
import { createRuntimeUuid } from "./runtimeUuid";

// 快速输入按索引复用已有符号身份；只有新增尾项生成新 id，避免每次键入破坏板眼稳定引用。
export function reconcileGongcheSymbolLabels(
  existing: readonly GongcheSymbol[],
  labels: readonly string[],
  startTime: number,
  endTime: number,
): GongcheSymbol[] {
  const normalized = labels.map((label) => label.trim()).filter(Boolean);
  const safeLabels = normalized.length > 0 ? normalized : ["合"];
  const symbols = safeLabels.map((label, index): GongcheSymbol => {
    const current = existing[index];
    const notation = current?.notation ?? "";
    const parenthesized = current?.parenthesized ?? false;
    return {
      id: current?.id ?? `gongche-symbol-${createRuntimeUuid()}`,
      label,
      notation,
      rawText: `${parenthesized ? `（${label}）` : label}${notation}`,
      parenthesized,
      startTime,
      endTime,
      assetUrl: current?.assetUrl ?? null,
    };
  });
  return redistributeGongcheSymbolSequence(symbols, startTime, endTime);
}

// 添加/删除时调用者先保留所需对象，本函数只重排时间，不重新分配稳定 id 或附加信息。
export function redistributeGongcheSymbolSequence(
  symbols: readonly GongcheSymbol[],
  startTime: number,
  endTime: number,
): GongcheSymbol[] {
  const safeSymbols = symbols.length > 0 ? symbols : [{
    id: `gongche-symbol-${createRuntimeUuid()}`,
    label: "合",
    notation: "",
    rawText: "合",
    parenthesized: false,
    startTime,
    endTime,
    assetUrl: null,
  }];
  const duration = Math.max(endTime - startTime, 0.001);
  const step = duration / safeSymbols.length;
  return safeSymbols.map((symbol, index) => ({
    ...symbol,
    startTime: startTime + step * index,
    endTime: index === safeSymbols.length - 1 ? endTime : startTime + step * (index + 1),
  }));
}

export function createDefaultGongcheSymbol(startTime: number, endTime: number): GongcheSymbol {
  return {
    id: `gongche-symbol-${createRuntimeUuid()}`,
    label: "合",
    notation: "",
    rawText: "合",
    parenthesized: false,
    startTime,
    endTime,
    assetUrl: null,
  };
}
