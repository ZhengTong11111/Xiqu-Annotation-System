import {
  inspectReleaseCandidate,
  parseReleaseCandidateArguments,
} from "./releaseCandidateInspector.js";

try {
  const options = parseReleaseCandidateArguments(process.argv.slice(2));
  const report = await inspectReleaseCandidate(options.releaseDir);
  console.log(
    `候选 release 检查通过：${report.checkedRequiredPaths} 个运行路径，` +
      `${report.runtimeDependencyCount} 个生产依赖，${report.migrationCount} 条 migration。`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "候选 release 检查失败。");
  process.exitCode = 1;
}
