import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

// 部署配置通过真实 YAML parser 读取，避免正则测试在缩进或结构损坏时仍误判通过。
async function readYaml(path: string): Promise<Record<string, unknown>> {
  return parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("Prometheus 使用独立凭据抓取 API 并加载平台规则", async () => {
  const config = await readYaml("deploy/monitoring/prometheus.yml");
  assert.deepEqual(config.rule_files, ["/etc/prometheus/xiqu-alerts.yml"]);
  const scrape = (config.scrape_configs as Array<Record<string, unknown>>)[0];
  assert.equal(scrape.job_name, "xiqu-api");
  assert.equal(scrape.metrics_path, "/metrics");
  const authorization = scrape.authorization as Record<string, unknown>;
  assert.equal(authorization.credentials_file, "/run/secrets/xiqu_metrics_token");
  assert.doesNotMatch(JSON.stringify(config), /admin123|xiqu_dev_password/);
});

test("平台告警规则覆盖依赖、容量、请求、任务和补偿失败", async () => {
  const config = await readYaml("deploy/monitoring/xiqu-alerts.yml");
  const groups = config.groups as Array<Record<string, unknown>>;
  const rules = groups.flatMap((group) => group.rules as Array<Record<string, unknown>>);
  const names = new Set(rules.map((rule) => rule.alert));
  for (const required of [
    "XiquApiDown",
    "XiquMetricsCollectionFailed",
    "XiquMetricsSnapshotStale",
    "XiquDependencyUnavailable",
    "XiquHighErrorRate",
    "XiquHighLatency",
    "XiquStorageCapacity",
    "XiquFailedJobs",
    "XiquJobBacklog",
    "XiquStaleJobClaim",
    "XiquJobCancellationStalled",
    "XiquUploadCompensationFailure",
  ]) assert.ok(names.has(required), `缺少告警 ${required}`);
  const capacities = rules.filter((rule) => rule.alert === "XiquStorageCapacity");
  assert.deepEqual(
    capacities.map((rule) => (rule.labels as Record<string, unknown>).severity).sort(),
    ["critical", "warning"],
  );
});

test("Alertmanager 示例提供分组、抑制和占位 webhook", async () => {
  const config = await readYaml("deploy/monitoring/alertmanager.yml.example");
  const route = config.route as Record<string, unknown>;
  assert.deepEqual(route.group_by, ["alertname", "service", "environment"]);
  assert.equal((config.inhibit_rules as unknown[]).length, 1);
  const serialized = JSON.stringify(config);
  assert.match(serialized, /replace-with-alert-receiver\.invalid/);
  assert.doesNotMatch(serialized, /localhost:4317\/api\/auth|admin123/);
});
