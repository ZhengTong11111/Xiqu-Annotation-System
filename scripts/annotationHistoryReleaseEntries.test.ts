import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

type RootPackage = {
  scripts?: Record<string, string>;
};

const HISTORY_RELEASE_ENTRIES = [
  {
    script: "annotation-history:plan:dry-run",
    entry: "dist/api/annotationHistoryCompactionCli.js",
    expectedError: "必须且只能选择 --all 或 --annotation-file-id",
  },
  {
    script: "annotation-history:shadow-recipe",
    entry: "dist/api/annotationHistoryShadowRecipeCli.js",
    expectedError: "必须且只能选择 --all 或 --annotation-file-id",
  },
  {
    script: "annotation-history:verify-shadow-recipes",
    entry: "dist/api/annotationHistoryStoredRecipeVerificationCli.js",
    expectedError: "必须提供完整的 --annotation-file-id",
  },
] as const;

test("历史容量 CLI 只从不可变 release 的编译产物启动", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as RootPackage;

  for (const contract of HISTORY_RELEASE_ENTRIES) {
    const command = packageJson.scripts?.[contract.script];
    assert.equal(
      command,
      `node --env-file-if-exists=.env ${contract.entry}`,
      `${contract.script} 必须直接执行编译产物`,
    );
    assert.doesNotMatch(command, /(?:--import\s+tsx|apps\/api\/src)/u);
    assert.equal(existsSync(contract.entry), true, `${contract.entry} 应由 build:api 生成`);
  }
});

test("历史容量 CLI 缺少范围参数时先失败且不会读取数据库配置", () => {
  for (const contract of HISTORY_RELEASE_ENTRIES) {
    // 注入不可连接且可识别的哨兵地址；若参数解析不再优先，测试会超时或暴露数据库错误。
    const environment = {
      ...process.env,
      DATABASE_URL: "postgresql://sensitive-marker.invalid/db",
    };

    const result = spawnSync(process.execPath, [contract.entry], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
      timeout: 5_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, `${contract.script} 应以参数错误退出`);
    assert.match(output, new RegExp(contract.expectedError, "u"));
    assert.doesNotMatch(output, /DATABASE_URL|sensitive-marker|ECONN|PrismaClient|postgresql:\/\//u);
    assert.ok(output.length < 1_000, `${contract.script} 的失败输出必须保持有界`);
  }
});
