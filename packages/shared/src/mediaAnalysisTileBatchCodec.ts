const MEDIA_ANALYSIS_TILE_BATCH_MAGIC = "XIQAB001";
const FIXED_HEADER_BYTES = 12;
const MAX_BATCH_HEADER_BYTES = 64 * 1024;

export const MAX_MEDIA_ANALYSIS_BATCH_ASSETS = 48;
export const MAX_MEDIA_ANALYSIS_BATCH_BYTES = 32 * 1024 * 1024;

export type MediaAnalysisTileBatchEntry = {
  id: string;
  byteLength: number;
};

/**
 * API 流式响应只需先生成 manifest 头，后续瓦片可以直接从对象存储依次透传，
 * 不需要为了拼接批次而在服务端保留第二份完整 Buffer。
 */
export function encodeMediaAnalysisTileBatchHeader(
  entries: readonly MediaAnalysisTileBatchEntry[],
) {
  validateEntries(entries);
  const manifestBytes = new TextEncoder().encode(JSON.stringify({
    version: 1,
    entries,
  }));
  if (manifestBytes.byteLength > MAX_BATCH_HEADER_BYTES) {
    throw new Error("媒体分析批次头超过大小上限。");
  }
  const output = new Uint8Array(FIXED_HEADER_BYTES + manifestBytes.byteLength);
  output.set(new TextEncoder().encode(MEDIA_ANALYSIS_TILE_BATCH_MAGIC), 0);
  new DataView(output.buffer).setUint32(8, manifestBytes.byteLength, true);
  output.set(manifestBytes, FIXED_HEADER_BYTES);
  return output;
}

/** 浏览器在完整响应落地后严格拆分瓦片，坏长度或尾随数据不能进入缓存。 */
export function decodeMediaAnalysisTileBatch(value: Uint8Array) {
  if (value.byteLength < FIXED_HEADER_BYTES) {
    throw new Error("媒体分析批次过短。");
  }
  const magic = new TextDecoder().decode(value.subarray(0, 8));
  if (magic !== MEDIA_ANALYSIS_TILE_BATCH_MAGIC) {
    throw new Error("媒体分析批次签名不正确。");
  }
  const manifestLength = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(8, true);
  if (manifestLength > MAX_BATCH_HEADER_BYTES) {
    throw new Error("媒体分析批次头超过大小上限。");
  }
  const payloadStart = FIXED_HEADER_BYTES + manifestLength;
  if (payloadStart > value.byteLength) {
    throw new Error("媒体分析批次头长度越界。");
  }

  const parsed = JSON.parse(
    new TextDecoder().decode(value.subarray(FIXED_HEADER_BYTES, payloadStart)),
  ) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("媒体分析批次头不正确。");
  }
  const entries = parsed.entries.map(parseEntry);
  validateEntries(entries);

  const assets = new Map<string, Uint8Array>();
  let offset = payloadStart;
  for (const entry of entries) {
    const end = offset + entry.byteLength;
    if (end > value.byteLength) {
      throw new Error("媒体分析批次瓦片长度越界。");
    }
    assets.set(entry.id, value.slice(offset, end));
    offset = end;
  }
  if (offset !== value.byteLength) {
    throw new Error("媒体分析批次包含未声明数据。");
  }
  return assets;
}

function parseEntry(value: unknown): MediaAnalysisTileBatchEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.byteLength !== "number") {
    throw new Error("媒体分析批次条目不正确。");
  }
  return { id: value.id, byteLength: value.byteLength };
}

function validateEntries(entries: readonly MediaAnalysisTileBatchEntry[]) {
  if (entries.length === 0 || entries.length > MAX_MEDIA_ANALYSIS_BATCH_ASSETS) {
    throw new Error("媒体分析批次条目数量不正确。");
  }
  const seenIds = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.id.trim() || entry.id.length > 128 || seenIds.has(entry.id)) {
      throw new Error("媒体分析批次包含空白、过长或重复的资产 ID。");
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength <= 0) {
      throw new Error("媒体分析批次瓦片大小不正确。");
    }
    seenIds.add(entry.id);
    totalBytes += entry.byteLength;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MEDIA_ANALYSIS_BATCH_BYTES) {
    throw new Error("媒体分析批次总大小超过上限。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
