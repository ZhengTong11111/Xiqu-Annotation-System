# 平台资源权限模型

本文档定义当前 `ResourceEntry + ResourcePermission` 权限语义。服务端实现以
`packages/document-model/src/permissions.ts` 和 `apps/api/src/resourceAccess.ts` 为准；前端
不得维护第二套鉴权算法。

最后更新：2026-08-01

## 1. 权限边界

权限对象是资源树节点：

- `folder`
- `project`
- `annotation_file`
- `media_file`

每条 `ResourcePermission` 表示一个资源对一个账号的**直接授权**。项目和文件夹可把授权继承
给后代；一个资源可以停止继承祖先授权。

当前不包含：

- Course / Assignment 成员角色。
- Workspace / Fork / 发布版本权限。
- 标注内容的轨道范围或时间范围授权。
- 显式 deny。

未来若增加轨道/时间范围限制，它必须是 `annotation_file` 内部的独立内容策略，不能改变本
文档定义的资源可见性和文件操作能力。

## 2. 平台角色

```ts
type PlatformRole =
  | "super_admin"
  | "admin"
  | "teacher"
  | "ta"
  | "annotator"
  | "reviewer"
  | "service";
```

- `super_admin` / `admin`：对所有资源拥有完整能力。
- 其他交互账号：不因平台角色自动获得资源权限，依赖 ownership 或有效 ACL。
- `service`：用于受控后端任务。它可以绕过用户可见性，但不能引用不存在的资源，也不能绕过
  任务类型和输入校验。

教师、助教只是账号职责标签，不是全局管理员。

## 3. 资源能力

```ts
type ResourceCapability =
  | "read"
  | "write"
  | "create_child"
  | "copy"
  | "move"
  | "delete"
  | "download"
  | "manage_permissions";
```

| 能力 | 语义 |
|---|---|
| `read` | 查看资源元数据；对标注文件可打开 payload，对文件夹/项目可进入 |
| `write` | 修改资源内容；对标注文件可 revision save |
| `create_child` | 在容器中创建、上传、导入或粘贴子资源 |
| `copy` | 复制资源；仍需对目标容器拥有 `create_child` |
| `move` | 移动资源；仍需对目标容器拥有 `create_child` |
| `delete` | 移入回收站或执行允许的删除操作 |
| `download` | 下载媒体或导出受管文件内容 |
| `manage_permissions` | 查看和修改该资源上的直接 ACL 与继承设置 |

能力没有 `manage -> write -> read` 之类的隐式层级。调用方必须检查操作实际需要的全部能力，
避免把一个管理权限错误地解释成所有数据权限。

## 4. 完整权限来源

以下主体拥有资源的全部能力：

1. `super_admin` / `admin`。
2. 资源自身的 `ownerUserId`。
3. 该资源任一祖先 `folder` / `project` 的 owner。

ownership 不依赖 ACL 行，不能被删除 grant 或 `breakPermissionInheritance` 降权。

祖先 owner 规则让项目 owner 可以管理项目内部文件，同时避免给每个后代生成重复 grant。

## 5. 直接授权与继承

### 5.1 直接授权

直接授权属于一个确定的 `resourceEntryId + userId`，包括：

- `capabilities[]`
- `inheritToChildren`
- `expiresAt`
- 创建者和时间信息

同一资源同一账号应只有一条直接授权记录。更新采用 upsert 或显式删除，不应产生语义重叠的
重复行。

### 5.2 继承

从当前资源向根遍历祖先：

- 当前资源直接授权始终参与计算。
- 祖先授权只有 `inheritToChildren=true` 才能传给后代。
- 直接和继承能力取并集。
- 过期授权等同于不存在。
- 遇到当前节点或向上路径中的 `breakPermissionInheritance=true` 后，不再继续读取更远祖先。

`breakPermissionInheritance` 不删除任何 ACL 行，也不影响 owner/admin 权限。

### 5.3 没有显式 deny

当前模型不能用一条空 grant 抵消祖先能力。若某文件需要独立授权：

1. 对该文件启用 `breakPermissionInheritance`。
2. 给需要访问的账号添加直接授权。

未来若引入 deny，必须重新定义优先级、继承、批量操作和可解释性，不能通过空数组暗中模拟。

## 6. 操作授权矩阵

| 操作 | 源资源 | 目标/父资源 |
|---|---|---|
| 列表/详情/打开 | `read` | 容器列表还需按每个子项可见性过滤 |
| 新建文件夹/项目 | 无 | 父容器 `create_child` |
| 导入标注 JSON | 无 | 父容器 `create_child` |
| 上传媒体 | 无 | 父容器 `create_child` |
| 重命名 | `write` | 无 |
| 复制 | `read + copy` | 目标容器 `create_child` |
| 移动 | `move` | 目标容器 `create_child` |
| 移入回收站 | `delete` | 无 |
| 恢复 | 按 API 的恢复能力检查 | 原/新父容器必须合法且名称不冲突 |
| 下载媒体 | `read + download` | 无 |
| 保存标注文件 | `read + write` | 无，另需正确 `baseRevision` |
| 查看直接 ACL | `manage_permissions` | 无 |
| 修改 ACL/继承 | `manage_permissions` | 被授予能力不能超出授权者可委派范围 |

列表接口不能先返回全部资源再由前端隐藏。服务端必须过滤不可见资源、面包屑和统计数字，避免
通过名称、数量或层级泄露信息。

## 7. 复制、移动与删除语义

### 7.1 标注文件复制

- 创建新的 `ResourceEntry + AnnotationFile`。
- 复制当前 payload，revision 从 1 开始。
- 复制者成为新文件 owner。
- 不复制源文件的直接 ACL。
- 新文件从目标目录重新继承权限。
- 关联媒体建立引用，不重复复制二进制。

### 7.2 移动

- 拒绝把资源移动到自身或任一后代。
- 校验目标是可容纳子项的容器。
- 校验目标 `create_child` 和源 `move`。
- 保留源资源直接 ACL。
- 移动后根据新祖先重新计算继承 ACL。
- 名称冲突必须由服务端返回可解释错误。

### 7.3 删除与恢复

- 默认软删除，不立即物理删除数据库行或对象。
- 已删除父节点的子树不能从普通列表穿透显示。
- 恢复必须处理父节点仍在回收站、父节点不存在和名称冲突。
- 永久删除、保留期限和对象清理策略尚未定稿，不得由前端私自实现。

## 8. 标注文件保存

权限与并发是两道独立检查：

1. 当前账号对 annotation file 有 `read + write`。
2. 请求 `baseRevision` 等于数据库当前 revision。

保存事务必须：

1. 锁定并重新读取目标 annotation file。
2. 在事务内复核 revision。
3. 把旧 payload 写入 `AnnotationRecoverySnapshot`。
4. 条件更新新 payload、revision、编辑者和保存时间。
5. revision 竞争时只允许一个请求成功，其余返回 `409`。

无权限返回 `403`；坏输入返回 `400`；不得把这些情况包装成 `500`。

## 9. ACL 管理约束

- 只有有效 `manage_permissions` 主体可查看和修改直接授权。
- API 接收的账号、能力、日期和资源 id 必须做运行时校验。
- 普通 manager 不能授予自己没有的能力；admin/owner 的完整权限不由 ACL 行表达。
- 修改或删除 grant 后必须重新查询有效权限，不得只相信前端本地矩阵。
- 权限查询失败时前端必须 fail closed，不能回退到可编辑。
- 每次 grant upsert/delete 和继承开关变化应写 audit log，但 detail 不保存资源 payload。

## 10. 前端展示规则

Inspector 应区分：

- 直接授权。
- 继承来源。
- owner/admin 完整权限。
- 最终有效能力。
- 是否已截断继承。
- 授权是否过期。

禁用控件必须说明原因，但不代替后端校验。打开标注编辑器时，服务端返回只读能力则
`useProjectDocumentState({ readOnly: true })` 必须阻止 commit、临时写入、undo/redo 等修改路径。

## 11. 测试最低矩阵

- admin 全局完整权限。
- 资源 owner 与祖先项目/文件夹 owner 完整权限。
- 直接 grant。
- 多层祖先继承与 `inheritToChildren=false`。
- `breakPermissionInheritance`。
- 多条能力并集与 expiresAt。
- 无权限列表不可见、详情/媒体读取/保存为 403。
- grant 管理越权拒绝。
- move 后继承来源变化、直接 ACL 保留。
- copy 后 owner 变化、直接 ACL 不复制。
- stale save 409 且不产生错误快照。

纯函数测试之外，以上关键路径需要 API + PostgreSQL 集成测试。

## 12. 已撤销模型

此前的 `PermissionGrant`、`view/edit/manage` action、ProjectMember、轨道/时间 scope、snapshot
mutation diff 和 Assignment 来源 grant 已从当前运行时移除。它们只存在于 Git 和
`docs/development-log.md` 的历史记录中，不是兼容目标。
