import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapInitialAdministrator,
  type BootstrapAdministratorStore,
  validateBootstrapAdministratorInput,
} from "../src/bootstrapAdmin.js";
import {
  parseBootstrapAdminArguments,
  readBootstrapPasswordFromStdin,
} from "../src/bootstrapAdminArguments.js";

function createMemoryStore(options: {
  hasAdministrator?: boolean;
  existingAccounts?: string[];
} = {}) {
  const created: Array<{ accountName: string; displayName: string; passwordHash: string }> = [];
  let exclusiveRuns = 0;
  const store: BootstrapAdministratorStore = {
    runExclusive: async (operation) => {
      exclusiveRuns += 1;
      return operation({
        hasActiveAdministrator: async () => options.hasAdministrator ?? false,
        accountExists: async (accountName) => options.existingAccounts?.includes(accountName) ?? false,
        createAdministrator: async (input) => {
          created.push(input);
          return { id: "admin-id", accountName: input.accountName, displayName: input.displayName };
        },
      });
    },
  };
  return { store, created, getExclusiveRuns: () => exclusiveRuns };
}

test("首次管理员在独占边界内创建且 store 不接收明文密码", async () => {
  const memory = createMemoryStore();
  const result = await bootstrapInitialAdministrator(
    memory.store,
    { accountName: " first.admin ", displayName: " 首位管理员 ", password: "correct-horse-123" },
    async () => "hashed-password",
  );
  assert.equal(memory.getExclusiveRuns(), 1);
  assert.deepEqual(result, {
    id: "admin-id",
    accountName: "first.admin",
    displayName: "首位管理员",
  });
  assert.deepEqual(memory.created, [{
    accountName: "first.admin",
    displayName: "首位管理员",
    passwordHash: "hashed-password",
  }]);
});

test("已有管理员或同名普通账号时拒绝 bootstrap", async () => {
  const input = { accountName: "first.admin", displayName: "管理员", password: "correct-horse-123" };
  await assert.rejects(
    () => bootstrapInitialAdministrator(createMemoryStore({ hasAdministrator: true }).store, input),
    /已存在活跃管理员/,
  );
  await assert.rejects(
    () => bootstrapInitialAdministrator(
      createMemoryStore({ existingAccounts: ["first.admin"] }).store,
      input,
    ),
    /账号名已存在/,
  );
});

test("管理员身份和密码输入采用严格边界", () => {
  assert.throws(
    () => validateBootstrapAdministratorInput({
      accountName: "a b",
      displayName: "管理员",
      password: "correct-horse-123",
    }),
    /账号名/,
  );
  assert.throws(
    () => validateBootstrapAdministratorInput({
      accountName: "admin",
      displayName: "管理员",
      password: "short",
    }),
    /12-256/,
  );
});

test("CLI 解析不接受密码参数、未知参数或缺失参数", () => {
  assert.deepEqual(
    parseBootstrapAdminArguments(["--account-name", "admin", "--display-name", "系统管理员"]),
    { accountName: "admin", displayName: "系统管理员" },
  );
  assert.throws(
    () => parseBootstrapAdminArguments(["--account-name", "admin", "--password", "secret"]),
    /用法/,
  );
  assert.throws(
    () => parseBootstrapAdminArguments(["--account-name", "admin"]),
    /同时提供/,
  );
});

test("stdin 密码只移除一个终止换行并限制输入大小", async () => {
  assert.equal(
    await readBootstrapPasswordFromStdin((async function* () {
      yield Buffer.from("correct-");
      yield Buffer.from("horse-123\n");
    })()),
    "correct-horse-123",
  );
  await assert.rejects(
    () => readBootstrapPasswordFromStdin((async function* () {
      yield "x".repeat(1025);
    })()),
    /过长/,
  );
});
