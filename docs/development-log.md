# Development Log

## 2026-07-27：工作区、标注版本与项目版本重构

- 按最终领域语义破坏性移除 Course/Assignment、`AnnotationDocument` 与 `PermissionGrant`
  运行时模型。`ProjectMember` 直接保存角色、能力、时间/轨道范围和有效期，不再存在第二份
  可能漂移的授权记录。
- 新增 `AnnotationWorkspaceService`、`AnnotationVersionService`、
  `ProjectVersionService` 和 `ProjectAccessService`，将成员、可变工作区、不可变标注版本和
  项目发布职责从通用 repository 中拆开。
- 工作区保存继续使用 snapshot + `baseRevision`；完成版本固定事务内最新 snapshot 并记录
  parent lineage；Fork 始终复制指定版本的固定 snapshot，不读取来源工作区的后续状态。
- 项目版本支持候选、发布、superseded 与归档；发布事务原子更新旧发布版本和项目 current
  指针。保存、版本序号和发布路径使用可串行事务有限重试，主工作区通过条件指针保证唯一。
- 收尾审查补充了两个生命周期边界：已过期成员不能成为新工作区 owner；建立项目候选版本
  会在串行事务内重新确认来源标注版本仍处于 active，避免与归档并发时产生失效候选。
- 项目库改为“工作区 / 成员标注 / 项目版本”三视图；项目权限管理明确选中账号后编辑能力和
  scope，并展示该成员成果。无管理能力账号不会进入权限页面。修复了新页签套用旧 grid 行
  定义导致页签占满内容区的问题。
- 删除未使用的 `PlatformHome.tsx`、课程服务/策略/测试及旧权限测试；重写 10 项
  document-model 权限测试，并把角色默认能力与能力目录集中到 `packages/shared`。
- 本地数据库确认指向 `localhost:54329/xiqu_platform` 后执行 `db:push --force-reset`，符合
  本轮“不兼容旧平台开发数据”的决策。
- 验证：`npm run test:permissions`、`npm run build` 通过。真实 Fastify/PostgreSQL 冒烟覆盖
  管理员设置学生 scope、范围内保存、范围外 `403 permission_scope_violation`、完成版本、
  候选发布、固定版本 Fork、成员移除/重加及学生管理接口 403。浏览器验证管理员/学生导航、
  逐成员权限归属、独立滚动和三类项目视图。
- 未完成：submitted 工作区审核/退回与意见、版本 diff/选择性合并、确定范围、自动保存、
  operation 驱动同步和实时协作。

## 2026-07-27：阶段 10 独立标注作业第一套完整闭环

> 本节保留为历史开发记录；其 Course/Assignment 运行时实现已被上方“项目库与项目权限
> 管理统一”决策撤销，不再代表当前代码结构。

- 后续 Chrome 实机复查发现成员新增使用 `POST` 正常，但成员权限修改和移除分别使用
  `PATCH` / `DELETE`，原 CORS 默认方法没有放行，导致浏览器只完成预检并显示
  `Failed to fetch`。API 已显式允许平台使用的完整 HTTP 方法集合。
- 课程成员 UI 改为逐账号权限行：每个账号独立显示平台角色、课程角色、能力说明，
  可以直接保存课程权限或通过明确的确认面板移出课程，不再复用含义模糊的共用下拉框和
  `×` 按钮。成功请求会清除旧错误，避免历史网络错误继续误导用户。
- 成员移出/学生升为 staff 的数据语义已补齐：草稿 recipient 直接移除；已发布 recipient
  转为 `withdrawn`；个人文档和进度保留；所有 assignment 来源 grant 撤销；学生“我的作业”
  不再展示已撤销任务。手工创建、没有 `assignmentId` 的 grant 不受影响。
- Chrome 完整验证“添加学生 -> 改为助教 -> 移出课程”均成功且无残留错误；真实 PostgreSQL
  冒烟验证已发布作业从 `assigned` 转为 `withdrawn`、学生列表隐藏、原文档访问返回 `403`，
  自动验证数据已清理。
- 根据 `CLAUDE_WORK.md` 的当前任务完成课程、成员和独立作业全栈实现。
- Prisma 新增 `Course`、`CourseMember`、`Assignment`、`AssignmentRecipient` 及状态枚举；
  作业在创建时冻结 source snapshot，发布时为每名学生复制独立 revision 1 snapshot。
- 新增独立 `CourseAssignmentService`，没有继续把课程逻辑堆入已有 repository。发布使用
  Serializable transaction，学生文档、快照、范围 grant、接收记录和审计同生共死，重复发布
  不会重复生成副本。
- 学生提交后，作业专用 grant 降为只读；`saveDocument` 和 operation 入口另有提交锁，
  防止其他 project-level edit grant 绕过。助教退回后恢复编辑，并记录首次保存、最后活动、
  提交和退回时间。
- 平台新增课程管理、成员设置、作业范围/接收者选择、发布与进度表，以及学生“我的作业”
  打开和提交入口。UI 复用现有紧凑工作台样式。
- 新增纯状态机测试，并保留较详细中文注释解释事务、权限与提交锁设计。
- Codex 提交前审查补齐了最初实现遗漏的课程详情、成员新增/修改/移除、草稿详情与修改、
  受课程上下文约束的账号搜索等接口；学生视图会裁剪教师草稿、全班提交统计和其他成员身份。
- 修复审查中发现的边界问题：发布不再误写学生活动时间；课程角色变化会同步撤销/恢复
  assignment 来源的 staff grant；助教不能管理课程成员或自我提升；owner 和最后一名教师
  不能被降级/移除；Serializable 并发发布对 P2034 做有限重试。
- 验证：`db:push`、assignment tests、既有 permission tests、web/API build 均通过；真实
  PostgreSQL + Fastify 冒烟完成“建课 -> 加学生 -> 建草稿 -> 重复安全发布 -> 学生保存
  -> 提交 -> 保存 403 -> 助教退回 -> 学生重新保存 200”；扩展冒烟还覆盖并发发布、
  草稿修改、成员增改删、学生数据裁剪、坏请求 400 和审计动作。自动验证数据已清理。
- 尚未包含阶段 11 合并审核、阶段 12 确定范围、自动保存、实时协作和局部 snapshot 裁剪。

本文件记录跨对话、跨 agent 的实际开发变更。它和 `CLAUDE_WORK.md` 分工不同：

- `CLAUDE_WORK.md`：本机 ignored 文件，只写当前下一轮任务，不提交。
- `docs/development-log.md`：仓库内长期更新日志，提交到 git，记录已经发生的关键改动、验证和遗留风险。
- `docs/kunqu-platform-roadmap.md`：路线图和阶段计划，记录更大的架构方向和阶段状态。

记录规则：

- 新条目放在最上方。
- 只写有长期价值的信息，不粘贴大段终端原始日志。
- 不写私有绝对路径、访问 token、生产密码或大段样例数据。
- 后端/数据库/API/平台 UI 的重要变化必须记录验证命令和剩余风险。

## 2026-07-27

### 阶段 9 第二轮审查：权限边界、资源所有权与僵尸接口清理

Codex 在首轮权限闭环提交后继续做了权限核心、API、前端只读路径和资源查询的第二轮审查，并修复以下问题：

- 权限核心：
  - 受限 grant 不再授权缺少 project/document/track 约束的宽范围请求。
  - 未知历史 action 安全返回未授权，不抛运行时异常。
  - mutation 数组中的非对象、重复 id 不再被 `Map`/过滤逻辑静默吞掉。
  - 畸形 `branchScope` 和不存在的递归 lane 被标记为需要 manage 的异常修改。
- grant 与审计：
  - 文档 grant 接口不再混入暂时无法由该接口更新/撤销的 project-level grant。
  - 受限 manager 只能看到自己 manage scope 覆盖的授权；文档主体仅向整文档 manager 附带完整 grant 清单。
  - 拆开 mutation scope 与 grant scope 的空轨道语义；“全轨道、限时段”的 manager 现在可以管理同范围或更窄授权，同时仍不能编辑无法识别轨道的 mutation。
  - 全局审计只对 admin 开放；TA/teacher 必须指定可管理项目或整文档 manage 文档。
  - project/document 审计筛选不一致时返回 `400`。
- 文件、媒体与项目：
  - teacher/TA 不再全局列出所有文件和媒体，只能看到自己拥有或有效 grant 可见的资源。
  - 项目摘要的文档数量按当前用户可见文档计算，避免侧信道泄露其他课堂作业数量。
  - `MediaAsset` 增加可空 `ownerUserId`；新媒体记录创建者，即使尚未绑定文件/项目也可被创建者继续管理。
  - 创建项目会校验媒体资产可见性。
- 后台任务：
  - 路由校验任务类型、非空文件 id 和 documentId。
  - 普通用户必须可读输入文件、可编辑关联文档；service 也只能引用真实文件。
- 清理：
  - 删除未使用的 `canPerformAction` 别名和与真实 HttpError 结构不一致的 `PermissionScopeViolationBody`。

验证：

- `npm run test:permissions`：12 项通过。
- `npm run build`：Prisma、shared、document-model、web、API 全部通过。
- `npm run db:push`：本地 PostgreSQL schema 同步通过。
- API 冒烟：全局/文档审计权限、错误筛选、任务坏输入/不存在文件、admin/TA/student 资源可见性、TA 创建未绑定媒体并重新列出均符合预期；临时媒体与审计数据已清理。

残余设计边界：

- track/time `view` scope 当前仍是文档准入和前端范围描述，不会裁剪整份 snapshot。局部读取需与后续 fragment/operation/delta 协议共同设计，避免保存时删除未加载内容。
- `MediaAsset.ownerUserId` 对旧数据为可空；无法从旧记录可靠推断创建者，只能继续通过主文件或项目关系授权。
- 当前 repository 仍保留为分片上传预留的 pending/finalize 方法；它们有明确后续用途且有注释，不视为僵尸代码。

### Codex 修复 DeepSeek 阶段 9 权限实现

在上一条阻断审查之后，Codex 完成了权限实现的修复、清理和验证：

- 将 `packages/shared`、`packages/document-model` 改为可运行的 workspace 包，API 改为直接使用 `@xiqu/document-model`；删除 API 侧复制权限实现和源码目录误生成的 JavaScript。
- 修复 grant 用户判定优先级、动作隐含关系、过期授权、项目级授权、owner/admin 语义以及 teacher/TA 全局越权。
- 重写 snapshot mutation 分析，覆盖视频、点时间、真实动作/工尺父轨、递归分叉共有块、附属点、轨道结构和未知字段。
- grant CRUD 增加运行时校验、真实轨道校验、scope 清空语义和 manage 防提权；越权保存使用标准 `HttpError` 返回结构化 403。
- 前端权限加载改为 fail-closed，document state 增加整文档只读写保护；保存和版本按钮按有效权限显示。
- 额外修复空 body POST 携带 JSON content type、Fastify 4xx 被包装成 500 的既有错误。

验证：

- `npm run test:permissions`：8 项通过。
- `npm run build`：Prisma、shared、document-model、web、API 全部通过。
- `npm run db:push`：本地 PostgreSQL 16 schema 同步通过。
- API 冒烟通过：admin/TA/student 登录、项目与文档可见性、只读读取、scoped edit 范围内保存、范围外 403、非法 action/轨道 400、受限用户防提权 403、edit 创建版本、无 manage 恢复版本 403。

遗留项：

- grant 管理 UI 和 scoped-edit 时间/轨道可视提示尚未实现。
- 本轮 operation log 仍只记录摘要，不驱动 snapshot；实时协作仍属后续阶段。

### DeepSeek 阶段 9 权限范围实现审查：阻断提交

DeepSeek 在 `codex/backend-permission-scopes` 分支实现了 permission grant API、有效权限摘要、snapshot mutation 范围校验和前端最小接入。Codex 审查后确认该版本可以通过 TypeScript 构建与 Prisma schema 校验，但权限安全和交付完整性仍存在阻断问题，因此本轮没有提交，也没有启动后端供试用。

主要阻断项：

- API 使用 `apps/api/src/permissionsClient.ts` 复制了一套权限实现，没有复用 `packages/document-model/src/permissions.ts`；两套逻辑已经存在差异，后者当前基本未进入运行路径。
- 越权保存抛出普通对象，而全局错误处理器只识别 `HttpError`，实际会返回 `500 internal_error`，不是约定的 `403 permission_scope_violation`。
- grant 创建/修改接口缺少 action、scope、时间、轨道和过期时间的运行时校验，也没有防止受限 `manage` 用户创建超出自身权限的 grant。
- snapshot mutation 提取遗漏或错误映射了视频、板眼/附属点的单点时间、动作块真实轨道、工尺谱父轨和递归分叉归属，存在范围校验绕过和误拒绝。
- 旧的 `canDocumentGrant()`、项目查询和 operation API 仍忽略 grant 过期、动作隐含关系及 owner 语义；版本恢复仍以 `edit` 为入口，与权限文档要求的 `manage` 不一致。
- 前端权限查询失败时回退到 `null` 并继续进入编辑器；当前只拦截服务器保存，没有形成完整只读状态。保存错误还检查了不存在的 `statusCode` 字段，而 `PlatformApiError` 暴露的是 `status`。
- 源码目录出现未跟踪的编译产物 `.js`；另有新增 grant client 方法和大部分 document-model 权限 helper 当前没有实际调用。
- `docs/kunqu-platform-roadmap.md` 未更新，本轮也没有增加权限用例或 API 冒烟验证。

验证：

- `npm run build`：通过。
- `npx prisma validate`：通过。
- 纯函数回归验证确认：
  - 当前 `canPerformActionWithGrants()` 会把其他用户的某些 grant 错判给当前用户。
  - 将板眼时间从授权范围内移动到范围外时，mutation 没有时间范围，校验错误放行。
  - 修改项目视频字段不会生成 mutation。

后续应先修复并补齐权限核心与 API 冒烟矩阵，再由 Codex 复审；在此之前不要提交或启动该后端版本。

## 2026-07-07

### Claude Code 任务交接与实际完成内容

本轮采用“Codex 制定任务单 -> Claude/GLM 实现 -> Codex 审查修复”的协作流程。

Codex 写入 `CLAUDE_WORK.md` 的任务边界：

- 当前任务只做前端 pending operations 与服务端 operation log 的连接。
- 不做实时协同、WebSocket、CRDT、课堂作业、权限范围 diff 校验或版本 diff UI。
- 保存到服务器前先提交本地 pending operations，成功保存 snapshot 后再确认本地 pending。
- operation log payload 只能上传摘要，不上传完整 `ProjectData` / `beforeProject` / `afterProject`。
- 失败时必须区分 `conflict` / `offline` / `error`，不能错误调用 `markProjectAsSaved()`。
- 必须维护 `docs/kunqu-platform-roadmap.md`，并运行 `npm run build` / `npx prisma validate`。

Claude/GLM 最新提交 `b0df88e` 实际完成：

- 新增 `src/utils/platformOperations.ts`：
  - `buildServerOperationRequest()`：把本地 `ProjectDocumentOperation` 转成服务端 operation log 请求。
  - `submitPendingOperations()`：顺序提交 pending operations。
  - `describeServerSaveError()`：把保存错误归类为 conflict/offline/error。
- 修改 `src/App.tsx`：
  - `saveProjectToServer()` 先提交 pending operations，再调用 `/save` 保存完整 snapshot。
  - 成功后更新 remote revision 并调用 `markProjectAsSaved()`。
  - 失败时保留 pending operations，不清空本地状态。
- 修改 `src/state/projectDocumentState.ts`：
  - 暴露 `pendingOperationsRef`，让保存流程读取最新 pending。
- 更新 `docs/kunqu-platform-roadmap.md`：
  - 记录该过渡设计：operation log 只记录摘要，snapshot 仍由 `/save` 写入。

Codex 审查发现并修复：

- 保存期间继续编辑可能被误标为已保存。
- snapshot 保存失败后重试可能重复提交已经写入服务端的 operation rows。

### 修复服务器保存竞态与 operation 重复提交

本轮审查前端 pending operations 接入服务端 operation log 后，修复两个保存路径问题：

- 保存期间继续编辑时，新编辑不再被误标为已保存：
  - 保存开始时固定 `projectSnapshot`、`trackSnapSnapshot` 和 pending operation 快照。
  - `/save` 只保存这个固定项目快照。
  - 保存成功后只确认本次快照覆盖的 operation ids。
  - 如果保存过程中用户继续编辑，新 operation 会留在 pending 中，状态回到 dirty。
- snapshot 保存失败后重试不再重复提交已经写入服务端的 operation：
  - `ProjectDocumentOperation.syncState` 增加 `submitted`。
  - `submitPendingOperations()` 跳过 `submitted` operation。
  - 提交过程中每成功一条就回调记录 id；如果后续失败，这些 id 会被标成 `submitted`，下次重试不会重复写 operation rows。
- 保存按钮重复触发被 `serverSaveInFlightRef` 拦截，避免并发保存同时提交同一批 operation。

验证：

- `npm run build`：通过。
- `npx prisma validate`：通过。

遗留风险 / 下一步：

- 当前去重是前端状态级别；如果用户刷新页面后重试，服务端仍没有基于 `localOperationId` 的唯一约束。
- 后续若 operation log 成为协同同步协议，应考虑服务端幂等键或 `clientOperationId` 字段。

### 后端审计与 operation log 审查修复

本轮在审查 GLM/Claude 对平台后端审计日志与标注操作日志的实现后，补强了 API 运行时边界，并同步维护交接文档。

变更：

- `apps/api/src/router.ts`
  - `GET /api/audit-logs` 的 `limit` 现在必须是正整数。
  - `POST /api/annotation-documents/:documentId/operations` 现在校验：
    - `baseRevision` 必须是非负整数。
    - `localRevision` 必须是非负整数或 `null`。
    - `action` 必须是非空字符串。
  - 目的：坏 JSON 不应穿透到 Prisma 并返回 `500 internal_error`。
- `prisma/schema.prisma`
  - 修正 `AnnotationOperation` 注释：当前语义是 `baseRevision` 冲突直接返回 `409 conflict`，不落 `rejected` operation 行。
- `docs/kunqu-platform-roadmap.md`
  - 记录本次代码审查后的输入校验修复。
- `AGENTS.md`
  - 补充当前后端已经有 audit log / annotation operation log。
  - 说明 operation log 当前只记录操作，不修改 document snapshot。
  - 说明 audit detail 只存摘要，不存完整标注 payload 或文件内容。
  - 补充 `CLAUDE_WORK.md` 的本机任务交接规则。
- `CLAUDE_WORK.md`
  - 已重写为下一轮“前端 pending operations 接入服务端 operation log”的详细本机任务单。
  - 该文件被 `.gitignore` 忽略，不提交。

验证：

- `npm run build`：通过。
- `npx prisma validate`：通过。
- 临时 API 端口冒烟：
  - `limit=abc` -> `400 bad_request`
  - `limit=1.5` -> `400 bad_request`
  - `localRevision: "x"` -> `400 bad_request`
  - 空白 `action` -> `400 bad_request`
  - 过期 `baseRevision` -> `409 conflict`

遗留风险 / 下一步：

- 前端 `pendingOperations` 尚未提交到服务端 `annotation_operations`。
- 当前 operation log 仍是记录层，不是差分同步或协同编辑协议。
- 自动保存、离线恢复、权限范围 diff 校验、版本 diff UI 仍未实现。
