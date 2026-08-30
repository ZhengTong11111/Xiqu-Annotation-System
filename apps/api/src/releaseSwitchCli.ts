import { parseReleaseSwitchArguments, switchRelease } from "./releaseSwitch.js";

try {
  const report = await switchRelease(parseReleaseSwitchArguments(process.argv.slice(2)));
  console.log(
    `release 原子切换完成：${report.previousRelease} -> ${report.activeRelease}；` +
      `候选已检查 ${report.checkedRequiredPaths} 个运行路径、` +
      `${report.runtimeDependencyCount} 个生产依赖和 ${report.migrationCount} 条 migration。`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "release 切换失败。");
  process.exitCode = 1;
}
