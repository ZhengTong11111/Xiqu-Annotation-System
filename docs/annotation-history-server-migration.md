# 服务器端恢复快照迁移与启用指南

最后更新：2026-09-02

本文说明如何在已经运行的生产服务器上，安全升级恢复快照的数据库合同，并在验证完成后分阶段启用
`reconstructible` 新快照。本文针对 HC3c2/HC3c3 的 39 -> 41 条 expand-only migration；它不是历史快照
压缩脚本，也不是把本机数据库复制到生产的部署说明。

完整的 release 构建、维护模式、systemd、对象存储、Caddy、备份和通用回滚边界仍以
[`server-deployment.md`](./server-deployment.md) 为准。本文只补充恢复快照相关的操作顺序和核对命令。

## 1. 先明确迁移边界

本次迁移只改变数据库对“未来快照”的表达能力：

- 既有 `inline` 快照的 `payload`、revision、operation、确认、评论、反馈和审核链接全部保留，不能更新、置空、压缩、归档或删除。
- 第 40、41 条 migration 只建立双形态字段合同，不能代替数据备份，也不会把旧行自动改成 `reconstructible`。
- `rollout=disabled` 时，普通保存仍然写完整 `inline` 快照；这是生产第一阶段的默认配置。
- 只有 `rollout=future-reconstructible-v1` 且数据库能力检查通过时，新的普通保存才会尝试写
  `reconstructible`。证明失败、命令不可重放、首个检查点、特殊保护 reason、超预算或事务异常都会继续保留完整
  `inline`，不会阻断正文保存或留下半条记录。
- `reconstructible` 行的特征是 `payload IS NULL`、`compacted_at IS NOT NULL`，并且具备有效检查点、operation
  范围和完整性 hash。它依赖的 checkpoint 与 operation 是恢复事实，不能单独删除。

生产切换的安全状态应始终满足：**备份已验证、目标 migration 已应用、旧 inline smoke 通过、再单独开启 rollout**。
不能因为本机已经出现 `reconstructible` 快照，就跳过生产备份、隔离恢复或旧历史验收。

## 2. 迁移前检查

迁移前由操作员在服务器上记录以下信息，记录到脱敏的
[`production-cutover-record-template.md`](./production-cutover-record-template.md)，不要记录密码、连接串、payload、
AccessKey、PlayAuth、临时 URL 或完整环境文件：

```bash
readlink -f /opt/xiqu/current
# release 目录通常不包含 .git；从构建记录/切换记录抄录该 release 对应的 commit。
df -h / /var/lib/xiqu-platform
sudo systemctl is-active xiqu-api
sudo systemctl is-active xiqu-analysis-worker
```

确认以下条件后才能安排窗口：

1. 新 release 已从审查过的提交构建，并通过 `release:inspect`、`release:check` 和完整构建。
2. 候选 release 包含第 40、41 条 migration、匹配的 Prisma Client、`packages/shared/dist` 和
   `packages/document-model/dist`。
3. 生产环境文件中的 `XIQU_ANNOTATION_HISTORY_FUTURE_SNAPSHOT_ROLLOUT` 仍为 `disabled`。
4. 数据盘有足够空间保存一致备份和必要的隔离恢复副本。空间不足时停止迁移，不删除业务数据换空间。
5. 已通知标注人员暂停编辑，并确认关键会话显示已同步。

候选 release 尚未切换时，可先执行只读门禁：

```bash
NEW_RELEASE=/opt/xiqu/releases/<new-release-id>
sudo bash -c "cd '$NEW_RELEASE' && \
  npm run release:inspect -- --release-dir '$NEW_RELEASE' && \
  npm run release:check"
```

## 3. 建立一致备份

必须先由旧 release 开启维护并等待 HTTP 写入排空，再停止 analysis worker。只停止 worker、继续允许 API 写入，
不能形成恢复快照迁移所需的一致备份。

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run maintenance:enable -- \
    --operator platform.admin \
    --reason "恢复快照 schema 迁移"
'

sudo systemctl stop xiqu-analysis-worker
sudo systemctl is-active xiqu-analysis-worker # 必须为 inactive
```

维护排空后创建并校验完整备份：

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:create -- \
    --operator platform.admin \
    --output /var/lib/xiqu-platform/backups \
    --reason "恢复快照 schema 迁移前一致备份" \
    --require-existing-maintenance
'

sudo -u xiqu bash -c '
  cd /opt/xiqu/current
  npm run backup:verify -- \
    --backup /var/lib/xiqu-platform/backups/xiqu-backup-...
'
```

备份校验失败、manifest 不完整、对象 checksum 不一致或数据库摘要无法复核时，保持维护状态和 worker 停止，
不要继续 migration。必要时先在不同名称的空数据库和空对象目录执行 `backup:restore-drill`；不能把生产数据库或
生产对象目录作为演练目标。

## 4. 第一阶段：只升级 schema，保持 rollout 关闭

从新 release 目录执行 migration，不能使用 `db:push`、`db:push --force-reset`、手工修改
`_prisma_migrations` 或删除旧约束：

```bash
NEW_RELEASE=/opt/xiqu/releases/<new-release-id>
sudo -u xiqu env NEW_RELEASE="$NEW_RELEASE" bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd "$NEW_RELEASE"
  npm run db:deploy
'
```

检查 migration 结果。实际 migration 名称以仓库目录为准，当前候选最后两条应为：

- `20260903010000_annotation_recovery_snapshot_future_contract`
- `20260903020000_annotation_recovery_snapshot_shadow_inline_contract`

```bash
sudo -u xiqu env NEW_RELEASE="$NEW_RELEASE" bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd "$NEW_RELEASE"
  npx prisma migrate status
'
```

预期为 `Database schema is up to date!`，并且生产 migration 数量已经从 39 条变为 41 条。migration 是
expand-only：它不应生成、修改或删除任何历史恢复快照行。若命令中途失败，保持维护，不重复执行危险的手工 SQL；
先查看 migration 和数据库日志，确认事务状态后再决定重试或按备份恢复。

## 5. 切换 release 并验收旧路径

schema migration 成功后，以旧 release 的真实路径为并发前提原子切换，不能使用裸 `ln -sfn`：

```bash
OLD_RELEASE="$(readlink -f /opt/xiqu/current)"
NEW_RELEASE=/opt/xiqu/releases/<new-release-id>

sudo bash -c "cd '$NEW_RELEASE' && npm run release:switch -- \
  --current-link /opt/xiqu/current \
  --expected-current '$OLD_RELEASE' \
  --new-release '$NEW_RELEASE'"
sudo systemctl restart xiqu-api

sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run deploy:check -- --base-url=https://annotation.example.org
'
```

维护状态下只做无写入检查。确认 API readiness、登录页、资源读取和恢复历史页面正常后，先用新 release 完成
受控人工验收：

1. 打开一个已有历史文件，检查恢复历史列表、详情、比较和恢复入口；旧 `inline` 快照必须能正常读取。
2. 检查一条带确认、评论、反馈、审核链接和媒体绑定的文件，确认治理事实没有丢失。
3. 解除维护前，仍保持环境文件中的 rollout 为 `disabled`。
4. 在低干扰窗口解除维护、启动 worker，使用一个受控可写文件完成一次普通编辑保存和一次协作追赶。
5. 检查保存成功、revision 连续递增、恢复历史可再次打开，且没有新的 5xx、同步失败或 worker stale claim。

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run maintenance:disable -- --operator platform.admin
'
sudo systemctl start xiqu-analysis-worker
sudo systemctl is-active xiqu-analysis-worker # 必须为 active
```

这一阶段完成后，生产已经具备新 schema，但仍然只写 `inline`。这样可以把“数据库升级风险”和“未来快照写入
风险”分开观察，出现问题时优先回滚代码而不改变历史数据。

## 6. 第二阶段：单独开启新快照写入

只有第一阶段的旧历史、普通保存、原子命令保存、恢复前保护、协作 catch-up、备份/恢复读取和指标均通过，且有
单独的生产授权后，才执行本阶段。不得把它和 39 -> 41 migration 混在同一个未验证窗口中。

编辑生产环境文件时只改这一项，保留其他值和权限：

```bash
sudoedit /etc/xiqu-platform/xiqu-platform.env
# XIQU_ANNOTATION_HISTORY_FUTURE_SNAPSHOT_ROLLOUT='future-reconstructible-v1'
sudo chmod 640 /etc/xiqu-platform/xiqu-platform.env
sudo systemctl restart xiqu-api
```

API 启动后再次检查 readiness 和只读 smoke，然后用低风险测试文件执行一次保存。数据库只读核对不得输出正文：

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  psql "$DATABASE_URL" -Atc "
    SELECT storage_mode, COUNT(*)
    FROM annotation_recovery_snapshots
    GROUP BY storage_mode
    ORDER BY storage_mode;
  "
'
```

启用成功时，新的普通保存可能出现 `reconstructible` 行；每条此类行都应满足：

```sql
storage_mode = 'reconstructible'
payload IS NULL
compacted_at IS NOT NULL
checkpoint_snapshot_id IS NOT NULL
operation_revision_start IS NOT NULL
operation_revision_end IS NOT NULL
operation_sequence_start IS NOT NULL
operation_sequence_end IS NOT NULL
operation_count IS NOT NULL
payload_sha256 IS NOT NULL
recipe_verified_at IS NOT NULL
```

如果 schema 能力检查发现 migration 没有完成，writer 会自动回退为完整 `inline`；这保护保存不被 rollout 顺序
阻断，但也说明部署顺序不正确，应修复环境与 schema，不应重复点击保存或手动置空 payload。若出现恢复错误、hash
不一致、operation 重放失败、保存 5xx 或同步异常，立即将 rollout 改回 `disabled` 并重启 API，保留现场和日志；
不要删除新行，也不要修改历史 inline 行。

## 7. 失败与回滚

### 7.1 只回滚代码

第 40、41 条是为旧 inline 代码设计的 expand-only 合同。只有确认旧 release 能读取现有数据库、且失败期间没有
不确定的数据写入时，才可以在维护状态和 worker 停止下使用 `release:switch` 切回旧 release。切回前先把 rollout
改为 `disabled`，避免旧 release 接收到新配置：

```bash
sudoedit /etc/xiqu-platform/xiqu-platform.env
# XIQU_ANNOTATION_HISTORY_FUTURE_SNAPSHOT_ROLLOUT='disabled'

FAILED_RELEASE="$(readlink -f /opt/xiqu/current)"
OLD_RELEASE=/opt/xiqu/releases/<previous-release-id>
sudo bash -c "cd '$FAILED_RELEASE' && npm run release:switch -- \
  --current-link /opt/xiqu/current \
  --expected-current '$FAILED_RELEASE' \
  --new-release '$OLD_RELEASE'"
sudo systemctl restart xiqu-api
```

不能通过删除 migration 记录制造“回滚”。数据库仍保持 41 条 migration；旧代码只使用它能够理解的 inline 字段。
回滚后重新执行 readiness、恢复历史、登录、ACL、revision、WebSocket、审计和对象 Range 验收，确认安全后才解除
维护并启动 worker。

### 7.2 恢复数据库与对象

如果 migration 执行不完整、数据库或对象出现不确定写入、恢复 hash 不一致、备份校验失败，不能只切回代码。保持
维护和 worker 停止，保留失败现场，使用第 3 节已验证的一致备份，同时恢复候选数据库和对象目录，再切回与备份
schema 匹配的 release。恢复必须走隔离空目标和经过校验的正式接管流程；不要对生产目录原地覆盖，也不要使用
`db:push --force-reset`。

## 8. 迁移完成判定与长期监控

本次服务器迁移只有同时满足以下条件才算完成：

- [ ] 候选 release、migration 和 Prisma Client 来自同一提交并通过发布门禁。
- [ ] 维护排空后的一致备份 manifest/checksum 验证通过。
- [ ] 生产数据库从 39 条安全升级到 41 条，`prisma migrate status` 为 up to date。
- [ ] 旧 `inline` 恢复历史、比较、恢复和治理事实读取正常。
- [ ] rollout 关闭阶段的普通保存、原子保存、协作追赶和 worker 运行正常。
- [ ] 有独立授权后才开启 `future-reconstructible-v1`，新快照形态抽样核对通过。
- [ ] 磁盘余量、恢复快照 storage mode 计数、`schema_not_ready` 回退计数、API 5xx 和 worker stale claim 已记录。
- [ ] 旧 release、备份 id、migration 前后数量、环境变量键变更、smoke 结果和回滚结论已写入脱敏运维记录。

日常巡检只看聚合指标和 bounded diagnostics。不要为了确认状态导出 ProjectData、完整 operation、凭据、媒体临时
URL 或恢复快照 payload；也不要把 `reconstructible` 当成“可以删除依赖 operation”的信号。

## 9. 服务器间迁移的区别

如果需求是把平台从服务器 A 搬到服务器 B，而不是在同一服务器升级 schema，应使用
[`server-deployment.md` 第 10.3 节](./server-deployment.md#103-服务器间迁移)的完整数据库 + 对象存储一致备份流程。
先在 B 的空候选数据库和空对象目录执行隔离恢复并校验，再进行接管；不要只迁移 PostgreSQL、只复制 `data/`，或
只把 `reconstructible` 快照行导出。恢复快照依赖 operation、checkpoint 和对象事实，数据库与对象必须作为一个
一致数据集迁移。
