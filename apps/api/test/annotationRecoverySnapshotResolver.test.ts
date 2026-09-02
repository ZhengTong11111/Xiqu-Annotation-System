import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
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
