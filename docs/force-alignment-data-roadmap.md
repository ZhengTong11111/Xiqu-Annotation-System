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

### FA-D1c2：管理员统计导出（代码已完成）

- 在现有 90 天半开时间窗聚合之上增加服务端管理员 CSV。每次导出重新执行全局管理权限，按
  `invokedAt ASC, id ASC` 分批读取，最多输出 10,000 行并以响应头明确报告条数和截断；浏览器不能用局部结果拼接跨账号事实。
- 固定列只含 attempt/event/entry/timestamps/outcome/suppressPrompt/counts/reasonCode、账号/文件/句子 id 与真实
  operation/revision provenance。不联表展开账号名、文件名或正文，不输出 details JSON、ProjectData、命令 payload、
  before/after、媒体 URL、凭据或错误文本；未知 reasonCode 留空，所有单元格复用审计 CSV 的公式注入防护。
- 普通用户稳定 403，非法、倒置或超过 90 天的时间窗稳定 400。真实 PostgreSQL 10,001 行夹具证明稳定分页和显式截断，
  HTTP 集成验证下载头与授权；专项 10 项、完整 API 309 项、平台集成 44 项和完整构建通过。本阶段无 schema/数据写入且未部署生产。

### FA-D2：AlignmentRun 与预测对象（已完成）

- 复用 processing job 和对象存储建立 run provenance、压缩预测 artifact、manifest/checksum 与失败补偿。
- 不保存临时 URL、凭据和逐帧大矩阵；应用结果与 operation 关联。

#### FA-D2a：Additive schema 与执行身份（已完成）

- 新增独立 `AlignmentRun` 与 `AlignmentArtifact`，run 固化 annotation file/revision、文本输入 hash、所选音轨及微秒偏移、
  媒体/分析指纹、模型/词典/代码版本和 config hash；删除来源实体时可空外键不能抹掉对应 snapshot id/hash。
- `ProcessingJobType` 增加 `force_alignment`，job 以可空 `alignmentRunId` 关联 run，并用数据库 CHECK 保证该列只属于该类型；
  现有 media-analysis/其他 job 不回填、不重解释。artifact 只保存 kind/format/mime/size/SHA-256/storage key，预测正文不进 PostgreSQL。
- 建立唯一 identity helper：仅稳定事实进入 hash/dedup key，账号、显示名、临时 URL、凭据、正文和完整 ProjectData 均排除。
  migration 只增表、枚举值、可空列/索引/约束，不 UPDATE/DELETE 现有 annotation、operation、snapshot、job 或媒体事实。
- 已新增唯一 `identityHash`、来源外键/snapshot 一致性、run 生命周期、artifact 容量与 force-alignment job 类型 CHECK；来源删除
  只置空导航外键，snapshot/hash、artifact 和 job 溯源继续保留。任务中心可识别“强制对齐”，但在 D2b 接入真实重试服务前
  不显示虚假的重试入口。专项 7/7、processing jobs 11/11、任务中心 2/2、完整 API 314/314 与完整构建通过；未部署生产。

#### FA-D2b：创建、复用与任务需求（已完成）

- 已增加严格创建 API。服务端按账号请求锁、文件/资源锁、音轨来源解析、canonical 执行锁的固定顺序，在事务内重读活动
  annotation file、当前 revision、稳定可对齐文本投影、默认/原声音轨、媒体来源和 `write + source read/download` 权限；
  浏览器只提供规范 UUID `clientRequestId` 和有限模型预设。投影保留句/字稳定 ID、句级范围/正文/分类并明确排除待预测逐字时间。
- 复用现有 `ProcessingJobRequest`/request key、canonical advisory lock、活动 job partial unique、取消与重试命令；同身份共享
  执行，不同账号保留独立需求。revision、文本、来源/音轨偏移、模型/词典/配置任一变化均不能错误复用；取消状态机已同时
  推进 job 与 AlignmentRun，最后需求取消 queued 执行时不会留下幽灵 run。force retry 已在 D2c 接入同一幂等命令服务。
- 文件内 run 列表/详情采用 `(createdAt,id)` 有界 keyset，每次重新验证 file read ACL，并只返回状态、计数、模型标签、当前输入
  匹配和 artifact 可用性；不暴露 dedupe/config/storage、正文、ProjectData、临时 URL 或供应商事实。历史未知模型可读但不可伪装
  为当前预设。前端在文件菜单提供低频入口，未保存/未同步或无 write 时禁用，状态与取消复用唯一后台任务中心。
- API 默认 `XIQU_FORCE_ALIGNMENT_REQUESTS_ENABLED=false`，D2c worker 未就绪时稳定 503 且零写入；显式启用仅供本阶段测试。
  专项 8/8（另含 shared parser 1/1、document projection 2/2）、processing jobs 11/11、完整 API 317/317 和完整构建通过；未部署生产。

#### FA-D2c：Worker 与预测对象原子发布（已完成）

- 已把媒体专用 runtime 收敛为唯一 processing-job runtime，并用轮转 coordinator 组合媒体分析与强制对齐 adapter。执行器采用
  shell-free 固定文件协议；正文投影和纯音频只进入私有临时目录，VOD URL 不进 argv/数据库/日志。请求开关与绝对执行器路径
  双门禁，未配置时 API 不创建、worker 不 claim。
- worker 在 claim 后及终态事务内重新验证当前 revision/文本 hash/计数、音轨/source fingerprint/offset 和至少一个活动需求账号的
  annotation/source ACL。版本化 gzip JSON 只含稳定 ID、项目时间轴微秒边界、有限候选和置信度；staged/promote 后在完整 claim
  fence 内原子提交 artifact + run + job。取消、停机重排、stale recovery、撤权、来源漂移、迟到旧 attempt、promote 模糊响应、
  数据库已提交但响应丢失和补偿失败均有稳定收口。
- 受保护读取只接受 file/run/artifact id，并逐次复核 annotation read、当前 source read/download、run/artifact/manifest 归属；不公开
  storage key。终态重试复用现有 ProcessingJobCommand 幂等 reservation：同输入重置 terminal run 并创建新 job，输入变化则创建
  新 identity。专项 12/12、processing jobs 11/11、媒体 worker 回归 20/20、完整 API 327/327 和完整构建通过；未部署生产。

#### FA-D2d：应用结果与真实 Operation 绑定（已完成）

- 已增加只增不改的 `AlignmentApplication` migration 和 operation 可空关系；application 只保留 run/artifact/file/account、
  client action、revision、数量与时间等轻量溯源，逐字 before/after 继续只存在于真实 timing operation。普通 operation 保持空关系，
  既有 annotation、snapshot、review、operation、artifact 与对象存储均未回填或改写。
- 服务端以 32 MiB 压缩/64 MiB 解压上限读取 prediction，重算 SHA-256 并严格校验 gzip/JSON/版本/run/text/offset 身份；随后从当前
  ProjectData 一次建立逐字身份索引，只生成 `timeline.items.timing.update`，每 500 项稳定分块、单 revision 最多 50,000 个变化字。
  句级时间不变，因此人工修改逐字后可使用新 action 明确再次应用同一 run；完全一致时零写入。
- application、snapshot、所有 operation、payload、sequence、revision、audit 和 revision 通知复用唯一 command commit 事务；相同
  client action 模糊重试只返回原提交，旧 revision、正文/来源漂移、撤权、损坏对象和不完整关系均 fail closed。文件菜单新增有界
  结果历史与确认应用入口，整个请求和权威回读期间阻断新编辑，浏览器不接收 prediction 或自行计算 timing。
- 专项 shared/document-model/API 9/9、请求 8/8、worker 12/12、processing jobs 11/11、完整 API 329/329、普通原子保存/前端提交回归
  与完整构建通过；迁移后在专用验证副本完成真实 HTTP `v4 -> v5 -> v6` 往返并恢复原边界。未部署生产，FA-D2 代码闭环完成。

### FA-D3：质量标签与训练导出（进行中）

#### FA-D3a1：质量评价合同与服务端事实（已完成）

- 新增 additive `AlignmentQualityAssessment`，评价必须绑定一次真实 `AlignmentApplication`，不能只对 run 或文件写一个
  无来源标签。编辑评价需要当前文件 `write`，审核评价需要当前文件 `review`；权限类型在写入时固化为有限 scope，不能
  从用户角色或后续权限变化反推。
- 评价结论只使用有限枚举：`correct | needs_adjustment | unusable`；异常原因只使用稳定代码：唱词不符、漏字、重复、衬字、
  多人重叠、听不清、音频不同步、人声分离失真、边界偏移及其他。`correct` 禁止携带异常原因，其他结论至少一个原因；
  第一版不收自由文本，避免隐私、容量和不可统计内容进入研究旁表。
- 每个 application/account/scope 只有一份当前评价，逻辑 action UUID + request hash 保证模糊重试幂等；允许同一账号之后
  明确改判，但必须通过新的 action UUID，并在 AuditLog 留下旧结论摘要与新结论摘要。评价不修改 ProjectData、revision、
  operation、snapshot、workflow status、审核确认或训练导出。
- API 只返回有限结论、原因、scope、评价人 id 和时间，不展开账号名、正文、预测或 operation payload。写入事务必须重新
  验证 application/file/run 关系和当前权限；文件已删除、关系不完整或 action UUID 漂移均 fail closed。
- 实现采用追加历史和 partial unique 当前行：相同 action 模糊重试返回原事实，后续新 action 改判会标记旧行 superseded，迟到旧
  action 不会覆盖新评价。列表最多返回 500 条当前评价并显式报告 partial；审计只记录 application id、scope 和有限旧/新枚举摘要。
  专项 shared/schema/PostgreSQL 9/9、既有应用 5/5、请求 8/8、完整 API 336/336 和完整构建通过；migration 为第 41 条纯新增迁移，
  未部署生产、未修改任何既有标注 payload/revision/operation/snapshot/review/run/application 行。

#### FA-D3a2：编辑器质量评价 UI（已完成）

- 先补文件级 application 有界 keyset 历史；run 不能代替 application，因为同一预测允许在不同 revision 被多次应用。列表只返回
  轻量 application/run 模型标签/评价计数，不展开 operation 或 assessment 全量；选中一次 application 后才读取最多 500 条当前评价，
  避免列表 N+1 和无界响应。
- 在现有强制对齐结果面板增加“预测结果 / 应用评价”两个紧凑视图；应用成功后自动选中新 application，也可重新打开历史补评。
- 编辑评价和审核评价根据有效能力分别显示，使用现有 Dialog/表单风格和固定原因多选，不新建第二套通知、轮询或状态 owner。
- UI 对模糊 HTTP 失败复用同一个 action UUID；已确认服务端结果后才清空 action。普通编辑、保存和离开保护不依赖评价成功。
- 已实现文件绑定的 `(createdAt,id)` 倒序 keyset application 历史，默认 20、最多 100；同一个 run 的多次应用保持独立记录，
  run/artifact/operation 数关系不完整时 fail closed。列表一次联表取得模型标签和当前评价数量，选中 application 后才读取评价，
  没有 N+1、operation payload、prediction、ProjectData、storage key 或媒体 URL。
- 现有结果窗口已拆为“预测结果 / 应用评价”两个紧凑视图；write/review 分别开放编辑/审核评价，两者都有时使用分段切换，无能力时
  保持只读。结论和原因沿用 D3a1 有限枚举，模糊失败只在 application/scope/verdict/canonical issues 完全相同时复用 action UUID。
- 关闭窗口或切换文件会使迟到读取/提交响应失去 UI 回写资格；服务端已完成的评价事实仍保留。评价提交只锁定自身控件，不进入
  App 的 prediction apply busy、文档 dirty、autosave、IndexedDB、undo 或 leave protection。专项质量 11/11、应用 11/11、原子保存
  34/34、完整 API 336/336 与完整构建通过；应用内浏览器停在登录页，因此未伪造登录态视觉点击验收。未部署生产。

#### FA-D3b：困难样本派生与有界选择（进行中）

- 从 prediction manifest、application、后续 timing operation 和质量评价派生置信度、模型分歧、人工改动量与明确异常原因；
  不复制 ProjectData、命令正文或声学矩阵，不把“没有继续修改”自动当成正确。
- 固化有界查询/统计边界与容量指标；训练候选必须可追溯到 run/application/revision，撤权后不可通过候选接口枚举文件内容。

##### FA-D3b1：发布期轻量预测质量摘要（已完成）

- 现有 prediction 对象含逐句/逐字置信度和每字最多三个候选边界，但 manifest 尚无可直接聚合的质量摘要。候选列表不能为每条
  application 重新下载、解压最多 64 MiB prediction，否则会形成对象存储 N+1 和不可控内存/网络成本。
- 在 prediction 已通过严格身份/时间校验后，用纯函数一次计算固定整数摘要：句/字置信度均值与最小值、低置信字数、有备选候选字数、
  与主结果置信度接近的备选字数及最大备选边界差。阈值和 ppm/微秒量纲由唯一模块固化，不保存实体 ID、正文、候选数组或自由 JSON。
- Worker 把摘要作为 v1 manifest 的可选严格字段与 artifact/run/job 在现有 claim-fenced 事务原子发布。旧 manifest 无摘要仍可读取和应用，
  只在后续候选派生中显示 `prediction_summary_unavailable`；不回填、不下载生产旧对象、不修改 schema。
- 已实现唯一 builder/parser，置信度按 ppm、边界差按微秒保存；低置信阈值 0.60、接近备选差值 0.10 只在该模块定义。空集合使用
  `null` 而不是伪装成 0 分，parser 拒绝额外字段、浮点、越界和不可能计数组合。
- Worker 在严格 prediction 校验后线性计算摘要，并在既有 artifact/run/job 成功事务写入可选 v1 manifest 字段；统一读取 helper 区分
  `ready/missing/invalid`，但摘要缺失或损坏不反向阻断 D2d prediction 读取。没有 schema、旧对象下载或回填。
- 摘要/worker 15/15、application 11/11、quality 11/11、完整 API 336/336 和完整构建通过。回归暴露既有 stale claim 测试与 20ms
  heartbeat 的时钟竞争，夹具改为向公开 `recoverStaleJobs(now)` 注入确定观察时间，没有放宽产品恢复逻辑。未部署生产。

##### FA-D3b2：Application 观察窗口与候选 API（下一阶段）

- 以 application committed revision 到下一次 application committed revision 形成互不重叠观察窗口；最新 application 的上界是当前文件
  revision。只统计窗口内非 application 绑定的逐字 timing operation，并显式报告 operation 扫描是否截断；后续再次应用模型不能伪装
  成人工调整。
- 文件级候选接口每次重新要求 `read`，使用文件绑定 keyset 和小页；一批 application 共用一次有界 operation 扫描和当前评价读取，
  不逐 application 查询。返回预测摘要、人工修改数量/边界改变量、当前有限评价与 observation revision，不返回 operation payload、
  prediction、ProjectData、正文或媒体事实。没有修改或评价只能标为 `unrated`，绝不能自动判定正确。

#### FA-D3c：冻结训练 manifest 与安全导出

- 导出冻结的 run、application、评价和目标 operation revision，生成带 checksum 的 manifest；训练输入通过受保护对象引用解析，
  浏览器和 CSV 不接收预测正文、ProjectData、临时媒体 URL 或凭据。
- 按演员/剧目等研究分组做稳定 group split，保证同组不会跨 train/validation/test；缺少分组事实时明确阻断，不以文件名猜测。
- 管理员导出使用有界 keyset/任务中心，具备取消、失败补偿、对象校验和审计；导出不会改变在线标注事实。

#### FA-D3d：容量观察、归档与闭环验收

- 根据真实表/索引/对象/备份增长决定非成功 attempt 的压缩归档阈值；没有 manifest、checksum、恢复演练和聚合替代前不删除。
- 与 history-capacity 指标共享观测口径但保持独立 migration/release；完成数据字典、训练消费说明和恢复验证后再关闭专项。

## 6. 数据安全停止条件

- migration 需要回填或改写现有 annotation/operation/snapshot 大表；
- 事件复制完整 ProjectData、命令链、媒体 URL 或声学矩阵；
- committed 不能与真实 operation 原子绑定；
- IndexedDB 行为队列影响草稿、自动保存、离开保护或协作 revision；
- 数据库预计新增超过 1GB，仍没有实际指标、归档和恢复路径。
