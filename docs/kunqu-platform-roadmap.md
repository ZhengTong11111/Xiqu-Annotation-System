# 昆曲多模态学术数据库与课堂标注平台完整改造路线图

本文档记录从当前 React/TypeScript 本地标注工具，逐步升级为完整前后端、账号权限、统一文件系统、版本管理、独立/协同标注、课堂作业、学术数据库与后端分析服务平台的工程计划。

当前分支：`codex/aggressive-backend-collab-save`

## 1. 最终目标

最终项目不应只是一个字幕或时间轴编辑器，而应成为一个面向昆曲研究、教学、资料整理和多模态分析的综合平台。

目标形态：

- 有账号、角色、权限、课程、项目、作业与管理后台。
- 所有视频、音频、标注、工尺谱、板眼、频谱、音高、姿态、渲染结果统一管理。
- 每个视频可以拥有多个标注文档、多个版本、多个标注任务与多个审定结果。
- 支持独立标注、协同标注、课堂分发、助教管理、教师审核、版本合并。
- 支持确定标注区间，对某视频的某时间段、某轨道范围进行审定和锁定。
- 支持公网服务器部署，供多个账号访问。
- 预留后端任务系统，后续接入音高提取、五线谱处理、姿态估计、工尺谱渲染、谱例导出等服务。
- 保留并增强当前时间轴标注工具，让它成为平台中的核心编辑器。

## 2. 当前项目基础

当前仓库是一个 Vite + React + TypeScript 前端项目。

已有能力：

- 多轨时间轴编辑。
- 字符级字幕、句级字幕、动作轨、自定义轨、附属点轨。
- 工尺谱附属轨、工尺谱导入、单字预览渲染。
- 板眼轨、板眼解析、板眼编辑、板眼全局纵线。
- 音频波形、人声频谱图、F0 曲线预留。
- 循环播放、快捷键、框选、多选、复制/剪切/粘贴。
- 可分离的视频/时间轴窗口。
- 本地 JSON 项目保存、导入、合并。
- `src/state/projectDocumentState.ts` 中已有本地 revision、operation log、sync state 的雏形。

主要不足：

- 没有后端服务。
- 没有账号系统。
- 没有数据库。
- 没有统一文件系统。
- 没有服务端保存和权限校验。
- 没有真正的多用户同步。
- 版本和操作日志仍停留在前端本地。
- 当前 `ProjectData` 是单体大对象，不适合直接作为长期服务端协同数据模型。

## 3. 总体工程策略

不要推倒当前标注工具。推荐采用“平台外壳 + 当前编辑器子应用”的迁移方式。

改造方向：

```text
当前单页标注工具
  -> monorepo 全栈项目
  -> 登录与主页
  -> 项目/视频/文件库
  -> 服务端标注文档保存
  -> 版本管理
  -> 权限授权
  -> 独立标注任务
  -> 审核与合并
  -> 实时协同
  -> 后端多模态任务服务
```

架构原则：

- 前端编辑体验优先保持稳定。
- 后端先承接保存、版本、权限，再进入实时协同。
- 类型、数据模型、权限规则前后端共享。
- 本地编辑和远端同步分层，不把网络逻辑散落到时间轴组件里。
- 所有关键行为都有审计日志。
- 所有研究数据都可追溯来源、版本、责任人和时间。

## 4. 推荐最终代码结构

建议演进为 TypeScript monorepo：

```text
apps/
  web/
    src/
      app/
      pages/
      features/
      editor/
      components/
      api/
      state/
      routes/
  api/
    src/
      modules/
      routes/
      services/
      auth/
      db/
      storage/
      realtime/
  worker/
    src/
      jobs/
      processors/
      adapters/

packages/
  shared/
    src/
      types/
      schemas/
      permissions/
      api-contracts/
  document-model/
    src/
      project-data/
      operations/
      snapshots/
      merge/
      validation/
  realtime/
    src/
      protocol/
      presence/
      conflict/
  config/

prisma/
  schema.prisma
  migrations/

docs/
  kunqu-platform-roadmap.md
  state-architecture.md
  api/
  database/
  permissions/
```

第一阶段可以不立刻迁移全部目录，但应按这个目标设计新增代码。

## 5. 推荐技术选型

### 5.1 前端

- React 18。
- Vite。
- TypeScript。
- React Router。
- TanStack Query 或类似请求缓存层。
- IndexedDB 用于离线草稿和大文档缓存。
- 当前编辑器状态继续以 `useProjectDocumentState()` 为基础演进。

### 5.2 后端

推荐两种路线：

方案 A：Fastify + Prisma

- 更轻量。
- 更适合从当前项目渐进引入。
- 路由、服务、schema 可以按模块组织。

方案 B：NestJS + Prisma

- 更重，但模块化、权限、依赖注入、WebSocket 组织更清晰。
- 适合最终多人团队长期维护。

建议：先用 Fastify 快速搭骨架，后续如果模块急剧膨胀再评估 NestJS。

### 5.3 数据库与文件系统

- PostgreSQL：核心元数据、权限、版本、任务、审计。
- S3-compatible object storage：视频、音频、图片、渲染结果、大型中间文件。
- 本地开发可使用本地目录或 MinIO。
- Redis：实时协同 presence、任务队列、锁、缓存。
- BullMQ 或类似队列：后端分析任务。

### 5.4 实时同步

分阶段：

- 第一阶段：服务端保存整份快照 + operation log。
- 第二阶段：WebSocket 广播操作。
- 第三阶段：根据冲突复杂度引入 Yjs/CRDT 或自研 operation transform。

当前时间轴的编辑操作多为结构化块操作，短期可先做“服务端序列化操作 + revision 校验”，不要一开始就把所有内容 Yjs 化。

## 6. 核心领域模型

### 6.1 账号与组织

```text
User
Role
Organization
Course
CourseMember
PermissionGrant
AuditLog
```

角色建议：

- `super_admin`
- `admin`
- `teacher`
- `ta`
- `annotator`
- `reviewer`
- `service`

权限建议采用：

```text
RBAC 角色权限 + ABAC 项目/轨道/时间范围授权
```

不要只靠角色判断编辑能力。一个学生是否能编辑，要看具体项目、文档、轨道、时间范围、任务状态。

### 6.2 媒体与剧目资料

```text
Work              剧目，例如《牡丹亭》
Excerpt           折子，例如《寻梦》
Performance       演出/版本/演员/来源信息
MediaAsset        媒体资产逻辑对象
MediaFile         实际文件对象
FileObject        统一文件记录
```

`MediaAsset` 不等于文件。一个视频资产可能有原始文件、压缩代理文件、音频抽取文件、缩略图、频谱缓存。

### 6.3 标注文档

```text
AnnotationProject
AnnotationDocument
AnnotationVersion
AnnotationSnapshot
AnnotationOperation
AnnotationBranch
ConfirmedRange
```

关系示意：

```text
MediaAsset
  └─ AnnotationProject
       ├─ Base Document
       ├─ Class Assignment Document
       ├─ Student Independent Document
       ├─ Collaborative Document
       └─ Published / Confirmed Versions
```

当前 `ProjectData` 可先作为 `AnnotationSnapshot.payload` 存储，但长期应拆出元数据与大文档 payload。

### 6.4 标注授权

```text
AnnotationAssignment
AssignmentMember
AssignmentScope
```

授权范围必须支持：

- 文档范围。
- 时间范围。
- 轨道范围。
- 权限动作：查看、编辑、评论、提交、审核、合并、确认。
- 模式：独立标注、协作标注。
- 有效时间。
- 是否允许导出。
- 是否允许查看他人标注。

### 6.5 后端任务

```text
ProcessingJob
ProcessingJobInput
ProcessingJobOutput
ProcessingJobLog
```

任务类型预留：

- `pitch_extraction`
- `spectrogram_generation`
- `staff_notation_render`
- `gongche_render`
- `pose_estimation`
- `video_transcode`
- `audio_extract`
- `annotation_export`

## 7. 数据库初版表设计

第一版可以包括：

```text
users
roles
user_roles
organizations
courses
course_members

files
media_assets
media_files
works
excerpts
performances

annotation_projects
annotation_documents
annotation_versions
annotation_snapshots
annotation_operations
annotation_branches
confirmed_ranges

annotation_assignments
assignment_members
assignment_scopes

merge_requests
merge_request_items
review_comments

collaboration_sessions
collaboration_presence
document_locks

processing_jobs
processing_job_inputs
processing_job_outputs

audit_logs
```

第一阶段不必全部实现，但 schema 设计要预留这些关系。

## 8. 标注流程设计

### 8.1 学术研究整理流程

1. 管理员上传视频或登记媒体来源。
2. 创建剧目、折子、演出资料。
3. 创建基准标注文档。
4. 导入字幕、工尺谱、板眼初始数据。
5. 研究人员细修字块、动作、板眼、工尺谱、音频分析。
6. 教师/管理员审定某些时间范围。
7. 发布版本。
8. 后续新研究可从发布版本分支。

### 8.2 课堂作业流程

1. 教师创建课程。
2. 助教导入学生账号。
3. 教师选择视频、时间范围、轨道范围。
4. 创建独立标注任务。
5. 每个学生获得独立副本。
6. 学生完成并提交。
7. 助教查看进度和质量。
8. 教师选择优秀标注或片段合并。
9. 合并结果进入课程基准版本或研究库候选版本。

### 8.3 协同研究流程

1. 创建协作文档。
2. 分配多个研究人员。
3. 多人同时进入编辑器。
4. WebSocket 同步 presence、选区、操作。
5. 服务端按 revision 接收操作。
6. 冲突时自动重放或进入人工解决。
7. 定期生成 snapshot。
8. 阶段性发布版本。

### 8.4 审核与确定标注流程

1. 审核者选择某个时间范围和轨道范围。
2. 对标注进行确认。
3. 生成 `ConfirmedRange`。
4. 普通用户无法修改该范围。
5. 修改必须通过解除确认或提交修改申请。
6. 导出数据库时优先使用确定标注。

## 9. API 设计方向

### 9.1 认证

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/refresh
```

### 9.2 项目与媒体

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId

POST   /api/media
GET    /api/media/:mediaId
POST   /api/files/upload-url
POST   /api/files/complete
```

### 9.3 标注文档

```text
GET    /api/annotation-documents/:documentId
POST   /api/projects/:projectId/documents
PATCH  /api/annotation-documents/:documentId
POST   /api/annotation-documents/:documentId/save
POST   /api/annotation-documents/:documentId/operations
GET    /api/annotation-documents/:documentId/operations
```

### 9.4 版本

```text
GET    /api/annotation-documents/:documentId/versions
POST   /api/annotation-documents/:documentId/versions
GET    /api/annotation-versions/:versionId
POST   /api/annotation-versions/:versionId/restore
```

### 9.5 授权与作业

```text
GET    /api/assignments
POST   /api/assignments
GET    /api/assignments/:assignmentId
PATCH  /api/assignments/:assignmentId
POST   /api/assignments/:assignmentId/submit
GET    /api/assignments/:assignmentId/progress
```

### 9.6 合并与审核

```text
POST   /api/merge-requests
GET    /api/merge-requests/:mergeRequestId
POST   /api/merge-requests/:mergeRequestId/apply

POST   /api/confirmed-ranges
DELETE /api/confirmed-ranges/:confirmedRangeId
```

### 9.7 后端任务

```text
POST   /api/jobs
GET    /api/jobs/:jobId
GET    /api/jobs/:jobId/outputs
```

### 9.8 实时协同

```text
WS /api/realtime/documents/:documentId
```

事件类型：

```text
client.join
client.leave
presence.update
document.operation
document.ack
document.conflict
document.snapshot
lock.acquire
lock.release
```

## 10. 前端页面规划

```text
/login
/home
/projects
/projects/:projectId
/projects/:projectId/documents/:documentId
/courses
/courses/:courseId
/courses/:courseId/assignments/:assignmentId
/review/:documentId
/admin/users
/admin/roles
/admin/storage
/jobs
```

当前 `App.tsx` 应逐步拆成：

```text
AnnotationEditorPage
  ├─ EditorShell
  ├─ ProjectDocumentProvider
  ├─ VideoWorkspace
  ├─ TimelineWorkspace
  ├─ InspectorWorkspace
  └─ SaveSyncStatusBar
```

但第一阶段不要大拆 Timeline。先把页面和数据加载边界搭起来。

## 11. 修改阶段计划

### 阶段 0：冻结现状与建立保护线

目标：保证大改时可以回退。

任务：

- 确认当前分支为 `codex/aggressive-backend-collab-save`。
- 运行 `npm run build`。
- 给当前编辑器行为补充最小冒烟测试脚本或手动检查清单。
- 记录当前 `ProjectData` schema 版本。

验收：

- 当前编辑器仍可打开、导入、保存、播放、编辑。
- 文档说明当前功能基线。

### 阶段 1：建立平台设计文档与共享类型边界

目标：先规范模型，再开始写服务。

任务：

- 新增 `packages/shared` 规划。
- 把 `ProjectData` 相关类型设计为可前后端共享。
- 定义权限常量。
- 定义 API response/error 格式。
- 定义 document revision 与 operation 类型。

验收：

- 前端仍可 build。
- 类型没有重复定义。

### 阶段 2：Monorepo 基础迁移

目标：为前后端共存做工程结构准备。

任务：

- 建立 `apps/web`。
- 将当前前端移动到 `apps/web/src`。
- 配置 workspace。
- 保持 `npm run build` 或新增根命令 `npm run build:web`。
- 保留现有静态资源路径。

验收：

- 前端功能不变。
- 构建命令通过。

风险：

- Vite 路径、public 资源、worker 路径可能需要调整。

### 阶段 3：后端 API 骨架

目标：有可运行服务，但不急于接入编辑器。

任务：

- 新建 `apps/api`。
- 增加 health check。
- 增加统一 env 配置。
- 增加错误响应格式。
- 增加日志。
- 增加 Prisma 或数据库访问层骨架。

验收：

- `GET /api/health` 正常。
- API 可独立启动。

### 阶段 4：账号系统第一版

目标：能登录、区分角色、获取当前用户。

任务：

- 设计 user/role 表。
- 实现密码 hash。
- 实现 login/logout/me。
- 前端新增 LoginPage。
- 前端新增 AuthProvider。
- 增加路由守卫。

验收：

- 未登录不能进入项目主页。
- 登录后能看到用户身份。
- 管理员/助教/学生角色可区分。

### 阶段 5：主页与项目库

目标：从“打开工具”变成“进入平台”。

任务：

- 新增 HomeDashboard。
- 新增 ProjectLibrary。
- 新增 ProjectDetail。
- 支持列出视频、项目、标注文档。
- 当前编辑器挂到 `documents/:documentId`。

验收：

- 登录后先进入主页。
- 点击项目后进入标注工具。
- 本地 mock 数据仍可通过开发入口打开。

### 阶段 6：统一文件系统第一版

目标：视频、项目文件、导出结果不再散落在浏览器本地。

任务：

- 设计 files/media_assets/media_files 表。
- 实现文件上传。
- 本地开发使用磁盘或 MinIO。
- 保存文件 hash、size、mime、owner、visibility。
- 前端项目创建时可以选择已上传媒体。

验收：

- 视频可上传并登记。
- 项目可绑定媒体资产。
- 后续打开项目不依赖本机绝对路径。

### 阶段 7：服务端标注文档保存

目标：把 `ProjectData` 保存到服务器。

任务：

- 设计 annotation_documents/snapshots 表。
- 实现加载文档。
- 实现保存快照。
- 前端新增 `ProjectDocumentRemoteClient`。
- 当前 `saveProjectFile` 保留本地导出，同时新增“保存到服务器”。
- `useProjectDocumentState` 接入 remote saved revision。

验收：

- 编辑后可保存到服务器。
- 刷新页面可从服务器恢复。
- 本地 JSON 导出不被破坏。

### 阶段 8：版本管理

目标：每个标注文档可保存多个版本。

任务：

- 设计 annotation_versions。
- 支持手动命名版本。
- 支持自动保存快照。
- 支持版本列表。
- 支持恢复版本。
- 支持版本备注。

验收：

- 同一视频可有多个标注版本。
- 可从旧版本恢复为新草稿。
- 恢复操作有审计记录。

### 阶段 9：权限范围与只读裁剪

目标：账号只能操作被授权范围。

任务：

- 设计 permission grants / assignment scopes。
- 支持按项目、文档、轨道、时间范围授权。
- 前端根据权限禁用不可编辑内容。
- 后端保存时校验操作是否越权。

验收：

- 学生只能编辑分配范围。
- 助教可查看进度但不一定能修改全部内容。
- 管理员可修改所有内容。

### 阶段 10：独立标注作业

目标：课堂分发场景可用。

任务：

- 设计 courses/assignments。
- 教师/助教创建作业。
- 为学生生成独立标注文档。
- 学生提交。
- 助教查看完成度、提交状态、最后编辑时间。

验收：

- 同一个视频可分发给多个学生。
- 每个学生得到独立文档。
- 助教能查看进度。

### 阶段 11：合并与审核

目标：将学生/研究者标注片段合并到基准文档。

任务：

- 设计 merge_requests。
- 支持选择源文档、目标文档、时间范围、轨道范围。
- 显示差异。
- 支持整段合并、部分轨道合并、拒绝。
- 合并后生成新版本。

验收：

- 可把某学生的一段优秀标注合并进教师文档。
- 合并来源可追溯。
- 原文档不被破坏。

### 阶段 12：确定标注与锁定

目标：建立学术数据库可信标注机制。

任务：

- 设计 confirmed_ranges。
- 支持按时间范围、轨道范围确认。
- 前端显示确定范围。
- 确定范围普通用户只读。
- 管理员/教师可解除确认。

验收：

- 已确定标注不能被普通编辑误改。
- 导出时可优先导出确定标注。

### 阶段 13：服务端 operation log

目标：从全量保存过渡到操作级保存。

任务：

- 扩展 `ProjectDocumentOperation`。
- 服务端接收 operation。
- 服务端记录 baseRevision/localRevision。
- 定期生成 snapshot。
- 前端 pending operation 自动同步。

验收：

- 断网后恢复可以继续同步。
- 操作日志可回放到文档状态。

### 阶段 14：实时协同第一版

目标：多人同时打开同一文档可看到基本同步。

任务：

- WebSocket 连接。
- presence 在线状态。
- 广播选区/光标。
- 广播提交后的 operation。
- 服务端 revision 校验。
- 简单冲突提示。

验收：

- 两个账号打开同一文档，一个人修改后另一个人可看到。
- 在线用户列表可见。
- 冲突不会静默覆盖。

### 阶段 15：实时协同增强

目标：协作可用于真实研究。

任务：

- 引入细粒度锁或 CRDT。
- 对时间轴块移动、边界调整、文本编辑分别处理冲突。
- 支持协作评论。
- 支持用户颜色、轨迹、最近修改标记。
- 支持协同撤销策略。

验收：

- 多人同时编辑不同轨道稳定。
- 多人编辑同一块有明确冲突处理。

### 阶段 16：后端任务系统

目标：为音高、五线谱、姿态、渲染服务预留统一入口。

任务：

- 设计 processing_jobs。
- Worker 队列。
- 文件输入输出。
- 前端任务面板。
- 任务结果可绑定到标注文档或媒体资产。

验收：

- 可以提交一个 mock job。
- job 有 queued/running/succeeded/failed 状态。
- 输出文件可被项目引用。

### 阶段 17：音高、频谱、谱例服务迁移

目标：把重计算从浏览器逐步迁到服务端。

任务：

- 服务端音频抽取。
- 服务端音高提取。
- 服务端频谱缓存。
- 五线谱/音高曲线导出。
- 前端保留即时预览能力。

验收：

- 大文件不再完全依赖浏览器计算。
- 结果可复用、可版本化。

### 阶段 18：姿态估计与动作数据接入

目标：支持多模态研究。

任务：

- 定义 pose result schema。
- 接入外部姿态估计服务。
- 姿态结果绑定视频时间轴。
- 允许由姿态结果辅助生成动作轨。

验收：

- 一个视频可关联姿态分析结果。
- 时间轴可显示或引用姿态事件。

### 阶段 19：公开数据库与检索

目标：从内部工具升级为可查询学术数据库。

任务：

- 设计检索索引。
- 支持按剧目、折子、演员、声腔、工尺谱、板眼、动作、时间范围检索。
- 支持只读公开页面。
- 支持引用链接。
- 支持导出学术数据包。

验收：

- 可查询某类板眼/工尺谱/唱腔片段。
- 可打开对应视频时间点。
- 可引用版本固定的数据。

### 阶段 20：部署、备份与运维

目标：公网稳定使用。

任务：

- Docker Compose 开发部署。
- 生产部署脚本。
- 数据库备份。
- 文件存储备份。
- 日志与监控。
- 管理员初始化。
- HTTPS、域名、CORS、安全 header。

验收：

- 可在独立服务器运行。
- 数据可备份恢复。
- 服务异常可定位。

## 12. 当前仓库近期建议执行顺序

建议接下来按这个实际顺序推进：

1. 补充本路线图。
2. 新增 `docs/database-model.md`。
3. 新增 `docs/permissions-model.md`。
4. 新增 `docs/api-design.md`。
5. 建立 `packages/shared`，先不迁移全部代码。
6. 建立 `apps/api` 最小服务。
7. 建立登录页和平台路由壳。
8. 把当前编辑器包成 `AnnotationEditorPage`。
9. 实现服务端文档保存。
10. 实现版本管理。

这样每一步都有可验证结果，不会在第一周就陷入“大拆 App.tsx 后全站不可用”的状态。

## 13. 验收总清单

最终项目应满足：

- 管理员可以创建账号和分配角色。
- 助教可以创建和管理课堂标注任务。
- 学生可以看到自己的作业并进入标注。
- 研究人员可以创建协作文档。
- 视频和标注统一保存，不依赖本机绝对路径。
- 每个标注文档有版本列表。
- 每次保存和发布可追溯。
- 每个用户只能编辑授权范围。
- 确定标注区间可锁定。
- 可从多个独立标注文档中合并片段。
- 多人协同编辑有同步、presence 和冲突处理。
- 后端任务系统可运行。
- 音高/姿态/渲染等结果可绑定回项目。
- 公开数据库可检索、引用、导出。
- 服务器可部署、备份、恢复。

## 14. 高风险点

- 过早重构 Timeline 会拖慢平台搭建。
- 过早实时协同会放大当前大对象状态的问题。
- 权限只做前端限制会导致数据安全问题。
- 文件系统若没有统一 file id，后续迁移服务器会非常痛苦。
- 标注版本如果没有 snapshot + operation 双层机制，恢复和协同都会困难。
- 工尺谱渲染字体存在授权风险，公开服务器发布前必须替换或取得许可。
- 大视频、频谱、音高、姿态估计会带来存储与计算成本，需要从一开始记录文件来源、缓存和生命周期。

## 15. 推荐里程碑

### M1：平台骨架

- 登录。
- 主页。
- 项目列表。
- 进入当前编辑器。

### M2：服务端保存

- 后端 API。
- 数据库。
- 标注文档保存/加载。
- 版本列表。

### M3：课堂作业

- 课程。
- 学生账号。
- 独立标注任务。
- 进度管理。

### M4：审核合并

- 版本对比。
- 片段合并。
- 确定标注。

### M5：协同编辑

- WebSocket。
- presence。
- operation 同步。
- 冲突提示。

### M6：多模态服务

- job queue。
- 音高/频谱服务端计算。
- 姿态估计接入。

### M7：公开学术数据库

- 检索。
- 引用。
- 导出。
- 权限分级公开。

## 16. 对当前代码的第一批具体改动建议

第一批代码变动不要超过这些范围：

- 新增 `docs/` 设计文档。
- 新增 `packages/shared` 的空壳和类型迁移计划。
- 新增 `apps/api` 的 health check。
- 前端新增 `routes` 和 `pages` 目录。
- 当前 `App.tsx` 暂时保留为编辑器主体。
- 新增 `AnnotationEditorPage` 包装现有工作台。

暂时不要做：

- 不要立刻把 `Timeline.tsx` 拆大块。
- 不要立刻把 `ProjectData` 拆成数据库多表实时编辑。
- 不要立刻上 CRDT。
- 不要立刻删除本地 JSON 导入导出。

## 17. 判断项目是否走偏的标准

如果出现以下情况，应暂停并回到设计：

- 普通标注编辑体验明显退化。
- 本地导入/导出无法使用。
- 权限逻辑散落在多个 UI 组件里。
- 后端保存只存一个不可追踪的大 JSON，且没有版本。
- 多人协同直接覆盖对方修改。
- 文件仍依赖本机绝对路径。
- 审定数据无法追踪是谁、何时、基于哪个版本确认。

## 18. 结论

这个项目最合理的路线是：

```text
先平台化
再服务端保存
再版本和权限
再课堂作业与审核合并
再实时协同
最后扩展后端多模态服务与公开数据库
```

当前标注工具已经足够复杂，接下来最重要的不是继续往 `App.tsx` 和 `Timeline.tsx` 里直接堆功能，而是建立清晰的前后端边界、数据模型、权限模型、文件系统和版本体系。只要这个地基打稳，后面的协同编辑、课堂教具、学术数据库和自动分析服务都能自然接上。
