import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeMediaAnalysisTileBatch,
  encodeMediaAnalysisTileBatchHeader,
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
} from "../dist/index.js";

function buildBatch(entries, chunks) {
  const header = encodeMediaAnalysisTileBatchHeader(entries);
  const output = new Uint8Array(
    header.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  output.set(header, 0);
  let offset = header.byteLength;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

test("媒体分析批次按 manifest 顺序往返多个原始瓦片", () => {
  const chunks = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])];
  const decoded = decodeMediaAnalysisTileBatch(buildBatch([
    { id: "asset-a", byteLength: chunks[0].byteLength },
    { id: "asset-b", byteLength: chunks[1].byteLength },
  ], chunks));
  assert.deepEqual([...decoded.keys()], ["asset-a", "asset-b"]);
  assert.deepEqual([...decoded.get("asset-a")], [1, 2, 3]);
  assert.deepEqual([...decoded.get("asset-b")], [4, 5]);
});

test("媒体分析批次拒绝空列表、重复 ID 和数量越界", () => {
  assert.throws(() => encodeMediaAnalysisTileBatchHeader([]), /数量/);
  assert.throws(() => encodeMediaAnalysisTileBatchHeader([
    { id: "same", byteLength: 1 },
    { id: "same", byteLength: 1 },
  ]), /重复/);
  assert.throws(() => encodeMediaAnalysisTileBatchHeader(
    Array.from({ length: MAX_MEDIA_ANALYSIS_BATCH_ASSETS + 1 }, (_, index) => ({
      id: `asset-${index}`,
      byteLength: 1,
    })),
  ), /数量/);
});

test("媒体分析批次拒绝截断、尾随字节和未知版本", () => {
  const valid = buildBatch([{ id: "asset-a", byteLength: 2 }], [Uint8Array.from([1, 2])]);
  assert.throws(() => decodeMediaAnalysisTileBatch(valid.subarray(0, valid.length - 1)), /越界/);

  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  assert.throws(() => decodeMediaAnalysisTileBatch(trailing), /未声明/);

  const unknownVersion = valid.slice();
  const manifestLength = new DataView(unknownVersion.buffer).getUint32(8, true);
  const manifest = JSON.parse(new TextDecoder().decode(unknownVersion.subarray(12, 12 + manifestLength)));
  manifest.version = 2;
  const replacement = new TextEncoder().encode(JSON.stringify(manifest));
  assert.equal(replacement.byteLength, manifestLength);
  unknownVersion.set(replacement, 12);
  assert.throws(() => decodeMediaAnalysisTileBatch(unknownVersion), /批次头/);
});
