import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseReleaseSwitchArguments,
  ReleaseSwitchError,
  switchRelease,
} from "../src/releaseSwitch.js";

test("release 切换参数要求三个显式绝对路径", () => {
  assert.deepEqual(parseReleaseSwitchArguments([
    "--current-link=/opt/xiqu/current",
    "--expected-current", "/opt/xiqu/releases/old",
    "--new-release", "/opt/xiqu/releases/new",
  ]), {
    currentLink: "/opt/xiqu/current",
    expectedCurrent: "/opt/xiqu/releases/old",
    newRelease: "/opt/xiqu/releases/new",
  });
  assert.throws(() => parseReleaseSwitchArguments([]), /--current-link/);
  assert.throws(() => parseReleaseSwitchArguments([
    "--current-link", "current",
    "--expected-current", "/releases/old",
    "--new-release", "/releases/new",
  ]), /绝对路径/);
  assert.throws(() => parseReleaseSwitchArguments(["--unknown"]), /未知参数/);
  assert.throws(() => parseReleaseSwitchArguments([
    "--current-link", "/opt/xiqu/current",
    "--current-link", "/opt/xiqu/another-current",
    "--expected-current", "/opt/xiqu/releases/old",
    "--new-release", "/opt/xiqu/releases/new",
  ]), /不能重复/);
});

test("原子切换与回滚都绑定期望旧 release", async () => {
  const fixture = await createReleaseTree();
  try {
    const first = await switchRelease({
      currentLink: fixture.currentLink,
      expectedCurrent: fixture.oldRelease,
      newRelease: fixture.newRelease,
    }, { inspectCandidate: candidateInspector });
    assert.equal(first.previousRelease, await realpath(fixture.oldRelease));
    assert.equal(first.activeRelease, await realpath(fixture.newRelease));
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.newRelease));

    const rollback = await switchRelease({
      currentLink: fixture.currentLink,
      expectedCurrent: fixture.newRelease,
      newRelease: fixture.oldRelease,
    }, { inspectCandidate: candidateInspector });
    assert.equal(rollback.activeRelease, await realpath(fixture.oldRelease));
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.oldRelease));
    await assertNoSwitchArtifacts(fixture.root, fixture.currentLink);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("current 漂移、同目标和跨 releases 根全部 fail closed", async () => {
  const fixture = await createReleaseTree();
  const otherRoot = await mkdtemp(path.join(tmpdir(), "xiqu-other-releases-"));
  const otherRelease = path.join(otherRoot, "other");
  await mkdir(otherRelease);
  try {
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.newRelease,
        newRelease: fixture.oldRelease,
      }, { inspectCandidate: candidateInspector }),
      hasReleaseSwitchCode("current_drift"),
    );
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.oldRelease,
        newRelease: fixture.oldRelease,
      }, { inspectCandidate: candidateInspector }),
      hasReleaseSwitchCode("same_release"),
    );
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.oldRelease,
        newRelease: otherRelease,
      }, { inspectCandidate: candidateInspector }),
      hasReleaseSwitchCode("release_root_mismatch"),
    );
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.oldRelease));
    await assertNoSwitchArtifacts(fixture.root, fixture.currentLink);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("非 symlink、并发锁和不完整候选不会覆盖 current", async () => {
  const fixture = await createReleaseTree();
  try {
    await rm(fixture.currentLink);
    await mkdir(fixture.currentLink);
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.oldRelease,
        newRelease: fixture.newRelease,
      }, { inspectCandidate: candidateInspector }),
      hasReleaseSwitchCode("current_not_symlink"),
    );

    await rm(fixture.currentLink, { recursive: true });
    await symlink(fixture.oldRelease, fixture.currentLink, "dir");
    await writeFile(`${fixture.currentLink}.switch.lock`, "existing\n");
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.oldRelease,
        newRelease: fixture.newRelease,
      }, { inspectCandidate: candidateInspector }),
      hasReleaseSwitchCode("switch_locked"),
    );
    await rm(`${fixture.currentLink}.switch.lock`);

    await assert.rejects(switchRelease({
      currentLink: fixture.currentLink,
      expectedCurrent: fixture.oldRelease,
      newRelease: fixture.newRelease,
    }));
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.oldRelease));
    await assertNoSwitchArtifacts(fixture.root, fixture.currentLink);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("原子 rename 失败时保留旧 current 并只清理本次临时项", async () => {
  const fixture = await createReleaseTree();
  const unrelated = path.join(fixture.root, "operator-notes.txt");
  await writeFile(unrelated, "keep\n");
  try {
    await assert.rejects(
      switchRelease({
        currentLink: fixture.currentLink,
        expectedCurrent: fixture.oldRelease,
        newRelease: fixture.newRelease,
      }, {
        inspectCandidate: candidateInspector,
        renameLink: async () => {
          throw new Error("injected rename failure");
        },
        createOperationId: () => "rename-failure",
      }),
      hasReleaseSwitchCode("switch_publish_failed"),
    );
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.oldRelease));
    assert.ok((await readdir(fixture.root)).includes("operator-notes.txt"));
    await assertNoSwitchArtifacts(fixture.root, fixture.currentLink);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rename 已提交但响应报错时按 current 真实目标确认成功", async () => {
  const fixture = await createReleaseTree();
  try {
    const report = await switchRelease({
      currentLink: fixture.currentLink,
      expectedCurrent: fixture.oldRelease,
      newRelease: fixture.newRelease,
    }, {
      inspectCandidate: candidateInspector,
      renameLink: async (source, target) => {
        await rename(source, target);
        throw new Error("injected response loss");
      },
      createOperationId: () => "ambiguous-rename",
    });
    assert.equal(report.activeRelease, await realpath(fixture.newRelease));
    assert.equal(await realpath(fixture.currentLink), await realpath(fixture.newRelease));
    await assertNoSwitchArtifacts(fixture.root, fixture.currentLink);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createReleaseTree() {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-release-switch-"));
  const releasesRoot = path.join(root, "releases");
  const oldRelease = path.join(releasesRoot, "old");
  const newRelease = path.join(releasesRoot, "new");
  const currentLink = path.join(root, "current");
  await mkdir(oldRelease, { recursive: true });
  await mkdir(newRelease, { recursive: true });
  await symlink(oldRelease, currentLink, "dir");
  return { root, oldRelease, newRelease, currentLink };
}

async function candidateInspector(releaseDir: string) {
  return {
    releaseDir: await realpath(releaseDir),
    checkedRequiredPaths: 26,
    runtimeDependencyCount: 25,
    migrationCount: 31,
  };
}

function hasReleaseSwitchCode(code: ReleaseSwitchError["code"]) {
  return (error: unknown) => error instanceof ReleaseSwitchError && error.code === code;
}

async function assertNoSwitchArtifacts(root: string, currentLink: string) {
  const prefix = `${path.basename(currentLink)}.switch`;
  assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(prefix)), []);
}
