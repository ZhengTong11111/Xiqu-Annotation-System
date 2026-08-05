import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ANNOTATION_MUTATION_PURPOSES,
  type AnnotationMutationPurpose,
} from "@xiqu/shared";
import { hashToken } from "./auth.js";

export const ANNOTATION_MUTATION_LEASE_TTL_MS = 60_000;
export const ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS = 5 * 60_000;
const TOKEN_PREFIX = "xiqu_lease_";
const TOKEN_PATTERN = /^xiqu_lease_[A-Za-z0-9_-]{43}$/;
const PURPOSES = new Set<AnnotationMutationPurpose>(ANNOTATION_MUTATION_PURPOSES);

// 明文租约 token 只存在于客户端和当前请求；数据库与审计日志只接触固定长度摘要。
export function createAnnotationMutationLeaseToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isValidAnnotationMutationLeaseToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashAnnotationMutationLeaseToken(token: string) {
  return hashToken(token);
}

export function matchesAnnotationMutationLeaseToken(token: string, expectedHash: string) {
  if (!isValidAnnotationMutationLeaseToken(token) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashAnnotationMutationLeaseToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

export function parseAnnotationMutationPurpose(value: unknown): AnnotationMutationPurpose | null {
  return typeof value === "string" && PURPOSES.has(value as AnnotationMutationPurpose)
    ? value as AnnotationMutationPurpose
    : null;
}

export function isAnnotationMutationLeaseExpired(expiresAt: Date, now = new Date()) {
  return expiresAt.getTime() <= now.getTime();
}

// 续期受首次创建时间约束，避免崩溃或遗忘的客户端无限占用结构编辑权。
export function calculateAnnotationMutationLeaseExpiry(createdAt: Date, now = new Date()) {
  const normalExpiry = now.getTime() + ANNOTATION_MUTATION_LEASE_TTL_MS;
  const absoluteExpiry = createdAt.getTime() + ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS;
  return new Date(Math.min(normalExpiry, absoluteExpiry));
}
