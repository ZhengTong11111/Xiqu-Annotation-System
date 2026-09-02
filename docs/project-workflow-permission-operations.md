# 项目职责组权限授予与人员变更手册

最后更新：2026-09-02

## 1. 文档用途

本文用于把批量任务分组转换为平台中的项目权限，并安全处理加入、退出和换组。它说明权限来源、数据库表、
Blind Pool 隔离结构、推荐操作流程、验收与回滚。通用权限语义仍以
[`permissions-model.md`](./permissions-model.md) 为准，服务器连接、维护和部署基础操作以
[`server-deployment.md`](./server-deployment.md) 为准。

批量人员变更是生产数据操作，不是代码部署。不要通过修改角色、复制 ACL 或直接覆盖整张成员表来图省事。

## 2. 当前权限结构

### 2.1 有效权限是多个来源的并集

一个账号对某个资源的最终能力，由以下来源共同合并：

1. 平台角色：`super_admin`、`admin` 有全资源能力；`teacher` 自动具有全资源 `read + download`；
   `annotator`、`reviewer` 名称本身不自动授权。
2. 资源所有权：资源 owner 和祖先 owner 拥有完整能力，不能通过删除 ACL 或职责组降权。
3. 手工直接 ACL：保存在 `resource_permissions`，可以从项目/文件夹向后代继承。
4. 项目职责组：保存在 `project_workflow_members`，是独立于手工 ACL 的权限来源。

当前没有显式 deny。因此，判断“退出人员是否已经失权”不能只看职责组行数，还必须确认其没有管理员/教师角色、
资源所有权、直接或继承 ACL 等其他来源，并以服务端有效权限计算做最终验收。

### 2.2 两种项目职责组

| 职责组 | 贡献能力 | 不包含 |
|---|---|---|
| 标注组 `annotation` | `read, write, create_child, copy, move, delete, download` | `review, manage_permissions` |
| 审核组 `review` | `read, review, download` | `write, create_child, copy, move, delete, manage_permissions` |

本次全量任务的组员同时加入标注组和审核组，所以最终获得编辑、文件操作、下载和审核能力，但不会获得
`manage_permissions`。职责组只保存成员关系，不生成 `resource_permissions` 行。

移出职责组只撤销这一项来源，不会删除手工 ACL，也不会改变角色、账号状态或资源 owner。

### 2.3 继承与 Blind Pool

普通折子戏在顶层项目设置职责组，权限向项目内媒体和标注文件继承。

Blind Pool 使用两层授权：

- 所有参与者加入 `Blind Pool` 根项目的审核组，从而可查看、下载 001-010 下的全部媒体。
- 每份 A/B 标注文件位于独立的 `BP-NNN-A/B` 子项目；这些叶项目设置
  `break_permission_inheritance=true`，只给对应任务组加入标注组和审核组。

因此，根项目媒体权限不会穿透到 A/B 标注文件。新增组员必须同时处理根项目审核组和本组叶项目；不能只处理其中一层。

## 3. 权威数据与数据库表

批量任务的业务来源是经人工确认的任务表，数据库中的稳定身份必须按账号和资源事实重新解析，不能把显示名称当作永久主键。

| 数据 | 表 | 关键字段 |
|---|---|---|
| 账号 | `users`、`user_roles` | `id`、`account_name`、`display_name`、`is_active`、角色 |
| 资源树 | `resource_entries` | `id`、`parent_id`、`type`、`name`、继承开关、归档/回收状态 |
| 职责组 | `project_workflow_members` | `project_resource_id`、`user_id`、`group`、`created_by`、`created_at` |
| 手工 ACL | `resource_permissions` | `resource_id`、`user_id`、能力、继承、有效期 |
| 审计 | `audit_logs` | action、操作者、项目、有限 detail、时间 |

`project_workflow_members` 对 `(project_resource_id, user_id, group)` 有唯一约束。一个人可以在同一项目同时属于标注组和审核组。

## 4. 推荐的数据库操作方式

### 4.1 只读连接

连接服务器后，从受保护的 systemd 环境文件读取连接串；不要输出、复制或写入仓库：

```bash
sudo -u xiqu bash -lc '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  PSQL_URL="${DATABASE_URL%%\?*}"
  psql "$PSQL_URL" -v ON_ERROR_STOP=1 -P pager=off
'
```

常用只读核对：

```sql
-- 显示名必须只匹配一个活动账号，同时核对账号名和角色。
SELECT u.id, u.account_name, u.display_name, u.is_active,
       string_agg(ur.role::text, ',' ORDER BY ur.role::text) AS roles
FROM users u
LEFT JOIN user_roles ur ON ur.user_id = u.id
WHERE u.display_name = '<姓名>'
GROUP BY u.id;

-- 查看职责组来源。
SELECT r.id, r.name, pwm.group, pwm.created_at
FROM project_workflow_members pwm
JOIN resource_entries r ON r.id = pwm.project_resource_id
WHERE pwm.user_id = '<用户 UUID>'
ORDER BY r.name, pwm.group;

-- 退出前必须检查其他独立来源。
SELECT * FROM resource_permissions WHERE user_id = '<用户 UUID>';
SELECT id, type, name FROM resource_entries
WHERE owner_user_id = '<用户 UUID>' AND archived_at IS NULL AND trashed_at IS NULL;
```

### 4.2 写入必须调用服务层

推荐编写一次性 Node 脚本，从当前已部署 release 导入：

- `dist/api/database.js`
- `dist/api/resourceAccess.js`
- `dist/api/resourceService.js`
- `dist/api/backup/maintenanceOperator.js`

通过 `ResourceService.updateProjectWorkflowGroups()` 更新项目，而不是直接执行 `INSERT/DELETE`。该服务会统一完成：

- 资源树写锁和项目行锁；
- 项目仍活动的校验；
- 操作者 `manage_permissions` 复核；
- 新成员存在且活动的校验；
- 标注组、审核组的完整集合替换；
- 项目 `updated_at` 更新；
- `project_workflow_groups_update` 审计记录。

这个 API 接收的是项目两组成员的**完整目标集合**。正确算法始终是：

```text
目标集合 = 当前集合 - 明确退出人员 + 明确加入本项目的人员
```

不得把“本次新增成员”直接当完整集合提交，否则会删除项目里的其他成员。也不得用职责组去改写
`resource_permissions`；两种来源必须保持独立。

### 4.3 批量变更安全顺序

1. 校验任务表 hash、组别、普通项目、Blind Pool A/B 分配。
2. 以姓名和账号名双重核对唯一活动账号；使用数据库 UUID 进入计划。
3. 核对项目 UUID、名称、类型、活动状态和父子关系；Blind Pool 还要核对叶项目断继承和文件位置。
4. 对退出人员检查角色、owner、直接 ACL 和全部职责组来源。
5. 读取每个受影响项目的当前完整成员集合，生成 before/after 和 SHA-256 计划指纹。
6. 先 dry-run，只报告变更项目、增删关系和每人的目标数量。
7. 开启维护模式并取得本次批处理专用 PostgreSQL advisory lock。
8. 指纹仍与当前数据库一致后，在第一笔写入前把完整 before/after 计划以 `0600` 保存到数据盘备份目录。
9. 按项目调用 `updateProjectWorkflowGroups()`；中途失败时保持维护状态并根据备份计划判断继续或反向恢复。
10. 验收成员行、直接 ACL 未变、审计数量和**最终有效权限**后，才解除维护模式。
11. 删除服务器 `/tmp` 中的一次性脚本和输入；保留数据盘中的受保护变更计划。

不要把数据库密码、环境文件、访问令牌、媒体 URL 或完整标注正文写进变更计划和日志。

## 5. 验收标准

### 5.1 退出人员

- `project_workflow_members` 中不再有该账号；
- 没有未处理的直接 ACL 和活动资源所有权；
- 对所有活动资源调用 `ResourceAccessService.getEffectivePermissions()`，不存在任何有效能力；
- 账号是否停用是另一项管理决定，不能把“已撤项目权限”误写成“账号已停用”。

### 5.2 新加入人员

- 普通本组项目及其任务文件、媒体具有
  `read + write + review + create_child + copy + move + delete + download`；
- Blind Pool 根项目、001-010 父项目和媒体具有 `read + review + download`；
- 本组 A/B 叶项目和标注文件具有编辑与审核完整组合；
- 其他组 A/B 叶项目和文件没有任何有效能力；
- 没有新增 `manage_permissions`；
- `resource_permissions` 总体事实未被职责组操作改动。

只统计数据库行数不足以完成验收，因为继承、角色和所有权都可能改变最终能力。

## 6. 回滚原则

本轮变更前快照保存每个受影响项目的完整 `beforeAnnotation`、`beforeReview`、`afterAnnotation` 和 `afterReview`。
需要回滚时，应在新的维护窗口重新核对项目和账号事实，再通过同一个服务层把每个项目恢复为 before 集合。

如果变更后其他管理员又调整了同一项目，不能直接覆盖为旧 before；必须先计算当前集合与本轮 after 的差异，保留后来合法变更。
除非数据库整体损坏，不要为了几十条职责组关系恢复整个生产数据库。

## 7. 2026-09-02 人员调整记录

### 退出

| 姓名 | 原组 | 删除标注组关系 | 删除审核组关系 | 账号处理 |
|---|---:|---:|---:|---|
| 周美璇 | 第6组 | 23 | 24 | 保持活动，仅撤项目权限 |
| 张心悦 | 第4组 | 23 | 24 | 保持活动，仅撤项目权限 |
| 武恩怡 | 第4组 | 23 | 24 | 保持活动，仅撤项目权限 |

三人均无直接 ACL、活动资源所有权或角色自动资源权限。本轮共删除 141 条职责组关系。

### 加入

| 姓名 | 账号 | 新组 | 目标标注项目 | 目标审核项目 |
|---|---|---:|---:|---:|
| 吴梓烽 | `wuzifeng` | 第4组 | 23 | 24 |
| 谢静媛 | `xiejingyuan` | 第4组 | 23 | 24 |
| 肖熹 | `xiaoxi` | 第6组 | 23 | 24 |
| 郭禹坤 | `guoyukun` | 第11组 | 22 | 23 |

第4组包括 22 个普通折子戏和 `BP-002-A`；第6组包括 23 个普通折子戏、没有 A/B 叶任务；第11组包括
19 个普通折子戏及 `BP-005-B`、`BP-007-A`、`BP-010-B`。四人都另加入 Blind Pool 根审核组。

郭禹坤执行前已有第11组目标内 1 条标注组和 3 条审核组关系，因此本轮实际新增总数为 182，而不是目标关系总数 186。

### 执行与证据

- 维护窗口：`2026-09-02T14:56:47.131Z` 至 `2026-09-02T14:58:51.254Z`。
- 计划指纹：`ecd1b8b5a687eeea996b6b9bcf66e516e877b792c4e300e0029ca825b1a0c4d1`。
- 受影响项目：67；删除关系：141；新增关系：182。
- 变更后职责组总数：10,334；手工直接 ACL 仍为 47。
- 审计记录：67 条 `project_workflow_groups_update`。
- 有效权限验收：退出人员 3,438 项资源检查通过；新成员 379 项允许检查和 150 项 Blind Pool 隔离检查通过。
- 变更前后计划保存在生产数据盘：
  `/var/lib/xiqu-platform/backups/permission-roster-delta-20260902.json`，权限应保持 `0600`。
- 解除维护后 API、analysis worker、Caddy 均为 active，API database/storage readiness 均为 ready。
