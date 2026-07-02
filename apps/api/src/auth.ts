import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, hashHex] = storedHash.split(":");
  if (algorithm !== "scrypt" || !salt || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
