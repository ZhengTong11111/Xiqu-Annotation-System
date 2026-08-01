# 标注文档状态与同步架构

本文档说明编辑器本地状态、平台 annotation file 和未来同步层之间的当前边界。

最后更新：2026-08-01

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

`submitted` 只表示 operation 摘要已写入日志，不表示 payload 已保存。当前去重只在页面内存层面
有效；刷新后重试仍缺少服务端幂等键。

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

## 5. 自动保存与离线恢复前置条件

下一步不能只在 React effect 中加 debounce。至少需要：

- pending operations 持久化到 IndexedDB。
- 每个 client operation 的稳定幂等 id 和数据库唯一约束。
- 页面刷新后恢复本地文档、remote base revision 和队列。
- 保存中继续编辑的快照隔离。
- 失败重试与退避。
- 409 冲突比较/用户决策，不自动覆盖。
- 页面关闭和视频/大 payload 保存性能策略。

详见 roadmap R4；这些工作必须在 R0 的 migration 和 API 集成测试保护线之后进行。

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
- `npm run build` 通过；平台保存改动还应有 API 集成测试。
