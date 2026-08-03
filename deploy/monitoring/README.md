# 平台外部监控配置

本目录提供 Prometheus + Alertmanager 的供应商中立基线。应用只暴露低基数事实指标；通知分组、静默、
抑制、重试和 webhook/email 投递由 Alertmanager 负责。

## 启用步骤

1. 为 API 配置独立强随机 `XIQU_METRICS_TOKEN`，不要复用登录密码、session token 或 S3 凭据。
2. 把相同 token 写入 Prometheus 容器内的 `/run/secrets/xiqu_metrics_token`，权限限制为监控进程可读。
3. 按部署网络修改 `prometheus.yml` 中 API 与 Alertmanager target；生产环境必须使用受控内网或 TLS。
4. 复制 `alertmanager.yml.example` 到部署私有配置，替换 `.invalid` webhook；不要提交真实 URL/secret。
5. 挂载 `xiqu-alerts.yml`，启动前使用对应版本的 `promtool check config` 和 `promtool check rules` 验证。

## 验证

```bash
curl -fsS -H "Authorization: Bearer $XIQU_METRICS_TOKEN" http://127.0.0.1:4317/metrics
promtool check config deploy/monitoring/prometheus.yml
promtool check rules deploy/monitoring/xiqu-alerts.yml
```

规则覆盖 API 不可达、指标采集失败、数据库/对象存储不可用、5xx、P95 延迟、平台容量、失败/积压任务
和上传补偿失败。容量 warning 与 critical 互斥；Alertmanager 同时配置 critical 抑制同名 warning。

当前模板不是托管 Prometheus、Grafana 或生产 TLS/IAM 的自动部署，也不替代 PostgreSQL/S3 备份。
