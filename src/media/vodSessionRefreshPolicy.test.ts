import assert from "node:assert/strict";
import test from "node:test";
import { getVodSessionRefreshRetryDelay } from "./vodSessionRefreshPolicy";

test("后台续签按上限持续退避且不产生零延迟循环", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 20].map((attempt) =>
      getVodSessionRefreshRetryDelay("background", attempt)),
    [5_000, 15_000, 30_000, 60_000, 60_000, 60_000],
  );
});

test("播放器故障恢复使用有限重试预算", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) =>
      getVodSessionRefreshRetryDelay("player_recovery", attempt)),
    [1_000, 3_000, 10_000, 30_000, null],
  );
  assert.equal(getVodSessionRefreshRetryDelay("background", 0), null);
  assert.equal(getVodSessionRefreshRetryDelay("player_recovery", 1.5), null);
});
