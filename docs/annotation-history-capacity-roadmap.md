# 标注历史与恢复快照容量治理路线图

更新日期：2026-09-01

## 1. 问题与目标

当前每次服务器 revision 成功推进前，都会把完整旧 `AnnotationFile.payload` 写成一条
`AnnotationRecoverySnapshot`。该设计保证事故恢复简单可靠，但自动保存和协作 operation 已经高频化后，完整 JSON 与
revision 一比一复制，容量随保存次数而不是研究内容增长。

目标不是删除历史，而是把“每个 revision 都有完整 JSON”改为“少量完整检查点 + 完整 operation 链 + 每个 revision 的
轻量元数据/hash”。任意被压缩的 revision 必须仍能按需无损重建、比较和恢复；无法证明重建一致的快照必须原样保留。

硬约束：现有标注、operation、恢复快照、审核事实和对象存储一个都不能因本专项丢失。所有生产压缩都必须经过
expand -> dry-run/影子验证 -> migrate -> contract，并提供停止、重试和回滚路径。

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

## 8. 预计收益

当前明显非可重放 revision 约 3,086 个，仅约 9.3%；再叠加近期窗口、周期检查点、审核引用和失败候选，保守预计可将
长期 inline payload 从 4.27GB 降至约 0.7-1.7GB，减少约 60%-85%。这是 dry-run 前的容量范围，不是上线承诺。

即便物理 relation 文件暂不缩小，清空后的 PostgreSQL 页可被后续写入复用，未来 `pg_dump` 和新备份只包含有效数据。
是否执行 `pg_repack` 或维护窗口 `VACUUM FULL` 必须根据磁盘余量、锁时长和恢复演练另行决定；本路线不自动执行。

## 9. 滚动阶段

### HC0：测量与算法设计（已完成规划）

- 生产只读容量、原因、单文件分布、revision 对应和非可重放比例测量。
- 冻结检查点、重放、hash、保护引用和停止条件。
- 不修改代码或生产数据。

### HC1：纯 dry-run 规划器

- 新增只读 planner/CLI，输出每文件 inline/reconstructible/blocked 数量、预计节省、最大重放距离和失败原因。
- 复用现有 parser/adapter，在内存中逐候选重建并与当前快照 hash 比较。
- 不新增 migration，不更新 storageMode，不删除/置空 payload，不写对象存储。
- 用复制的隔离生产数据库或经过授权的生产只读连接验证，禁止在在线 API 请求中运行全库规划。

完成标准：所有候选都有确定理由；随机和边界样本重建 hash 100% 相等；planner 中断不留下任何状态。

### HC2：Expand schema 与统一 resolver

- 加法字段/migration、inline resolver、查询分页、容量指标和受保护依赖模型。
- 现有所有行仍为 inline；详情、比较、恢复通过 resolver，但返回内容与旧实现逐字节语义一致。
- 部署并观察一轮，不做 compaction。

### HC3：影子 recipe 与小批次无损压缩

- 在不清空 payload 的情况下回填 hash/recipe，后台影子重建并持续比对。
- 先选择少量非关键测试文件，在维护/备份条件下允许 payload nullable；逐批压缩、验证、恢复演练。
- 任一失败停止该文件并保留 inline；禁止全库“一把梭”。

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
