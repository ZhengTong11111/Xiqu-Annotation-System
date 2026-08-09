type RuntimeCrypto = Partial<Pick<Crypto, "randomUUID" | "getRandomValues">>;

let fallbackSequence = 0;

// HTTP IP 地址不属于浏览器安全上下文，Chrome 会隐藏 crypto.randomUUID()。
// 统一入口优先使用原生 UUID；其次用仍可在非安全上下文调用的 getRandomValues 生成标准 UUID v4。
export function createRuntimeUuid(
  cryptoApi: RuntimeCrypto | undefined = globalThis.crypto,
): string {
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // 极旧浏览器的最后兜底只负责稳定实体身份，不作为鉴权凭据。
    // 时间、页面内序号和随机量共同参与，避免同一毫秒内连续创建产生重复 id。
    fallbackSequence = (fallbackSequence + 1) >>> 0;
    let seed = Date.now() ^ fallbackSequence;
    for (let index = 0; index < bytes.length; index += 1) {
      seed = Math.imul(seed ^ Math.floor(Math.random() * 0x1_0000_0000), 0x45d9f3b);
      bytes[index] = seed >>> ((index % 4) * 8);
    }
  }

  // RFC 4122 version 4 与 variant 位必须在随机字节写入后覆盖。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
