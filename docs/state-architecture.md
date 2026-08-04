# 标注文档状态与同步架构

本文档说明编辑器本地状态、平台 annotation file 和未来同步层之间的当前边界。

最后更新：2026-08-04

## 1. 三个层次

### 1.1 本地领域文档

`ProjectData` 是时间轴标注内容，与平台账号、资源 ACL、服务器 revision 分离。它可以通过本地
JSON 导入导出，也可以作为平台 `AnnotationFile.payload` 保存。

R5b3a1 起，持久化 `ProjectData`、`SavedProjectFile`、轨道/递归分叉和标注实体的唯一 TypeScript 定义位于
`packages/document-model/src/projectData.ts`。`src/types.ts` 只通过 type re-export 兼容既有 Web import，并
继续拥有 Inspector 聚焦、派生轨道、波形/频谱缓存和 Timeline 选择等运行时类型。共享 document-model 不得
依赖 React、DOM、Prisma 或 Fastify；平台 revision、ACL、session 和协作 presence/activity 也不得进入该模型。

### 1.2 客户端文档状态

`src/state/projectDocumentState.ts` 的 `useProjectDocumentState()` 是编辑器内的权威状态边界：

- `project` / `projectRef`
- `trackSnapEnabled` / ref
- undo / redo
- `hasUnsavedChanges`
- local operation log / pending operations
- local revision / saved revision
- `saved`、`dirty`、`saving`、`offline`、`conflict`、`error`
- transient drag baseline

`projectRef.current` 服务热交互路径，避免 pointer 事件闭包读取陈旧 render state。

### 1.3 平台持久化

一个平台 `annotation_file` 保存：

- 当前完整 payload。
- 服务器整数 revision。
- 最近编辑者和时间。
- 覆盖前恢复快照。

资源 ACL/revision 不写入 `ProjectData`。本地 JSON file version 也不代替服务器 revision。

## 2. 修改与历史契约

### `commitProject()`

用于一次已完成的用户修改：

- 建立一个 undo 历史项。
- 清除 redo。
- 增加 local revision。
- 记录一个 pending operation。

### `applyProjectWithoutHistory()`

用于拖动过程中的瞬时预览：

- 不为每个 pointer frame 生成历史或 operation。
- 保存拖动前基线。
- pointer-up 时再用 `commitProject()` 形成一个历史项。

不得把连续多个已完成拖动合成一个历史项，也不得把每帧拖动写入 operation log。

### `markProjectAsSaved()`

只在确认某个固定快照已成功持久化后调用：

- 推进 saved baseline。
- 只确认该保存请求覆盖的 operation ids。
- 保存期间产生的新 operation 继续保持 pending/dirty。

本地文件保存与平台保存可复用确认边界，但平台保存还需要服务器 revision。

## 3. 当前平台保存流程

1. 固定 project、UI state、pending operation id 和服务器 base revision 快照。
2. 将尚未 submitted 的 operation 顺序写入服务端 operation log：已迁移的纯时间编辑发送 versioned
   domain command，其他编辑发送 legacy 摘要。
3. 调用 annotation-file save API 写入固定完整 payload。
4. 成功后更新 remote revision，并只确认本次覆盖的 operation ids。
5. 失败时保留本地 pending operations：
   - 409 -> `conflict`
   - 明确离线 -> `offline`
   - 其他 -> `error`

`submitted` 只表示 operation 摘要已写入日志，不表示 payload 已保存。每条 operation 使用稳定
`clientOperationId`，服务端在“标注文件 + 账号 + clientOperationId”作用域内按请求指纹幂等接收；
响应丢失或完整保存推进 revision 后，完全相同请求仍可安全重放。

### 3.1 R4c1 自动保存调度

- `platformAutoSavePolicy.ts` 只根据 enabled/dirty/online/suspended/status/in-flight 与 idle/retry dueAt
  返回禁用、阻断、等待或立即保存，不读取 ProjectData，也不执行网络请求。
- `usePlatformAutoSave()` 只拥有一个 timer 和一个 in-flight 请求。新 local revision 重置空闲窗口；
  保存中继续编辑不会重入，请求结束后仍 dirty 才安排下一窗口。
- 自动保存和手动保存调用同一 `saveProjectToServer()` 事务并消费结构化 outcome。自动模式不打断尚未
  提交的文本输入，也不弹阻塞 alert；手动模式可提交当前输入并立即显示错误。
- offline 不发请求；online 恢复后重试。网络层、408、429、5xx 使用 2 秒起步、60 秒封顶的指数退避；
  409 进入 conflict，确定 4xx/程序错误进入不可自动重试 error。
- pending merge draft 暂停自动保存。页面卸载不启动 fetch/beacon，因为它无法维持 operation、payload、
  revision 与权限事务；dirty beforeunload 提示和 IndexedDB envelope 负责本地恢复。

## 4. Operation log 的当前边界

R5a1 建立了首批 version 1 `timeline.items.timing.update` envelope。一个命令可原子记录 sentence、
character、action、custom-block、attached-point、gongche-block 和 banyan-mark 的稳定目标与 before/after；
点状实体使用零长度区间。逐字/句块/自定义文字块移动所引起的句界和工尺派生时间也必须进入同一命令。
R5a4a 又加入 `annotation.items.content.update`，覆盖 sentence.text、character.char、action.label、
custom-block.text/type 和 attached-point.label。
R5a4b1 再加入 `annotation.items.lifecycle.update`，首批覆盖 custom-block 与 attached-point 叶实体；
R5a4b2 扩到 sentence、character 和完整 Gongche block，并用 `annotation.transaction.apply` 原子组合句同步
和父子级联。旧 `actionAnnotations` 是导入兼容字段，不再扩展新协议。

R5a4b3 新增 `annotation.items.state.update`，用于稳定实体仍存在但多个耦合字段需要整体替换的 Gongche
symbol、Banyan mark 和 Banyan section；同轮 lifecycle 也支持这三类实体的创建删除。

R5a4c2 新增顶层 `annotation.track.structure.update`，只更新已经存在的自定义文字/动作轨。一个 item 保存
轨道元数据、完整递归分叉树和该轨全部块的分叉归属，但不包含块时间、文本、类型或附属点内容。before/
after 必须保持轨道类型与 block 身份集合不变；lane 父子位置、block 父引用、循环、悬空 scope、排序和总
预算均由 shared parser fail closed。它不能嵌入普通 transaction，以免需要独占租约的结构写入被隐藏。

R5a4c3 新增 `annotation.track.structure.transaction.apply`。它是唯一可以直接组合结构叶命令与普通
content/lifecycle/state/timing 叶命令的顶层容器，必须包含至少一个结构叶命令，禁止递归或嵌入普通
`annotation.transaction.apply`。新增的 custom-track lifecycle 叶命令保存整轨拥有的 block、附属点轨/点，
以及 `customTracks`、`activeTrackOrder` 的精确位置；attached-point-track lifecycle 保存父轨类型、父集合
位置和展开状态。结构事务最多 20 个子命令、总成本最多 500，inverse 逆序反转全部叶命令。整轨删除可按
板眼 state 断链、工尺 lifecycle 删除、轨道 lifecycle 删除的顺序形成一条原子事实；自定义 typeOptions
重命名/删除可把结构快照与命中块 type 的 content 更新组合在同一事实中。

R5a4c4b 又新增内建轨生命周期 leaf。非空快照保存完整 `BuiltinTrack`（含附属点轨/点）以及它在
`builtinTracks`、`activeTrackOrder` 中的精确位置；逐字、工尺和板眼修复仍作为有依赖顺序的普通
lifecycle/state 子命令显式组合，不在轨道快照中重复保存。当前唯一合法内建轨身份是
`character-track` / `character`，unknown 输入不能借生命周期命令创建任意内建轨类型。

无法安全压缩到 500 实体预算的批量导入、修复和内建轨超量删除使用
`annotation.project.snapshot.boundary`。该 envelope 只保存稳定 boundary id、受控 kind 和方向，不保存
`ProjectData`；它是合法、受 mutation lease 保护但**不可 committed-feed 重放**的领域事实。草稿与历史可
保存该小型边界，undo/redo 通过 inverse 继续取得对应的 `bulk_import` 或 `bulk_repair` 租约；clean catch-up
遇到边界必须舍弃局部重放结果并读取权威 snapshot。

命令由本次 undo 的真实 `baseProject` 和最终 `nextProject` 提取。连续拖动仍只在 pointer-up 形成一条
operation；若目标缺失、id 不满足协议、超过 500 项，或同一次编辑还修改了合同外字段，普通实体调用点可
保留 legacy `project.commit`；受租约保护的结构调用点则必须阻止提交并显示错误，不能把无法证明完整的
结构变化静默降级成可保存的 legacy 快照。

当前 operation 是“领域命令与摘要并存”的渐进阶段：

- version 1 时间、稳定内容、生命周期、状态、依赖事务、既有自定义轨道结构命令和有界结构事务可严格验证、持久化和幂等重放请求，但服务端尚未
  apply 到 payload。
- 自定义轨道结构 history 的 undo/redo 已分别记录 inverse/正向领域命令；整条自定义轨、内建逐字轨、附属
  点轨生命周期，自定义类型选项内容联动、既有内建轨/点轨配置和顶层轨道排序也已进入结构事务。逐字唱法
  已是稳定 content 字段；批量导入/修复使用不可重放的受控快照边界。四声、分句合句等剩余编辑仍有 legacy
  摘要，不可领域重放。
- 它不会修改 annotation file payload。
- 它不能作为恢复完整项目的唯一来源。
- 不应把完整 before/after `ProjectData` 复制进每一条 operation。

### 4.1 R5a2a 命令执行语义

领域命令执行固定经过 `parse -> resolve actual -> assess all preconditions -> immutable apply`：

1. shared parser 先规范化 envelope；无效输入直接 `invalid_command`。
2. ProjectData adapter 按稳定目标解析当前时间，轨道内实体必须同时命中 track id。
3. shared assessment 一次检查全部 before；半毫秒内浮点差异允许通过，缺失或冲突返回稳定 target key、
   expected 和 actual。任一问题都会阻断整个命令。
4. 只有 `ready` 才按实体集合不可变写入 after。命令已包含句界/工尺派生变化，apply 不再运行同步 helper。
5. inverse 交换所有 before/after 并重新校验，可恢复目标时间。板眼 apply 还会维护 manualOffset 与 manual
   confidence；这些派生审校字段目前不属于 inverse payload，所以 inverse 保证时间恢复而非完整对象字节相同。

该纯 adapter 当前用于合同证明和未来远端接入测试，尚未替换成熟的本地直接编辑或 undo/redo 路径。

### 4.2 R5a2b 服务端顺序与续读合同

每个 `AnnotationFile` 保存 `lastOperationSequence`，每条 `AnnotationOperation` 保存文件内唯一 sequence。
新请求在同一文件行的排他锁内依次执行“幂等二次检查、base revision 检查、计数器递增、operation 创建”；
相同幂等键重放返回原 sequence，不同文件不共享全局锁。历史数据迁移按 `(createdAt, id)` 为每个文件稳定
回填 1..N，不能清空旧 operation 或以运行时 `max(sequence)+1` 代替事务计数器。

读取接口按 sequence 升序提供有界 page：默认 100、最大 200。opaque cursor 包含协议版本、文件 id 和
已观察到的 sequence；空页保持原 cursor，便于后续轮询不倒退。cursor 不是权限凭证，每次 GET 仍需实时
通过 read capability。`domain_command` 表示 payload 可通过 shared parser；`requires_snapshot` 表示只可
审计，不能 apply。

必须区分三件事：operation sequence 是**日志接收顺序**，读取 cursor 是**客户端观察位置**，annotation
file revision 才是**权威完整 payload 的保存版本**。当前服务端不会把领域命令 apply 到 payload，因此一条
operation 已分配 sequence 不等于对应快照已经保存。R5a3 必须先建立 operation 与 snapshot revision 的
确认事实及 HTTP catch-up 协调，再接实时传输。

### 4.3 R5a3a operation 与 snapshot 的原子提交事实

`AnnotationOperation.committedRevision/committedAt` 只有在完整 payload 保存事务成功时才写入。客户端 PUT
发送保存开始时固定的全部 `clientOperationIds`，包括前一次 POST 成功但 PUT 失败后仍为 submitted 的项；
服务端要求它们全部属于当前文件、当前 actor、当前 base revision 且尚未提交。恢复快照、payload revision、
operation 绑定和保存审计同成同败。空数组允许无 operation 的系统保存；历史 operation 无法证明属于哪次
快照，迁移后保持 null。

R5a2b acceptance feed 与 R5a3a committed feed 不能共用 cursor：前者按接收 sequence，后者只读取非空
committedRevision，并按 `(committedRevision, sequence)`。因此一个旧-base accepted operation 可以永久留在
日志中，却不会阻塞后续 revision 的已提交续读。`AnnotationFile.operationCursor` 是服务器为当前 payload
revision 生成的 committed-feed 起点；它跳过该 revision 的全部操作。committed page 同时返回服务器当前
revision，后续协调器据此识别“revision 推进但没有 operation”的快照刷新场景。

### 4.4 R5a3b clean-only HTTP catch-up

平台编辑器从 `AnnotationFile.operationCursor` 和 payload revision 启动独立 catch-up 运行时。运行时每个
文件只持有一个 timer 和一个在途请求；文件切换、React Strict Effects 清理和 dispose 都使旧 generation
失效。网络失败保留 cursor 并短退避，不能把 clean 文档改成保存冲突。

纯 coordinator 按 committed revision、acceptance sequence 验证全部页：cursor 必须前进，记录必须属于
当前文件并处于 committed/accepted 状态，从已知 revision 到服务器 currentRevision 不得缺号。只有所有
operation 都是已知 versioned command，且在局部 `ProjectData` 上逐条通过 before precondition，才返回
一个原子 applied 项目；任何 legacy、坏页、revision gap、分页预算耗尽或前置失败都只返回
`requires_snapshot`，不泄漏已经应用了一半的局部值。

document state 的 `replaceCleanProjectFromRemote()` 是最终写入门禁：current 与 saved 必须相等，pending
为空、没有 transient，sync status 必须为 saved。成功后 current/saved 同时推进并清空旧 undo/redo；不会
生成本地 history、operation 或 dirty。App 还会在行内文字编辑、待确认整合和保存期间暂停运行时。快照
降级复用 `hydrateProjectForClient()` 这一条迁移路径，并在 GET 返回后再次复核文件 revision/cursor 和
document clean 状态。

这不是自动 rebase：dirty 内容永远优先保留，协调器等待保存成功或人工解决冲突。它也不替代 WebSocket、
presence、服务端命令执行或后续更广的领域命令覆盖。

### 4.5 R5a4a 稳定内容更新命令

内容命令的 shared item 使用 `entityType/entityId/trackId/field/before/after`，其中实体与字段严格配对：句和
逐字不允许 track scope，动作、自定义块和附属点必须带正确 track id；字符串长度、额外字段、重复目标和
no-op 均 fail closed。通用 parser 只按 command type 分派到 timing/content 单域 parser，不以联合类型放宽
原有 timing 合同。

`buildProjectAnnotationContentCommand()` 不只读取声明目标。它会用和 replay 相同的纯写入器从 base 重建
项目，并递归比较完整 next；同一次 UI 提交若还改变时间、四声、分叉、typeOptions 或其他未声明字段，
builder 返回 null，document state 继续记录 legacy snapshot operation。这样不会为了提高领域命令覆盖率
而漏记派生变化。

内容 adapter 固定执行 `parse -> resolve all actuals -> assess all before -> immutable apply`，五类实体任一
缺失、错轨或 before 冲突都会阻断整批。草稿 unknown 边界、平台请求和 API 使用同一 envelope/action
合同；repository 不再硬编码 timing action，而以任一合法 command type 判断 `domain_command`。clean
catch-up 通过通用 ProjectData dispatcher 顺序重放 timing/content 混合 revision 链，最后一项失败时仍只
要求权威快照，不泄漏前面已应用的局部项目。

当前 App 只在精确单字段提交时生成内容命令：逐字 char 同时显式记录派生句 text；动作 label、自定义块
text/type、附属点 label 各自使用稳定目标。本节建立时创建/删除仍是 legacy；R5a4b1 已迁移其中无级联的
custom-block/attached-point 路径，详见下一节。复合编辑和 undo/redo 仍保留 legacy；服务器仍不直接执行
命令写 payload。

### 4.6 R5a4b1 叶实体生命周期命令

生命周期 item 使用 `entityType/entityId/trackId/before/after`。before/after 必须恰有一侧为 null，非空侧
同时保存完整实体快照与 `index/collectionLength/previousEntityId/nextEntityId`。因此该协议只能表达创建或
删除，不能伪装成实体更新；inverse 交换两侧后能把删除实体恢复到原集合顺序。

shared parser 严格限制 custom-block 与 attached-point 两类当前实体，校验文字/动作块差异、分叉 laneIds、
点时间、字符串、父 scope、重复目标、集合长度和索引。ProjectData adapter 先唯一解析父轨/附属点轨，
再检查全部目标存在性、完整 before 实体和位置；同一集合的多项变化先整体删除，再按最终 index 一次放置，
禁止逐项 splice 造成索引漂移。任何父容器、相邻 id、集合长度或实体快照冲突都阻断整批。

`buildProjectAnnotationLifecycleCommand()` 与内容 builder 一样，会用 replay 的同一写入器重建完整 next 并
递归比较整个 ProjectData。自定义块删除若还级联移除工尺块、混合多选还删除字符/板眼，或存在其他合同外
变化，builder 返回 null 并保留 legacy snapshot。App 当前接入自定义文字/动作块创建、无工尺级联删除、
附属点创建/删除和只含这些目标的多选删除。后续 R5a4b2/R5a4b3 又扩展了句、逐字、工尺和板眼实体；
草稿、API replayability 与 clean catch-up 现在通过通用 parser/dispatcher 接受
timing/content/state/lifecycle/transaction 混合 revision 链。

旧 `actionAnnotations` 已在导入归一化时迁移为 custom action block 并清空。本阶段没有为了“覆盖动作创建”
给该兼容数组继续增加生命周期协议。下一阶段应处理逐字/句与自定义块工尺依赖闭包，而不是恢复旧模型。

R5a4c2 已处理既有自定义轨道的元数据、递归分叉和块归属。整轨/附属点轨生命周期、会级联改块类型的
typeOptions 编辑和批量导入仍需要各自有界事务，不能强拆成没有原子边界的小操作。

### 4.7 R5a4b2 逐字、句与工尺依赖事务

`annotation.transaction.apply` 只允许顺序包含 timing/content/state/lifecycle 四种已严格校验的叶命令，禁止递归
事务、空事务和超出总实体预算的嵌套负载。inverse 逆序排列子命令并逐一反向；ProjectData adapter 只在
局部变量上顺序执行，任一子命令 invalid 或 before 冲突便丢弃局部结果。因此一个 committed revision 不会
暴露“逐字已删除但句或工尺尚未同步”的中间态。

lifecycle 快照现包含 sentence、character（含规范四声快照）、custom-block、attached-point 和完整 Gongche
block/symbol 序列。句、逐字和工尺分别是项目级集合；工尺的 trackId 只用于父引用寻址，不能误当成物理
子集合分组。批次先重建全部集合，再统一验证 `character.lineId` 以及工尺到逐字/自定义块的最终引用，所以
父子可以同批创建或同批删除，孤儿结果则整体失败。

App 已迁移已有句加字、新句首字、删字同步句、删末字同步删句、逐字/自定义块的工尺级联，以及显式工尺
块创建删除。transaction builder 仍用 replay adapter 从 base 重建完整 next；混合板眼、旧 action、分句重排
或其他未声明变化时返回 null 并保留 legacy snapshot。草稿、API replayability 和 clean catch-up 都把事务
作为一个 operation/revision 事实，服务端仍不直接 apply 到权威 payload。

### 4.8 R5a4b3 工尺符号与板眼复合状态

`annotation.items.state.update` 保存同一稳定实体的完整 before/after 快照，不承担创建、删除、换父集合或
集合重排。Gongche symbol 以父 Gongche block id 作为协议 scope；Banyan mark/section 位于项目级集合。
shared parser 严格验证字段、枚举、时间、链接数组、no-op、重复目标和总预算，target key 使用 JSON 元组，
避免允许冒号的合法 id 在字符串拼接时碰撞。

state 与 lifecycle 共用规范快照转换和同一板眼/工尺引用门禁。任何 mark.sectionId、linked Gongche block 或
symbol 指向最终项目外部时，ProjectData adapter 返回 `result_invalid`，不发布半成品。删除 Gongche block/
symbol 不删除研究记录，而是清除失效链接并设置 orphaned；正向事务按 state → lifecycle 先断链后删除，
inverse 逆序先恢复实体再恢复链接。

Inspector 快速输入按索引复用已有 symbol id，仅新增尾项生成新 id；添加/删除及时间重分配保留未删除实体
的元数据。整段工尺导入、内建轨删除等仍可使用 legacy 快照，但提交前必须经过同一引用修复。自动板眼生成
只有在状态/生命周期事务能重建完整 next 时才写领域命令，否则安全回退快照。

### 4.9 R5a4c1-R5a4c4b 结构性变更租约、有界事务与快照边界

轨道结构、递归分叉、批量导入和大范围修复仍不属于普通实体命令。服务端新增按 annotation file 唯一的
短时独占租约，绑定 holder、purpose、base revision、创建/过期时间；客户端只得到一次性明文 token，
PostgreSQL 仅保存 SHA-256。默认 TTL 为 60 秒，续期总计不超过 5 分钟，过期记录在后续锁事务中惰性清理。

`lockActiveAnnotationFileForWrite()` 是内容写入的统一锁边界：先取得资源树共享 advisory lock，再锁资源行、
检查当前和全部祖先未进回收站、在 transaction client 上复核 write capability，最后锁 annotation file 行。
operation、snapshot save、snapshot restore 和租约 acquire/renew/release 全部复用该顺序；权限撤销和资源树移动
不能再从 operation 的事务外 ACL 检查间隙穿过。

没有有效租约时普通写入完全不变；`annotation.track.structure.update` 与
`annotation.track.structure.transaction.apply` 和 `annotation.project.snapshot.boundary` 则无论数据库是否
已有租约都必须先取得锁。shared 的 `getAnnotationMutationLeasePurposeForCommand()` 是 App 保存/历史和 API
repository 的唯一语义判别源；它把结构写入映射为 `track_structure`，导入映射为 `bulk_import`，修复/生成
映射为 `bulk_repair`。有有效租约时，同账号另一个标签页也必须提交匹配 token；账号、摘要、
base revision 或有效期任一不符均返回可解释 409。operation 接受不释放租约；只有完整 payload revision 与
operation commit 成功后，才在同一事务删除租约。恢复快照同样受 guard 保护并在成功时释放。

编辑器的文件会话 runtime 只在内存保存 token，并负责 acquire single-flight、续期 timer、临时网络失败重试、
文件切换失效和 best-effort release。结构 updater 先预览 no-op，再以串行门禁取得租约，最后基于最新
`projectRef` 重算并提交；这样等待网络期间的普通编辑不会被旧闭包覆盖，连续点击也不会重复创建 lane。
保存事务给全部 pending operation 和完整 snapshot 使用同一顶层 token；若恢复草稿中的结构命令已经失锁，
保存前会重新 acquire。成功保存调用 `markCommitted()` 只清客户端内存，因为服务端已原子删锁；失败则
保留 token、pending operation 和 IndexedDB 草稿。

`HistoryEntry` 可保存产生该边界的 command envelope。结构 undo 在弹出历史前先取得租约并记录 inverse，
redo 保存并重发原命令；legacy 历史仍走原有 project.undo/project.redo。当前受控 UI 覆盖轨道名称/颜色、
显示开关、纯 typeOptions 增加与排序、递归 lane 新增/删除/改名/改色、显示模式和 block branchScope。
R5a4c3 又覆盖整条自定义轨创建/删除、内建或自定义父轨的附属点轨创建/删除，以及会同步修改 block.type 的
自定义 typeOptions 重命名/删除。R5a4c4a 新增只能嵌入顶层结构事务的 order、builtin-track config 和
attached-point-track config 三类结构叶命令，覆盖既有顶层轨道重排、内建逐字轨配置、附属点轨配置以及
typeOptions 与逐字 `singingStyle`/点 `label` 的原子联动。R5a4c4b 再覆盖内建逐字轨创建/删除；逐字与工尺
生命周期、板眼断链和内建轨容器变化按依赖顺序进入同一结构事务，超预算时才进入 `bulk_repair` 快照边界。
逐字唱法复用 content command，但拥有独立 target key，不再与字面文本混为一个字段。

结构事务的 ProjectData apply 只在全部子命令和最终引用/容器完整性通过后发布结果；自定义轨必须在
`customTracks` 与 `activeTrackOrder` 中唯一对应，点轨 id 跨父轨唯一。配置 builder 从真实 base/next 提取
before/after，并通过完整 next 深比较拒绝漏报的内容级联；等待租约期间所有 updater 都必须回到最新
`projectRef` 重新计算，不能提交网络等待前捕获的 options。批量入口同样经过统一串行门禁；文件解析可以在
锁前完成，但真正的 next project 必须在锁后重建。平台覆盖导入不得在服务器 revision 保存前调用
`markProjectAsSaved()`，否则自动保存和冲突恢复会把未上传内容误判为 clean。

## 5. 浏览器草稿与离线恢复边界

R4b1 已为可写平台会话建立 version 1 IndexedDB envelope：

- 主键严格绑定当前账号 id 与标注文件 id，切换账号不会读取他人草稿。
- 一份 envelope 只保存 current/saved 项目、吸附状态、本地 revision、服务器基准 revision、时间戳和
  紧凑 pending operation；每条 operation 不再复制完整 before/after 项目。
- 持久化前移除受保护媒体 URL、访问 token、Blob 和运行时状态；项目迁移仍只经过
  `normalizeImportedProjectFile()`。
- dirty 编辑短延迟覆盖同一 envelope；离开编辑器时立即排入最后快照；完整保存确认 clean 后删除草稿。
- 打开文件时必须先读取服务器最新 payload、revision 和权限。同 revision 草稿可由用户显式恢复；
  只读草稿禁止直接恢复，只允许导出或明确丢弃。损坏记录不能进入 document state。
- stale 草稿固定作为结构化比较左侧，服务器当前文件固定作为右侧。用户只能把明确选择的本地实体整合
  到服务器基线；依赖闭包、重复稳定 id、结构问题和每个内容冲突都复用普通文件整合的纯领域 helper。
- 准备整合时必须同时重读 IndexedDB 草稿和服务器文件，并核对草稿更新时间、两侧 revision、write
  capability、选择集合、冲突决定与计划指纹。成功只产生运行时 `AnnotationMergeDraft`，不写项目 JSON、
  IndexedDB、审计日志、operation 日志或服务器。
- 编辑器显示运行时草稿期间，持久化 hook 暂停全部 put/delete：二次确认后形成一次可撤销 dirty commit，
  再以最新服务器 revision 覆盖旧 envelope；明确取消后 clean 状态删除旧草稿；未确认就离开则继续保留。

R4c1 已提供服务器自动保存与联网退避，R4c2 再把 409 conflict 显式交接到上述结构化比较边界；任何
流程都不得自动覆盖远端。

### 5.1 R4c2 保存冲突交接

1. 409 保持当前 editor dirty/conflict，自动保存停止；用户仍可继续编辑，debounced IndexedDB 草稿继续
   覆盖同一 envelope。
2. 用户明确点击处理后，App 调用 `usePlatformDraftPersistence().flushNow()`。flush 与 debounce/unmount
   共用同一任务队列，必须等待之前写任务并使用最新 recovery refs，禁止平行 `store.put()`。
3. flush 成功后，Workspace 重新读取当前账号/文件草稿和最新服务器 `AnnotationFile`。任一失败都留在
   editor；只有两侧事实完整时才建立 `PendingDraftOpen` 并切换资源管理器。
4. revision-conflict 直接进入 R4b2 固定本地到服务器比较；权限撤销进入 read-only 数据保险；极端情况下
   revision 未变化则进入同 revision 恢复提示。Workspace 不自动应用或保存。
5. 用户完成选择、冲突决定和编辑器二次确认后形成一次 dirty commit；R4c1 再从最新 remote revision
   自动保存。取消或退出继续遵循 R4b2 草稿保留规则。

### 5.2 R4c3 自动保存运行时

自动保存采用单向依赖：React 会话 facts → `platformAutoSavePolicy` 纯决策 →
`PlatformAutoSaveRuntime` 生命周期协调 → App 唯一保存事务。各层职责如下：

- hook 只传入 enabled、dirty、suspended、local revision、sync status 与 online，不保留 timer 或退避状态。
- policy 只返回 disabled/blocked/waiting/save-now，不发请求、不读取项目。
- runtime 至多维护一个 timer 和一个 in-flight 请求；它处理新 revision、online 恢复、正常 outcome、
  合同外异常和 dispose，但不修改 revision、saved baseline、operation 或草稿。
- App 保存事务固定 payload/吸附/operation 快照，处理服务器响应并更新 document state。同步 throw 或
  rejected Promise 被 runtime 视为合同外错误：释放请求锁、阻断后台重试、通知 App 显示 error，禁止
  伪装成正常 outcome。
- React 18 Strict Effects 的模拟卸载会 dispose 并清空 runtime ref；第二次 effect setup 必须重新创建实例，
  否则开发模式会留下永久失效的自动保存协调器。

## 6. 实时协作方向

实时协作不能合并任意完整 `ProjectData`：

- R5b3 开始前的写路径审计确认：operation POST 只完成幂等验收、base revision/租约检查和单文件 acceptance
  sequence 排序，不修改 `AnnotationFile.payload`；只有随后完整 payload 保存事务才会保存恢复快照、推进
  revision 并绑定声明的 operation。accepted operation 可能永远不提交，因此不能广播给远端当成权威事实。
- R5b3a1 已把持久文档类型迁入 `packages/document-model`，并让现有 ProjectData apply 入口直接依赖该共享
  类型。R5b3a2a 又迁入了 timing、content、Gongche/Banyan state 的 resolver、完整 next builder、immutable
  writer、precondition adapter，以及它们共用的复合快照、引用完整性和项目 equality。`src/utils` 同名文件
  只保留窄兼容导出，Web catch-up 与未来 API 会调用同一函数体。
- Lifecycle、annotation transaction、轨道结构/configuration 和通用 dispatcher 仍在 Web `src/utils`，需要在
  R5b3a2b/a2c 继续迁移。在完整 dispatcher 共享前，API 仍不能建立第二套服务端 apply，WebSocket activity bus
  也仍不得承载可靠 operation。

- R5b1/R5b2a 的 WebSocket 与跨实例通知已经落地；revision 消息只负责经过认证的文件失效提示，不传完整 payload，也不提交
  operation。`session.ready` 或 `annotation.revision.advanced` 观察到更高 revision 时，只调用现有 catch-up
  runtime 的 `requestCheck()`；dirty、保存中、冲突或行内编辑期间仍保留一次唤醒，直到 clean 后才走 HTTP。
- HTTP committed feed 与权威 snapshot 仍是唯一远端内容来源。WebSocket 断线、丢事件或重复事件不会改变
  正确性，只影响多久开始下一次 HTTP 检查；客户端不能从通知消息直接替换 `ProjectData`。
- 一次性连接票据、socket、超时、重连 timer 和 generation 由独立运行时持有。明文票据通过 WebSocket
  子协议头发送，upgrade URL 不含票据或平台 access token；本地编辑器不创建连接，文件切换和 React
  Strict Effects 都必须销毁旧 generation。
- 保存/恢复事务提交后先 fan-out 当前进程，再经 schema 隔离的 PostgreSQL LISTEN/NOTIFY 发送有界
  file id/revision/cursor。每个实例使用独立小型连接池和可重连 listener；hub 对自回环、重复和乱序 revision
  单调去重。NOTIFY 不是持久队列，listener 断线期间仍由周期 HTTP catch-up 补齐，不能从事件推断内容已应用。
- R5b2b1 的 presence 与 `ProjectData`、revision 和 operation 状态完全分离。每个已认证文件连接在 PostgreSQL
  保存一条 60 秒短生命周期 session，心跳只续期未过期行；断线、撤权和服务关闭会立即删除，异常退出由
  TTL 兜底。同账号多窗口在服务器快照中聚合为一个成员和 `connectionCount`。
- Presence 的 LISTEN/NOTIFY 只发送文件 id 级失效提示，不携带成员身份；接收实例在本地有订阅者时才
  single-flight 重读数据库，并把严格有界的 `presence.snapshot` 发送给浏览器。断线、重连和文件切换会
  清空旧成员列表，在线状态不能授予权限、改变保存结果或进入恢复草稿。
- R5b2b2 的远端活动是另一类纯运行时状态。浏览器发送严格完整的
  `{sequence, activity:{playhead,pointer,selection}}` 最新快照，最多 8 Hz，静止时每 2 秒保活；服务端按连接
  再次限流，并通过独立 schema 隔离的 PostgreSQL transient activity channel 跨实例转发。断线 clear 与
  浏览器 6 秒 stale 回收共同避免残留，慢消费者可以丢帧，因为下一帧总能覆盖旧状态。
- `platformCollaborationRuntime` 只维护一个完整 activity 候选及一套节流/保活/背压/generation；播放头、鼠标
  和选区不能建立三套并行队列。文件 session key 变化时清空完整候选，同文件离线重连则保留调用方最后事实。
  `remoteTimelineActivityRegistry` 负责连接级 sequence、clear、stale、同账号多窗口最新完整快照聚合和 32 账号
  显示上限；选区最多为前 12 个活跃账号绘制。
- `timelineSelectionSummary` 从当前有效选择解析真实时间和可视 lane，只输出起止时间、项目数、轨道数和固定
  研究域类别；实体 id、正文、轨道/分叉名称不得进入协议。Timeline 只消费整理后的只读列表，播放头、鼠标和
  选区边界直接复用 `trackHeaderWidth + time * zoom`，不能通过视觉补偿修改时间坐标，也不能参与吸附、选择、
  撤销或历史。普通窗口与独立 Timeline 用 source ownership 避免旧窗口迟到 leave 清除新窗口鼠标位置。
- 远端活动不得进入 `ProjectData`、revision、浏览器恢复草稿、恢复快照、operation log 或治理审计。在线成员
  菜单的显示开关只影响本地渲染，共享开关只清除鼠标和选区，播放头仍可预览；operation 传输不得借用该
  可丢失通道替代持久化事务。
- 服务端必须排序、鉴权、幂等确认和重放 operation。
- 客户端需要 optimistic apply、ack、reject 和 rebase。
- 普通块级命令与轨道结构/批量导入采用不同冲突策略。
- 是否使用 OT/CRDT 应在领域命令稳定后决定，不提前绑定库。

## 7. UI 临时状态

以下状态应留在组件或专门 UI store，不进入协作文档：

- hover、context menu、tooltip。
- pointer drag RAF 和命中区。
- preview frame。
- 当前面板尺寸和临时窗口位置。
- 展开分叉时用户实际点击的 branch-lane 上下文。

只有需要随项目文件保存的 UI state 才进入 saved file 的 `uiState`，且要通过统一归一化路径。

## 8. 修改本层时的验证

- 一个完成拖动只生成一次 undo 和 operation。
- 保存期间新增编辑仍为 dirty。
- operation 已提交但 payload 保存失败时可重试且不丢内容。
- stale base revision 返回 conflict，不调用 `markProjectAsSaved()`。
- 自动保存只有一个 timer/请求；网络故障退避，409/确定 4xx 不盲重试，pending merge 必须暂停。
- read-only session 无法通过 commit、transient update、undo/redo 绕过。
- 本地 JSON 保存/导入与平台保存互不污染。
- IndexedDB 草稿按账号/文件隔离，且不含 token、Blob 或每 operation 完整项目快照。
- 同 revision 才能直接恢复；stale 草稿只能经固定方向结构化整合，read-only/损坏草稿不能进入可写
  document state。
- `npm run build` 通过；平台保存改动还应有 API 集成测试。
