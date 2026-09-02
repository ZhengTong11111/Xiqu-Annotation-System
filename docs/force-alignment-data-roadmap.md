# Force Alignment 数据闭环路线图

更新日期：2026-09-02

## 1. 决策

Force alignment 数据采集涉及 schema、前端离线送达、annotation operation 事务、对象存储、容量监控与训练导出，
不适合一轮 `CLAUDE_WORK.md` 全部完成，采用 FA-D0 至 FA-D3 滚动实施。

生产数据库当前约 4.5GB，恢复快照已占约 4.27GB。
[`annotation-history-capacity-roadmap.md`](./annotation-history-capacity-roadmap.md) 的 HC1 已完成：生产样本证明当前格式冷历史
可以无损 recipe 重建，但大量旧格式必须继续 inline。HC2a expand schema/resolver 已完成代码与测试，HC2b-HC4 继续独立
推进；行为旁表可以在 HC2 合同稳定后开始本地开发，但生产上线必须先完成 HC2 migration 观察。两项可以共享容量指标，
绝不能把快照 compaction 与行为表 migration 混成一次上线。

## 2. 只记录高价值事实

### 立即需要

- “将本句逐字重置为平均时间”的一次调用只写一行尝试，不按打开/确认/终态制造多行。
- 保存账号、标注文件、句子 id、入口、逐字数量、句长、调用/确认/结束时间、免提示和终态。
- 成功记录与真实 annotation operation、committed revision 原子绑定；before/after 继续使用 operation，不重复写入。
- 本地不登录工具默认不上报；平台模式使用稳定 runtime UUID 和账号/文件作用域。

### 模型上线前需要

- 不可变 AlignmentRun：模型、词典、代码版本、配置 hash、文本 revision、音轨和媒体分析指纹。
- 原始逐句/逐字边界、置信度和有限候选保存为压缩对象；数据库只保存 manifest、checksum、大小和摘要。
- 明确质量标签：正确、需修改、唱词不符、漏字、重复、衬字、多人重叠、听不清、音频不同步、人声分离失真。
- 模型结果应用 operation 与 run 关联；后续人工 timing 修改继续复用现有 operation。

### 禁止采集

- 完整 ProjectData、完整 command chain、鼠标轨迹、普通滚动/播放头、录屏、临时媒体 URL、token 或 PlayAuth。
- 为普通 timing operation 复制一份 before/after 行为日志。
- 逐帧 posterior、隐藏向量、waveform/spectrogram/F0 数组；只引用已有分析资产，必要时按需重算。
- 把“没有继续修改”或账号角色直接当作正确标签。

## 3. 容量估算与门禁

- 当前 AnnotationFile payload 平均约 82KB。若 20 万次点击各复制一份，约 15.3GB；按三个阶段逐行写入约 46GB，禁止。
- 具体列 + 至多 2KB 严格详情，按含索引约 0.8-1.2KB/尝试估算：20 万次约 160-240MB，100 万次约
  0.8-1.2GB。完整备份会再次放大，因此仍需阈值。
- 若复制当前峰值 30,702 条每日 operation，会增加约 24-37MB/日、9-13GB/年；所以只记录工具调用和模型 provenance。
- 第一版只开放一个 eventName；25 万行或 256MB warning，75 万行或 768MB attention。阈值只报警，不自动删除。
- 非成功尝试未来可先导出压缩对象和日聚合，再按 manifest/恢复演练归档；`committed`、审核标签和 run 关联长期保留。

## 4. 轻量尝试模型

建议新增 `AnnotationToolAttempt`：

```text
id / eventName / actorUserId / annotationFileId / sentenceId
entryPoint / invokedAt / confirmedAt / finishedAt / outcome
suppressPrompt / characterCount / sentenceDurationMs
annotationOperationId / committedRevision / details
```

- 一行覆盖完整尝试生命周期，终态后只允许同值幂等重放。
- actor/file 删除使用 `SetNull`，不级联抹除统计事实。
- details 按 eventName 使用 exact-key parser，序列化最多 2KB，不建立 JSON GIN。
- 索引仅有 event/time、file/time、actor/time 和 operation unique。
- `committed` 不能由前端独立接口自报；command batch 同一事务验证平均分配语义并关联 operation。
- 前端使用独立 IndexedDB 小队列，不混入 ProjectData 草稿，也不阻塞保存。

## 5. 滚动阶段

### FA-D0：容量和合同规划（已完成）

- 完成生产只读测量、记录筛选、禁止项、估算和数据安全边界。
- 不修改代码或数据库。

### FA-D1a：服务端轻量旁表（代码已完成）

- 已使用独立 additive migration 建立 `AnnotationToolAttempt`，只支持 `sentence_character_even_timing_reset`；actor、file、
  operation 删除均 SetNull，旁表事实保留，现有 annotation/operation/snapshot 大表零回填、零改写。
- shared exact-key parser 与批量状态快照 API 已完成。身份字段不可变、生命周期单调补齐、终态不可改写；排序 advisory lock
  保证多标签页并发首次送达幂等，旧前缀重试不会倒退新状态。外部 API 无法写 committed/operation/revision。
- 新建需活动文件 write；本人既有记录在撤权后仍可补完，其他账号统一 404。管理员 90 天内聚合只返回固定事件、入口、终态
  计数，不返回 attempt、账号、文件、句子或 details 身份。
- details 只有固定 reasonCode 且至多 2KB；专项 5 项、command 25/5 项、完整 API 301 项和完整构建通过。不接 UI、不部署
  生产；生产上线仍必须晚于 HC2 migration 的独立观察。

### FA-D1b：前端生命周期与离线队列（代码已完成）

- 句级列表和 Timeline 已分别向唯一 App 动作传入 `sentence_list` / `timeline_context_menu`；同一 runtime UUID 单调记录
  invoked、confirm/cancel、no-change/blocked/final failure。确认框明确区分 Action 关闭与真正取消，避免一次确认被双记。
- 独立有界 IndexedDB 每账号最多 2,000、全局最多 5,000 行，不混入 ProjectData 草稿。旧前缀不能覆盖新状态，服务端确认
  只按本地 version 条件删除；损坏行不会外送。系统时钟回拨也不会制造倒序生命周期。
- `PlatformWorkspace` 持有唯一账号级送达 owner，跨文件批量最多 100；临时失败指数退避，401 等待重新登录，永久坏行二分
  隔离，多标签页依赖服务端幂等和本地条件删除。本地工具没有记录入口，完全不上报。
- 成功本地应用仍保持 pending，不由前端伪造 committed；专项 9 项、FA-D1a 5 项、命令 25/5 项、客户端原子提交 34 项、
  完整 API 301 项和完整构建通过。本阶段未部署生产。

### FA-D1c1：operation 原子绑定（代码已完成）

- pending operation 和 command batch 已增加可选、严格、批内唯一的 `toolAttemptId`；它经过 IndexedDB 草稿、恢复、
  rebase 与批次切片保持不变，并只在字段存在时进入幂等 request hash，因此旧无字段请求的历史 hash 不漂移。
- 保存前只定点送达当前批相关 attempt；浏览器存储/API 异常会移除本次网络请求的绑定字段并继续普通 command 保存，
  不污染 dirty/save/conflict/leave。成功送达、刷新恢复和 ambiguous retry 则保持同一 attempt/operation 身份。
- command commit 按稳定 UUID 锁定 pending confirmed attempt，复用 document-model 平均分配算法证明目标句字符数、句长与
  canonical after；句外 ProjectData 不得夹带变化，仅允许目标字符关联工尺的 timing 联动。operation 创建后同事务写
  committed、finishedAt、operation id 和 revision；精确重放再次核对旁表绑定。
- 本阶段无 schema 变化、零回填；伪造非平均结果、已结束或其他账号 attempt 会回滚 payload、revision、snapshot、
  operation 与 audit。专项 12/6/6 项、草稿 41 项、rebase 13 项、客户端原子提交 34 项、完整 API 304 项和完整构建通过，
  未部署生产。

### FA-D1c2：管理员统计导出（下一阶段）

- 在现有 90 天有界聚合之上增加管理员 CSV；导出重新执行管理员权限、时间窗和行数上限，不由浏览器拼接已加载结果。
- 普通用户不能读取跨账号事实；CSV 不包含 ProjectData、命令 payload、媒体 URL、凭据或其他大字段。

### FA-D2：AlignmentRun 与预测对象

- 复用 processing job 和对象存储建立 run provenance、压缩预测 artifact、manifest/checksum 与失败补偿。
- 不保存临时 URL、凭据和逐帧大矩阵；应用结果与 operation 关联。

### FA-D3：质量标签与训练导出

- 增加明确接受、异常原因和审核标签，以置信度、模型分歧和人工改动量选择困难样本。
- 导出冻结 revision 的训练 manifest，并按演员/剧目隔离 train/validation/test。
- 根据真实容量决定非成功尝试归档；没有校验对象与聚合前不删除。

## 6. 数据安全停止条件

- migration 需要回填或改写现有 annotation/operation/snapshot 大表；
- 事件复制完整 ProjectData、命令链、媒体 URL 或声学矩阵；
- committed 不能与真实 operation 原子绑定；
- IndexedDB 行为队列影响草稿、自动保存、离开保护或协作 revision；
- 数据库预计新增超过 1GB，仍没有实际指标、归档和恢复路径。
