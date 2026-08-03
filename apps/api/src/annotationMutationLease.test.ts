import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS,
  calculateAnnotationMutationLeaseExpiry,
  createAnnotationMutationLeaseToken,
  hashAnnotationMutationLeaseToken,
  isAnnotationMutationLeaseExpired,
  isValidAnnotationMutationLeaseToken,
  matchesAnnotationMutationLeaseToken,
  parseAnnotationMutationPurpose,
} from "./annotationMutationLease.js";

test("租约 token 只以固定格式和摘要进入持久化边界", () => {
  const token = createAnnotationMutationLeaseToken();
  const hash = hashAnnotationMutationLeaseToken(token);
  assert.equal(isValidAnnotationMutationLeaseToken(token), true);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(matchesAnnotationMutationLeaseToken(token, hash), true);
  assert.equal(matchesAnnotationMutationLeaseToken(`${token}x`, hash), false);
});

test("租约用途和过期判断对宽松输入 fail closed", () => {
  assert.equal(parseAnnotationMutationPurpose("track_structure"), "track_structure");
  assert.equal(parseAnnotationMutationPurpose("unknown"), null);
  assert.equal(parseAnnotationMutationPurpose({ value: "bulk_import" }), null);
  const now = new Date("2026-08-04T00:00:00.000Z");
  assert.equal(isAnnotationMutationLeaseExpired(now, now), true);
  assert.equal(isAnnotationMutationLeaseExpired(new Date(now.getTime() + 1), now), false);
});

test("续期不能越过首次创建后的最长生命周期", () => {
  const createdAt = new Date("2026-08-04T00:00:00.000Z");
  const nearLimit = new Date(createdAt.getTime() + ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS - 10_000);
  assert.equal(
    calculateAnnotationMutationLeaseExpiry(createdAt, nearLimit).getTime(),
    createdAt.getTime() + ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS,
  );
  const afterLimit = new Date(createdAt.getTime() + ANNOTATION_MUTATION_LEASE_MAX_LIFETIME_MS + 1);
  assert.ok(calculateAnnotationMutationLeaseExpiry(createdAt, afterLimit).getTime() < afterLimit.getTime());
});
