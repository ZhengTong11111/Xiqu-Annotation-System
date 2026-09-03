# 标注历史与恢复快照容量治理路线图

更新日期：2026-09-02

## 当前权威状态（HC2 已完成，2026-09-02）

本节优先于下面按阶段记录的历史章节，供后续开发和运维接手时使用。历史章节中的“生产未执行”“等待授权 A”等
表述是当时的状态，不代表当前状态。

- 已从提交 `f8c2b1e` 组装并切换不可变生产 release `20260902T205647Z-f8c2b1e`，旧 release 仍保留为回滚候选；生产 API、analysis worker 和 Caddy 均恢复运行，维护模式已关闭。
- 已在维护窗口完成 36 -> 39 的 expand-only migration。现有标注文件、当前 payload、operation、确认、评论、反馈、审核链接和媒体对象没有被迁移脚本更新、删除或置空。
- 已完成一致备份与隔离恢复演练：备份包含 95,295 个对象且 manifest/checksum 通过；恢复后的数据库 migration、运行时状态和业务摘要，以及对象存储内容均通过核对，`missing=0`、`orphan=0`。演练数据库和临时对象目录已删除，只保留脱敏恢复报告。
- 当前生产恢复快照约 47,669 行，`storage_mode=inline`、完整 payload 47,669 行，`payload missing=0`、`reconstructible=0`、`archived=0`、canonical hash 尚未回填。快照 relation 约 6,354,526,208 bytes，24 小时新增约 14,659 行，7 天新增约 46,789 行。
- 当前数据盘约 34GB 可用，系统盘约 4.1GB 可用。因仍有标注人员在线，后续容量治理必须先做只读规划和空间门禁；不能为了释放空间把数据盘压到安全阈值以下，也不能用长锁表操作替代治理。
- 为保证恢复演练有足够空间，已删除两份最早的**完整备份副本**，删除前已核对 manifest；没有删除数据库业务行、快照 payload、operation、确认、评论、反馈、审核链接或媒体对象。当前正式备份及近几日完整备份仍保留。
- 发布后的只读观察中 API 5xx、uncaught/unhandled/fatal/Prisma error 和 worker error 均为 0；由于观察窗口没有新的用户保存/协作流量，保存 smoke 仍需在下一次低干扰窗口由真实用户操作验证，不能把“无错误”写成已完成的保存验收。
- 在线恢复历史此前出现的异常目前已恢复正常；没有新的可复现错误证据，本路线图不再把恢复历史页面防御性改造作为容量治理前置任务。后续若再次出现问题，必须先保存真实响应/浏览器错误并单独定位，不能借容量治理猜测性修改恢复链路。
- 当前分支已形成 41 条 migration 的 HC3c2 本地候选，但生产仍停在 39 条 migration；本地双形态 schema/resolver 尚未部署，也没有改变生产保存策略。

**当前硬门禁**：在线保存和恢复仍只使用完整 inline payload；禁止运行 `annotation-history:shadow-recipe --apply`、任何
`verify-shadow-recipes` 写入变体、compactor、payload 清理、`VACUUM FULL`、`pg_repack` 或删除业务历史。任何新动作都必须先
确认备份可恢复、数据盘余量足够，并能在短维护窗口内停止和回滚。

## 最新容量决策（2026-09-02）

- **历史冻结**：现有恢复快照、operation、标注、确认、评论、反馈和审核链接全部保留，不再对过去的快照做压缩、清理、置空、归档
  或物理回收。之前 HC3 中针对历史样本的 planner/shadow/nullable/compactor 设计仅作为研究记录，不再作为当前上线目标。
- **未来新增记录另行治理**：从未来明确版本开始，新增恢复记录可以使用“检查点 + 可重放 operation 范围 + 完整性 hash”的轻量表示，
  但必须先完成新的读写 resolver、保存事务、恢复/比较接口、失败回退和隔离演练。现有 inline 历史不能被迁移成新表示，旧历史与新历史
  可以并存，读取必须按存储形态分别处理。
- **不以压缩换取当前空间**：当前数据库约 6.42GB，其中恢复快照约 6.06GB；数据盘约 34GB 可用、系统盘约 4.1GB 可用。只要
  新方案不能在短维护窗口内完成并且没有足够安全余量，就继续完整保存未来快照，不执行冒险的空间回收。
- **恢复历史故障暂不作为当前容量任务**：在线恢复历史已经恢复正常，近期只读核查没有固定的恢复接口错误。保持现有读取合同不变；只有再次有可复现证据时，才建立独立的恢复历史修复任务。

## 1. 问题与目标

当前每次服务器 revision 成功推进前，都会把完整旧 `AnnotationFile.payload` 写成一条
`AnnotationRecoverySnapshot`。该设计保证事故恢复简单可靠，但自动保存和协作 operation 已经高频化后，完整 JSON 与
revision 一比一复制，容量随保存次数而不是研究内容增长。

当前决定分成两个生命周期：**既有历史冻结保留**，**未来新增快照才允许采用轻量表示**。现有每个 revision 的完整 JSON
不迁移、不压缩、不清理；未来新增记录可以在保存事务中使用“少量完整检查点 + 完整 operation 链 + 每个 revision 的轻量
元数据/hash”，但必须先完成双形态 resolver、原子保存、恢复/比较接口、失败回退和隔离演练。

硬约束：现有标注、operation、恢复快照、审核事实和对象存储一个都不能因本专项丢失。未来轻量快照必须与旧 inline 历史并存，
任何 proof、读取或磁盘安全门禁失败都回退为完整 inline；不能为了节省空间牺牲保存、协作或恢复可靠性。

## 2. 生产只读基线

2026-09-01 测量结果：

| 项目 | 当前规模 |
|---|---:|
| PostgreSQL 总大小 | 4,517MB |
| 恢复快照 | 33,183 行 / 4,265MB |
| 普通 `save` 快照 | 33,179 行，payload 约 4,084MB |
| `before_snapshot_restore` 特殊快照 | 4 行 |
| 快照 payload 平均/中位/P95/最大 | 129KB / 122KB / 296KB / 306KB |
| annotation operation | 74,435 行 / 118MB |
| 已提交 revision 组 | 33,179，恰好与普通 save 快照一一对应 |
| 含明显非可重放 action 的 revision 组 | 3,086，约占 9.3% |
| 被确认/评论 revision 直接引用的快照 | 24 |
| 近 24 小时新增快照 | 1,932 |
| 近 7 天新增快照 | 32,310 |

单文件分布已经高度倾斜：最多的文件有 6,118 个快照、payload 约 1.1GB；其后还有 3,741、3,119、2,800、2,678 个
快照的文件。单纯设置“保留最近 50 个”会丢失事故恢复能力；单纯设置“保留 7 天”在当前活跃期也几乎不减容。

按现状每天 5,000-13,000 个快照、平均 129KB 估算，逻辑 payload 增量约 0.6-1.7GB/日；PostgreSQL TOAST 会压缩，
但完整备份仍会持续放大。200+ 人继续标注时，这一模型不能长期维持。

## 3. 为什么不能直接定期删除

- `project.commit`、`track-snap.update`、snapshot boundary 和部分历史 undo/redo 不能只凭 operation clean replay。
- 快照恢复、历史比较、确认与评论引用 revision；删除 payload 前必须知道该 revision 如何重建。
- 仅按时间或每 N 条抽样会跨过非可重放边界，可能得到“有 revision 元数据但无法恢复内容”的假历史。
- PostgreSQL 删除/置空大 JSON 后普通 `VACUUM` 只让页可复用，不一定立即归还磁盘；`VACUUM FULL` 会锁表并需要额外
  临时空间，不能夹在普通发布中。
- 把所有快照原样搬到对象存储只会移动 4GB，不减少备份总量；必须使用 operation 作为无损差分，并只保留必要检查点。

## 4. 目标表示

每个恢复 revision 的元数据永久保留，payload 采用三种存储模式：

```text
inline          当前 PostgreSQL 完整 payload，读取最快
reconstructible 轻量 recipe：checkpoint + committed operation 范围 + canonical hash
archived        特殊历史的压缩对象 + manifest + checksum（只用于无法重放但不需热读的旧检查点）
```

新增字段按 expand/contract 分期落地：

```text
storageMode
payloadSha256
checkpointSnapshotId
operationSequenceStart / operationSequenceEnd
compactionVersion
compactedAt
archiveObjectId / archiveSize / archiveSha256
```

第一阶段只新增 nullable 字段，现有 `payload NOT NULL` 保持不变。只有所有读路径都支持 resolver、影子重建持续通过后，
才在后续 contract migration 允许 payload 为空；不能用一次破坏性 migration 同时改 schema、搬 33,183 行和切换 API。

## 5. 检查点选择

以下快照必须保留完整 inline 或受校验 archived payload：

- `reason != save`，尤其 `before_snapshot_restore`；
- 非可重放 revision 前后的必要检查点；
- 被确认、审核评论、编辑反馈或不可变审核包来源 revision 引用的历史；
- 最近 24 小时与每文件最近 100 个 revision，保证高频误操作可快速恢复；
- 距上一个检查点超过 100 个 revision、500 条 operation 或 6 小时时的新检查点；
- reconstruction parser、precondition、命令完整性或最终 hash 任一失败的 revision；
- 未来用户/管理员显式固定的恢复点。

规则取并集，不是互相覆盖。具体 24 小时/100 revision/500 operation/6 小时阈值必须由 dry-run 输出的保留率、最大重放
成本和文件分布校准，不能在没有生产实测前写死进删除任务。

## 6. 无损重建证明

对每个候选 revision：

1. 从最近且较早的 inline checkpoint 读取并走唯一 ProjectData normalizer；
2. 按文件内 committed revision、sequence 稳定读取完整 operation；
3. revision 中只要出现 `requires_snapshot`、缺页、sequence/revision gap 或 parser 失败，候选立即 blocked；
4. 使用服务端现有领域 adapter 逐条 apply，禁止另写近似重放器；
5. 对重建结果做 canonical JSON SHA-256，并与候选原始 payload hash 比较；
6. 只有完全相等才标记 `reconstructible`，同时保存 checkpoint 和 operation 范围；
7. 读取/恢复时重新重建并复核 hash，不相等则拒绝恢复并报告稳定诊断，绝不返回近似内容。

该证明把 operation 从“协作增量”升级为快照差分，但不会改变 operation 本身、提交顺序或保留策略。只要一个
reconstructible snapshot 存在，对应 checkpoint 和 operation 范围都成为受保护依赖，生命周期任务不得删除。

## 7. 新保存策略

初期继续同步创建完整快照，后台 compactor 只处理超过热窗口的候选，先确保保存可靠性不退化。影子运行稳定后再考虑：

- replayable command batch 默认创建轻量 revision 元数据；到检查点阈值时创建 inline payload；
- legacy/full-payload、snapshot boundary、恢复操作和任何非可重放提交始终创建 inline checkpoint；
- 快照创建与 revision/operation 仍在同一事务，不能异步到只剩 revision、没有恢复依据；
- compactor 使用文件级 advisory/row lock 和有界批次，不能与标注保存竞争长事务；
- UI 保留现有恢复历史身份，详情 endpoint 通过 resolver 读取 inline、重建或 archived payload，调用者不猜存储模式。

## 8. HC1 实测收益与修正

HC0 根据明显非可重放 revision 比例曾粗估长期 inline payload 可减少 60%-85%；HC1 生产只读样本证明该估算忽略了
历史 ProjectData 格式，因此已经失效，不能再作为容量或上线承诺。

2026-09-01 使用 PostgreSQL 强制只读连接抽取 12 个生产文件，共 4,157 个快照、8,650 个 committed operation、约
993.8MB canonical payload：

- 使用默认 24 小时 + 每文件最近 100 revision 热窗口时，441 个保留 inline，3,716 个旧格式 payload 被安全 blocked，
  当前样本没有进入 recipe 的冷候选；
- 为验证算法而临时缩小到 1 小时 + 最近 1 revision 时，414 个候选完整重放且 hash 相等，recipe 约 150KB，可替代约
  69.7MB payload；最大重放距离 93 revision / 150 operation；
- 3,716 个旧格式快照仍为 `snapshot_payload_invalid`，其中后续 3,237 个因缺少可信当前格式 checkpoint 同时标记
  `checkpoint_unavailable`；另有 1 个候选严格 apply 前置失败，全部保留原 payload；
- 4,157 份 payload 串行读取约一分钟；内存和锁风险很低，但全库逐 snapshot 单查询过慢，HC2 resolver/批处理必须设计
  有界批读，不能简单提高并发影响在线保存。

因此当前可证明收益只覆盖“当前格式 + 完整可重放 operation 链”的冷历史。旧格式若要减容，只能保留/归档其原始完整
payload，或先建立能**逐字节重建原历史格式**的专用证明；把旧格式归一化成 v7 后比较语义 hash 不等于无损恢复，禁止借此
清空原快照。

即便物理 relation 文件暂不缩小，清空后的 PostgreSQL 页可被后续写入复用，未来 `pg_dump` 和新备份只包含有效数据。
是否执行 `pg_repack` 或维护窗口 `VACUUM FULL` 必须根据磁盘余量、锁时长和恢复演练另行决定；本路线不自动执行。

## 9. 滚动阶段

### HC0：测量与算法设计（已完成规划）

- 生产只读容量、原因、单文件分布、revision 对应和非可重放比例测量。
- 冻结检查点、重放、hash、保护引用和停止条件。
- 不修改代码或生产数据。

### HC1：纯 dry-run 规划器（已完成）

- 已新增只读 policy/repository/replay/planner/CLI，输出每文件 inline/reconstructible/blocked、容量、最大重放距离和固定失败码。
- 已复用 `parseCurrentProjectData()`、shared command parser/replayability 与 `applyAnnotationCommandToProject()`；canonical hash
  复用 operation 幂等层的稳定 JSON 序列化，不存在第二套近似 apply 或 JSON 规范化。
- CLI 必须显式指定单文件或 `--all`，具备 statement timeout、2 连接池、单实例 advisory lock、SIGINT、扫描上限和
  PostgreSQL `default_transaction_read_only=on`。隔离集成测试额外尝试写入并确认由数据库拒绝。
- 未新增 migration，未更新/删除/置空 snapshot，未写对象存储，未部署 release；生产验证程序只临时放入 `/tmp`，报告
  摘要记录后已清理。
- 已确认旧 operation 路径允许在失败/未提交请求上消耗 sequence；planner 只要求 committed revision 连续覆盖、组内
  sequence 唯一稳定，不把跨 revision 合法空档误判为缺链。

完成证据：9 项专项单元/隔离 PostgreSQL 测试、25 项命令合同、5 项原子批次、34 项客户端原子提交回归和完整构建通过；
生产样本 414 个 reconstructible 候选均 hash 相等，其他候选均有固定保留/阻断理由。planner 没有数据库 mutation 方法，
生产连接也由 PostgreSQL 强制只读。

### HC2：Expand schema 与统一 resolver

#### HC2a：只加字段与 inline resolver（代码已完成，生产观察待授权）

- 已增加 expand-only migration、Prisma 字段与唯一 inline resolver；`payload` 继续 `NOT NULL`，数据库门禁只允许
  `storageMode=inline`。新增字段只包含 storage mode、可选 canonical hash 和未来 recipe 定位事实；尚无稳定 archive
  manifest 模型，因此没有提前加入含糊的对象路径/对象 id 字段，也没有建立会改变整文件级联语义的自引用外键。
- 现有所有行仍为 inline；详情、比较、恢复通过 resolver，但返回内容与旧实现逐字节语义一致。
- resolver 必须同时接受历史任意 JSON inline payload；只有 recipe 重建路径才要求当前格式。旧格式不能因 strict parser
  失败而失去详情、比较或恢复能力，也不能被归一化 v7 替代原始历史。
- 详情与恢复共用 resolver；可选 hash 不一致或未知 storage mode 均 fail closed，恢复失败发生在保护快照、revision、审计
  写入之前。列表仍只读取原有轻量摘要，公开 DTO 不暴露 storage/hash/recipe 私有字段。
- migration/API 前后兼容：迁移只有 enum、`ADD COLUMN` 和 `CHECK`，没有 payload `UPDATE/DELETE/DROP`；旧 release 可继续
  依靠列默认值保存/恢复，新 release 不回填 hash、不写 recipe、不改变在线保存事务。
- 专项 4 项、平台 API 43 项、完整 API 285 项及完整构建通过；迁移夹具证明迁移前已存在的任意 JSON 行在迁移后保持原值，
  数据库也会拒绝提前切换到 reconstructible。
- 尚未部署生产；需在明确授权的维护/迁移窗口部署并观察一轮，仍不做 compaction。该上线门禁不阻止继续开发 HC2b，
  但 HC3 生产写入和 Force Alignment 生产 migration 必须保持独立发布顺序。

#### HC2b1：恢复历史有界分页（代码已完成）

- 恢复历史列表已改为文件绑定的 opaque keyset cursor；UI 明确部分加载，不再使用固定 50 条假装完整历史。
- 摘要仍不读取 payload/storage/hash/recipe；刷新替换第一页，“加载更多”按 cursor 追加并按 snapshot id 去重，资源切换或
  刷新必须使旧续页响应失效。
- cursor 绑定 annotation file 与 `revision + createdAt + id` 倒序总序，坏游标、跨文件游标和越界 limit 明确拒绝。
- 专项 4 项、平台 API 43 项、完整 API 287 项与完整构建通过；生产未部署，前后端 page DTO 必须作为同一 release 上线。

#### HC2b2a：Planner 批读与依赖保护合同（代码已完成）

- planner repository 已改为每批最多 16 条 payload，SQL 返回先按 snapshot id 校验/建 map，再按原 revision 顺序逐条处理；
  只保留一个批次，不并行预取、不全文件物化。17 条单元夹具形成 2 批，隔离 PostgreSQL 的 33 条快照只执行 3 次 payload
  查询，原有 keep/reconstructible/blocked、hash、checkpoint 与缺行语义不变。
- 已建立唯一 checkpoint/operation 依赖保护查询：只读取 reconstructible recipe 定位列和同文件 checkpoint revision，
  不读取 payload/operation body。畸形、跨文件、缺 checkpoint、扫描截断或非法候选区间全部 fail closed；当前 inline-only
  数据返回空且有效。
- 专项 15 项、resolver 4 项、命令 25 项、原子提交 5/34 项、完整 API 292 项与完整构建通过。仍未回填 recipe/hash、
  未清空 payload、未改变在线保存/恢复，也未部署生产。

#### HC2b2b：低成本容量指标（代码已完成）

- 已新增唯一容量采集边界：一条 SQL 聚合 storage mode、payload/hash present/missing、24h/7d 新建数量，并通过
  `pg_total_relation_size` 读取 table + indexes + TOAST 总占用。查询不 select、测量、parse、hash 或 detoast payload。
- 成功结果在每个 API 实例缓存 5 分钟，并发 scrape 共用 in-flight；接入既有 OperationalMetricsCollector 和 `/metrics`，
  没有第二路由、timer、worker 或前端轮询。失败只标记采集失败并保留上一份真实 Gauge。
- Prometheus 只增加 storage mode、present/missing、24h/7d 固定标签；blocked code、最大重放距离和 operation 数继续来自
  显式只读 planner 报告。
- 专项/observability 15 项、HC1 15 项、resolver 4 项、完整 API 298 项与完整构建通过；没有 schema migration、生产部署、
  payload/recipe/hash 写入或数据清理。

#### HC2 生产观察门禁（下一阶段）

- 在明确授权后，把 HC2a/HC2b 作为同一前后端 release 部署：先执行 expand-only migration，再验证旧/新 API 列表、详情、
  恢复和 metrics；不执行 compaction。
- 记录至少一轮真实 relation bytes、storage/hash 覆盖、24h/7d 增量和 planner dry-run 基线，确认采集耗时与数据库负载。
- 只有生产 resolver、分页、依赖保护与指标均稳定，且一致备份/恢复演练完成后，才允许规划 HC3 影子 recipe 写入。

#### HC2g：生产观察手册与不可变 release 入口（代码与文档已完成，生产未执行）

- 新增 [`annotation-history-production-observation.md`](./annotation-history-production-observation.md)，把生产动作拆为三次独立授权：
  expand-only 部署/只读观察、指定非关键文件的小批量影子 recipe、未来 nullable payload/compactor。手册复用通用部署、维护、
  一致备份、隔离恢复与原子切换流程，并单独冻结样本顺序、脱敏报告、停止条件和回滚证据；前一阶段通过不会自动授权下一阶段。
- 三条历史治理 package script 已从 `tsx apps/api/src/*.ts` 改为同一不可变 release 的
  `dist/api/annotationHistory*Cli.js`。`release:inspect` 也把这些编译入口列为必需文件；候选缺失时必须重新构建，禁止把源码或开发依赖
  临时复制进服务器 release。
- 新增入口合同测试：构建后核对 package script 与三个 dist 文件，并向每个 CLI 注入不可连接的哨兵数据库地址；缺少范围参数必须
  在访问数据库之前稳定失败，输出保持有界且不能泄露连接信息。入口合同 2/2、部署专项 29/29、容量专项 33/33、完整 API
  338/338 与完整构建通过。
- 本阶段没有 schema/migration、历史算法、在线 API 或依赖变化，也没有连接生产、部署、执行 migration、写影子 recipe、清空
  payload、运行 compactor 或物理回收。下一步仍停在授权 A：只有用户明确批准当前候选后，才能按手册执行生产 HC2 观察。

#### HC2h：本地不可变候选组装演练（已完成，生产未执行）

- 从已审查 commit `5e2ed07` 重新完整构建，并严格按部署复制白名单在系统临时目录组装 554MB 候选。候选根只有
  `package.json`、lockfile、Prisma config/migrations、`packages`、`dist`、`node_modules` 和两个部署 smoke 脚本；没有 `.env`、
  `data`、docs、备份、报告、密钥或应用源码根目录，两个 workspace 链接均解析到候选内部。
- 当时的候选内 `release:inspect` 确认 30 个运行路径、27 个生产依赖和 49 条 migration；后续 HC2i 发现其中混入未部署且最终
  反向删除的 Force Alignment migration，因此该旧候选已经废弃，不能部署。`release:check` 当时确认 Prisma Client 与候选 schema
  一致。三个历史治理编译入口逐项存在并取得 SHA-256，三条 npm script 在没有数据库配置时都先以严格范围参数错误退出，未出现
  `ECONN`、Prisma、数据库 URL 或无界错误输出。
- 演练后已删除整个 554MB 临时候选并复核路径不存在，没有生成可误认作已部署 release 的 `/opt/xiqu` 状态。该证据只证明当前
  commit 可以形成完整候选，仍不构成授权 A；生产 release 必须在当次授权后从当时的明确 commit 重新构建和检查。
- 本轮完整 API 338/338、完整构建与 `git diff --check` 通过；仅修改 roadmap/Development Log，没有新增依赖、schema、migration、
  运行时代码或新的 AGENTS 规则。

#### HC2i：容量治理生产前风险审查（代码修复完成，生产未执行）

- 只读复核生产仍运行 `0f4bf69`、36 条 migration、PostgreSQL 16.15，API/worker/Caddy 正常且维护关闭。当前恢复快照已增长到
  47,474 行、总 relation 约 6.0GB；主表 heap 约 8.8MB、索引约 9.8MB，约 6.0GB 位于 TOAST。容量等价聚合的生产
  `EXPLAIN ANALYZE` 约 19ms，只扫描主表页，没有读取或解压 payload。
- HC2a/HC3a migration 只增加 enum、常量默认列、nullable 轻量列与 CHECK；没有 `UPDATE/DELETE/TRUNCATE/DROP payload`。
  PostgreSQL 16 对常量默认使用 fast default，不重写历史行；CHECK 只读取新增轻量列。正式执行仍必须在维护排空并停止 worker 后
  取得表锁，不能把低扫描成本误解为可在线无维护迁移。
- 审查发现影子 `--apply` 曾把 planner 放在普通可写连接上，导致只读门禁和 statement timeout 在 apply 模式失效；现已改为
  planner 始终使用独立强制只读连接，可写连接只在完整计划通过后创建。写服务的每个候选事务还会 `FOR SHARE` 锁定并确认
  `platform_runtime_state.platform` 仍处于维护状态；未维护或批次间退出维护固定以 `maintenance_required` 阻断且零写入。
- 已删除 10 条从未进入生产、只为错误 Force Alignment 服务端 pipeline 建表后再删表的草稿 migration，以及对应僵尸迁移测试。
  当前候选从生产 36 条基线只前进到 39 条：容量 expand、影子 recipe 字段、轻量工具尝试旁表。历史升级演练先写入现有 annotation
  payload、operation、snapshot、确认、评论、反馈和审核链接，再执行 37-39；升级前后原业务列逐项完全相等。
- 在线保存和原子命令提交仍只创建 `storageMode=inline` 且包含完整 payload 的旧式快照；容量代码没有修改 revision 发布、operation
  feed、WebSocket、确认/评论/反馈写入或审核链接。同步 inline resolver 仍是详情/恢复唯一线上入口，异步 reconstructible 协调器
  没有 ResourceService/router/config 调用点；没有自动 recipe、nullable payload、compactor、清理器或 VACUUM。
- 容量专项 34/34、生产 36 -> 39 migration 演练 1/1、发布入口 2/2、部署专项 29/29、完整 API 337/337、完整构建与
  `git diff --check` 均通过。自审没有发现会让现有保存、跨实例同步、恢复、确认/评论/反馈或审核链接失效的剩余阻断问题。
- 提交 `8f2cfb6` 后又按部署白名单完成一次不可变候选结构演练：`release:inspect` 通过 30 个运行路径、27 个生产依赖、39 条
  migration，`release:check` 的 Prisma schema 校验通过，三条历史治理 CLI 均存在；候选使用硬链接避免复制大依赖，演练后临时目录
  已清理。
  本审查只消除了已知代码门禁和迁移链风险，仍不等于授权 A，更不授权影子 apply、payload 清空、compactor 或物理回收。

### HC3：历史压缩方案（已冻结，不再执行）

HC3 原本针对已有历史快照筛选和压缩，现因生产仍有标注且用户明确要求保留过去记录而冻结。HC3a、HC3a2、HC3b1、HC3b2a、
HC3b2b 的代码和测试保留为未来研究参考，但不允许对生产既有行执行 planner apply、shadow recipe、payload nullable 清理或
storage mode 迁移。新的未来快照方案改在 HC3c 重新设计，不能沿用“批量改造旧历史”的任务单。

#### HC3a：inline 影子 recipe 候选（历史方案，冻结）

- 新增 `recipeVerifiedAt`，明确区分“完整 payload 尚在、recipe 已重建验证”和真正的 `compactedAt`。expand migration
  不执行任何历史 `UPDATE/DELETE/TRUNCATE`，`payload` 继续 `NOT NULL`，HC2a 的 inline-only 约束继续禁止
  `reconstructible/archived`；inline 行也禁止写入 `compactedAt`。
- 影子验证继续复用 HC1 当前格式 parser、正式领域 command adapter 与 canonical hash。事务外 planner 只提供候选；每个
  候选写入前取得同文件 advisory lock、`annotation_files FOR SHARE` 和目标/checkpoint snapshot 行锁，重新读取并完整重放。
  文件 revision、目标 hash、operation 范围、recipe 身份或存储模式任一漂移都会以固定码阻断并停止该文件。
- 新 CLI `annotation-history:shadow-recipe` 默认 dry-run，必须指定单文件；只有显式 `--apply` 才写入，默认最多 16、硬上限
  100 个候选，每个 recipe 最多 10,000 条 operation。完全相同的 recipe 重试不更新时间；不同已有 recipe 绝不覆盖。
- 专项 22 项验证 planner、重放、迁移、单文件写入、payload/inline 保留、幂等、revision 漂移和冲突停止；resolver 5 项、
  客户端原子保存 34 项、完整 API 323 项及完整构建通过。测试数据库已执行 migration，本机/生产业务数据库和服务器
  release 均未部署。
- 已新增真实 Prisma 历史升级演练：在独立 `_test` schema 先执行生产现有 36 条 migration，写入标注正文、operation、恢复快照、
  确认、评论、反馈和审核链接，再执行清理后的 37-39。升级前后的生产基线列逐项相等；HC2/HC3a 只新增 inline 元数据且不自动
  写 recipe，轻量工具尝试旁表独立创建。错误 Force Alignment pipeline migration 已在进入生产前删除，不再用“先建再删”证明安全。
  该本地证据不代表生产 migration、影子写入或部署已经获准。
- 本阶段不产生容量回收：payload 仍完整存在，指标中的 payload-present 数不会下降。只有完成 HC2 生产观察、一致备份/恢复
  演练，并对少量非关键文件完成真实影子观察后，才能另行设计 HC3b 的 nullable payload 与读取重建切换。

#### HC3a2：已存影子 recipe 强制只读复核（历史方案，冻结）

- 新增单文件 `annotation-history:verify-shadow-recipes` CLI 和唯一只读复核服务。它只选择已经保存完整 recipe 且仍为 inline 的
  快照，默认最多 16、硬上限 100 个候选，每个候选最多读取 10,000 条 operation；按 revision/id 稳定顺序逐条验证，首个漂移
  即停止该文件，不执行自动修复或覆盖。
- 复核在 PostgreSQL `default_transaction_read_only=on` 连接和 `REPEATABLE READ` 事务中运行，使用独立 advisory lock、statement
  timeout 和有界连接池。服务层不存在 Prisma mutation；报告只包含文件/快照身份、revision、固定状态码与计数，不输出正文、
  ProjectData、operation body、媒体地址、对象 key、数据库连接或凭据。
- 数据库 recipe 字段必须整组存在；checkpoint 必须仍属于同一文件并保持 inline，目标不能已 compact。实际重建只调用
  `reconstructAnnotationHistoryPayload()`，没有第二套 parser、领域 command apply、canonical hash 或 recipe 比较逻辑。终止信号在
  候选读取前或读取期间到达都会准确报告 interrupted，并由事务/statement timeout 提供有界退出。
- 为容量集成测试抽出一份共享完整历史夹具，删除影子写入与只读复核之间重复的账号、文件、快照和 operation 构造代码。
  `buildAnnotationHistoryRecipe()` 与纯重建内核的 snapshot 类型也收紧到实际使用的身份字段，没有改变运行语义。
- 容量专项 33/33、完整 API 334/334 与完整构建通过；自审确认没有数据库写入、在线 API、timer、worker、schema migration、
  payload 清理或生产连接。该工具可供未来生产观察使用，但本轮没有运行生产复核，也不构成影子写入、nullable migration、
  compactor、`VACUUM` 或部署授权。

#### HC3b1：统一纯重建内核（历史方案，冻结）

- 新增唯一纯函数 `reconstructAnnotationHistoryPayload()`：严格校验文件/checkpoint/target 身份、recipe version/hash/range，
  复用现有 current ProjectData parser、revision validator、正式领域 command apply、canonical hash 和 recipe builder，从有界事实
  重建目标 ProjectData。失败只返回固定低基数错误码，不查询数据库、不返回正文或 operation payload。
- HC3a 影子验证已改为该内核的薄包装；目标 inline payload 只作为“原正文仍在场”的额外格式/hash 证据。旧的重复解析、重放、
  hash 和 recipe 比较代码已删除。结构非法 recipe 返回 `recipe_invalid`，形状合法但 operation 范围漂移返回 `recipe_changed`。
- 本轮没有修改 Prisma schema、恢复历史数据库查询、详情/恢复 API 或 `resolveAnnotationRecoverySnapshotPayload()`；inline 历史任意
  JSON 仍原样返回，`reconstructible/archived` 仍 fail closed，payload 仍 `NOT NULL`，inline-only CHECK 仍生效。
- 容量专项 27/27、resolver 5/5、原子保存 34/34、完整 API 328/328 与完整构建通过；随后完成的 HC3a2 已通过唯一内核对
  数据库中的已存 recipe 提供强制只读复核。下一步仍必须先完成 HC2 生产观察、
  一致备份/恢复演练和少量影子观察；本纯内核不构成 nullable migration、compactor 或生产部署授权。

#### HC3b2a：数据库重建事实装载边界（历史方案，冻结）

- 新增 `annotationHistoryReconstructionFacts.ts`，集中读取已存 recipe、同文件 inline checkpoint 与 recipe revision 范围内的
  committed operation。每次只处理一个目标快照，operation 上限统一为 10,000；checkpoint 缺失/模式改变、recipe 字段不完整或
  operation 超限返回固定低基数错误码，不读取 annotation 当前正文、审核、媒体、对象、账号或权限。
- 该模块只负责有界数据库事实，不解析 ProjectData、不 apply command、不计算 hash、不比较 recipe，也不存在 Prisma mutation。
  HC3a2 只读复核已改为它的第一个调用者，然后把结果交给唯一纯重建内核；验证服务中旧 checkpoint/operation 查询、recipe 解析与
  旧 operation 上限常量已经删除。
- 影子 recipe 写服务仍保留自己的写前加锁重读：它面对的是尚未持久化的 planner 候选，并需要文件共享锁、snapshot `FOR UPDATE`
  与轻量元数据 UPDATE，不能错误复用只读 stored-recipe loader。两条路径共用同一个重建 operation 上限和纯重建内核，但锁与写职责
  保持分离。
- 容量专项 33/33、inline resolver 5/5、客户端原子保存 34/34、完整 API 334/334 与完整构建通过。本轮没有 schema/migration、
  payload nullable、storage mode 切换、在线详情/比较/恢复接线、生产连接或部署；现有在线 resolver 仍拒绝 reconstructible/archived。

#### HC3b2b：禁用态异步 payload 协调器（历史方案，冻结）

- 新增 `annotationRecoverySnapshotPayloadService.ts`，组合既有 inline resolver、HC3b2a 数据库事实装载和 HC3b1 纯重建内核。
  inline 继续原样返回任意历史 JSON 并校验可选 hash；archived 和默认 reconstructible 继续返回
  `snapshot_storage_mode_unsupported`。
- reconstructible 候选路径必须持有模块 Symbol 品牌的隔离测试能力，不能由 JSON、HTTP 参数或环境变量构造；能力工厂当前只在测试
  中引用。`resourceService`、router、config、env、详情、比较与恢复没有接线或启用点，因此这不是隐藏的线上 feature flag。
- 候选重建不使用 target inline payload，严格要求未来行同时满足 `payload=null` 与 `compactedAt!=null`；正文仍在或缺少压缩时间的
  半迁移状态分别固定阻断。recipe/事实/重建失败只返回 snapshot/file/revision 与低基数 code，不返回正文、hash、recipe 或 operation。
- resolver 专项 9/9、容量专项 33/33、完整 API 338/338 与完整构建通过。隔离 PostgreSQL 用真实 stored recipe、checkpoint 与
  operation 重建出目标 ProjectData，数据库行保持 inline 且逐项不变；没有 schema/migration、payload 清理、在线行为、生产连接或部署。

### HC3a0：生产只读校准与恢复读取验收（已被“历史冻结、未来治理”决策取代）

该阶段原计划用于筛选历史压缩候选，现不再作为历史治理任务执行。下面的只读门禁仍保留为未来新方案上线前的通用
安全要求，但不能据此扫描或改写现有历史。

- [ ] 从当前生产 release 的 `/etc/xiqu-platform/xiqu-platform.env` 受控加载环境，确认服务名为 `xiqu-api.service`，所有 CLI
  在 `sudo -u xiqu` 下运行；报告只写到 release/Git 之外的受控目录，不输出连接串、正文、operation body、媒体 URL、对象 key 或凭据。
- [ ] 先读取数据盘和系统盘可用空间，设置硬门禁：低于预设安全余量时只结束检查，不创建候选、不复制数据库、不做物理回收；候选和恢复临时目录必须位于数据盘。
- [ ] 只读运行容量 metrics，并按历史量分层选择少量文件：低历史量、中等历史量、高历史量各取有限样本；每次明确 file id 和扫描上限，单批保持有界，不全库并发扫描。
- [ ] 对选定文件执行 planner dry-run 和已存 recipe 的强制只读复核，比较 inline 保留数、blocked 原因、最大 operation 重放量、预计逻辑节省量和单文件耗时。旧格式失败必须继续保留 inline，不能通过归一化猜测可重建。
- [ ] 只读检查恢复历史的详情、比较、恢复和审核/评论关联读取路径，确认 inline resolver 在当前 39 条 migration 下返回与旧数据一致；不以列表数量代替内容一致性证明。
- [ ] 在隔离测试库补充与生产快照分布相近的长链、非可重放边界、旧格式和审核引用夹具，验证 planner 的停止条件、分页、恢复和低磁盘门禁。
- [ ] 输出一份脱敏校准报告，给出候选保留率、blocked 率、最大重放成本、预计逻辑节省量、数据库/对象备份增长和推荐的下一步批次；没有足够收益或余量不足时，明确结论为暂不治理。
- [ ] 完成本地专项测试、完整构建、自审和文档更新后再提交。除非用户另行明确授权，不部署本阶段代码，不进入 HC3a shadow apply。

**HC3a0 的完成条件**：只读报告可复现，恢复/比较路径通过，所有候选都有固定结论，数据盘安全余量未下降，且没有任何
生产业务事实或快照 payload 发生变化。完成后再单独评估“少量、非关键文件的 shadow recipe”是否值得进入下一阶段。

### HC3c：未来新增快照的轻量保存（滚动实施中）

本阶段只针对上线后产生的新恢复记录，绝不回写或改造现有历史。在线恢复历史已经正常，因此本阶段不再夹带没有证据的
恢复 UI 防御修改；双形态读写仍必须在正式上线前完成隔离验证。

#### HC3c1：未来快照决策边界（已完成，本地未接入线上）

- 已新增唯一的纯函数策略入口，明确 rollout、保存 reason、检查点、精确重建证明和 operation 重放预算的决策顺序。
- 未到明确 rollout、不是普通 `save`、属于检查点、证明缺失/失败/形状不合法、hash 算法版本漂移、revision/operation 范围不一致或
  超过预算时，一律要求完整 inline payload；只有完整证明通过时才返回 reconstructible recipe。
- 策略只消费现有重建内核产生的证明，不复制 parser、command apply 或 canonical hash 计算；它没有被保存服务、恢复 resolver、schema
  或生产配置调用，因此本轮不会改变线上写入和恢复行为。
- 已补充 hash 算法版本、目标/检查点 revision、operation 范围、失败回退和预算边界测试；完整 API 测试 343/343，容量专项、历史专项、
  构建和 `git diff --check` 通过。
- 本轮不修改 schema、不应用 migration、不改变现有恢复历史，不连接生产、不部署、不进入维护。

**HC3c1 完成条件已满足**：未来决策内核有明确 fail-closed 合同，旧历史和线上链路零变更；它只是 HC3c2 的本地前置能力，不能被
描述为“未来轻量快照已经上线”。

#### HC3c2：双形态数据库合同与 resolver（已完成，本地未部署）

本阶段已在本地隔离库完成可审查、可回滚的 expand 阶段；没有清理历史，也没有接入生产保存。

- [x] 先定义不可变的历史边界：HC3c2 通过显式 schema 合同识别存储形态；边界之前的行永远保持
  `inline + payload`，不能按 createdAt 猜测或迁移。
- [x] 新增第 40 条 expand migration 允许 nullable payload 和完整 reconstructible 行；第 41 条修正并保留 HC3a 的完整 payload inline
  shadow recipe。数据库拒绝 payload/recipe 半迁移、revision/operation 范围错误和 archived 未实现形态；migration 不更新旧行。
- [x] 详情与恢复动作已改为在同一事务中共用异步双形态 resolver。inline 原样校验返回；reconstructible 复用现有 loader、重建和
  canonical hash；缺事实、越权、超预算或 hash 不一致均固定 fail closed，不返回近似 ProjectData。
- [x] 删除不再需要的 Symbol 测试读取能力，避免把测试开关伪装成运行时 feature flag；没有复制 parser、command apply 或 hash。
- [x] 隔离库完成 39 -> 41 migration；旧 inline、inline shadow、完整 reconstructible、半迁移、archived 和历史业务事实升级测试通过。
- [x] 完成恢复 resolver、容量历史专项和完整 API 回归（344/344），构建与 `git diff --check` 通过；生产未连接、未迁移、未部署。

HC3c3 的本地候选仍不等于生产上线：生产当前仍是 39 条 migration 和 inline-only。只有显式 rollout、40/41 条 migration、备份/恢复演练和
短维护发布全部获授权后，线上新快照才可能使用轻量路径；在此之前保存继续完整 inline。

#### HC3c3：保存事务接线与失败补偿（已完成，本地候选未启用）

本阶段才讨论让未来新快照使用 HC3c1 的决策结果，仍先限于本地隔离库。必须先完成纯映射和事务测试，再评估短维护发布。

- [x] 新增唯一 `annotationHistoryFutureSnapshotWriter`，先创建完整 inline，再在同一事务内用既有重建内核验证；有效证明才写完整
  reconstructible recipe、`payload=null`、`compactedAt` 和 hash，所有失败路径保留 inline。
- [x] 接入普通 `ResourceService.saveAnnotationFile` 和原子 `AnnotationCommandCommitService`，已有同 revision 快照保持幂等不重算；
  保存、AnnotationFile、operation、revision、租约和工具 attempt 仍由各自原事务整体提交或回滚。
- [x] rollout 默认关闭并由 `XIQU_ANNOTATION_HISTORY_FUTURE_SNAPSHOT_ROLLOUT` 严格解析；检查点阈值统一复用容量策略，特殊 reason、首个
  快照、空/超预算/不可重放链、证明失败和旧 release 合同继续 inline/fail closed。
- [x] 集成测试覆盖有效 reconstructible 读取、证明失败 inline 回退、配置边界和旧 API 回归；完整 API 347/347、完整构建、schema guard
  与 `git diff --check` 通过。生产仍为 39 条 migration，未应用 40/41，未启用 rollout，未写入或改变任何历史事实。
- [x] 复查恢复详情、恢复、比较依赖的详情接口、备份/隔离恢复与容量指标没有复制 parser/replay/hash，也没有引入正文、operation body、
  媒体 URL、凭据或对象 key 到 recipe/日志。

#### HC3c4：本地 rollout 验收与生产发布门禁（已完成，本地未发布）

本阶段先完成本地可重复发布证明，不连接生产、不应用 production migration、不打开线上 rollout。目标是把“代码已接线”和“可以安全启用”
分成两个可审计结论。

- [x] 在隔离库验证默认 `disabled`、显式 `future-reconstructible-v1`、特殊保护 reason、有效命令链、证明失败、同 revision 幂等和事务回滚；
  有效链可由异步 resolver 无损恢复，失败/保护路径保留完整 inline，事务回滚不留下快照。
- [x] 既有容量、resolver、详情/恢复/比较和完整 API 回归继续通过；旧 inline 与新 reconstructible 共存的读取合同仍由同一 resolver 承担，
  不返回近似 ProjectData，也没有改动确认、评论、反馈、审核链接或媒体事实。
- [x] rollout 配置只接受 `disabled` 或 `future-reconstructible-v1`，默认关闭；保存 writer 只在普通/原子保存和恢复前保护入口装配，worker、
  CLI 和旧 release 不会自行打开未来写入策略。生产仍为 39 条 migration，不能把本地 41 条 schema 带入线上。
- [x] 增加低基数 rollout/回退观测：事务成功后才记录 storage 结果、固定回退原因和耗时；回滚与原子命令幂等重放不计为新写入，观测不携带
  payload、operation body、账号、媒体 URL、凭据或对象 key。
- [x] 完成专项 5/5、观测 11/11、完整 API 350/350、完整构建、Prisma schema guard、串行容量专项 35/35 和 `git diff --check`；未连接生产、
  未应用 40/41 migration、未启用 rollout、未进入维护、未部署。

#### HC3c5：生产发布前只读门禁与人工 smoke（下一轮）

本阶段仍不自动发布。只有在用户明确授权新的 release 后，才按独立任务执行生产 39 -> 41 的备份、隔离恢复、短维护迁移和回滚验证；
没有授权时只完成不写数据库的候选检查和清单审查。

- [ ] 在本地候选上运行 release inspector，逐项确认 migration 40/41、环境变量默认值、systemd 模板、worker/CLI 不会意外启用 rollout，
  并核对回滚到 39 条 migration 时旧 inline 读取合同仍明确可用。
- [ ] 设计并演练一次脱敏的备份/隔离恢复证据：数据库与对象目录位于数据盘，manifest/checksum、业务事实摘要和快照形态统计完整，
  不读取或记录正文、operation body、媒体 URL、凭据或对象 key；演练目录不得与生产源重叠。
- [ ] 在生产只读状态稳定、系统盘和数据盘均高于安全余量时，形成短维护窗口的逐步清单；没有足够空间、备份校验或恢复证据就停止，
  不应用 migration、不改变快照 payload。
- [ ] 若获授权发布，先保持 rollout=`disabled` 完成 migration 与旧 inline smoke，再由人工决定是否另一个 release 才启用
  `future-reconstructible-v1`；启用前必须核对新旧读取、普通保存、原子保存、恢复保护和观测指标。
- [ ] 发布后观察固定低基数指标、保存/协作/恢复/审核路径和磁盘余量；任何保存异常、恢复不一致、空间越线或指标异常都回滚代码开关/候选，
  不删除或改写既有历史。

**HC3c 完成条件**：旧历史零变更；未来新记录在证明成功时才使用轻量形态；所有失败路径自动保留 inline；详情/比较/恢复和
备份恢复均可读取两种形态；测试、构建、低干扰线上 smoke 和回滚证据齐全。空间不足时系统必须继续可靠保存或明确阻止治理，
不能把数据库压到安全余量以下。

### HC4：未来保存策略与运维闭环

- replayable 保存按阈值建立检查点，其余直接保存 recipe；非可重放提交保持 inline。
- 增加管理员容量面板、compactor 进度/取消/重试、固定 Prometheus 指标和磁盘/备份增长告警。
- 根据真实 relation/backup 增量决定是否归档旧 inline checkpoint，以及是否维护窗口物理回收 PostgreSQL 空间。

## 10. 停止条件

- 任何候选无法从一个受保护 checkpoint 连续重放到目标 revision；
- operation 缺失、不可解析、requires snapshot、前置条件失败或重建 hash 不一致；
- compactor 需要修改 AnnotationFile 当前 payload、revision、operation 或审核事实；
- migration 会长时间重写/锁住 4GB 快照表；
- resolver 未覆盖列表详情、比较、恢复、备份/恢复检查和诊断；
- 尚未完成一致备份、恢复演练或回滚验证就准备清空现有 payload；
- 数据盘不足以同时容纳旧数据、候选迁移与回滚副本。
