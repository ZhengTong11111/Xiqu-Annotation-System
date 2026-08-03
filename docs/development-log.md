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

## 2026-08-02：R2.3a 两个标注文件的结构化比较

本轮严格按 `CLAUDE_WORK.md` 的单轮任务完成普通标注文件比较基础，没有混入片段合并、快照恢复、
已确认范围或实时协作。

实际实现：

- 新增 `src/platform/annotationDiff.ts`：
  - 两侧 `unknown` payload 先通过共享可识别边界，再复用唯一的
    `normalizeImportedProjectFile()` 迁移到当前 `ProjectData`。
  - 按稳定实体 id 比较项目/媒体、句级字幕、逐字与四声、工尺谱、板眼区段/标记、递归自定义轨道、
    自定义块和附属点。
  - 显示派生的 Gongche/branch pseudo lane 不作为保存实体重复计数；工尺 fallback symbol 的随机 id
    不进入语义 fingerprint。
  - 重复稳定 id 不再被 `Map` 静默吞掉，结果会指出左/右侧、领域和重复标识数量。
- 把“可识别旧项目 payload”判断收敛到 `src/utils/projectFile.ts`，快照预览和文件比较共享同一边界，
  仍由正式 normalizer 承担唯一迁移逻辑。
- 新增 `AnnotationComparisonDialog.tsx`：
  - 并行按需读取两个完整标注文件，使用请求 generation 阻止关闭、交换或换文件后的迟到响应污染。
  - 分别呈现左右读取/权限/迁移错误，支持交换左右、重试、总计和领域差异展开。
  - UI 只显示结构化摘要，不把 payload 写入 URL、日志、localStorage 或 audit。
- 新增 `resourceComparison.ts`，集中判定“恰好两个、均为可读标注文件、非回收站、无 mutation”资格，
  并按 `selectedIds` 而非资源排序保留左右顺序。
- 列表、网格和 Finder 分栏共用 `ResourceItem` 右键命令；工具栏使用同一资格 helper，没有三套分支。
- 没有新增依赖：现有 Radix Dialog、Radix Context Menu 和 Lucide 足以提供稳定行为与当前视觉风格。

浏览器验收：

- 两个不可识别的集成测试 payload 会分别显示左/右迁移错误，不生成空项目假 diff。
- 使用有效《寻梦》示例文件验证了差异总计、领域展开、字段与时间范围、警告、左右交换和内部滚动。
- 列表工具栏、网格右键和 Finder 分栏右键均能从同一组选中的两个标注文件打开比较。
- 浏览器验收向本地开发数据库的示例项目导入了一份仓库内有效 JSON，仅作为运行数据，`data/` 仍被
  git ignore，不进入提交。

自动验证：

- `npm run test:annotation-diff`：10/10 通过。
- `npm run test:resource-comparison`：2/2 通过。
- `npm run test:recovery-preview`：3/3 通过。
- `npm run test:resource-columns`：7/7 通过。
- `npm run test:permissions`：5/5 通过。
- `npm run test:api`：19/19 通过。
- `npm run build`：通过。
- 既有提示仍存在：Prisma/pg 并发测试输出 pg 9 前置弃用警告；Vite 主 chunk 超过 500 kB。本轮没有
  引入新的相关回归。

本轮核对结论与下一步：

- 未发现比较操作修改文件 revision、恢复快照、audit、编辑器 history 或资源选择的路径。
- 当前 UI 展开大领域时会一次渲染该领域全部变化；真实示例约千级差异可用，若后续规模明显扩大，
  再以测量结果决定虚拟列表，不提前引入重型表格依赖。
- 下一轮是 R2.3b：先设计结构化差异到时间范围导航/现有 Timeline 只读联动的边界，再决定单时间轴
  标记或双视图方案；不得直接进入片段合并。

## 2026-08-02：R2.3b1 标注差异的只读双侧时间概览

本轮先结合现有单文档 `PlatformEditorSession`、mutation callback 很重的 `Timeline.tsx` 和 R2.3a
结构化 diff 重新拆分 roadmap，没有把第二份 `ProjectData` 或完整时间轴硬塞进比较 Dialog。

实际实现：

- 新增 `annotationDiffTimeline.ts` 纯模型：
  - 只消费 `AnnotationDiffResult.groups[].entries`，按 domain + identity 建立稳定实体键；
  - 修改项可生成左右两个片段，新增/删除按实际存在范围生成单侧片段，零时长板眼/打点保留点语义；
  - 反向有限范围归一化并向 UI 报告纠正数，负数、NaN 和 Infinity 不进入 Canvas，并单独计数；
  - 领域、变化类型和可选时间窗口筛选保持共同 duration，不因切换筛选让坐标轴跳动；
  - CSS 像素 hit-test 在重叠片段中按距离、较短范围和稳定 key 选择唯一结果。
- 新增高 DPI `AnnotationDiffTimelineOverview.tsx`：
  - `ResizeObserver` 跟随 Dialog 实际宽度，两条语义轨共享时间刻度；
  - Canvas 一次绘制千级片段，不为每个范围创建 React 节点；领域颜色、左右轨、变化轮廓和相邻状态
    文字共同表达语义；
  - hover/选中只触发轻量重绘，Canvas 不拥有筛选、网络请求或编辑器状态。
- 比较 Dialog 增加研究领域与新增/删除/修改筛选、可定位实体数、无时间差异数和非法范围提示。
  Canvas 选择会明确展开领域并在 React 挂载目标按钮后滚动；差异行改为可键盘操作的 button，选择后
  自动恢复其领域/变化筛选并高亮左右时间范围。无时间项目差异显示明确说明。
- 左右交换以文件 id + revision 重建结果组件，筛选和选择不会引用交换前实体。没有新增依赖，现有
  React、Canvas、Radix Dialog 与测试工具已经足够。

浏览器验收：

- 使用本地有效《寻梦》两份标注，约 1,120 项结构化变化中 1,116 项具有时间范围；Canvas 在共同
  0–24:00 轴上稳定绘制，左侧短文件和右侧长文件的分布符合数据。
- 关闭工尺谱后可定位实体从 1,116 降至 838，继续关闭逐字后降至 684；API 日志确认筛选没有重新请求
  annotation-file payload。
- 点击差异行能够高亮对应时间范围；无时间项目差异显示“没有可定位的时间范围”。左右交换后文件
  方向正确、旧选择清空、筛选恢复默认。
- 验收期间原有 API 进程退出，Dialog 正确显示双侧 `Failed to fetch` 和重试；健康检查确认是服务进程
  不可用而非交换状态错误，重启 API 后通过原按钮恢复。Browser 自动化表面对 Canvas 的任意坐标点击
  支持有限，因此精确命中规则由专项纯函数测试覆盖，视觉与列表到 Canvas 的方向由浏览器验收覆盖。

自动验证：

- `npm run test:annotation-diff-timeline`：10/10 通过。
- `npm run test:annotation-diff`：10/10 通过。
- `npm run test:resource-comparison`：2/2 通过。
- `npm run test:recovery-preview`：3/3 通过。
- `npm run test:resource-columns`：7/7 通过。
- `npm run test:permissions`：5/5 通过。
- `npm run test:api`：19/19 通过。
- `npm run build` 与 `git diff --check`：通过。
- 既有 pg 9 前置弃用提示和 Vite 主 chunk 超过 500 kB 提示仍存在，本轮没有新增依赖或相关回归。

下一步：

- R2.3b2 只处理“从选中差异打开左侧或右侧文件并定位时间”的平台会话合同。必须复用现有单文件
  编辑器和 read-only 权限，不能在比较 Dialog 复制完整 Timeline；片段合并继续留在后续独立轮次。

## 2026-08-02：R2.3b2 从比较差异打开对应文件并定位时间

本轮严格按重写后的 `CLAUDE_WORK.md` 完成一个闭环，只建立“结构化差异 → 单侧文件 → 现有编辑器”
导航，没有混入第二套 Timeline、双文档编辑、片段合并、恢复快照或协作协议。

实际实现：

- 新增 `annotationComparisonNavigation.ts` 纯导航合同：
  - 左右命令只读取所选侧自己的 `leftTimeRange/rightTimeRange`；
  - 缺失、负数、NaN 和 Infinity 返回 `null`，不伪造 0 秒；
  - 零时长打点保留，反向有限范围统一归一化，播放起点取归一化 start；
  - 生成的 `AnnotationComparisonFocus` 明确标记为一次性运行时会话状态。
- `PlatformWorkspace` 抽出唯一 `openPlatformAnnotationFile()`：普通双击和比较导航现在共用最新文件
  读取、父标题、受保护媒体 hydrate、revision、权限和只读判定。旧内联打开实现已删除；失败返回
  `false` 并保留资源管理器/比较窗口状态。
- 比较 Dialog 在选中差异后显示“打开左侧/打开右侧”：
  - 只有该侧存在合法范围时启用；打开期间防止重复提交和左右交换；
  - 当前条目只通过稳定 key 从 diff 反查，不复制陈旧实体；
  - 交换左右会重建比较结果与命令方向，失败后当前选择与筛选不被清空。
- `PlatformEditorSession` 增加可选 `initialFocus`。`EditorWorkbench` 把播放头初始化为真实范围 start，
  并向现有 Timeline 提供一次性带缓冲的 focus range；Timeline 回报消费后清理，后续人工滚动不会
  再被拉回。该字段不进入 ProjectData、JSON、undo/history、operation log 或服务器保存。
- 没有新增依赖；现有 React、Radix Dialog、Lucide 和 Timeline focus 接口足以清楚实现边界。
- 清理 `AGENTS.md` 中 R2.3a 遗留的重复目录说明，并补充平台唯一打开入口与一次性焦点不变量。

浏览器验收：

- 使用本地《寻梦》r3 与 r1 文件比较：选择只在右侧存在的 `line-1` 时左侧禁用、右侧启用；进入
  右侧文件后当前时间严格显示 `58.199s`，时间轴首屏从约 58 秒开始，句级与逐字内容属于右侧文件。
- 选择只在左侧存在的删除项时仅左侧可用；选择无时间的项目/媒体差异时两侧均禁用。
- 交换左右后，同一 `line-1` 变为左侧删除项，仅左侧可用，说明命令方向跟随文件而非旧选择。
- 1280×720 截图确认编辑器播放头、时间轴和比较命令布局没有溢出；验收标签和本轮 Web 进程已清理。
- 本轮未人为停止正在复用的 API 进程来验证失败分支；失败保留由 callback 的 `false` 合同和上一轮
  实际 API 中断验收共同覆盖，后续若引入组件测试框架可补 UI 级网络失败自动化。

自动验证：

- `npm run test:annotation-comparison-navigation`：8/8 通过。
- `npm run test:annotation-diff-timeline`：10/10 通过。
- `npm run test:annotation-diff`：10/10 通过。
- `npm run test:resource-comparison`：2/2 通过。
- `npm run test:recovery-preview`：3/3 通过。
- `npm run test:resource-columns`：7/7 通过。
- `npm run test:permissions`：5/5 通过。
- `npm run test:api`：19/19 通过。
- `npm run build` 与 `git diff --check`：通过。
- 既有 pg 9 前置弃用提示和 Vite 主 chunk 超过 500 kB 提示仍存在；本轮没有新增依赖或相关回归。

核对结论与下一步：

- 未发现导航写入 payload、revision、恢复快照、audit、operation 或编辑历史的路径；read-only 继续由
  服务端 capabilities 与 `useProjectDocumentState({ readOnly })` 决定。
- 下一轮进入 R2.3c 选择性片段整合合同，必须先定义目标文件、引用完整性、冲突决策和单次可撤销提交，
  不能把它简化成整份 JSON 覆盖，也不能与确认标注或实时协作同时实现。

## 2026-08-02：R2.3c1 选择性整合的实体计划与引用依赖核心

本轮先重新审查现有 `App.tsx` 轨道级“导入并整合”实现，确认它按时间/文本匹配、复制并重建 id，且
没有覆盖工尺谱、板眼和稳定实体引用闭包，因此没有把旧实现直接接到结构化比较。按照本机
`CLAUDE_WORK.md`，本轮只建立纯计划/预检核心，没有增加比较 UI 或目标文件写入。

实际实现：

- 新增 `annotationMergePlan.ts`，以左→右/右→左方向、两份已归一化 `ProjectData`、现有结构化 diff
  和稳定 entry keys 生成确定计划。方向依据真实 source/target，不把 diff 的 added/removed 固定绑定
  到某个复制方向。
- 项目实体先集中建立索引，再以拓扑遍历计算最小强引用闭包：字符带所属句，工尺带内建逐字或自定义
  文字块/轨道，板眼标记带区段和关联工尺，自定义块带轨道与递归父块，附属点带定义和自定义父轨。
  选择上游实体不会反向吸入全部下游内容。
- 计划明确区分用户选中与自动依赖，并按目标状态给出 add、replace-conflict、already-equal。冲突本身
  可以进入后续用户决策；未知 key、错误方向导致的来源缺失、坏引用、动作轨工尺、递归父块循环和
  project 领域则形成机器可判定 issue，使计划不可应用。
- 输出按依赖优先、固定领域和 identity 稳定排序；重复/乱序选择得到相同结果，requiredBy 和摘要均
  可直接成为下一轮 UI 的唯一数据源。函数不生成 id、不读时间、不修改输入，也不调用 React、API、
  `commitProject()`、revision、history、operation 或恢复快照。
- 新增 `test:annotation-merge-plan`。11 个测试组覆盖 20 余项场景，包括双向新增、依赖三态、工尺与
  板眼多级闭包、递归父块、自定义/内建附属点、坏引用、非法父轨、循环、未知/不支持 key、方向错误、
  确定性、输入不变和五类摘要统计。本轮没有新增第三方依赖。

自动验证：

- `npm run test:annotation-merge-plan`：11/11 通过。
- `npm run test:annotation-comparison-navigation`：8/8；`test:annotation-diff-timeline`：10/10；
  `test:annotation-diff`：10/10；`test:resource-comparison`：2/2。
- `npm run test:recovery-preview`：3/3；`test:resource-columns`：7/7；`test:permissions`：5/5；
  `test:api`：19/19。
- `npm run build` 和 `git diff --check` 通过；仍只有既有 pg 9 前置弃用提示与 Vite 主 chunk 提醒。
- 本轮是无 UI 的纯领域模块，浏览器验收不适用，没有为了形式打开页面。

核对结论与下一步：

- 未发现第二套项目迁移、diff identity、目标写入或旧轨道 merge 调用路径；新核心与现有导入整合保持
  隔离，后者暂未删除，待实际应用阶段证明可替代后再单独清理。
- 下一轮 R2.3c2 只在比较 Dialog 增加方向、实体多选和计划预览，展示 selected/dependency、三种目标
  动作和结构 issue；仍不修改文件。完成并重新核对后，R2.3c3 才接冲突决策和目标编辑器的一次可撤销
  commit。

## 2026-08-02：R2.3c2 比较端选择与只读整合预检

本轮按 `CLAUDE_WORK.md` 把 c1 纯计划核心接入现有比较 Dialog，只建立方向、多选和预检反馈，没有
增加应用按钮、目标文件写入、revision 更新、恢复快照或编辑器历史提交。

实际实现：

- `annotationDiff.ts` 在一次成功规范化后同时返回 diff 与左右 `ProjectData`。比较展示和计划器共享
  同一次正式迁移结果，不从原始 payload 建立第二套解释路径。
- 新增 `annotationMergeSelection.ts`：集中处理方向可选性、方向切换后的选择裁剪、单项/领域级不可变
  Set 更新，以及 checked/indeterminate 三态。项目设置、未变化实体和来源侧不存在的实体不能显式
  选择；筛选与折叠不参与选择模型。
- 比较 Dialog 把“时间/条目导航选择”和“整合多选”拆成两个状态。点击 Canvas 或差异行只控制
  打开左/右侧文件的焦点；复选框只控制预检。方向切换保留仍合法的双侧修改项并裁剪来源缺失项，
  交换左右文件重建会话并清空旧选择。
- 新增 `AnnotationMergePlanPanel.tsx`：显示左右方向及文件名、用户选择/自动依赖/新增/待决冲突/目标
  已相同计数、结构 issue 和计划项。超过 40 项时先限制 DOM，再按 100 项递增展示；面板持续明确
  标记“只读”和“不会修改、保存或创建新修订”。
- 差异组标题增加领域级复选框和半选状态；差异行拆为独立复选框与导航按钮，避免嵌套交互元素。
  已删除旧整行按钮 CSS 路径，并补充窄屏布局。
- 修复项目迁移中的确定性缺陷：空工尺块 fallback symbol id 改由父块稳定 id 派生。此前把规范化项目
  暴露给计划器后，重复读取同一输入会因随机占位符产生不稳定对象；旧随机 id helper 已删除。
- 新增 `test:annotation-merge-selection`，覆盖双向可选性、未知 key 裁剪、不可变更新、分组批选以及
  checked/indeterminate。本轮没有新增第三方依赖。

浏览器验收：

- 使用平台中两份真实《寻梦》标注验证默认左→右与交换后的右→左方向、文件名和单侧实体禁用原因。
- 领域全选 3 项和 91 项均生成正确计划；91 项预检只首批渲染 40 项并显示剩余 51 项入口。
- 单项取消后领域复选框进入半选；隐藏句级字幕筛选后选择仍保留。点击只存在于右侧的 `line-1` 只
  启用“打开右侧”，且不会加入整合选择。
- 方向切换会裁剪新来源缺失的旧选择；交换左右会清空整合选择。820×900 窄屏下 Dialog
  `clientWidth === scrollWidth`，无横向溢出；浏览器控制台没有 warning/error。
- API 验收日志只有认证、资源、权限和两侧 annotation-file 的 OPTIONS/GET，没有 PATCH、DELETE、
  保存、快照或其他写请求，确认预检只读。

自动验证：

- `test:annotation-merge-selection`：5/5；`test:annotation-merge-plan`：11/11；
  `test:annotation-diff`：10/10；`test:annotation-comparison-navigation`：8/8；
  `test:annotation-diff-timeline`：10/10；`test:resource-comparison`：2/2。
- `test:recovery-preview`：3/3；`test:resource-columns`：7/7；`test:permissions`：5/5；
  `test:api`：19/19。
- `npm run build` 与 `git diff --check` 通过。仍只有既有 pg 9 前置弃用提示和 Vite 主 chunk 提醒。

核对结论与下一步：

- 未发现 UI 重算依赖、随机迁移、嵌套按钮、目标写入或旧选择泄漏；计划器仍是唯一引用闭包来源。
- 下一轮 R2.3c3 必须先补冲突决策与纯应用模型，再在应用前重新读取目标 revision/权限并重新预检，
  最终只向目标单文件编辑器交付一次可撤销 `commitProject()`；本轮不提前实现。

## 2026-08-02：R2.3c3 冲突决策、陈旧计划保护与单次可撤销应用

本轮按 `CLAUDE_WORK.md` 完成普通标注文件选择性整合闭环。比较 Dialog 仍不写文件；它只收集明确
冲突决策并发起最新状态复核，实际变更必须在现有目标单文件编辑器中由用户第二次确认。

实际实现：

- `annotationMergeConflict.ts` 集中管理 `take-source` / `keep-target` 显式决策、计划变化后的陈旧决策
  裁剪、未决冲突和准备可用状态，并以方向、选择、计划项和 issue 生成确定语义指纹。
- `AnnotationMergePlanPanel` 把冲突与普通计划项分离展示；自动依赖中的冲突同样必须逐项决定。按钮
  文案明确为“准备整合草稿”，结构 issue、空选择或未决冲突均阻断下一步。
- `annotationMergeApply.ts` 在目标克隆上按拓扑计划全量应用或整体失败：新增轨道/附属轨时先建立空
  定义容器，只写入明确计划中的块和点；替换定义保留目标未选集合。应用后统一排序并校验重复 id、
  逐字所属句、工尺父块和符号、板眼引用、递归父块/分叉归属、附属轨及活动轨道顺序。
- `annotationMergePreparation.ts` 在进入编辑器前重新读取两侧文件，核对文件 id、revision、来源
  `read`、目标 `write`、重复 identity，并重新规范化、diff、选择裁剪、计划和语义指纹。任何变化
  都要求返回比较页重新检查，不沿用陈旧 payload。
- `annotationMergeDraft.ts` 定义仅存在于运行时会话的 base/merged 项目和摘要；草稿不写入项目 JSON、
  localStorage、operation、audit 或 URL。
- `PlatformWorkspace` 抽取普通打开与草稿打开共用的编辑器会话入口。`App.tsx` 显示紧凑确认条；取消
  不产生历史，确认前验证当前项目仍等于 draft base，确认后只调用一次 `commitProject(...,
  "merge-project")`。此步骤不调用服务器保存，后续普通保存继续使用 `baseRevision` 和既有 409 保护。
- 自审阶段移除了自定义块写入的 `as never` 类型绕行，并把附属点 identity 从冒号反解析改成按真实
  实体构造完整 key 精确匹配，避免合法 id 字符造成隐含约束；同时补齐附属轨定义和工尺符号引用校验。
- 本轮没有新增第三方依赖。

浏览器验收：

- 使用平台中两份真实《寻梦》文件选择 3 条句级字幕，从比较页成功准备并进入目标编辑器；确认条
  显示来源、目标、新增/替换/保留目标摘要，1280 px 视口无横向溢出。
- 首次验收发现浏览器中裸调用 `crypto.randomUUID` 会触发 `Illegal invocation`。改为绑定宿主对象调用，
  并增加默认 id 路径专项测试后重试成功。
- 点击“应用到当前文档”后确认条消失，编辑菜单出现一个可用“撤销”，而“重做”仍禁用，符合单次
  历史提交。自动点击撤销时浏览器控制在超长时间轴 DOM 上超时，因此本轮只将“单次撤销入口可用”
  记为实际通过，不把自动撤销后的内容比对夸大为已通过。
- 比较和草稿应用阶段均未调用服务器保存；数据库 revision 与恢复快照仍由用户后续普通保存决定。

自动验证：

- `test:annotation-merge-conflict`：1/1；`test:annotation-merge-apply`：4/4；
  `test:annotation-merge-preparation`：4/4。
- 既有 `test:annotation-merge-plan`、`test:annotation-merge-selection`、`test:annotation-diff`、
  `test:annotation-diff-timeline`、`test:annotation-comparison-navigation` 和 `test:resource-comparison`
  均在实现阶段通过。
- `npm run build` 与 `git diff --check` 通过；仍只有既有 Vite 主 chunk 体积提醒。本轮没有改 API schema
  或数据库迁移。

核对结论与下一步：

- 未发现第二条目标文件写入、自动保存、整份 JSON 覆盖、随机 id、快照发布化或绕过项目 history 的
  路径；比较选择、计划、准备、纯应用和编辑器确认职责分离。
- 下一轮 R2.4 把所选恢复快照与当前文件送入同一结构化 diff UI。快照保持只读，详情继续按需读取，
  不进入选择性整合，也不改变现有安全恢复命令。

## 2026-08-02：R2.4 恢复快照与当前文件的只读结构化比较

本轮按本机 `CLAUDE_WORK.md` 先审计普通文件比较、恢复详情和当前文件打开路径，再实现恢复快照比较。
目标不是复制一套比较页面，而是把已经稳定的结构化差异审阅抽成共享只读能力，同时维持恢复历史与
普通文件选择性整合之间的严格边界。

实际实现：

- 新增 `AnnotationDiffReview.tsx`，集中承载差异摘要、重复标识警告、研究领域/变化类型筛选、高 DPI
  Canvas 时间概览、Canvas 与条目双向定位、领域折叠以及单侧打开动作。组件只理解结构化 diff 和
  导航，不理解文件读取、恢复、选择性整合或持久化；普通比较可通过 group/entry 插槽组合整合复选框。
- `AnnotationComparisonDialog.tsx` 改为复用共享只读审阅层，仍由普通文件包装层负责左右交换、整合
  方向、多选、依赖计划、冲突决策和草稿准备。删除原组件内重复的筛选、时间索引、条目列表、图标、
  时间格式化与 DOM 定位实现，净减少数百行重复展示逻辑，没有保留旧备用路径。
- 新增纯函数 `recoverySnapshotComparison.ts`，固定快照为左侧、当前文件为右侧，并直接调用既有
  `buildAnnotationDiff()`。两侧继续共用 `normalizeImportedProjectFile()`、稳定实体 id、重复 id 警告和
  迁移错误隔离，不生成第二种历史格式，也没有网络或恢复 mutation。
- 新增 `RecoverySnapshotComparisonDialog.tsx`。头部明确展示快照 revision/创建者/创建时间和当前
  revision/编辑者/保存时间；主体复用共享差异审阅。快照侧没有打开、交换或整合命令，只有当前文件
  可以按所选条目的真实右侧时间范围进入现有单文件编辑器。
- `ResourceRecoveryHistory.tsx` 在可成功预览的快照详情底部增加“与当前文件比较”。每次点击都通过
  annotation-file API 重新读取服务器当前 payload、revision 和权限相关资源信息，不把 Inspector 中
  可能过期的 revision 或本地编辑器未保存内容当作服务器事实；请求使用 generation 隔离，资源切换、
  恢复成功或关闭比较都会使旧响应失效。
- 比较弹窗作为快照详情上方的独立 Radix 层。关闭比较会返回原快照详情，恢复按钮与二次确认仍然
  存在；当前文件读取或迁移失败只在比较层显示局部错误，不折叠恢复历史，也不把坏 payload 当空项目。
- `ResourceExplorer.tsx` 只向恢复历史传递现有 `onOpenAnnotationFile`，因此当前文件定位继续走平台唯一
  打开路径，重新读取最新文件并沿用真实 capabilities；没有复制第二套编辑器会话或 UI 鉴权。
- 新增 `test:recovery-comparison`，覆盖固定左右方向、当前新增实体、相同 payload、快照/当前/双侧迁移
  错误、重复 identity 警告和输入不可变。本轮没有新增依赖、API、Prisma schema 或 migration。

真实浏览器验收：

- 使用平台中的“示例项目：昆曲《寻梦》”及 `《寻梦》示例标注.json`（当前 r3、两个恢复快照）打开
  r2 快照详情，确认只有可预览快照启用“与当前文件比较”。
- 比较结果固定显示左侧 r2 快照和右侧 r3 当前文件，得到 2 项新增、0 项删除/修改和 5 项未变化；
  时间概览、筛选、领域折叠和条目定位正常，页面没有出现“选择性整合预检”或任何快照编辑入口。
- 选择当前侧新增句后，“打开当前文件并定位”正确启用；关闭比较后，底层快照详情仍保持打开，恢复
  按钮和当前 revision 提示均未丢失，证明嵌套 Dialog 没有破坏恢复上下文。
- 另外重新选择两份真实《寻梦》普通标注文件打开原比较页，确认领域/条目整合复选框、方向和预检
  仍存在，证明共享只读层抽取没有把普通文件的 R2.3c 能力带入快照，也没有使其回归。

自动验证：

- `test:recovery-comparison`：4/4；`test:recovery-preview`：3/3；`test:annotation-diff`：10/10；
  `test:annotation-diff-timeline`：10/10；`test:annotation-comparison-navigation`：8/8；
  `test:resource-comparison`：2/2。
- `test:annotation-merge-plan`：11/11；`test:annotation-merge-selection`：5/5；
  `test:annotation-merge-conflict`：1/1；`test:annotation-merge-apply`：4/4；
  `test:annotation-merge-preparation`：4/4。
- `test:resource-columns`：7/7；`test:permissions`：5/5；`test:api`：19/19。
- `npm run build` 与 `git diff --check` 通过。仍只有既有 pg 9 前置弃用提示和 Vite 主 chunk 超过
  500 kB 提醒；本轮没有引入新的构建或运行警告。

核对结论与下一步：

- 未发现第二套项目迁移、第二套差异算法、快照修改、快照整合、自动恢复、服务器保存或编辑器 history
  写入路径。普通文件整合语义只存在于包装层，`AnnotationDiffReview` 保持纯只读组合边界。
- R2.4 已形成快照“查看摘要、与当前比较、安全恢复”三种明确且互不替代的操作。下一轮进入 R2.5a，
  先定义“已确认标注范围”的数据、权限、时间/轨道边界和审计合同，不直接把它塞进 ProjectData、ACL
  或恢复快照，也不在合同未稳定前同时开发完整数据库和 UI。

## 2026-08-02：R2.5a 已确认标注范围的共享合同与纯领域核心

本轮先审计 Prisma 的 AnnotationFile、RecoverySnapshot、ResourcePermission、AuditLog 与平台角色，
以及 ProjectData 的句级、逐字、工尺谱、板眼、自定义轨道和附属点结构。审计确认现有 `reviewer` 只是
全局角色标签，无法表达“只允许审核某一个文件”，而 `write` 与 `manage_permissions` 分别代表修改内容
和分配权限，也不应被误用为研究审核授权。因此本轮只稳定合同和纯规则，没有提前制造 shared/schema
不一致的半迁移状态。

实际合同与实现：

- `packages/shared/src/platform.ts` 新增八个稳定确认领域、互斥的 all/domains/tracks 目标、半开时间范围、
  确认草稿、带撤销判别联合的确认记录，以及 active/revoked、current/stale 状态类型。
- 时间语义固定为 `[startTime, endTime)`，要求有限、非负且 `endTime > startTime`。相邻范围首尾相接不
  算重叠；零时长点事件暂不冒充整段确认，未来若需要实体级审核将另设显式合同。
- domains 按共享领域顺序去重，tracks trim、去重并确定排序。轨道字符串规范化不猜测项目结构；
  `validateAnnotationConfirmationTracks()` 要求调用方提供当前项目真实持久轨道 id 集合，因此 branch-lane、
  Gongche 附属轨和 attached point 可视轨只有在被错误传入时才会被明确拒绝，不依赖脆弱前缀推断。
- `validateAnnotationConfirmationDraft()` 集中校验文件 id、正整数 revision、时间/目标与 2,000 字备注，
  空白备注统一为 null。非法领域或空目标产生结构化 issue，不会静默退化为 all。
- `getAnnotationConfirmationLifecycle()` 要求撤销账号和合法撤销时间成组出现；只有撤销原因、非法日期或
  半截字段均拒绝。原确认事实不会被覆盖或删除。
- `getAnnotationConfirmationFreshness()` 只按服务器 revision 保守判断：相同为 current，向前保存后为
  stale；revision 倒退或非法值是数据错误。本轮不假装通过局部 fingerprint 让旧确认跨 revision 生效。
- `annotationConfirmationScopesOverlap()` 先判断半开时间相交，再处理 all 或同维度 domain/track 交集；
  domains 与 tracks 跨维度不猜测映射关系。
- `canCreateAnnotationConfirmation()` 要求 read + 独立 review；撤销还要求本人记录或管理员/owner。
  决策输入刻意不包含 write/manage_permissions，防止未来 API 把普通编辑、权限管理或全局 reviewer 角色
  当作逐资源审核授权。
- 新增 `test:annotation-confirmations`，本轮没有修改 Prisma、migration、API、ResourceCapability 或 UI，
  也没有新增第三方依赖。

自审修复：

- 第一次严格构建发现一个未使用类型 import，直接删除而未使用 lint/TypeScript 禁用绕行。
- 初版生命周期只检查撤销时间与账号是否同时存在；自审进一步发现“只有撤销原因”和非法日期仍可能
  形成半截审计事实，随后补齐拒绝规则和测试。
- 轨道校验没有使用 `gongche:` / `branch-lane:` 等前缀作为唯一事实，因为自定义 id 和附属点 id 的
  命名不属于可靠持久合同；改为显式传入真实保存轨道集合。

自动验证：

- `test:annotation-confirmations`：9/9，覆盖三种作用域、确定规范化、输入不变、坏时间/目标/领域/轨道、
  草稿字段、生命周期、freshness、半开重叠与审核权限矩阵。
- `test:permissions`：5/5；`test:api`：19/19。
- `npm run build` 与 `git diff --check` 通过。仍只有既有 pg 9 前置弃用提示和 Vite 主 chunk 超过 500 kB
  提醒；本轮没有 UI，因此浏览器验收不适用，也没有为了形式打开页面。

核对结论与下一步：

- 未发现确认事实进入 ProjectData、annotation payload、恢复快照、operation log 或 UI 状态的路径；纯
  模块没有 Prisma、React、网络、副作用、随机 id、any 或类型断言绕行。
- R2.5b 将一次性把 `review` 加入 Prisma/shared ACL，增加确认表、迁移、列表/创建/撤销 API、AuditAction
  与集成测试。必须复用本轮纯校验，创建时锁定并核对当前 annotation revision，撤销只追加撤销事实，
  不修改 payload、revision 或恢复快照；在这条服务端闭环完成前不提前制作前端假数据界面。

## 2026-08-02：R2.5b 已确认标注范围的数据库、ACL 与 API 闭环

本轮按 `CLAUDE_WORK.md` 的 R2.5b 任务单继续推进，没有提前制作确认范围 UI。开始时复核了 R2.5a
共享合同、资源 ACL 合并规则、标注保存/快照恢复的锁顺序、AuditLog 事务边界和资源复制行为；实现后
再针对权限、revision、轨道、撤销、复制、回收站和并发逐项自审。代码由 Codex 直接实现并审查，未
委托 Claude Code 或其他代理，也没有引入新依赖。

数据库与共享合同：

- Prisma `ResourceCapability` 增加独立 `review`，`AuditAction` 增加确认创建/撤销；新增确认目标模式、
  八个研究领域枚举与 `AnnotationConfirmation` 表。表保存文件、被审核 revision、半开时间范围、互斥
  all/domains/tracks 目标、备注、创建者和追加式撤销事实，不保存 freshness、payload、diff 或 UI 状态。
- 新 migration `20260802030000_annotation_confirmations` 只追加 enum 和表/索引/FK/CHECK，没有修改
  baseline。时间、目标互斥、正 revision 与撤销字段成组均有数据库第二层约束；迁移已分别部署到隔离
  `api_test` schema 和本地开发 `public` schema。
- shared API 增加列表、创建、撤销合同；浏览器客户端补齐三个真实请求方法。资源 Inspector 继续复用
  `RESOURCE_CAPABILITIES` 生成权限矩阵，只新增“审核”中文标签，没有另造 UI 权限枚举。

服务端行为与安全边界：

- `ResourceService` 的确认列表只要求活动文件 `read`，最多返回 200 条治理元数据和当前 revision，绝不
  读取/返回 payload。创建与撤销要求同一资源上的 `read + review`；普通 write、manage_permissions 和
  全局 reviewer 角色均不能替代逐资源授权。
- 创建复用 R2.5a 草稿校验，并按现有内容写入顺序取得资源树 shared advisory lock、资源行锁和
  annotation 行共享锁；在锁内复核活动状态、权限和 revision。tracks 模式只接受锁内当前 payload 的
  `character-track` 与顶层 custom track id，派生工尺/分叉/附属点可视轨及不可识别旧结构保守返回 400。
- 撤销锁定文件与确认行，记录 `revokedBy/revokedAt/reason` 而不删除原事实；创建者可撤销自己记录，
  全局管理员、当前资源 owner 或祖先 owner 可撤销他人记录。重复撤销幂等返回首次结果，不覆盖原因，
  也不重复写审计。
- 创建/撤销 AuditLog 与业务记录在同一事务，detail 仅保存确认 id、revision、时间和目标模式等定位摘要，
  不含 note 或 payload。普通保存推进 revision 后旧确认原样保留，由客户端纯 helper 派生 stale。
- 标注文件复制继续只复制当前 payload 形成 revision 1 独立文件，不复制确认、恢复快照、operation、ACL
  或审计。回收站文件/隐藏后代不能列出、创建或撤销确认，恢复后历史事实仍保留。

自审与修复：

- 首次分层构建发现 Prisma/shared 领域之间缺少显式双向映射，补成穷尽 `Record`，以后任一侧新增领域
  都会由 TypeScript 强制提示同步；同时把重复 Prisma include 收敛到共享常量。
- 权限测试原先写死“完整能力数量为 8”，加入 review 后失败。改为比较 admin/owner 的完整能力集合并
  明确断言包含 review，移除随能力扩展必然过期的数字断言。
- 集成测试验证普通 write 无法创建确认，随后给同一账号 read+review 且无 write 后可以创建；另一个
  reviewer 无法撤销创建者记录，而管理员可以。跨文件 id、重复撤销、过期 revision、派生轨、坏范围、
  审计泄漏、复制和回收站均有数据库断言。
- 新增保存与确认并发测试：保存必定把 revision 1 推到 2；确认只能在先取得锁时合法绑定 revision 1，
  或在保存先完成后得到 409，不可能写入与真实审核时刻不一致的 revision。

验证结果：

- `test:permissions`：5/5；`test:annotation-confirmations`：10/10。
- `test:api`：21/21，其中平台主集成套件新增确认生命周期和保存并发两组真实 PostgreSQL 用例。
- `npm run db:deploy` 成功应用开发库迁移；`npm run build` 与 `git diff --check` 通过。
- 浏览器在真实平台开发库中打开“示例项目：昆曲《寻梦》”权限 Inspector，展开学生账号后确认“审核”
  与查看、编辑等能力并列显示且可由现有矩阵管理；页面控制台无 error/warn。本轮没有提交权限变更。
- 仍只有既有 pg 9 `client.query()` 前置弃用提示和 Vite 主 chunk 超过 500 kB 提醒，没有新增运行警告。

核对结论与下一步：

- 未发现确认事实进入 ProjectData、编辑器 history、payload、恢复快照或 operation log；没有第二套
  scope/freshness/权限算法，也没有确认复制或物理删除路径。服务端是唯一权限与 revision 真相。
- R2.5b 已闭环。下一轮 R2.5c 在标注文件 Inspector 与时间轴中消费这些真实 API：先展示 current/stale、
  active/revoked 范围，再提供受 review 控制的创建/撤销；不得先写 mock UI，也不得把状态回写项目 JSON。

## 2026-08-02：R2.5c 已确认标注范围的 Inspector 与时间轴审核交互

本轮先依据实际代码和 R2.5b 服务端合同重写被忽略的 `CLAUDE_WORK.md`，再实现平台编辑器中的真实审核
工作流。工作由 Codex 直接完成、浏览器验收和自审，没有委托 Claude Code、GLM 或其他代理。实现没有
新增第三方依赖：现有 React、Radix AlertDialog、Lucide、共享合同与 document-model helper 已足够，
继续引入组件库反而会扩大视觉和状态边界。

模块与状态边界：

- 新增 `annotationConfirmationView.ts` 作为唯一纯视图模型：集中维护八类研究领域中文标签、真实持久
  轨道选项、历史目标摘要、current/stale 与 active/revoked 安全派生、创建阻断原因、撤销入口可见性和
  半开区间分层。未知历史轨道仍显示原 id；异常历史保守标为 stale/revoked 并展示校验原因，不静默丢弃。
- 新增 `useAnnotationConfirmations.ts` 管理一份打开文件的 list/create/revoke。创建和撤销均以服务端响应
  为事实，成功后重新 list，不做乐观拼接；命令成功而刷新失败会得到独立提示。请求、资源和 mutation
  generation 共同防止文件切换时旧响应覆盖新列表、旧错误污染新面板或旧 finally 清掉新命令 pending。
- 新增 `AnnotationConfirmationPanel.tsx`，作为平台治理区与原内容 Inspector 纵向组合。面板可折叠并
  独立滚动，支持有效/全部历史、all/domains/tracks 目标、备注、刷新、时间轴显隐、精确导航和 Radix
  二次确认撤销。轨道选项仅来自 `character-track` 与顶层 custom track；轨道被删除后会裁剪旧表单选择。
- `App.tsx` 只负责组合平台会话、确认 hook、文档 dirty/revision、循环范围和时间轴焦点。创建范围复用
  现有 loop range，但不会打开循环或修改范围；未设置范围、文件有未保存修改、列表加载、缺少 review
  或服务器 revision 与编辑器保存 revision 不一致时均明确阻断。保存成功后非阻塞刷新确认列表，使旧
  revision 事实立即呈现 stale；刷新失败不会反转已经成功的文件保存。
- 平台会话新增当前账号、角色、review 能力和撤销他人确认的 owner 权威。自审发现服务端允许祖先容器
  owner 撤销，而初版前端只识别文件/直接父级 owner；随后补为沿祖先链保守查询。查询失败只隐藏入口，
  不授予能力，API 仍在事务内做最终鉴权。

时间轴精确行为：

- `Timeline` 只接收最小的扁平只读范围，不依赖平台 API DTO 或权限模型。在 loop lane 与 top deck 之间
  增加可隐藏确认栏；重叠范围用稳定区间着色分层，半开区间首尾相接复用同层。
- chip 左边界严格为 `getCanvasX(startTime, zoom)`，宽度为 `(endTime-startTime)*zoom`，仅以 4px 下限保证
  极短范围可点击。点击直接使用记录原始时间 seek/focus，不从 DOM 像素反算，也不进入吸附、拖拽、
  框选、块历史或项目文档状态。
- 原先散落的 46px 固定顶部偏移收敛为 CSS 变量；top deck、板眼全局纵线和 loop overlay 共同加入可选
  确认栏高度，避免插入治理栏后纵向遮挡。平台面板关闭时间轴显示时栏高归零；本地编辑器从不渲染栏。

测试、自审和真实验收：

- 新增 `test:annotation-confirmation-view`，5/5 覆盖持久轨道过滤、领域/未知轨道摘要、半开区间布局、
  创建阻断优先级和创建者/owner/admin 撤销入口。既有 `test:annotation-confirmations` 10/10、
  `test:permissions` 5/5、`test:api` 21/21 均通过；`npm run build` 与 `git diff --check` 通过。
- 在真实平台管理员会话打开“示例项目：昆曲《寻梦》”的现有标注文件。无范围时创建被正确阻断；在
  时间轴拖出 `5.050-9.050` 秒循环范围后创建成功，面板显示一条 current 记录，时间轴出现一条范围。
  在 20px/s 下实测 chip 左边界为 265px（164px 轨道头 + 5.05×20），宽度为 80px（4×20），确认栏与
  top deck 间距为 0；点击后媒体时间精确跳到 5.050 秒，没有改变循环范围。
- 通过撤销对话框填写“R2.5c 浏览器验收”并成功撤销。有效列表和时间轴随权威刷新清空，“全部”保留
  撤销者、时间和原因。显隐开关可移除/恢复整条确认栏；进入“不登录的本地标注工具”后确认面板与
  时间轴栏数量均为 0。浏览器控制台无 error/warn。
- 上述浏览器验收在本地开发数据库留下了一条已撤销确认记录，撤销原因即“R2.5c 浏览器验收”；它是
  可追溯的开发验收数据，不属于 seed 或产品示例合同。浏览器自动化未能可靠触发 React 原生 range 的
  缩放 change，因此没有声称完成交互式多倍率验收；坐标公式随 `zoom` 重算，并已在实际 20px/s 和构建
  中核对。既有 Vite 大 chunk 提示和 pg 9 前置弃用提示仍在，本轮没有新增运行警告。

完成结论与后续边界：

- R2.5c 已形成“服务端事实、平台治理面板、精确只读时间轴栏”的端到端闭环。没有确认状态进入
  `ProjectData`、导出 JSON、undo/redo、operation log 或恢复快照，也没有修改现有吸附和块编辑代码。
- 本轮不做实体级确认、评论/签名、跨 revision 指纹续期、确认范围拖动、课堂作业或实时协作。R2 到此
  完成恢复、比较、选择性整合与研究审核主链；下一轮转入 R3a，先稳定大规模资源查询的分页、排序、
  搜索合同和 PostgreSQL 索引，再考虑前端虚拟列表，避免在不稳定 API 上先重写三种资源视图。

## 2026-08-02：R3a 资源查询稳定分页与 list/grid 增量加载

本轮在 commit `8669d1f` 后先审计 shared API、Fastify route、`ResourceService`、Prisma schema、三种资源
视图和移动目标选择器，并整体重写 ignored 的 `CLAUDE_WORK.md`。审计发现 cursor/limit 虽已存在，但
服务端仍一次读取全部候选、逐条串行检查删除祖先和 ACL、在 Node 内存排序后 slice；裸 id cursor 在
排序相等或跨查询复用时也没有稳定语义。因此本轮删除旧内存分页，而不是在其外面再包一层 UI。

服务端查询与合同：

- 新增 `resourcePagination.ts`。查询先规范化 view、parent、trim 后搜索、type、sort 和 direction；limit
  刻意不进入查询指纹，允许翻页时调整页大小。cursor 是 base64url 的版本化 JSON，只保存最后返回 id
  和 sha256 查询指纹，不暴露搜索词，也不携带权限。坏格式、未知版本、上下文不一致及 cursor 行已移出
  当前候选集合均返回 400，不再静默回第一页。
- Prisma 排序改为请求字段加同方向 id tie-break，形成稳定总序；删除原 `Intl.Collator`、Node 全集 sort、
  `findIndex(cursor)` 和 slice 路径。名称排序现在以 PostgreSQL 实际 collation 为准，不再出现浏览器/服务端
  两套排序事实。
- `listResources()` 每次只取 50-200 条候选。每批以最多 12 个 worker 有界并发检查已删除祖先和权威
  effective read ACL，按数据库顺序收集到 `limit+1` 个可见资源或候选耗尽；额外一项只用于判断是否有
  下一页，不返回隐藏数量或总候选数。每页仍重新算权限，cursor 从不成为授权凭据。
- shared `ResourceListPage.nextCursor` 从 optional 收敛为明确 `string|null`；browser client 只透传 token，
  不解析或构造 cursor。没有引入新依赖。

前端增量边界：

- 新增 `resourcePageState.ts`，下一页按服务器顺序追加、按 id 去重、保留路径并更新 nextCursor。
- `ResourceExplorer` 的 list/grid 共用首次替换和下一页追加请求。目录、虚拟 view、搜索、排序或方向改变
  时立即增加 request generation，连 180ms 搜索防抖窗口中的旧响应也不能写回；下一页失败保留已有项
  和 cursor，允许重试。只有首次替换裁剪选择，未加载页不会被误判为已删除。
- 有下一页时内容区底部显示克制的“加载更多”；加载期间不清空现有资源。Finder column 和移动目标
  选择器本轮仍只消费首批 200 条，没有用 `listAllPages()` 伪装扩展能力；其逐列分页与虚拟化明确留给
  R3b。

数据库索引与一次失败验证：

- migration `20260802040000_resource_query_indexes` 增加目录 name/id、updatedAt/id 复合索引及
  user/lastOpenedAt 索引，Prisma schema 同步声明。索引使用 `IF NOT EXISTS`，便于本地失败迁移按 Prisma
  正式 resolve 流程恢复，但没有修改 baseline 或 force reset。
- 初版曾尝试在 migration 中 `CREATE EXTENSION pg_trgm` 并创建 GIN trigram 名称索引。隔离 `api_test`
  schema 首次成功，却把数据库级扩展安装进测试 schema；随后 public 部署先因找不到 operator class、再
  因扩展函数所有权无法移动而失败。这证明应用 migration 不能安全管理数据库级扩展。Codex 没有手工
  标记成功或忽略错误，而是用 `prisma migrate resolve --rolled-back` 恢复失败记录，删除自动扩展/GIN
  逻辑，仅部署可移植 B-tree 索引；测试遗留扩展和临时索引随后清理。最终 migration 在 public 成功，
  并在全新临时 schema 从 baseline 到最新完整部署后删除临时 schema。`pg_trgm` 改为未来运维预置能力。

测试与浏览器验收：

- `test:resource-pagination` 5/5：cursor 往返、坏 token/版本/六类上下文漂移、limit 可变、稳定 orderBy、
  scan 上下界和有限并发保序。
- `test:resource-page-state` 2/2；`test:resource-columns` 7/7；`test:permissions` 5/5。
- `test:api` 27/27。新增真实 PostgreSQL 用例创建 7 个相同 updatedAt 资源，以 3 条分页验证 id desc 总序
  无重无漏；验证跨排序 cursor 为 400，并混入截断继承的不可读子项，确认 limit=2 的页面仍填满且不
  泄漏隐藏项。既有资源、复制、移动、快照、确认和回收站测试全部通过。
- `npm run build` 与 `git diff --check` 通过；仍只有既有 Vite 大 chunk 和 pg 9 前置弃用提示。
- 浏览器在开发库临时插入 205 个顶层验收项目：list 首批出现“加载更多”，点击后 R3a 项目从 199 条
  增至完整 205 条且按钮消失；搜索精确名称只剩 1 条且无下一页；清空搜索切换 grid 后重新出现首批
  199 条和加载入口。临时 205 条资源随后全部删除并刷新确认无错误，未留下产品数据。

自审结论与后续：

- 没有 offset pagination、totalCount、全页预取、UI 权限替代、第二套 sort 或旧裸 cursor 僵尸路径。
  candidate ACL 仍是逐资源查询，但已由全集串行变为有限批次/有界并发；后续应先测量再批量化。
- R3a 完成 API 与 list/grid 的增量基线。R3b 将为每个 Finder column 建立独立 cursor 状态，并评估成熟
  headless 虚拟化依赖，覆盖 list/grid/column 1000+ DOM、选择、键盘、右键和 Pragmatic DnD，不改变
  资源查询和 ACL 合同。

## 2026-08-02：R3b Finder 逐列分页、三视图虚拟化与目标目录增量读取

本轮在 commit `53b122d` 后先审计 `ResourceExplorer`、Finder 列模型、移动目标选择器和现有 CSS，随后
整体重写被忽略的 `CLAUDE_WORK.md`。审计确认 R3a 的主 list/grid 已能追加页面，但会把全部已加载资源
挂载为 DOM；Finder 每列和移动目标选择器仍固定读取 200 条。实现由 Codex 直接完成、测试、浏览器验收
和自审，没有委托 Claude Code、GLM 或其他代理。

依赖判断：

- 引入 `@tanstack/react-virtual` 3.14.9（MIT，headless，TypeScript）。它只替代滚动可视区测量、
  overscan 和虚拟行定位，不接管现有样式、权限、选择、菜单或拖拽。list/grid/column 继续渲染唯一的
  `ResourceItem`，因此 Radix Context Menu 与 Pragmatic DnD 没有出现第二套注册路径。
- 未引入完整 table/grid UI 框架，也没有把虚拟列表变成 eager 全页预取。依赖与 lockfile 同步提交；
  Vite 主 chunk 从本轮构建看仍约 762 kB，既有大 chunk 提醒未消失，但没有新增运行错误。

分页与路径状态：

- 新增 `resourceColumnPageState.ts`，把 Finder 单列的首屏替换、后续页去重追加、cursor 更新和追加失败
  保留建成纯函数。`useResourceColumns()` 现在为每列保存 `nextCursor/loading/loadingMore/error/
  loadMoreError`，并以整组路径 request generation 和 cursor 复核阻止旧响应串列。
- 路径完整性判定新增“列尚未穷尽”边界：上游列有 nextCursor 时，首批找不到打开者不能证明容器已
  移动或删除；只有列耗尽且无读取错误才允许截断路径。搜索仍只作用于最右列，祖先列保持未过滤。
- `ResourceColumnBrowser` 每列独立虚拟 34px 行，接近末端自动请求该列下一页，并保留显式加载/错误
  重试入口。选中项通过数据索引调用 virtualizer 定位，不再查询可能尚未挂载的 DOM。
- 浏览器验收中还发现同一 root view 的深层 column 点击“所有项目”后，由于 rootView 值未变化，旧列
  路径不会自动重置；随后切回 list 会把旧 parentId 写回。现已在根导航命令中显式清空 Finder 路径，
  并复核 column → root → list 不再落回旧目录。

虚拟渲染与目标选择器：

- 新增 `ResourceVirtualCollection.tsx`。list 使用固定 38px 行并保留五列表头；grid 根据容器宽度计算
  列数后按整行虚拟化；两者接近已加载末端时预取下一页，并保留键盘可达的“加载更多”命令。
- 旧 `ResourceExplorer.tsx` 内 list/grid 直接 `map()`、重复 item props 和 SortButton 已删除。选择数组、
  Shift/Command 范围、全选、Inspector 和拖拽 payload 仍按浏览器中已加载的完整资源集合计算，不受
  虚拟项卸载影响，也不声称选中尚未请求的服务器页面。
- 资源浏览器原本依靠条件 error banner 决定 CSS grid 子项位置；无错误时内容可能落入 auto 行。新增
  固定零高反馈行，使三种内容视图稳定占据可伸展轨道。自审又发现初版把 list 表头和数据横向滚动
  拆开会导致窄窗口列错位，最终收敛回同一滚动容器和 sticky 表头。
- 新增 `resourceDestinationPaging.ts`。移动目标选择器每次最多跨过四个纯文件页面，发现 project/folder
  即停止；若预算耗尽则保留 cursor 和“加载更多位置”，不会一次读取目录全集。后续页失败保留当前
  路径、已加载目标和 cursor，可直接重试。

测试、自审与浏览器验收：

- `test:resource-column-pages` 4/4，覆盖列追加去重、失败保留、目标选择器跨纯文件页和有限扫描预算；
  `test:resource-columns` 8/8，新增未穷尽列不截断路径；`test:resource-page-state` 2/2。
- `test:permissions` 5/5；`test:api` 27/27；`npm run build` 与 `git diff --check` 通过。仍只有既有 pg 9
  前置弃用提示和 Vite 主 chunk 超过 500 kB 提醒。
- 浏览器在开发库临时插入 1000 个顶层项目。list 首屏只挂载 26 个资源节点，连续分页到第 1000 项后
  只挂载约 31 个；grid 约 36 个；Finder column 约 35 个，并实际到达第 600 项后的页面。移动目标
  Dialog 显示后续页入口，点击后可见第 200 项后的目标。
- 验收结束删除全部 1000 条 `R3B 虚拟化验收` 临时资源，数据库复核剩余 0 条。没有把压力数据写入
  seed、migration 或产品示例。浏览器控制器对位于长虚拟 spacer 末端的普通 click 会在自动滚动期间
  超时，但滚动触发的实际分页和 DOM 上限均可观测；没有把该控制器限制冒充产品错误。

完成结论与下一步：

- R3b 已完成 list/grid/column 的增量消费和虚拟 DOM 基线。没有修改服务端 ACL/cursor、数据库 schema、
  标注文件或时间轴，也没有保留旧全量渲染备用路径。
- 下一轮 R3c 进入上传可靠性、容量限制和对象生命周期。必须先审计 multipart 临时文件、对象落盘与
  PostgreSQL 元数据之间的失败窗口，再设计配额、校验、补偿和孤儿清理；不能直接用前端 accept 当
  安全校验，也不能在尚无生命周期规则时实现永久删除。

## 2026-08-02：R3c 单命令媒体上传、容量锁与对象生命周期审计

本轮按固定流水线先审计实际代码和 R3 路线图，再整体重写被忽略的 `CLAUDE_WORK.md`，随后由 Codex
直接实现、测试、自审和修复。没有委托 Claude Code、GLM 或其他代理。用户特别要求保留详细
Development Log，因此本条同时记录计划与实现差异、失败测试和浏览器工具边界。

审计与架构决策：

- 原流程由 `POST /files/upload` 创建裸 `FileObject`，浏览器再调用 `POST /media-files` 创建资源。第二步
  重名、权限、网络或进程失败都会留下数据库和磁盘孤儿。新流程删除这两个写入口及 shared/client
  合同，改为 `POST /media-files/upload?parentId&name` 单一命令；资源管理器只调用一次。
- 文件系统和 PostgreSQL 无法真正共事务。新 `MediaUploadService` 先验证目标目录和 `create_child`，
  再把流写到同目录唯一暂存对象，同时计算 size、SHA-256 和 8192 字节签名头；验证后以 rename 发布
  final 对象，最后在数据库事务中创建 FileObject、ResourceEntry、MediaFile 和 audit。事务前失败删除
  暂存，发布后事务失败删除 final。进程若恰在 publish 与 transaction 间退出，只会留下可审计磁盘
  orphan，不会留下指向缺失文件的已提交资源。
- 自审发现数据库提交后原实现还会做一次 DTO 权限映射；若映射异常被外层当作提交失败，可能删除已经
  被 DB 引用的二进制。实现因此改成 commit 先返回 resource id，上传服务标记 `databaseCommitted` 后
  再映射 DTO；提交后的展示异常不再触发文件补偿。
- 容量按唯一 FileObject 计算，因此普通媒体复制复用对象且不重复计费。事务以固定“平台 quota lock、
  用户 quota lock、父目录 namespace lock”顺序拿 advisory lock，再顺序查询平台/账号容量，防止两个
  并发上传同时依据旧使用量越过配额。默认单文件 1 GiB、用户 20 GiB、平台 200 GiB、孤儿宽限 24h，
  均可通过环境变量配置；单文件上限硬性低于 2,000,000,000，等待未来 FileObject/MediaFile/API DTO
  同步迁移 BigInt 后再支持更大资产。

媒体验证与依赖：

- 引入 `file-type` 22.0.1，MIT，包体约 136 kB，Node >=22。它只负责从二进制签名识别媒体类型，替代
  不可信的浏览器 MIME 声明；没有引入 UI 框架。根 package 明确 Node >=22，package 与 lockfile 同步。
- `uploadPolicy.ts` 集中维护 MP4/M4A/MOV/WebM/MKV/AVI/MP3/WAV/FLAC/OGG/Opus/AAC 等签名、MIME 和
  扩展别名。前端 `accept` 只保留为文件选择便利。空文件、文本伪装和扩展/签名冲突均在发布前拒绝。
- 集成测试第一次暴露 `@fastify/multipart` 在当前消费方式下会把 65 字节输入截成 64 字节并设置
  `file.truncated`，但不会自动抛出预期异常；若不检查，会继续进入配额判断并错误返回 409。上传服务
  现于签名检测和发布前显式检查该标志，稳定返回 `413 upload_too_large` 并删除暂存文件。
- `LocalObjectStorage` 改用 `path.relative` 校验根目录边界，避免旧字符串 `startsWith(rootDir)` 对相似
  前缀目录判断失真；目录审计不跟随符号链接，只返回相对 storage key。

生命周期与 migration：

- 新 `ObjectLifecycleService` 提供管理员 GET dry-run 和显式 `{confirm:true}` cleanup。它区分过期暂存、
  磁盘无 DB 对象、DB 无 MediaFile 引用和 DB 引用但二进制缺失；只有超过宽限期的前三类确定孤儿可按
  规则清理，`missing_binary` 永远只报告。无引用 FileObject 删除前再次以关系条件复核。
- audit enum 新增 `media_upload` 与 `storage_orphan_cleanup`，由 migration
  `20260802050000_media_upload_lifecycle_audit` 部署。migration 已成功应用到 public、隔离 api_test，并在
  全新 `r3c_migration_test` schema 从 baseline 连续部署六条 migration 后删除临时 schema。

测试与验收：

- 新 `test:uploads` 4/4：配置边界、名称/签名、暂存发布、超限半文件清理和路径越界。
- `test:api` 32/32：真实最小 MP4 签名的一步上传、旧入口 404、受保护 Range、无权限写入前拒绝、空/
  伪装/错扩展、multipart 超限、配额事务补偿、两个并发上传只允许一个提交，以及孤儿 dry-run/cleanup
  不误删 fresh staged 和 missing-binary 元数据。递归媒体复制测试改用真实 MP4，并继续证明两个媒体
  资源复用一个 FileObject。
- `test:permissions` 5/5；`npm run build` 与 `git diff --check` 通过。仍只有既有 Vite 主 chunk 超过
  500 kB 提醒和集成测试中的 pg 9 前置弃用提示。
- 开发 API 已在应用 public migration 后重启，资源管理器可登录、进入项目，上传入口按目录状态启用，
  页面没有新增错误。当前浏览器控制器不提供 `setInputFiles`，其页面沙箱也没有可构造的 DataTransfer，
  因而不能自动完成原生文件选择；没有改用不受支持的 DOM 伪造来声称浏览器上传成功。运行中 API 的
  真实 multipart 链路由上述集成矩阵覆盖，前端合同由 web build 验证。

完成结论与后续：

- 旧裸上传 repository 方法、route、shared DTO 和 client 调用均已删除，没有双路径僵尸代码。对象清理
  是管理员运维能力，不等同于用户永久删除；用户可见永久删除仍需完整引用/保留策略。
- R3d 应进入结构化运行指标、容量/失败诊断、PostgreSQL 与对象目录一致备份恢复演练，并明确未来
  S3/MinIO 适配接口。大于 2 GB、分片/断点上传和通用研究附件继续留在科研资产中心扩展，不在本轮
  以局部 size 类型修改冒充完成。

## 2026-08-02：R3d1 运行健康、低基数指标与管理员诊断

本轮继续执行“审计实际代码 → 整体重写被忽略的 `CLAUDE_WORK.md` → 实现 → 专项/API/构建 → 浏览器
验收 → 自审修复 → 文档”的固定流水线，由 Codex 直接完成，没有委托 Claude Code、GLM 或其他代理。
用户再次明确要求记录 Development Log，因此本条保留设计边界、测试中间结果、自审发现和开发数据
诊断结果，而不只记录最终文件列表。

审计与阶段拆分：

- 原 `/api/health` 无条件返回 `ok`，即使 PostgreSQL 或对象目录不可用也会误导反向代理；上传、HTTP
  延迟、状态码和对象清理没有结构化指标，R3c 的孤儿 API 也没有容量/任务/一致性聚合界面。
- R3d 被拆为 R3d1 可观测性/管理员诊断和 R3d2 一致备份恢复。原因是 PostgreSQL 与本地对象目录没有
  跨介质快照；在所有写入口尚未受统一维护边界约束时，直接执行 `pg_dump` 与目录复制无法保证两者处于
  同一业务时刻。本轮没有用文档命令假装完成灾备。
- 引入 `prom-client` 15.1.3（Apache-2.0，Node 16/18/20+，当前 unpacked size 约 126 kB）。它替代手写
  Prometheus 文本、直方图和 Node 默认指标实现；没有引入通用 Dashboard 或第二套 UI 框架。package 与
  lockfile 已同步，管理界面继续使用现有 Radix Dialog、Lucide 和资源平台 CSS。

后端实现与安全边界：

- 新 `HealthService` 提供 dependency-free `/api/health/live` 与 PostgreSQL + 对象根目录
  `/api/health/ready`；兼容 `/api/health` 改为 readiness。依赖失败返回 503，并只公开组件状态、安全文案
  和耗时，不回传连接串或绝对路径。对象 readiness 仅检查目录存在、类型和读写权限，不递归扫描资产。
- 新 `ApiObservability` 为每个 `buildApiApp()` 建立独立 Registry，避免测试或多实例重复注册。HTTP 指标
  使用 Fastify route pattern、method 和 status code；404 固定 `unknown`，不把 UUID/query 作为标签。
  上传结果只使用 success、too_large、unsupported_media、validation、quota、forbidden、conflict、
  internal；另记录提交成功字节、暂存/final 补偿失败和清理结果。没有用户、文件名、资源 id、storage key
  或错误文案标签。
- `/metrics` 默认 404，仅配置 `XIQU_METRICS_TOKEN` 后启用，并以恒定时间比较独立 Bearer token。显式
  `buildApiApp({ metricsToken: null })` 会关闭入口，不会被环境变量重新打开；浏览器 session 与监控凭据
  保持分离。
- 新 `SystemDiagnosticsService` 只允许 super_admin/admin，资源级 `manage_permissions` 不会获得系统权限。
  它并行聚合数据库往返、活动/回收资源、类型、唯一 FileObject 容量、当前管理员对象容量、媒体/标注/
  快照、任务状态、磁盘 final/staged 汇总、四类对象一致性问题和最近上传/清理摘要。平台/账号 80%/95%
  容量、missing binary、可清理孤儿、失败任务和显著排队由服务端生成稳定告警 code。
- 诊断容量继续按唯一 FileObject 计算，媒体复制不会重复计费。普通诊断只返回一致性计数，不返回完整
  storage key；具体孤儿列表仍留在受控生命周期 API。对象清理仍需 `{confirm:true}`，missing binary
  永远只报告。

前端实现与浏览器验收：

- 资源工作区顶部为全局管理员增加“系统诊断”图标；普通账号不渲染入口。新 Dialog 使用独立滚动区域，
  以紧凑分区显示服务状态、平台/当前账号容量、数据与任务摘要、对象一致性、告警和最近运维事件；没有
  改造成传统后台统计卡页面，也没有挤占右侧资源 Inspector。
- “清理合格孤儿”仅在可清理数大于零时启用，浏览器二次确认后调用既有 cleanup，再刷新全量诊断。
  加载、刷新、错误、空运维事件和成功通知均有状态。
- 实际浏览器以管理员登录后成功打开面板：PostgreSQL 与对象目录均正常、容量进度和各统计可见，长内容
  由 Dialog 内部滚动；退出后以 student 登录，DOM 中无系统诊断入口。没有对开发数据执行清理。
- 这次诊断真实暴露当前开发 public 数据存在 6 个超过宽限期的磁盘孤儿和 2 个缺失二进制。由于缺失
  二进制需判断恢复来源，孤儿清理也属于显式管理员决策，本轮只记录结果，没有擅自删除开发资产。

测试、自审与计划差异：

- 新 `test:observability` 4/4，覆盖 Registry 隔离、规范化 route 标签、token 比较、业务指标以及“存储
  故障降低 readiness 但不影响 liveness”。`test:uploads` 4/4、`test:permissions` 5/5。
- API 集成增至 36/36：验证 live/ready/兼容 health、metrics 缺失/正确 token、显式关闭 metrics、普通
  用户 diagnostics 403、管理员容量和健康摘要；既有资源、ACL、恢复、确认、上传、Range 和孤儿清理
  回归全部通过。`npm run build` 与 `git diff --check` 通过；仍只有既有 pg 9 前置弃用提示和 Vite 主 chunk
  超过 500 kB 提醒。
- 第一次 API 运行在 TypeScript 编译阶段发现测试把未知 JSON 深层字段直接访问，修正为明确 JsonObject
  边界后重跑通过，并未以 `any` 绕过。
- 自审发现初版在 `commitUploadedMedia()` 已提交后仍等待 DTO 映射成功才记录上传 success；若映射失败，
  同一次已提交上传会被错误记成 internal failure。最终把成功字节计数移动到数据库提交边界，并让提交后
  展示失败仅由 HTTP 500 指标表达，不重复记录上传失败。自审还明确了 `metricsToken: null` 的关闭语义，
  增加 dependency failure 回归，并补齐新增 helper 的中文功能注释。

完成边界与下一步：

- R3d1 已让系统具备可部署探针、受保护指标和管理员故障定位入口，但尚未连接外部 Prometheus/Grafana
  或告警通知；这属于部署配置，不在浏览器内伪造。
- 下一轮 R3d2 必须先建立覆盖所有数据库/对象写入的维护静默边界，再实现带 manifest/checksum 的数据库
  与对象目录一致备份、隔离恢复演练和回滚说明。不得只提供两个并行复制命令后宣称灾备完成。

## 2026-08-02：R3d2a 全局维护模式与跨实例写入静默边界

本轮按既定流水线从 R3d1 commit `4d82ca3` 开始：先审计实际 mutation、数据库连接装配与路线图，整体
重写被忽略的 `CLAUDE_WORK.md`，再实现、专项/API/全前端测试、全新 schema migration、浏览器验收和
自审修复。由 Codex 直接完成，没有委托 Claude Code、GLM 或其他代理。用户特别要求维护详细
Development Log，因此这里同时记录计划外发现、失败的浏览器交互和最终恢复状态。

阶段拆分与锁协议：

- R3d2 被明确拆为 R3d2a 写入静默边界和 R3d2b 备份/恢复。原因是 PostgreSQL 与本地对象目录没有共同
  快照；如果备份时仍有上传、标注保存、登录 session 或资源树事务提交，分别复制数据库和目录不能形成
  可证明的一致恢复点。本轮没有先写两个 shell copy 命令后宣称灾备完成。
- 新增单行 `PlatformRuntimeState`，持久保存维护状态、原因、开始时间、操作者 id 和更新时间；migration
  同时增加 maintenance enable/disable audit action，默认关闭。状态不依赖 Node 内存，因此 API 重启和
  多实例观察同一事实。
- 新 `MaintenanceCoordinator` 为所有非 GET/HEAD/OPTIONS HTTP 请求获取 PostgreSQL shared advisory
  permit，并持有到 response 或 request abort。管理员开启维护时获取同 key exclusive lock，先等待所有
  在途写请求排空，再在 Prisma transaction 中写 runtime state 与 audit。独占锁释放后，新 mutation
  虽可取得共享锁，但会在同一数据库 session 读取 active 并立即返回 `503 maintenance_mode`。
- 只有 `POST /api/admin/maintenance` 绕过普通 gate，handler 仍要求 global admin；否则进入维护后没有
  恢复通道。重复设置同一状态不重复写 audit。unlock 失败会销毁连接而不是把可能仍持锁的 session 放回
  池；业务与解锁同时失败时用 `AggregateError` 保留两条原因，请求正常响应和中断共用幂等释放 helper。

连接池与只读边界自审：

- 初步设计曾考虑复用 PrismaPg 的 pg Pool。审计发现请求级 shared permit 会持续到响应结束：足够多并发
  写请求可能占满该 Pool，随后每个 handler 又等待 Prisma 取得同池连接，形成自锁。最终
  `createPrismaConnection()` 显式返回第二个、同数据库与 search_path 的 `maintenancePool`；生产 server、
  API factory 和测试负责同时注入/关闭。没有保留共池备用路径。
- 第一次专项/API 测试通过后，自审发现 `GET /annotation-files/:id` 会 upsert `lastOpenedAt`。这意味着维护
  期间虽然 GET 被放行，数据库仍在写，破坏静默承诺。最终删除 GET 副作用，新增受 gate 保护的
  `POST /resources/:id/opened`；平台成功进入编辑器后 fire-and-forget 记录最近打开，维护期失败只写
  console warning，不阻止只读打开。集成测试直接核对 GET 后 `ResourceUserState` 仍为 0、维护中 POST
  为 503、解除后 POST 204 且记录为 1。
- 未来独立 worker、备份 CLI 或其他进程写入不会自动经过 HTTP hook，必须复用同一 advisory 协议。本轮
  尚无真实 worker；R3d2b 必须提供不依赖浏览器 session 的受控 CLI 维护恢复路径，避免 session 过期后
  平台长期停留在持久维护状态。

API、前端与交互：

- shared 合同新增 maintenance status/request 和错误码；诊断响应复用 coordinator，不建立第二套状态查询。
  管理员 GET/POST 可读写维护状态，普通用户 403；维护中普通 mutation（包括 login）统一返回 503，健康、
  metrics、诊断、资源与标注文件读取继续可用。原因必填/长度约束同时由 coordinator 维护，便于未来 CLI
  复用；普通 503 不包含维护原因，避免向匿名 mutation 泄漏运维细节。
- 系统诊断首区显示“正常写入/维护中”、原因、时间和操作者。初版按计划使用 `window.prompt/confirm`；实际
  内嵌浏览器验收会自动取消原生 prompt，而且该交互脱离诊断上下文。最终改成面板内受控确认区：进入
  维护必须填写最多 240 字原因，风险说明、字符计数、取消和最终确认都可见；恢复写入也有明确确认区。
  没有引入新的 UI 依赖，沿用既有 Radix Dialog 与低饱和桌面样式。

测试、迁移与浏览器验收：

- 新 `test:maintenance` 1/1：两个 coordinator 共用数据库状态，持有 shared permit 时 enable Promise
  不完成；幂等 release 后才完成；active 跨 coordinator 生效，新 permit 返回 503，普通用户读取状态
  403，disable 后恢复，enable/disable audit 各一条。
- API 全套增至 38/38，覆盖管理员/学生切换权限、维护中资源/标注 GET、GET 无用户状态副作用、普通
  resource mutation、recent-open mutation 和 login 拒绝、diagnostics 状态、专用恢复与恢复后 mutation。
  既有认证、分页、ACL、复制、移动、恢复、确认、上传、Range、孤儿清理全部回归通过。
- 其余前端/纯函数测试全部通过：permissions 5/5、annotation confirmations 10/10、confirmation view
  5/5、resource pagination 5/5、page state 2/2、column pages 4/4、columns 8/8、uploads 4/4、observability
  4/4、recovery preview 3/3、comparison 4/4、diff/timeline/navigation 10/10/8/8，以及全部 merge 和 resource
  comparison 测试。`npm run build` 与 `git diff --check` 通过；仍只有既有 Vite 主 chunk 提醒和 pg 9
  前置弃用提示。
- migration 已应用 public 与 api_test，并在全新 `r3d2a_fresh_test` schema 从 baseline 连续部署全部 7 条
  migration、核对默认 maintenance=false 后删除临时 schema。公共数据库最终状态再次查询为 false。
- API 以最新代码重启。浏览器管理员诊断页先显示正常；通过真实管理 API 进入维护后刷新可见原因和操作
  者，匿名 mutation 实测返回 `HTTP 503 / maintenance_mode`。改成面板内确认区后，又从 UI 完成一次
  “原因输入 → 进入维护 → 状态显示 → 恢复写入”，最终页面为“正常写入”、数据库为 false。没有清理
  R3d1 发现的 6 个磁盘孤儿或处理 2 个 missing binary，也没有创建验收项目。

完成边界与下一步：

- R3d2a 只提供可证明的写入静默点，不包含备份产物。R3d2b 应基于它建立可重复 CLI：开启/校验维护、
  `pg_dump`、对象目录快照、manifest/checksum、失败清理、隔离 PostgreSQL/schema 与临时对象目录恢复、
  自动一致性核验、最终恢复写入及操作手册。不能把 public 数据直接覆盖作为演练。
- R3d2b 还应明确中断恢复和“维护已开启但备份进程崩溃”的处理，且 CLI 自身不能依赖被维护 gate 拒绝的
  login；完成前路线图仍不得声称数据库与对象已经可恢复。

## 2026-08-03：R3d2b 一致备份包、离线校验与隔离恢复演练

本轮从 R3d2a commit `3b81494` 开始，先重新审计数据库连接、维护 coordinator、本地对象存储、测试数据库
和 PostgreSQL 客户端环境，再重写被忽略的 `CLAUDE_WORK.md`。由 Codex 直接实现、测试和自审，没有委托
Claude Code、GLM 或其他代理。用户再次强调 Development Log 必须详细，因此这里保留真实失败过程，
而不是只记录最终成功命令。

备份格式与安全边界：

- 新增 `apps/api/src/backup/`，把 manifest 类型/运行时校验、路径隔离、流式 checksum、PostgreSQL 工具、
  维护操作者、备份编排、离线 verify、隔离 restore drill 和 CLI 分开。没有引入新依赖：固定六个命令与
  纯文件/子进程边界使用 Node 标准库更清楚，避免为少量参数引入重型 CLI 框架。
- 备份包固定为 `manifest.json`、PostgreSQL 16 custom-format `database.dump` 和 `objects/<storageKey>`。
  manifest v1 记录无秘密数据库身份、pg_dump 版本、dump/每个对象的 size + SHA-256、数据库资源/FileObject
  摘要、对象聚合、操作者和一致性 warning；运行时拒绝未知版本、坏摘要、重复 key、路径穿越和聚合不符。
- `backup:create` 在路径、工具和 global-admin 操作者预检后才进入既有 maintenance exclusive 边界；dump、
  完整对象根复制、数据库摘要和 verify 都在同一静默窗口。文件与 manifest 显式 fsync，staging 自校验后
  才原子 rename 为 final 并同步父目录。受控失败清理 staging 并默认恢复写入；显式保留维护和 SIGKILL
  仍按 fail-closed 处理。输出/对象目录同时做词法和 realpath 分离，源树 symlink 会中止。
- 原生工具只通过 `spawn(tool, argv)` 调用，数据库用户/密码放在 `PG*` 环境而不进入 argv/日志；支持
  `XIQU_PG_BIN_DIR`、PATH 和 Homebrew 稳定位置发现，不提交本机 Cellar 绝对路径。CLI 参数错误也进入统一
  错误边界，不再打印内部堆栈。
- `maintenance:status|enable|disable` 不依赖 login/token，直接从数据库加载 active global-admin 操作者并
  复用 `MaintenanceCoordinator`，因此浏览器 session 失效后仍有受审计恢复通道。备份命令拒绝接管别人
  已开启的维护窗口。

恢复设计、自审修复与真实失败：

- `backup:restore-drill` 必须先离线 verify，然后拒绝与源同名的数据库、`postgres/template` 系统库、任何
  含用户表的目标数据库、与源/备份重叠或非空的对象目录。对象先写同级 staging 再原子发布；恢复报告
  复核 migration history、runtime state、资源/FileObject 摘要和每个对象内容。
- 第一次真实恢复失败：`pg_restore` 报“one of -d/--dbname and -f/--file must be specified”。审计确认它与
  `pg_dump` 不同，即使已有 `PGDATABASE` 仍要求 `--dbname`；最终只把无秘密数据库名加入 argv，密码仍在
  环境。
- 第二次真实恢复失败：新数据库天然存在 `public`，而按 schema 的 custom dump 包含 `CREATE SCHEMA
  public`。由于恢复前已证明目标数据库没有任何用户表，最终使用
  `--clean --if-exists --single-transaction` 原子重建 schema。没有通过忽略错误或覆盖非空库来绕过。
- 第一次成功后自审发现报告只验证运行状态表存在，没有确认恢复库安全闭锁。最终进一步要求恢复状态为
  `maintenance=true` 并在报告中提示人工确认后显式 disable；同时把对象恢复改为 staging 原子发布、把
  目标“空 schema”提升为“整个数据库没有用户表”、同库保护提升为不受 localhost/127 别名影响的数据库
  名不同，并增加文件/目录 fsync 与父目录 symlink 物理路径检查。

真实演练和故障注入结果：

- 本机 `pg_dump/pg_restore` 为 PostgreSQL 16.14，工具不在 PATH，通过本轮支持的 `XIQU_PG_BIN_DIR` 指向
  未提交本机目录。实际 public 全量备份发布到 ignored `data/backups-r3d2b/`，包含 1 个 dump 和 6 个磁盘
  对象。manifest 如实记录 8 条 warning：2 个数据库 FileObject 缺失磁盘文件、6 个磁盘孤儿（其中包含
  `.DS_Store`）；未执行清理。
- 使用本机未提交运维连接创建 `xiqu_restore_r3d2b_final`，owner 为应用角色 `xiqu`，真实 pg_restore 到
  `public` 并恢复隔离对象目录。最终报告四项全通过：migration history、maintenance=true、database
  summary、object content；源与恢复库均为 34 个资源、2 个 FileObject，源 maintenance=false、恢复库
  maintenance=true，missing=2/orphan=6 状态被完整保留。随后强制关闭连接、删除临时数据库、对象目录和
  报告，未改 public 内容。
- API 已在 4317 运行。CLI 进入维护后 `/api/health/ready` 返回 200，匿名 login mutation 返回
  `HTTP 503 maintenance_mode` 且不泄漏维护原因；CLI disable 后 public 状态为 false。
- 故障注入使用隔离对象根 symlink，让流程在 pg_dump 后、对象复制阶段失败。命令退出 1、错误只报告
  相对 key，输出目录没有 final 或 staging，public maintenance 自动恢复 false；临时目录已清理。

测试与完成边界：

- 新 `test:backup` 7/7，覆盖稳定 manifest/离线 verify、对象篡改、manifest 外额外文件、路径穿越、
  源/输出与恢复目录重叠、同名数据库、PG 密码与安全身份隔离、未知版本拒绝。API 全套增至 45/45，包含既有维护、健康、指标、
  资源、ACL、复制、恢复、确认、上传和对象生命周期回归；`test:maintenance` 1/1、`test:uploads` 4/4、
  `test:observability` 4/4 通过。
- `npm run build`、API TypeScript、`git diff --check` 均通过。仍只有既有 Vite 主 chunk 超过 500 kB 警告和
  pg 9 前置弃用提示。本轮无 schema 变化，因此没有新增 migration。
- R3d2b 完成的是本地对象目录全量一致备份与可证明恢复，不包含定时调度、备份加密、增量链、远端副本、
  S3/MinIO 或生产告警。下一轮应先收敛对象存储接口和部署运维基线，不能让业务 service 或未来备份继续
  依赖本地路径细节。

## 2026-08-03：R3e1 对象存储端口、本地适配器与装配边界

本轮继续执行“审计实际代码与 roadmap → 整体重写被忽略的 `CLAUDE_WORK.md` → 实现 → 专项/API/构建
验证 → 真实运行故障验证 → 自审 → 文档”的逐轮流程。由 Codex 直接完成，没有委托 Claude Code、
DeepSeek、GLM 或其他代理。用户明确要求 Development Log 不只写最终结果，因此这里同时记录迁移范围、
自审修正和因磁盘空间不足未完成的新备份事实。

审计结论与设计边界：

- R3d2b 后，`LocalObjectStorage` 同时承担稳定业务合同和本地实现身份；API 装配、上传、Range 下载、
  readiness、对象生命周期、系统诊断与备份都直接引用 concrete class。测试中的故障替身还需要
  `as unknown as LocalObjectStorage`，说明抽象边界并不真实。`getRootDirectory()` 又让备份算法直接依赖
  本地路径，未来远端适配器只能伪装文件系统或复制业务 service。
- 本轮没有为了“支持远端”引入 AWS SDK，也没有创建一个不能运行的 S3 类。新增稳定 `ObjectStorage`
  端口，覆盖现有业务真实需要的 staged publish、流式读取/Range、存在/删除、readiness 和安全对象摘要；
  后端描述采用 `local | remote` 判别联合。`LocalObjectStorage` 成为该端口的本地适配器。
- 新增唯一生产装配函数 `createObjectStorageFromEnvironment()`。`XIQU_OBJECT_STORAGE_BACKEND` 未配置时
  兼容当前部署并选择 local，显式 `local` 同路径装配；空字符串或任何未知值在启动阶段 fail closed，
  防止本来要写远端的部署悄悄落到本机磁盘。
- API composition root 接受 `ObjectStorage` 注入；上传、下载、健康、清理和诊断服务进一步使用最小
  `Pick<ObjectStorage, ...>` 能力。测试故障替身不再伪装具体类。扫描确认 concrete local 只保留在工厂、
  本地适配器测试、API 集成测试和明确创建隔离本地恢复目标的位置。

备份和恢复边界：

- 本地全量备份不能假装对任意远端后端成立。新增 `requireLocalSnapshotRoot()`，在进入维护模式前根据
  判别描述收窄能力；远端描述即使实现全部普通业务方法，也会明确拒绝本地快照命令，不能伪造
  `rootDirectory` 绕过。
- 备份 CLI 与 API 使用同一个环境工厂，不再分别 `new LocalObjectStorage()`。恢复演练的目标仍明确是
  隔离本地目录，这是当前命令的受控范围；但恢复后对象一致性算法改为对 `getObjectStream()` 计算
  SHA-256，不再拼接本地根路径。`digestFile()` 和对象流复用同一个流式摘要核心。
- 自审时发现 `compareRestoredObjects()` 虽已改为流读取，参数仍写死 concrete local。最终改成只依赖
  `listStoredObjects` 与 `getObjectStream` 的最小端口切片，没有保留半抽象签名或兼容 re-export。

测试、真实运行与限制：

- 新 `test:object-storage` 5/5：本地暂存/原子发布、超限与越界清理、默认/显式 local 工厂、空白/未知
  配置拒绝，以及 typed remote fixture 不能取得本地快照根。`test:backup` 7/7、`test:uploads` 4/4、
  `test:observability` 4/4 全部通过。
- API 全套增至 48/48，既有认证、分页、ACL、移动/复制/回收站、恢复快照、确认、维护模式、媒体上传、
  Range 下载、对象生命周期和备份边界均通过。`npm run build`、API test TypeScript 和
  `git diff --check` 通过；仍只有既有 Vite 主 chunk 超过 500 kB 提醒与 pg 9 前置弃用提示。
- 使用 `XIQU_OBJECT_STORAGE_BACKEND=local` 和 PostgreSQL 16.14 客户端走真实 `backup:create` 工厂路径。
  当前数据卷只余约 1.2 GiB，命令在写入阶段真实返回 `ENOSPC`。失败补偿正确：没有发布 final 或留下
  staging，空输出目录已删除，public maintenance 自动恢复为 false；运行中 API `/api/health/ready`
  返回 200，database/storage 均为 ok。由于用户磁盘空间不足，本轮没有声称创建了一份新的成功备份；
  上轮 R3d2b 的完整成功恢复演练仍是当前灾备基线，且未删除任何正式备份、数据库对象或孤儿资产。

完成边界与下一步：

- R3e1 完成的是可替换对象存储的业务端口、唯一装配边界和本地能力收窄，不是 S3/MinIO 支持本身。
  下一轮应选择并实现一个真实 S3-compatible 适配器，以 MinIO 等兼容服务执行 multipart/Range、暂存发布、
  readiness、列举和删除集成测试；同时单独设计远端一致备份策略，不能继续调用本地目录快照。
- 在进行新的大型真实备份或 MinIO 镜像拉取前，需要先释放磁盘空间或使用容量充足的独立卷。本轮没有
  擅自清理 R3d1/R3d2b 已记录的 missing/orphan，也没有删除用户数据来换取测试空间。

## 2026-08-03：R3e2 S3-compatible 运行适配器与真实协议验证

本轮在 R3e1 commit `d1c32d1` 后继续同一逐轮流程：审计实际端口与 roadmap、整体重写被忽略的
`CLAUDE_WORK.md`、实现、专项/API/build、依赖安全审计、真实协议故障排查、自审和文档。由 Codex
直接完成，没有委托 Claude Code、DeepSeek、GLM 或其他代理。

合同修正与生产适配器：

- 审计发现 R3e1 的 `getObjectStream()` 同步返回 `Readable`，只适合本地 `createReadStream()`；S3
  `GetObject` 必须先等待网络响应。如果用延迟代理流维持同步签名，认证、404 和网络错误可能发生在
  Fastify 已发响应头之后。最终把端口改为 `Promise<Readable>`，local adapter、Range route 和恢复摘要
  一次迁移，不保留同步兼容接口。API 仍直接把解析后的 Node stream 交给 Fastify，不缓冲完整媒体。
- 引入官方 `@aws-sdk/client-s3` / `@aws-sdk/lib-storage` 3.1101.0（Apache-2.0、Node >=20；本仓库要求
  Node >=22）。新 `S3ObjectStorage` 使用流式 Transform 同时执行 maxBytes、SHA-256 和前 8192 字节签名头；
  SDK Upload 使用有限并发 multipart 写临时 key。成功后 CopyObject 生成 final，再删除 staged；失败会
  abort multipart、幂等清理 staged，并让既有上传 service 继续执行数据库/对象补偿。
- 适配器实现闭区间 Range、HeadObject exists、DeleteObject、HeadBucket readiness 和官方 paginator
  ListObjectsV2。数据库只保存逻辑 storageKey；bucket/prefix 映射集中在 adapter 内，拒绝绝对路径、
  反斜杠、空/点/父级/NUL segment。列表严格剥离配置 prefix，不向业务层泄漏 endpoint、bucket 或凭据。
- 工厂新增显式 `s3`。bucket、region、access key、secret 必填；endpoint、path-style 和 prefix 可配置；
  坏 URL、半套凭据、坏布尔或坏 prefix 启动即失败且错误不回显秘密。当前故意不启用宿主默认凭据链，
  避免开发服务器误用机器/云实例身份；IAM role 支持留给生产部署安全审查。
- R3d2b 的本地全量备份边界未放宽：S3 backend 会在进入维护前被 local capability assertion 拒绝。
  运行时 S3 支持不等于远端备份已经完成。

依赖选择与真实协议排查：

- 最初评估 dev-only `s3rver` 3.7.1。它能快速跑通协议，但 npm 官方 audit 显示该包直接处于 high
  风险范围，并携带旧 busboy/dicer/fast-xml-parser；按照 AGENTS 依赖准则立即卸载，lockfile 不保留，
  没有以“仅测试依赖”为由接受已知风险。
- 本机无 Docker且数据卷仅余约 1 GiB，没有拉取 MinIO/LocalStack 大镜像。Homebrew 的 MinIO formula
  已因上游归档而 deprecated；最终安装并使用 SeaweedFS 4.40（Apache-2.0、当前 Homebrew stable，
  bottle 约 40 MB、安装约 135 MB），以临时目录和随机 master/volume/filer/S3/gRPC 端口启动真实 S3
  HTTP 服务。该二进制是本机测试前置条件，不作为 npm 或仓库运行依赖提交。
- 第一次 SeaweedFS 上传返回 `InternalError`。增加受控尾部服务日志后确认不是 S3 adapter/CopySource，
  而是宿主磁盘达到 100%，SeaweedFS 默认 1% 最低空闲阈值把测试卷标为只读。最终仅对临时测试进程设置
  10 MiB volume 上限、最多 5 卷和 0% 测试保留阈值，真实 staged/promote/Range/list/delete 随后通过；
  未修改生产配置，也未删除用户对象或 R3d2b 备份。
- 集成夹具每次使用随机端口、显式测试凭据、临时目录，真实 CreateBucket 作为 readiness polling；启动
  失败和正常结束都会销毁 SDK client、终止/必要时强杀子进程并删除临时目录。测试文件使用
  `.integration.ts`，不混入无 SeaweedFS 的普通 `test:api` 环境；`npm run test:s3-storage` 显式执行。

测试、安全审计与边界：

- `test:s3-storage` 2/2：真实协议验证 staged metadata、promote、完整读取、精确 Range、Head、prefix
  隔离、分页列表、delete、超限无残留、bucket readiness/缺失失败。object factory 增至 6 项，增加 S3
  装配、秘密不泄漏、缺凭据、坏布尔和坏 prefix。
- `test:uploads` 4/4、`test:observability` 4/4、`test:backup` 7/7、API 普通套件 49/49、S3 协议套件 2/2、
  `npm run build` 和 `git diff --check` 通过。本地媒体 Range 与恢复摘要证明 async stream 迁移无回归。
  协议文件使用 `.integration.ts`，普通 API 套件不依赖外部 SeaweedFS 二进制。
- npm 官方 audit 显示新增 AWS SDK 链没有已知 advisory。仓库仍有此前 Prisma/Fastify/Vite 工具链的
  既有 11 项（0 critical、4 high、6 moderate、1 low）；直接项为 Prisma 与 Vite，升级涉及框架大版本，
  不在本轮用 `audit fix --force` 冒险改动。国内 npm 镜像不实现 audit API，审计改用官方 registry。
- R3e2 完成的是可运行、经过真实兼容协议验证的 S3 adapter。尚未完成：真实生产 MinIO/AWS bucket
  smoke、TLS/证书、IAM role、S3 原生备份/恢复、版本化/生命周期策略和远端副本。SeaweedFS 证明本轮
  使用的 API 子集具有兼容性，但不能替代目标生产供应商验收。
- 最新 API 已用本轮代码重启在 4317；`/api/health/ready` 返回 200，PostgreSQL 与默认 local storage 均为
  ok，public maintenance 最终为 false。

## 2026-08-03：R3f1 通用审计日志浏览、筛选与安全导出

本轮继续执行固定的逐轮流水线：先审计实际代码与 roadmap，整体重写本机忽略的 `CLAUDE_WORK.md`，
再实现 shared contract、纯查询模型、服务层、Fastify 路由、管理界面、专项/API 测试和数据库索引；随后
进行浏览器验收、自我代码审查并同步 README、roadmap、AGENTS 与本日志。全部工作由 Codex 直接完成，
没有委托 Claude Code、DeepSeek、GLM 或其他代理。

审计结论与设计边界：

- 现有 `AuditLog` 只提供简单列表，缺少稳定翻页、组合筛选、关系摘要和完整导出；若前端直接导出已
  加载行，会把一个局部页面伪装成完整审计事实。最终把读模型从通用 repository 中抽出为独立
  `AuditLogService`，repository 继续只负责各业务事务中的审计写入，避免把治理查询继续堆进资源仓储。
- 全局日志只允许系统管理员读取。非管理员必须显式指定一个资源，并在服务端通过权威 ACL 解析取得
  该资源的 `manage_permissions`；普通 `read`、前端隐藏按钮或账号角色文字都不能替代这一授权判断。
- 列表排序固定为 `createdAt DESC, id DESC`，同一毫秒内由 id 保证稳定顺序。游标包含版本、时间、id 和
  规范化查询指纹，跨筛选复用、篡改、已不属于当前结果集的游标都会返回 400，不退化为 offset。
- 筛选支持资源、操作者、目标账号、枚举 action 和起止时间。时间必须是带 `Z` 或显式时区偏移的完整
  ISO 日期时间，拒绝无时区字符串与反向区间，避免浏览器、服务器时区不同导致审计边界悄然漂移。

后端合同、查询与导出：

- `packages/shared` 新增唯一 `AUDIT_ACTIONS`、`AuditActionName`、分页响应和操作者/资源/目标账号摘要。
  专项测试把 shared action 列表与 Prisma 运行时 enum 对照，防止数据库新增事件后路由校验或中文标签
  静默遗漏。
- 新 `auditLogQuery.ts` 集中负责输入规范化、query fingerprint、opaque cursor、Prisma where 和 CSV
  序列化。新 `auditLogService.ts` 负责授权、稳定 keyset 分页、关系批量查询和导出上限；账号与资源通过
  批量查询补齐，不为每行制造 N+1。被删除的关联仍显示 id 回退信息，不让旧审计变成空白。
- 新 `/api/audit-logs/export` 复用与列表完全相同的规范化筛选，每批读取 500 条，最多探测 10,001 条以
  判断截断，最终只输出前 10,000 条。响应暴露实际条数和截断标头；CSV 固定中文列、UTF-8 BOM，详细
  对象使用稳定 JSON，并对去除前导空白后以 `= + - @` 开头的单元格加前缀，防止电子表格公式注入。
- Prisma 为全局时间顺序以及 action/resource/actor/target/file 组合查询增加 `(字段, createdAt, id)`
  索引。迁移 `20260803070000_audit_log_query_indexes` 已部署到 public 与隔离 `api_test` schema。

管理员界面与交互：

- 资源工作区顶部新增独立“审计日志”入口，仅全局管理员渲染。Radix Dialog 使用与现有桌面工作区一致
  的低饱和样式，筛选草稿和已应用条件分离；账号目录加载失败不会阻断审计日志本身。
- 首次查询、刷新、应用筛选和“加载更多”均带 request id。旧请求不能覆盖新筛选，也不能在刷新后把
  旧页面追加回来；首屏刷新会清空陈旧行，避免用户误把旧结果当成新查询。表头和数据放在同一滚动
  区域，横向滚动保持列对齐，Dialog 自己处理纵向滚动而不推动整个工作区。
- 导出由浏览器发起认证请求并保存服务端 Blob，界面显示服务端返回的真实条数与截断状态。下载 object
  URL 延迟撤销以兼容 Safari，不保留常驻 URL；前端没有第二套 CSV 生成逻辑。
- 实际浏览器以 `admin` 登录，在 1280×720 视口打开审计窗口：默认加载 50 条，action 筛选
  `auth_login` 后只显示匹配事件；重置后“加载更多”从 50 增至 100，并显示仍有后续；服务端导出当时
  筛选下的 105 条，界面明确提示“已导出105条审计记录”。浏览器控制器不提供动态修改 viewport 的
  方法，因此本轮没有声称完成真实窄屏截图；窄屏 CSS 断点、内部滚动和生产构建已检查。

自审、修复与验证：

- 第一版时间校验用 `toISOString() === input`，会错误拒绝合法 `+08:00`。改为严格完整 ISO 结构加日期
  有效性校验，既保留时区要求，也接受合法偏移。第一版“加载更多”在切换筛选后存在旧请求追加风险，
  最终在请求完成前再次核对 generation，并让首屏请求主动结束旧 loading 状态。
- 第一版把约 200 行审计读/导出逻辑放进 `PrismaPlatformRepository`。自审认为这会混淆资源仓储与治理
  查询职责，遂完整抽出 `AuditLogService`，删除 repository 中的旧读路径，没有保留两套实现或僵尸
  helper。第一版表头与 body 分别横向滚动也会失去同步，最终统一成单一滚动表格区域。
- `npm run test:audit-log` 共 7 项通过，覆盖 ISO/偏移时区、action 同步、cursor round-trip/跨查询拒绝、
  坏 token、CSV 特殊字符、稳定 detail 和公式防护。API 集成套件新增同毫秒日志排序、组合筛选、关联
  摘要、管理员全局读取、资源 manage-permissions 授权、普通学生拒绝、跨筛选游标、CSV 元数据/公式
  防护，以及坏 action/日期/反向区间。
- 最终 `npm run test:audit-log` 7/7、API 全套 55/55、`npm run build` 和 `git diff --check` 通过。
  API 集成套件同时覆盖此前认证、资源树、ACL、移动/复制/回收站、恢复快照、确认范围、维护模式、
  上传/Range 和对象生命周期，没有因审计服务抽取产生回归。构建仍只有既有 Vite 主 chunk 超过
  500 kB 提醒，测试仍有既有 pg 9 前置弃用提示；两者均不是本轮新增失败。
- API 已以抽取后的最新 `AuditLogService` 代码重启在 4317；`/api/health/ready` 返回 200，PostgreSQL
  与默认 local storage 均为 ok，`maintenance:status` 为 false。重载前端并重新登录后，最新服务返回的
  审计窗口仍能加载账号、资源摘要和维护/确认/保存等多种动作，证明浏览器验收没有依赖重启前的旧
  tsx 进程。

完成边界与下一步：

- R3f1 提供的是可治理、可分页、可筛选和可安全导出的通用审计读面，不是外部 SIEM、实时告警或不可
  篡改归档。CSV 仍是有界人工导出；日志保留期限、归档介质、外部告警和生产审计访问策略尚未完成。
- 下一轮应在实际代码与部署约束上重新审计 R3：优先建立可测试的外部告警出口，或设计 S3-native
  一致备份/恢复与目标生产桶 smoke。不能因为运行时已支持 S3，就把本地目录快照命令直接套到远端。

## 2026-08-03：R3f2 外部告警部署基线与可告警平台指标

本轮在 R3f1 commit `c7c40f2` 后继续逐轮流程：审计 roadmap、现有 `ApiObservability`、健康检查、系统
诊断和服务器装配，整体重写本机忽略的 `CLAUDE_WORK.md`，再实现、测试、真实抓取、自审并维护文档。
全部工作由 Codex 直接完成，没有委托 Claude Code、DeepSeek、GLM 或其他代理。

架构审计与取舍：

- 管理员诊断已经会计算稳定 code 的容量、依赖、孤儿和任务告警，但它只在管理员打开 Dialog 时运行，
  不能作为无人值守监控源。现有 `/metrics` 已有规范化 HTTP、上传、清理和 Node 进程指标，却没有依赖
  可用性、平台容量与任务存量，Prometheus 只能知道进程是否可抓取，不能区分 PostgreSQL/S3 故障。
- 没有在每个 API 实例增加 setInterval + webhook。多实例会重复通知，随后还要自建 leader、分组、静默、
  抑制、重试和投递历史，这会重复 Alertmanager 的成熟职责。最终边界是 API 只提供低基数事实指标，
  Prometheus 计算规则，Alertmanager 负责通知生命周期。
- 孤儿/缺失二进制检查需要枚举对象与数据库关系，不适合每 30 秒 scrape。它仍保留在管理员诊断与显式
  清理中；外部规则本轮覆盖轻量 readiness、容量、请求、任务与补偿失败，不把重型审计偷偷放入指标端点。

应用指标实现：

- 新 `OperationalMetricsCollector` 并行执行 `HealthService.getReadiness()`、唯一 FileObject size aggregate
  和 ProcessingJob groupBy，补齐 queued/running/succeeded/failed 四个固定状态。依赖 unavailable 是成功
  采集到的故障事实，分别输出 0；查询异常或超时则由调用方记录 collection-success=0。
- 重叠 `/metrics` 抓取共享一个 in-flight Promise。第一次实现审查时发现若把 timeout 直接包在保存的
  Promise 上，超时会提前清除 in-flight，底层查询尚未结束时下一次抓取可能启动第二份；最终改为保存
  原始采集 Promise，每个调用方单独等待超时，只有底层真实收敛才释放引用。
- `ApiObservability` 新增 dependency、platform used/quota、processing jobs、collection success/timestamp
  Gauge。成功 snapshot 覆盖所有固定类别，任务归零不会残留旧值；采集失败只把 success 设为 0，不将
  上一次真实容量/任务伪造成 0。所有 label 都是固定 dependency/status，没有账号、资源、文件名、路径、
  endpoint、bucket 或错误文本。
- `/metrics` 先完成独立 Bearer 校验，再触发采集。未配置仍 404，坏 token 仍 401；采集失败写结构化
  warning 并继续返回合法 Prometheus exposition。`XIQU_OPERATIONAL_METRICS_TIMEOUT_MS` 默认 5000，
  只接受 1-60000 的整数，坏配置启动即失败。

标准监控配置与依赖：

- 新 `deploy/monitoring/prometheus.yml` 使用 credentials file 读取 token，并加载 `xiqu-alerts.yml`；仓库
  不包含真实 token。规则覆盖 API down、指标采集失败、database/storage unavailable、5xx 比率（同时
  要求 5 分钟至少 20 次请求）、P95 延迟、容量 80/95%、失败/积压任务和上传补偿失败。
- 容量 warning 表达式显式限制 <=95%，与 critical 互斥；Alertmanager 示例仍配置同 alertname 的
  critical 抑制 warning。示例包含分组、等待、重复间隔、resolved 通知和 `.invalid` webhook，占位 URL
  必须由部署私有配置替换。
- 引入仅测试使用的 `yaml` 2.9.0：ISC、Node >=14.6、职责单一且 TypeScript 支持成熟。它真正解析三份
  配置，替代脆弱的手写正则/缩进判断，不进入生产运行 bundle。同步提交 package 与 lockfile。官方 npm
  生产依赖审计为 7 项既有问题（0 critical、2 high、5 moderate），新 YAML 是 dev dependency，未用
  `audit fix --force` 跨 Prisma/Vite 大版本冒险升级。

测试、真实抓取与限制：

- `test:observability` 10/10：覆盖 Registry 隔离、低基数 route、token、上传/清理、readiness、完整
  operational snapshot、失败保留真实 Gauge、重叠/超时复用、环境边界，以及三份 YAML 的结构和必需
  告警。首次跑 API 全套时，测试 Promise executor 内赋值被 TypeScript 收窄成 never；改为明确 definite
  assignment 后通过，没有为测试放宽生产类型。
- API 全套 61/61 通过；集成测试验证有 token 的真实 `/metrics` 包含 database/storage=1、平台配额、
  collection success=1，显式 null 仍关闭端点。`npm run build` 与 `git diff --check` 通过，仍只有既有
  Vite 主 chunk >500 kB 提醒和 pg 9 前置弃用提示。
- 用临时 `XIQU_METRICS_TOKEN=r3f2-local-proof` 启动最新 API：无凭据返回 401；有凭据实际抓到
  database=1、storage=1、used=36、quota=214748364800、四类 jobs=0、collection success=1 和时间戳。
  随后停止临时进程并恢复普通无 token 开发 API；readiness 正常，维护模式未被改变。
- 本机没有 `promtool`，因此没有声称执行官方 PromQL/config 二进制校验；普通测试通过真实 YAML parser
  验证结构，并在部署 README 明确要求目标 Prometheus 版本启动前执行 `promtool check config/rules`。
  本轮也没有安装 Docker/Prometheus/Alertmanager 或向外部 webhook 发送测试通知。

完成边界与下一步：

- R3f2 完成的是标准、可部署、供应商中立的外部告警基线，不是生产监控集群托管。真实网络、TLS、
  secret、receiver、Grafana dashboard 和值班策略属于部署环境配置。
- R3 下一轮应审计并设计 S3-native 一致备份/恢复和目标生产 bucket smoke。运行时 S3 adapter、Prometheus
  告警与本地全量备份都已存在，但三者相加不等于远端灾备已经完成。

## 2026-08-03：R3g1 远端一致备份包发布与流式校验

本轮从已提交的 R3f2 基线开始，先精读 `ObjectStorage`、本地 backup/restore、manifest/verifier、S3
适配器、CLI 和 roadmap，再整体重写被忽略的 `CLAUDE_WORK.md`。全部实现、测试、真实 smoke、自审和
文档维护由 Codex 直接完成，没有委托 Claude Code、DeepSeek、GLM 或其他代理。

架构审计与边界决定：

- 现有本地备份的安全性来自真实目录分离、拒绝 symlink、文件/目录 fsync、staging 离线校验和同文件
  系统原子 rename。S3 没有等价目录 rename，因而没有删除 `requireLocalSnapshotRoot()`，也没有让远端
  descriptor 伪造路径。旧 `backup:create`、`backup:verify` 和本地隔离 restore drill 语义保持不变。
- 远端采用 manifest-last 提交协议：在唯一 backup id 下先流式发布 `database.dump` 和
  `objects/<storageKey>`，最后才 promote `manifest.json`。没有 manifest 的 prefix 一律是不完整产物，
  verifier 不会因发现 payload 而猜测它可恢复。
- 备份目标使用独立 `XIQU_BACKUP_S3_*` 变量组和必填非空 prefix。若线上 source 与 backup target 是同一
  provider，且 location 相同或任一 namespace 包含另一个，命令在进入维护前 fail closed，避免递归把
  备份自身再次纳入源对象列表。secret 不进入 descriptor、manifest、CLI JSON 或文档真实值。
- PostgreSQL custom dump 仍写受控本地临时文件，再以 ReadStream 上传；源对象始终通过
  `ObjectStorage.getObjectStream()` 传输。没有引入 zip/tar 或把整包读入内存，也没有建立第二种 manifest
  版本。远端恢复演练、保留策略、调度与生产 IAM 留给 R3g2，未被包装成“已完成灾备”。

实现内容：

- `backupManifest.ts` 新增唯一 `serializeBackupManifest()` 与 `parseBackupManifestText()`；本地文件读取和
  远端对象读取共享同一 unknown JSON 运行时校验、稳定排序和格式版本边界。`buildConsistencyWarnings()`
  导出复用，远端仍诚实记录数据库 missing、source orphan、大小和 checksum 差异。
- 新 `remoteBackupPaths.ts` 集中生成/校验单段 backup id，并映射 database、objects 和 manifest key；
  相对路径继续复用现有 traversal/反斜杠/绝对路径守卫。
- `objectStorageFactory.ts` 把 S3 环境解析泛化为带变量前缀的单一 helper；线上仍用 `XIQU_S3_*`，新
  `remoteBackupStorageFactory.ts` 使用 `XIQU_BACKUP_S3_*` 并要求 prefix。没有复制两份 endpoint、bucket、
  布尔值和凭据输入校验。
- 新 `remoteBackupService.ts` 负责预检、维护窗口、pg_dump、稳定排序的源对象复制、manifest-last、发布
  后 verifier 和失败补偿。每个 final key 在 promote 前登记；即使 server-side copy 已成功但 staged
  删除失败，外层也会删除 final。自审后又在 `uploadAndPromote()` 内幂等重试 staged 删除，补偿失败用
  `AggregateError` 同时保留原始错误和清理错误。工作目录移到维护成功后创建，维护启用失败不会留下
  空临时目录；普通失败仍恢复写入，显式 keep 语义与本地备份相同。
- 新 `remoteBackupVerifier.ts` 只接受明确 backup id，给 manifest 8 MiB 聚合上限，列举该 id 的精确声明
  集合，并对 dump/每个对象逐项流式复算 size/SHA-256。单个对象错误不会阻断其他诊断；额外 final 或
  `.upload-*` 对象也会作为未声明污染报错。
- CLI 新增 `backup:create-remote` 与不连接数据库的 `backup:verify-remote`，输出只含 backup id、manifest
  key、创建时间、对象数和 warning。`.env.example`、README、AGENTS 和 roadmap 同步了配置、命令、
  manifest commit marker 及未完成边界。

测试基础设施、自审与修复：

- 新内存 `ObjectStorage` 状态机测试真实消费 Readable 并计算 SHA-256，覆盖专用配置、namespace 重叠、
  backup id 穿越、manifest-last、成功 verifier、篡改/额外对象、无 manifest 和“final 已形成后 promote
  报错”清理。`test:backup` 最终 12/12。
- S3 协议测试新增隔离 `platform-source`/`platform-backups` prefix 的远端包发布和校验。最初每个 test
  独立启动/停止 SeaweedFS，默认并发时进程偶尔只完成一两个 case 且无测试汇总；这不是可接受的通过。
  改为文件级单一 SeaweedFS fixture、串行三个场景、统一关闭后，`test:s3-storage` 稳定 3/3，约 9 秒，
  实际覆盖 multipart、server-side copy、list、stream read、prefix 隔离和 verifier。
- 自审发现 promote 可能在 copy 已形成 final 后因 staged 删除失败而抛错。第一版只登记 final 补偿，会
  留 staged；现已在局部重试 staged delete，测试从“无 final”加强为“整个 backup id 下零残留”。
- 自审还发现临时 work directory 原先在维护开启前创建；若 `setMaintenance(true)` 失败会留下空目录。
  已将 mkdtemp 移入维护成功后的 try，并在 finally 聚合临时目录清理错误，没有保留旧路径。

真实命令验收与环境事实：

- 首次用当前完整本地 source 对临时 SeaweedFS 执行 CLI，测试服务 `volume.max=5` 被默认卷占满，130 KiB
  dump 无法取得 bucket collection 卷并返回 S3 500。提高到 50 后 dump 与若干源对象开始上传，但当前
  source 包含大型 MP4，20 MiB 测试卷很快再次耗尽。服务日志确认发布器反向删除了已完成的 dump、
  `.DS_Store`、首个视频及失败 staged；远端 prefix 列表无 final 残留，两次维护状态均恢复 false。
  这两次是测试存储容量失败，不被记录成业务通过，也没有继续复制用户大型资产消耗磁盘。
- 最终使用隔离 `/tmp/xiqu-r3g1-small-source`（一个小 probe 对象）、真实当前 PostgreSQL、PostgreSQL
  16.14 工具和新的 SeaweedFS bucket/prefix 运行 `backup:create-remote`。命令成功生成
  `xiqu-backup-2026-08-03T02-09-18-506Z-4e27251a`，对象数 1；真实数据库中两个 FileObject 不在隔离 source，
  probe 不在数据库，故 manifest 如实输出 2 条 missing 和 1 条 orphan warning。
- 随后对同一 id 执行 `backup:verify-remote`，返回 `valid=true`、errors 为空、createdAt 与创建输出一致；
  `maintenance:status` 为 false。该 smoke 覆盖了真实 CLI 参数解析、operator、维护排空、pg_dump、本地
  source 流、S3 staged/promote、manifest-last 和远端 verifier，但不冒充生产 MinIO/AWS/IAM 验收。
- API 全套最终 68/68，包含旧认证、资源树、ACL、上传/Range、恢复快照、确认范围、维护、审计、指标、
  本地备份与新远端备份测试。`npm run build` 通过 Prisma generation、shared、document-model、web 和
  API；仍只有既有 Vite 主 chunk >500 kB 提醒和 pg 9 前置弃用提示。`git diff --check` 在提交前复核。

完成边界与下一步：

- R3g1 已提供可创建、可校验、失败可补偿的 S3-compatible 远端全量备份包；它不是远端恢复、增量备份、
  加密、跨区域复制、定时调度或长期保留系统。
- R3g2 应先建立远端包读取/物化到隔离恢复工作区的安全合同，再复用现有 PostgreSQL/object 一致性恢复
  检查；同时定义无 manifest/超过宽限期失败包与已提交包的保留清理，最后在目标 MinIO/AWS bucket 和
  经审查的 IAM 权限上做 smoke。生产凭据链未审查前仍保持显式 access key/secret fail closed。

## 2026-08-03：R3g2a 远端备份单次物化与隔离恢复演练

本轮开始时用户确认了“R2.3c2”，但实际仓库的 roadmap 与开发日志表明 R2.3c2 早已完成，当前提交
`45984cf` 已处于 R3g1。没有为了迎合旧编号重做选择性整合 UI，而是先核对分支、最近提交、roadmap、
本地恢复和远端备份代码，再把本机忽略的 `CLAUDE_WORK.md` 整体重写为 R3g2a 当前任务书。任务书明确
文件范围、安全合同、失败补偿、测试矩阵、真实演练顺序和 Development Log 要求；本轮实现、审查、
测试和文档均由 Codex 直接完成，没有委托 Claude Code、DeepSeek、GLM 或其他代理。

架构审计与方案：

- 现有 `runRestoreDrill()` 已经正确处理本地包离线验证、不同名称空数据库、对象目录原子发布、migration
  history、维护状态、数据库摘要和对象内容检查。因此远端恢复没有另写一套 PostgreSQL/object 恢复，
  只新增“远端包安全物化 + 生命周期清理”编排。
- 不能先调用 `verifyRemoteBackup()` 把全部 payload 读一遍，再重新下载一遍恢复。最终合同是：manifest
  读取一次；database dump 和每个对象各打开一次网络流，在落盘时同步计算 size/SHA-256；形成标准本地
  包后，现有本地 verifier 再读本地磁盘。这保留传输校验与落盘复核两层保证，但没有双倍网络流量。
- 本机只剩约 6 GiB，仓库 `data/` 约 4.2 GiB。真实恢复使用一个小型隔离 source，而非复制用户的大型
  MP4；数据库 dump 仍来自真实当前 PostgreSQL，因而恢复检查不是伪造 JSON 或 mock happy path。

实现与代码清理：

- 新 `remoteBackupPackage.ts` 集中 8 MiB manifest 限制、backup id、manifest 解析、payload key 映射和
  精确对象集合检查。`remoteBackupVerifier.ts` 删除原有重复 manifest/key/list helper，继续逐项汇总
  摘要错误；物化器和 verifier 不再维护两套远端包格式知识。
- 新 `remoteBackupMaterializer.ts` 先确认对象集合，再在普通非 symlink 工作根下创建唯一 staging。
  每个远端流经摘要 Transform 直接写 `wx` 文件，路径继续通过 `resolveInsideRoot()`；payload 全部通过后
  才写本地 manifest。任何读取、摘要、路径、中止或写盘错误都会删除完整临时包；清理失败使用
  `AggregateError` 与主错误一起返回。
- 新 `remoteRestoreDrillService.ts` 只把物化结果交给 `runRestoreDrill()`，并在成功或失败出口清理。自审
  发现第一版把“成功后清理失败”也落入通用 catch，可能进行第二次清理；最终拆成失败补偿与成功清理
  两个明确出口，删除含混重试语义。
- `RestoreDrillOptions.sourceStorageRoot` 改为可选：线上 source 为 local 时仍进行真实物理根重叠检查；
  source 为 S3 时不伪造路径，但目标仍必须与物化包互不包含。现有本地 CLI 继续通过
  `requireLocalSnapshotRoot()` 传必填根，没有削弱本地快照能力收窄。
- 最终自审又补上恢复工作根的物理路径隔离：它不能进入线上 local 对象根，也不能包含/位于目标对象
  目录中；检查沿着真实祖先解析 symlink，并在开始远端下载前 fail closed。对象 list 失败则保留已解析
  manifest 并给出独立诊断，verifier 仍可继续检查 payload，不能误报成“缺少 manifest”。
- CLI 新增 `backup:restore-remote-drill`，使用独立 `XIQU_BACKUP_S3_*`，支持 backup id、工作根、隔离
  数据库、对象目录和报告。该分支位于数据库装配前，只读取线上存储 descriptor，不误连业务 Prisma。

专项测试和真实协议：

- 内存 ObjectStorage 增加真实 read 事件和故障点。`test:backup` 最终 19/19，新增证明 manifest、dump、
  对象各只打开一个远端流，本地包可离线复核；同时覆盖中途读取失败零半包、清理 AggregateError，以及
  恢复在同库安全检查失败后仍清除物化目录、工作根与目标目录重叠拒绝。
- `test:s3-storage` 3/3，真实 SeaweedFS HTTP 协议的远端发布用同一个 backup id 物化为标准本地包并通过
  verifier；测试后删除临时包。没有引入新依赖，现有 Node stream/crypto/fs 与 ObjectStorage 端口足够
  清晰，也没有保留另一套 S3 下载实现。
- 第一次真实演练脚本尚未启动就被命令执行器拒绝，因为退出清理使用 `rm -rf`；没有创建数据库、启动
  SeaweedFS 或改变维护状态。改成仅对随机 `/tmp` 根使用 `find -delete` 后重跑。
- 第二次运行到隔离库准备时，应用账号 `xiqu` 因无 `CREATEDB` 权限而失败。没有给应用账号提权；这是
  正确生产边界。最终由本机 PostgreSQL 管理员仅创建/删除、并把隔离库 owner 设为 `xiqu`，实际恢复仍
  使用受限应用账号。
- 最终真实 smoke 使用 SeaweedFS 隔离 bucket/prefix、PostgreSQL 16.14、真实当前数据库 dump、一个
  18-byte 左右测试对象和新库 `xiqu_remote_restore_smoke`。创建得到远端包
  `xiqu-backup-2026-08-03T02-38-56-599Z-7c53f822`；隔离 source 与数据库真实 FileObject 不同，manifest
  如实记录 2 missing + 1 orphan。新 CLI 恢复报告四项全部通过：migration history、maintenance=true、
  database summary、object storage。恢复工作根条目数为 0，恢复对象数 1，源库 maintenance=false。
  退出时删除隔离数据库、报告、对象目录、物化目录和 SeaweedFS 卷；没有保留 smoke 凭据或绝对路径。

完整回归、自审和边界：

- `npm run test:backup` 19/19、`npm run test:s3-storage` 3/3、API 全套 73/73、`npm run build` 和
  `git diff --check` 通过。完整构建覆盖 Prisma generation、shared、document-model、web 和 API；仍只有
  既有 Vite 主 chunk >500 kB 提醒和 pg 9 前置弃用提示。
- 新逻辑块均有中文功能注释；没有引入 `any`、新依赖、第二套 manifest 或第二套恢复器。恢复目标仍须
  不同名称空库、空对象目录和安全报告路径，恢复库仍 fail closed 保持维护状态。
- R3g2a 完成的是明确 backup id 的人工隔离恢复演练，不是生产自动恢复。尚无未完成包/已提交包保留
  清理、调度、增量、加密、跨区域复制或生产 IAM/default credential-chain 验收。下一轮 R3g2b 应先设计
  有宽限期、dry-run、显式确认和 manifest commit-marker 感知的远端清理，再做目标部署桶权限 smoke。

## 2026-08-03：R3g2b1 远端备份保留计划与确认清理

本轮从已提交且工作树干净的 R3g2a commit `881d90c` 开始。先审计现有对象孤儿治理、S3/local
`listStoredObjects()`、manifest-last 发布、远端 key、CLI 参数解析和 roadmap，再整体重写被忽略的
`CLAUDE_WORK.md`。生产 bucket/IAM 依赖真实部署环境，因此本轮进一步拆为 b1 生命周期治理；b2 才做
生产验收，不能把 SeaweedFS 当成 AWS/MinIO 运维验收。全部实现、测试、自审与文档由 Codex 直接完成，
未委托 Claude Code、DeepSeek、GLM 或其他代理。

分类、策略与安全取舍：

- 生命周期只自动识别 `createRemoteBackupId()` 真实生成的 production id。显式 verifier 仍能读取安全的
  历史/测试 id，但自动清理不会因为一个普通顶层目录“长得像备份”就删除它。
- 无 manifest 包分类为 incomplete，以包内最新对象修改时间应用 24 小时默认宽限；任一 fresh staged/
  payload 都会保护整个包。manifest 无法解析、manifest 声明与实际 key/size 不一致、未知顶层对象均只
  报告，不进入自动删除。
- 结构完整包按 manifest `createdAt` 统一排序，默认保留 30 天且至少保护最新 3 个。不能按 S3 list 顺序
  逐个决定。inspect 不重算全部 payload SHA-256，否则轻量 dry-run 会退化成整桶下载；恢复前 verifier
  仍负责完整 hash，生命周期结构检查至少核对 key 与声明 size。
- plan token 是策略、全部识别包分类、对象 key/size/modifiedAt/staged、未知对象和最终 eligible 集合的
  稳定 JSON SHA-256，不含 generatedAt。同状态重复 inspect 稳定；cleanup 重新扫描，任何对象或策略
  变化都在首个 delete 前拒绝，不能使用过期 dry-run。
- 完整包删除严格 manifest-first：先撤销唯一 commit marker，再删除 payload；manifest 删除失败时该包
  payload 零触碰。不同包独立，某包失败不会阻止无关 eligible 包，结果逐包返回 deleted/failed、对象数、
  字节数和安全错误。未完成包没有 commit marker，可逐项幂等重试。

实现与代码清理：

- `remoteBackupPackage.ts` 抽出唯一 manifest 读取与 manifest-to-key helper，verifier、materializer、
  lifecycle 共享格式知识，不为每个包重复 list bucket。`remoteBackupPaths.ts` 新增 production id 判定，
  没有削弱显式 backup id 的路径安全守卫。
- 新 `remoteBackupRetentionPolicy.ts` 统一环境和 CLI 覆盖：grace 1 分钟至 30 天、retention 1 至 3650 天、
  minimum retained 1 至 1000；只接受十进制安全整数，坏配置扫描前 fail closed。
- 新 `RemoteBackupLifecycleService` 一次列举并分组，逐 manifest 分类，再统一应用保留策略和 token。对象
  字节汇总显式拒绝超过 JavaScript 安全整数；删除结果不读取/返回正文或 SDK 对象。
- CLI 新增 `backup:inspect-remote` 与 `backup:cleanup-remote`。cleanup 必须同时提供当前 plan token 和
  `--confirm`；部分失败先输出结构化逐包结果，再以非零状态提醒运维。旧 parser 中只特殊识别
  `keep-maintenance-on-failure` 的硬编码已删除，所有布尔 flag 由命令白名单统一解析。

测试、自审与真实 CLI：

- 新生命周期内存测试覆盖 complete/incomplete/fresh incomplete/invalid/inconsistent/unrecognized、
  retention + minimum newest、token 稳定与漂移、缺 confirm、manifest-first、manifest 删除失败不碰
  payload、独立包部分成功和策略边界。首次专项为 24/25，失败不是业务错误，而是测试错误地要求完整包
  manifest 必须是所有包的全局第一项；独立未完成包先删除是合法的。断言改为同一完整包内 manifest
  相对 dump 在前，随后通过。
- 自审后把结构一致从 key 精确集合加强为 payload key + size，并让安全字节汇总真实检查
  `Number.isSafeInteger`；补充 size mismatch 与一个包失败不阻止另一个包的测试，没有保留旧弱判断。
- 提交前静态审查又发现根级普通对象可能恰好与 production id 同名；分组最终要求真实 `<id>/...` 结构，
  无斜杠同名对象进入 unrecognized 只报告集合，并补入回归测试，避免把普通根对象当未完成包删除。
- SeaweedFS 协议测试新增两个正式包，真实 staged/promote 后计划只选择过期包，确认删除后最新包仍通过
  `verifyRemoteBackup()`，旧 prefix 已消失。
- 真实 CLI smoke 使用临时 SeaweedFS bucket/prefix 和 AWS SDK 写入两个有效最小包：旧包
  `xiqu-backup-2026-01-01T00-00-00-000Z-aaaaaaaa`、新包
  `xiqu-backup-2026-08-03T00-00-00-000Z-bbbbbbbb`。`backup:inspect-remote --retention-days 1
  --minimum-retained 1` 只选旧包（2 对象、681 字节），返回 64 位 token；cleanup 用 token + confirm 删除
  1 包/2 对象，新包 verify valid=true，二次 inspect 只剩新包且 eligible=0。临时服务与卷退出后删除，
  命令全程未连接 PostgreSQL、未改变平台维护状态。

最终验证与下一步：

- 最终 `npm run test:backup` 25/25、`npm run test:s3-storage` 4/4、API 全套 79/79、`npm run build` 与
  `git diff --check` 通过。完整构建覆盖 Prisma generation、shared、document-model、web 和 API；既有
  Vite 主 chunk >500 kB 与 pg 9 前置弃用提醒不冒充本轮失败。新增模块、类型组、函数、循环和删除条件
  均有中文功能注释，没有新依赖或并行清理路径。
- R3g2b1 仍不是生产灾备验收。下一轮 R3g2b2 需要真实目标 MinIO/AWS bucket、TLS/网络路径、最小 IAM
  policy（create/verify/restore/list/delete 所需动作分离）、凭据轮换和默认 credential-chain 决策；若当前
  开发环境没有这类外部资源，应先产出可执行验收工具/文档，不能伪造生产通过。

## 2026-08-03：R3g2b2a 远端对象存储验收工具与最小权限部署契约

本轮从已提交且工作树干净的 R3g2b1 commit `e72289b` 开始。先核对分支、roadmap、`deploy/`、
`S3ObjectStorage` 的全部命令、远端备份 storage factory、CLI 参数白名单和现有 SeaweedFS 协议测试。
审计确认仓库此前只有 monitoring 部署资料，没有对象存储 IAM 模板或目标环境验收命令；roadmap 也把
真实 MinIO/AWS、TLS、网络和权限 smoke 留给 R3g2b2。当前开发环境没有生产 bucket、域名或 IAM 凭据，
因此没有伪造“生产通过”，而是把本轮明确拆成 R3g2b2a 工具/部署契约，真实 R3g2b2 继续保持未完成。
被忽略的 `CLAUDE_WORK.md` 已整体替换为本轮任务书，旧 R3g2b1 日志没有继续留在当前任务文件。本轮由
Codex 直接实施，没有委托 Claude Code、DeepSeek、GLM 或其他代理。

能力探针设计与实现：

- 新 `remoteStorageCapabilityCheck.ts` 只依赖既有 `ObjectStorage`，没有创建第二个 AWS SDK client、环境
  解析器或数据库连接。探针使用随机 `.acceptance/<uuid>/probe.bin`；该根不符合正式 backup-id，因此
  即使异常中断也不会被 lifecycle 错认成已提交备份包。
- 固定小型内容在 staged upload 时验证 final key、size 和 SHA-256；随后分别执行 staged HEAD、完整
  prefix LIST、server-side copy publish、staged 消失/final 存在、完整 GET、闭区间 Range GET、final
  DELETE，以及 HEAD/LIST 无残留检查。读取 helper 对字节数设置严格上限，异常服务不能借探针持续灌流。
- 正常路径删除后仍进入统一补偿阶段，再对 staged/final 两个可能 key 幂等删除。一个删除失败不会阻止
  另一个；业务错误与全部清理错误通过 `AggregateError` 一起报告。成功 JSON 只含固定 format/version、
  起止时间、安全 backend descriptor、8 个能力项和 `passed/cleaned=true`，不含随机 key、正文或凭据。
- 如果 `putStagedObject()` 在返回 staged key 前失败，服务无法也不应猜测适配器内部 UUID；这依赖端口
  的上传失败补偿合同。当前 S3 adapter 已 abort multipart、等待 upload promise 并幂等删除 staged。
- CLI 新增 `backup:check-remote-capabilities`，位于 Prisma 装配前，只使用强制非空 prefix 的
  `XIQU_BACKUP_S3_*` factory。没有接触业务数据库、维护状态、线上 `XIQU_S3_*` 或远端备份保留计划。

最小权限与部署资料：

- 新 `deploy/object-storage/backup-target-policy.json` 把 bucket 级 `ListBucket`/
  `ListBucketMultipartUploads` 限定到部署者替换的备份 prefix，对象 ARN 只覆盖该 prefix；对象动作仅有
  Get/Put/Delete、AbortMultipartUpload 和 ListMultipartUploadParts，没有使用 `s3:*`。
- 权限不是凭印象罗列：`HeadBucket` 与 `ListObjectsV2` 对应 ListBucket；SDK multipart 对应 Put/Abort/
  list parts；`CopyObject` 没有独立 IAM action，而依赖源 GetObject 与目标 PutObject；HEAD/完整与 Range
  GET 对应 GetObject。SSE-KMS 权限留给具体 key 的独立安全评审，不把 KMS 通配塞入通用模板。
- `deploy/object-storage/README.md` 记录运行时/备份命名空间隔离、AWS 与 MinIO path-style 差异、生产 TLS、
  显式凭据现状、模板替换方式、验收命令和生产记录清单。默认凭据链仍刻意关闭；IAM role/Web Identity/
  工作负载身份需要单独设计刷新和失效生命周期，不能在本轮悄悄启用。
- 根 README、`.env.example`、AGENTS 和 roadmap 同步。roadmap 只将 R3g2b2a 标为完成，并明确下一轮要在
  真实目标执行能力检查、真实备份/校验/恢复、生命周期清理，以及人工 TLS/网络/IAM/轮换核对。

测试失败、修复与真实协议验证：

- 首次 `test:backup` 在 TypeScript 阶段失败：测试把 `Error` 直接传给只接受字符串的 `assert.match`。
  改为匹配 `error.message`，业务代码未改。
- 第二次专项运行 27/28：失败测试错误地要求失败路径至少有 3 次公开 `deleteObject` 调用。真实 S3
  promote 内部确实调用 delete，但 `ObjectStorage` 端口只承诺发布语义，不要求替身也从公开方法自调用。
  测试改为精确断言补偿阶段两个 key 的 2 次删除，避免把 adapter 实现细节写进服务合同。
- 最终 `test:backup` 28/28。新增内存测试覆盖完整调用顺序、8 项报告、成功零对象、读取失败后双 key
  补偿，以及业务失败和两个清理失败同时保留；报告序列化中不含测试秘密。
- `test:s3-storage` 5/5。新增真实 SeaweedFS prefix 场景执行整个验收服务，并比较运行前后对象集合完全
  相同；既有 staged/promote/Range/list/delete、超限清理、远端包发布物化与生命周期测试继续通过。
- 第一次真实 npm CLI smoke 尚未进入应用：临时 SeaweedFS `-dir` 子目录未预建，服务启动即报告
  `no such file or directory`；trap 已终止进程并删除临时根，没有创建 bucket 或运行探针。脚本补上
  `mkdir -p` 后重跑。
- 第二次 CLI smoke 使用 8 个随机端口、临时 SeaweedFS 卷、隔离 bucket
  `xiqu-capability-smoke` 和 prefix `platform-backups`。`npm run --silent backup:check-remote-capabilities`
  返回 format/version 1、`passed=true`、`cleaned=true`、8 项检查；随后官方 SDK ListObjectsV2 确认 prefix
  `remainingObjects=0`。临时服务、卷和报告在退出 trap 中删除。本地 endpoint 为 HTTP，只证明命令、
  环境装配和 S3-compatible 协议闭环，不形成生产 TLS/IAM 结论。

自我审查与剩余边界：

- 新文件、类型组、函数、循环、失败补偿和业务条件均有中文功能注释；没有 `any`、新依赖、第二套 S3
  factory 或可序列化秘密。IAM JSON 是带 `${...}` 占位符的有效模板，文档明确要求部署后检查占位符已
  替换，不能原样冒充实际策略。
- 探针正常路径在补偿前已用 HEAD/LIST 验证空根；补偿重复删除利用 S3 幂等性。若删除权限或服务异常，
  命令以非零退出并聚合清理故障，运维必须人工检查 `.acceptance/`，不能继续宣称验收通过。
- R3g2b2 仍受外部环境阻塞：没有真实生产 MinIO/AWS bucket、受信任 TLS、网络路径和 IAM 主体。本轮不
  能验证 bucket versioning/object lock/KMS/跨区域规则，也没有启用默认凭据链。下一轮必须在目标环境
  保存脱敏能力报告，并完成真实 backup create/verify/isolated restore 和 lifecycle dry-run/cleanup。

最终回归与提交前审查：

- `npm run test:backup` 最终 28/28，`npm run test:s3-storage` 5/5，`npm run test:api` 82/82；API 测试真实
  应用 8 个 migration 到隔离 `api_test` schema，既有 pg 9 前置弃用提示没有冒充本轮回归。
- `npm run build` 通过 Prisma generation、shared、document-model、web 和 API；只保留既有 Vite 主 chunk
  大于 500 kB 提醒。`git diff --check` 与 IAM JSON 语法检查通过，未新增依赖或 lockfile 变化。
- 最终全文检索确认命令只有一个 CLI 调度入口、服务只有一个 `ObjectStorage` 编排路径；没有遗留临时
  smoke 文件、SeaweedFS 进程、测试 bucket、旧探针或僵尸逻辑。文档没有把 R3g2b2a 写成生产验收完成。

## 2026-08-03：R4a 标注 operation 服务端幂等接收基础

本轮从 R3g2b2a commit `331b57f` 和干净工作树开始。真实 R3g2b2 仍需要尚未提供的生产 MinIO/AWS、
TLS、网络和 IAM 环境；roadmap 允许可靠性基础持续加强时进入 R4，且 R4 的幂等/离线基础是 R5 实时
协作硬前置。因此先审计 Prisma `AnnotationOperation`、operation GET/POST、完整 revision save、客户端
`useProjectDocumentState()`、`submitPendingOperations()` 和现有 API 集成测试，再把被忽略的
`CLAUDE_WORK.md` 整体替换为 R4a 任务书。本轮由 Codex 直接实施，没有委托 Claude Code、DeepSeek、
GLM 或其他代理。

审计发现的真实漏洞：

- 本地 `ProjectDocumentOperation.id` 已稳定生成，但只被塞进 payload 的 `localOperationId`；共享请求、
  数据库列和唯一索引都不知道它是幂等键。
- 保存顺序是逐条 POST operation 摘要，再 PUT 完整 payload。如果服务端已插入 operation、但响应在网络
  中丢失，客户端 callback 尚未把它标成 submitted，下一次保存会再次插入相同行。
- React `submitted` 状态只减少同一页面内“后续完整保存失败”的重复提交，刷新后完全丢失；它不能替代
  服务端幂等。若简单加 unique 却仍先检查 current revision，完整保存推进 revision 后的迟到安全重放
  又会被错误拒绝。

数据合同、迁移与纯逻辑：

- `CreateAnnotationOperationRequest` 新增必填 `clientOperationId`；record 返回该 id 供客户端确认，但绝不
  返回内部 `requestHash`。客户端 builder 把本地 operation id 放入一等字段，并从摘要 payload 删除重复
  `localOperationId` 和对应旧注释。
- `AnnotationOperation` 新增 `client_operation_id`、`request_hash`，唯一作用域为
  `(annotation_file_id, actor_user_id, client_operation_id)`。不同账号可独立复用同一 client key，不能读取
  或占用彼此幂等空间。
- 第 9 个 migration `20260803080000_annotation_operation_idempotency` 先加 nullable 列，把历史行确定性
  回填为 `legacy:<server-id>` 和 64 位零 hash，再设 NOT NULL/复合 unique；没有修改 baseline 或删除历史。
- 新纯模块验证 1–128 位安全 ASCII client id；稳定 JSON 递归排序对象 key、保留数组顺序，拒绝非有限数、
  非 JSON 实例和循环引用。SHA-256 指纹绑定 base/local revision、action 和 payload；文件/账号由唯一
  作用域绑定。没有为短小纯函数引入依赖。

事务与并发语义：

- POST 仍先复核当前账号 write 权限。事务先按唯一作用域查已有记录：hash 相同直接返回原 operation，
  因此文件 revision 后续推进也不影响已接受请求的迟到重放；hash 不同返回带稳定
  `idempotency_conflict` detail 的 409，不回显 payload/hash。
- 只有新 key 才按原锁顺序 `FOR SHARE` annotation 行、检查文件存在和 `baseRevision === current`。过期
  revision 的新 key 仍 409，不能借幂等 API 绕过乐观锁。
- 首次实现使用 `upsert({ update: {} })`。第一次 API 全套中 migration 成功，但并发相同请求有一个返回
  500：Prisma 的空 update 没有稳定收敛到数据库原子 conflict-update 路径，仍可能先查后插。没有用宽泛
  P2002 catch 掩盖未知唯一冲突；改为对 `clientOperationId` 唯一键自身做无语义 update，促使原子 upsert，
  返回后再次核对 requestHash。第二次并发测试两个请求均 200、id 相同、数据库只有一行。
- 幂等重放不新增审计事实、不改变 status/createdAt、不推进 annotation revision。operation 仍只是未来
  同步与审计地基，不会将摘要应用到 `AnnotationFile.payload`，也没有假装实现自动保存。

测试、失败与验证：

- 客户端 builder 专项 1/1；服务端纯 helper 3/3，覆盖现有 op-UUID、安全字符边界、对象 key 稳定排序、
  数组顺序、循环/NaN 拒绝和全部指纹字段。组合命令最后直接调用 `tsc` 时 zsh 报 command not found，
  原因是编译器只在 npm 本地 PATH；改用 `npm exec -- tsc` 后严格类型检查通过，代码未因此修改。
- 首次 `test:api` 应用第 9 个 migration 成功，85 项中 83 通过、平台总 suite 因并发 upsert 500 计为第二
  个失败；按上述原子 no-op update 修复后重跑 85/85。
- API 场景覆盖：缺/坏 client id、旧 revision 新 key 拒绝、首次/相同重放同 id/count=1、完整保存推进
  revision 后旧请求仍可重放、同 key 异 payload 返回稳定 409、Promise.all 并发同 id，以及临时赋予学生
  write 后相同 client key 生成另一 actor 的独立行。

自我审查与边界：

- 现有 fallback `op-<timestamp>-<random>` 与 UUID id 都符合新字符合同；legacy migration id 不与真实
  `op-*` 冲突。upsert 的无语义 update 不修改 hash、payload、status 或时间。
- 重放仍位于 write 权限检查之后：账号失去权限不能借旧幂等 key读取记录。资源隐藏/回收等访问边界也
  继续由服务端 capability fail closed。
- R4a 没有持久化浏览器 pending payload/base revision，没有自动保存计时、重试退避、页面关闭保护或
  409 比较决策。下一轮应先设计 IndexedDB envelope/version/容量/文件隔离和恢复提示，再接自动调度；
  不能把整份 ProjectData 塞入每条 operation 或直接跳到 WebSocket。

最终回归与开发环境落地：

- `npm run test:platform-operations` 1/1、幂等纯 helper 3/3、`npm run test:api` 85/85、`npm run build`
  全部通过。完整构建覆盖 Prisma generation、shared、document-model、web 和 API；只保留既有 Vite 主
  chunk >500 kB 提醒和 pg 9 前置弃用提示。
- `git diff --check` 通过；全文检索确认旧 `localOperationId` 只剩“断言其不存在”的回归测试，
  `requestHash` 仅存在 Prisma schema/migration/repository 内，没有进入共享 DTO、浏览器或日志。
- `npm run db:deploy` 将第 9 个 migration 成功应用到开发库 public schema，`prisma migrate status` 显示
  9 个 migration 全部最新。为避免旧 API 进程在新 NOT NULL schema 上写入失败，正常终止 PID 10007，
  用当前代码重启为 PID 19329；`/api/health/ready` 返回 ready，database/storage 均为 ok。
- API 当前继续运行在 `http://127.0.0.1:4317`。本轮没有修改前端布局，不需要浏览器视觉验收；真正的
  用户可见离线恢复流程留给后续 R4b。

## 2026-08-03：R4b1 浏览器离线草稿持久化与同 revision 恢复

本轮从 R4a commit `95929ce` 和干净工作树开始。Codex 先审计 `useProjectDocumentState()`、平台唯一文件
打开路径、完整 revision save、operation 提交顺序、比较整合入口和本地/平台 payload 边界，再把被忽略的
`CLAUDE_WORK.md` 整体替换为 R4b1 当前任务书。本轮由 Codex 直接实现，没有调用 Claude Code、GLM、
DeepSeek 或其他代理。目标严格限定为“浏览器崩溃/刷新/返回资源管理器后保住未保存内容，并在同服务器
revision 下显式恢复”，不把 IndexedDB 草稿宣传成服务器自动保存或实时协作。

审计与数据结构决策：

- 原 `ProjectDocumentOperation` 在每次 commit/undo/redo 中各存一份完整 `beforeProject` 和
  `afterProject`，吸附操作也重复两份完整开关表。若直接持久化 pending 队列，项目体积会按操作数成倍
  膨胀。现在 operation 只保留稳定 id、type/action、local/base revision、时间、syncState 和紧凑
  `summary`；完整 current/saved 项目只在草稿 envelope 中各存一次。服务端 operation request 直接消费
  摘要，删除旧 diff helper 和快照字段，没有保留两条并行路径。
- 新建 version 1 `PlatformDraftRecord`，稳定主键为编码后的“账号 id + 标注文件 id”。内容包括
  current/saved ProjectData、current/saved 吸附状态、紧凑 pending operations、本地/已保存 revision、
  服务器基准 revision 和时间戳；不保存 undo/redo、临时拖拽、比较焦点、整合草稿、界面浮层或任何
  每-operation 项目快照。
- IndexedDB 属于不可信 `unknown` 边界。归一化会验证 schema/身份/key、整数 revision、时间戳、operation
  id/类型/摘要一致性、唯一 id 与 revision 范围，再让 current/saved 项目共同经过唯一
  `normalizeImportedProjectFile()` 迁移入口。损坏记录不能进入 document state；普通打开会让用户明确
  确认是否删除坏记录并打开服务器版本，取消则保留记录且不打开，避免既静默丢数据又永久锁死文件。
- 平台 payload 脱水/水合从 `PlatformWorkspace.tsx` 抽到 `platformProjectPayload.ts`。草稿构建先经过
  `getPersistableProjectData()` 和 `prepareProjectForServer()`，因此受保护媒体 URL 中的登录 token、Blob
  URL 与浏览器运行时字段不会写进 IndexedDB；恢复时再按当前会话生成媒体访问 URL。

持久化、恢复与竞态边界：

- 引入 `idb` 8.0.3（ISC）作为生产依赖，封装 versioned IndexedDB 连接、object store 和类型化事务；它
  替代容易写错的原生 request/transaction 回调，没有带入新的 UI 风格。测试引入 `fake-indexeddb`
  6.2.5（Apache-2.0），在 Node 中运行真实 IndexedDB 事务语义。两者维护活跃、TypeScript 类型完整、
  许可证适合项目，且只进入浏览器草稿/测试边界。
- `usePlatformDraftPersistence()` 只在可写平台会话启用。dirty 编辑以 700ms 合并写入同一 envelope；
  写任务执行时读取 document refs 的最新快照，队列串行化 put/delete，避免迟到 put 在保存成功删除后
  重新制造草稿。编辑器卸载会立即排入最后一份 dirty 快照，因此 700ms 内返回资源管理器也不会漏写。
  clean 只来自初始服务器状态或成功完整保存，此时删除草稿。
- `useProjectDocumentState()` 新增一次性 `initialRecoveryState`，首次 render 原子恢复 current/saved 项目、
  吸附状态、pending operation id/revision 与时间；不使用 effect 先显示错误 clean 状态。新增
  `getRecoveryState()` 作为 IndexedDB 唯一完整快照接口，App 不再拼接 hook 内部 refs。
- 平台打开仍只有一条权威路径：先读取服务器最新 payload、revision 和权限，再读取当前账号/文件草稿。
  revision 完全相同时可显式恢复；远端已变化或当前只读时禁止直接恢复，只能导出标准 v5 JSON，或明确
  丢弃后打开服务器版本。恢复保留原 operation id/local revision，未来重试继续复用 R4a 幂等键。
- 选择性整合不能绕过恢复入口。准备 merge draft 前会检查目标文件是否存在任何本地草稿；存在有效或
  损坏记录都阻止进入目标编辑器，要求先普通打开并处理，避免比较流程覆盖尚未恢复的数据。
- 正常完整保存仍按“固定 payload/operation ids -> 顺序提交 operation 摘要 -> revision save -> 只确认本次
  覆盖内容”的既有流程运行。保存成功后 `hasUnsavedChanges=false` 触发草稿删除；保存期间继续编辑仍保留
  新 operation 和 dirty envelope。

界面与样式：

- 新增 Radix Dialog 草稿恢复界面，沿用现有恢复历史的低饱和桌面风格，明确文件名、更新时间、草稿
  基准 revision、服务器当前 revision 和待同步数量。同 revision 显示恢复入口；stale/read-only 只显示
  导出与丢弃，不用禁用按钮假装可恢复。
- 本轮没有改时间轴布局、标注数据格式或服务器 schema。`ResourceExplorer` 只有 payload helper import
  迁移，平台/本地 JSON 的既有入口不变。

失败、修复与验证：

- 第一次 `build:web` 在 `unknown` 草稿归一化处触发 TS18046；先把通过 integer guard 的 revision 保存为
  已收窄局部数值，再参与 operation 范围判断。没有用 `as any` 绕过边界。
- 第一次 document recovery 测试在 Node SSR 中报 `React is not defined`；测试显式导入 React 并使用
  `React.createElement`，保留应用的现代 JSX 配置，不修改生产构建。
- `npm run test:platform-operations` 2/2；覆盖稳定 operation id 和恢复后的紧凑吸附摘要。
- `npm run test:platform-drafts` 5/5；覆盖 token URL 脱敏、无每操作完整快照、operation id/revision 保留、
  unknown 损坏拒绝、同 revision 判定、账号/文件隔离、覆盖/删除，以及 hook 首次挂载原子恢复。
- `npm run test:api` 85/85；隔离 `api_test` schema 无待迁移，并确认本轮前端状态重构没有破坏幂等 API、
  revision save、恢复快照、ACL、上传、备份和运维边界。仍输出既有 pg 9 前置弃用提示，不影响结果。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 和 API；仅保留既有 Vite
  主 chunk 超过 500 kB 提醒。`git diff --check` 通过，API `/api/health/ready` 返回 database/storage ok。
- 尝试使用内置 Browser 做真实刷新恢复点击测试时，第一次导航发生在 Vite 启动前，形成
  `ERR_CONNECTION_REFUSED` 的 `data:` 错误页；随后虽已启动 `http://127.0.0.1:5173/`，Browser 运行时
  URL 安全策略禁止从该错误页导航、刷新或读取，并明确禁止绕过或换用另一浏览器表面。因此本轮没有
  冒充完成浏览器视觉/生命周期手测；自动化覆盖了数据、IndexedDB 事务和首次恢复状态，真实浏览器的
  “编辑后立即返回、刷新恢复、stale 导出/丢弃、保存后不再提示”仍列为人工验收项。

自我审查与后续边界：

- 全文检索确认旧完整 before/after 字段只剩解释其危害的注释和断言其不存在的测试；没有僵尸 helper。
  `idb` 与 `fake-indexeddb` 同 package/lockfile 提交，未引入第二套项目迁移或 UI 框架。
- 当前 envelope 保存 current 与 saved 两份项目是恢复 dirty 基线所需的有界重复，不随 operation 数增长；
  大项目的序列化耗时、配额和 worker 化应在真实性能数据出现后处理，不能提前把 ProjectData 拆成未经
  设计的局部缓存。
- R4b1 遇到 stale revision 会 fail closed，并提供 JSON 数据保险，但尚不能结构化审阅/整合 stale 草稿；
  R4b2 应复用现有 `annotationDiff`/merge planner 建立“本地草稿 vs 服务器当前文件”的明确决策。之后
  R4c 才加入服务器自动保存节流、在线恢复和退避。WebSocket/presence 继续留在 R5。
