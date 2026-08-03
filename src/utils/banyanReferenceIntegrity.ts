import type { ProjectData } from "../types";

export type BanyanReferenceRepairResult = {
  project: ProjectData;
  changedMarkIds: string[];
};

// 板眼与工尺构成跨集合强引用；所有命令适配器都应复用这里的最终态校验，避免各自解释引用规则。
export function validateBanyanGongcheReferences(project: ProjectData) {
  const sectionIds = new Set(project.banyanSections.map((section) => section.id));
  const markIds = new Set(project.banyanMarks.map((mark) => mark.id));
  if (sectionIds.size !== project.banyanSections.length || markIds.size !== project.banyanMarks.length) return false;

  const gongcheBlocks = new Map<string, Set<string>>();
  for (const block of project.gongcheAnnotations) {
    if (gongcheBlocks.has(block.id)) return false;
    const symbolIds = new Set(block.symbols.map((symbol) => symbol.id));
    if (symbolIds.size !== block.symbols.length) return false;
    gongcheBlocks.set(block.id, symbolIds);
  }

  return project.banyanMarks.every((mark) => {
    if (mark.sectionId && !sectionIds.has(mark.sectionId)) return false;
    if (!mark.linkedGongcheAnnotationId) {
      return !mark.linkedGongcheSymbolId && (mark.linkedGongcheSymbolIds?.length ?? 0) === 0;
    }
    const symbolIds = gongcheBlocks.get(mark.linkedGongcheAnnotationId);
    if (!symbolIds) return false;
    return (!mark.linkedGongcheSymbolId || symbolIds.has(mark.linkedGongcheSymbolId)) &&
      (mark.linkedGongcheSymbolIds ?? []).every((symbolId) => symbolIds.has(symbolId));
  });
}

// 工尺删除后保留板眼研究记录，但断开所有失效强引用并显式标记为孤立，禁止保存悬空 id。
export function repairBanyanGongcheReferences(project: ProjectData): BanyanReferenceRepairResult {
  const blocks = new Map(project.gongcheAnnotations.map((block) => [block.id, block]));
  const changedMarkIds: string[] = [];
  const banyanMarks = project.banyanMarks.map((mark) => {
    if (!mark.linkedGongcheAnnotationId) return mark;
    const block = blocks.get(mark.linkedGongcheAnnotationId);
    if (!block) {
      changedMarkIds.push(mark.id);
      return {
        ...mark,
        linkedGongcheAnnotationId: null,
        linkedGongcheSymbolId: null,
        ...(mark.linkedGongcheSymbolIds === undefined ? {} : { linkedGongcheSymbolIds: [] }),
        orphaned: true,
      };
    }

    const validSymbolIds = new Set(block.symbols.map((symbol) => symbol.id));
    const nextSingle = mark.linkedGongcheSymbolId && validSymbolIds.has(mark.linkedGongcheSymbolId)
      ? mark.linkedGongcheSymbolId
      : null;
    const nextMany = mark.linkedGongcheSymbolIds?.filter((id) => validSymbolIds.has(id));
    const singleChanged = nextSingle !== (mark.linkedGongcheSymbolId ?? null);
    const manyChanged = nextMany !== undefined && nextMany.length !== mark.linkedGongcheSymbolIds?.length;
    if (!singleChanged && !manyChanged) return mark;
    changedMarkIds.push(mark.id);
    return {
      ...mark,
      linkedGongcheSymbolId: nextSingle,
      ...(nextMany === undefined ? {} : { linkedGongcheSymbolIds: nextMany }),
      orphaned: true,
    };
  });
  return changedMarkIds.length === 0
    ? { project, changedMarkIds }
    : { project: { ...project, banyanMarks }, changedMarkIds };
}
