# Force Alignment 人工修正数据路线图

更新日期：2026-09-02

## 1. 产品边界

平台接收已经由外部工具生成的 force-alignment 标注 JSON。标注者在现有编辑器中修正句级、逐字和其他轨道，
服务器负责可靠保存这些人工编辑事实，并提供有界、脱敏的数据导出，供后续离线模型研究使用。

平台当前**不负责**：

- 启动或托管 force-alignment 模型；
- 创建模型运行、预测对象或预测应用流程；
- 在服务器下载媒体并生成训练输入；
- 评价模型运行、选择困难样本、切分训练集或生成训练 ZIP；
- 训练、调参、部署或在线调用对齐模型。

如果以后确实要在平台中运行模型，必须作为新的独立专项重新论证计算资源、媒体授权、模型版本、任务隔离和运维容量，
不能从本路线图推导为既定需求。

## 2. 当前数据事实

### 2.1 工具尝试

`AnnotationToolAttempt` 一行记录一次“将本句逐字重置为平均时间”的完整生命周期：

```text
id / eventName / actorUserId / annotationFileId / sentenceId
entryPoint / invokedAt / confirmedAt / finishedAt / outcome
suppressPrompt / characterCount / sentenceDurationMs
annotationOperationId / committedRevision / details.reasonCode
```

- 句级列表和时间轴右键两个入口共用同一事件合同。
- 平台模式使用独立、有界、按账号隔离的 IndexedDB 队列；断网和刷新后可续传。
- 本地免登录工具不上传行为数据。
- 取消、无变化、阻断和失败没有伪造 operation，仍可用于分析工具易用性。
- 成功尝试只能在真实 command commit 事务中标记 `committed`，并原子绑定 operation/revision。

### 2.2 人工修正

普通人工拖动和平均重置最终都已经保存为严格 annotation operation。字符 timing 命令包含：

```text
characterId / optional trackId
before.startTime / before.endTime
after.startTime / after.endTime
actor / file / operation / baseRevision / committedRevision / committedAt
```

这份 operation 是权威事实。平台不再增加一张重复保存 ProjectData 或 command payload 的训练日志表；管理员导出时才用
shared 严格 parser 提取 `entityType=character` 的 timing 叶命令，并转换为微秒整数。

## 3. 已完成阶段

### FA-D0：容量和隐私边界

- 禁止复制完整 ProjectData、媒体 URL、声学矩阵、鼠标轨迹、录屏、token、PlayAuth 或自由诊断 JSON。
- 工具尝试每次调用只保存一行，固定详情至多 2KB，不建立 JSON GIN。
- 工具尝试达到 25 万行/256MB 时告警，75 万行/768MB 时进入容量处理；告警不自动删除研究事实。

### FA-D1a：轻量工具尝试旁表

- additive migration、shared exact-key parser、服务端幂等/单调生命周期和权限复核已完成。
- actor/file/operation 删除使用 `SetNull`，避免资源生命周期意外抹除统计事实。
- 新记录要求当前文件 `write`；本人已有离线事实在撤权后仍可补完终态。

### FA-D1b：浏览器离线送达

- IndexedDB 每账号最多 2,000、全局最多 5,000 行；独立于 ProjectData 草稿和自动保存。
- Workspace 持有唯一账号级送达协调器，支持临时失败退避、401 暂停、永久坏行隔离和多标签页幂等。

### FA-D1c：真实 operation 原子绑定与工具尝试导出

- `toolAttemptId` 随 pending operation、草稿、恢复、rebase 和批次切片保持稳定。
- command commit 验证目标句、字符数、句长和 canonical 平均时间，成功后同事务绑定 operation/revision。
- 管理员工具尝试 CSV 使用 90 天半开窗口、稳定 keyset 分页、10,000 行上限和显式截断。
- 工具尝试 CSV 只含固定身份、时间、枚举、计数和 provenance，不输出命令或 timing。

### FA-R1：删除错误的服务器执行链

- 已删除 AlignmentRun、模型 executor、对齐 worker、prediction、应用评价、研究分组、训练冻结和 ZIP 发布的运行时代码、UI、DTO、
  配置、依赖与专项测试。
- 已发布到开发数据库的历史 migration 仍保留；新的 fail-closed cleanup migration 只有在所有错误功能表、任务、引用和审计事实
  都为空时才删除结构。PostgreSQL 历史 enum 值作为不可达 tombstone 保留，避免重写任务/审计大表。
- 本机 public 与 `api_test` 均通过空表门禁并完成清理；未迁移、未连接、未部署生产。

### FA-R2：人工逐字时间修正导出

- 新增唯一 `AnnotationCorrectionDatasetService`，只读既有 accepted/committed operation 与可选工具尝试关系。
- 支持直接 timing、普通 transaction 和结构 transaction 内的 timing 叶；坏 payload、非字符实体、旧快照边界和未提交操作均跳过，
  不按文件名、账号或目录猜测训练事实。
- 一行对应一个逐字修正，含 before/after 起止微秒及 delta；绑定平均重置时标记 `sentence_even_reset`，否则标记
  `manual_timing_edit`。
- 管理员 CSV 使用 90 天半开窗口、最多扫描 10,000 个候选 operation、最多导出 10,000 行并显式报告截断。
- CSV 不包含唱词/句子正文、ProjectData、任意 details、媒体 URL、对象 key、凭据或错误文本。
- 未提交的取消、失败、阻断和无变化仍由工具尝试 CSV 表达，不伪造成 timing 标签。

## 4. 使用方式

管理员可分别使用：

```text
GET /api/admin/annotation-tool-attempts/export?from=<ISO>&to=<ISO>
GET /api/admin/annotation-corrections/export?from=<ISO>&to=<ISO>
```

第一份回答“用户是否调用、确认或放弃平均重置”；第二份回答“用户实际提交了哪些逐字边界修正”。二者通过
`toolAttemptId / operationId / committedRevision` 关联，但服务器不在导出时运行模型或组装媒体训练包。

## 5. 后续仅在有实际研究需求时推进

1. 为外部导入文件增加显式、可选的来源元数据，例如外部工具名称、版本和离线运行批次；不能靠文件名猜测。
2. 在隐私和研究协议明确后，决定导出是否需要账号匿名化映射；当前导出仅限全局管理员。
3. 根据真实导出规模决定是否增加对象存储归档；在 10,000 行上限仍足够时不提前建设训练数据仓库。
4. 若需要字符正文或音频片段，先设计独立授权、脱敏、数据许可和冻结 revision 合同；不得直接扩展当前轻量日志。

## 6. 停止条件

- 需要复制 ProjectData、完整 operation payload 或媒体到新日志表；
- 需要根据文件名、目录、账号角色猜测某次编辑是否来自模型结果；
- 采集会阻塞保存、协作、草稿恢复或离开保护；
- 导出需要绕过管理员授权、时间窗、行数上限或截断声明；
- cleanup migration 发现任何错误执行链事实；必须人工导出并重新决策，不能继续删除。
