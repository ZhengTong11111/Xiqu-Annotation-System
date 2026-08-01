# Development Log

> 本文件是按时间追加的实施历史，不是当前架构规范。旧章节中的 Course/Assignment、
> Workspace/Fork、ProjectMember、AnnotationVersion、ProjectVersion、PermissionGrant 和
> 轨道/时间 scope 均可能已被后续重构撤销。当前设计以 `AGENTS.md`、
> `docs/kunqu-platform-roadmap.md`、`docs/permissions-model.md` 和实际代码为准；不要为“修正文档”
> 回写或删除历史记录。

## 2026-08-01：R2.2 恢复快照 mutation 与内容写入保护线

Codex 按本机 `CLAUDE_WORK.md` 直接完成 R2.2，没有委派给其他 agent。开始前工作区已干净，因此没有
制造无内容的占位提交；实现完成后再统一提交可审查的功能切片。本轮引入
`@radix-ui/react-alert-dialog` 1.1.23（MIT，Radix 官方仓库）：它与既有 Radix Dialog 同源，用于危险
恢复操作的焦点锁定、Escape 和取消语义，替代自制确认弹层或 `window.confirm`，不引入新的视觉框架。

实现内容：

- 新增专用恢复 API。请求必须提交正整数 `baseRevision`；服务端验证快照同时属于路径中的标注文件，
  stale revision 返回 409，跨文件或不存在快照返回 404，无写权限返回 403。
- 恢复不是 revision 回退：事务先把当前 payload 保存为 `before_snapshot_restore` 保护快照，再把目标
  快照 payload 写成新的当前 revision，并更新编辑者、保存时间和资源修改时间。源快照继续保留。
- 新增 `annotation_snapshot_restore` 审计 action 与可部署 Prisma migration。审计只记录源快照 id、
  源/原/新 revision，不复制完整 payload；保护快照、文件更新和审计在同一事务提交。
- 普通保存与快照恢复共用活动标注文件内容写入 helper。两者先取得资源树 advisory key 的 shared
  transaction lock，再锁资源和 annotation 行、复核活动状态与 `write` 权限；move/trash/restore 继续
  对同一 key 取 exclusive lock。不同文件仍可并发写入，结构 mutation 与内容 mutation 不会交叉穿透。
- 将普通保存的 `annotation_file_save` audit 从 router 的事务后写入迁移到 service 事务内，并删除旧
  路径，避免“payload 已保存但审计失败”的半完成状态。
- Inspector 快照预览新增固定恢复入口与 Radix 二次确认，明确当前/目标 revision、文件、创建者与
  时间。恢复成功后刷新资源和历史；409 保留确认上下文并提示刷新；不可解析的旧 payload 仍可恢复，
  但确认框会提示可能需要旧版工具或人工修复。

审查与验证：

- `npm run test:api`：19 项通过。新增恢复成功、保护快照、审计、重复请求 409、坏输入、越权、跨文件
  快照、缺失资源，以及被回收祖先隐藏时 save/restore 均拒绝的回归。
- `npm run test:permissions`：5 项通过；`npm run test:resource-columns`：7 项通过；
  `npm run test:recovery-preview`：3 项通过。
- `npm run build` 通过 Prisma generation、shared、document-model、web 和 API；仍只有既有 Vite 大
  chunk 提醒。
- 新依赖经本地 package metadata 核对为 MIT；功能按需引入，不改变资源管理器低饱和桌面样式。
- 浏览器实际验证了坏 payload 警告、取消不修改文件、二次确认、正式恢复后 revision 2 -> 3、历史中
  新增“恢复前保护快照”，以及 Inspector 在资源刷新后仍保持展开；页面视觉层级正常。

下一步：R2.3 先建立可测试的 ProjectData 结构化 diff 模型与只读摘要入口。片段合并、确认标注层、
自动保存和协作继续保持独立边界。

## 2026-08-01：R2.1 恢复历史列表、详情与只读预览

Codex 先把“新增逻辑代码块必须附带中文功能注释”的长期规范写入 `AGENTS.md` 并独立提交，随后按
本机 `CLAUDE_WORK.md` 完成 R2.1。本轮没有引入新依赖：仓库已有 Radix Dialog，足以提供焦点管理、
Esc 关闭和遮罩行为；继续复用它比增加另一套 UI 基础设施更稳定。

实现内容：

- 将原来同时承担列表与详情的完整恢复快照 DTO 拆为 summary/detail。列表从 Prisma 查询层明确
  `select` 排除 payload，最多返回 50 条 revision、创建者、原因和时间；用户选择单条后才读取完整
  payload。
- 详情查询同时约束 annotation-file id 与 snapshot id；列表和详情均要求有效 `write` capability，
  并拒绝不存在、已回收或被已回收祖先隐藏的标注文件。跨文件 snapshot id 返回 404，不泄露归属。
- 新增纯函数 `recoverySnapshotPreview.ts`，从 `unknown` 开始校验，复用
  `normalizeImportedProjectFile()` 迁移当前/旧项目格式，再汇总视频、句级/逐字、工尺谱、板眼、
  自定义轨道/块和附属点数量。空对象、非项目 payload 或迁移失败只生成可显示错误，不影响 Inspector。
- 新增独立 `ResourceRecoveryHistory` 组件。标注文件 Inspector 默认折叠历史区，摘要和详情分别加载，
  使用请求 generation 防止快速切换资源时旧响应覆盖新状态；详情对话框明确只读，不提供恢复、保存
  或覆盖当前文件命令。
- 更新 shared 合同、浏览器 API client、Prisma 注释、命令清单和长期恢复快照不变量；删除旧的完整
  列表类型和调用路径，没有保留两套恢复读取接口。

审查与验证：

- `npm run test:recovery-preview`：3 项通过；覆盖当前项目、旧 `videoUrl` 格式与不可识别 payload。
- `npm run test:permissions`：5 项通过；`npm run test:resource-columns`：7 项通过。
- `npm run test:api`：17 项通过。新增用例覆盖轻量列表、详情内容、查看不修改当前 revision/payload、
  无 write 的 403、跨文件 snapshot id 的 404，以及缺失文件/快照。
- `npm run build:web` 通过；仅保留既有 Vite 大 chunk 提醒。
- 浏览器实际页面验证了标注文件 Inspector 入口、延迟展开、列表、坏快照隔离、Radix 对话框关闭与
  控制台零 error。开发数据库中的该历史 payload 是测试占位对象，因此 UI 正确显示不可识别提示；
  正常 ProjectData 摘要由纯函数测试覆盖。

下一步：R2.2 增加真正恢复 mutation。它必须把恢复视为一次新的 revision 写入：用 `baseRevision`
防并发覆盖，先快照当前 payload，再写入目标历史 payload，并记录不含标注内容的审计摘要。

## 2026-08-01：R1.6 原子批量移入回收站

Codex 先将 R1.5 共享资源项造成的详细列表 class 回归独立修复并提交为 `91abdd1`，随后按本机
`CLAUDE_WORK.md` 完成 R1.6。本轮没有修改数据库 schema、对象存储或标注文件格式，也没有新增
依赖；前端继续复用现有 Radix 菜单和资源管理器状态模型。

实现内容：

- 将原 `resourceMove.ts` 中实际与 move 无关的父子选择压缩逻辑迁移为 `resourceSelection.ts`。
  move 与 trash 现在共用 `normalizeResourceSelection()`；旧文件和旧命名已删除，避免两套树选择
  规则逐渐分叉。
- 新增 `POST /api/resources/trash-batch` 与 shared/client 合同，接收 1–200 个资源 id。父项和后代
  同时选择时只软删除最外层逻辑根，后代保持原父子关系并通过 trashed ancestor 隐藏。
- 整批 mutation 在一个 Prisma 事务中完成：取得统一资源树 advisory lock、锁定逻辑根与父命名
  空间、重新读取层级、通过 transaction client 复核每个根的 `delete` capability、统一写入
  `trashedAt`，并为每个逻辑根写 `resource_trash` 审计。任一资源不存在、无权限或状态非法时整批
  回滚。
- 单项 trash endpoint 保留服务端兼容入口，但委托同一个批量 service；浏览器客户端已删除无调用者
  的旧单项方法，不保留并行业务路径。
- 资源管理器新增统一批量 orchestration。工具栏、Delete/Backspace，以及列表、网格、分栏三种
  视图的右键菜单都调用一次 batch API；右键已选项作用于当前选择，失败时保留选择并显示原因，
  in-flight ref 防止确认框或快捷键重复提交。
- 三种视图均按整个待删除选择计算表面权限。服务端仍是最终鉴权边界，禁用菜单只用于提前说明。
- `npm run test:api` 改为执行全部 API 测试文件，并新增树选择纯函数测试；集成测试覆盖请求校验、
  缺失资源全量回滚、混合权限全量回滚、父子折叠、审计、重复删除和恢复清理。

验证：

- `npm run test:api`：16 项通过（包括 3 项选择归一化纯函数测试）。
- `npm run test:permissions`：5 项通过；`npm run test:resource-columns`：7 项通过。
- `npm run build`：Prisma generation、shared、document-model、web 和 API 全部通过；仅保留既有 Vite
  大 chunk 提醒。
- 浏览器实际页面验证：列表中 Command 多选两项后，工具栏显示并启用“将所选 2 项移到回收站”；
  右键当前选择中的资源显示统一“移到回收站”命令；Inspector 选择状态正常，控制台无 error。
  浏览器控制环境未能可靠接管原生 `window.confirm` 生命周期，因此没有把自动化点击冒充为完成
  删除；真实删除、失败回滚、审计和恢复清理由 PostgreSQL API 集成测试覆盖。

下一步：进入 R2.1，把现有自动恢复快照变成用户可见、可定位的历史列表和只读预览。真正恢复、
结构化 diff、永久删除、对象清理、标签与批量 ACL 继续作为独立切片，避免混入本轮事务语义。

## 2026-08-01：R1.5 Finder 式分栏资源浏览器

Codex 先把 R1.4 原子批量移动与桌面拖拽独立提交为 `13bf103`，随后按本机
`CLAUDE_WORK.md` 实现真正的 column view。本轮没有修改数据库 schema、API 合同、权限算法、
时间轴或标注文件格式，也没有新增依赖；资源项继续复用 R1.4 已引入的 Pragmatic DnD 和现有 Radix
右键菜单。

实现内容：

- 新增 `resourceColumnModel.ts`，用纯函数表示虚拟根、路径列、右侧截断、当前位置和路径选中。
  mutation 刷新后只在上游容器确实消失时截断路径；单列临时请求错误无法证明资源被移动，因此
  保留原路径，避免网络波动让用户丢失工作位置。
- 新增 `useResourceColumns.ts`，并行加载全部可见列并用请求 generation 阻止快速换目录时旧响应
  覆盖新路径。搜索只作用于最右列，祖先列保持完整；排序与刷新则一致作用于所有可见列。
- 新增 `ResourceColumnBrowser.tsx`，列组只横向滚动，每列独立纵向滚动；新列自动露出，当前选择
  自动滚入视口。支持单击展开、上下选择、右键/左键进入与返回，以及 Inspector 跟随。
- 抽出共享 `ResourceItem.tsx`，统一列表、网格、分栏的图标、格式化、Radix 右键菜单和 Pragmatic
  DnD 注册/注销，删除原来 `ResourceExplorer.tsx` 内重复的资源项和菜单代码。
- 列模式多选限制在同一列；Command/Ctrl、Shift、全选、复制、移动、恢复和删除都使用当前选择列
  的资源集合，避免跨层级产生含义模糊的选择。
- 列表/网格切到分栏时从 breadcrumbs 恢复路径；分栏切回单页视图时保留最右目录。创建、导入、
  上传和粘贴统一使用当前列位置。
- 工具栏命令收敛为桌面式图标按钮并保留 tooltip，避免中间浏览区变窄时按钮文字被压成竖排；
  视图切换始终保持可见。
- 提交后人工检查发现共享资源项把列表类名误写成按规则推导的 `.resource-list-item`，而既有五列
  详细布局使用 `.resource-list-row`，导致列表退化成普通按钮并横向挤压。现已恢复明确类名映射，
  浏览器截图复核名称、类型、修改时间、负责人和大小五列及选择状态均恢复正常。

验证：

- `npm run test:resource-columns`：7 项通过，覆盖路径建立/替换/截断、当前位置、资源消失和临时
  读取失败。
- `npm run build:web`：通过；只保留既有 Vite 500 kB chunk 提醒。
- 浏览器验证：多级分栏、路径选中、列表与分栏位置互转、上下/左右键、Inspector 跟随、最右列
  搜索且祖先列不被过滤、工具栏窄宽度布局均符合预期。
- 分栏资源项使用与列表/网格相同的 Pragmatic DnD 注册和原子批量移动 API。浏览器自动化仍不能
  可靠合成原生 drop 手势，因此列间真实拖拽保留为人工验收项；本轮未伪造自动化通过结论。

下一步：R1.6 原子批量移入回收站。永久删除、对象清理、标签和批量 ACL 继续作为后续独立设计，
不塞入同一事务切片。

## 2026-08-01：R1.4 原子批量移动与桌面拖拽

Codex 按 `CLAUDE_WORK.md` 先把上一轮 R1.3 以提交 `e235adf` 独立保存，再实现批量移动合同和
桌面拖拽入口。拖拽没有另写一套业务逻辑，目标选择器、工具栏和拖放最终都调用同一个批量 API。

后端：

- 新增 `POST /api/resources/move-batch`，请求包含 1–200 个去重资源 id 和目标 `parentId`。
- 新增 `resourceMove.ts` 纯归一化 helper。父目录和后代同时被选中时，后代记入
  `collapsedDescendantIds`，只移动最外层逻辑根，保留子树内部关系。
- 整个选择在一个 Prisma 事务内执行。事务统一取得资源树写锁、按 id 排序的资源行锁和按名称
  排序的源/目标命名空间锁；权限、活动树、目标容器、循环和同名冲突任一失败都会整批回滚。
- 同目录资源作为 `unchanged` 返回，不执行 update，也不写伪造的 move audit。
- 旧单项 move endpoint 保留 API 兼容性，但删除了原来的单资源事务实现，改为委托批量核心。
- API 集成测试新增批量移动组，覆盖父子选择压缩、重复 id、no-op 审计、同名整批回滚、循环、
  resource move 权限、目标 create_child 权限、回收站祖先和坏输入。

前端：

- 目标选择器由单资源改为选择快照，支持多项标题、混合来源和“全部已在目标目录”的 no-op 提示。
- 资源工具栏增加多选移动；右键未选中资源只移动该项，右键当前多选中的资源移动整个选择。
- 新增 `resourceDragAndDrop.ts`，集中注册 draggable/drop target、校验内部 drag payload、生成紧凑
  原生拖拽预览并负责 cleanup；列表、网格和面包屑共用这一层。
- 引入 `@atlaskit/pragmatic-drag-and-drop@2.0.1`（Apache-2.0）。它只负责 headless 拖拽事件，
  不接管现有 CSS、选择状态、权限或 API；选择它是为了替代容易泄漏和重复触发的手写 HTML5
  drag lifecycle。目标选择器继续保留为键盘可访问的完整移动入口。
- 拖动已选中资源携带整个选择；拖动未选中资源先形成单选。加载、回收站、粘贴、恢复、移动中和
  目标选择器打开时禁用拖拽写操作。
- 人工验收发现项目移动进另一项目后仍出现在“所有项目”。根因不是复制或 move 事务失败，而是
  `all_projects` 原先把所有层级的 project 平铺返回。现已把该视图明确为资源管理器根目录，只返回
  `parentId = null` 的顶层项目；最近、收藏、共享等聚合视图仍可跨目录展示。集成测试同时断言移动后
  数据库只有新的父级关系、根视图不再显示嵌套项目、目标项目子项中仍可找到该项目。

验证：

- `npm run test:api`：12 组通过；包含移动后根视图与目标目录显示语义回归测试。
- `npm run test:permissions`：5 项通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 已知非阻断提示仍为 pg 9 前置弃用 warning 和 Vite 500 kB chunk warning。
- 浏览器已验证登录、Command/Ctrl 多选、工具栏“移动（2）”、多项目标选择器标题、源容器禁用、
  no-op 提示和 DnD 对列表项的原生 draggable 注册；控制台无 error。
- 自动化浏览器未能可靠合成原生 HTML5 drop 手势；用户随后已用真实指针把项目拖入另一项目，
  确认 drop 会触发服务端移动，并由此发现上述根视图穿透问题。网格多选、面包屑祖先目标、取消拖拽
  和键盘完整路径仍保留为最终人工验收项；自动化阶段的临时资源已移入回收站。

## 2026-08-01：R1.3 递归复制与统一复制/粘贴语义

Codex 根据本机 `CLAUDE_WORK.md` 完成 R1.3。本轮把前端“可复制任意资源”与后端“只支持标注文件”
的矛盾收敛为统一文件管理语义，没有修改时间轴、本地项目 JSON 或标注编辑器数据模型。

实现内容：

- 新增 `resourceCopy.ts` 纯规划层：验证资源树连通性，按父先子后排序，为整棵树预分配新 id，并把
  标注文件指向子树内媒体的 `mediaResourceId` 重映射到副本；复制上限为每个根 2,000 个活动节点。
- `copyResource()` 支持 project、folder、annotation_file、media_file。项目/文件夹的每个根在单一
  数据库事务内全有或全无；任一活动后代缺少 read/copy 时整棵拒绝，不留下半成品。
- 副本所有节点由复制者拥有，不复制 direct ACL、收藏/最近状态、恢复快照、operation、job 或审计
  历史；新节点从目标目录重新继承权限。标注 revision 重置为 1。
- 媒体普通复制只创建新 ResourceEntry/MediaFile，并复用不可变 FileObject。新增正式 migration
  `20260801010000_media_file_object_reuse`，把 FileObject/MediaFile 从一对一改为一对多。
- 媒体读取鉴权改为检查账号是否能下载任一引用同一 FileObject 的媒体资源，继续保留 owner/admin
  快速路径和 Range 行为。
- 前端新增 `resourceClipboard.ts`，多个根顺序复制并收集独立结果；一个根失败不阻止后续根。工具栏
  增加可见“粘贴”，成功后选中新副本，失败时按资源汇总原因，并用 ref 阻止快捷键/按钮重复提交。
- 复制审计只记录源 id、节点数、标注数和复用对象数，不写 payload 或二进制内容。

审查过程中发现并修复测试数据库隔离漏洞：

- Prisma URL 的 `?schema=api_test` 不会自动改变 node-postgres 的 `search_path`；旧测试 migration
  部署到 `api_test`，但 Prisma/raw SQL 可能仍访问 `public`。
- 新增共享 `database.ts`，同时给 PrismaPg adapter 和 PostgreSQL search_path 指定同一 schema；生产
  与测试不再各自构建连接。
- 测试清库前除校验 URL 以 `_test` 结尾，还读取 `current_schema()` 验证实际连接，防止误清开发数据。
- 开发 public schema 原先已有 baseline 表但没有 migration history。本轮先核对表与媒体唯一索引，
  使用 `migrate resolve --applied` 无损登记 baseline，再通过 `db:deploy` 应用 R1.3 migration；未 reset、
  未清理开发数据或对象存储。

验证：

- `npm run test:api`：11 组通过。递归复制测试覆盖项目说明、多层目录、媒体对象复用、内部/外部
  媒体引用、revision、ACL/恢复历史不复制、下载、禁止复制到自身后代、受限后代整体回滚和审计摘要。
- `npm run test:permissions`：5 项通过。
- `npm run build`：Prisma generate、shared、document-model、Web 与 API 全部通过；Vite 仍报告既有的
  604.74 kB 大 chunk 提醒，本轮未增加相关依赖或扩大 bundle 路径。
- `npm run db:deploy`：public schema 成功应用媒体对象复用 migration。
- 没有新增依赖：递归拓扑、id 映射和顺序结果收集均为短小领域逻辑，引入通用图/队列依赖不会减少
  维护成本。

尚待用户浏览器人工验收：四类资源单独复制、含内部媒体引用的项目复制、多选部分失败、连续粘贴
防重，以及回收站仍只提供恢复。永久删除、FileObject 引用计数/孤儿清理和大型异步复制不在本轮。

## 2026-08-01：R1.2 回收站恢复与虚拟视图操作闭环

Codex 先将已完成并验证的 R1.1 移动目标选择器提交为 `8ca74c3`，再按本机
`CLAUDE_WORK.md` 开始 R1.2。本轮没有修改数据库 schema、shared API 合同、对象存储或时间轴。

实现内容：

- 回收站右键菜单改为上下文语义，只提供按有效 `delete` 能力启用的“恢复到原位置”，不再显示
  打开、复制、移动、重命名和重复移入回收站。
- 回收站工具栏增加可见的“恢复所选（N）”；隐藏新建项目/文件夹、导入 JSON 和上传媒体入口，
  并抑制 Enter、F2、Command/Ctrl+C、双击和 Delete/Backspace 的普通资源操作。
- 回收站 Inspector 保持只读详情，不允许在已删除资源上继续编辑收藏或账号权限。
- 新增纯前端 `resourceRestore.ts`：按选中父子关系让祖先优先，随后顺序调用现有单项恢复 API；
  多选采用明确的部分成功语义，一个名称冲突不会阻止无关资源恢复，失败项保留选择并显示资源名
  与具体原因。
- 恢复 orchestration 使用 ref 阻止 React 状态提交前的重复菜单事件发起并发恢复；右键单项和工具栏
  多选共用同一请求路径。
- 后端先通过新增失败测试复现“父目录仍在回收站，子项恢复却返回 200”的问题，再修复为 `409`。
  恢复现在在事务内检查原父目录存在、仍为容器、父目录及全部祖先处于活动树，并继续执行同名
  冲突检查。
- 将 move 专用 advisory lock 收敛为 `lockResourceTreeMutation()`；move、trash、restore 按统一的
  树结构锁、资源行锁、父目录命名空间锁顺序执行，防止恢复校验后父目录被并发移动或删除。
- `hasTrashedAncestor()` 显式接收 Prisma client/transaction，事务中的恢复检查不再退回事务外
  client 读取过期树状态。
- 重复 trash/restore 请求返回清楚的 `400`，避免没有真实状态变化却写入成功审计。

测试与审查：

- `npm run test:api`：10 组通过。新增断言覆盖父目录未恢复时子项 `409`、拒绝后仍保持 trashed、
  无权限恢复 `403`、失败不写成功审计、先父后子恢复成功、根级项目恢复成功。
- `npm run test:permissions`：5 项通过。
- `npm run build`：Prisma、shared、document-model、Web、API 全部通过。
- 单独运行 Web build 与恢复排序 helper，确认选中父项先于子项执行。
- `git diff --check` 通过。
- 本地 Web/API 服务均可访问；浏览器验证到平台登录页。没有替用户提交登录表单或修改开发数据，
  因此已认证的回收站菜单、多选与冲突反馈仍需按交付顺序人工走查。
- 仍存在上游 Prisma adapter 的 pg 9 前置弃用提醒和 Vite 603 kB 大 chunk 提醒，均非本轮回归。

本轮明确没有实现永久删除。物理对象清理、恢复期限和审计策略没有确定前，不提供不可逆按钮。
递归复制、媒体复制语义、拖拽/批量移动和真正的 Finder column view 继续留在 R1 后续切片。

## 2026-08-01：R1.1 资源移动目标选择器

R0 稳定化实现经完整 build、API 集成测试、权限测试和 diff check 复核后，Codex 将其提交为
`fc5471a`，随后开始 R1 的第一个独立资源操作切片。本轮没有修改数据库、shared API 合同、
后端移动事务或时间轴。

实现内容：

- 在资源右键菜单增加“移动到…”，按资源的有效 `move` 能力决定是否启用。
- 新增独立 `ResourceDestinationPicker`，通过现有 `listResources()` 浏览项目/文件夹，通过
  `moveResource()` 提交目标 parent id；没有复制 ACL 或循环检测算法到前端。
- 目标选择器区分浏览位置和选中目标，支持根目录、面包屑、返回、单击选择、双击/Enter 进入、
  Escape 关闭、加载/空目录/无权限/同目录/失败/提交中状态。
- 禁止进入待移动容器本身，从 UI 层避免选择其后代；服务端事务内 cycle 和 `create_child` 检查
  仍是安全边界。
- 目录请求使用递增请求 id 让旧响应失效，避免快速切换路径时较慢响应覆盖当前目录。
- 移动成功后清理已离开列表的选择和 anchor，再按服务端结果刷新目录，避免 Inspector 持有旧对象。
- 引入 MIT 许可的 `@radix-ui/react-dialog`，复用其 Portal、焦点锁定、Escape 和无障碍语义；
  相比维护手写 modal/focus trap，减少了容易失效的交互代码，并与现有 Radix Context Menu 一致。
- 增加符合现有低饱和桌面资源管理器的对话框样式，目录列表独立滚动并适配窄窗口。

审查与验证：

- `npm run test:api`：10 组通过，移动继承重算、循环保护、目标权限和名称冲突继续由真实
  PostgreSQL 集成测试覆盖。
- `npm run test:permissions`：5 项通过。
- `npm run build`：Prisma、shared、document-model、Web 和 API 全部通过。
- `git diff --check` 通过。
- 本地浏览器实测右键入口、源项目禁用、目标选择后确认启用、双击下钻、面包屑、返回和对话框
  布局；验证过程中没有提交实际移动，不改变测试数据。
- 仍保留上游 Prisma adapter 的 pg 9 前置弃用提醒和 Vite 大 chunk 提醒，均非本轮回归。

本轮明确未做多选批量移动、拖拽移动、递归复制、通用文件网盘和 ZIP 打包；这些继续按 roadmap
后续 R1/R3 切片实施。

## 2026-08-01：R0 migration、API 集成测试与事务保护线

Codex 在 `codex/backend-r0-stabilization` 分支开始实施新 roadmap 的 R0。本轮直接读取并审查
Prisma schema、Fastify 装配、资源 service、ACL、对象存储和现有纯权限测试，没有修改时间轴。

实现内容：

- 从当前资源树 schema 生成 `20260801000000_resource_tree_baseline` migration，并新增
  `db:deploy`。本地数据库账号没有 `CREATE DATABASE` 权限，因此测试采用独立 `api_test`
  PostgreSQL schema；准备器硬性拒绝清理名称不以 `_test` 结尾的 schema。
- 将 Fastify 应用装配抽到 `apps/api/src/app.ts`。生产 `server.ts` 只负责 Prisma/pool、seed、
  listen 和进程关闭；测试通过同一 app factory 使用 `inject()`。
- 新增 API 测试 tsconfig、临时对象存储和 `npm run test:api`。10 组集成测试覆盖认证、资源创建与
  循环、ACL 继承/截断/过期/委派、移动继承重算、标注复制、并发 revision 保存、恢复快照、
  回收站、媒体 Range、审计、operation 与 processing job 边界。
- 目录命名写操作使用 transaction advisory lock；创建、重命名、移动、复制与恢复在锁内重新
  检查名称。move 另有全局树结构事务锁，避免并发交叉移动同时通过循环检查。
- 对象流写入失败会删除半文件；文件已写入而数据库落库失败时执行补偿删除。

测试驱动修复：

- 非法/越界 Range 不再退化为整文件 200，而是返回 416；`bytes=-N` 正确读取尾部字节。
- stale annotation operation 不再以 `superseded` 状态返回 200，而是与 snapshot 保存一致返回
  409，并在共享行锁下确认 revision。
- 已删除容器的后代不再穿透到 all-projects 等普通视图。
- 回收站资源恢复时若同目录已有同名替代项，返回 409，不制造两个活动同名项。
- 审计日志写入失败不再把已经完成的主操作伪装成 500，避免客户端重试制造重复资源。

验证：

- baseline 首次 deploy 成功，重复 deploy 无 pending migration。
- Prisma schema 与 `api_test` 数据库 diff 为零。
- `npm run test:api`：10 组通过。
- 仍需在最终审查阶段运行 permission tests、完整 build 和 diff check。
- Prisma pg adapter 的并发事务测试会触发 `pg` 8 的 pg 9 前置弃用警告；堆栈位于上游 adapter，
  当前没有测试失败或数据错误。

## 2026-08-01：资源树重构后的文档基线重置

本轮没有修改运行时代码。资源树与逐文件 ACL 已合并到 `main` 后，Codex 重新审查了 roadmap、
权限文档、状态架构、README 和 AGENTS，发现旧 20 阶段路线与旧 `PermissionGrant + 轨道/时间
scope` 文档仍可能让后续 agent 按已经删除的模型继续开发。

完成内容：

- 将 `docs/kunqu-platform-roadmap.md` 从累积式旧计划重写为当前 R0-R7 路线：先 migration 与
  API 集成测试保护线，再补资源操作、恢复/比较、规模化、自动保存、实时协作、多模态任务和
  学术数据库/生产部署。
- 明确 Course/Assignment、Workspace/Fork、ProjectMember、AnnotationVersion、ProjectVersion
  和旧轨道/时间 scope 只属于历史，不是待完成兼容项。
- 重写 `docs/permissions-model.md`，统一为 `ResourceEntry + ResourcePermission` 的能力、继承、
  ownership、复制/移动/保存与 fail-closed 语义。
- 重写 `docs/state-architecture.md`，记录当前 `useProjectDocumentState()`、平台 revision save、
  operation 摘要边界，以及自动保存/实时协作的真实前置条件。
- 更新 `AGENTS.md`，移除旧 Workspace/Fork 发布流程验证项，并明确未来课堂流程应基于资源复制、
  ACL、文件比较和确认层。
- 将本机 `CLAUDE_WORK.md` 整体替换为下一轮 R0 详细任务单；该文件继续被 `.gitignore` 排除，
  不作为历史日志提交。

验证：

- 全仓检索现行规范中的旧模型引用；保留的引用均用于明确“已删除/不得恢复”。
- `git diff --check` 通过。
- 本轮只有 Markdown 文档变更，未运行构建或数据库测试。

## 2026-07-27：资源管理器与逐文件账号权限重构

本轮由 Codex 根据用户确认的新产品逻辑直接设计并实现，没有沿用上一轮
Workspace/Fork/发布版本状态机，也没有由 Claude Code 或 GLM 代写。

实现内容：

- 在开始破坏性重构前提交旧工作区版本，基线提交为
  `743d2db Replace assignments with workspace version model`。
- 重写 Prisma 平台领域模型：
  - `ResourceEntry` 统一文件夹、项目、标注文件和媒体文件。
  - `AnnotationFile` 保存 payload 与 revision。
  - `AnnotationRecoverySnapshot` 保存覆盖前内容。
  - `ResourcePermission` 保存逐资源、逐账号能力。
  - `ResourceUserState` 保存收藏和最近打开状态。
- 新增 `resourceAccess.ts` 与 `resourceService.ts`，集中处理继承权限、资源树修改、
  标注文件复制、revision 冲突和恢复快照。
- 删除旧 `AnnotationWorkspaceService`、`AnnotationVersionService`、
  `ProjectVersionService`、项目成员服务和串行发布事务帮助器，避免旧生命周期逻辑继续存在。
- 重写 shared DTO、API 路由/client 和 document-model 权限测试。
- 新增 `ResourceExplorer.tsx`：
  - 三栏桌面式资源管理界面。
  - 搜索、排序、列表/网格/列模式、面包屑、多选、快捷键和右键操作。
  - 新建项目/文件夹、导入 JSON、上传媒体、复制标注文件、重命名和移入回收站。
  - Inspector 直接展示和编辑选中资源上每个账号的能力与继承设置。
- `PlatformWorkspace.tsx` 只负责登录、资源管理器和编辑器会话切换；
  `App.tsx` 改为按 annotation-file id/revision 保存。
- 保留原有本地 JSON 与本地工具入口，平台 revision/ACL 不污染 `ProjectData`。

审查与修复：

- 修复全局 checkbox 样式污染权限矩阵的问题，限定资源权限复选框尺寸。
- 系统管理员行明确显示“完整权限”，不再误显示为“尚未授权”。
- 标注文件打开失败时立即显示用户可见错误，不让错误只停留在不可见的外层状态。
- 删除旧后台、成员、Workspace 和版本页面遗留的 600 余行无引用 CSS，并把登录页样式收敛为
  当前单面板结构；避免旧两栏登录布局和已删除页面选择器继续污染维护边界。
- 并发审查发现 revision 预检若放在事务外，两次同 revision 保存可能竞争恢复快照；
  保存事务现在先用 PostgreSQL 行锁串行化同一标注文件，再在事务内复核 revision，并以
  条件 UPDATE 作为第二层保护。真实并发请求结果稳定为一个 `200`、一个 `409 conflict`。
- 恢复权限到期时间和 operation log 参数的严格运行时校验，无效日期、负 revision 和空
  action 现在返回 `400`，不会穿透到 Prisma 形成 `500`。
- 全仓检索确认活动代码不再引用 Workspace、Fork、AnnotationVersion 或 ProjectVersion。
- 更新 `AGENTS.md` 和 roadmap，删除会误导后续 agent 的旧领域约束。
- 同步重写 README 的平台入口、PostgreSQL/API 启动方式、三栏资源管理、逐文件账号权限、
  revision/恢复快照和当前限制；原有详细时间轴说明继续保留。本地模式与平台模式现在有各自
  明确的启动和保存说明。
- 修正 roadmap 顶部的“当前模型”声明，并把紧邻顶部的 Workspace/Fork 落地记录标注为
  已撤销历史；后续实施应以资源树与逐文件 ACL 阶段为准。

验证：

- `npm run build`：Prisma、shared、document-model、Web、API 全部通过。
- `npm run test:permissions`：5 项资源权限测试通过。
- `npm run db:push -- --force-reset`：本地 PostgreSQL schema 与新种子成功重建。
- 真实 API 冒烟：
  - 学生可继承读取项目和标注文件。
  - 对原文件无写权限时保存返回 403。
  - 复制后学生成为新文件 owner，可保存并递增 revision。
  - 管理员可给原文件补充直接写权限。
  - 覆盖前 payload 正确形成 recovery snapshot。
  - 两个并发保存使用相同 `baseRevision` 时仅一个成功，另一个返回 409。
- 浏览器冒烟：登录、三栏浏览、项目下钻、权限矩阵展开编辑和进入时间轴编辑器均通过。

后续事项：

- 移动 API 已具备，但前端仍需专业的目标选择器和拖拽移动。
- 文件夹/项目递归复制、真正的 Finder column view、虚拟列表和服务端搜索尚未实现。
- recovery snapshot 管理、批量权限、实时协作与离线恢复继续沿 roadmap 推进。

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
