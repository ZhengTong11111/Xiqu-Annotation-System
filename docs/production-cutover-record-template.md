# 生产升级与回滚记录模板

> 使用方式：每次生产升级复制一份本模板到受控运维记录目录，按实际证据填写。未执行项保持未勾选并说明原因，
> 不得提前勾选。此记录不是命令脚本，完整命令和边界以 [`server-deployment.md`](./server-deployment.md) 为准。

## 1. 保密边界

本记录只保存 release、commit、migration 数量、备份 id、报告路径、健康状态、任务聚合数量和验收结论。**禁止记录**：

- 账号密码、session token、监控 token、AccessKey ID/Secret、Web License key、PlayAuth；
- `DATABASE_URL`、含签名或凭据的对象地址、VOD/媒体临时 URL；
- 环境文件正文、对象正文、完整标注 payload、浏览器草稿内容；
- 私钥路径之外的私钥内容，或任何可直接复用的授权请求头。

## 2. 变更摘要

- 变更编号：`<change-id>`
- 计划窗口（时区）：`<start> - <end>`
- 操作员账号名：`<operator-account-name>`
- 验收人：`<reviewer>`
- 变更原因：`<bounded-summary>`
- 旧 release：`<absolute-old-release-path>`
- 旧 commit/tag：`<old-commit-or-tag>`
- 新 release：`<absolute-new-release-path>`
- 新 commit/tag：`<new-commit-or-tag>`
- migration 变化摘要：`<none | count-and-names>`
- 环境变量键变化：`<key names only; never values>`
- 预计是否可仅回滚代码：`<yes | no | unknown>`

## 3. 候选预检

- [ ] 新 release 为不可变目录，构建来源和 commit 已复核。
- [ ] `release:inspect` 通过：运行路径 `<count>`，生产依赖 `<count>`，migration `<count>`。
- [ ] `release:check` 通过，Prisma Client 与候选 schema 一致。
- [ ] release notes、migration、环境键、对象存储和代理变更已审查。
- [ ] 已通知用户停止编辑，关键用户确认界面显示已同步。
- [ ] 已记录 `current` 的真实旧 release；后续原子切换将它作为 `expected-current`。

候选预检证据/异常：`<summary>`

## 4. 一致备份窗口

- [ ] 使用旧 release 启用维护并等待 API 在途写入排空。
- [ ] 维护状态复核为启用，写入已 fail closed。
- [ ] 停止 analysis worker，`is-active` 为 `inactive`。
- [ ] 活动任务摘要已记录：queued `<n>` / running `<n>` / cancelling `<n>` / stale claim `<n>`。
- [ ] 一致备份创建完成。
- 备份 id/目录名：`<backup-id-only>`
- [ ] manifest 和全部对象校验通过。
- 备份校验摘要：`<manifest version, object count, bytes, checksum result>`
- [ ] 本次风险需要隔离恢复演练，且演练通过；或已记录不需要的理由。
- 隔离恢复报告路径/摘要：`<path-or-not-required-reason>`

> 一致备份必须发生在“维护排空完成 + worker 已停止”之后；反过来的备份不得作为本次升级回滚基线。

## 5. Migration 与原子切换

- [ ] 使用新 release 执行正式 `prisma migrate deploy`，没有使用 `db push`。
- migration 前数量/最后一条：`<count / name>`
- migration 后数量/最后一条：`<count / name>`
- [ ] 使用 `release:switch`，并把第 2 节旧 release 作为 `expected-current`。
- 原子切换结果：`<old -> new>`
- [ ] API 已重启，必要时 Nginx 配置先通过 `nginx -t` 再 reload。
- [ ] 维护状态下只读 smoke 通过：Web 首页 / liveness / readiness。
- 静态资源 hash：`<asset hash>`
- readiness 摘要：`<healthy summary>`

## 6. 恢复服务与人工验收

- [ ] 使用新 release 解除维护。
- [ ] 启动 analysis worker，进程 active，任务可靠性没有陈旧 claim。
- [ ] 登录、资源列表、打开标注文件正常。
- [ ] 编辑、同步保存、返回资源管理器等待保存正常。
- [ ] 两个独立账号协作、权限撤销/只读边界正常。
- [ ] 上传媒体 Range、下载和资源权限正常。
- [ ] 若启用 VOD，使用正式授权域名完成播放、随机 seek 和切音轨。
- [ ] 已有波形、频谱、F0 读取正常；一次受控分析任务可收敛。
- [ ] 系统诊断、审计、指标和告警接收端正常。

人工验收缺口/观察：`<summary>`

## 7. 回滚决策

触发原因：`<none | reason>`

### A. 仅代码回滚

只在 migration 与旧程序明确向后兼容、数据库和对象权威事实无需恢复时使用：

- [ ] 保持或重新启用维护，停止 worker。
- [ ] 使用 `release:switch`，`expected-current` 为失败的新 release，目标为已记录旧 release。
- [ ] 重启 API，维护状态下通过只读 smoke。
- [ ] 复核 readiness、对象 Range、登录、ACL、revision、WebSocket、审计和任务状态。
- [ ] 明确确认数据兼容后才解除维护并启动 worker。

### B. 数据与对象恢复

只要 migration 不向后兼容、数据库/对象发生不确定写入或一致性检查失败，就不能只切代码：

- [ ] 保持维护和 worker 停止，保留失败现场与日志。
- [ ] 使用第 4 节已验证的一致备份，按正式恢复/接管流程同时恢复数据库与对象。
- [ ] 切回与备份 schema 匹配的旧 release；不得手工删除 `_prisma_migrations`，不得使用强制 `db push`。
- [ ] 完成完整只读与人工验收后才恢复写入。

最终 active release：`<absolute-release-path>`

最终维护状态：`<enabled | disabled>`

最终 worker 状态：`<inactive | active>`

未完成项与负责人：`<items>`

## 8. 最终签署

- 操作员：`<name / time>`
- 验收人：`<name / time>`
- 结果：`<successful | rolled-back | maintenance-held>`
- 后续观察截止时间：`<timestamp>`
- Development Log 条目：`<path / heading>`
