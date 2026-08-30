# 后台任务与读写链路故障判别手册

## 1. 用途与边界

本手册用于判断平台出现“页面能打开但保存失败”“波形一直排队”“取消任务没有结束”“快速滚动后请求变慢”等现象时，故障究竟位于 HTTP 读取、维护写门禁、PostgreSQL、对象存储还是分析 worker。

平台不会用一个含糊的“服务异常”覆盖所有层级。运维人员应先保留现场，再根据下列权威事实逐层收窄范围。不要先重启所有进程；盲目重启会清除连接、claim 和日志证据，也可能把可恢复问题变成更难判断的状态。

## 2. 权威入口

| 入口 | 负责回答的问题 | 不负责回答的问题 |
| --- | --- | --- |
| `/api/health/live` | API 进程是否存活 | 数据库、对象存储是否可用 |
| `/api/health/ready` | PostgreSQL 与对象存储是否都可用 | worker 进程是否运行 |
| 管理员“系统诊断” | 依赖、容量、写许可、任务积压/陈旧 claim 的聚合结论 | 具体任务的取消和重试 |
| “后台任务”中心 | 哪一项任务、谁仍需要、能否取消或重试 | 主机服务和连接池状态 |
| `/metrics` | 可告警的低基数趋势与当前聚合值 | 资源名、账号、任务 payload |
| `systemctl status xiqu-analysis-worker` | worker 进程在空队列时是否存活 | 某个任务是否仍持有有效 claim |
| worker 日志 | 固定错误码、恢复、claim 丢失和 FFmpeg 退出原因 | PlayAuth、临时 URL 或凭据正文 |

有活动任务时，数据库中的任务状态、heartbeat 和 claim 是处理链路权威；空队列没有 heartbeat 可观察，因此 worker 是否存活必须由 systemd 或主机监控判断。API 不伪造“worker 在线”指标。

## 3. 五分钟判别流程

### 3.1 API 是否可达

1. `live` 失败：先检查 `xiqu-api` 的 systemd 状态、端口和 Nginx；这不是任务中心问题。
2. `live` 成功、`ready` 失败：查看 readiness 中是 database 还是 storage unavailable。
3. `ready` 成功但页面慢：继续检查规范化 HTTP 延迟、客户端是否在快速滚动中主动中止旧批次，以及维护写许可。

### 3.2 只有写入失败还是读取也失败

- GET、Range、波形瓦片读取正常，但登录、保存、上传等 mutation 等待：检查 `xiqu_maintenance_write_permits_active`、`waiting` 和 `oldest_age_seconds`。
- active 长期不降且 oldest 持续增长：保留 route/status 指标与 API 日志，定位未收敛的业务 Promise；不要把只读 POST 重新归为 write 来掩盖问题。
- waiting 增长但 active 接近许可上限：优先排查数据库连接池/维护 advisory gate，不要只扩大连接池。
- 维护已开启：新的写入被拒绝是预期行为；编辑器本地草稿不能当成服务器保存成功。

### 3.3 后台任务是否真正停滞

- queued 大于零且最老排队年龄超过 120 秒：检查 worker 是否 active、是否在反复退避、数据库是否可 claim。
- running/cancelling 的陈旧 claim 大于零：worker 超过 120 秒未刷新 heartbeat。先查 worker 日志和数据库依赖；正常 runtime 会每 30 秒扫描并恢复陈旧 claim。
- cancelling 最老年龄超过 120 秒：检查 FFmpeg 是否收到 SIGTERM、2 秒后是否升级 SIGKILL，以及来源流/对象补偿是否仍在收口。
- 最近失败大于零但没有积压、陈旧 claim：这通常是已收敛的单任务业务失败；在任务中心查看稳定错误类别并决定是否重试。
- 历史 failed 总数大于零但最近窗口为零：不是当前事故，不应保持永久告警。

### 3.4 数据库还是对象存储

- readiness database unavailable：检查 PostgreSQL 连接、连接池、慢查询和 advisory lock；对象补偿不应作为第一操作。
- readiness storage unavailable：检查对象根挂载/S3 endpoint、凭据权限和超时；数据库仍可能正常。
- `xiqu_media_upload_compensation_failures_total` 增长：发布处于不确定窗口。保留 staged/final 的固定 stage 证据，运行对象一致性检查，不要人工按猜测删除对象。
- `missing_binary`：数据库引用存在但二进制缺失，属于恢复问题；孤儿清理不得删除或隐藏这条事实。
- 可清理孤儿：只使用系统诊断中的受控清理；缺失二进制和宽限期内对象不能被清理。

## 4. 用户动作与运维动作

| 现象 | 用户可做 | 管理员/运维应做 |
| --- | --- | --- |
| 单个任务稳定 failed | 在任务中心按权限重试 | 查看稳定错误类别与近期同类失败趋势 |
| 共享任务仍有其他需求 | 取消“我的任务请求” | 不应强制停止其他人的共享执行 |
| claim 陈旧 | 等待自动恢复，不重复快速创建 | 检查 worker/systemd/数据库；确认 stale recovery 是否收敛 |
| 对象补偿不确定 | 不重复上传同一逻辑请求 | 保留现场，检查对象一致性与审计事实 |
| 写许可耗尽 | 保留本地草稿，停止反复提交 | 检查 active/waiting/oldest 与规范化 route；必要时进入维护 |
| readiness 失败 | 停止写入和批量操作 | 进入维护，修复依赖后再恢复 |

只有幂等请求可以原样重放：媒体分析创建复用同一 `clientRequestId`，取消/重试复用同一 command id。不能通过固定延时后生成新 ID 来“重试”，否则会创建新的业务事实。

## 5. 受控命令顺序

```bash
# API 与依赖
curl -fsS http://127.0.0.1:4317/api/health/live
curl -fsS http://127.0.0.1:4317/api/health/ready

# worker 进程与最近日志；不要输出环境变量或凭据
sudo systemctl status xiqu-analysis-worker
sudo journalctl -u xiqu-analysis-worker --since "15 minutes ago"

# API 日志中只检索稳定错误码和低基数事件
sudo journalctl -u xiqu-api --since "15 minutes ago"
```

若需要执行一致备份、migration 或 release 切换，必须按 `docs/server-deployment.md` 的维护窗口顺序停止 worker、排空 HTTP 写入并验证备份。本手册不授权直接修改生产任务行、清空 claim 或删除对象。

## 6. Prometheus 关键指标

- `xiqu_operational_metrics_collection_success`
- `xiqu_operational_metrics_collection_timestamp_seconds`
- `xiqu_processing_jobs{status=...}`
- `xiqu_processing_job_oldest_age_seconds{phase="queued|heartbeat|cancelling"}`
- `xiqu_processing_job_stale_claims{status="running|cancelling"}`
- `xiqu_processing_job_recent_outcomes{status="succeeded|failed|cancelled"}`
- `xiqu_processing_job_recent_average_duration_seconds{phase="queue_wait|run|cancellation"}`
- `xiqu_maintenance_write_permits_active`
- `xiqu_maintenance_write_permits_waiting`
- `xiqu_maintenance_write_permit_oldest_age_seconds`
- `xiqu_media_upload_compensation_failures_total{stage="staged|final"}`

所有 label 都是固定低基数枚举。账号、资源、任务 ID、对象路径、错误正文、VOD URL、PlayAuth 和凭据不得进入 Prometheus。

## 7. 浏览器与 VOD 验收

当前阿里云 Web License 绑定 `localhost`。本机真实 VOD 播放、音轨切换、波形/频谱/F0 验收必须从 `http://localhost:5173/` 进入；`http://127.0.0.1:5173/` 页面即使可打开，也不能作为 VOD 播放结论。服务端故障注入和 API 集成测试不需要启动 VOD 播放器。

## 8. P4 回归命令

```bash
npm run test:processing-reliability-p4
npm run test:api
npm run test:deployment
npm run build
git diff --check
```

P4 聚合脚本依次验证路由/可取消流、数据库/对象原子性、worker/FFmpeg、指标/诊断/告警。任何失败都应回到对应 owner 修复，不用跳过测试或重启掩盖。
