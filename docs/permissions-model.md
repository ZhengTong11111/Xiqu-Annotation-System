# 平台资源权限模型

本文档定义当前 `ResourceEntry + ResourcePermission` 权限语义。服务端实现以
`packages/shared/src/platformRolePolicy.ts` 和 `apps/api/src/resourceAccess.ts` 为准；前端
不得维护第二套鉴权算法。

最后更新：2026-08-22

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
  | "annotator"
  | "reviewer"
  | "service";
```

- `super_admin`：对所有资源拥有完整能力，并独占账号创建、角色/状态调整和他人密码重置。
- `admin`：对所有资源、审计、诊断和运维拥有完整能力，但不能管理账号。
- `teacher`：自动对所有资源取得 `read + download`，不会自动取得内容编辑、审核、创建或权限管理能力。
- `annotator` / `reviewer` / `service`：不因角色名称自动获得资源能力，依赖 ownership 或有效 ACL。

一个账号可以同时拥有多个角色。后续 teacher/annotator 附属关系会在独立关系模型中设计；当前没有根据
附属关系隐式发放 ACL，也不得用前端分组模拟服务端授权。

## 3. 资源能力

```ts
type ResourceCapability =
  | "read"
  | "write"
  | "review"
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
| `review` | 创建确定标注范围等审核治理事实；不等于内容编辑 |
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

`teacher` 的 `read + download` 是角色自动浏览基线，权限来源标记为 `role`。直接授权和继承授权可在此
基础上增加能力；角色基线不会被空 grant 抵消，也不会提升为 owner/admin 全权。

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

### 10.1 极简与详细权限编辑

资源 Inspector 默认提供“极简”模式，并保留原有“详细”模式。极简模式只是常用 capability
组合的前端预设，不新增 API 字段、数据库枚举或服务端角色，也不得参与有效权限计算：

| 极简选项 | 直接授权 capability | 说明 |
| --- | --- | --- |
| 不额外授权 | 删除当前资源上的直接 ACL | 不是显式 deny；角色、父目录继承、owner/admin 权限仍然有效 |
| 仅查看 | `read + download` | 下载是上传媒体、VOD 播放及受保护资源读取链路的一部分 |
| 可编辑 | `read + write + copy + move + delete + download` | 项目和文件夹另加 `create_child`；不包含审核或权限管理 |

- 三档基础权限必须使用互斥 radio；`review` 作为“可审核”独立 checkbox，可与任一基础档组合，但不会
  自动加入“可编辑”。`manage_permissions` 仍只能在详细模式中设置。
- “可审核”只附加 `review`。审核命令仍要求 `read + review`，因此普通账号应组合“仅查看 + 可审核”或
  “可编辑 + 可审核”；teacher 可由角色基线取得 `read + download`。`不额外授权 + 可审核`会保存一条
  仅含 `review` 的直接 ACL，而不是执行 DELETE，也不会暗中补发读取能力。
- 直接 capability 在剥离可选 `review` 后，只有与基础预设**完全相同**时才能显示为标准组合；存在
  `manage_permissions`、其他额外/缺失能力或重复能力时显示“自定义细分权限”，并保留原值，直到用户明确
  选择基础预设覆盖或进入详细模式编辑。
- 媒体文件没有标注确认操作，极简模式不为它生成 `review`；异常历史组合仍由详细模式处理。
- 两种模式编辑同一条 `ResourcePermission`。切换模式不能自行保存、裁剪或扩充 capability；每次写入后
  必须重新读取服务端矩阵。
- 极简模式不修改资源级“继承父目录权限”和直接授权的“传递给子文件”开关。前者只在详细模式调整，
  后者沿用现有直接授权值，新授权使用服务端/界面的既定默认值。
- owner 和全局管理员保持只读完整权限摘要。普通权限管理者只能选择其自身可委派的完整预设，服务端仍
  必须在事务内重新校验，前端禁用不能代替鉴权。
- 当选择“不额外授权”后仍存在 `teacher` 角色基线或父目录继承时，界面必须直接说明残余来源，不得显示
  “完全无权限”或制造一条空 capability grant。

### 10.2 集中项目权限管理

资源管理器顶部为 `super_admin` 和 `admin` 提供三栏式“项目权限管理”窗口：左栏搜索活动账号，中栏跨目录
搜索全部活动项目，右栏显示选中“账号 + 项目”的直接授权、最终有效权限、权限来源和项目 owner。该窗口是
日常项目分配的快速入口，资源 Inspector 仍是任意项目、文件夹、标注文件和媒体文件的细粒度权限入口。

- 项目列表使用独立的管理员只读分页接口，覆盖嵌套项目，同时排除自身或祖先已归档、已进入回收站的项目。
  接口只返回轻量项目摘要；选中项目后才读取既有完整权限矩阵，不能预先展开“项目数 × 账号数”。
- 集中窗口继续复用 10.1 的“三档基础权限 + 可审核附加项”，不新增数据库权限等级。`manage_permissions`、
  过期时间以及其他自定义组合仍在详细 Inspector 中编辑。
- 与单资源 Inspector 保留当前 `inheritToChildren` 的行为不同，集中窗口中的“仅查看”和“可编辑”明确表示
  **整个项目范围**，保存时固定写入 `inheritToChildren=true`。子资源的继承截断和已有直接 ACL 不会被修改。
- “不额外授权”且未勾选审核时，只删除当前项目对该账号的直接 ACL；勾选审核时保存 `review` 并向子资源
  传递。不论哪种组合，都不删除子资源 ACL，也不修改项目自身是否继承父级权限。
- 自定义 capability 或 `inheritToChildren=false` 的既有直接 ACL 不会在加载时被裁剪；必须由管理员勾选覆盖确认，
  才能用三档项目预设替换。owner 和全局管理员只显示锁定解释，不产生无意义的直接 ACL。
- 所有写入继续调用既有权限 PUT/DELETE 路由，并在成功后重新读取服务端矩阵。集中窗口不计算有效权限，
  前端锁定、提示和预设只能改善体验，不能替代服务端事务内的权限与委派校验。

## 11. 测试最低矩阵

- super_admin 独占账号治理，admin 调账号 API 为 403。
- super_admin/admin 全局资源完整权限。
- teacher 全局 `read + download`，但 write/review/create_child/manage_permissions 为 403。
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
