#!/usr/bin/env node

import {
  assertSupportedNodeVersion,
  parseDeploymentCheckArguments,
  runDeploymentCheck,
} from "./deploymentCheck.mjs";

try {
  // CLI 只做无凭据只读探测，适合首次部署、升级和回滚后的统一验收。
  assertSupportedNodeVersion(process.versions.node);
  const options = parseDeploymentCheckArguments(process.argv.slice(2));
  const results = await runDeploymentCheck(options);
  for (const result of results) {
    console.log(`通过：${result.name}（HTTP ${result.status}）`);
  }
  console.log(`部署检查通过：${options.baseUrl}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`部署检查失败：${message}`);
  process.exitCode = 1;
}
