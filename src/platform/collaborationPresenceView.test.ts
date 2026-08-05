import assert from "node:assert/strict";
import test from "node:test";
import { buildCollaborationPresenceView } from "./collaborationPresenceView";

test("在线成员展示把当前账号置顶并保留多窗口数量", () => {
  const view = buildCollaborationPresenceView([
    {
      userId: "user-b",
      accountName: "beta",
      displayName: "乙",
      connectionCount: 2,
      lastSeenAt: "2026-08-04T00:00:00.000Z",
    },
    {
      userId: "user-a",
      accountName: "alpha",
      displayName: "甲",
      connectionCount: 1,
      lastSeenAt: "2026-08-04T00:00:00.000Z",
    },
  ], "user-b");
  assert.equal(view[0]?.userId, "user-b");
  assert.equal(view[0]?.connectionCount, 2);
  assert.equal(view[0]?.isCurrentUser, true);
  assert.equal(view[0]?.avatarLabel, "乙");
});
