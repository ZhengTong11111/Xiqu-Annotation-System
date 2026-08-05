# 昆曲多模态学术数据库与课堂标注平台路线图

本文档只描述**当前有效架构、阶段顺序和未来目标**。已经撤销的 Course/Assignment、
Workspace/Fork、完成版本和项目发布版本模型仅在 `docs/development-log.md` 中作为历史记录保留，
不得据此继续实现。

最后更新：2026-08-05

当前开发基线：R1-R4 工程闭环与 R5 实时多人协作、原子领域命令提交、显式并发冲突处理及
单服务器可部署候选门禁均已完成。平台现已补齐管理员账号生命周期、所有账号自助改密、标注文件与
媒体资源的数据库外键绑定，以及双账号 revision 竞争后的无冲突命令自动重放。clean 客户端现分别记录
“协作通道已观察 revision”和“已进入本地 ProjectData 的 revision”，两者存在缺口时暂停开始新写操作，
待权威 HTTP catch-up 完成后恢复，避免从已知过时快照制造本可避免的同目标冲突。当前新增 R3h
外部媒体与分析资产路线，用四个独立闭环依次补齐跨目录媒体选择、阿里云 VOD、统一播放控制器和
适合公网媒体的波形/频谱/F0 分析管线；R6/R7 保留为后续路线。

R3h1 已于 2026-08-05 完成并通过浏览器、专项测试、完整 API 测试和生产构建验收；当前立即阶段为
R3h2 媒体来源抽象与阿里云 VOD，尚未进入统一播放器或分析资产实现。

当前阶段：R2 已完成恢复、文件比较、选择性整合和确认范围审核闭环；R3a/R3b 已完成稳定资源分页、
ACL 后填页、目录查询索引、三视图增量消费与虚拟渲染。R3c 已把媒体上传收敛为单一业务命令，建立
签名校验、并发安全容量边界、跨文件系统/数据库补偿和管理员对象孤儿审计。R3d1 已加入轻量
liveness/readiness、低基数 Prometheus 指标和管理员容量/一致性诊断；R3d2a 已建立跨 API 实例持久化的
维护模式与写入静默边界；R3d2b 已完成 PostgreSQL 与对象目录一致备份、manifest/checksum 离线校验、
隔离恢复演练和无浏览器 session 的运维恢复 CLI。R3e1/R3e2 已建立对象存储端口和真实 S3-compatible
适配器，R3f1 已完成通用审计日志浏览、筛选和安全导出，R3f2 已建立标准 Prometheus/Alertmanager 外部
告警基线，R3g1 已完成独立 S3-compatible 命名空间中的 manifest-last 远端一致备份创建与流式校验，
R3g2a 已完成远端包单次流式物化和真实 PostgreSQL/对象目录隔离恢复演练，R3g2b1 已完成 manifest-aware
远端包检查、保留计划、稳定 token 和确认清理；R3g2b2a 已补齐无残留能力验收命令、最小 IAM 模板和
部署检查表。真实生产 MinIO/AWS 的 R3g2b2 等待目标环境；本地开发已完成 R4a operation 幂等接收、
R4b1 浏览器草稿持久化/同 revision 恢复、R4b2 stale 草稿结构化整合、R4c1 自动保存调度/在线退避和
R4c2 保存冲突可视化续接、R4c3 可测试自动保存生命周期协调与异常收口；R4 工程闭环已完成。R5a1 已
建立首批 version 1 时间轴领域命令、严格前后端校验、草稿往返和成熟拖拽提交接入；R5a2a 已完成纯
precondition/inverse/all-or-nothing ProjectData apply；R5a2b 已完成服务端单文件 sequence、权限复核、
opaque 续读游标和有界 operation feed。R5a3a 已把保存声明的 operation 与新 payload revision 在同一事务
绑定，并建立独立 committed feed 与快照 cursor；R5a3b 已完成 clean-only HTTP catch-up、原子领域命令
重放与权威快照降级。R5a4a 已完成逐字/句/动作/自定义块/附属点的稳定内容命令、严格全项目差异门禁、
草稿往返和混合 timing/content 追赶。R5a4b1 已完成自定义块/附属点叶实体创建删除；R5a4b2 已完成逐字/
句/工尺块生命周期、句同步与父块工尺级联原子事务；R5a4b3 已完成工尺符号稳定身份、内部增删改、板眼
复合状态、删除断链和 state/lifecycle 原子事务；R5a4c1 已建立标注文件级短时独占租约、事务内活动文件/
ACL 复核，以及 operation/save/restore 的统一写入门禁；R5a4c2 已把既有自定义轨道元数据、递归分叉树与
块分叉归属接入严格结构命令、编辑器 acquire/renew、受控保存、历史 inverse 和失锁恢复；R5a4c3 已完成
有界结构事务、自定义轨整轨生命周期、内建/自定义父轨的附属点轨生命周期，以及自定义 typeOptions 与块
type 的原子联动；R5a4c4a 已完成既有顶层轨道排序、既有内建轨配置、既有附属点轨配置，以及各自
typeOptions 与逐字唱法/点标签的原子联动；R5a4c4b 已完成内建轨生命周期和批量受控快照边界。R5b1
已完成短时一次性票据、认证 WebSocket 文件会话、权限重验、连接生命周期与 revision 通知；R5b2a
已通过 PostgreSQL LISTEN/NOTIFY 完成跨 API 实例的有界 revision 事件分发、重连和可观测性；R5b2b1
已完成数据库短生命周期 presence、跨实例成员失效通知、同账号多窗口聚合、撤权/断线清理和在线成员 UI，
R5b2b2a 已完成严格协议、双端限流、跨实例瞬时通道、断线/stale 清理和 Timeline 远端播放头预览；
R5b2b2b 已把该通道收敛为播放头、鼠标时间与匿名选区摘要的统一最新快照，并补齐隐私开关、递归轨道
选区汇总和精确时间叠加；R5b3 已按共享领域模型、服务端原子命令提交、客户端确认和并发冲突收敛拆分，
R5b3a1、R5b3a2a/a2b/a2c 与 R5b3a3a/a3b 已完成共享持久类型、完整纯命令 dispatcher、当前格式运行时
ProjectData parser、有序原子命令批次合同和服务端原子数据库提交；R5b3b1 已完成客户端完整命令链审计、
原子批次 planner、严格响应/错误策略、single-flight 重试 runtime 和 document saved baseline 部分确认；
R5b3b2 已完成 App、自动保存、IndexedDB 恢复状态、mutation lease 和冲突状态的真实接线，可重放编辑现已
直接原子提交并逐批确认，旧/不可重放边界才走有界完整快照；R5b3c1 已建立共享本地命令链审计、纯
all-or-nothing 冲突重放判定和真实双账号并发矩阵；R5b3c2 已完成显式 App 冲突决策、二次权威核验、
crash-safe 草稿 checkpoint、基线替换和原 operation 重提接线。后续可靠性修复又把同一安全 rebase 规则接入
在线 409 自动处理：无冲突命令保留原身份并立即重提，同目标冲突仍进入既有人工流程；WebSocket 建连窗口
通过“先订阅、再读权威 head、再发送 ready”消除漏 revision。R5 可部署候选门禁已完成：生产入口采用
fail-closed 环境配置、同源 `/api`、显式首管理员 bootstrap，并提供 systemd、Nginx/TLS、部署 smoke、
迁移、备份恢复、升级回滚和人工验收说明。`pg_trgm` 仍作为数据库级部署能力由运维基线显式预置。

## 1. 产品目标

平台同时服务两类场景：

- 昆曲多模态学术数据库：统一管理媒体、标注文件、研究元数据、分析结果和可追溯历史。
- 课堂标注工具：教师或助教分配资源权限，学生直接打开、复制和编辑获授权的标注文件。

平台采用用户熟悉的文件管理器语义，而不是额外暴露“工作区、Fork、提交版本、发布版本”等
状态机。用户操作的是项目、文件夹、媒体文件和标注文件；管理员管理“资源 × 账号”的权限。

现有时间轴编辑器仍是核心研究工作站。平台化不得破坏本地 JSON、视频重关联、精确时间编辑、
工尺谱、板眼、频谱、递归分叉轨道、撤销重做和导入导出能力。

## 2. 当前架构基线

### 2.1 资源与存储

- `ResourceEntry` 是统一资源树节点，类型为 `folder`、`project`、`annotation_file`、
  `media_file`。
- 项目是特殊容器资源，不是另一套平行导航层级。项目与文件夹复用同一套容器操作、ACL 和资源树
  不变量；当前差异主要是类型、图标/导航语义及可选 `ProjectMetadata`，项目不是独立存储卷。
- `all_projects` 是资源管理器根目录，只列出 `parentId = null` 的顶层项目。嵌套项目只在实际父容器
  下出现；最近、收藏、共享、归档和回收站才是跨目录虚拟视图。
- `AnnotationFile` 保存可变 `payload`、整数 `revision`、媒体资源外键和最近保存信息；关联媒体摘要由
  API 独立返回，受保护 URL 不进入 `ProjectData`。
- 保存必须携带 `baseRevision`；过期写入返回 `409`，不得静默覆盖。
- 覆盖 payload 前创建 `AnnotationRecoverySnapshot`。恢复快照是内部历史，不是普通文件或
  用户发布版本。
- 媒体元数据保存在 PostgreSQL，二进制当前保存在 `data/storage`；统一上传在消费流前检查目录权限，
  经过暂存、单文件上限、真实签名/扩展校验和配额事务后才创建资源。文件读取受 ACL 保护并支持
  HTTP Range。
- 普通媒体复制创建新的媒体资源节点并复用不可变 `FileObject`，不会重复写入大体积二进制。
- 本地项目 JSON 与平台资源模型分层：`ProjectData` 不保存服务器资源 id、ACL 或 revision。

### 2.2 权限

- `ResourcePermission` 保存一个资源对一个账号的直接能力。
- 能力为 `read`、`write`、`create_child`、`copy`、`move`、`delete`、`download`、
  `manage_permissions`。
- 项目/文件夹授权可继承给后代；资源可用 `breakPermissionInheritance` 截断祖先授权。
- 直接授权与继承授权取并集，当前没有显式 deny。
- `super_admin`、`admin`、资源 owner，以及祖先项目/文件夹 owner 拥有完整资源权限；只有 `super_admin`
  可以管理账号。`teacher` 自动取得所有资源的 `read + download`，内容编辑、审核和权限管理仍需显式 ACL。
- API 是安全边界；前端隐藏或禁用控件只改善体验。
- 系统管理员通过独立账号管理界面创建、停用/恢复账号、调整平台角色和重置密码；普通账号可修改自己
  的密码。停用和密码变化会撤销旧会话，账号不做破坏性硬删除。
- 原 `ta` 角色已迁移并合并为 `teacher`。未来 teacher/annotator 附属关系和可调整自动权限需要单独的数据
  模型与审计合同，本轮只保留集中角色策略入口，不提前引入关系表或隐式 ACL。
- 当前 ACL 是资源级权限。旧“轨道/时间范围 grant”不属于现行模型；若未来确有需要，应作为
  标注文件内部的第二层规则单独设计，不能复活已删除的数据模型。

详见 `docs/permissions-model.md`。

### 2.3 前端

- `ResourceExplorer.tsx` 提供三栏资源管理器、搜索、排序、多选、快捷键、右键菜单和 Inspector。
- 资源管理器可在列表、网格和 Finder 分栏中选择两个可读标注文件，通过共享工具栏/右键命令打开
  结构化比较。两侧 payload 按需读取并经唯一项目迁移入口归一化，按项目、句级、逐字、工尺谱、
  板眼、自定义轨道/块和附属点分组展示增删改；比较只读，不创建快照或修改 revision。
- 标注文件 Inspector 已提供默认折叠的恢复历史：列表只读取轻量摘要，选择单条后才读取完整
  payload，并通过正式项目迁移入口生成只读多模态统计；用户可经二次确认把历史内容恢复成新的
  当前 revision，坏历史数据会显示高可见警告而不是被静默阻断。
- 恢复历史可把所选快照与重新按需读取的服务器当前文件送入共享结构化 diff 审阅。快照固定在左、
  当前文件固定在右，只允许按真实时间范围打开当前文件定位；没有交换、快照编辑或选择性整合入口，
  关闭比较后仍回到原快照详情和独立恢复命令。
- column view 已使用路径列模型实现 Finder 式多列导航：列组横向滚动、每列独立纵向滚动，支持
  左右/上下方向键、路径选择、Inspector 跟随，并与列表/网格共用资源项、右键菜单和拖拽入口。
- Inspector 是逐账号直接授权与继承状态的唯一管理入口。
- `PlatformWorkspace.tsx` 负责登录、资源管理器与编辑器会话切换。
- 比较结果可以按所选侧的真实时间范围打开现有单文件编辑器；平台会重新读取最新 payload、revision
  和权限，并通过一次性会话焦点把播放头及时间轴定位到范围开始，不在 Dialog 内复制第二套编辑器。
- 选择性整合以结构化 diff 稳定 key 和明确方向计算 source/target，支持单项与
  领域级多选，自动闭包句级、逐字、工尺谱、板眼、自定义轨道/递归父块和附属打点的强引用，并区分
  用户选择、自动依赖、新增、冲突、目标已相同和结构错误。每项冲突要求显式采用来源或保留目标；
  准备应用时重新读取两侧最新 revision、权限和 payload，并重建语义指纹。目标编辑器只接收运行时
  草稿，用户确认后形成一次可撤销本地提交，不自动保存服务器。
- 标注编辑器通过 `useProjectDocumentState()` 管理历史、dirty 状态、本地 revision、pending
  operations 和同步状态。
- 可重放领域 operation 由原子命令批次在同一事务中推进 `AnnotationFile.payload`、revision、恢复快照、
  committed operation 和审计；只有旧格式、受控批量边界等明确不可重放场景继续使用完整快照保存。

### 2.4 已完成能力

- PostgreSQL 用户、角色、会话与密码哈希。
- 系统管理员账号生命周期、平台角色、停用/恢复、密码重置和所有账号自助改密；敏感操作撤销既有会话并写审计。
- 资源树的创建、读取、重命名、移动、软删除、恢复、收藏和最近打开。
- 单命令媒体上传、真实媒体签名校验、用户/平台容量锁、失败补偿、受保护读取及 MP4 Range seeking。
- 管理员对象存储 dry-run/显式 cleanup API，可识别过期暂存、磁盘孤儿、无引用 FileObject 和缺失
  二进制；缺失二进制只报告，不自动删除数据库元数据。
- 标注 JSON 导入、四类资源统一复制/粘贴、打开编辑和 revision 保存。
- 媒体文件和标注文件已提供统一资源下载命令：媒体使用对象存储流式响应，标注导出当前权威 JSON；入口位于
  资源右键菜单和 Inspector，并由服务端独立校验 `download`。项目/文件夹打包仍保留为后续异步归档能力。
- 标注 JSON 导入时可选择/上传媒体或明确暂不关联；Inspector 可改绑/解绑，数据库外键在媒体删除时自动置空。
  R3h1 已将选择器扩展为资源根/项目/文件夹导航、稳定分页、当前目录搜索和编辑器内入口；JSON 导入、
  Inspector 与编辑器共用同一组件，跨目录媒体仍由服务端复核 ACL。
- 两个普通标注文件的只读结构化比较、左右交换、单侧读取/迁移错误隔离与重复实体 id 警告。
- 普通标注文件的实体选择、依赖闭包、逐项冲突决策、陈旧计划拒绝和目标编辑器单次可撤销整合。
- 恢复快照与当前服务器 revision 的固定方向只读结构化比较、时间概览和当前文件定位。
- 保存前恢复快照与并发冲突检查。
- 快照恢复会先保护当前 payload，再以单调递增 revision 写入历史内容；保护快照、文件更新和审计
  位于同一事务。
- 逐资源 ACL、继承、截断继承和权限矩阵。
- 审计日志、标注 operation log 和后端任务占位接口。
- 本地免登录编辑入口。

### 2.5 当前缺口

- 已有 baseline migration 和首批 API/PostgreSQL 集成测试；后续新 API 仍需持续扩充矩阵。
- `pg` 8 在 Prisma adapter 的并发事务测试中会输出一条 pg 9 前置弃用警告，当前测试结果不受
  影响，升级依赖前需跟踪上游修复。
- 原子批量移动、多选目标选择器及列表/网格/分栏/面包屑拖拽已实现。`all_projects` 只展示顶层
  项目，移动后不会再从根聚合视图穿透显示。
- 原子批量移入回收站已实现。父子混合选择会压缩为逻辑根，整批权限/活动树校验、软删除和审计
  位于同一事务；前端三个视图的工具栏、右键和 Delete/Backspace 共用一个入口。
- Finder 式 column view 已完成逐列 cursor、加载/重试和虚拟渲染；未穷尽的祖先列不会误截断路径。
- 恢复快照已有受控列表、只读预览、安全恢复 mutation，以及对当前服务器 revision 的结构化比较；
  普通标注文件已有结构化 diff、双侧时间概览、按侧打开定位和选择性整合闭环。
- 服务端与三种视图已具备资源分页、名称搜索和虚拟渲染；高级筛选、查询指标和全文索引仍未完成。
- 可写平台文件已有按账号/文件隔离的 IndexedDB 草稿、刷新后同 revision 显式恢复，以及 stale 草稿对
  最新服务器文件的固定方向结构化比较、依赖闭包、逐项冲突决策和编辑器二次确认；已有空闲自动保存、
  保存中继续编辑、在线恢复、有界退避和 409 显式比较续接，生命周期由确定性 runtime 测试覆盖。
- 已有跨实例在线成员 presence、远端播放头/鼠标时间/匿名选区摘要，以及 HTTP 原子领域 operation 提交和
  committed-feed 追赶。WebSocket 仍只发送有损 revision 唤醒：建连时先订阅再权威读取 head，clean 会话据此
  追赶；双账号同 revision 竞争时，无交集命令自动重放并立即重提，同目标修改继续显式冲突审阅。当前仍不是
  OT/CRDT，也不承诺同一实体的无提示即时合并。
- 后端任务仍是占位模型，没有独立 worker、队列和结果资产管理。
- 迁移、本地/S3 对象存储、备份恢复、监控和维护门禁已有工程实现；真实生产 bucket/IAM、TLS、反向代理、
  限流和跨设备演练仍属于部署加固缺口。
- 当前资源树只接纳项目、文件夹、标注文件和媒体文件，尚不是可上传任意研究附件的通用网盘。
- 尚未提供目录/多选资源的流式打包下载，大型导出也没有进度、取消、过期清理和结果资产。
- `MediaFile` 当前强制关联本平台 `FileObject`，尚不能表达阿里云 VOD 等外部媒体。`VideoPlayer` 与 App
  直接依赖 `HTMLVideoElement`，波形还会在浏览器中下载并解码完整视频，频谱和 F0 继续依赖整段 PCM；
  这套管线不适合短时签名、HLS、跨域或长视频，按 R3h2-R3h4 分阶段替换，不能只嵌入第三方播放器脚本。

## 3. 设计原则

1. 资源树、ACL、annotation-file revision 是后续平台能力的唯一基础。
2. 先建立迁移与自动化测试保护线，再扩展资源操作和协作。
3. 文件复制是用户创建独立标注成果的主要方式；恢复快照只负责事故恢复。
4. 不在前端复制鉴权算法，不依赖 UI 状态保证安全。
5. 不把多人协作建立在整份 JSON 互相覆盖上；先明确领域 operation 与幂等性。
6. 不为平台化牺牲本地工具和时间轴精确性。
7. 新抽象必须服务真实边界；不提前引入微服务、CRDT 或复杂 deny ACL。
8. 长期文档描述当前真相，历史实施细节进入 development log。

## 4. 当前执行路线

### R0：资源树架构稳定化与保护线（首轮已完成）

目标：让刚完成的破坏性重构具备可迁移、可回归、可继续扩展的工程基础。

- 重写现行权限、状态和架构文档，移除旧模型误导。
- 建立第一条可提交的 Prisma baseline migration，并验证空数据库可重复部署。
- 建立 API 集成测试基础设施，使用隔离测试数据库，不破坏开发数据。
- 覆盖认证、资源可见性、ACL 继承/截断、资源树操作、annotation save 并发、恢复快照、
  媒体 Range、审计与 operation 输入校验。
- 审计 copy/move/trash/restore/permission/save 的事务边界和并发不变量；只修复测试证明的问题。
- 保持 `npm run build` 与权限核心测试通过。

完成标准：新环境可以只靠 migration 建库；关键 API 有自动化回归；文档与运行时代码一致。

2026-08-01 首轮结果：

- 提交资源树 baseline migration，并在隔离 `api_test` schema 通过 deploy 与 schema drift 检查。
- 抽出可注入的 Fastify app factory，生产启动与测试装配共用路由和错误边界。
- 新增 `test:api`，覆盖认证、资源层级、ACL、移动、复制、并发保存、恢复快照、回收站、媒体
  Range、审计、operation 和 processing job 输入边界。
- 测试驱动修复 Range 416/suffix、过期 operation 409、回收站祖先穿透、同目录命名竞态、恢复
  同名冲突、移动循环竞态和上传失败补偿。
- 后续 API 功能必须沿用该测试框架，不把 R0 当成一次性测试工程。

### R1：资源管理操作闭环

- R1.1 已完成：单资源移动目标选择器、目录浏览、权限预判和明确的冲突提示。
- R1.2 已完成：回收站恢复入口、批量恢复反馈、虚拟视图上下文操作，以及恢复到有效资源树的
  服务端不变量；永久删除继续等待对象生命周期策略。
- R1.3 已完成：项目/文件夹递归复制、媒体逻辑副本与 `FileObject` 复用、子树内标注媒体引用
  重映射、逐根部分成功反馈和可见粘贴入口；每个根保持服务端事务原子性。
- R1.4a 已完成并提交：服务端原子批量移动合同、父子选择逻辑根归一化、多选目标选择器，以及
  单项移动接口复用同一事务核心。
- R1.4b 已完成并提交：列表/网格/面包屑拖拽目标；拖拽使用 Pragmatic DnD，但键盘和对话框移动
  仍是正式入口，API 继续承担权限、循环、回收站和名称冲突的最终校验。
- R1.4 验收修复：`all_projects` 已收敛为只显示顶层项目，避免资源已移动但仍从聚合视图穿透显示；
  集成测试验证数据库父级、根视图和目标目录三者一致。
- R1.5 已完成：新增纯路径列模型与回归测试、异步列数据 hook、真正的多列浏览器，以及跨模式
  当前位置恢复；搜索只过滤最右列，临时读取错误不会误截断路径，移动/删除导致路径失效时会收敛
  到最后一个有效列。列表、网格和分栏共用 `ResourceItem`、Radix 右键菜单和 Pragmatic DnD 注册。
- R1.6 已完成：把移动专用的父子选择压缩抽为 `resourceSelection.ts`，移动与删除共用同一树选择
  语义；批量删除在一个事务中取得资源树锁、复核活动状态与 `delete` 权限、软删除逻辑根并写审计。
  单项接口委托批量核心，工具栏、右键和 Delete/Backspace 共用一次批量请求；失败整批回滚并保留
  前端选择。API 与纯函数测试覆盖坏输入、缺失资源、权限失败、父子折叠、重复提交和审计。
- 回收站永久删除、保留期限和对象清理策略。
- 标签和批量权限操作；批量移动、复制和批量软删除已经各自建立统一语义。
- 所有资源操作补充审计、事务和集成测试。

完成标准：常用文件操作无需输入资源 id，也不依赖临时对话框。

### R2：恢复历史、比较与研究审核

- R2.1 已完成：轻量恢复快照列表、创建者/时间/原因/revision 展示、按需详情和安全只读摘要。
  列表不读取 payload；详情绑定 annotation file 与 snapshot id，并要求有效 `write` 权限。
- R2.2 已完成：恢复 mutation 携带当前 `baseRevision`，先保存当前 payload 为新的 recovery snapshot，
  再把目标历史 payload 写成当前文件的新 revision；文件更新、保护快照和不含 payload 的 audit log
  同事务提交。普通保存同步收敛到同一活动文件写入保护线，并与资源树 move/trash/restore 使用同一
  advisory key 的 shared/exclusive 锁顺序。
- R2.3a 已完成：两个可读标注文件经 `normalizeImportedProjectFile()` 进入纯结构化 diff，按稳定实体 id
  匹配并覆盖句级、逐字、工尺谱、板眼、递归自定义轨道/块和附属点。资源管理器三种视图共用比较
  资格和右键命令；Dialog 提供左右交换、字段/时间范围摘要、单侧错误隔离和重复 id 数据质量警告。
- R2.3b1 已完成：比较 Dialog 使用独立纯时间索引把结构化 diff 映射到共同时间尺度；高 DPI Canvas
  绘制左右差异分布而不为千级片段建立 DOM，支持研究领域与变化类型筛选、点事件、非法/无时间范围
  统计，以及 Canvas 标记与可访问差异按钮的双向定位。筛选不重新读取 payload，交换左右会重建索引
  并清理旧选择；概览不持有第二份 ProjectData，也不修改文件、revision 或恢复历史。
- R2.3b2 已完成：所选结构化差异按左/右真实时间范围生成纯导航焦点；缺失侧、无时间和非法范围不
  伪造定位。比较 Dialog 通过平台唯一文件打开入口重新读取最新 payload、revision 和权限，复用现有
  单文件编辑器并把播放头严格设到该侧开始时间；Timeline 只消费一次初始 focus，后续滚动不被拉回。
  该会话不写入 ProjectData、undo/history、operation log、revision 或恢复快照。
- R2.3c1 已完成：新增纯选择性整合计划核心。左→右/右→左均按真实 source/target 判断；用户选择
  通过稳定 diff key 去重，并自动闭包字符所属句、工尺父文字块、自定义轨道与递归父块、板眼区段与
  关联工尺、附属点定义与自定义父轨。计划按依赖拓扑稳定排序，区分 selected/dependency 以及 add、
  replace-conflict、already-equal；缺失来源、坏引用、非法工尺父轨、循环和 project 领域产生结构化
  issue。该阶段为纯预检，不生成 id、不修改 ProjectData、不触发 history、revision 或 API。
- R2.3c2 已完成：现有比较 Dialog 增加方向、单项/领域级多选和依赖计划预览，完全消费 c1 输出，
  展示用户选择、自动依赖、目标已相同、待决冲突和不可执行原因。导航选择与整合选择独立，筛选和
  折叠不清除选择，方向切换只裁剪新来源侧不可用项；长计划限制首批 DOM。本阶段仍只读，不进入
  编辑器、不保存目标文件。
- R2.3c3 已完成：每个 replace-conflict 必须显式选择保留目标或采用来源。准备应用时重新读取两侧
  最新文件，校验 revision、来源 read、目标 write、重复 id 和计划语义指纹，并通过纯应用器验证
  句级/逐字、工尺、板眼、递归轨道及附属点引用完整性。运行时草稿进入目标单文件编辑器后，最终
  确认只形成一次可撤销 `commitProject()`，不自动保存或创建额外快照；正常保存仍受既有 revision
  与 409 保护。
- R2.4 已完成：恢复详情增加“与当前文件比较”，打开时重新读取当前 annotation file，固定历史在左、
  当前在右，并经唯一项目迁移和 `annotationDiff` 入口进入共享 `AnnotationDiffReview`。普通文件比较
  继续通过组合槽拥有选择性整合，而快照比较没有交换、快照打开或整合入口；只允许打开当前文件并
  定位，关闭后保留原恢复详情和二次确认语义。
- R2.5a 已完成：建立“已确认标注范围”的共享合同和纯领域校验。确认记录绑定 annotation file、被审核
  revision、半开时间范围、明确的研究领域/保存轨道作用域、审核者与审计时间；定义 active/revoked 及
  current/stale 判定。读取沿用资源 `read`，创建/撤销将使用独立 `review` 能力，
  不把普通 `write`、`manage_permissions` 或全局 reviewer 角色直接当作资源审核授权。
- R2.5b 已完成：新增 Prisma `AnnotationConfirmation`、独立 `review` capability、追加式 migration、
  列表/创建/撤销 API 和同事务治理审计。创建在统一资源树/资源行/annotation 行锁序下核对活动文件、
  当前 revision 与真实持久轨道；撤销保留原事实且幂等。普通保存只使旧确认变为 stale，复制不携带
  确认，回收站文件不能治理；确认不会覆盖 payload、revision、恢复快照或 annotation operation。
- R2.5c 已完成：平台编辑器右侧增加独立确认面板，使用当前循环范围创建 all/domain/真实持久轨道
  作用域的确认，浏览 current/stale/revoked 历史并经二次确认撤销；保存后刷新服务器事实。时间轴在
  loop 与 top deck 之间增加精确、只读、可隐藏的重叠分层确认栏，点击按原始时间 seek/focus，不参与
  吸附或编辑。dirty、列表加载、缺少 `review`、无范围及 revision 不一致均阻断创建；本地模式不加载
  或展示治理 UI，服务端仍是权限与状态真相。

完成标准：误操作可恢复，研究者能比较和选择性整合不同文件。

### R3：规模、可靠性与运维基础

- R3a 已完成：资源查询使用版本化、查询绑定的 opaque cursor；数据库按业务字段和同方向 id 形成稳定
  总序，以 50-200 条有限批次扫描候选，并以有界并发复核已删除祖先和有效 ACL，直到填满可见页或
  候选耗尽。坏/跨查询/失效 cursor 明确返回 400；`all_projects`、普通目录与聚合视图语义保持。主
  list/grid 支持保留已加载资源的“加载更多”，搜索/路径/排序切换立即淘汰旧响应。新增目录名称、
  更新时间和最近打开 B-tree 索引；名称 contains 的 trigram 索引因数据库级扩展所有权边界延后。
- R3b 已完成：Finder 每列独立持有 cursor/loading/error，未穷尽列不触发路径误截断；list/grid/column
  使用 MIT 的 `@tanstack/react-virtual` 只挂载可视区与 overscan，继续复用一套 ResourceItem、Radix 菜单
  和 Pragmatic DnD。移动目标选择器可有限跨过纯文件页面并继续增量加载，不读取目录全集。浏览器以
  1000 个临时项目验证 list/grid/column 分别只挂载约 31/36/35 个资源节点，临时数据已清理。
- R3c 已完成：浏览器与 API 删除“裸 FileObject 上传后再导入”的两段路径，统一
  `POST /media-files/upload`；服务端使用 MIT `file-type` 检测真实媒体签名，以暂存对象和原子 rename
  发布二进制，在固定平台/用户 advisory lock 下按唯一 FileObject 计算配额，并在一个事务中创建文件、
  媒体资源和审计。失败按阶段补偿；管理员可审计和显式清理超过宽限期的确定孤儿，缺失二进制只诊断。
- R3d1 已完成：健康检查拆分 dependency-free liveness 与数据库/对象目录 readiness；每个 API 实例使用
  独立 `prom-client` Registry 记录规范化 HTTP、媒体上传和对象清理指标，`/metrics` 默认关闭并由独立
  运维 token 保护。管理员诊断 Dialog 展示容量、资源/任务、对象一致性、服务告警和安全运维摘要，
  且保留显式确认的合格孤儿清理入口。
- R3d2a 已完成：新增持久化 `PlatformRuntimeState` 和跨实例 PostgreSQL shared/exclusive advisory gate。
  所有 HTTP mutation 持有共享许可直到响应完成；管理员以独占锁等待在途写入排空后进入维护，维护中
  GET/HEAD 继续可读而 mutation 返回 503。锁连接使用独立连接池避免与 Prisma 业务查询自锁；请求中断
  也会幂等释放。标注文件 GET 的“最近打开”副作用已拆为独立 POST，因此只读边界是真实的。管理员
  诊断面板提供受控原因输入、风险说明和恢复入口；状态和审计跨 API 重启持久化。
- R3d2b 已完成：新增版本化 `manifest.json + database.dump + objects/` 全量备份包；备份在持久维护静默
  窗口内执行 PostgreSQL 16 custom dump 与对象流式复制，为 dump 和每个对象记录 SHA-256/size，并在
  staging 离线校验、fsync 后原子发布。CLI 可独立查询/切换维护、创建/验证备份和向不同名称的空数据库
  与隔离对象目录真实恢复；恢复报告复核 migration、运行状态、数据库摘要和对象内容。恢复库保留
  maintenance=true，源已有 missing/orphan 只作为 warning 诚实保留。当前实现仍是本地对象存储全量包，
  不包含 S3/MinIO、增量、加密或定时调度。
- R3e1 已完成：新增稳定 `ObjectStorage` 端口、本地适配器和唯一环境工厂；API 装配、上传、下载 Range、
  readiness、对象生命周期、系统诊断及备份编排只依赖端口或最小能力切片。未知后端配置在启动阶段
  fail closed；本地一致备份通过判别能力显式取得受控根目录，远端描述不能伪造路径。恢复对象校验改为
  对对象流计算摘要。该阶段只建立端口，后续 R3e2/R3g1 已分别补上真实 S3 适配器与远端备份创建/校验。
- R3e2 已完成：使用官方 AWS SDK v3 实现 S3-compatible 适配器，统一异步对象流合同；支持流式限额/
  SHA-256/header、multipart staged 上传、按对象大小选择单次或 multipart copy 发布、Range、Head、分页 List、Delete、bucket
  readiness、prefix 隔离和严格环境配置。协议测试以 Apache-2.0 SeaweedFS 4.40 真实 HTTP 服务验证完整
  生命周期；未把有高危旧依赖的 s3rver 留入仓库。R3g1 后已具备远端备份创建/校验，生产 MinIO/AWS
  bucket smoke 和 IAM 默认凭据链仍待部署阶段完成；R3g2a 已补齐 S3-compatible 远端隔离恢复演练。
- 服务端分页、排序和基础名称搜索已完成；标签、负责人、媒体类型和时间范围等高级过滤留待独立切片。
- 标签、负责人、媒体类型、更新时间等索引。
- `FileObject.size` 与 `MediaFile.size` 已由 `Int` 迁移为 `BigInt`，单文件不再受 Int4 的 2 GiB 上限约束；
  线格式仍为 JSON number，BigInt↔number 转换集中在应用 mapper 边界。单文件上限现由
  `XIQU_MAX_UPLOAD_BYTES` 与用户/平台配额共同约束。S3 发布已补齐超过 5 GB 的有限并发 multipart copy；
  浏览器直传、断点续传和可恢复上传会话仍待独立切片。
- R3f2 已完成：`/metrics` 在鉴权后按请求采集数据库/对象存储可用性、平台逻辑容量与固定后台任务状态，
  重叠 scrape 复用 in-flight，超时/异常以 collection-success Gauge 表达且不伪造零值。仓库提供可解析
  测试的 Prometheus scrape/rule 和 Alertmanager 分组/抑制/webhook 示例，覆盖 API、依赖、错误率、延迟、
  容量、任务和上传补偿失败；真实 secret 与 receiver 仍由部署私有配置管理。
- R3f1 已完成：全局管理员可在独立窗口按 action、操作者、目标账号、资源和带时区时间范围查询审计；
  资源级管理者只能查询具有 `manage_permissions` 的指定资源。查询使用绑定筛选指纹的稳定 keyset
  cursor，关联账号/资源批量补齐且删除后仍有回退摘要。服务端按同一筛选条件分批读取并导出公式安全
  CSV，单次上限 10,000 条，前端不会把已加载页面伪装成完整导出。
- R3g1 已完成：新增独立 `XIQU_BACKUP_S3_*` 目标和非空 prefix，拒绝与线上对象命名空间相同或互相包含；
  维护静默窗口内把 PostgreSQL custom dump 与源对象逐项流式 staged/promote，最后发布 `manifest.json`
  作为唯一完成标志。失败按逆序清理 final/staged，远端 verifier 以明确 backup id 流式复算 size/SHA-256
  并拒绝缺失、额外或篡改对象。本地备份/恢复合同未被削弱，真实 SeaweedFS 协议及隔离 source CLI
  create/verify smoke 已通过。
- R3g2a 已完成：远端 verifier 与恢复器共享 manifest/key/精确对象集合索引；materializer 对 manifest、
  dump 和每个对象各打开一次远端流，在唯一临时目录落盘并同步复算 size/SHA-256，完整后再由本地
  verifier 二次复核。远端恢复编排复用唯一 `restoreDrillService`，成功/失败/中止均清理临时包；真实
  SeaweedFS + PostgreSQL 16 隔离恢复验证 migration、maintenance、数据库摘要和对象内容全部通过。
- R3g2b1 已完成：独立备份命名空间一次 list 后按严格 production id 分组；无 manifest 包按最新对象时间
  享有宽限，结构完整包按 manifest 时间、保留天数和至少最新 N 个生成计划。计划 token 绑定全部对象
  事实与策略，确认清理前重新扫描；完整包 manifest-first，坏 manifest/不一致/未知对象只报告。真实
  SeaweedFS CLI inspect -> token -> cleanup -> verify smoke 已通过。
- R3g2b2a 已完成：新增不连接数据库、只访问独立备份 prefix 的无残留能力检查，真实覆盖 readiness、
  staged upload、HEAD/LIST、server-side copy、完整/Range GET 和 DELETE；失败出口聚合补偿错误。仓库同时
  提供由当前 SDK 调用推导的 bucket/prefix 最小 IAM 模板，以及 TLS、网络、凭据和生产验收检查表。
  SeaweedFS 服务测试与真实 CLI smoke 均证明运行前后 prefix 对象集合一致，但不冒充生产验收。
- 对象存储端口、本地/S3-compatible 适配器、本地/远端隔离恢复与远端保留清理已完成；下一步为 R3g2b2
  在真实生产 MinIO/AWS bucket 执行能力检查、真实备份/校验/隔离恢复、生命周期 dry-run/清理，并归档
  脱敏报告；同时人工核对 TLS/网络/最小 IAM 和凭据轮换。默认凭据链仍未启用，工作负载身份需独立评审。

完成标准：大量资源下仍可用，故障可定位，数据库和对象可恢复。

#### R3h：外部媒体、阿里云 VOD 与分析资产

R3h 位于现有资源/ACL/对象存储基础与 R6 通用后台任务之间。它不改变 `ProjectData` 的本地交换职责：
平台媒体来源、VOD 身份、短时播放凭据、分析任务和派生资产都属于平台资源层，不得写入标注 JSON、
浏览器草稿、operation、审计详情或协作消息。

三条用户工作流必须长期并存：本地计算机媒体继续服务免登录编辑、本地项目和手动重关联；上传到平台的
服务器媒体继续使用 `FileObject`、ACL、Range 和对象存储；阿里云 VOD 作为不上传本平台二进制的第三种
平台媒体来源新增。统一播放/分析接口只收敛运行时能力，不得删除或伪装任一来源的存储和权限语义。

- **R3h1：服务器媒体选择闭环（已完成）。** 把原“同目录前 200 项”选择器改为可浏览资源根、项目和文件夹的
  分页媒体选择器，复用稳定 cursor、路径模型、权限 DTO、Radix Dialog 和现有资源列表 API；支持面包屑、
  上级/进入目录、当前目录搜索、加载更多、已有媒体选择、上传新媒体和明确解绑。JSON 导入、Inspector
  与平台编辑器共用同一组件和同一绑定 mutation。编辑器改绑前必须处理 dirty/保存中的会话，成功后权威
  重读标注文件并刷新运行时媒体，不能污染 undo/history 或把媒体 URL 写回 `ProjectData`。只读用户能看到
  当前关联状态和无权修改原因，API 继续独立复核标注 `write` 与媒体 `read + download`。
- **R3h2：媒体来源抽象与阿里云 VOD。** 在 `media_file` 资源下建立严格判别的 uploaded/aliyun_vod 来源，
  迁移既有媒体为 uploaded；VOD 只持久化 `vid`、region 和可公开元数据。AccessKey、Secret、playauth、
  临时播放地址和供应商响应不得落库或进入客户端长期状态。服务端使用经许可证/维护性评估的阿里云官方
  SDK 验证视频并签发短时播放会话，资源 ACL、复制、移动、下载语义、审计和失效诊断按来源明确处理。
  用户提供的 `00cf8df6907871f1b31f5017e1f80102` 仅作显式配置的人工验收样例，不将空 playauth 当作认证。
- **R3h3：统一播放控制器。** 将 App 对 `HTMLVideoElement` 的直接属性和事件访问收敛为稳定控制接口，
  原生上传媒体与 Aliplayer/VOD 各自实现适配器。两种来源必须保持相同的 currentTime/duration/play/pause/
  seek/playbackRate/ended 语义，并回归时间轴点击、拖拽边界预览、循环播放、P/Tab 范围播放、快捷键、
  分离预览窗口和媒体会话切换。第三方 SDK 采用受控加载、销毁和错误边界，不向全局散落脚本状态。
- **R3h4：波形、频谱和 F0 分析资产。** 把“浏览器 fetch 完整视频 -> 全量 AudioContext 解码 -> 整段 PCM
  常驻内存”降为本地/小文件回退。平台媒体通过可追溯分析任务生成版本化 manifest、多分辨率波形峰值、
  按时间/预设分块的频谱数据和 voiced-only F0；输入绑定媒体资源 id、来源 checksum/VOD 版本、算法参数和
  代码版本，输出进入受 ACL 保护的派生资产。前端按可视时间窗和缩放级别加载、取消和缓存，缺失/处理中/
  失败状态明确展示，播放不因分析不可用而阻断。任务执行可复用 R6 worker/queue 边界，但不得在 API 请求或
  主线程中同步处理整段长视频。

阶段纪律：R3h1-R3h4 每项独立审查、测试、文档化并提交后才进入下一项。若成熟依赖能减少自研协议、
提升播放器或数据加载稳定性并与现有风格兼容，应优先评估使用；选择理由、许可证、替代范围和验证结果写入
Development Log。任何阶段不得为追求“能播放”而牺牲时间轴的精确时间语义。

完成标准：用户可从任意有权目录关联服务器媒体；阿里云 VOD 不上传本平台对象也能安全播放；上传媒体与
VOD 共用精确媒体时钟；长视频波形、频谱和 F0 不再依赖浏览器完整下载与全量 PCM 常驻内存。

#### R3 后续扩展：科研资产中心与批量导出（暂不纳入当前开发轮次）

这一扩展的目标是让平台在保持昆曲标注语义的同时，承担有限的科研网盘能力；它不是把平台
改造成无边界的个人云盘。实施前必须先完成 R1 的资源操作闭环和 R3 的基础容量治理。

- 增加通用二进制资源类型，支持图片、PDF、Office 文档、压缩包和其他研究附件；目录、所有权、
  ACL、回收站和审计仍统一使用 `ResourceEntry`，不得建立第二套文件树。
- 把二进制对象的通用关系与媒体专属元数据分开：`FileObject` 继续只表示对象存储实体，媒体时长、
  编解码等信息作为媒体扩展，不让普通附件伪装成媒体。
- 文件大小字段升级为可安全容纳大视频的 `BigInt`，并同步处理 shared DTO、JSON 序列化、排序和
  前端格式化；迁移前必须评估已有数据与 API 兼容边界。
- 提供带正确 `Content-Disposition`、MIME、长度和权限校验的普通文件下载；媒体 Range 读取继续
  保持，不以一次性读入内存的方式下载大文件。
- 增加多选资源/目录的递归打包导出。小型导出采用流式 ZIP，逐项检查 `read` 与 `download`，并
  在压缩包中恢复用户可见目录结构；标注 payload 在导出时序列化为 JSON，媒体从对象存储流式读取。
- 打包中生成 `manifest.json`，至少记录资源 id、相对路径、类型、checksum、标注 revision、创建者、
  修改时间和媒体关联，保证科研数据离线后仍可追溯。
- 大型打包接入后台任务：提供排队、进度、取消、重试、失败诊断、临时结果下载和到期自动清理，
  不用长时间 HTTP 请求承担全部工作。
- 增加分片/断点续传、文件类型与大小校验、用户/项目配额、checksum 去重策略、恶意文件检查、
  孤儿对象回收、对象生命周期、备份与恢复演练。
- 保持本地对象存储与 S3/MinIO 实现共享同一接口；业务 service 不直接拼接本地磁盘路径。
- 批量下载、导出任务与临时结果都必须写审计记录；任何子项无权限时采用明确的全量失败或跳过
  清单策略，不得静默泄露或遗漏文件。

完成标准：常见科研附件可与标注和媒体共用资源树及 ACL；大型项目可以安全、可追溯、低内存地
打包导出；本地磁盘与对象存储后端可替换而不改变上层资源语义。

### R4：自动保存、离线队列与恢复同步

- R4a 已完成：把本地 operation id 提升为服务端一等幂等键，建立请求指纹、数据库唯一约束、并发
  单行接收和 revision 推进后的安全重放；这是持久离线队列与自动保存的前置，不会直接应用 operation
  payload 或替代完整 revision save。
- R4b1 已完成：operation 改为紧凑摘要，完整项目只在每个账号/标注文件的一份 versioned IndexedDB
  envelope 中保存；草稿不含访问 token、Blob、undo/redo 或每操作项目快照。刷新或返回资源管理器后，
  平台先读取服务器最新 revision，再允许同 revision 草稿显式恢复；stale/read-only 草稿只能导出或
  丢弃，损坏草稿必须经确认清除。成功保存回到 clean 后删除草稿。
- R4b2 已完成：stale 草稿固定以“本地草稿在左、服务器当前文件在右”复用结构化 diff/merge；选择、
  强依赖闭包和逐项冲突决定完成后，会同时重读 IndexedDB 与服务器并核对 identity、revision、权限和
  plan fingerprint。成功只建立运行时整合草稿，编辑器二次确认后形成一次可撤销 dirty commit，不会
  直接保存或覆盖远端；待确认期间暂停草稿 put/delete，退出仍保留旧 stale envelope。
- R4c1 已完成：可写平台文件在 3 秒空闲窗口后调用唯一保存事务；保存中继续编辑只确认固定快照，后续
  dirty 再次排队。离线不发请求，online 恢复后重新同步，网络/408/429/5xx 使用 2 秒至 60 秒确定性
  指数退避；409 与确定 4xx 停止自动重试。pending merge 暂停调度，手动保存与自动保存共用结构化
  outcome 和同一 operation/payload/revision 边界。beforeunload 不伪造无法等待的异步保存，仍由
  IndexedDB 草稿兜底。
- R4c2 已完成：409 conflict 在编辑器显示显式处理栏；用户点击后，草稿 persistence 沿同一串行队列
  flush 当前 recovery state，Workspace 再重读服务器文件、权限与草稿。两侧成功后才离开 dirty 编辑器，
  并按 revision-conflict/read-only/recoverable 进入 R4b2 既有流程；整合确认后由 R4c1 从最新 revision
  继续保存。失败留在编辑器，不清 dirty、不静默覆盖。
- 自动保存产生的 `409` 必须保持进入显式比较和用户决策，禁止未来改成自动覆盖远端；R4b2 提供可复用
  的 stale 草稿实体比较与整合基础，R4c2 负责从保存冲突稳定进入该边界。
- R4c3 已完成：timer、single-flight、保存中继续编辑、在线恢复、退避、阻断和卸载收口到可注入时钟的
  `PlatformAutoSaveRuntime`；React hook 只负责 facts 接线，并兼容 Strict Effects 重建。同步 throw、异步
  reject 等合同外错误会释放锁、阻断后台重试并保留 dirty；确定性测试覆盖全部生命周期分支。
- 快照保存和 operation 日志的确认边界保持一致。

完成标准：工程实现与自动化回归已达到“断网和刷新不静默丢失编辑，恢复在线后可安全继续同步”；真实
生产浏览器、跨设备和弱网场景仍列为部署验收门禁，不以单元测试冒充生产验收。

### R5：实时多人协作

- R5a1 已完成：新增 `timeline.items.timing.update` version 1 envelope，覆盖句、逐字、动作、自定义块、
  附属打点、工尺块和板眼点的 before/after；逐字/句/自定义文字块的派生句界与工尺时间同命令记录。
  shared parser 严格限制版本、字段、实体、id、时间、重复项和 500 项上限；草稿恢复、平台请求和 API
  复用同一合同。纯时间拖拽/缩放从真实 transient base 与最终项目提取命令，合同外变更和不可表达旧 id
  安全回退 `project.commit`。该阶段的旧 operation 接口只验证和记录命令、不直接 apply payload；R5b3a3b
  已另建原子 command-batch 入口，编辑器将在 R5b3b 迁移。WebSocket 仍只通知 revision 推进。
- R5a2a 已完成：shared 提供半毫秒容差的全量 before 前置检查、可解释 target_missing/before_mismatch
  和确定 inverse；Web 唯一 ProjectData adapter 覆盖七类实体，先检查全部目标再不可变写入，板眼同步
  manualOffset/confidence，错误 track/缺失/冲突均不产生部分项目。命令已显式包含的句界/工尺派生时间
  不会被 apply 再次同步。该 adapter 还未接服务器或替换本地 undo。
- R5a2b 已完成：`AnnotationFile` 维护单文件序号计数器，operation 在文件排他锁内幂等复查、revision
  复核并连续分配 sequence；历史行按 `(createdAt, id)` 确定回填。HTTP feed 使用绑定文件和版本的 opaque
  cursor、100/200 默认与上限、升序有界读取，并在每次读取时重新检查 read capability。可解析领域命令
  标为 `domain_command`，legacy 摘要标为 `requires_snapshot`。该 cursor 只表示客户端已观察到哪里，
  sequence 只表示日志接收顺序；二者都不证明对应完整 payload 已保存。
- R5a3a 已完成：operation 的 nullable `committedRevision/committedAt` 只在完整 payload 保存事务中绑定；
  保存请求显式声明当前账号本次快照覆盖的 client operation ids，缺失、跨账号、异 base 或已提交项使
  payload/revision/operation 整体回滚。历史日志保持未提交，不猜测回填。独立 committed feed 按
  `(committedRevision, acceptanceSequence)` 升序续读，跳过未提交空洞；AnnotationFile 返回对应当前
  payload revision 的 opaque snapshot cursor。未被一次保存声明的旧-base operation 永久保持 accepted，
  不能被后续 revision 自动认领。
- R5a3b 已完成：可停止、可换文件、single-flight 的 HTTP catch-up coordinator 从 snapshot cursor 有界读取
  committed pages。完整连续的已知领域命令只在局部项目全部通过前置条件后一次替换 clean 基线；legacy、
  revision gap、分页预算、坏页和前置失败统一重取权威快照。dirty/pending/transient/行内编辑/保存/冲突/
  待确认整合均暂停，文件切换和 dispose 的迟到响应失效；远端替换不写 undo、operation 或 dirty。
- R5a4a 已完成：新增 `annotation.items.content.update`，覆盖 sentence.text、character.char、action.label、
  custom-block.text/type 与 attached-point.label。shared 严格约束字段/实体/track scope、字符串长度、重复、
  no-op 与 action/type；ProjectData builder 以同一纯写入器重建完整 next，发现任何时间、结构或其他合同外
  变化即回退 snapshot。五类 apply/inverse 全量前置检查、IndexedDB 草稿、API replayability 和 clean HTTP
  catch-up 已共用通用命令分派，混合 timing/content revision 链保持原子。
- R5a4b 按依赖闭包分阶段推进，不能用一个宽松 CRUD 命令覆盖所有实体：
  - R5a4b1 已完成：当前格式真实使用的自定义块与附属点叶实体创建/删除，严格保存父作用域、完整快照、集合
    位置、inverse 和 all-or-nothing 前置条件；有关联工尺的自定义块先回退快照；混合
    timing/content/lifecycle 链可 clean catch-up。旧 `actionAnnotations` 只保留导入兼容，不再扩展命令。
  - R5a4b2 已完成：lifecycle 扩展 sentence、character 与完整 Gongche block/symbol 快照；新增禁止递归的
    `annotation.transaction.apply`，逆序 inverse、局部顺序 apply 与完整 next 门禁把句文本/边界同步、最后
    一个字删除句、逐字/自定义父块工尺级联封装为一个 operation/revision。草稿、API 与 clean catch-up 已
    复用通用 parser/dispatcher；这里描述的是编辑器仍在使用的旧 operation + 完整保存兼容路径，原子批次
    服务端入口已在 R5b3a3b 落地。
  - R5a4b3 已完成：新增严格 `annotation.items.state.update`，复用完整快照覆盖 Gongche symbol、Banyan mark/
    section；lifecycle 同步扩展三类实体。工尺快速编辑按索引保留稳定 symbol id；删除 symbol/block 时保留
    板眼研究记录、清除失效链接并标记 orphaned，再由 state → lifecycle transaction 原子提交。所有 after
    均通过统一板眼/工尺引用门禁，草稿、API 与 clean catch-up 已可验证和重放 state。
- R5a4c1 已完成：新增 PostgreSQL `AnnotationMutationLease`，按文件唯一绑定 holder、purpose、base revision、
  60 秒 TTL 和 5 分钟最长生命周期；明文 token 只返回客户端。统一写锁 helper 让 operation、save、restore
  和租约 mutation 共享资源树锁、活动祖先检查、事务内 ACL 与文件行锁；有效租约存在时所有内容写入必须
  带匹配 token，成功 revision 写入原子释放。API/client 和审计已接入。
- R5a4c2 已完成：新增顶层 `annotation.track.structure.update`，以完整 before/after 结构快照覆盖既有自定义
  轨道元数据、递归 lane 树和全部块分叉归属；shared parser 限制身份、父子引用、循环、稳定排序、预算和
  no-op，ProjectData adapter 以完整 next 门禁证明无合同外变化。平台 UI 在本地 mutation 前取得租约，定时
  续期，operation/save 只在请求顶层携带 token；成功保存清本地凭据，失锁后的 pending 结构命令会在保存前
  重新取锁。结构 history 保存 envelope，undo/redo 分别提交 inverse/正向命令并复用同一租约。无租约结构
  operation 即使数据库不存在活动租约也会 409，普通命令保持旧行为。
- R5a4c3 已完成：新增服务端可见且必须持租约的有界结构事务，组合整条自定义轨道生命周期、附属点轨
  生命周期、既有轨道结构更新及必要的内容/工尺/板眼子命令；迁移整条自定义轨道创建/删除、附属点轨
  创建/删除和会同步修改块类型的自定义 typeOptions 重命名/删除。结构事务必须有至少一个结构子命令，
  禁止递归、禁止藏入普通 annotation transaction，并保持 500 实体总预算和完整 ProjectData 反证门禁。
  自定义轨生命周期快照保存拥有块、附属点轨/点和两个集合的精确位置；apply 额外验证轨道、排序、块、
  点轨和点的稳定 id 唯一性。整轨删除按板眼断链、工尺删除、父轨删除的依赖顺序原子执行，inverse 可精确
  恢复。shared 租约判别、API、草稿、历史和 clean catch-up 已识别同一顶层结构事务。
- R5a4c4 已按风险与依赖闭包拆分，不能用一个宽松“轨道更新”快照同时覆盖稳定配置和大规模生命周期：
  - R5a4c4a 已完成：新增轨道顺序、既有内建轨配置、既有附属点轨配置三类有界结构叶命令；内建
    typeOptions 重命名/删除必须与受影响逐字 `singingStyle` 原子联动，附属点轨 typeOptions 重命名/删除
    必须与受影响 point label 原子联动。轨道头移动/拖拽、Inspector 配置以及右键快速新建类型均复用结构
    事务、完整 next 反证和 mutation lease；直接逐字唱法修改也已进入稳定 content command。
  - R5a4c4b 已完成：内建轨创建/删除使用严格生命周期 leaf，并把逐字、工尺与板眼断链按依赖顺序组合；
    超出有界预算时改走受控权威快照，不伪装成可重放事务。导入 SRT/项目、整合导入、句字修复、工尺批量
    导入和超预算生成使用显式 `bulk_import`/`bulk_repair` 租约保护的 `annotation.project.snapshot.boundary`；
    operation 只保存严格小型意图，不保存完整 ProjectData。该边界可进入草稿、历史和 API 日志，但明确不可
    由 committed feed 重放，clean catch-up 必须读取权威 snapshot。平台覆盖导入在真实服务器保存前保持 dirty。
- R5b 按“先会话、再通知、后 presence/协作写入”分阶段推进，不能让 WebSocket 成为绕过现有 HTTP 权限、
  revision、operation 幂等或 mutation lease 的第二条写路径：
  - R5b1 已完成：PostgreSQL 保存 30 秒一次性票据摘要，明文票据通过 WebSocket 子协议头发送，upgrade URL
    不携带票据或平台 access token；文件会话
    严格校验协议、活动资源、账号、当前角色与 ACL，并通过心跳和每次发送前复核响应停用、撤权或移入回收站。
    服务端只发布 `session.ready` 与单调 `annotation.revision.advanced`，客户端仅用它唤醒已有 clean-only HTTP
    committed feed/snapshot 追赶。文件切换、离线、超时、退避重连、Strict Effects 清理和紧凑连接状态 UI 已有
    确定性测试；进程内 hub 只负责本实例 WebSocket fan-out，不再承担跨实例传输。
  - R5b2a 已完成：新增严格有界的 revision 事件 envelope 和可替换 event-bus 边界；生产组合使用 schema
    隔离的 PostgreSQL LISTEN/NOTIFY、独立小型连接池和独立 listener。保存/恢复事务提交后先通知本实例，再
    异步发布跨实例事件；同文件待发布事件按最高 revision 合并，队列有上限和明确丢弃指标。listener 初次连接
    失败会阻止启动，运行时断线使用有界退避重连；hub 对自回环、重复与乱序 revision 做单调去重。专项测试及
    两个真实 Fastify 实例的 PostgreSQL 集成测试覆盖跨实例保存与恢复通知。NOTIFY 仍是可丢失提示，不是持久
    队列；周期 HTTP committed-feed/snapshot catch-up 始终是权威恢复路径。
  - R5b2b 按可独立验证的状态层拆分，不能在在线身份、TTL 和撤权清理尚未稳定时直接广播高频鼠标事件：
    - R5b2b1 已完成：使用 PostgreSQL 短生命周期 session 保存跨实例可恢复的在线成员事实，LISTEN/NOTIFY
      只广播文件级 presence invalidation，接收实例重新读取数据库权威成员快照；已建立 join/renew/leave/
      expire、同账号多 tab 聚合、200 账号/1000 session 有界容量、在线成员视图、断线清空、撤权清理和
      低基数指标。Presence 不写入 ProjectData、恢复快照、operation log 或治理审计，异常退出由 60 秒 TTL
      和周期失效重读兜底。
    - R5b2b2a 已完成：在稳定 presence session 上建立严格有界的播放头协议、浏览器 8 Hz 节流/2 秒保活、
      服务端 token bucket 限流、独立 schema-isolated transient PostgreSQL event bus、慢消费者丢帧、断线
      clear、6 秒 stale 回收、同账号多窗口最近活动聚合和 Timeline 只读叠加层。播放头严格复用 Timeline
      时间坐标，不参与吸附或编辑；该状态不写 ProjectData、revision、快照、operation 或审计历史。
    - R5b2b2b 已完成：把播放头、鼠标时间和选区摘要合并为一个严格、完整的最新 activity 快照，共用
      8 Hz trailing 调度、2 秒保活、服务端 token bucket、跨实例 transient bus、连接 sequence、clear 和
      6 秒 stale 回收。选区只发送起止时间、项目数、可视轨道数和固定研究域类别，不发送实体 id、正文、
      轨道名或分叉名；递归分叉选择按真实可视 lane 计数。普通/独立 Timeline 共用精确时间坐标叠加，最多
      显示 32 个远端账号和前 12 个选区 band；用户可独立关闭远端提示或停止共享自己的鼠标与选区，播放头
      仍保持协作预览。换文件会清空完整瞬时活动，避免把上一文件状态带入新会话。
  - R5b3 按“共享纯模型 -> 服务端权威 apply -> 客户端确认 -> 并发冲突”拆分。现有 operation POST 只在当前
    revision 上验收并排序，完整 payload 保存时才与新 revision 原子绑定；accepted operation 不是已提交内容，
    不得直接通过 WebSocket 广播并让远端应用：
    - R5b3a1 已完成：把持久化 `ProjectData` 及嵌套实体类型迁入 `packages/document-model`，Web 只保留
      运行时选择、波形/频谱和派生视图类型；通过兼容 re-export 保持现有导入稳定，不改变 JSON 文件格式、
      migration、命令 envelope 或编辑行为。十个现有 apply 入口已直接依赖共享类型，且专项领域测试、
      operation catch-up、API 119 项和完整构建通过。该边界使 API 后续可以类型安全地调用同一套纯 apply engine。
    - R5b3a2 按依赖闭包迁移当前位于 `src/utils` 的纯命令 resolver、precondition adapter、immutable writer
      和 dispatcher。Web catch-up 与 API 最终共用唯一 apply 实现；每个子阶段都删除原实现，只保留窄兼容出口：
      - R5b3a2a 已完成：迁移 `projectValueEquality`、timing、content、Gongche/Banyan 复合快照、引用完整性
        和 state 的纯 builder/resolver/writer/apply。Web 旧路径只保留窄 re-export；54 项领域/组合/catch-up、
        API 119 项和完整构建通过，源码扫描确认每个函数体只有共享包一份。
      - R5b3a2b 已完成：迁移 lifecycle、annotation transaction 及其依赖闭包；Web 旧路径只保留窄出口，
        54 项生命周期/事务/结构组合/catch-up、API 119 项和完整构建继续证明集合位置、父子引用、工尺/板眼
        断链和 all-or-nothing 事务语义。
      - R5b3a2c 已完成：迁移自定义轨结构、轨道 lifecycle/configuration、结构事务和通用命令 dispatcher；
        Web 旧路径只保留窄出口，49 项结构/组合/catch-up、API 119 项和完整构建通过。API 现可从
        document-model 一个公开入口调用完整纯 apply engine，但尚未接入数据库写事务。
    - R5b3a3 按运行时文档边界与数据库事务分两轮推进。现有数据库 `AnnotationFile.payload` 是 unknown JSON，
      不能因为 TypeScript 已共享 `ProjectData` 就在 API 中直接断言后调用 apply；一次本地保存也可能包含同一
      base revision 上有顺序依赖的多条命令，服务端必须把整条命令链作为一个 revision 原子提交：
      - R5b3a3a 已完成：在 `packages/document-model` 建立当前格式 `ProjectData` 的严格运行时 parser，拒绝
        缺字段、非法 union、非有限时间和畸形递归分叉；同时在 shared 定义有序命令批次 request/response、
        数量与唯一 client id 合同。parser 只验证当前持久格式，不复制 Web 的旧 JSON migration，也不静默
        补字段或删除未知数据。Zod 通过独立 package subpath 暴露，未进入 Web 根 bundle；新旧 operation、
        IndexedDB 草稿和未来原子入口共用同一个 client id validator。
      - R5b3a3b 已完成：新增 `POST /api/annotation-files/:resourceId/command-batches` 和独立原子提交服务。
        同一数据库事务内完成活动文件锁、事务内 ACL、租约用途/base revision、当前 payload 严格解析、按请求
        顺序 apply、旧 payload 恢复快照、单 revision、按序 committed operation、资源时间、审计和结构租约
        释放，提交后才发布 revision/cursor。完全相同批次可返回原确认；子集、乱序、部分已存在、不同指纹、
        畸形 payload、前置失败和并发旧 revision 均 fail closed，不留下 accepted 行或中间 ProjectData。旧
        operation POST + 完整 payload PUT 在 R5b3b 客户端迁移完成前仍是明确兼容通道。
    - R5b3b 按客户端状态核心与 App/自动保存接线分两轮推进，不能在一个 React 回调中同时重写 transport、
      saved baseline 和离线恢复：
      - R5b3b1 已完成：新增纯原子批次 planner，先从 saved baseline 审计整条 pending command chain 与当前
        ProjectData 一致，再按共享上限切首批 100 项，避免后续命令失败却提交前半批；legacy、snapshot boundary、
        track-snap 和旧 `submitted` 行形成机器可读兼容 barrier。专用响应/错误策略严格核对 revision、ID、顺序、
        base 和 committed 事实；single-flight runtime 冻结同批 ID，处理有界退避、online 恢复、协议错误阻断、
        文件 generation 与迟到响应。document state 可只确认 pending 有序前缀并推进 saved/remote baseline，同时
        保留后续 current project、pending 和 undo/redo；pending 即使把正文撤回 saved 值也继续保持 dirty。
      - R5b3b2 已完成：App 保存事务冻结当前恢复状态，可重放 pending chain 按最多 100 项的原子批次提交，
        每批只推进 document saved project、派生吸附基线、local/remote revision 和 committed cursor，不再额外
        PUT 同一完整 payload；请求期间的新编辑保留为下一轮 dirty。薄 React adapter 与可测试 coordinator
        复用同批 operation IDs 做 single-flight/有界网络重试，文件切换取消旧等待；自动保存显式消费 online
        facts。结构命令携带现有租约或按 planner purpose 获取，提交后同步消费 token 并原位推进下一批 base
        revision；服务端绝对租约上限不会触发 0ms 续期忙循环。legacy、track-snap、snapshot boundary、旧
        submitted operation，以及服务器明确返回的旧 payload migration 继续走单一完整快照兼容入口；revision、
        lease、precondition、协议和确定 4xx 均 fail closed，不借快照覆盖远端。浏览器真实结构编辑验证只产生
        revision 15→16 和 operation 8→9，一次原子审计、无额外 PUT revision，租约归零。
      WebSocket 仍只负责 revision/presence/activity 提示；clean 客户端继续用 committed feed，dirty 客户端不得
      被远端 payload 静默覆盖。
    - R5b3c 按“纯判定与真实证据 -> App 重基线与用户确认”分轮推进，不能让 409 处理在没有完整本地链证明时
      静默覆盖 dirty 文档：
      - R5b3c1 已完成：抽出正常提交与冲突判定共用的 pending command chain 审计，统一检查 legacy barrier、
        operation 身份、local revision 连续性、严格 envelope、before precondition 和 current project 完整解释。
        新纯 rebase planner 先在原 saved baseline 证明本地链，再在最新服务器 ProjectData 上按序试运行同一批
        envelope；全部成功才返回完整 rebased project、原 operation id/envelope 与租约用途，任一目标缺失或
        before mismatch 都返回有界且无正文的机器摘要，不泄漏前序局部结果。真实 Fastify/PostgreSQL 双账号
        测试证明：双方从 revision N 读取，A 提交后 B 的旧 base 409 且零数据库副作用；无交集 B 命令可用同一
        id/envelope 在 N+1 重提至 N+2；同目标旧基线不重提；撤权后即使内容可重放仍由服务端 403。现有人工
        草稿比较继续保留，本轮尚未接入 App 自动/确认重基线。
      - R5b3c2 已完成：409 交接先通过既有串行 IndexedDB 队列 flush，再权威重取文件与草稿，并以单一状态机
        区分恢复、确认重放和人工比较。轻量 proposal 只暴露 revision、operation 数量和租约用途；用户确认后
        再次读取两侧并复核身份、revision、写权限、planner 结果和计划指纹。全部通过后，最新服务器 ProjectData
        成为 saved baseline，完整重放结果成为 current ProjectData，原 operation id/local revision/envelope
        保持不变；Workspace 先以最新 remote revision 写入 crash-safe checkpoint，再经唯一编辑器打开路径恢复，
        后续由普通自动保存走现有原子接口重提。同目标冲突、legacy/track-snap/snapshot barrier、revision 再变、
        撤权或指纹变化继续进入既有结构化人工比较。WebSocket 仍只承担失效提示/presence/activity，未引入
        OT/CRDT。
      - R5 完成后的可靠性维护已把同一套纯 rebase 证明接入普通在线原子保存：两个可写客户端从同一 revision
        编辑不同实体时直接重放；编辑同一时间目标时按 start/end 分边协调，本端未修改的边保留服务器最新值，
        本端修改的边采用后完成冲突恢复一端的绝对目标值；编辑同一稳定内容字段也采用后恢复端版本。重建命令
        保留 operation id，并在最新 revision 上立即重提；
        lifecycle、结构、旧命令、快照边界、撤权或请求期间又发生本地编辑仍停在显式冲突流程。浏览器旧草稿不
        启用值级转换，避免“服务端已提交但响应丢失”时重复应用。WebSocket 建连继续先订阅、再二次读取权威
        revision/cursor，消除票据 head 与订阅之间的漏通知窗口。
- R5 可部署候选门禁已完成：单服务器 PostgreSQL + Fastify + Web + 本地或 S3-compatible 对象存储方案
  统一记录于 `docs/server-deployment.md`；仓库提供生产环境模板、systemd、Nginx/TLS、同源开发代理、
  首管理员 bootstrap 和无凭据只读 smoke check。真实隔离 schema 已验证 14 条 migration 与首次管理员创建，
  临时数据已清理。
- 服务端 operation 排序、确认、重放、权限复核与原子批次提交已完成；WebSocket 仍只承载失效提示、
  presence 和瞬时 activity，不成为第二条持久写路径。
- 块级、内容、生命周期、工尺/板眼复合状态和递归轨道结构已进入严格命令或受控快照边界；结构修改继续
  使用显式短时租约，批量导入继续使用可审计快照边界。
- 协作保存与 operation、恢复快照、审计和 crash-safe 浏览器草稿已经联动；普通在线保存可在完整证明后自动
  重放无交集修改，并协调 timing/content 同目标冲突。结构、生命周期、旧草稿或证据不完整时仍进入人工结构化
  比较，不把高风险冲突降级成整份 JSON 覆盖。
- collaboration revision 通知只表示“服务器有更新”，不等于该 payload 已经进入本地编辑状态。clean 客户端
  在 observed revision 高于 applied revision 时必须暂时禁止新写操作并立即追赶；已经开始的编辑不被中断，
  仍由命令 precondition 和显式冲突流程裁决。
- clean catch-up 应用远端结果时，current/saved ProjectData、document-owned remote revision、App revision 与
  committed cursor 必须共同推进。该维护约束已通过“接收远端 vN 后立即本地保存至 vN+1”的回归覆盖，防止
  服务器已提交而客户端误报确认失败并阻断后续追赶。
- 对修复前已打开的旧会话，成功确认只允许在“document revision 落后且 frozen server-base ProjectData 与当前
  saved baseline 完全相同”时自愈；revision 超前或项目基线不一致继续 fail closed。该规则支持同 operation id
  幂等重试恢复，不引入整份 payload 覆盖。

完成标准：已达到。多账号可同时编辑而不静默覆盖，冲突与恢复过程可解释，并形成受控单服务器试用候选。
R5 完成不代表 R7 公网生产验收；真实云 IAM、TLS 续期、外部告警、长期备份调度、跨区容灾与安全审计仍需
在目标部署环境执行。

### R6：多模态后端任务

- 独立 worker/queue 执行音高、频谱、工尺谱渲染、姿态估计、转码和导出。
- 任务输入引用资源 id，输出写成可追溯结果资源。
- 状态、进度、取消、重试、幂等和失败诊断。
- 模型、参数、代码版本、来源文件 checksum 和结果 provenance。
- 计算缓存与资源权限继承。

完成标准：长任务不阻塞 API，结果可复现并能绑定回学术项目。

### R7：学术数据库、课堂工具与生产部署

- 剧目、折子、演员、声腔、曲牌、工尺谱、板眼和动作的领域元数据。
- 跨项目检索、引用、导出、永久标识和数据来源说明。
- 课堂所需的批量分发、进度视图和审核可建立在资源复制、ACL、diff 与确认层之上，
  不恢复 Course/Assignment 平行文件体系。
- 公开/受限数据分级、许可协议和敏感数据策略。
- 生产数据库迁移、对象存储、TLS、密钥、限流、备份、监控和灾难恢复。
- 公共发布前替换或取得 `GCNSymbolKai.woff2` 的明确授权。

完成标准：平台可作为教学工具和可持续维护的昆曲研究数据库运行。

## 5. 阶段依赖

```text
R0 稳定化
  -> R1 资源操作
  -> R2 恢复与比较
  -> R3 规模与运维
  -> R3h 外部媒体与分析资产
  -> R4 自动保存/离线
  -> R5 实时协作
  -> R6 多模态任务
  -> R7 学术数据库/生产化
```

顺序不是要求所有阶段一次做完，但有三个硬依赖：

- R0 完成前不开始自动保存或实时协作。
- R2 的恢复与比较能力应先于大规模协作。
- R4 的幂等、离线和冲突基础应先于 R5 WebSocket 协作。

R1 与 R2 的部分 UI 可交错；R3 的监控和迁移可随每阶段持续加强；R6 的单个实验任务可提前
验证，但不能绕过资源、权限和 provenance 边界。

## 6. 数据与 API 不变量

- 所有受管项目、文件夹、媒体和标注文件都必须有 `ResourceEntry`。
- 移动资源必须拒绝循环，并检查目标 `create_child`。
- 标注文件复制创建独立 revision 1 文件，复制者成为 owner，源直接 ACL 不复制。
- annotation save 在一个事务内锁定/复核 revision、保存旧 payload、更新新 payload。
- 无权限、过期权限和权限查询失败必须 fail closed。
- 删除默认软删除；恢复不能制造非法父子关系或名称冲突。
- 媒体读取和 Range 请求必须经过资源可见性检查。
- audit detail 与 operation payload 不得无意保存完整媒体或完整项目快照。
- 任何 API 合同变化必须同步 shared types、API、client、测试和本路线图。

## 7. 近期决策清单

### 已决定

- 使用 PostgreSQL + Prisma，当前 API 为 Fastify。
- 使用统一资源树与逐资源 ACL。
- 使用 mutable annotation file + revision + recovery snapshot。
- 保留本地 JSON 交换格式和本地编辑入口。
- 复制文件代替产品层 Fork。
- baseline 之后的持久 schema 变化必须提交可部署的 Prisma migration；`db:push` 只用于可丢弃的
  本地结构实验，不能代替迁移历史。
- 普通媒体复制创建新的媒体资源节点并复用不可变 `FileObject`；不重复写入大体积二进制。
  物理复制只作为未来显式的“创建独立二进制副本”操作，不属于普通复制/粘贴。
- 不兼容此前尚未投入生产的旧平台开发数据。

### 尚待阶段性决定

- recovery snapshot 保留期限与配额。
- 服务端搜索使用 PostgreSQL 索引还是后续独立搜索服务。
- 自动保存 operation 的领域粒度与幂等键格式。
- 实时协作采用自研 operation sequencing、OT、CRDT 或混合策略。
- 生产对象存储、任务队列和部署平台。
- 通用二进制资源是单独新增 `ResourceType`，还是将现有 `media_file` 收敛为通用 file 加媒体扩展。
- 批量打包遇到部分资源无下载权限时采用全量失败还是输出显式跳过清单。
- 小型流式 ZIP 与后台异步打包的容量/文件数切换阈值。

## 8. 风险与停止条件

- 若新平台改动导致本地编辑、时间轴精确行为或导入导出退化，应暂停扩展并先修复。
- 若权限规则在 UI、API、service 各自复制，应停止并收敛到唯一权限核心。
- 若 migration 或测试会破坏开发数据库，必须改用独立测试数据库；不得自动 force reset 未确认目标。
- 若自动保存无法区分已提交 operation 与已保存 snapshot，不得进入实时协作。
- 若快照或 audit 无限制保存完整 payload，应先解决容量和隐私问题。
- 若工尺谱字体许可未解决，不得将当前字体作为公开发布资产继续扩散。

## 9. 历史路线处理

以下旧阶段不再是现行实施计划：

| 旧主题 | 当前处理 |
|---|---|
| Course / Assignment / Submission | 运行时已删除；课堂流程未来基于资源复制、ACL、diff 和确认层设计 |
| ProjectMember + 轨道/时间 scope | 已删除；当前为 ResourcePermission；细粒度内容规则未来另立模型 |
| AnnotationWorkspace | 已删除；用户直接编辑 AnnotationFile |
| AnnotationVersion / ProjectVersion | 已删除；恢复使用隐藏快照，研究成果使用普通文件复制与比较 |
| Fork / 完成 / 候选发布 / superseded | 已删除；不重新引入 |
| 旧“阶段 0-8 平台骨架” | 实质基础已完成，由当前 R0-R3 接续稳定和补全 |
| operation log / autosave / collaboration | operation log 只有地基；按 R4-R5 重新实施 |
| 多模态服务 / 公开数据库 / 部署 | 目标保留，按 R6-R7 实施 |

完整历史、被撤销实现及当时验证结果见 `docs/development-log.md` 和 Git 历史。

## 10. 文档维护规则

- 本文件只保存当前架构、阶段状态、决策与下一步，不堆叠每轮代码流水账。
- 实际完成内容、其他 agent 的工作、Codex 审查、修复和验证写入
  `docs/development-log.md`。
- 当前交给本地 agent 的单轮任务写入被忽略的 `CLAUDE_WORK.md`，任务变化时整体重写。
- 权限语义变化同步更新 `docs/permissions-model.md`。
- document state、history、pending operation 或保存确认边界变化同步更新
  `docs/state-architecture.md`。
- 可持续的工程规则、目录职责和验证约束同步更新 `AGENTS.md`。
