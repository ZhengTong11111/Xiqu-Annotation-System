# 后台任务与读写链路可靠性专项路线图

## 1. 文档定位

本专项用于永久修复 2026-08-30 暴露的维护许可耗尽事故，并把现有媒体分析 worker 演进为可治理、可复用、
可观测的后台任务基础。它同时覆盖未来上传、下载、分析、导出、转码、音高、五线谱、工尺渲染和姿态估计等
长时任务可能复现的资源泄漏、重复执行、取消竞态和写入阻塞问题。

本文件是 P0-P5 的长期路线图；每轮实际执行说明只写入被 Git 忽略的 `CLAUDE_WORK.md`，实际结果写入
`docs/development-log.md`。不得把本文件改成逐次命令日志，也不得让 `CLAUDE_WORK.md` 长期堆积已完成阶段。

## 2. 已确认事故与设计结论

### 2.1 事故事实

- `POST /media-analysis/assets/batch` 实际是只读、可取消的流式读取，却曾因 HTTP 方法被维护协调器当作写入。
- 前端快速滚动会中止过时批次；旧许可依赖正常 `onResponse` 释放，中止响应可能遗留 PostgreSQL session
  advisory lock 和专用连接。
- 20 个许可耗尽后，GET/健康检查仍可工作，而登录、保存、播放会话和其他 POST 持续等待直至代理超时。
- 重启 API 只能暂时释放 session，不是永久修复。

### 2.2 长期结论

1. HTTP 方法不是完整业务语义；路由必须显式区分 `read | write | control`，非安全方法遗漏声明时默认 write。
2. 写许可跟随服务端业务 Promise，而不是客户端是否完整接收响应；真正写入不能因客户端断开而提前放行维护。
3. HTTP 流式读取必须传播中止并回收当前及后续对象 I/O，但短时读取中止不能伪装成后台任务取消。
4. 后台“共享执行”与“某个用户需要该结果”必须分离，否则重复请求、共享复用和取消无法同时正确。
5. 应用层 advisory lock 便于串行化业务判断，但数据库唯一约束才是跨实例并发的最后正确性门禁。
6. 所有等待、分页、批次、重试、日志和内存缓存必须有界；异常应返回稳定错误并可观测，不能无限挂起。

## 3. 总体不变量

- `ProcessingJob` 表示一次系统共享执行；`ProcessingJobRequest` 表示账号在资源上下文中的需求。
- 客户端只提供稳定 `clientRequestId`，服务端根据权威资源、媒体指纹、算法和配置生成 dedupe identity。
- 临时 VOD URL、PlayAuth、AccessKey、token、对象签名地址和完整 ProjectData 不进入任务表、审计或日志。
- 任务可见不等于结果可下载；结果访问始终重新执行资源自己的 `read + download` ACL。
- 普通用户取消自己的 request 不能终止其他账号仍需要的共享执行。
- worker shutdown 是“清理后重新排队”，用户取消是“清理后进入终态”，两者不得复用一个含糊布尔值。
- 成功发布、取消和失败只能有一个终态获胜；迟到取消不能删除已经原子发布的成功资产。
- 不为本专项引入 Redis、Kafka 或第二套任务队列；当前以 PostgreSQL claim、事务和约束为权威。
- P0-P5 不改变 ProjectData、标注协作命令、时间轴吸附或本地 JSON 文件格式。

## 4. 阶段总览

```text
P0 维护许可与可取消 HTTP 流
  -> P1 请求/执行分离、幂等、查询 API
  -> P2 取消、重试、worker 协作终止
  -> P3 图形化后台任务中心
  -> P4 跨读写/分析链路韧性审计与故障注入
  -> P5 生产迁移、压测、部署与人工验收
```

每个阶段必须独立完成代码审查、专项测试、完整构建、roadmap/log/AGENTS 更新和 Git 提交，工作区干净后才可
开始下一阶段。数据库阶段只能提交正式 Prisma migration，禁止用 `db push` 冒充迁移。

## 5. P0：维护许可与可取消 HTTP 流

### 目标

解除只读分析流拖垮全站 POST 的系统性风险，并建立未来路由和对象流必须复用的边界。

### 实现范围

- typed Fastify route config：`read | write | control`。
- GET/HEAD/OPTIONS 默认 read；其他方法默认 write fail closed；只读 POST 必须逐路由审计后显式声明。
- 写许可由 handler 包装器持有到业务 Promise settled，所有 fallback 幂等 release。
- 普通写锁与维护独占排空均有界；繁忙返回稳定可重试 `write_gate_busy`。
- 批量瓦片、单瓦片、媒体 Range 和资源下载共用客户端断开回收 helper。
- 指标和管理员诊断显示本实例 active/waiting/oldest permit 及固定低基数异常计数。

### 状态

- **代码已完成并提交**：`bfd223b fix maintenance write gate and abortable streams`。
- 专项、媒体分析、完整 API、部署检查和构建已通过。
- 按用户要求尚未部署生产；生产快速滚动人工验收留到 P5。

### 门禁

- 100 次连续批次中止后，当前对象流、后续对象读取和 permit 计数回到基线。
- 真正 handler 未结束时维护不能误判写入已排空。
- 新增非安全路由若不声明，自动受到 write 门禁。

## 6. P1：请求/执行分离、幂等与查询 API

### 状态

- **已完成并提交**：`47a98af feat: separate processing job requests`。
- 实际实现把业务需求 `ProcessingJobRequest` 与客户端幂等别名 `ProcessingJobRequestKey` 分开：同一账号、任务和
  资源上下文只保留一个需求，但多个标签页各自的 `clientRequestId` 都能永久精确重放。该调整比原计划把两者塞入
  一行更能表达真实语义，也为 P2 的“取消个人需求”保留唯一状态 owner。
- 媒体分析执行键、请求指纹、创建审计和查询 DTO 均只保存稳定脱敏事实；已完成 run 与 job 终态不一致时稳定失败，
  不返回无法建立幂等映射的伪成功。
- mine/related/all、summary 与 detail API 已完成；related 使用批量 ACL 和有界扫描，摘要达到上限会显式返回
  `isPartial=true`，不会把截断统计冒充精确值。

### 数据模型

- `ProcessingJob` 增加服务端生成的 `deduplicationKey`。
- 新增 `ProcessingJobRequest`：job、requester、context resource、client request id、requested time。
- 唯一约束：同账号 client request id 唯一；同 job/账号/context 唯一。
- PostgreSQL partial unique index 保证同一 dedupe key 在活动状态最多一个执行。
- 历史媒体分析 job 仅在身份可证明时按 canonical run 回填；其他任务使用唯一 legacy key，不错误合并。
- migration 遇到同 key 多个活动 job 必须 fail closed，不擅自删记录或选择 winner。

### 创建合同

- 媒体分析创建请求增加必填 `clientRequestId`；一次逻辑点击和模糊响应重试复用同一值。
- 服务端重读 annotation、audio track、primary/source media、rendition JobId、ACL 和算法配置。
- dedupe key 包含任务类型、source media、媒体 fingerprint、稳定 rendition JobId、算法版本和 config hash。
- annotation id、音轨偏移、显示名、临时 URL 和凭据不得进入 key。
- 有活动 job 时创建/复用当前用户 request；无活动 job 时原子创建 run/job/request。
- 唯一冲突重新读取 winner；同 clientRequestId 若指向不同任务事实，返回稳定 `idempotency_conflict`。
- 可复用 succeeded run 继续直接返回，不伪造新的后台执行。

### 查询合同

- `GET /api/processing-jobs?scope=mine|related|all...`
- `GET /api/processing-jobs/summary`
- `GET /api/processing-jobs/:id`
- mine 只看本人 request；related 只看当前仍可读的 context resource；all 仅 admin/super_admin。
- 稳定 keyset cursor、bounded limit、批量补齐摘要，禁止 N+1 和隐藏资源枚举。
- DTO 不暴露 dedupe key、claim、input file ids、原始 result、storage key 或供应商错误。

### 验收

- 同账号同 clientRequestId 精确重放；改变 context/identity 明确冲突。
- 多账号、多标签、多个 API 实例请求相同分析只有一个活动 job，各自有 request。
- 不同媒体/rendition/算法/config 不错误合并。
- 撤权后 related/detail 立即隐藏，管理员 all 仍受角色门禁。
- worker 继续正常 claim 和完成旧/新媒体分析任务。

## 7. P2：取消、重试与 worker 协作终止

### 状态

- **已完成**：取消/重试命令、worker 协作终止、终态竞态和陈旧 claim 恢复均已实现并通过完整回归；未提前建设
  P3 任务中心 UI，也未部署生产。
- 实际模型新增稳定 `ProcessingJobCommand` 作为取消/重试幂等事实；`ProcessingJobRequest` 保存经当前来源权限校验
  后的稳定音轨外键，使终态任务可以在重试时重新执行完整 ACL/来源验证，而不依赖旧审计 JSON。
- 最后需求取消、新需求附加和 stale recovery 共用 canonical execution 锁；worker 的 shutdown signal 与业务取消
  signal 分离。成功、取消、失败、heartbeat 和重排均使用 claim owner 条件，并把 job/run 成对放在同一事务中。
- 陈旧恢复会在锁内重读 heartbeat 和 active request；旧 worker 的迟到异常发现 claim 已转交后不会再清理新 attempt
  的分析资产。

### 状态与命令

- 增加 `cancelling`、`cancelled` 以及执行级取消时间、操作者和有界原因。
- 普通用户取消自己的 request；仍有其他 active request 时执行继续。
- 最后一个 request 取消 queued job 时直接 cancelled；running job 进入 cancelling。
- admin/super_admin 可二次确认后强制取消；teacher/annotator 不获得管理能力。
- failed 和业务允许的 cancelled 可重试；重试创建新历史执行，不原地复活旧终态。
- 所有取消/重试 mutation 使用稳定 operation/request id，响应丢失可安全重放。

### worker 合同

- worker shutdown signal 与单任务 cancellation signal 分离后组合。
- 取消检测采用 heartbeat/有界 watcher，不在每个 sample 查询数据库。
- FFmpeg、来源流、瓦片循环、staging 和发布边界均响应 cancellation。
- 用户取消清理当前执行的 partial/staging 并进入 cancelled；worker shutdown 清理后重新 queued。
- 成功提交使用 claim owner + running + no-cancel 条件更新；完成与取消只能一个终态胜出。
- compensation 失败进入稳定 failed/告警，不伪报取消成功。

### 验收

- 共享 requester、最后 requester、管理员强制取消、重复取消均符合上述语义。
- queued 取消不会被 claim；running 取消能终止真实 FFmpeg/对象流。
- 迟到取消不删除成功资产，worker 重启不把用户取消重新排队。
- 已通过任务专项 8/8、媒体分析 39/39、完整 API 211/211、部署检查 28/28、完整生产构建和 `git diff --check`。

## 8. P3：图形化后台任务中心

### 状态

- **已完成**：统一任务中心、后端搜索、活动需求摘要、命令接线、轮询/中止和响应式 UI 已通过专项与完整门禁。
- 面板由 `PlatformWorkspace` 统一持有，使资源管理器和平台编辑器共享同一查询代际与命令状态；两处入口只负责
  打开任务中心，不能各自启动轮询。第一版继续复用现有 Radix Dialog、lucide 与桌面样式，不新增 UI 依赖。

### UI 架构

- 平台顶部增加“后台任务”图标和活动计数 badge。
- 使用与资源管理器一致的桌面软件风格右侧面板；窄屏使用全高覆盖。
- My / Related / All 三个视图；All 仅管理员显示。
- 支持状态、类型、搜索、分页、详情、取消自己的 request、管理员强制取消和受约束重试。
- 普通用户操作文案必须明确“取消我的任务请求”，共享执行可能继续。

### 状态 owner

- `useProcessingJobCenter` 管理分页、筛选、single-flight、Abort、网络/可见性恢复和账号代际；筛选、退出、换账号或
  手动刷新会中止已失效的列表、详情和增量读取，迟到响应不能串入新视图。
- 面板打开且有活动任务时约 2 秒 polling；无活动任务降频；关闭时只刷新 summary。
- 页面 hidden 暂停，恢复可见/online 时立即刷新；迟到响应不能污染新账号。
- 第一版不把任务状态塞入文件协作 WebSocket，HTTP 查询仍是权威来源。
- 活动 badge 使用服务端 `activeRequestCount`，只统计当前账号未取消且仍处于 queued/running/cancelling 的需求；历史
  `byStatus` 不因个人取消而消失。取消/重试响应含糊时，客户端保留同一 command UUID 精确重放。

### 验收

- 资源管理器和编辑器中均可打开，不破坏滚动、快捷键、Inspector 或媒体分析 UI。
- 权限、撤权占位、空状态、维护、断网、账号切换、长中文名称和窄窗口均正确。
- 重复点击只产生一条逻辑命令，服务端权威状态能收敛 UI。
- 已通过任务专项 10/10、任务中心模型 2/2、完整 API 213/213、部署检查 28/28、完整生产构建和
  `git diff --check`。本机浏览器没有可复用的 localhost 登录态，因此仅确认登录壳层无运行时错误；登录后的视觉与
  操作人工验收留在 P5 统一执行，不把未执行检查写成已通过。

## 9. P4：跨读写/分析链路韧性审计与故障注入

P4 不再局限于当前媒体分析入口，而是把 P0-P3 的边界横向审计到未来可能出现同类故障的链路。

### 当前状态与分轮

- **P4a、P4b 已完成，P4c 进行中**：P3 已由 commit `a122acf` 独立提交。P4 依据现有维护门禁、对象流、存储补偿和 worker 测试基础拆成
  四个可独立验证/提交的小轮，避免一个“大型故障测试”同时跨越所有 owner 后难以定位失败。
- **P4a 路由与 HTTP 流**：形成实际注册路由的机器可读 maintenance manifest，验证非安全方法默认 fail closed、显式
  read/control 例外有界；统一覆盖单对象、Range、批量对象和响应打开阶段的客户端断开。
- **P4b 数据库与对象存储**：注入 pool/事务/锁/对象读取写入/磁盘或配额失败，验证上传、复制、下载、备份和清理的
  原子性、超时、补偿与幂等边界。
- **P4c worker 与分析**：注入 FFmpeg、VOD 临时来源、对象发布、heartbeat、worker kill/restart、取消/完成竞态和多实例
  重复需求，校验 claim、资产、活动执行和终态收敛。
- **P4d 可观测性与运行手册**：补齐低基数指标、管理员诊断和故障判别手册，运行压力/故障矩阵并完成 P4 全量回归。
- 每小轮仍必须重写 `CLAUDE_WORK.md`、写 Development Log、更新本 roadmap/AGENTS 并独立提交；未经用户明确要求不
  部署生产。
- P4a 实际实现还在完整 API 压力中定位并修复了递归复制的概率性媒体外键错误：复制计划现在对资源树父子依赖和
  标注文件内部媒体依赖做确定性拓扑排序，不能再依赖 Prisma 未声明的兄弟返回顺序。
- P4a 已通过专项 17/17、完整 API 221/221、部署检查 28/28、完整生产构建和 `git diff --check`；未部署生产。
- P4b 通过 `--trace-deprecation` 证明 pg 警告来自 Prisma relation fan-out/nested write 在 adapter-pg 单事务连接上的
  query 重入，而非 collaboration LISTEN/NOTIFY。账号、资源、ACL、音轨和分析迁移改为顺序批量读取/写入并内存装配；
  完整 API 在 `--throw-deprecation` 下 225/225 通过。对象发布补偿现在覆盖“final 已形成但 promote 报错”的不确定窗口，
  数据库未提交时按 final -> staged 清理，数据库已提交后的 DTO 失败保留权威对象。未新增 migration、依赖或生产部署。

### 路由与流审计

- 生成并测试全部非安全方法路由清单；确认 read/write/control 语义和默认 fail closed。
- 审计所有 `getObjectStream`、Range、批量下载、上传 body、S3 multipart、VOD/HTTP source、FFmpeg stdin/stdout，
  确认取消传播、超时、文件句柄/连接回收和 staging compensation。
- worker、CLI、migration 等无 HTTP 客户端生命周期的流继续使用其自身 shutdown/补偿 owner，不误套 HTTP helper。

### 读写与数据库韧性

- 对数据库不可用、连接池耗尽、慢 SQL、advisory lock 繁忙、对象存储慢/断流、磁盘满、配额失败和 API 重启
  建立有界错误与恢复测试。
- 写事务在客户端断开后仍必须得到明确提交/回滚结果；不能提前释放维护许可，也不能无限占用连接。
- 读取重试不得创建业务事实；写入/任务重试必须依赖幂等键而非固定 debounce。
- 审计 upload/download/analysis/backup/restore 的 timeout、batch、pagination、memory 和 log 上限。

### 分析任务韧性

- 压测快速滚动、跨大范围跳转、反复开关波形/频谱/F0、快速切音轨和多文件切换。
- 压测同账号多标签、多账号、多 API 实例重复创建与取消。
- 注入 FFmpeg 退出、VOD 临时 URL 过期、对象读取中断、staging 发布失败、worker kill/restart 和取消/完成竞态。
- 校验没有重复 active job、孤儿对象、失联资产、遗留 claim、许可泄漏或无界日志。

### 可观测性与运行手册

- 指标覆盖任务状态、排队/运行时长、取消延迟、重试、stale recovery、compensation、permit、pool 和对象错误。
- 诊断只展示有界、低基数、脱敏事实；详细内部证据仅进入受控日志。
- 将“如何区分读取拥塞、写门禁、worker 卡住、对象存储故障”写入运维文档。

### 验收

- 故障注入后服务能自行恢复或进入稳定可诊断状态，不依赖盲目重启。
- 所有连接、stream、临时对象、claim 和 permit 回到基线。
- 用户看到的错误可重试/不可重试语义与服务器事实一致。

## 10. P5：生产迁移、压测、部署与验收

### 上线前

- P0-P4 每阶段均已提交，工作区干净，完整 API、媒体分析、worker、部署检查和 build 通过。
- 新 migration 在生产备份的隔离恢复库演练，检查历史回填、partial unique gate 和数据计数。
- 记录旧 release、commit、migration、活跃任务、对象/数据库摘要和回滚条件。
- 使用 `platform.admin` 开启维护、停止 worker、创建并验证一致备份；不得同步本地调试数据库、对象或草稿。

### 部署

- 构建完整不可变 release，包含 Prisma config/client、migrations、workspace package.json/dist 和运行依赖。
- 在候选 release 执行 `release:check` 与正式 `migrate deploy`，原子切换 `/opt/xiqu/current`。
- 维护状态下检查静态 hash、liveness、readiness、只读 API、指标和诊断，再解除维护并启动 worker。
- 不在运行 release 内 `git pull`、原地补文件或使用 `db push`。

### 线上验收

- 真实 HTTP IP 阶段验证 P0 快速滚动；未来 HTTPS/域名部署继续使用相同 route/stream 合同。
- 多账号验证任务共享、取消、重试、权限撤销和管理员治理。
- 验证登录、打开、编辑、保存、协作、VOD/上传媒体、Range、波形/频谱/F0 和资源下载无回归。
- 观察一段稳定窗口内 permit、pool、job、worker、对象错误和 orphan 指标。
- 任一 migration、readiness、对象一致性或核心闭环失败时保持维护并按已验证 release/备份回滚。

### 完成标准

- 用户人工验收通过，maintenance 解除，API/worker active，readiness healthy。
- 没有未解释的数据/对象漂移、活动任务重复、许可泄漏或高频失败。
- Development Log 记录 release、备份摘要、测试与人工验收；不得记录秘密。

## 11. 滚动执行规则

每轮严格执行：

1. 检查 Git、实际代码、测试、数据库 schema 和上一阶段 Development Log。
2. 对照本 roadmap 更新阶段状态；现实改变时先修 roadmap，不机械执行旧设想。
3. 完全重写 `CLAUDE_WORK.md`，只保留当前阶段的文件、目标、非目标、验证和审查要求。
4. 实施当前阶段；清理被替代的僵尸代码和重复路径，为复杂新逻辑写准确中文功能注释。
5. 运行专项测试、完整 API/build、必要的浏览器/协议验收和 `git diff --check`。
6. 自审功能、权限、竞态、资源释放、敏感信息、N+1/无界行为、已有功能影响和新增依赖。
7. 更新 `docs/development-log.md`、本 roadmap、总 roadmap 和必要的 `AGENTS.md`。
8. 独立提交当前阶段；确认工作区干净后，才规划下一阶段。

未经用户明确要求，不部署服务器。部署只能发生在 P5 或用户指定的阶段，并遵守维护、备份、不可变 release、
迁移和回滚规范。

## 12. 当前进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 | 代码完成，待生产验收 | commit `bfd223b`；按用户要求暂不部署 |
| P1 | 已完成 | commit `47a98af`；请求/执行分离、幂等键、查询 API 与 migration |
| P2 | 已完成 | 取消、重试、独立任务取消信号、claim fencing 与终态竞态收敛；暂不部署 |
| P3 | 已完成 | 统一任务中心、后端搜索、活动摘要、筛选/详情、取消和重试 UI；暂不部署 |
| P4 | 进行中（P4c） | P4a 路由/HTTP 流与 P4b 数据库/对象补偿已完成；下一轮注入 worker/分析故障 |
| P5 | 待开始 | 依赖 P0-P4 均已提交并通过门禁 |
