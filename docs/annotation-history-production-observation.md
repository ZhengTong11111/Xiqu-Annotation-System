# 标注恢复历史生产观察与影子验证手册

更新日期：2026-09-02

## 1. 目的与适用边界

本手册用于执行 [`annotation-history-capacity-roadmap.md`](./annotation-history-capacity-roadmap.md) 的 HC2 生产观察，以及在
另行授权后对少量非关键文件执行 HC3a 影子 recipe 验证。通用 release 构建、维护、备份、隔离恢复、原子切换与回滚仍以
[`server-deployment.md`](./server-deployment.md) 为准；本文只补充恢复历史专项的授权、命令顺序、停止条件和脱敏证据。

本手册不是部署授权。未经用户针对当前 release 和当前阶段明确授权，操作员只能准备候选、检查命令合同和填写空白记录，不能
连接生产、执行 migration、写 recipe、修改快照、压缩数据或运行物理空间回收。

## 2. 三次独立授权

### 授权 A：expand-only 部署与只读观察

授权 A 允许在完整维护、备份和恢复门禁下部署包含 HC2 expand migration 的同一前后端 release，并执行：

- 无正文容量指标观察；
- PostgreSQL 强制只读 planner；
- 恢复历史列表、详情、比较和恢复的只读/受控验收；
- 一致备份验证与隔离恢复演练。

授权 A **不允许**使用 `--apply`，也不允许写 hash/recipe、清空 payload、切换 storage mode、运行 compactor 或物理回收。

### 授权 B：指定文件的小批量影子 recipe

授权 B 必须在授权 A 的生产观察稳定、一致备份可验证且隔离恢复演练通过后单独取得。它只允许：

- 对明确列出的非关键 annotation file UUID 先执行 shadow dry-run；
- 对同一文件显式使用一次 `--apply`，建议每批 1–16 个候选；
- 立即运行 stored-recipe 强制只读复核，并重复容量/错误指标观察。

影子写入仍保留完整 inline payload，只增加可重建 recipe 证据。授权 B 不能扩大为 `--all`，不能对未列出的文件写入，也不
允许清空 payload、写 `compactedAt` 或切换为 reconstructible。

### 授权 C：nullable payload 与 compactor

payload nullable migration、正式异步 resolver 接线、storage mode 切换、compactor、归档、删除或物理空间回收属于未来独立阶段。
现有代码与本手册都不构成授权 C。进入该阶段前必须重新审查 schema、在线读写、回滚工具、磁盘余量和恢复演练结果。

## 3. 不变量与禁止操作

整个观察期必须保持：

- 当前 `AnnotationFile` payload/revision、operation、恢复快照身份和审核事实不变；
- HC2 后所有历史快照仍为 `inline`，payload 仍非空；
- 只读 planner 与 stored-recipe verifier 使用 PostgreSQL 强制只读连接；
- 报告只包含 UUID、revision、固定状态码、数量、时长和容量，不包含正文、ProjectData、operation body、媒体 URL、对象 key、
  数据库连接串、token、AccessKey 或 PlayAuth；
- 生产环境由 `/etc/xiqu-platform/xiqu-platform.env` 显式加载；package script 中的 `.env` 仅用于本机开发兜底。

明确禁止：

- 对全库执行影子 `--apply`；
- 置空或删除 recovery snapshot payload；
- 写 `storageMode=reconstructible`、`storageMode=archived` 或 `compactedAt`；
- 启动 compactor、清理任务或历史删除任务；
- 运行 `VACUUM FULL`、`pg_repack` 或其他会锁表/重写 relation 的物理回收；
- 为了让 CLI 可运行而把 TypeScript 源码复制进不可变 release；
- 把报告、备份或临时环境文件写进 Git/release 目录。

## 4. 候选 release 与现场预检

在任何生产授权执行前，记录并复核以下事实：

| 项目 | 脱敏记录 |
|---|---|
| 授权阶段 | A / B |
| 候选 commit 与 release id | `<commit>` / `<release-id>` |
| 当前 release | `<current-release-id>` |
| 当前 migration 基线 | `<last-applied-migration>` |
| 系统盘/数据盘剩余空间 | `<system-free>` / `<data-free>` |
| 维护状态 | `<enabled-or-disabled>` |
| API / analysis worker | `<status>` / `<status>` |
| 一致备份 | `<backup-id>` / `<verified-at>` |
| 隔离恢复演练 | `<drill-id>` / `<passed-at>` |
| 明确授权人和时间 | `<operator>` / `<time>` |

候选 release 必须先在隔离构建目录完成：

```bash
NEW_RELEASE=/opt/xiqu/releases/<release-id>

cd "$NEW_RELEASE"
npm run release:inspect -- --release-dir "$NEW_RELEASE"
npm run release:check

# 三条历史治理入口必须来自同一 release 的编译产物。
test -f dist/api/annotationHistoryCompactionCli.js
test -f dist/api/annotationHistoryShadowRecipeCli.js
test -f dist/api/annotationHistoryStoredRecipeVerificationCli.js
```

若候选缺少任一 `dist/api` 入口，应回到可信构建主机重新构建；不能在候选或运行中的 release 里补源码、安装开发依赖或手工改文件。

## 5. 授权 A 执行顺序

### 5.1 维护、备份与隔离恢复

严格复用 [`server-deployment.md` 第 10–12 节](./server-deployment.md#10-备份与恢复演练) 的顺序：

1. 记录当前 release、migration、磁盘、维护和服务状态；
2. 使用旧 release 开启维护并等待在途写入排空；
3. 停止 analysis worker，确认其不再领取任务；
4. 在既有维护窗口内创建并验证 PostgreSQL + 对象存储一致备份；
5. 对重要升级使用不同名称的空数据库和空对象目录完成隔离恢复演练；
6. 任一步失败都保持维护，不执行 migration 或 release 切换。

### 5.2 expand migration 与原子切换

只有授权 A、备份和恢复证据齐全后，才可按通用升级流程执行：

```bash
OLD_RELEASE="$(readlink -f /opt/xiqu/current)"
NEW_RELEASE=/opt/xiqu/releases/<release-id>

# 环境只在受控 shell 内显式加载，不写入报告或命令历史附件。
set -a
source /etc/xiqu-platform/xiqu-platform.env
set +a

cd "$NEW_RELEASE"
npm run db:deploy
npm run release:switch -- \
  --current-link /opt/xiqu/current \
  --expected-current "$OLD_RELEASE" \
  --new-release "$NEW_RELEASE"
```

随后重启 API，在维护状态下执行 readiness、只读 smoke 和 migration 基线检查。任一失败按通用回滚手册原子切回旧 release；不
使用 `db push`，也不通过手工 DDL 绕过 migration。

### 5.3 只读容量与 planner 观察

先创建 release 之外、仅运维账号可读的报告目录。输出文件采用独占创建，重复运行必须使用新文件名：

```bash
REPORT_ROOT=/var/lib/xiqu-platform/reports/annotation-history/<observation-id>
install -d -m 0700 "$REPORT_ROOT"

cd /opt/xiqu/current

# 只对明确 UUID 做首轮观察，避免一开始全库读取大量 payload。
npm run annotation-history:plan:dry-run -- \
  --annotation-file-id <annotation-file-uuid> \
  --output "$REPORT_ROOT/planner-<file-alias>.json"
```

同时记录 `/metrics` 中恢复历史 relation bytes、storage mode、payload/hash present/missing、24h/7d 增量，以及 API/数据库 CPU、
内存、连接数、慢查询和磁盘变化。指标 scrape 不应读取或 detoast payload；planner 的正文批读只由显式命令触发。

首轮只读观察应覆盖：

- 一个低历史量非关键文件；
- 一个中等历史量文件；
- 一个高历史量但仍在既定上限内的文件；
- 至少一次详情、比较、恢复预览和受控恢复闭环；
- 一次备份验证与隔离恢复后的同一事实复核。

只有小样本稳定且数据库负载在可接受范围，才可经新授权扩大只读文件列表。`--all` 是显式全库扫描，不应作为首轮命令。

### 5.4 恢复服务

完成只读观察后，按通用部署手册解除维护、启动 analysis worker，并进行登录、打开、保存、协作、媒体 Range/VOD 和分析任务验收。
观察记录必须注明用户写入恢复时间；不能因为只读指标正常就跳过标注保存闭环。

## 6. 授权 B 执行顺序

### 6.1 重新预检

授权 B 不是授权 A 的延续。执行前重新确认当前 release/migration、维护状态、API/worker、磁盘、最近一致备份、隔离恢复证据和文件
UUID 清单。文件必须是非关键候选，且其 planner 不包含扫描截断、命令缺口、旧格式阻断或未知状态。

### 6.2 dry-run、apply 与只读复核

每个文件按以下顺序单独执行，前一个完整通过后才能处理下一个：

```bash
REPORT_ROOT=/var/lib/xiqu-platform/reports/annotation-history/<shadow-run-id>
FILE_ID=<annotation-file-uuid>
FILE_ALIAS=<sanitized-alias>

install -d -m 0700 "$REPORT_ROOT"
cd /opt/xiqu/current

# 第一步仍是只读；默认候选数 16，可显式缩小，不能超过代码硬上限。
npm run annotation-history:shadow-recipe -- \
  --annotation-file-id "$FILE_ID" \
  --limit-candidates 16 \
  --output "$REPORT_ROOT/$FILE_ALIAS-dry-run.json"

# 只有单独授权 B 明确包含该 UUID 时，才可添加 --apply。
npm run annotation-history:shadow-recipe -- \
  --annotation-file-id "$FILE_ID" \
  --limit-candidates 16 \
  --apply \
  --output "$REPORT_ROOT/$FILE_ALIAS-apply.json"

# 写入后立即用独立强制只读连接复核数据库中已存 recipe。
npm run annotation-history:verify-shadow-recipes -- \
  --annotation-file-id "$FILE_ID" \
  --limit-candidates 16 \
  --output "$REPORT_ROOT/$FILE_ALIAS-verify.json"
```

复核后重新采集容量指标、planner 摘要和文件详情/比较/恢复结果。HC3a 只增加影子元数据，payload-present 数量和 relation bytes 不会
立即下降；若出现下降，应视为合同被破坏并立即停止。

## 7. 固定停止条件

出现任一情况立即停止当前阶段，保留维护/报告/备份证据，不自动修复或扩大扫描：

- 当前 release、migration、文件 revision 或授权 UUID 与记录不一致；
- 磁盘不足以同时容纳当前数据、备份、候选 migration 和回滚副本；
- 维护未排空、worker 未停止、备份校验或隔离恢复失败；
- planner/verify 报告 interrupted、truncated、blocked、recipe/hash/operation/checkpoint 漂移；
- CLI 读取源码、缺少编译入口、需要开发依赖或输出底层数据库错误；
- API/readiness、恢复历史分页、详情、比较、恢复、保存、协作或审核事实回归；
- 指标采集引起明显连接、CPU、内存、慢查询或磁盘异常；
- shadow apply 的 payload-present 减少、storage mode 改变或 `compactedAt` 非空；
- 操作范围将从指定文件/候选批次扩大到全库；
- 需要执行 payload 清理、compactor、VACUUM、pg_repack 或任何未列出的写操作。

## 8. 回滚与证据保留

- release 行为失败：保持维护，按 [`server-deployment.md` 第 12 节](./server-deployment.md#12-失败回滚) 原子切回已记录旧 release；
- expand migration：只加字段，不手工逆向删除列；应用回滚与数据库恢复是否需要执行由事故事实和备份状态决定；
- shadow recipe：完整 payload 仍在，停止后不覆盖、不清空、不批量删除 recipe；先保留报告供代码审查，必要修复另开有界任务；
- 报告与备份保存在 release/Git 之外，权限最小化；对外分享前再次去除 UUID、路径、主机、账号和时间关联信息；
- 每次命令记录 release commit、命令模式、文件别名、开始/结束时间、退出码、固定摘要和停止判断，不记录 stdout 中可能出现的正文扩展。

## 9. 脱敏观察记录模板

```text
观察编号：<observation-id>
授权阶段：A / B
授权时间与操作者：<time> / <operator-alias>
候选 release：<release-id> (<commit>)
旧 release：<release-id>
migration：<before> -> <after>
维护排空：pass / fail
worker 停止：pass / fail
一致备份与校验：<backup-alias> / pass / fail
隔离恢复：<drill-alias> / pass / fail
文件样本：<sanitized-file-aliases-and-count>
planner：inline=<count>, reconstructible=<count>, blocked=<count>, interrupted=<bool>
shadow：dry-run only / applied=<count>, blocked=<count>
stored verify：verified=<count>, blocked=<count>, truncated=<bool>
relation bytes：<before> -> <after>
24h / 7d 增量：<count> / <count>
API / DB 负载摘要：<bounded-summary>
人工验收：详情 / 比较 / 恢复 / 保存 / 协作 / 审核 / 媒体 / 分析
停止条件：none / <fixed-code>
后续决定：停止 / 继续只读 / 申请下一次独立授权
```

记录中不得粘贴 annotation payload、operation body、审核正文、媒体地址、对象 key、数据库 URL、密码、token、AccessKey、PlayAuth
或第三方原始错误。需要定位时只引用受保护报告的别名和固定错误码。
