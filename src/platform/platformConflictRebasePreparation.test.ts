import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationFile, ResourceCapability } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type {
  ProjectDocumentOperation,
  ProjectDocumentRecoveryState,
} from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import { buildProjectAnnotationContentCommand } from "../utils/annotationContentCommand";
import { buildPlatformDraftRecord, type PlatformDraftRecord } from "./platformDraft";
import {
  buildPlatformConflictRebaseProposal,
  preparePlatformConflictRebase,
} from "./platformConflictRebasePreparation";

const USER_ID = "student-user";
const FILE_ID = "annotation-file";

// 夹具用一条真实领域命令形成 dirty 草稿，确保准备器验证的是生产 command envelope 而不是手写伪数据。
function createFixture(): {
  draft: PlatformDraftRecord;
  serverFile: AnnotationFile<ProjectData>;
  latestServerProject: ProjectData;
} {
  const savedProject = structuredClone(mockProject);
  const currentProject = structuredClone(savedProject);
  currentProject.subtitleLines.find(({ id }) => id === "line-1")!.text = "本地修改";
  const envelope = buildProjectAnnotationContentCommand(savedProject, currentProject, [{
    entityType: "sentence",
    entityId: "line-1",
    field: "text",
  }]);
  if (!envelope) throw new Error("测试夹具无法生成内容命令。");
  const operation: ProjectDocumentOperation = {
    id: "rebase-preparation-op",
    type: envelope.command.type,
    action: "edit",
    localRevision: 5,
    baseRevision: 4,
    createdAt: 1_785_830_000_000,
    syncState: "pending",
    commandEnvelope: envelope,
    summary: { hasProjectChange: true, hasTrackSnapChange: false },
  };
  const recoveryState: ProjectDocumentRecoveryState = {
    currentProject,
    savedProject,
    currentTrackSnapEnabled: { "character-track": true },
    savedTrackSnapEnabled: { "character-track": true },
    pendingOperations: [operation],
    localRevision: 5,
    savedRevision: 4,
    lastChangedAt: 1_785_830_000_000,
    lastSavedAt: 1_785_829_000_000,
  };
  const draft = buildPlatformDraftRecord({
    userId: USER_ID,
    annotationFileId: FILE_ID,
    remoteBaseRevision: 7,
    recoveryState,
    createdAt: 1_785_828_000_000,
    now: 1_785_830_100_000,
  });
  const latestServerProject = structuredClone(savedProject);
  latestServerProject.subtitleLines.find(({ id }) => id === "line-2")!.text = "远端修改";
  return {
    draft,
    latestServerProject,
    serverFile: createAnnotationFile(latestServerProject, 8, ["read", "write"]),
  };
}

test("不相交命令生成轻量 proposal，不把正文放入指纹", () => {
  const fixture = createFixture();
  const result = buildPlatformConflictRebaseProposal({ userId: USER_ID, ...fixture });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.proposal.operationCount, 1);
  assert.equal(result.proposal.draftRemoteBaseRevision, 7);
  assert.equal(result.proposal.serverRevision, 8);
  assert.doesNotMatch(result.proposal.planFingerprint, /本地修改|远端修改/);
  assert.doesNotMatch(result.proposal.planFingerprint, /before|after/);
});

test("二次准备以最新服务器为 saved、完整重放结果为 current，并保留 operation 身份", () => {
  const fixture = createFixture();
  const proposal = requireProposal(fixture);
  const original = structuredClone(fixture);
  const result = preparePlatformConflictRebase({
    userId: USER_ID,
    ...fixture,
    proposal,
    now: 1_785_830_200_000,
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(
    result.recoveryState.savedProject.subtitleLines.find(({ id }) => id === "line-2")?.text,
    "远端修改",
  );
  assert.equal(
    result.recoveryState.currentProject.subtitleLines.find(({ id }) => id === "line-1")?.text,
    "本地修改",
  );
  assert.equal(
    result.recoveryState.currentProject.subtitleLines.find(({ id }) => id === "line-2")?.text,
    "远端修改",
  );
  assert.deepEqual(result.recoveryState.pendingOperations, fixture.draft.pendingOperations);
  assert.notEqual(result.recoveryState.pendingOperations, fixture.draft.pendingOperations);
  assert.equal(result.recoveryState.localRevision, 5);
  assert.equal(result.recoveryState.savedRevision, 4);
  assert.equal(result.draftRecord.remoteBaseRevision, 8);
  assert.equal(result.draftRecord.createdAt, fixture.draft.createdAt);
  assert.equal(result.draftRecord.updatedAt, 1_785_830_200_000);
  assert.deepEqual(fixture, original);
});

test("草稿身份、时间、基准或 operation 集合漂移均阻断确认", () => {
  const fixture = createFixture();
  const proposal = requireProposal(fixture);
  const cases: Array<[PlatformDraftRecord, string]> = [
    [{ ...fixture.draft, userId: "another-user" }, "identity_changed"],
    [{ ...fixture.draft, annotationFileId: "another-file" }, "identity_changed"],
    [{ ...fixture.draft, updatedAt: fixture.draft.updatedAt + 1 }, "draft_changed"],
    [{ ...fixture.draft, remoteBaseRevision: 6 }, "draft_changed"],
    [{
      ...fixture.draft,
      pendingOperations: fixture.draft.pendingOperations.map((operation) => ({
        ...operation,
        id: "replaced-operation",
      })),
    }, "plan_changed"],
  ];
  for (const [draft, reason] of cases) {
    const result = preparePlatformConflictRebase({
      userId: USER_ID,
      ...fixture,
      draft,
      proposal,
    });
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, reason);
  }
});

test("服务器身份、revision 与写权限变化均阻断确认", () => {
  const fixture = createFixture();
  const proposal = requireProposal(fixture);
  const changedIdentity = {
    ...fixture.serverFile,
    resource: { ...fixture.serverFile.resource, id: "another-file" },
  };
  const changedRevision = { ...fixture.serverFile, revision: 9 };
  const revoked = createAnnotationFile(fixture.latestServerProject, 8, ["read"]);

  const identityResult = preparePlatformConflictRebase({
    userId: USER_ID,
    ...fixture,
    serverFile: changedIdentity,
    proposal,
  });
  assert.equal(identityResult.status, "rejected");
  if (identityResult.status === "rejected") assert.equal(identityResult.reason, "identity_changed");

  const revisionResult = preparePlatformConflictRebase({
    userId: USER_ID,
    ...fixture,
    serverFile: changedRevision,
    proposal,
  });
  assert.equal(revisionResult.status, "rejected");
  if (revisionResult.status === "rejected") assert.equal(revisionResult.reason, "server_revision_changed");

  const permissionResult = preparePlatformConflictRebase({
    userId: USER_ID,
    ...fixture,
    serverFile: revoked,
    proposal,
  });
  assert.equal(permissionResult.status, "rejected");
  if (permissionResult.status === "rejected") assert.equal(permissionResult.reason, "write_permission_revoked");
});

test("同目标冲突、track-snap 变化与旧操作不生成 proposal", () => {
  const conflictFixture = createFixture();
  conflictFixture.latestServerProject.subtitleLines.find(({ id }) => id === "line-1")!.text = "远端同目标";
  conflictFixture.serverFile.payload = conflictFixture.latestServerProject;
  assert.equal(
    buildPlatformConflictRebaseProposal({ userId: USER_ID, ...conflictFixture }).status,
    "not_available",
  );

  const snapFixture = createFixture();
  snapFixture.draft.currentTrackSnapEnabled = { "character-track": false };
  const snapResult = buildPlatformConflictRebaseProposal({ userId: USER_ID, ...snapFixture });
  assert.deepEqual(snapResult, { status: "not_available", reason: "track_snap_state_changed" });

  const legacyFixture = createFixture();
  legacyFixture.draft.pendingOperations[0] = {
    ...legacyFixture.draft.pendingOperations[0]!,
    type: "project.commit",
    commandEnvelope: undefined,
  };
  const legacyResult = buildPlatformConflictRebaseProposal({ userId: USER_ID, ...legacyFixture });
  assert.deepEqual(legacyResult, { status: "not_available", reason: "manual_review_required" });
});

test("proposal 指纹被篡改时不返回半份 recovery state", () => {
  const fixture = createFixture();
  const proposal = { ...requireProposal(fixture), planFingerprint: "tampered" };
  const result = preparePlatformConflictRebase({ userId: USER_ID, ...fixture, proposal });
  assert.deepEqual(result, {
    status: "rejected",
    reason: "plan_changed",
    message: "冲突重放计划已经变化，请重新检查后再确认。",
  });
  assert.equal("recoveryState" in result, false);
  assert.equal("draftRecord" in result, false);
});

function requireProposal(fixture: ReturnType<typeof createFixture>) {
  const result = buildPlatformConflictRebaseProposal({ userId: USER_ID, ...fixture });
  if (result.status !== "ready") throw new Error(`测试夹具未生成 proposal：${result.reason}`);
  return result.proposal;
}

// AnnotationFile 夹具只填写客户端合同字段，权限能力用于覆盖写权限撤销边界。
function createAnnotationFile(
  payload: ProjectData,
  revision: number,
  capabilities: ResourceCapability[],
): AnnotationFile<ProjectData> {
  return {
    resource: {
      id: FILE_ID,
      parentId: "project-1",
      type: "annotation_file",
      name: "并发测试.json",
      owner: { id: "owner", accountName: "admin", displayName: "管理员" },
      breakPermissionInheritance: false,
      archivedAt: null,
      trashedAt: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:01:00.000Z",
      childCount: 0,
      size: null,
      mimeType: "application/json",
      revision,
      favorite: false,
      permission: {
        source: "direct",
        capabilities,
        inheritedFrom: [],
        isOwner: false,
        canManagePermissions: false,
      },
    },
    payload,
    revision,
    operationCursor: `cursor-${revision}`,
    mediaResourceId: null,
    lastEditor: { id: "owner", accountName: "admin", displayName: "管理员" },
    lastSavedAt: "2026-08-04T00:01:00.000Z",
  };
}
