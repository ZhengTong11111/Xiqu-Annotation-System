# 标注文档状态与同步架构

本文档说明编辑器本地状态、平台 annotation file 和未来同步层之间的当前边界。

最后更新：2026-08-03

## 1. 三个层次

### 1.1 本地领域文档

`ProjectData` 是时间轴标注内容，与平台账号、资源 ACL、服务器 revision 分离。它可以通过本地
JSON 导入导出，也可以作为平台 `AnnotationFile.payload` 保存。

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
2. 将尚未 submitted 的 operation 摘要顺序写入服务端 operation log。
3. 调用 annotation-file save API 写入固定完整 payload。
4. 成功后更新 remote revision，并只确认本次覆盖的 operation ids。
5. 失败时保留本地 pending operations：
   - 409 -> `conflict`
   - 明确离线 -> `offline`
   - 其他 -> `error`

`submitted` 只表示 operation 摘要已写入日志，不表示 payload 已保存。每条 operation 使用稳定
`clientOperationId`，服务端在“标注文件 + 账号 + clientOperationId”作用域内按请求指纹幂等接收；
响应丢失或完整保存推进 revision 后，完全相同请求仍可安全重放。

## 4. Operation log 的当前边界

当前 operation payload 是摘要，不是可重放的领域增量：

- 它用于审计、同步实验和后续协议设计。
- 它不会修改 annotation file payload。
- 它不能作为恢复完整项目的唯一来源。
- 不应把完整 before/after `ProjectData` 复制进每一条 operation。

真正协作前，应逐步引入稳定 id 的领域命令，例如：

- `character.updateTiming`
- `character.updateText`
- `block.create`
- `block.delete`
- `track.rename`
- `attachedPoint.move`

批量导入、轨道结构和递归分叉变更可能需要更高层事务命令，不能强拆成没有原子边界的小操作。

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

这仍不是自动保存：当前没有后台保存调度、联网重试退避或页面关闭时的服务器保存策略。下一步 R4c
应在上述显式冲突边界之上接入自动保存；任何流程都不得自动覆盖远端。

## 6. 实时协作方向

实时协作不能合并任意完整 `ProjectData`：

- WebSocket 负责 presence 和 operation 传输，不替代持久化事务。
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
- read-only session 无法通过 commit、transient update、undo/redo 绕过。
- 本地 JSON 保存/导入与平台保存互不污染。
- IndexedDB 草稿按账号/文件隔离，且不含 token、Blob 或每 operation 完整项目快照。
- 同 revision 才能直接恢复；stale 草稿只能经固定方向结构化整合，read-only/损坏草稿不能进入可写
  document state。
- `npm run build` 通过；平台保存改动还应有 API 集成测试。
