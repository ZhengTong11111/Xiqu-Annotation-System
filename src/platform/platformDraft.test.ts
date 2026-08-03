import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import type { ProjectDocumentRecoveryState } from "../state/projectDocumentState";
import {
  assessPlatformDraftCompatibility,
  buildPlatformDraftRecord,
  normalizePlatformDraftRecord,
  toProjectDocumentRecoveryState,
} from "./platformDraft";
import {
  createPlatformDraftTaskQueue,
  getPlatformDraftPersistenceAction,
} from "./usePlatformDraftPersistence";

// 测试夹具包含 dirty 项目与稳定 operation id，用来验证刷新后仍能继续幂等提交。
function createRecoveryState(): ProjectDocumentRecoveryState {
  return {
    currentProject: {
      ...mockProject,
      video: {
        ...mockProject.video,
        url: "http://localhost:4317/api/files/media-1/content?access_token=secret",
        filePath: "platform-file:media-1",
      },
      subtitleLines: mockProject.subtitleLines.map((line, index) => index === 0
        ? { ...line, text: `${line.text}（本地编辑）` }
        : line),
    },
    savedProject: mockProject,
    currentTrackSnapEnabled: { "character-track": false },
    savedTrackSnapEnabled: { "character-track": true },
    pendingOperations: [{
      id: "op-recoverable",
      type: "project.commit",
      action: "edit",
      localRevision: 3,
      baseRevision: 2,
      createdAt: 1_785_700_000_000,
      syncState: "pending",
      summary: {
        hasProjectChange: true,
        hasTrackSnapChange: false,
      },
    }],
    localRevision: 3,
    savedRevision: 2,
    lastChangedAt: 1_785_700_000_000,
    lastSavedAt: 1_785_699_000_000,
  };
}

// 构建草稿会清除受保护媒体 URL，并保留单份项目、稳定 operation 和 revision。
test("构建并恢复平台草稿不会持久化会话 URL", () => {
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState: createRecoveryState(),
    now: 1_785_700_100_000,
  });
  assert.equal(record.currentProject.video.url, "");
  assert.equal(record.pendingOperations.length, 1);
  assert.equal("beforeProject" in record.pendingOperations[0], false);
  assert.equal("afterProject" in record.pendingOperations[0], false);

  const normalized = normalizePlatformDraftRecord(record, {
    userId: "user-1",
    annotationFileId: "file-1",
  });
  assert.ok(normalized);
  const recovered = toProjectDocumentRecoveryState(normalized, (project) => ({
    ...project,
    video: { ...project.video, url: "fresh-protected-url" },
  }));
  assert.equal(recovered.currentProject.video.url, "fresh-protected-url");
  assert.equal(recovered.pendingOperations[0].id, "op-recoverable");
  assert.equal(recovered.localRevision, 3);
});

// 刷新恢复必须保留领域命令的版本、目标和 before/after，才能继续复用同一个幂等 operation。
test("平台草稿完整往返版本化 timing command", () => {
  const recoveryState = createRecoveryState();
  recoveryState.pendingOperations = [{
    ...recoveryState.pendingOperations[0],
    type: "timeline.items.timing.update",
    commandEnvelope: {
      version: 1,
      command: {
        type: "timeline.items.timing.update",
        items: [{
          entityType: "character",
          entityId: "char-1",
          before: { startTime: 1, endTime: 2 },
          after: { startTime: 2, endTime: 3 },
        }],
      },
    },
  }];
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState,
  });
  const normalized = normalizePlatformDraftRecord(record, {
    userId: "user-1",
    annotationFileId: "file-1",
  });

  assert.deepEqual(normalized?.pendingOperations[0].commandEnvelope,
    recoveryState.pendingOperations[0].commandEnvelope);
  assert.equal(normalizePlatformDraftRecord({
    ...record,
    pendingOperations: [{
      ...record.pendingOperations[0],
      commandEnvelope: {
        ...record.pendingOperations[0].commandEnvelope,
        unexpected: true,
      },
    }],
  }, { userId: "user-1", annotationFileId: "file-1" }), null);
});

// 内容命令与 timing 共用草稿边界；刷新后仍须保留字段、track scope 与 before/after。
test("平台草稿完整往返版本化 content command", () => {
  const recoveryState = createRecoveryState();
  recoveryState.pendingOperations = [{
    ...recoveryState.pendingOperations[0],
    type: "annotation.items.content.update",
    commandEnvelope: {
      version: 1,
      command: {
        type: "annotation.items.content.update",
        items: [{
          entityType: "attached-point",
          entityId: "point-1",
          trackId: "point-track-1",
          field: "label",
          before: "原标签",
          after: "新标签",
        }],
      },
    },
  }];
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState,
  });
  const normalized = normalizePlatformDraftRecord(record, {
    userId: "user-1",
    annotationFileId: "file-1",
  });

  assert.deepEqual(
    normalized?.pendingOperations[0].commandEnvelope,
    recoveryState.pendingOperations[0].commandEnvelope,
  );
});

// 生命周期命令的完整实体与位置事实必须原样往返，否则恢复后的 operation 无法安全重放或反向。
test("平台草稿完整往返版本化 lifecycle command", () => {
  const recoveryState = createRecoveryState();
  recoveryState.pendingOperations = [{
    ...recoveryState.pendingOperations[0],
    type: "annotation.items.lifecycle.update",
    commandEnvelope: {
      version: 1,
      command: {
        type: "annotation.items.lifecycle.update",
        items: [{
          entityType: "attached-point",
          entityId: "point-created",
          trackId: "point-track-1",
          before: null,
          after: {
            entity: { id: "point-created", time: 2, label: "呼吸" },
            position: {
              index: 0,
              collectionLength: 1,
              previousEntityId: null,
              nextEntityId: null,
            },
          },
        }],
      },
    },
  }];
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState,
  });
  const normalized = normalizePlatformDraftRecord(record, {
    userId: "user-1",
    annotationFileId: "file-1",
  });
  assert.deepEqual(
    normalized?.pendingOperations[0].commandEnvelope,
    recoveryState.pendingOperations[0].commandEnvelope,
  );
});

// 草稿只可由原账号打开原文件；损坏 operation、越界 revision 和假项目均 fail closed。
test("平台草稿 unknown 边界拒绝身份与结构损坏", () => {
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState: createRecoveryState(),
    now: 1_785_700_100_000,
  });
  assert.equal(normalizePlatformDraftRecord(record, {
    userId: "user-2",
    annotationFileId: "file-1",
  }), null);
  assert.equal(normalizePlatformDraftRecord({
    ...record,
    pendingOperations: [{ ...record.pendingOperations[0], localRevision: 99 }],
  }, { userId: "user-1", annotationFileId: "file-1" }), null);
  assert.equal(normalizePlatformDraftRecord({
    ...record,
    currentProject: {},
  }, { userId: "user-1", annotationFileId: "file-1" }), null);
});

// revision 判定绝不偷偷把旧草稿提升到服务器当前 revision。
test("只有相同服务器 revision 的草稿可直接恢复", () => {
  const record = buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: 7,
    recoveryState: createRecoveryState(),
  });
  assert.equal(assessPlatformDraftCompatibility(record, 7).status, "recoverable");
  assert.equal(assessPlatformDraftCompatibility(record, 8).status, "revision-conflict");
  assert.equal(record.remoteBaseRevision, 7);
});

// 待确认整合暂停整个草稿生命周期；确认或取消后才根据 dirty 状态覆盖或删除。
test("草稿持久化决策区分暂停、写入与删除", () => {
  const base = {
    enabled: true,
    suspended: false,
    userId: "user-1",
    annotationFileId: "file-1",
  };
  assert.equal(getPlatformDraftPersistenceAction({
    ...base,
    suspended: true,
    hasUnsavedChanges: false,
  }), "none");
  assert.equal(getPlatformDraftPersistenceAction({
    ...base,
    hasUnsavedChanges: true,
  }), "put");
  assert.equal(getPlatformDraftPersistenceAction({
    ...base,
    hasUnsavedChanges: false,
  }), "delete");
});

// 显式 flush 必须排在 debounce 写入后；失败既反馈调用者，也不能毒死后续队列。
test("草稿写入队列保持顺序并可在失败后继续", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  const queue = createPlatformDraftTaskQueue((error) => {
    errors.push(error instanceof Error ? error.message : "unknown");
  });
  const first = queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("first");
  });
  const failed = queue.enqueue(async () => {
    events.push("failed");
    throw new Error("write failed");
  });
  const final = queue.enqueue(async () => {
    events.push("flush");
  });

  await first;
  await assert.rejects(failed, /write failed/);
  await final;
  assert.deepEqual(events, ["first", "failed", "flush"]);
  assert.deepEqual(errors, ["write failed"]);
});
