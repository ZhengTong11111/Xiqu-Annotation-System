import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { resolveAnnotationRecoverySnapshotPayloadAsync } from "../src/annotationRecoverySnapshotPayloadService.js";
import {
  resolveAnnotationRecoverySnapshotPayload,
  type AnnotationRecoverySnapshotResolvableRow,
} from "../src/annotationRecoverySnapshotResolver.js";

function createRow<TPayload>(
  payload: TPayload,
  overrides: Partial<AnnotationRecoverySnapshotResolvableRow<TPayload>> = {},
): AnnotationRecoverySnapshotResolvableRow<TPayload> {
  return {
    id: "snapshot-1",
    annotationFileId: "annotation-1",
    revision: 7,
    storageMode: "inline",
    payload,
    payloadSha256: null,
    ...overrides,
  };
}

test("inline resolver 原样返回历史任意 JSON，且不修改输入", () => {
  const historicalPayload = {
    marker: "legacy",
    savedProjectFile: { version: 2, project: { unknownField: true } },
    missingCurrentFields: ["tracks"],
  };
  const row = createRow(historicalPayload);
  const before = structuredClone(row);

  const result = resolveAnnotationRecoverySnapshotPayload(row);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload, historicalPayload, "inline 读取不应克隆或规范化 payload");
  assert.deepEqual(row, before);
});

test("inline resolver 校验可选 canonical hash", () => {
  const payload = { title: "当前格式同样不经 parser", tracks: [] };
  const valid = resolveAnnotationRecoverySnapshotPayload(createRow(payload, {
    payloadSha256: createAnnotationHistoryCanonicalHash(payload),
  }));
  assert.equal(valid.ok, true);

  const invalid = resolveAnnotationRecoverySnapshotPayload(createRow(payload, {
    payloadSha256: "0".repeat(64),
  }));
  assert.deepEqual(invalid, {
    ok: false,
    code: "snapshot_payload_hash_mismatch",
    snapshotId: "snapshot-1",
    annotationFileId: "annotation-1",
    revision: 7,
  });
  assert.ok(!JSON.stringify(invalid).includes("当前格式"));
  assert.ok(!JSON.stringify(invalid).includes("00000000"));
});

test("尚未启用和未知的存储形态稳定 fail closed", () => {
  for (const storageMode of ["reconstructible", "archived", "future_mode"]) {
    const result = resolveAnnotationRecoverySnapshotPayload(createRow(
      { secretMarker: storageMode },
      { storageMode },
    ));
    assert.deepEqual(result, {
      ok: false,
      code: "snapshot_storage_mode_unsupported",
      snapshotId: "snapshot-1",
      annotationFileId: "annotation-1",
      revision: 7,
    });
    assert.ok(!JSON.stringify(result).includes("secretMarker"));
  }
});

test("异步协调器读取 inline 并保留旧 JSON 身份", async () => {
  const payload = { legacy: true, nested: { untouched: "旧结构" } };
  const transaction = {} as Parameters<typeof resolveAnnotationRecoverySnapshotPayloadAsync>[0]["transaction"];
  const inline = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: {
      ...createRow(payload),
      checkpointSnapshotId: null,
      operationRevisionStart: null,
      operationRevisionEnd: null,
      operationSequenceStart: null,
      operationSequenceEnd: null,
      operationCount: null,
      compactionVersion: null,
      recipeVerifiedAt: null,
      compactedAt: null,
    },
  });
  assert.equal(inline.ok, true);
  if (inline.ok) assert.equal(inline.payload, payload);

  const reconstructible = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: {
      ...createRow(null, { storageMode: "reconstructible" }),
      checkpointSnapshotId: "checkpoint-1",
      operationRevisionStart: 2,
      operationRevisionEnd: 7,
      operationSequenceStart: 1,
      operationSequenceEnd: 6,
      operationCount: 6,
      compactionVersion: 1,
      recipeVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
      compactedAt: null,
    },
  });
  assert.deepEqual(reconstructible, {
    ok: false,
    code: "snapshot_compaction_incomplete",
    snapshotId: "snapshot-1",
    annotationFileId: "annotation-1",
    revision: 7,
  });
});

test("异步协调器拒绝缺失 inline payload 而不返回近似内容", async () => {
  const transaction = {} as Parameters<typeof resolveAnnotationRecoverySnapshotPayloadAsync>[0]["transaction"];
  const result = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: {
      ...createRow(null),
      checkpointSnapshotId: null,
      operationRevisionStart: null,
      operationRevisionEnd: null,
      operationSequenceStart: null,
      operationSequenceEnd: null,
      operationCount: null,
      compactionVersion: null,
      recipeVerifiedAt: null,
      compactedAt: null,
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "snapshot_payload_missing",
    snapshotId: "snapshot-1",
    annotationFileId: "annotation-1",
    revision: 7,
  });
});

test("候选重建在 recipe 不完整时先行阻断且不读取数据库", async () => {
  const transaction = {} as Parameters<typeof resolveAnnotationRecoverySnapshotPayloadAsync>[0]["transaction"];
  const result = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: {
      ...createRow(null, { storageMode: "reconstructible" }),
      payloadSha256: "a".repeat(64),
      checkpointSnapshotId: null,
      operationRevisionStart: 2,
      operationRevisionEnd: 7,
      operationSequenceStart: 1,
      operationSequenceEnd: 6,
      operationCount: 6,
      compactionVersion: 1,
      recipeVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
      compactedAt: new Date("2026-09-02T01:00:00.000Z"),
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "recipe_incomplete",
    snapshotId: "snapshot-1",
    annotationFileId: "annotation-1",
    revision: 7,
  });
});

test("候选重建拒绝正文未清空或缺少压缩时间的半迁移状态", async () => {
  const transaction = {} as Parameters<typeof resolveAnnotationRecoverySnapshotPayloadAsync>[0]["transaction"];
  const completeRecipe = {
    ...createRow(null, { storageMode: "reconstructible" }),
    payloadSha256: "a".repeat(64),
    checkpointSnapshotId: "checkpoint-1",
    operationRevisionStart: 2,
    operationRevisionEnd: 7,
    operationSequenceStart: 1,
    operationSequenceEnd: 6,
    operationCount: 6,
    compactionVersion: 1,
    recipeVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
  };

  const payloadPresent = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: {
      ...completeRecipe,
      payload: { staleInlinePayload: true },
      compactedAt: new Date("2026-09-02T01:00:00.000Z"),
    },
  });
  assert.equal(payloadPresent.ok, false);
  if (!payloadPresent.ok) assert.equal(payloadPresent.code, "snapshot_payload_state_invalid");

  const missingCompactedAt = await resolveAnnotationRecoverySnapshotPayloadAsync({
    transaction,
    row: { ...completeRecipe, compactedAt: null },
  });
  assert.equal(missingCompactedAt.ok, false);
  if (!missingCompactedAt.ok) assert.equal(missingCompactedAt.code, "snapshot_compaction_incomplete");
});
