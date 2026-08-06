import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  type MediaAnalysisAssetDescriptor,
} from "@xiqu/shared";
import {
  buildAdjacentPlatformAnalysisWindows,
  buildPlatformAnalysisRequestWindow,
  cancelPlatformAnalysisBatchesOutsideRetainedAssets,
  partitionMediaAnalysisAssetBatches,
  PlatformMediaAnalysisAssetCache,
  selectContiguousLoadedAnalysisAssets,
  type PlatformMediaAnalysisBatchRegistry,
} from "./platformMediaAnalysisLoading";

test("分析请求窗口按 30 秒边界量化并保留来源偏移", () => {
  assert.deepEqual(
    buildPlatformAnalysisRequestWindow({ startTime: 95, endTime: 145, zoom: 20 }, 5),
    { startTime: 60, endTime: 180, waveformLevel: 2 },
  );
  assert.deepEqual(
    buildPlatformAnalysisRequestWindow({ startTime: 96, endTime: 146, zoom: 20 }, 5),
    { startTime: 60, endTime: 180, waveformLevel: 2 },
  );
});

test("分析资产批次同时遵守数量和总字节边界", () => {
  const descriptors = Array.from(
    { length: MAX_MEDIA_ANALYSIS_BATCH_ASSETS + 1 },
    (_, index) => descriptor(`asset-${index}`, 1),
  );
  assert.deepEqual(
    partitionMediaAnalysisAssetBatches(descriptors).map((batch) => batch.length),
    [MAX_MEDIA_ANALYSIS_BATCH_ASSETS, 1],
  );
  assert.deepEqual(
    partitionMediaAnalysisAssetBatches([
      descriptor("large-a", 20 * 1024 * 1024),
      descriptor("large-b", 20 * 1024 * 1024),
    ]).map((batch) => batch.length),
    [1, 1],
  );
  assert.deepEqual(
    partitionMediaAnalysisAssetBatches([
      descriptor("small-a", 4),
      descriptor("small-b", 4),
      descriptor("small-c", 4),
    ], { maxBytes: 8 }).map((batch) => batch.length),
    [2, 1],
  );
});

test("不同分析序列拆成独立批次让轻量波形先完成", () => {
  const waveform = descriptor("waveform", 1);
  const spectrogram = { ...descriptor("spectrogram", 1), kind: "spectrogram" as const };
  const pitch = { ...descriptor("pitch", 1), kind: "pitch" as const, preset: "yin-v1" };
  assert.deepEqual(
    partitionMediaAnalysisAssetBatches([waveform, spectrogram, pitch])
      .map((batch) => batch.map(({ id }) => id)),
    [["waveform"], ["spectrogram"], ["pitch"]],
  );
});

test("相邻预取窗口不重复当前范围且不会越过零点", () => {
  assert.deepEqual(
    buildAdjacentPlatformAnalysisWindows({ startTime: 60, endTime: 180, waveformLevel: 2 }),
    [
      { startTime: 0, endTime: 60, waveformLevel: 2 },
      { startTime: 180, endTime: 300, waveformLevel: 2 },
    ],
  );
});

test("快速跳转只取消与保留资产集合完全无交集的批次", () => {
  const retainedController = new AbortController();
  const obsoleteController = new AbortController();
  const registry: PlatformMediaAnalysisBatchRegistry = new Map([
    [Symbol("retained"), {
      controller: retainedController,
      assetIds: new Set(["shared", "old"]),
    }],
    [Symbol("obsolete"), {
      controller: obsoleteController,
      assetIds: new Set(["obsolete"]),
    }],
  ]);
  assert.equal(cancelPlatformAnalysisBatchesOutsideRetainedAssets(registry, new Set(["shared"])), 1);
  assert.equal(retainedController.signal.aborted, false);
  assert.equal(obsoleteController.signal.aborted, true);
});

test("渐进显示只选择从窗口起点开始的连续已加载前缀", () => {
  const descriptors = [0, 1, 2].map((tileIndex) => ({
    ...descriptor(`asset-${tileIndex}`, 1),
    tileIndex,
    startTime: tileIndex * 30,
    endTime: (tileIndex + 1) * 30,
  }));
  assert.deepEqual(
    selectContiguousLoadedAnalysisAssets(
      descriptors,
      new Map([
        ["asset-0", Uint8Array.of(0)],
        ["asset-2", Uint8Array.of(2)],
      ]),
    ).map(({ id }) => id),
    ["asset-0"],
  );
});

test("分析资产缓存按真实访问顺序淘汰并遵守字节预算", () => {
  const cache = new PlatformMediaAnalysisAssetCache(3, 6);
  cache.set("a", Uint8Array.from([1, 1]));
  cache.set("b", Uint8Array.from([2, 2]));
  cache.set("c", Uint8Array.from([3, 3]));
  assert.ok(cache.get("a"));
  cache.set("d", Uint8Array.from([4, 4]));
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual([...cache.get("a") ?? []], [1, 1]);
  assert.equal(cache.size, 3);
  assert.equal(cache.byteLength, 6);

  cache.set("oversized", new Uint8Array(7));
  assert.equal(cache.get("oversized"), undefined);
  assert.equal(cache.byteLength, 6);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.byteLength, 0);
});

function descriptor(id: string, size: number): MediaAnalysisAssetDescriptor {
  return {
    id,
    kind: "waveform",
    preset: "default",
    level: 0,
    tileIndex: 0,
    startTime: 0,
    endTime: 30,
    mimeType: "application/vnd.xiqu.waveform-tile",
    size,
  };
}
