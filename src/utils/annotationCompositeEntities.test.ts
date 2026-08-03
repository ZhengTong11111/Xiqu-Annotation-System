import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import type { BanyanMark, GongcheSymbol, ProjectData } from "../types";
import {
  repairBanyanGongcheReferences,
  validateBanyanGongcheReferences,
} from "./banyanReferenceIntegrity";
import {
  reconcileGongcheSymbolLabels,
  redistributeGongcheSymbolSequence,
} from "./gongcheSymbols";

function createMark(overrides: Partial<BanyanMark> = {}): BanyanMark {
  return {
    id: "mark-reference",
    time: 1,
    estimatedTime: 1,
    sourceSymbol: "1",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    attachment: "on_note",
    linkedGongcheAnnotationId: "block-reference",
    linkedGongcheSymbolId: "symbol-a",
    linkedGongcheSymbolIds: ["symbol-a", "symbol-b"],
    confidence: "auto",
    ...overrides,
  };
}

function createReferenceProject(): ProjectData {
  const project = structuredClone(mockProject);
  const character = project.characterAnnotations[0];
  if (!character) throw new Error("mockProject 缺少逐字夹具。");
  project.gongcheAnnotations = [{
    id: "block-reference",
    parentTrackId: "character-track",
    parentBlockId: character.id,
    startTime: 0,
    endTime: 2,
    symbols: ["symbol-a", "symbol-b"].map((id, index): GongcheSymbol => ({
      id,
      label: index === 0 ? "上" : "尺",
      rawText: index === 0 ? "上" : "尺",
      startTime: index,
      endTime: index + 1,
    })),
  }];
  project.banyanMarks = [createMark()];
  return project;
}

test("工尺块或符号删除后保留板眼记录并清除失效强引用", () => {
  const base = createReferenceProject();
  assert.equal(validateBanyanGongcheReferences(base), true);

  const symbolDeleted = structuredClone(base);
  symbolDeleted.gongcheAnnotations[0].symbols = symbolDeleted.gongcheAnnotations[0].symbols.slice(1);
  const repairedSymbol = repairBanyanGongcheReferences(symbolDeleted);
  assert.deepEqual(repairedSymbol.changedMarkIds, ["mark-reference"]);
  assert.equal(repairedSymbol.project.banyanMarks[0].linkedGongcheSymbolId, null);
  assert.deepEqual(repairedSymbol.project.banyanMarks[0].linkedGongcheSymbolIds, ["symbol-b"]);
  assert.equal(repairedSymbol.project.banyanMarks[0].orphaned, true);
  assert.equal(validateBanyanGongcheReferences(repairedSymbol.project), true);

  const blockDeleted = structuredClone(base);
  blockDeleted.gongcheAnnotations = [];
  const repairedBlock = repairBanyanGongcheReferences(blockDeleted);
  assert.equal(repairedBlock.project.banyanMarks[0].linkedGongcheAnnotationId, null);
  assert.deepEqual(repairedBlock.project.banyanMarks[0].linkedGongcheSymbolIds, []);
  assert.equal(validateBanyanGongcheReferences(repairedBlock.project), true);
});

test("工尺快速输入与重新分配保持既有符号稳定 id 和附加元数据", () => {
  const existing: GongcheSymbol[] = [
    { id: "stable-a", label: "上", notation: "1/", rawText: "上1/", startTime: 0, endTime: 1 },
    { id: "stable-b", label: "尺", notation: "2/", rawText: "尺2/", startTime: 1, endTime: 2 },
  ];
  const reconciled = reconcileGongcheSymbolLabels(existing, ["工", "尺", "六"], 0, 3);
  assert.deepEqual(reconciled.map((symbol) => symbol.id).slice(0, 2), ["stable-a", "stable-b"]);
  assert.equal(reconciled[0].notation, "1/");
  assert.equal(reconciled[2].id === "stable-a" || reconciled[2].id === "stable-b", false);

  const redistributed = redistributeGongcheSymbolSequence(reconciled, 3, 6);
  assert.deepEqual(redistributed.map((symbol) => symbol.id), reconciled.map((symbol) => symbol.id));
  assert.deepEqual(redistributed.map((symbol) => [symbol.startTime, symbol.endTime]), [[3, 4], [4, 5], [5, 6]]);
});
