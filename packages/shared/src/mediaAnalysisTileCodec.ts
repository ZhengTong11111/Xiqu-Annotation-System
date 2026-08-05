const MEDIA_ANALYSIS_TILE_MAGIC = "XIQUA001";
const FIXED_HEADER_BYTES = 12;

export type EncodedMediaAnalysisTile = {
  header: Record<string, unknown>;
  sections: Uint8Array[];
};

/**
 * 分析瓦片使用“小 JSON 头 + 原始二进制段”格式，避免频谱矩阵被扩成巨大的 JSON 数组。
 * sectionLengths 属于协议字段，由编码器统一生成，调用方不能伪造。
 */
export function encodeMediaAnalysisTile(
  header: Record<string, unknown>,
  sections: Uint8Array[],
): Uint8Array {
  const safeHeader = {
    ...header,
    sectionLengths: sections.map((section) => section.byteLength),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(safeHeader));
  const totalBytes = FIXED_HEADER_BYTES + headerBytes.byteLength
    + sections.reduce((sum, section) => sum + section.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  output.set(new TextEncoder().encode(MEDIA_ANALYSIS_TILE_MAGIC), 0);
  new DataView(output.buffer).setUint32(8, headerBytes.byteLength, true);
  output.set(headerBytes, FIXED_HEADER_BYTES);
  let offset = FIXED_HEADER_BYTES + headerBytes.byteLength;
  for (const section of sections) {
    output.set(section, offset);
    offset += section.byteLength;
  }
  return output;
}

export function decodeMediaAnalysisTile(value: Uint8Array): EncodedMediaAnalysisTile {
  if (value.byteLength < FIXED_HEADER_BYTES) throw new Error("分析瓦片过短。");
  const magic = new TextDecoder().decode(value.subarray(0, 8));
  if (magic !== MEDIA_ANALYSIS_TILE_MAGIC) throw new Error("分析瓦片签名不正确。");
  const headerLength = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(8, true);
  const payloadStart = FIXED_HEADER_BYTES + headerLength;
  if (payloadStart > value.byteLength) throw new Error("分析瓦片头长度越界。");
  const parsed = JSON.parse(
    new TextDecoder().decode(value.subarray(FIXED_HEADER_BYTES, payloadStart)),
  ) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.sectionLengths)) {
    throw new Error("分析瓦片头不正确。");
  }
  const lengths = parsed.sectionLengths;
  if (lengths.some((length) => !Number.isSafeInteger(length) || length < 0)) {
    throw new Error("分析瓦片分段长度不正确。");
  }
  const sections: Uint8Array[] = [];
  let offset = payloadStart;
  for (const length of lengths as number[]) {
    if (offset + length > value.byteLength) throw new Error("分析瓦片分段越界。");
    sections.push(value.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== value.byteLength) throw new Error("分析瓦片包含未声明数据。");
  const { sectionLengths: _sectionLengths, ...header } = parsed;
  return { header, sections };
}

/** Float32 统一写成小端，浏览器与不同架构的 worker 读取结果一致。 */
export function encodeFloat32LittleEndian(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * 4, values[index] ?? 0, true);
  }
  return bytes;
}

export function decodeFloat32LittleEndian(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error("Float32 分段长度不正确。");
  const output = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getFloat32(index * 4, true);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
