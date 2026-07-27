# 平台权限模型

本文档定义平台权限系统的一致语义，供 shared/document-model、API repository 和前端共享使用。模型采用 RBAC 角色能力 + ABAC 项目/文档/轨道/时间范围的方式。

## 1. 角色与全局能力

### 1.1 角色定义

```ts
type PlatformRole =
  | "super_admin" | "admin"       // 全局管理与编辑，绕过普通 grant
  | "teacher" | "ta"              // 仅通过 project owner / manage grant 拥有管理能力
  | "annotator" | "reviewer"     // 仅通过 grant 获得能力
  | "service";                    // 后端任务（无交互权限）
```

### 1.2 角色能力

| 角色 | 全局绕过 grant | 默认行为 |
|---|---|---|
| super_admin / admin | 是 | 可 view/edit/manage 所有项目/文档，无需 grant |
| teacher / ta | **否** | 与 annotator 同等；仅通过 project owner 或 manage grant 获得管理能力 |
| annotator / reviewer / service | 否 | 仅通过 grant |

开发 seed 会给助教账号显式的示例文档 `manage` grant；这只是示例数据，不是角色级全局放行。教师/助教访问其他项目时仍必须是项目 owner，或持有有效的 project/document grant。

### 1.3 项目 owner 隐式能力

项目 owner 对其拥有的项目及其下所有文档自动享有 `view/edit/manage` 能力，等价于 `source: "owner"`。后端在判断时不依赖 grant 行，直接按 `project.ownerUserId` 识别。

## 2. 动作语义

### 2.1 PermissionAction

```ts
type PermissionAction =
  | "view"    // 查看文档内容、播放、缩放、Inspector 只读查看
  | "edit"    // 编辑标注块（创建/修改/移动/删除），保存 snapshot
  | "comment" // 预留
  | "submit"  // 预留
  | "review"  // 预留
  | "merge"   // 预留
  | "confirm" // 预留
  | "manage"; // 管理 grant、创建/恢复版本、轨道结构修改、删除文档
```

**隐含关系**（由解析函数负责推导，不在 grant actions 里重复存储）：
- `manage` 隐含 `edit` 和 `view`。
- `edit` 隐含 `view`。
- 不存在其他隐含关系。

**版本恢复**：要求 `manage`。原因：恢复版本按整份旧 snapshot 写成新 revision，本质是覆盖当前文档，不应被 scoped edit 绕过范围校验。

**创建/修改/撤销 grant**：要求 `manage`。

## 3. Scope 语义

### 3.1 字段缺省含义

| 字段 | 缺省/空 | 含义 |
|---|---|---|
| projectId | 未指定或等于文档所属 project | 限定对应项目 |
| documentId | 未指定或等于文档 | 限定对应文档 |
| timeRange | 未指定或 `null` | 文档全部时间 |
| trackScope.trackIds | 未指定或空数组 `[]` | 文档全部保存轨道 |
| expiresAt | 未指定或 `null` | 没有过期时间 |

### 3.2 范围校验规则

- `startTime >= 0`，`endTime > startTime`，均为有限数。
- `trackIds` 中每个元素是非空字符串，去重。
- grant 的 `projectId` 必须与该 grant 指向的文档的 `projectId` 一致；不能把 A 项目的 projectId 和 B 项目的 documentId 组合保存在一条 grant 中。
- 多条 grant 的访问范围取**并集**：同一项修改可以由相邻时间段 grant 共同覆盖；共有分叉块涉及的每个 lane 也可以分别由不同 grant 覆盖。
- `expiresAt` 在每次鉴权时检查（已过期 grant 等同于不存在）。

### 3.3 一次修改的范围

一次修改的范围取决于修改了什么：

| 操作 | 涉及时间范围 |
|---|---|
| 新建块 | 新块 `[startTime, endTime]` |
| 删除块 | 旧块 `[startTime, endTime]` |
| 移动块 | 旧范围与新范围的并集 |
| 缩放块边缘 | 旧范围与新范围的并集 |
| 修改文字/类型/metadata | 该块当前范围 |
| 修改工尺谱符号时间 | 该符号及所在工尺谱块的范围 |
| 修改附属打点时间 | 旧、新点时间的并集 |
| 修改板眼 mark 时间 | 旧、新点时间的并集 |

**保守规则**：一项修改涉及的完整时间范围必须被至少一条有效 grant 覆盖，不能按块中心点或首尾平均判断。

## 4. 轨道 ID 模型

权限系统按「持久化逻辑轨道 ID」判断归属，不使用 `buildTimelineTrackDefinitions()` 生成的 UI 派生 lane。

| 数据 | 权限 ID |
|---|---|
| 内建逐字轨 | `character-track` |
| 自定义文字/动作轨 | 自定义轨道 id |
| 分叉子轨（recursive branch lane） | 父轨 id（`customTrack.id`）或稳定 branch lane id（`{{trackId}}#branch:{{laneId}}`） |
| 工尺谱附属轨 | 跟随父文字轨 id 授权 |
| 附属打点轨 | 跟随父轨 id 或自身稳定 id（`{{parentTrackId}}#point:{{pointTrackId}}`） |
| 句级字幕 | 与逐字轨共用 `character-track` |
| 板眼 | 独立 `banyan` 或需要 `manage` 的结构修改 |
| 轨道结构变更 | 需要 `manage`，不按单个轨道 id 判断 |

**多 lane 共享块**（`branchScope.mode === "lanes"` 且 `laneIds.length > 1`）：授权范围需覆盖**所有**归属 lane id，不能只命中一个就允许修改。

## 5. 结构性修改

以下操作默认要求 `manage`。`manage` 也受自己的轨道/时间 scope 约束；只有 owner、管理员或无轨道/时间限制的 manage grant 才能管理整份文档：

- 新建、删除、重命名、重排轨道
- 修改轨道类型或 trackType
- 修改递归分叉树结构（branchLane 增删改）
- 修改 branchScope 归属（将块从某个 lane 移到另一个）
- 修改项目视频 URL 或全局元数据
- 大范围导入/替换项目（import merge）
- `activeTrackOrder` 的修改（改变时间轴中轨道的可见顺序）
- 修改 unknown payload 字段（旧文件不识别字段发生变化，保守拒绝）

**实现提示**：在 mutation 提取阶段，对上述操作设 `requiresManage: true`，由权限校验统一拦截。

## 6. 有效权限摘要

`resolveEffectiveDocumentPermission` 的返回结构：

```ts
type EffectiveDocumentPermission = {
  canView: boolean;
  canEdit: boolean;                    // 至少可以编辑部分范围
  canManage: boolean;                  // 可以管理 grant / 恢复版本 / 修改结构
  isUnrestrictedEditor: boolean;      // 整文档任何轨道、任意时间均可编辑
  isUnrestrictedManager: boolean;     // 可管理整份文档
  isUnrestrictedViewer: boolean;
  source: "admin" | "owner" | "grant" | "none";
  editScopes: MergedScope[];          // 合并后可编辑的范围
  viewScopes: MergedScope[];          // 合并后可查看的范围
  manageScopes: MergedScope[];        // 合并后可管理的范围
};
```

`MergedScope` 是对多条 grant 按时间范围和轨道范围合并后的紧凑表示，供前端展示"你可以编辑 XX 轨道的 XX 到 XX 秒"和"当前文档整文档只读"判断。

前端的只读限制是体验层保护，真正的安全边界仍在服务端。服务器文档打开时若有效权限查询失败，编辑器必须拒绝进入而不是回退到可编辑状态；无 `edit` 权限时，项目状态层会拒绝 commit、临时拖动写入、吸附设置修改、undo 和 redo。

### 6.1 当前局部 view 的协议边界

当前标注文档仍以整份 snapshot 作为读取与保存单位。因此：

- track/time `view` scope 当前用于判断用户是否可以进入文档，并通过 `viewScopes` 告知前端授权范围。
- API 暂不裁剪 snapshot payload。若只返回局部 payload，scoped editor 随后保存整份 snapshot 时会把未返回内容误判为删除。
- 保存安全由 `editScopes` 的旧/新 snapshot mutation diff 保证；范围外修改会被拒绝。
- 真正的局部内容隐藏必须与服务端 fragment 或 operation/delta 协议一起实现，并在合并时保留客户端未加载的内容。

在该协议落地前，不要把 `viewScopes` 描述为严格的数据脱敏能力，也不要在 API 层直接删除不可见轨道或时间段。

## 7. 保存差异校验（mutation scope check）

### 7.1 流程

```
旧 snapshot payload → 新请求 payload → collectProjectMutations()
  → authorizeProjectMutations(mutations, effectivePermission)
  → 全部通过 → 创建 snapshot
  → 任一越权 → 403 permission_scope_violation，不写 snapshot，不推进 revision
```

### 7.2 ProjectMutation

```ts
type ProjectMutation = {
  kind: string;              // "character.create", "custom-block.move", "track.structure" 等
  action: "create" | "update" | "delete" | "move" | "structure";
  trackIds: string[];        // 涉及的持久化轨道 id
  timeRange?: { startTime: number; endTime: number };
  requiresManage: boolean;
  entityId?: string;
  summary?: string;          // 人类可读的简短摘要
};
```

### 7.3 错误响应

越权时返回带有 `code: "permission_scope_violation"` 的 403，包含违规摘要（最多前若干条）和总数，但不返回完整旧/新 payload。

## 8. 审计

新增 `AuditAction`：`permission_grant_create`、`permission_grant_update`、`permission_grant_revoke`、`permission_denied`。

`permission_denied` 的 detail 只包含：documentId、被拒绝 mutation 的数量/类型/范围摘要、操作用户 id。**不**保存完整 snapshot 或完整 mutation payload。

全局审计查询只允许 `super_admin/admin`。其他账号必须指定可管理的项目，或自己具有整文档 manage 权限的文档；受限 manager 不能读取整份文档审计，因为当前审计行没有足以逐条执行轨道/时间裁剪的信息。

## 9. 平台资源可见性

- 只有 `super_admin/admin` 可以全局列出文件、媒体、项目和审计日志。
- teacher/TA 与普通账号一样，通过资源所有权或有效 project/document grant 获得可见性。
- `FileObject.ownerUserId` 记录上传者；授权项目引用的主媒体文件也可被项目成员读取。
- `MediaAsset.ownerUserId` 记录媒体创建者。旧媒体若没有 owner，仍可通过主文件所有权或可见项目访问。
- 文档级 grant 只应暴露对应文档，项目摘要的 `documentCount` 也必须按当前用户可见文档计算。
- 创建项目前必须校验当前用户有权使用所选媒体资产。
