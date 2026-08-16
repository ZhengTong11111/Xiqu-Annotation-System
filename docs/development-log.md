# Development Log

> 本文件是按时间追加的实施历史，不是当前架构规范。旧章节中的 Course/Assignment、
> Workspace/Fork、ProjectMember、AnnotationVersion、ProjectVersion、PermissionGrant 和
> 轨道/时间 scope 均可能已被后续重构撤销。当前设计以 `AGENTS.md`、
> `docs/kunqu-platform-roadmap.md`、`docs/permissions-model.md` 和实际代码为准；不要为“修正文档”
> 回写或删除历史记录。

## 2026-08-09：云端新建文字块/动作块失败修复（首轮已部署，运行时恢复补强）

本轮 Codex 先审查了前序代理已经放入工作区的结构事务迁移，再定位用户报告的现象：本机编辑器可以新建文字块、
动作块，生产文件旧块编辑正常，但新增块无法提交。没有在生产文件上执行未经确认的新建或删除测试。

### 根因

- 新建动作、逐字、工尺块、自定义块和附属点已经改为构造 `annotation.track.structure.transaction.apply`，但
  shared 的事务 parser 只把专用轨道结构/lifecycle/configuration leaf 计作“结构子命令”。
- 仅包含普通 `annotation.items.lifecycle.update` 的实体新建事务因此在解析阶段返回 `null`；App 随后显示“无法形成
  完整且有界的协作命令”，云端没有可重放的 operation。这解释了为什么旧块 timing/content 编辑仍可保存，而新块失败。
- 动作实体还缺少严格的 action-scoped lifecycle 快照合同；此外时间轴框选创建动作仍保留一个直接调用无界
  `commitProject` 的旧入口。

### Codex 实际修复

- 在 `packages/shared/src/annotationCommands.ts` 增加 `ActionLifecycleSnapshot`、action scoped parser、集合键、
  inverse 支持，并让普通 lifecycle leaf 在结构事务中参与“至少一个结构子命令”判定。
- 在 `packages/document-model/src/annotationLifecycleCommand.ts` 增加 action 的目标解析、按轨道集合位置重建、
  引用校验和 ProjectData adapter 支持；动作块可被创建、删除和 inverse 精确恢复。
- 在 `packages/document-model/src/trackStructureTransactionCommand.ts` 增加逐字创建所需的句级 timing leaf，保证
  新句/逐字/句同步不会拆成多次保存。
- 在 `src/App.tsx` 将点击创建与拖拽创建动作、逐字块、自定义块、附属点和工尺块，以及对应删除入口统一到结构事务；
  只有命令成功提交后才改变选中项和行内编辑状态。动作类型与内建 options 的右键耦合修改也已统一到结构事务；
  新增逻辑均补充中文功能注释，并清理拖拽动作创建及动作类型修改的旧直接 `commitProject` 路径。
- 本轮没有新增 npm 依赖；继续复用 shared parser、document-model adapter、原子批次 runtime 和现有 mutation lease。

### 验证

- `npm run test:annotation-commands`：23/23 通过。
- `npm run test:annotation-command-commit`：5/5 通过。
- `npm run test:annotation-lifecycle-command`：10/10 通过。
- `npm run test:custom-track-structure-command`：19/19 通过，覆盖动作块结构事务创建/inverse 及普通 lifecycle
  leaf 作为结构事务唯一结构子命令。
- `npm run test:annotation-transaction-command`：8/8 通过。
- `npm run test:platform-atomic-submit`：26/26 通过。
- `npm run test:platform-operation-catch-up`：20/20 通过。
- `npm run test:platform-drafts`：33/33 通过。
- `npm run test:platform-conflict-rebase`：13/13 通过；`npm run test:platform-conflict-rebase-preparation`：6/6 通过。
- `npm run build:web` 与完整 `npm run build` 通过；仅有既有 Vite 主 chunk 超过 500 kB 提醒，未引入新的编译错误。
- `git diff --check` 通过。

### 当前状态与待推进

- 已完成：本地代码、命令模型、App 入口、自动化测试和构建检查。
- 待完成：提交 Git 后按 `docs/server-deployment.md` 进入维护模式，停止 analysis worker，创建并校验生产备份，
  发布包含 shared/document-model/API/Web 的不可变 release，执行 migration/readiness/deploy smoke，解除维护并启动
  worker；随后在生产已有文件上人工验收新建文字块、动作块、撤销/重做、刷新后 revision 收敛。生产验收应优先用
  用户指定的已有工程，未经用户确认不删除或清理数据。
- 其他 agent/Codex 工作边界：本轮未调用 Claude Code；工作区中已有的前序结构事务迁移由前序代理完成，本轮 Codex
  负责审查、补齐 shared 门禁、action lifecycle、App 残余入口、回归测试和本文记录。

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

## 2026-08-03：R4b2 stale 浏览器草稿结构化比较与安全整合

本轮从 R4b1 commit `49cae65` 和干净工作树开始。Codex 先审计普通文件比较、选择性整合、平台唯一
文件打开入口、IndexedDB 草稿仓库和编辑器 document state，再把被忽略的 `CLAUDE_WORK.md` 整体替换
为 R4b2 当前任务书。实现、测试、自审和文档均由 Codex 直接完成，没有调用 Claude Code、GLM、
DeepSeek 或其他代理。本轮目标不是把 stale 草稿整份覆盖到服务器，而是让用户能按稳定实体审阅本地
改动，并在最新服务器内容之上安全形成一份尚未保存、可撤销的编辑器草稿。

共享审阅层与删除的旧逻辑：

- 原 `AnnotationComparisonDialog.tsx` 同时承担双资源读取、左右交换、方向、实体选择、依赖计划、冲突
  决策和准备状态。为避免 stale 草稿复制第二套算法，新建 `AnnotationMergeDiffReview.tsx`，集中拥有
  direction、selection、plan、conflict resolution 和 preparation state；外层只传入同一次规范化产生的
  diff/leftProject/rightProject，并接收排序后的选择、冲突决定和 plan fingerprint。
- 普通文件比较继续允许双向整合；草稿比较只开放 `left-to-right`。原对话框内单项/分组 checkbox、禁用
  原因和计划状态已删除，没有保留并行旧实现。`AnnotationMergePlanPanel` 只增加受限方向输入，不学习
  IndexedDB、资源 id 或保存行为。
- 新建 `PlatformDraftConflictDialog.tsx`，固定“本地浏览器草稿在左、服务器当前文件在右”。草稿不是
  `ResourceEntry`，因此不会伪造资源路径、侧边打开命令或可写文件身份；界面明确说明准备不会直接覆盖
  服务器。

权威复核与纯领域边界：

- `platformDraftConflict.ts` 是无 React、网络、存储和保存副作用的准备器。用户点击准备后，Workspace
  同时重新读取最新 `AnnotationFile` 与当前账号/文件的 IndexedDB envelope，再核对 user/file identity、
  草稿 `updatedAt`、草稿基准 revision、服务器 revision 和最新 write capability。
- 准备器重新运行唯一 `buildAnnotationDiff()` 迁移路径，拒绝重复稳定 id；随后规范化当前左到右选择，
  禁止把已经失效的条目静默裁掉，重建依赖计划并核对 plan fingerprint。所有 replace conflict 都必须
  经过显式“采用来源/保留目标”决定；结构 issue 或应用完整性失败均不会产出半成品。
- 成功结果复用既有 `AnnotationMergeDraft`，但新增 `sourceKind` 区分普通资源整合与浏览器草稿整合。
  `baseProject` 始终是权威服务器当前项目，`mergedProject` 仅包含明确选择、本地依赖闭包和冲突决定；
  纯准备器不删除 IndexedDB、不写 operation/audit、不修改 ProjectData 输入，也不保存服务器。

编辑器二次确认与草稿生命周期：

- Workspace 仍通过唯一 `enterPlatformEditor()` 构造会话。成功准备只打开服务器目标文件和运行时 merge
  draft；编辑器确认前，项目历史、dirty 状态和服务器 revision 均未变化。
- `usePlatformDraftPersistence()` 增加显式 `suspended`，并把 put/delete/none 判定抽为可测试纯函数。只要
  runtime merge draft 待确认，就暂停全部草稿写入与清理；此时退出编辑器不会因初始 clean 状态误删
  原 stale envelope。
- 用户确认时，既有 `commitProject(merged, base, "merge-project")` 只形成一次可撤销 dirty 操作，然后
  persistence 以最新服务器 revision 覆盖旧 stale envelope。用户点击“放弃本地草稿整合”时必须再次
  确认旧草稿将清除；确认取消后目标仍 clean，恢复持久化并删除 envelope。普通文件整合取消不增加该
  草稿语义。
- pending merge draft 仍是纯运行时状态，不进入 ProjectData、项目 JSON、IndexedDB、localStorage、
  operation log 或 audit log。最终服务器写入仍只能由用户执行普通 revision-checked 保存。

失败、修正与测试：

- 新增 stale 准备器测试第一次失败并非实现错误，而是测试把合并后句级数组预期写成“服务器独有在
  本地新增之前”；正式应用按时间稳定排序，实际为 shared、local-only、server-only。测试改为领域模型
  的真实稳定时间顺序，没有修改生产排序去迎合断言。
- `npm run test:platform-drafts` 9/9：覆盖草稿脱敏/归一化、同 revision 判定、IndexedDB 隔离、首次原子
  恢复、stale 选择性准备、草稿/服务器/权限变化阻断、旧选择和旧指纹阻断，以及 suspended/dirty/clean
  三种持久化决策。
- merge 回归全部通过：`test:annotation-diff` 10/10、`test:annotation-merge-plan` 11/11、
  `test:annotation-merge-selection` 5/5、`test:annotation-merge-conflict` 1/1、
  `test:annotation-merge-apply` 4/4、`test:annotation-merge-preparation` 4/4。普通双文件整合仍使用同一套
  纯 helper 和双向 UI。
- `npm run test:api` 85/85；本轮无 schema/API 合同变化，仍验证资源 ACL、revision save、确认范围、
  快照、上传、对象生命周期、审计、备份和维护边界。仅输出既有 pg 9 前置弃用提示。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 和 API；Vite 仅保留既有
  主 chunk 超过 500 kB 提醒。`git diff --check` 通过；运行中的 API `/api/health/ready` 返回 ready，
  PostgreSQL 和本地对象存储均为 ok。

浏览器验收边界与人工顺序：

- R4b1 尝试 Browser 时，在 Vite 启动前形成 `ERR_CONNECTION_REFUSED` 的 `data:` 错误页；该浏览器运行时
  随后明确以安全策略禁止从错误页导航、刷新或读取，也禁止绕过或换用另一浏览器表面。本轮遵守该限制，
  没有再次尝试规避，也没有把 TypeScript 构建冒充成真实视觉点击验收。
- 人工验收应依次：以 rN 打开并编辑形成草稿但不保存；另一会话把服务器推进到 rN+1；重新打开看到
  revision conflict；进入固定方向比较；选择本地新增和冲突项；准备后确认服务器内容尚未变化；退出后
  再开确认旧草稿仍在；重新准备并在编辑器应用，确认只出现一次可撤销 dirty 操作；普通保存成功后再开
  文件不应提示旧草稿。只读账号仍只能导出/丢弃。

自我审查与下一阶段：

- 全文检索确认普通比较中的旧 selection/group checkbox 和禁用 helper 已删除；`AnnotationMergeDraft`
  只有普通资源与 stale 草稿两个正式构造入口，均显式设置 `sourceKind`。没有新增依赖、第二套项目迁移、
  直接服务器覆盖或僵尸保存路径。
- 当前 hook 仅把“待确认整合时暂停、确认后 dirty 写入、取消后 clean 删除”的决策做了纯函数测试；完整
  React + IndexedDB 生命周期仍需按上述人工顺序验收。R4c 应在现有显式冲突边界之上实现自动保存节流、
  保存中继续编辑、在线恢复和指数退避；不能把 R4b2 的运行时草稿误当作已保存事实，也不能提前进入
  WebSocket/presence。

## 2026-08-03：R4c1 自动保存调度、保存中继续编辑与在线退避

本轮在提交 R4b2 commit `0642d4b` 后立即开始。Codex 重新审计 `useProjectDocumentState()`、
`saveProjectToServer()`、幂等 operation 提交、revision save、IndexedDB 草稿和 beforeunload，而不是照着
roadmap 的旧一句话直接堆 timer；随后把被忽略的 `CLAUDE_WORK.md` 整体替换为 R4c1 当前任务书。工作由
Codex 直接完成，没有调用 Claude Code、GLM、DeepSeek 或其他代理，也没有引入新依赖。

审计结论与范围调整：

- 现有状态层已经正确表达 saved/dirty/saving/offline/conflict/error，并能在保存期间继续编辑：保存开始
  固定 project、track snap、covered operation ids 和 local revision，成功只推进该固定 baseline，期间
  新 operation 继续 pending/dirty。因此本轮不重写 document state，也不创建第二套保存队列。
- 原保存函数直接弹窗并返回 boolean，只适合菜单命令。现在定义 `PlatformSaveOutcome` 联合类型，明确
  saved、四种 skipped、offline、conflict 和带 retryable 的 error；manual/auto 共用同一 operation +
  payload + revision 事务。手动模式仍提交当前输入框并显示错误，自动模式不打断输入法/未确认文字，也
  不弹阻塞 alert。
- R4c1 只解决调度、保存中继续编辑、在线恢复和退避。自动保存遇到 409 会 fail closed 并停在 conflict；
  它不会在后台自动采用本地、覆盖服务器或刷新丢失内容。把该状态接入 R4b2 结构化比较留给 R4c2。

纯策略与调度器：

- 新增 `platformAutoSavePolicy.ts`，集中定义 3 秒空闲窗口、2 秒退避基数和 60 秒上限。纯函数根据
  enabled/dirty/suspended/online/sync status/in-flight、idle/retry dueAt 返回 disabled、blocked、waiting
  或 save-now；它不读取 ProjectData、不持有 timer，也不发请求。
- 退避采用确定性 `2s, 4s, 8s ... 60s`，没有引入随机 jitter。当前单浏览器会话优先保证可复现测试与
  清晰诊断；若生产观测显示大量客户端同时 online 形成惊群，再加入可注入、可测试的受控 jitter。
- 新增 `usePlatformAutoSave()`，只拥有一个 timer 与一个 in-flight 请求。保存 callback 存在 ref 中，避免
  App 每次 render 的函数身份重置计时；新 local revision 重排 idle，retry timer 和 idle timer 不并存。
  offline 不请求，project state 的 online 事件恢复 dirty 后立即重试。pending merge draft 完全暂停。
- 保存期间组件 facts 可以继续变化；single-flight 锁阻止重入，请求完成后若最新文档仍 dirty，再进入
  下一空闲窗口。卸载会清 timer，并允许已发请求自然完成，但不会让迟到结果继续安排已销毁会话。

错误分类、页面关闭与删除的旧逻辑：

- `describeServerSaveError()` 现在同时给同步 UI 与调度器返回 retryable：浏览器明确 offline 为 offline；
  fetch `TypeError`、HTTP 408/429/5xx 可退避；409 是不可重试 conflict；403 和其他确定 4xx、未知程序错误
  是不可自动重试 error。失败仍不调用 `markProjectAsSaved()`。
- 删除旧 boolean 成功/失败返回和自动路径无条件 alert 的假设；菜单与自动 hook 都只调用一份
  `saveProjectToServer({ source })`。`serverSaveInFlightRef` 继续是请求级唯一互斥，不新增平行锁。
- dirty `beforeunload` 继续保留，但页面卸载不启动 fetch/sendBeacon。服务器保存要求 operation、payload、
  revision、权限和响应确认，Beacon 无法满足事务；R4b1 IndexedDB envelope 仍是关闭/崩溃的本地兜底。

实现过程中的自审修正：

- 第一版 hook 曾用 effect generation 同时取消 timer 和标记请求结果过期。自审发现：保存期间新编辑会
  让 effect cleanup 增加 generation，随后请求 finally 也被忽略，可能使 `inFlightRef` 永久为 true。提交
  前已删除这一错误耦合，改为 timer 由 effect cleanup 管理、请求锁无条件在 finally 释放、仅以
  `mountedRef` 禁止卸载后 rerender。没有留下 generation 僵尸路径。
- 自审还收紧了不可重试错误：新 local revision 或 online 事件只重置普通退避，不清除 403 等
  `retryBlocked`；用户必须手动重试、权限恢复并成功保存，或重新打开会话。409 更不会因继续本地编辑而
  自动解除。随后又检查了手动保存入口：手动 403 不会把 outcome 回传给自动 hook，因此纯策略进一步
  规定“error 且没有明确 retryDueAt”一律阻断；只有自动请求已登记退避截止时间时才允许后台继续尝试。

测试、构建与运行状态：

- `npm run test:platform-auto-save` 4/4：覆盖禁用/clean/pending merge、idle/retry 到点、offline/conflict/
  non-retryable/in-flight 阻断，以及指数退避增长和封顶。
- `npm run test:platform-operations` 3/3：除稳定 operation id/摘要外，新增 409、503、403、fetch TypeError
  与普通 Error 的 retryable 分类回归。
- `npm run test:platform-drafts` 9/9：确认自动调度接入没有破坏 IndexedDB 隔离、原子恢复、stale 整合和
  pending merge 持久化暂停。
- `npm run test:api` 85/85：无 schema/API 合同变化，revision 并发、恢复快照、ACL、确认范围、上传、
  审计、备份和维护边界继续通过；只保留既有 pg 9 前置弃用提示。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 和 API；Vite 只保留既有主
  chunk 超过 500 kB 提醒。`git diff --check` 通过；运行中的 `/api/health/ready` 返回 ready，database 和
  storage 均为 ok。

浏览器验收边界与人工顺序：

- R4b1 的 Browser 会话仍受其错误 `data:` 页安全策略限制，并明确禁止绕过或换用其他浏览器表面。本轮
  没有违反该限制，也没有把 policy 测试或 TypeScript 构建冒充成真实浏览器自动保存验收。
- 人工验收应依次：打开可写文件并修改，顶部先显示本地更改，约 3 秒后显示保存中再回已保存；保存中
  继续修改，第一次完成后仍显示 dirty 并再次自动保存；断网修改应显示离线待同步且服务器 revision 不
  变，恢复网络后自动推进；用 5xx/网络中断观察有界重试且无 alert 风暴；用第二会话推进 revision 后，
  自动保存应停在“存在远端冲突”且不得覆盖。pending merge 确认条存在时不应自动保存。

后续边界：

- R4c1 没有把 retry timer 写入 ProjectData/IndexedDB/localStorage，也没有新增 UI 框架、后台 worker、
  WebSocket 或 operation 增量应用。自动保存成功仍会触发既有恢复快照与确认范围 freshness 刷新。
- R4c2 应让 conflict 状态提供“读取最新服务器并比较”的明确入口，复用 R4b2 diff/plan/apply 和编辑器
  二次确认，同时保留当前 dirty 草稿；不应通过页面刷新、清空 IndexedDB 或自动覆盖来解除冲突。

## 2026-08-03：R4c2 自动保存冲突的显式比较与继续同步

本轮从 R4c1 commit `f7a4c28` 和干净工作树开始。Codex 审计编辑器 conflict 状态、Workspace 会话构造、
R4b2 `PendingDraftOpen`/固定方向比较入口，以及草稿 debounce/unmount 写队列；随后将 `CLAUDE_WORK.md`
整体替换为 R4c2 当前任务。工作由 Codex 直接实现，没有调用 Claude Code、GLM、DeepSeek 或其他代理，
也没有新增依赖。

核心流程与职责边界：

- 409 仍由唯一保存事务归类为 conflict，自动保存停止，document/undo/pending operations/dirty baseline
  原样保留。编辑器新增紧凑冲突栏，但不自动弹窗打断时间轴；用户可继续编辑，只有明确点击“比较并处理
  冲突”才启动交接。
- `usePlatformDraftPersistence()` 新增稳定 `flushNow()`。它不在 App 或 Workspace 另开 IndexedDB put，
  而是复用 debounce、clean delete 和 unmount capture 的同一串行队列；flush 等待先前任务，并在真正执行
  时读取最新 options/recovery refs。这样较旧 debounce 写入不可能在冲突导航的精确草稿之后反向覆盖。
- `PlatformEditorSession.openSaveConflictReview()` 属于 Workspace 编排命令。App 先等待 flush；Workspace
  再并行读取最新服务器文件和同账号/文件草稿，重新归一化并计算 recoverable/revision-conflict/read-only。
  任一读取或归一化失败都会返回错误并留在当前 dirty editor；只有两侧事实完整后才设置 pending modal、
  清 editor session 并切到资源管理器。
- 预期 revision-conflict 会直接展示 R4b2 `PlatformDraftConflictDialog`，固定本地草稿在左、服务器当前在
  右。若权限在冲突期间被撤销，进入 read-only 导出/丢弃保护；若服务器 revision 极端情况下回到同值，
  进入 recoverable 提示。交接本身不写服务器、不创建资源、不记录 operation/audit，也不标记 saved。
- 用户完成 R4b2 选择、依赖闭包、冲突决定和编辑器二次确认后形成一次 dirty commit；R4c1 自动保存从
  新服务器 revision 继续。取消/退出仍按 R4b2 规则保留或显式放弃草稿。

队列测试与实现修正：

- 为避免只测试 `put/delete/none` 决策而漏掉真正竞态，将草稿串行器抽为
  `createPlatformDraftTaskQueue()`。每个调用者得到自己的 execution Promise，能感知显式 flush 失败；
  内部 tail 会报告错误并恢复，使一次 IndexedDB 故障不毒死后续写入。
- 新增回归测试构造“延迟首写 → 失败写 → flush”，断言事件严格按 first/failed/flush 排序，失败 Promise
  对调用者 reject、错误回调收到一次诊断、最终 flush 仍执行。没有为测试引入 jsdom 或第二套 repository。
- 冲突栏维护 busy/error；重复点击被阻止。状态离开 conflict 后清理旧错误，下一次冲突不会显示上一次
  请求诊断。最终自审还发现 flush 失败原本会通过通用草稿错误回调把 conflict 改成 error，导致处理入口
  消失；现在冲突期间只更新错误说明并保留 conflict 主状态，用户可以修复存储问题后重试。样式复用
  编辑器顶部信息带密度，以低饱和橙色区分普通蓝色 merge draft，不改时间轴布局。
- 队列抽取后的第二次自审发现：显式 flush 需要拿到 rejected Promise，但 debounce、clean 删除和卸载写入
  没有调用者等待；直接用 `void` 丢弃会在 IndexedDB 失败时形成未处理 rejection。最终实现保留同一队列
  的统一错误上报，并让三类后台调用显式消费已上报的 rejection；没有恢复旧的吞错队列，也没有建立
  第二条草稿写入路径。随后完整构建又定位到身份缺失分支会令写入 helper 返回 `undefined` 的类型漏洞；
  helper 现已固定返回 `Promise<void>`，缺少账号或文件标识时明确失败，不以可选链把非法调用伪装成成功。

测试与运行状态：

- `npm run test:platform-drafts` 10/10：在 R4b1/R4b2 原 9 项上新增队列顺序、失败反馈与恢复验证。
- `npm run test:platform-auto-save` 4/4，确认 conflict 仍阻断调度；R4c1 policy 无回归。
- `build:web` 在实现过程中通过，覆盖新增 session callback、flush result、App banner 与 CSS 类型边界。
- merge 回归通过：diff 10/10、plan 11/11、selection 5/5、conflict 1/1、apply 4/4、preparation 4/4。
- `npm run test:api` 85/85；本轮无 API/schema 变化，revision/ACL/恢复/运维合同继续通过，仅保留既有
  pg 9 前置弃用提示。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 和 API；只保留既有 Vite
  主 chunk 超过 500 kB 提醒。`git diff --check` 通过；`/api/health/ready` 的 database/storage 均为 ok。

浏览器与人工验收边界：

- R4b1 Browser 会话仍处于安全策略禁止导航的错误 `data:` 页，并明确禁止绕过或换用其他浏览器表面。
  本轮没有违反该限制，也不会把构建冒充成冲突栏真实点击验收。
- 人工顺序：会话 A 修改后暂不保存；会话 B 推进服务器 revision；A 自动保存进入 conflict，确认冲突栏
  出现且仍可继续编辑；点击处理，确认 busy 后直接进入固定方向比较；返回/失败时 dirty 不丢；完成选择
  和二次确认后，观察自动保存从最新 revision 成功并清除旧草稿。处理期间撤销 write 权限应进入 read-only
  保护而非错误打开可写 editor。

后续边界：

- R4a 至 R4c2 已形成“幂等 operation → IndexedDB 恢复 → stale 结构化整合 → 自动保存/退避 → 409 显式
  交接”闭环。没有 WebSocket、presence、领域 operation 重放或实时多人合并。
- 下一轮必须对照 R4 完成标准做一次生命周期与残余风险审计；若缺少可自动化的 timer/hook 集成测试、
  用户可见重试信息或关闭页面一致性证明，应拆 R4c3 补齐，而不是因主路径可编译就直接宣布 R4 完成。

## 2026-08-03：R4c3 自动保存生命周期协调器与 R4 工程验收

本轮从 R4c2 commit `9689070` 和干净工作树开始。Codex 先对照 roadmap 的 R4 完成标准审计
`usePlatformAutoSave()`、纯 policy、document online/offline listener、唯一服务器保存事务、IndexedDB 草稿
和现有测试。审计确认产品主路径已连通，但只有纯 policy 有测试，timer、single-flight、保存期间继续编辑、
online 恢复、dispose 和异常 Promise 仍耦合在 React hook 内。随后将 `CLAUDE_WORK.md` 整体替换为 R4c3
单一任务。工作由 Codex 直接实施，没有调用 Claude Code、GLM、DeepSeek 或其他代理，也没有新增依赖。

实现与旧逻辑清理：

- 新增 `platformAutoSaveRuntime.ts`。运行时只接收六项会话 facts，并注入 now/timer/save/error callback；
  内部至多保留一个 timer 和一个 in-flight 请求，继续复用 R4c1 纯 policy 与退避函数，没有复制决策逻辑。
- runtime 的 `update()` 统一处理 local revision、offline→online 和普通 facts 变化；`evaluate()` 是唯一调度
  入口。正常 outcome 只调整 idle/retry/block 状态，服务器 revision、saved baseline、operation ack 和
  IndexedDB 仍由 App/document/draft 各自所有。
- `usePlatformAutoSave.ts` 删除原来的 idle/retry dueAt、attempt、blocked、in-flight、mounted refs 和
  `useReducer` 强制 render。hook 现在只把最新回调保存在 ref、向 runtime 更新 facts，并在卸载时 dispose。
- App 新增合同外异常回调：记录开发者错误并设置用户可见 sync error；它不标记 saved、不清 dirty、不清
  operation 或草稿，也不进入盲目自动重试。

实现过程中的自审修正：

- 初始 runtime 测试 7/8，通过项包括 idle、退避、offline、阻断、suspend、异常和 dispose。唯一失败来自
  测试误以为保存 Promise 完成就等于 React document 已从 saving 推进到 dirty；最终保留产品边界，让
  runtime 在 saving facts 下等待 document 更新，并按真实顺序修正测试，没有让协调器越权修改同步状态。
- 第二次自审发现 React 18 Strict Effects 风险：若 runtime 在 render 创建，开发态模拟卸载 dispose 后，
  第二次 effect setup 会继续取得已销毁实例，导致自动保存永久失效。最终改为 effect 通过
  `ensureRuntime()` 按需创建，cleanup 同时 dispose 并置空 ref；第二次 setup 会建立新实例。
- 保存调用改为 `Promise.resolve().then(save)`，同步 throw 和异步 reject 走同一 catch；catch 先阻断、清
  dueAt、通知 App，finally 再释放锁并重新求值。dispose 后迟到成功/失败都不再建 timer 或调用 UI。

确定性测试：

- 新增 `npm run test:platform-auto-save-runtime`，使用手写 fake clock，不引入 jsdom、fake timer 库或真实
  3 秒等待。8/8 覆盖：单 idle timer、single-flight、保存中继续编辑、2s/4s 退避、online 立即恢复、
  conflict/确定错误阻断、pending merge suspend、同步 throw/异步 reject、dispose 迟到响应。
- `npm run test:platform-auto-save` 4/4、`npm run test:platform-drafts` 10/10、
  `npm run test:platform-operations` 3/3 通过；前端构建通过，只保留既有 Vite 主 chunk 超过 500 kB 提醒。
- merge 回归 35/35：diff 10、plan 11、selection 5、conflict 1、apply 4、preparation 4；R4c3 没有改变
  structured merge、冲突决定或二次确认边界。
- `npm run test:api` 85/85；本轮无 API/schema 变化，revision、operation 幂等、ACL、恢复、上传、审计、
  维护与备份合同继续通过，只保留既有 pg 9 前置弃用提示。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 和 API；`git diff --check`
  通过。运行中的 `/api/health/ready` 返回 ready，database 6.23 ms、storage 1.93 ms，均为 ok。Vite 只保留
  既有主 chunk 超过 500 kB 提醒。

浏览器与后续边界：

- 既有 Browser 会话仍受错误 `data:` 页安全策略限制，并明确禁止绕过或换用其他浏览器表面。本轮继续
  遵守限制；确定性 runtime 测试证明调度语义，但不冒充真实浏览器弱网、刷新和 IndexedDB 验收。
- 人工验收仍按 R4c2 顺序增加两项：开发态 Strict Mode 修改后应在约 3 秒正常保存；制造未知 save 异常时
  应显示同步失败、保持 dirty 且不形成请求风暴。生产上线前还需真实跨设备、弱网和浏览器关闭场景验收。
- R4 工程闭环通过最终回归后，下一轮进入 R5 前置：先稳定块级领域命令与协作权限/排序合同，不直接把
  任意完整 `ProjectData` 快照塞进 WebSocket，也不提前绑定 OT/CRDT。

## 2026-08-03：R5a1 第一批可验证时间轴领域命令

本轮从 R4c3 commit `e72c131` 和干净工作树开始。Codex 先审计 `useProjectDocumentState()` 的 transient
拖动基线、App 各时间编辑入口、IndexedDB 草稿 parser、服务器 operation 请求、API 幂等接收与 R5 roadmap，
再将被 gitignore 的 `CLAUDE_WORK.md` 整体替换为 R5a1 当前任务书。实现、测试、自审和文档由 Codex 直接
完成，没有调用 Claude Code、GLM、DeepSeek 或其他代理，也没有新增依赖；有限的纯数据合同使用现有
TypeScript 足以表达，引入 schema 库反而会制造本轮不需要的运行时和 bundle 成本。

共享协议与边界：

- 新增 `packages/shared/src/annotationCommands.ts`，定义 version 1 `timeline.items.timing.update` envelope。
  每项保存 entity type、稳定 entity id、必要时 track id，以及 before/after 时间；sentence、character、
  action、custom-block、attached-point、gongche-block、banyan-mark 构成首批实体集合。打点和板眼统一编码
  为 `startTime === endTime`，不为点状实体再造第二种时间结构。
- unknown parser 要求 envelope/command/item/timing 使用精确字段，拒绝未知版本/类型、空命令、超过 500
  项、重复目标、坏 id、NaN/Infinity、负数、倒置区间、点实体非零区间和 no-op。稳定 target key 同时用于
  去重与排序；排序采用明确的代码点比较，不依赖客户端 locale。
- builder 复制输入、删除 no-op 并稳定排序。自审发现第一版对超过 500 项或旧文件中不符合新 id 约束的
  目标会抛异常，这会让一次合法时间轴 pointer-up 崩溃；提交前改为返回 `null`，调用层安全保留 legacy
  snapshot operation。协议无法表达的旧数据不会阻止用户继续标注，也不会被伪造成半个领域命令。
- shared allowlist 继续接受 `project.commit/project.undo/project.redo/track-snap.update`，领域 action 则
  必须和 envelope command type 完全一致。第二次自审发现 legacy action 原本可夹带一个合法 envelope，
  现已明确拒绝带 `version` 或 `command` 外形的 legacy payload；未知 action 和损坏 envelope 同样在路由
  写库前 fail closed。

本地 document、草稿与服务器接入：

- `ProjectDocumentOperation` 可选保存 `commandEnvelope`，operation type 扩为 legacy 与已知领域命令联合。
  `commitProject()` 第三个参数改为明确 options，可同时指定 history action 或 envelope；所有 import、merge、
  repair 等显式 history 调用已迁移到 options 形状，未迁移编辑仍按原样记录 `project.commit`。
- 新增 `timelineTimingCommand.ts`，从同一次 undo 的真实 `baseProject` 与最终 `nextProject` 统一解析时间。
  这点对拖动很关键：live frame 已通过 `applyProjectWithoutHistory()` 改写 `projectRef.current`，pointer-up
  不能把当前画面误当 before。helper 覆盖嵌套自定义块、附属点、工尺和板眼，并集中收集文字父块派生的
  工尺目标；目标缺失即返回 `null`，不把创建/删除错记成 timing update。
- App 首批迁移成熟的单逐字、句块、动作、自定义块、工尺块、板眼点以及多选批量时间提交。逐字变化会
  同步记录句界和对应工尺块；句块移动会记录句、其逐字与工尺；自定义文字块记录自身与工尺。文本、
  四声、类型、分叉归属、工尺符号、板眼类型、创建删除、导入和轨道结构继续走 snapshot，避免一条命令
  只描述实际修改的一部分。undo/redo 仍是 legacy，尚未伪造 inverse command。
- `platformDraft.ts` 对领域 operation 要求 envelope 存在、合法且 type 一致；legacy operation 禁止夹带
  envelope。恢复和克隆保留稳定 operation id、版本、目标及 before/after，不保存额外完整项目副本。
- `platformOperations.ts` 对领域 operation 直接发送完整 envelope；legacy 路径继续发送紧凑摘要。Fastify
  router 复用 shared allowlist/validator，repository、数据库 schema、请求指纹和 `(file, actor, client id)`
  幂等作用域不变。服务器当前只验证并记录，仍由后续 revision-checked PUT 保存完整 payload；本轮没有
  实现 command apply、服务端排序游标、WebSocket、presence、OT 或 CRDT。

实现过程中的清理与审查：

- `commitProject()` 参数收口期间逐一更新了显式 history action 调用，没有保留 string/options 两套重载。
  一次机械补丁曾把工尺命令片段误插入 `updateCustomTrack()`；在测试前通过行级审计删除，并复核所有
  `baseProject` 声明只存在于预期时间路径，没有留下重复变量或僵尸分支。
- 多选命令使用选择目标加受影响句和派生工尺目标；同一目标由 shared key 去重。合并显示、分叉布局、
  吸附、实时预览和现有 history 数量均未改变；仍是每次完成拖动产生一次 undo 和一次 operation。
- API 旧集成测试曾用未知 `character.updateText` 测 stale revision。新 allowlist 会更早返回 400，因此将
  stale 用例改为合法 `project.commit`，并把现有幂等主路径升级为合法 timing envelope。测试语义现在分别
  明确覆盖“协议坏输入 400”和“合法操作旧 revision 409”，不再依赖无效 action 偶然穿过路由。

测试、构建与运行状态：

- `npm run test:annotation-commands` 4/4：覆盖构建/解析往返、输入不可变、确定排序、no-op/超限/旧坏 id
  安全回退、精确结构、点语义、重复目标及 action/envelope allowlist。
- 新增 `npm run test:timeline-timing-command`，3/3 覆盖七类实体的 base/next 时间提取、嵌套点轨、目标去重、
  缺失/无变化回退和工尺父块并集过滤。
- `npm run test:platform-operations` 4/4，新增领域 envelope 原样发送；legacy 摘要和保存错误分类继续通过。
- `npm run test:platform-drafts` 11/11，新增 versioned timing command 的 IndexedDB record 往返和损坏
  envelope fail closed；stale 草稿整合、仓库隔离和 document 原子恢复无回归。
- `npm run test:api` 85/85：真实 `api_test` PostgreSQL migration 后，合法领域命令首次写入、同请求重放、
  同 key 异命令 409、revision 推进后迟到重放、并发单行和不同账号隔离全部通过；未知 action、坏版本、
  legacy 夹带 envelope 均为 400。只保留既有 pg 9 前置弃用提示。
- `npm run test:platform-auto-save` 4/4、`npm run test:platform-auto-save-runtime` 8/8，确认新增 operation
  envelope 未破坏 R4 的 idle、single-flight、离线恢复、退避、冲突阻断和卸载边界。
- 首次完整构建发现新增测试夹具仍使用旧式板眼 subtype 且误写附属点 options 字段；运行时测试因不做
  完整项目类型检查没有暴露它。按当前 `BanyanMark`/`AttachedPointTrack` 类型修正夹具后，`npm run build`
  完整通过 Prisma generation、shared、document-model、web 与 API。Vite 只保留既有主 chunk 超过 500 kB
  提醒；`git diff --check` 通过。
- 运行中的 `/api/health/ready` 返回 ready，database 11.5 ms、storage 2.38 ms，均为 ok。

浏览器验收边界与人工顺序：

- 既有 Browser 会话仍受错误 `data:` 页安全策略限制，并明确禁止导航、读取、绕过或切换其他浏览器
  表面。本轮遵守限制，没有把 Node 测试冒充 UI 验收。
- 人工验证顺序：平台打开可写测试文件；分别拖拽和缩放逐字、动作、自定义文字/动作、工尺块、板眼点；
  多选移动混合块和附属打点；确认每次只有一条 undo、撤销恢复原位置、自动保存后重开位置一致；再编辑
  文本/类型/四声/分叉归属并确认仍能保存。使用旧导入文件和超过 500 个多选目标时不得崩溃，应回退
  snapshot。断网刷新后恢复草稿，再在线保存，领域 operation id 和 envelope 不应丢失或重复。

后续边界：

- R5a1 只证明命令可稳定表达、验证、离线保存和幂等记录，不等于服务端已经能重放。R5a2 应先实现纯
  apply/precondition/inverse 或明确拒绝结果，并定义单文件服务端顺序号、ack cursor、权限复核和有界读取；
  这些在 HTTP/确定性测试闭环后，才适合接 WebSocket presence 与实时传输。
- 后续命令应按文本、创建删除和轨道结构分批设计。批量导入、递归分叉与跨实体操作必须保留显式事务
  边界，不能为了减少 `project.commit` 数量而拆成失去原子性的细碎命令。

## 2026-08-03：R5a2a 时间命令前置条件、反向命令与 ProjectData 原子应用

本轮在 R5a1 commit `5acfd5d` 后立即开始。Codex 先检查干净工作树、R5 roadmap、现有
`AnnotationOperation` schema/repository、API DTO、幂等指纹和 `timelineTimingCommand` resolver，再重写
gitignore 中的 `CLAUDE_WORK.md`。审计结论是不能先给数据库日志增加 sequence 然后再猜命令如何执行：
服务端尚无统一 precondition/apply 语义，`ProjectData` 仍属于 Web 模型。于是把 R5a2 拆为本轮 R5a2a
纯执行合同和下一轮 R5a2b 服务端排序/确认/有界读取。本轮由 Codex 直接实现，没有委派其他代理，也
没有引入依赖。

shared 执行合同：

- `annotationCommands.ts` 新增 `invertAnnotationCommandEnvelope()`，严格解析后交换全部 before/after，再经
  builder 复制、校验和确定排序；无效 unknown 返回 `null`，不修改输入。
- 新增 `assessTimelineTimingExecution()` 和穷举结果：invalid_command、ready，或带 issues 的 blocked。
  issue 明确区分 target_missing 与 before_mismatch，并返回稳定 target key、expected 和 actual，未来 API
  409/UI 不必解析自由文本。调用者提供当前目标时间快照，shared 不 import ProjectData/React/Prisma。
- 前置比较使用统一 `TIMELINE_TIMING_COMPARISON_EPSILON = 0.0005`，允许半毫秒浮点运算误差；builder 的
  no-op 仍精确比较，不能吞掉真实细微调整。重复 actual target 被视为含糊缺失，不随机采用某一项。
- assessment 总是遍历完整命令并汇总问题；调用者只有收到 ready 才能写入，因此后项失败不会留下前项
  已更新的半完成结果。

ProjectData adapter 与旧逻辑清理：

- `resolveProjectTimelineTiming()` 从提取 helper 的私有函数提升为唯一只读 resolver，builder 与 apply 共用
  sentence、character、action、custom-block、attached-point、gongche-block、banyan-mark 的同一寻址。
  action/custom/point/gongche 必须同时匹配 track id。补充 `assertNever`，以后扩 command union 时 TypeScript
  会强迫 resolver 和 apply 分组同步扩展，不能把未知实体静默当成板眼。
- 新增 `timelineTimingCommandApply.ts`。入口先 parse，再为每项解析 actual，一次运行 shared assessment；
  blocked/invalid 不返回新项目。ready 后按七类 map 分组，对相关 ProjectData 集合做不可变更新；输入项目、
  未涉及集合顺序和文字/标签/符号等非时间字段保持不变。
- 自定义轨同时承载 blocks 与 attached point tracks，adapter 在一次轨道映射中处理两类更新，不建立互相
  覆盖的双路径。句界和工尺派生目标已经是命令显式项，apply 不调用现有同步 helper，避免二次位移。
- 板眼时间应用同时重算 `manualOffset = time - estimatedTime` 并设 `confidence = manual`，与编辑器现有人工
  拖动语义一致。inverse 可恢复全部目标时间；由于 version 1 命令没有记录旧 confidence/manualOffset，
  它不承诺整个 BanyanMark 字节级恢复。文档和 AGENTS 已明确该边界，没有伪称完整 undo。
- 本轮没有把 adapter 接入 App 正常编辑、undo/redo 或服务器。成熟本地编辑仍直接生成最终 ProjectData；
  adapter 是远端命令接入前的可测试执行边界，不增加隐藏 UI 或第二套时间同步。

测试与自审修正：

- shared 测试由 4 项增至 6 项，新增 inverse 双重往返/输入不可变、invalid inverse、ready 容差、缺失和
  mismatch 可解释结果。现有 builder/严格 parser/API allowlist 回归继续通过。
- 新增 `test:timeline-timing-command-apply` 3 项：一次命令覆盖七类实体，断言 apply 后目标时间与 next 一致、
  输入不变、标签等字段保留、板眼派生字段一致；inverse 后目标时间回到 base；后项缺失、before 冲突、
  错误 track 和损坏命令均不产生部分结果。
- 第一版 adapter 为取得 parsed envelope 借用了“空 actual assessment”，虽然行为正确但语义绕弯；自审后
  改为直接调用 shared parser，再单独 assessment。另把自定义轨 helper 的 readonly 强制 cast 清除，使用
  实际可变数组类型，不留掩盖类型问题的断言。
- 初次 `build:web` 发现测试使用当前 TS target 不支持的 `Array.at()`；改为明确末项索引。随后加入
  exhaustive entity guard，避免 future union 扩展形成僵尸 fallback。
- 专项执行结果：`test:annotation-commands` 6/6、`test:timeline-timing-command` 3/3、
  `test:timeline-timing-command-apply` 3/3，`build:web` 通过，只保留既有主 chunk 大小提醒。
- `test:platform-operations` 4/4、`test:platform-drafts` 11/11、`test:platform-auto-save` 4/4、
  `test:platform-auto-save-runtime` 8/8，确认 inverse/apply 纯函数没有改变 operation 请求、IndexedDB、
  自动保存、冲突或卸载生命周期。
- `npm run test:api` 85/85；本轮无 schema/API 行为变化，真实 `api_test` PostgreSQL 上的 revision、operation
  幂等、ACL、上传、恢复、审计、维护和备份继续通过，只保留既有 pg 9 前置弃用提示。
- `npm run build` 完整通过 Prisma generation、shared、document-model、web 与 API；Vite 只保留既有主
  chunk 超过 500 kB 提醒。`git diff --check` 通过；`/api/health/ready` 返回 ready，database 1.24 ms、
  storage 0.85 ms，均为 ok。

浏览器与下一步：

- 既有 Browser 运行时仍明确禁止从错误 `data:` 页导航、读取或换用替代表面。本轮没有新增 UI，继续遵守
  限制；纯函数测试不能冒充实际多端协作验收。
- R5a2b 应基于现有 `AnnotationOperation` 幂等表设计单文件稳定 sequence、ack cursor 和 bounded replay
  page。必须保留每请求 write 权限复核、旧幂等重放先于当前 revision 拒绝的语义，并决定服务端怎样复用
  ProjectData adapter，而不是从 API 反向 import Web 源码。WebSocket/presence 仍在其后。

## 2026-08-03：R5a2b 单文件 operation 顺序与有界续读

本轮在 R5a2a commit `2381e8b` 后继续执行滚动目标。Codex 先核对 roadmap、Prisma operation 表、幂等
事务、Fastify 路由、共享 DTO 和浏览器 API client，再把被 gitignore 的 `CLAUDE_WORK.md` 整体替换为
R5a2b 当前任务书。本轮由 Codex 直接实现，没有调用 Claude Code、GLM、DeepSeek 或其他代理，也没有
新增依赖：现有 PostgreSQL 行锁、Prisma transaction、Node base64url 和 TypeScript runtime guard 已能以
更小的维护面完成该合同。

数据库迁移与并发顺序：

- `AnnotationFile` 新增 `lastOperationSequence` 计数器，`AnnotationOperation` 新增非空 `sequence`，并以
  `(annotationFileId, sequence)` 建立唯一约束。sequence 是**单文件日志接收顺序**，不是全局时钟。
- 可部署 migration 不删除历史数据：先加 nullable sequence，按每文件 `(createdAt ASC, id ASC)` 使用
  `ROW_NUMBER()` 确定回填 1..N，再把文件计数器推进到历史最大值，最后设置 NOT NULL 和唯一索引。
  `npm run test:api` 已在隔离 `api_test` schema 真实执行该 migration。
- 新 operation 仍在事务外层逐请求复核 write capability。事务先检查既有 `(文件、actor、client id)`；
  未命中才对 annotation-file 行取得 `FOR UPDATE`，锁后再次检查幂等键，再检查 base revision、原子递增
  文件计数器并创建 operation。完全相同的迟到重放在 revision 已推进后仍返回旧行和旧 sequence；同 key
  异内容继续 409，旧 revision 的新 key 继续 409。
- 第一版在文件锁和二次检查之后仍保留旧原子 upsert。自审确认此时同文件请求已经串行化，upsert 只会
  制造第二套并发语义和无意义 update，因此提交前删除，收敛为单一 `create` 路径。

读取合同与兼容边界：

- 新增 `annotationOperationPagination.ts`：默认 100、最大 200，严格接受正整数 limit；opaque cursor
  精确包含 version 1、annotationFileId 和 afterSequence，拒绝额外字段、坏 base64/JSON、未知版本、
  跨文件复用和非安全整数。cursor 不保存权限事实。
- GET operation 从旧的“createdAt 倒序最多 200 数组”改为 sequence 升序 page：`items`、`nextCursor`、
  `hasMore`。查询使用 limit + 1 判断后页；空页保留输入 cursor，因此轮询不会意外退回文件开头；每次
  请求仍实时检查 read capability。
- 共享 `AnnotationOperationRecord` 增加 sequence 和 replayability。能够通过 shared command parser 且
  action 匹配的时间命令标记 `domain_command`；legacy 摘要或历史损坏值标记 `requires_snapshot`。浏览器
  `PlatformClient` 已改用 page DTO 和 cursor/limit，但本轮没有建立轮询 hook、远端 apply 或 WebSocket。
- 文档明确区分三个事实：sequence 是服务端接收日志的顺序，cursor 是某客户端已观察的位置，annotation
  file revision 才是完整 payload 的权威保存版本。服务端当前不 apply command，所以不能把前两者写成
  “快照已确认”；这项缺口进入 R5a3。

测试过程与发现：

- 新增 cursor 纯测试，覆盖默认值、round trip、最大值、坏格式、跨文件、未知版本、零/超限/小数 limit；
  `test:annotation-operation-pagination` 2/2 通过，并加入 package scripts 与 AGENTS 命令表。
- API 集成把现有 operation 用例扩展为真实序列断言：首次/幂等重放均为 1；并发相同 key 同行同 sequence
  2；不同 actor 同 key 获得 sequence 3；同文件并发不同 key 获得连续唯一 `[4, 5]`；legacy 摘要为 6 且
  `requires_snapshot`。两项一页的续读稳定得到 `[1,2] -> [3,4] -> [5,6]`，无重复、漏项或倒序。
- 第一轮权限测试把文件直接 ACL 清空后期待 403，实际仍返回 200。检查发现账号合法继承了父目录 read；
  这是测试假设错误而非接口泄露。用例随后显式截断该文件权限继承再验证 403，并恢复继承状态，因而同时
  保住了“直接空权限不抹掉父级授权”的既有 ACL 语义。
- `npm run test:api` 最终 87/87，通过 operation、ACL、资源、上传、恢复、审计、维护、备份与对象存储全套
  回归；仍只保留既有 node-postgres 关于 pg 9 前置行为的弃用提示。

文档、审查与未实现项：

- README 增加用户可见的单文件顺序与 `requires_snapshot` 解释；state architecture 固化锁、游标和三种
  事实边界；roadmap 标记 R5a2b 完成并拆出 R5a3；AGENTS 增加分页 helper 的所有权和专项命令。
- R4/R5 受影响专项合并执行 36/36：command 6、timing extraction 3、all-or-nothing apply 3、operation
  request 4、draft 7、auto-save policy 4、runtime 8、operation cursor 2（部分测试文件包含多项断言，Node
  汇总为 36 项）。完整 `npm run build` 通过 Prisma generation、shared、document-model、web 与 API；
  Vite 只保留既有主 chunk 超过 500 kB 提醒。`git diff --check` 通过。
- 运行中的 `/api/health/ready` 返回 ready，database 2.85 ms、storage 0.55 ms。该进程仍是本轮提交前已在
  运行的 API 实例；新 migration 和新 operation 路径由隔离 `api_test` PostgreSQL 全套验证，提交后进入
  下一轮前需按开发运行流程部署 main schema/restart，不能用旧进程 readiness 冒充新代码已热加载。
- 本轮没有服务端 apply、客户端 catch-up、operation 与保存 revision 的绑定、WebSocket、presence、OT
  或 CRDT。下一轮 R5a3 必须先解决“日志已接收但完整快照保存失败/尚未发生”的明确状态，再让客户端
  消费 operation feed；不能仅凭 sequence 乐观宣称远端内容已持久化。

## 2026-08-03：R5a3a operation 与权威快照 revision 原子绑定

本轮在 R5a2b commit `a9785cf` 后自动续接活动 goal。Codex 先检查干净工作树、活动 goal、roadmap、App
唯一平台保存事务、`submitPendingOperations()`、shared save DTO、`ResourceService.saveAnnotationFile()`、
operation schema 和 R5a2b feed，再整体重写被 gitignore 的 `CLAUDE_WORK.md`。审计发现不能直接实现 HTTP
轮询/apply：现有顺序是先 POST operation、再 PUT 完整 payload，PUT 失败会留下有 sequence 的日志行，
但无法证明它进入了任何权威 snapshot。于是把 R5a3 拆为本轮 R5a3a 提交事实和下一轮 R5a3b 客户端
catch-up coordinator。本轮由 Codex 直接实现，没有调用其他代理，也没有新增依赖；PostgreSQL 事务、
Prisma 和 Node base64url 足以清晰表达该边界。

数据模型与保存事务：

- `AnnotationOperation` 新增 nullable `committedRevision`、`committedAt`，以及
  `(annotationFileId, committedRevision, sequence)` 索引。migration 对历史 operation 保持 null：旧日志
  没有证据表明进入哪一个历史 payload，不能为了得到连续图表而猜测回填。
- `SaveAnnotationFileRequest` 增加 `clientOperationIds`。App 在保存开始时固定 pending snapshot，并在 PUT
  中发送全部 covered 本地 id；这里既包含本轮刚 POST 成功的项，也包含此前 PUT 失败后已标 submitted、
  本轮不会再次 POST 的项。成功后仍只 acknowledge 本次固定集合；保存期间新编辑继续 dirty。
- Router 接受最多 500 个、满足既有幂等键安全字符集且不重复的 id。早期无 operation 的原始内部请求在
  runtime 边界仍等价为空数组，正式 TypeScript client 合同则要求显式字段；空数组支持恢复/系统类无操作
  payload 保存，不会伪造 operation。
- `ResourceService.saveAnnotationFile()` 在既有资源树/annotation-file 内容锁内，先复核 base revision，再
  一次读取当前 actor 声明的全部 operation，要求数量一致、base 一致且 committedRevision 为空。随后恢复
  快照、完整 payload revision、operation commit 字段和审计日志在同一 Prisma transaction 内写入；绑定
  update 数量不一致会抛 409 并整体回滚。保存审计只增加 revision 与 operationCount，不写 payload/命令。
- 未被某次保存声明的旧-base operation 永久保持 accepted。后续 revision 不会自动认领它；这是防止其他
  actor 或失败编辑被错算进快照的必要边界，后续治理可做过期诊断，但不能后台猜测提交。

双 feed 与快照 cursor：

- R5a2b acceptance feed 保持按文件接收 sequence，用于诊断全部日志。新增独立 committed feed，只返回
  committedRevision 非空行，并按 `(committedRevision ASC, sequence ASC)` 分页。两者不共用 cursor。
- committed cursor version 1 精确绑定文件、保存 revision 与同 revision sequence，默认/上限仍为 100/200；
  坏 base64/JSON、额外字段、未知版本、跨文件、负数/越界整数和坏 limit fail closed。快照 cursor 使用当前
  revision 加数据库 Int 最大 sequence，表示“该完整 payload 已经包含到此 revision，不应再重放”。
- 每个 `AnnotationFile` 响应新增 `operationCursor`；committed page 额外返回 `currentRevision`。因此下一轮
  可识别三类情况：有 committed commands、出现 `requires_snapshot`，或 revision 已推进但没有 operation。
  operation 查询先执行、文件 revision 后读取，避免响应声称的 revision 落后于已经返回的提交事实；若
  两次查询间发生新保存，客户端最多走保守快照刷新，不会静默漏 apply。
- operation record 增加 `commitState`、`committedRevision/At`。replayability 规则不变：合法时间命令为
  `domain_command`，legacy/历史损坏值为 `requires_snapshot`。本轮 PlatformClient 只暴露 committed API，
  没有 timer、远端 apply、WebSocket 或 UI 状态。

测试、构建与实现中的修正：

- 新增 committed cursor 纯测试 2 项，覆盖默认起点、同 revision 页尾、snapshot 起点、跨文件、坏格式、
  未知版本、limit 边界和数据库 Int 上限；加入独立 npm script 与 AGENTS 命令表。
- API 集成新增独立标注文件场景：POST 后为 accepted/null；保存只提交声明的 A，未声明 sequence 2 保持
  orphan；revision 1 cursor 可读 A、revision 2 cursor 跳过 A；orphan 不能在 base 2 被认领且失败保存不改
  payload/revision；sequence 3 legacy 提交到 revision 3 后，committed feed 能越过 sequence 2 空洞并标记
  requires_snapshot；管理员不能绑定学生 operation；缺失 id 失败后同 operation 可在同 base 重试成功；
  一项一页稳定得到 A/C/student/retry，坏 cursor 400，截断继承后的无 read 为 403。
- `npm run test:api` 在隔离 `api_test` PostgreSQL schema 真实应用第 11 个 migration，最终 90/90。revision、
  operation、ACL、恢复、确认、上传、审计、维护、备份和对象存储回归全部通过，只保留既有 pg 9 前置
  弃用提示。
- 第一次完整构建发现三个测试夹具仍手写旧 `AnnotationFile` 且缺少 operationCursor。没有把新字段改成
  optional 来掩盖问题，而是给 merge preparation、draft conflict、recovery snapshot comparison 夹具补上
  明确 cursor。随后 `npm run build` 通过 Prisma generation、shared、document-model、web 和 API；Vite
  只保留既有主 chunk 超过 500 kB 提醒。
- 提交前受影响专项 35/35：committed cursor 2、merge preparation 4、autosave policy 4、autosave runtime 8、
  platform draft 6、draft conflict 3、recovery comparison 4、platform operation 4；`git diff --check` 通过。
  运行中的旧 API 实例 readiness 仍为 ready，database 8.93 ms、storage 2.61 ms；它没有热加载本轮代码，
  新 migration/事务行为以 `api_test` 真实执行结果为准，下一轮运行验收前需部署 main schema 并重启。

文档与下一步边界：

- README 解释原子绑定和双 feed；state architecture 新增 R5a3a 事实边界；roadmap 标记 R5a3a 完成并
  细化 R5a3b；AGENTS 增加 committed cursor 与 ResourceService 事务所有权。本节同时记录计划、实际实现、
  测试和未完成项，不把 `CLAUDE_WORK.md` 当历史日志。
- 既有 Browser 会话仍明确禁止从错误 `data:` 页导航、读取或切换替代表面。本轮无新 UI，遵守限制，未
  把 Node/API 测试冒充浏览器验收。
- R5a3b 必须先实现纯 catch-up 状态机：文件切换/dispose、single-flight、分页耗尽、dirty/pending 阻断、
  requires_snapshot、revision gap 和 precondition failure 都要有确定结果。只有 clean 且完整的领域命令页
  才可评估 R5a2a apply；仍不在同一轮引入 WebSocket/presence/OT/CRDT。

## 2026-08-03：R5a3b clean-only HTTP operation catch-up

本轮由用户确认开始 R5a3c2（当前 roadmap 中的有效编号为 R5a3b）并特别提醒必须写 Development Log。
Codex 沿活动 goal 的逐轮流程，先读取干净工作树、R5a3a commit `51a4e1b`、roadmap、被忽略的
`CLAUDE_WORK.md`、PlatformWorkspace 会话构造、App 唯一保存事务、document state、PlatformClient、
committed feed DTO 与 R5a2a ProjectData adapter，再把 `CLAUDE_WORK.md` 完整改写成当前任务。计划明确把
纯 feed 判定、timer/single-flight 运行时、薄 React hook、document clean 门禁和 App 快照降级分开；没有
调用其他 agent，也没有新增依赖，现有 React、TypeScript 和 PlatformClient 已足以表达该协调边界。

纯追赶与运行时：

- 新增 `platformOperationCatchUp.ts`。一次检查从打开文件给出的 snapshot cursor 开始，每页最多 200、
  最多 10 页；逐页验证文件 id、committed/accepted 状态、安全整数、revision/sequence 严格顺序、cursor
  前进和服务器 revision 单调性。调用方不能把坏页修补成看似连续的数据。
- coordinator 要求 `knownRevision + 1 .. currentRevision` 每个 revision 都至少有 committed operation。
  无 operation 保存、查询间竞态造成的缺号、legacy/坏命令、分页预算耗尽和 before precondition 失败都返回
  `requires_snapshot`。网络 reject 则交给运行时重试，不和语义降级混为一类。
- 全部 operation 都是 timing domain command 时，先在局部 project 上按 committed revision/sequence 顺序
  调用 R5a2a adapter；直到最后一条成功才返回新 ProjectData。测试专门构造“第一条可 apply、第二条 before
  mismatch”，确认 coordinator 只返回快照要求，输入项目及任何半成品都不外泄。
- 新增 `platformOperationCatchUpRuntime.ts`，集中拥有一个 timer、一个在途 check/apply、session generation、
  dispose 和 2 秒网络重试。clean 会话首次立即检查，稳定后每 5 秒检查；blocked/offline 不留隐藏 timer。
  文件、revision 或 cursor 在请求中改变时，旧 generation 的结果被丢弃，并立即检查新会话。
- 自审发现最初的 generation 只在文件身份变化时递增：若请求期间先变 dirty、后又 clean，迟到响应会被
  忽略但新会话要多等一个完整周期。实现随后把“从 eligible 进入 blocked/offline”也作为 generation
  失效事件；旧 flight 结束后对最新 clean facts 立即重新检查。
- `usePlatformOperationCatchUp.ts` 仅以 refs 转发最新 check/apply/error callback，并兼容 React 18 Strict
  Effects setup-cleanup-setup；没有把 timer 或网络状态塞回 App。

文档状态与 App 接线：

- `useProjectDocumentState()` 新增 `replaceCleanProjectFromRemote()`。最终替换前再次要求 current/saved 相等、
  pending 为空、transient 为空且 sync status 为 saved；成功时 current/saved 一起推进并清空旧 undo/redo，
  保留本地 track-snap 偏好，不生成 history、operation 或 dirty。纯资格 helper 有独立组合测试。
- `syncStateRef` 在 `setSyncStatus()` 与远端替换中同步更新。该修正覆盖同一事件循环内“保存已经开始但 React
  尚未重渲染”的窄窗口；不能只依赖下一 render 才更新的 state 作为最终覆盖门禁。
- `PlatformEditorSession` 现在携带 operationCursor。普通保存通过现有 `onAnnotationFileSaved()` 同步 revision、
  cursor 和文件名；领域命令追赶使用新增的元数据推进回调，只更新 revision/cursor。
- 第一版命令追赶成功后为了构造完整 `AnnotationFile` 又执行一次 GET。自审确认这是错误的双重读取：本地
  已替换后 GET 失败会造成元数据不同步，也可能读到比已 apply 命令更晚的 revision。提交前将其删除，命令
  路径只提交已经验证的 revision/cursor；完整 GET 只用于明确的 `requires_snapshot`。
- App 用 session cursor 初始化 `remoteOperationCursor`，普通保存成功也更新它。clean-only 阻断范围覆盖
  dirty、pending、transient、待确认 merge、行内逐字/自定义文字编辑、saving/conflict/error 和实际保存
  flight；只读 clean 文件也可以追赶，因为 read 权限不应意味着永远停留在旧快照。
- 快照降级统一调用现有 `getAnnotationFile()` 与 `hydrateProjectForClient()`，没有复制第二条 JSON migration
  路径。GET 返回后再次核对请求 revision/cursor，并由 document gate 复核 clean；等待期间发生的编辑优先
  保留，响应被丢弃，不做隐式 rebase。远端推进后刷新 confirmation facts，使旧 revision 确认及时变 stale。
- 网络失败只写开发者 warning 并等待短退避，不把 clean 文档标成保存 error/conflict。当前尚无远端同步
  toast 或在线成员 UI；这是 HTTP 追赶地基，不冒充实时协作。

测试、构建与修正：

- 新增 `test:platform-operation-catch-up`，共 11 项：跨页连续 revision 顺序重放、up-to-date、revision gap、
  requires_snapshot、前置失败无半成品、坏顺序/跨文件/不前进 cursor、分页预算、首次立即检查、周期与
  single-flight、blocked/offline 恢复、文件切换/dispose 迟到响应、网络短退避和 document clean 门禁。
- 第一次专项 10/10 通过，但 Web build 发现当前 TS target 不提供 `Array.prototype.at()`。实现改回明确的
  `operations[operations.length - 1]`，没有为了一个调用提高整个项目 lib target；随后专项扩为 11/11，
  Web build 通过。
- 受影响回归通过：catch-up 11/11、auto-save runtime 8/8、platform operation 4/4、platform draft/recovery
  11/11、annotation confirmation view 5/5，共 39 项。完整 API 回归在隔离 `api_test` PostgreSQL schema
  验证 11 个 migration，90/90 通过；只保留既有 node-postgres pg 9 弃用提示。
- 完整 `npm run build` 通过 Prisma generation、shared、document-model、Web 2045 个模块转换和 API 类型
  构建；仅保留既有主 chunk 824.81 kB / gzip 252.28 kB 提醒。`git diff --check` 通过。运行中的旧 API
  readiness 为 ready，database 5.32 ms、storage 2.60 ms；它没有热加载本轮 Web 代码，R5a3b 的行为以纯
  客户端专项和 API committed-feed 全套回归为准。
- 既有 Browser 会话仍明确禁止从错误 `data:` 页导航、读取或切换替代表面。本轮没有新 UI，未绕过限制，
  也未把 Node/API 测试描述成浏览器验收。

文档和下一步：

- README 说明 clean-only HTTP 追赶与暂停边界；state architecture 增加 R5a3b 的纯协调器、document gate
  和快照降级；AGENTS 增加三个新模块所有权与专项命令；roadmap 标记 R5a3b 完成。
- 下一轮 R5a4a 先扩展稳定 id 的文本/标签/类型内容更新命令，复用严格 before/after、precondition、inverse
  和 all-or-nothing ProjectData adapter。创建/删除、轨道结构、递归分叉、WebSocket、presence、OT/CRDT
  继续分阶段处理，不能在一轮里混成无法审查的大命令协议。

## 2026-08-04：R5a4a 稳定实体内容更新领域命令

本轮在 R5a3b commit `1e41077` 后沿活动 goal 自动续接。Codex 先核对工作树、roadmap、R5a3b committed
catch-up、shared command union、ProjectData timing adapter、App 行内编辑路径、IndexedDB 草稿边界和 API
repository，再把被 gitignore 的 `CLAUDE_WORK.md` 整体替换为 R5a4a 当前任务书。任务范围只包含稳定实体
已有字符串字段：sentence.text、character.char、action.label、custom-block.text/type 和
attached-point.label；创建删除、轨道结构、四声、唱腔、工尺符号、批量导入、undo/redo、WebSocket 与
presence 明确留在后续。本轮由 Codex 直接审查和实现，没有调用 Claude Code、GLM、DeepSeek 或其他代理；
现有 TypeScript/shared 合同已足够清晰，没有新增依赖。

共享协议与完整差异门禁：

- shared 新增 `annotation.items.content.update` 判别命令以及 timing/content envelope 联合。内容 item 使用
  `entityType/entityId/trackId/field/before/after`：句 text 与逐字 char 禁止 trackId；动作 label、自定义块
  text/type 和附属点 label 必须带安全 trackId。parser 同时拒绝额外字段、非法 id、错误字段配对、空项、
  重复目标、no-op、超过 500 项及超过 2000 UTF-16 code units 的字符串。
- 通用 `parseAnnotationCommandEnvelope()` 只读取 command.type 并分派给严格单域 parser，没有把原 timing
  parser 改成宽松联合解析。builder 对目标确定排序并复制输入；inverse 按命令种类交换 before/after；内容
  assessment 与 timing 一样先收集全部 missing/mismatch，再决定 ready，禁止部分应用。
- 第一版 `buildProjectAnnotationContentCommand()` 只权威读取声明目标的 before/after，却没有证明同一次
  `nextProject` 不含未声明变化；这与任务书的安全边界不一致。自审后加入“命令重建完整 next”门禁：
  builder 调用与 replay 相同的纯 immutable writer 从 base 重建项目，再用引用优先的无环深比较检查完整
  ProjectData。媒体 URL 等巨大未变字符串按引用/值立即返回，变化数组才递归；任何时间、结构或派生字段
  差异都会返回 null，使 document state 继续记录 legacy snapshot operation。
- 内容 writer 按集合归组，句、逐字、动作、自定义块和内建/自定义父轨下的附属点只遍历一次相关集合。
  `annotationContentCommandApply.ts` 先 strict parse，再 resolve 全部 actual 并执行 shared precondition，ready
  后复用同一个 writer。删除了最初“用空 actuals 人为制造 blocked 结果以取得 envelope”以及第二套重复
  map 写入逻辑。`annotationCommandApply.ts` 只负责 timing/content 判别分派，R5a3b coordinator 因而可以
  在同一 committed revision 链中顺序重放两类命令。

编辑器、草稿和服务端接线：

- App 的逐字 char 提交显式同时记录同步得到的 sentence.text；动作 label、自定义文字块 text、自定义块
  type 和附属点 label 只在 changes 恰好包含一个对应字段时生成内容命令。完整重建门禁仍会拦截任何隐藏
  派生变化，不能由 UI 的 key 判断替代协议证明。context-menu 的动作/块类型/附属点标签入口复用这些函数。
- 附属点原实现通过轨道 updater 隐藏了 base/next，第一版接线因此复制了内建轨与自定义轨两套嵌套 map。
  自审将其收敛为 `buildProjectWithUpdatedAttachedPointTrack()`，轨道设置和单点编辑共用同一项目变换。
  随后又发现 recordHistory 提交错误地显式采用已经 transient 更新的 currentProject 作为 base，会破坏原始
  undo 基线并让内容命令失去真实 before；最终恢复 `transientProjectRef.current ?? currentProject` 为权威
  base。附属点 time 本轮仍是 legacy，不用不准确注释冒充已迁移 timing 路径。
- `PlatformDraftRecord` 的 unknown 规范化最初仍把领域类型硬编码为 timing。专项审查后增加 content 类型和
  统一 domain-type set；内容 envelope 可完整往返 IndexedDB，领域 operation 缺 envelope、类型不一致或
  legacy 夹带 envelope 继续 fail closed。
- API repository 的 replayability 从 timing action 硬编码改为“shared parser 成功且 command.type 等于
  row.action”。Fastify 仍只校验、幂等记录并在完整 payload 保存时绑定 committed revision，不直接把命令
  写入 AnnotationFile payload。集成测试同时验证合法内容命令得到 `domain_command`，内容 envelope 冒充
  timing action 返回 400。

测试过程、发现与验证：

- shared 首轮测试出现 1 项失败：测试假设 inverse 的第一个 item 是 custom-block，但稳定 target key 排序
  实际把 character 放在前面；修正断言后 8/8。随后补齐内容字段/scope、额外字段、重复、no-op、长度、
  inverse、action 一致和全量前置条件覆盖。
- Web 首轮构建暴露 TypeScript 对 custom-block 的 `text | type` 联合不能在链式条件末尾收窄到 never。
  实现改为先按 custom-block 实体分支、再按 field 分支，而不是断言类型；没有使用 `any` 或放宽 strict。
- 新内容 adapter 测试 3/3：五类实体同批 apply、inverse 恢复、输入不可变；错轨/before 冲突 all-or-nothing；
  缺失目标及“char 与 startTime 同时变化”的合同外项目拒绝生成命令。
- catch-up 11/11 将原跨页第二 revision 改成 content command，真实验证 timing 移动后继续改变逐字文字；
  最终 ProjectData 同时含两类结果。既有第二项前置失败测试继续证明 coordinator 不泄漏第一项半成品。
- 受影响专项最终 44/44：shared command 8、timing builder 3、timing adapter 3、content adapter 3、平台
  operation 4、平台草稿/恢复 12、catch-up/runtime/document gate 11。完整 API 在隔离 `api_test` PostgreSQL
  schema 应用 11 个 migration 后 90/90，通过资源、ACL、revision、operation、恢复、确认、上传、审计、
  维护、备份和对象存储回归；只保留既有 node-postgres 关于 pg 9 的弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 2048 个模块转换和 API 类型构建；
  Vite 只保留既有主 chunk 831.87 kB / gzip 253.81 kB 提醒。`git diff --check` 通过。运行中的旧 API 实例
  readiness 仍为 ready，database 4.33 ms、storage 1.83 ms；它启动于本轮代码之前，所以只证明本地依赖
  可用，R5a4a 服务端行为以隔离数据库 API 全套回归为准。
- 既有 Browser 自动化禁令仍有效。本轮没有新增 UI，也不需要视觉布局验收；没有绕到 Chrome、替代浏览器
  或其他自动化表面，并且没有把纯函数/API 测试描述成浏览器手测。

文档、自审与下一步：

- README 更新用户可见 operation/catch-up 能力；state architecture 新增 R5a4a 合同、完整差异门禁和混合
  replay；roadmap 标记 R5a4a 完成并把下一步推进到 R5a4b；AGENTS 增加三个内容命令模块的所有权、builder
  安全不变量和专项命令。本 Development Log 记录计划、实际实现、修复与测试，不把 CLAUDE_WORK 当日志。
- 本轮没有重复 parser、第二套 apply writer或 timing-only replayability hardcode；新增逻辑块均有准确中文
  功能注释。`annotationContentCommand.ts` 的深比较只用于低频 pointer-up/表单提交的协议证明，不进入
  pointer-move 热路径。
- R5a4b 必须先按实体依赖设计 create/delete 命令：明确 id 生成、集合插入顺序、父子依赖、inverse、
  已存在/已删除前置条件和完整 next 重建。轨道结构、递归分叉及批量导入仍不能伪装成普通块创建删除；
  WebSocket/presence 也应等稳定 mutation 合同继续扩展后再进入。

## 2026-08-04：R5a4b1 自定义块与附属点叶实体生命周期命令

计划、审计与范围修正：

- 本轮从 R5a4a commit `31c7ce9` 继续活动 goal。Codex 先确认工作树干净、分支领先远端 2 个提交，再读取
  roadmap、shared command union、ProjectData 类型、App 全部创建/删除入口、项目文件迁移和 committed
  catch-up。随后把 gitignore 中的 `CLAUDE_WORK.md` 整体替换为 R5a4b1 当前任务书，并先在 roadmap 把
  R5a4b 拆成叶实体、句/工尺依赖闭包、复合工尺/板眼三个子阶段。
- 初始计划把 `actionAnnotations` 当作叶实体。代码审计发现当前文件格式只保留内建逐字轨；旧内建动作轨和
  `actionAnnotations` 会在 `normalizeImportedProjectFile()` 中迁移为 custom action track/block，随后把
  action 数组归一化为空。继续给该数组增加生命周期协议会扩展僵尸模型。任务书、roadmap 和实现因此在
  写协议前修正为当前 UI 真正使用的 custom-block 与 attached-point。
- custom-block 可能拥有工尺子块，所以 R5a4b1 只接受“没有关联工尺级联”的叶形态。删除若同步移除工尺、
  混合多选还改变字符/板眼或任何其他项目字段，完整 next 门禁返回 null 并保留 legacy snapshot。逐字/句、
  工尺引用与板眼区段留给后续显式依赖闭包，而不是被宽松 CRUD 悄悄遗漏。
- 本轮由 Codex 直接规划、实现、自审和验证，没有调用 Claude Code、GLM、DeepSeek 或其他代理。纯
  TypeScript 集合规划足够清晰，没有新增依赖。

共享合同与集合顺序语义：

- shared 新增 version 1 `annotation.items.lifecycle.update`，并加入唯一 `ANNOTATION_DOMAIN_COMMAND_TYPES`、
  envelope/command union、通用 parser、inverse 和 API action/payload allowlist。首批 item 只允许
  custom-block 与 attached-point，必须携带安全 `entityId/trackId`，before/after 恰有一侧为 null；两侧
  同空、同存或借生命周期命令更新实体均 fail closed。
- 非空状态包含完整规范实体和位置。custom block 快照保留起止时间、文字或动作轨的 null text、type、
  branchScope/laneIds、branchGroupId 和 branchParentBlockId；attached point 保留 id/time/label。可选字段统一
  编码 null，builder 深复制 laneIds，避免不同客户端用“缺字段/空字段”制造两个 operation 指纹。
- 位置状态不是 UI 装饰，而是 `index/collectionLength/previousEntityId/nextEntityId` 四项协作事实。parser
  校验边界索引必须对应 null 邻居、同父集合长度一致、before/after 索引唯一，以及长度变化等于创建数减
  删除数。最多 500 项；实体、分叉 id、字符串、有限非负时间、区间、额外字段和重复目标均严格验证。
- 生命周期 assessment 一次区分 parent_missing、target_presence_mismatch 和 state_mismatch。完整实体和位置
  都匹配前才 ready；inverse 只交换 before/after 并重新经过 builder/parser，因此删除可以恢复原索引而非
  追加到尾部。

ProjectData builder、adapter 与编辑器接线：

- 新 `annotationLifecycleCommand.ts` 唯一解释父集合和快照。自定义块要求唯一 custom track id；附属点在
  内建/自定义父轨的所有 point track 中要求 id 唯一；重复父或重复实体不会“取第一个”。builder 从 base/
  next 权威读取两侧状态，拒绝双方同存/同缺，再调用纯 apply 重建完整 next。
- 同一集合的多项变化不是逐个 splice：先移除全部 before 目标，按 after 的最终 index 占位，再以原顺序
  填入未修改实体，最后复核集合长度和新实体的前后邻居。任一集合计划失败返回 null，其他集合也不落地。
  `annotationLifecycleCommandApply.ts` 固定执行 strict parse、resolve all parents/actuals、assess all、grouped
  immutable apply；通用 dispatcher 仅新增 lifecycle 判别，不复制单域逻辑。
- R5a4a 的 ProjectData 深比较抽到 `projectValueEquality.ts`，内容和生命周期 builder 共用。它保持引用优先、
  数组有序和对象自有字段精确比较，没有新增 JSON.stringify 或 target-only 第二路径。
- App 新增一个 `commitProjectWithLifecycle()` 边界。自定义文字/动作块创建、无工尺级联单删、附属点创建/
  单删，以及多选中的 custom-block/attached-point 都只声明候选目标；builder 证明不了完整 next 时仍调用
  原 `commitProject` legacy 路径。混合多选因此不会只记录一半事实。
- 自审发现候选最初从 `${trackId}:${entityId}` 复合 key 再拆分，但协议允许 id 含冒号；该实现会错误寻址，
  在测试前改为直接从结构化 TimelineSelectionItem 生成目标。创建 custom block 也从写入
  `branchScope: undefined` 改为条件 spread，保证内存对象、命令重建和 JSON 往返使用相同字段集合。
- `actionAnnotations` 的既有时间/内容兼容代码本轮没有顺手大删，避免把协议阶段扩成数据模型迁移；但没有
  新增任何 action lifecycle 调用或测试，AGENTS 已明确当前功能必须面向 custom block。

草稿、API 与 catch-up：

- IndexedDB 草稿本来已复用领域命令总表和通用 parser，无需增加新的类型硬编码。新增测试证明 lifecycle
  完整实体和位置可以 unknown 校验后原样往返，坏字段仍拒绝。
- API repository 已在 R5a4a 使用通用 parser 判定 replayability，本轮没有增加第三个 action 特判。真实
  Fastify 集成测试新增合法 lifecycle operation，得到连续 acceptance sequence 8 和 `domain_command`；
  before/after 同空的坏命令返回 400。服务端仍不 apply payload。
- catch-up 用例从 timing/content 两段扩为跨页 timing/content/lifecycle 三个连续 revision。新附属点只在
  既有 point track 基线中创建，最终局部项目同时包含三类结果；生命周期父容器、位置或前置状态失败仍由
  通用 adapter 返回 blocked，coordinator 整链降级权威快照且不泄漏前面半成品。

测试、构建与验收：

- shared command 11/11：生命周期 build/parse/inverse/precondition、坏位置、额外字段、重复目标，以及原
  timing/content 合同全部通过。生命周期 ProjectData 5/5：动作型 custom block 创建/inverse、文字块文本
  与递归分叉归属、多附属点同集合删除/inverse、错父/位置漂移/已存在冲突、合同外变化和工尺级联回退。
- 受影响专项共 50/50：shared 11、timing builder 3、timing apply 3、content 3、lifecycle 5、platform
  operations 4、catch-up/runtime/document gate 11、draft/conflict/store/recovery 13。`git diff --check` 通过。
- `npm run test:api` 在真实 PostgreSQL `api_test` schema、11 条 migration 上 90/90，通过资源、ACL、保存、
  operation、恢复、确认、上传、审计、维护、备份和对象存储全套；只保留既有 pg 9 弃用提示。
- `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。Web 转换 2051 模块，主 chunk
  842.61 kB / gzip 256.52 kB，只保留既有大包提示。没有一般 lint 脚本。
- 测试前检查 `127.0.0.1:4317` 时没有 API 进程监听；这不是 readiness 依赖失败。最终用当前工作树执行
  `npm run dev:api`，shared/document-model 预构建后 Fastify 正常监听 4317；`/api/health/ready` 返回 ready，
  database 3.81 ms、storage 1.31 ms。既有浏览器自动化禁令继续有效，本轮没有绕用 Chrome/其他浏览器，
  也没有把纯函数和 API 回归冒充人工 UI 验收。

文档、自审与下一步：

- README、state architecture、roadmap 和 AGENTS 已同步第三类命令、位置不变量、完整差异门禁、新模块
  所有权、专项测试命令与 legacy action 迁移事实；本 Development Log 记录计划修正、实际实现、问题和
  验证，`CLAUDE_WORK.md` 仍只保存当前任务。
- 当前没有重复 ProjectData deep equality、lifecycle parser、apply writer或 repository action hardcode；新
  逻辑块均有中文功能注释。生命周期生成发生在创建/删除提交边界，不进入 pointer-move 热路径。
- 下一轮 R5a4b2 需要先列出逐字创建/删除对句文本、句时间、空句保留策略和工尺子块的完整闭包，再决定
  custom block 工尺级联能否复用同一高层事务命令。不能只把 Gongche id 加进叶命令；板眼对工尺符号的
  引用策略也必须在 R5a4b3 前固定。

## 2026-08-04：R5a4b2 句、逐字与工尺依赖事务

计划校正与设计决策：

- 用户确认的阶段名为 R2.3c2，但仓库 roadmap、代码合同与前两轮提交显示 R2.3c2 已经完成，当前连续阶段
  实际是 R5a4b2。Codex 没有重复旧阶段或改写已经稳定的资源管理功能，而是先读取 roadmap、R5a4b1
  lifecycle 合同、句/逐字同步路径、工尺父子引用和全部创建/删除入口，再把 gitignore 中的
  `CLAUDE_WORK.md` 整体重写为本轮 R5a4b2 任务书；roadmap 同步记录实际阶段，避免后续代理继续使用错误
  编号。
- 单条 `annotation.items.lifecycle.update` 只能证明一个集合内的存在性和位置变化，不能原子表达“逐字块
  创建 + 句文本/时间更新”“删除最后一个逐字块 + 删除空句 + 删除其工尺块”等跨集合依赖。为此新增
  `annotation.transaction.apply`：它不是另一套宽松 CRUD，也不直接保存 ProjectData，而是把已经严格
  验证的 content、timing、lifecycle 叶命令按顺序组成一个有界事务。任一子命令解析、前置条件或 apply
  失败，整个事务返回 blocked，不泄漏前面子命令形成的半成品。
- 事务最多包含 20 个子命令，禁止递归事务，并复用各叶命令的字段和项目数量上限；总预算还会展开计算
  工尺块内部的 symbol 数量，避免用一个大工尺快照绕过 operation 限制。inverse 反转子命令顺序并逐条
  求逆，因此“先改句、再建字”的正向操作会变成“先删字、再恢复句”的安全逆操作。
- 本轮没有引入依赖，也没有另造 parser、catch-up 协议或服务端 ProjectData writer。API 仍只校验和记录
  versioned domain command；客户端现有 bounded catch-up 通过统一 parser/dispatcher 原子回放事务，服务端
  直接应用命令仍属于后续 roadmap。

共享合同与 ProjectData 原子适配：

- lifecycle 快照扩展到 sentence、character 和 Gongche block。逐字快照保留完整 tone 字段；工尺快照保留
  `parentTrackId`、父块、起止时间、原始 notation 和每个 symbol 的完整结构；句、逐字和工尺都是全局物理
  集合，不能误按 UI trackId 拆成多个保存数组。custom block 和 attached point 则继续按父轨集合分组。
- `annotationLifecycleCommand.ts` 统一负责五类实体的权威查找、完整快照、位置重建和最终引用校验。逐字的
  `lineId` 必须指向最终项目中存在的句；工尺父块必须在最终逐字或 custom-block 集合中存在。父实体和子
  实体可以在同一事务里一起创建或删除，但 apply 后若留下悬空引用则整批拒绝。
- 内容 builder 新增只生成叶 envelope 的内部入口，生命周期 builder 同样可生成尚未要求“单命令完整
  next”的 envelope；原有公开严格 builder 仍保留完整 next 重建门禁。新
  `annotationTransactionCommand.ts` 只负责声明 content、timing、lifecycle 目标，按内容、时间、生命周期
  顺序构建子命令，再用纯 apply 重建完整 ProjectData 并深比较 next。任何未声明变化都会让 builder 返回
  null，编辑器安全回退既有 legacy snapshot，而不是写入残缺领域事实。
- `annotationTransactionCommandApply.ts` 是事务唯一 ProjectData adapter。它在局部 project 值上顺序调用
  三个叶 adapter；直到全部成功才返回新项目。通用 dispatcher 只增加一个事务分派，不复制各领域实体
  写入逻辑。

编辑器真实路径接线：

- 在已有句中创建逐字块时，事务同时记录句文本、句时间和逐字生命周期；创建首个逐字块及新句时，句与
  逐字由同一 lifecycle 事务建立。显式创建工尺块改为 Gongche lifecycle 命令，不再只留下 legacy 摘要。
- 单个逐字删除会同时处理该字的工尺块、剩余句文本/时间同步，以及最后一个字删除后空句的生命周期；
  custom block 删除若带有关联工尺也使用同一事务。显式删除工尺块直接记录完整 lifecycle 快照。
- 多选删除先收集字符、自定义块、附属点及其依赖工尺，再推导被清空的句和仍存句的内容/时间变化，最后
  由完整差异门禁证明整个 next。若多选还包含尚未迁移的动作或板眼变化，事务无法重建完整项目，会明确
  回退 legacy snapshot；没有把已迁移部分伪装成一次完整领域操作。
- 接线仍只发生在 pointer-up、菜单命令和表单提交边界，不进入拖拽 pointer-move 热路径；时间轴吸附、选择、
  播放和渲染逻辑没有被这轮协议改动触碰。

实现过程中发现并修复的问题：

- 一次 App 补丁最初命中了附近的粘贴提交块，把普通 `commitProject(nextProject)` 误换成字符事务入口。
  TypeScript 构建立即暴露未定义变量；Codex 回读上下文后恢复粘贴路径，并只修改真正的逐字创建入口。
- lifecycle 的泛型 scope 在 sentence/character/Gongche 全局集合与按轨集合之间产生 TypeScript 收窄错误。
  最终用有明确返回类型的 overload 表达两类父集合，没有改成 `any`、类型断言堆叠或复制五套 apply。
- 新测试最初使用 `Array.prototype.at()`，但 Web 当前 TypeScript target 不包含该 API；测试改用稳定索引，
  没有为了一个测试抬高整站 target。
- 自审发现事务 item 总预算最初只计 Gongche block，不计其嵌套 symbols。parser 随即改为展开计数并增加
  回归，防止超大工尺符号数组绕过上限。
- 工尺在 ProjectData 中是一个全局数组，`parentTrackId` 是引用作用域而不是物理集合分片。初版集合事实
  分组沿用了 custom-block 的 track 分组思路，审查后改为全局集合重建，否则跨轨工尺会出现错误长度和
  邻居事实。

测试、构建与运行验收：

- shared command 13/13，通过事务严格解析、禁止递归、子命令/总项目预算、逆操作和原三类叶合同回归。
  lifecycle adapter 7/7，新增句与逐字同批创建、工尺完整 symbol 快照和父引用校验；transaction adapter
  6/6，覆盖已有句建字、新句建字、删字并同步句、删除最后一字/句/工尺、custom block 工尺级联，以及
  中途前置条件失败时不产生半成品。
- 受影响专项共 64/64：shared 13、timing builder 3、timing apply 3、content 3、lifecycle 7、transaction
  6、platform operations 4、catch-up/runtime/document gate 11、draft/conflict/store/recovery 14。草稿新增
  事务 unknown 校验往返；跨页 catch-up 现在连续回放 timing/content/lifecycle/transaction 四个 revision。
- `npm run test:api` 在真实 PostgreSQL `api_test` schema 应用 11 条 migration 后 90/90，覆盖合法事务
  operation 的 domain-command 接受和坏 lifecycle 请求拒绝，并完整回归资源、ACL、revision、恢复、确认、
  上传、审计、维护、备份和对象存储。仅保留既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 与 API；Web 转换 2053 个模块，主
  chunk 853.13 kB / gzip 258.73 kB，仅保留既有大包提醒。`npm run build:api` 和 `git diff --check` 也通过；
  仓库仍没有一般 lint/full-test 聚合脚本。
- 最终用当前工作树重启 `npm run dev:api`，Fastify 正常监听 4317；`/api/health/ready` 返回 ready，database
  3.61 ms、storage 1.07 ms。依照既有禁令没有调用浏览器自动化，本轮无新增视觉布局，也没有把纯函数、
  PostgreSQL API 回归或 readiness 冒充人工浏览器验收。

文档、自审与下一步：

- README、state architecture、roadmap 和 AGENTS 已同步事务语义、句/逐字/工尺生命周期覆盖、模块所有权、
  catch-up 行为和新专项命令。本 Development Log 详细记录阶段校正、设计取舍、实际接线、修复和验证；
  `CLAUDE_WORK.md` 继续只保存当前轮任务，不承担历史日志。
- 自审未发现第二套 parser/apply writer、未受完整差异门禁保护的部分事务、递归事务或遗留的错误分组逻辑。
  新逻辑块均有中文功能注释。已知 legacy 回退仍包括板眼复合变化、部分动作兼容字段及更复杂的工尺 symbol
  内部编辑，这些没有在本轮用宽松命令偷渡。
- 下一轮 R5a4b3 应先审计工尺 symbol 内部编辑和板眼复合实体的真实 App 写路径、父子引用、derived review
  元数据及 inverse 边界，再决定扩展现有 lifecycle/transaction 还是增加更合适的领域命令；必须继续复用
  完整差异门禁和原子 transaction，不能为板眼建立第二套追赶或保存协议。

## 2026-08-04：R5a4b3 工尺符号与板眼复合实体命令

计划与实际范围：

- 本轮先按 roadmap 和 R5a4b2 的遗留边界重写 `CLAUDE_WORK.md`，只处理工尺 symbol、板眼 mark/section
  三类复合实体以及它们之间的引用，不提前把轨道结构、递归分叉、整轨删除或批量导入伪装成普通 CRUD。
  实际实现与计划一致：补齐稳定身份、完整状态替换、实体创建删除、板眼断链事务、草稿/API/catch-up
  往返，并保留无法由完整领域命令证明的写路径为 legacy snapshot。
- 这三类实体不能只更新一个展示字段。工尺 symbol 包含时间和演唱记号等耦合状态；板眼 mark 同时包含
  区段、工尺块、单/多 symbol 引用和人工复核元数据。因此新增 `annotation.items.state.update`，保存同一
  稳定实体的完整 before/after 快照；创建、删除和集合位置仍由 lifecycle 表达，避免把更新伪装为删后重建。
- 本轮没有引入新依赖，没有建立第二套网络协议、草稿格式或服务端 payload writer。服务端继续严格校验、
  接受和记录领域命令，权威项目内容仍由 revision-checked snapshot save 提交。

共享合同、稳定身份与原子适配：

- shared 命令合同新增 state envelope、严格 unknown parser、确定性 builder/inverse、全目标 before 前置检查、
  action allowlist 和总实体预算；transaction 叶命令扩展为 content、timing、state、lifecycle。工尺 symbol
  的协议 scope 是父 Gongche block id，板眼 mark/section 是项目级集合，三类 after 都必须保持相同实体 id。
- target key 从冒号拼接改为 JSON 元组。协议允许合法 id 含冒号，旧拼接会让不同 `(entityType, trackId,
  entityId)` 组合碰撞并被误判重复；新键同时用于 timing/content/state/lifecycle 的排序和前置条件匹配，且
  不进入持久化格式，因此无需数据迁移。
- `annotationCompositeSnapshots.ts` 成为 Gongche symbol 与板眼实体规范快照的唯一转换层；state 和 lifecycle
  不再各自维护一份字段复制。`annotationStateCommand.ts` 负责权威目标解析、完整 next 重建门禁和不可变
  写入，`annotationStateCommandApply.ts` 先解析并核对全部 before，再统一写入和验证最终引用，任一失败都
  不返回半成品。
- transaction 按 content → timing → state → lifecycle 执行。删除被板眼引用的工尺 symbol/block 时，先用
  state 清除失效引用、设置 orphaned，再由 lifecycle 删除实体；inverse 自动逆序，先恢复工尺实体，再恢复
  板眼链接。state 子命令不支持引用同一事务稍后才创建的实体，这是当前删除/断链场景的有意边界，而非
  一个隐藏的宽松执行路径。

引用完整性、工尺编辑与真实 App 接线：

- 新 `banyanReferenceIntegrity.ts` 集中验证 sectionId、Gongche block id、单 symbol id 和多 symbol id；删除
  工尺数据时保留板眼研究记录，只清除失效强引用并标记 orphaned。没有在 App、state adapter 和 lifecycle
  adapter 中复制三套引用规则。
- 新 `gongcheSymbols.ts` 统一快速输入、添加、删除与时间重分配。快速输入按索引复用既有 symbol id；添加
  只为新增项分配 id，删除只移除目标 symbol；其余 symbol 的附加元数据不会因重新分配时间而被整体重建。
  Inspector 已移除旧的本地分配 helper，改用这一稳定身份实现。
- App 增加带 state 目标的提交入口。工尺内部编辑记录 timing/state/lifecycle transaction；板眼非时间字段
  使用 state，纯时间编辑继续复用 timing；板眼自动生成在完整状态/生命周期事务可以重建 next 时写领域
  命令，否则明确回退 legacy snapshot。手工创建板眼区段与 mark、删除单个/多个 mark 均已接 lifecycle。
- 删除字符、自定义块、工尺块或工尺 symbol 时先统一修复板眼引用，并把变化的 mark 声明为 state 目标。
  整轨删除和整段工尺导入仍属于后续受控批量路径，但提交前也经过同一引用修复，保证 legacy snapshot
  本身不会保存悬空强引用。

实现过程中发现并修复的问题：

- 初版 target key 使用冒号拼接，测试含冒号 id 后发现潜在碰撞；已改为结构化元组键，并为共享 parser 和
  ProjectData state apply 各增加回归。
- 初版 state apply 只检查 before 后替换快照，没有验证最终板眼引用；现统一调用引用门禁，坏 after 返回
  `result_invalid`。这与真正的 `target_missing` 前置失败分开，避免日志和调试信息误导。
- 初版命令预算只计算外层 mark item，遗漏 `linkedGongcheSymbolIds` 数组；现 lifecycle/state 成本都会展开
  链接数组，Gongche block 也继续展开 symbols，防止以嵌套数据绕过 500 项限制。
- App 接线的一次范围过宽补丁误改了邻近函数的局部变量名，并在 custom track 删除路径产生重复声明；
  TypeScript 构建和逐段回读当轮即发现并删除，没有保留兼容分支或僵尸变量。
- 手工板眼创建最初缺少规范快照要求的 `orphaned: false`；已在创建源头补齐，而不是放宽 parser 接受不完整
  实体。工尺/板眼引用修复也没有删除 mark，以免丢失需要人工复核的学术记录。

测试、构建与运行验收：

- shared command 16/16；lifecycle adapter 9/9；state/composite adapter 5/5；transaction adapter 7/7。
  覆盖完整状态 apply/inverse、before 冲突、坏引用、冒号 id、symbol 稳定身份、板眼引用修复、symbol 与
  section/mark 生命周期，以及“先断链再删除、inverse 先恢复实体再恢复链接”的原子事务。
- 平台 operation 4/4、draft 15/15、operation catch-up/runtime/document gate 12/12；IndexedDB 草稿可严格
  往返 state envelope，clean committed feed 可回放复合实体 state 命令。
- `npm run test:api` 在真实 PostgreSQL `api_test` schema 上 90/90：合法 state operation 进入连续 sequence
  并标为 `domain_command`，坏 state 请求返回 400；资源、ACL、revision、恢复、确认、上传、审计、维护、
  备份和对象存储全套同步回归。仅保留既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 与 API；Web 转换 2058 个模块，主
  chunk 868.03 kB / gzip 262.01 kB，只保留既有大包提示。`git diff --check` 通过；仓库仍无一般 lint/full-test
  聚合脚本。
- 本轮没有调用浏览器自动化，也没有视觉 UI 改动；纯函数、API 和构建通过不冒充人工交互验收。提交前用
  当前工作树重启 Fastify，并以 `/api/health/ready` 再确认数据库和对象存储依赖。

文档、自审与下一步：

- README、state architecture、roadmap 与 AGENTS 已同步 state 命令、复合实体所有权、稳定 symbol id、引用
  修复策略、mixed catch-up 和专项测试命令。本 Development Log 同时记录了计划、实际实现、问题、验证与
  安全回退；`CLAUDE_WORK.md` 仍只保留当前一轮工作，不积累历史日志。
- 自审未发现第二套 parser、重复引用验证、部分发布的 transaction 或需要保留的旧 symbol 分配 helper。
  轨道结构、递归分叉、批量导入和大范围修复仍是明确的 legacy/受控操作边界，没有为了提高命令覆盖率而
  放宽完整 next 门禁。
- 下一轮 R5a4c 先设计显式锁、受控事务、操作预算和冲突恢复，再选择一个真实结构写路径落地；不能直接
  把大范围结构变化塞进普通 state/lifecycle 命令，也不能在服务端形成第二套 ProjectData 解释器。

## 2026-08-04：R5a4c1 结构性变更短时独占租约

计划与边界：

- R5a4b3 提交后先审计真实轨道写路径。改名、颜色和显示模式只改元数据；删除递归分叉会同步重写多个块的
  branchScope；整轨删除还会级联块、附属点、工尺和板眼引用。Codex 因而没有直接增加一个宽松“轨道
  state”命令，而是把 `CLAUDE_WORK.md` 整体切换为 R5a4c1：先建立跨 API 实例有效的文件级短时独占租约，
  下一轮再接首个结构 UI。
- 用途限制为 track_structure、bulk_import、bulk_repair，只服务审计和提示，不扩大权限。租约按 annotation
  file 唯一，绑定 holder、base revision、创建/过期时间；默认 60 秒，续期总生命周期最多 5 分钟。
- 本轮明确不接编辑器定时续租和轨道 UI，不引入 WebSocket，不解释 ProjectData 结构，也不把整轨删除或批量
  导入纳入普通 CRUD。无租约路径必须完全保持旧行为。

数据库、token 与 API：

- Prisma 新增 `AnnotationMutationPurpose` 和 `AnnotationMutationLease`，annotationFileId 为主键，holder 与
  expiresAt 有索引；文件或账号删除会级联清理。migration `20260804110000_annotation_mutation_leases` 同步
  增加 acquire/renew/release 三类审计动作。
- `annotationMutationLease.ts` 集中 token、purpose 和时间策略。token 使用 32 随机字节与固定前缀，数据库只
  保存 SHA-256；比较使用 timingSafeEqual。明文只在 acquire/renew 响应和请求内存在，不进入 audit、operation
  payload 或日志。
- API 增加 status/acquire/renew/release；共享 DTO 和 platformClient 同步。operation、save、snapshot restore
  请求新增可选 mutationLeaseToken：无活动租约可省略，有活动租约则账号、token、base revision 和有效期必须
  全部匹配。operation 接受后继续持锁，只有完整 save/restore 成功推进 revision 才在同一事务释放；任何快照、
  operation 绑定或 revision 失败都会整体回滚并保留租约。
- 错误详情使用稳定 code 区分 held、required、invalid、expired、revision_conflict；对外 status/冲突只显示
  holder 公共摘要、purpose 和 expiresAt，不回显摘要或数据库内部凭据。

统一写锁与实现中修复的问题：

- 初版租约 guard 已覆盖 operation/save，但自审发现 snapshot restore 同样会覆盖 payload/revision，可能绕过
  活动租约。恢复请求随后接入同一 token guard，并在成功恢复时原子释放；无 token 的恢复在持锁期间返回
  409。
- 继续审查发现 operation 原有 write capability 只在事务外检查，且只锁 annotation file 行；权限撤销、资源
  移动或移入回收站可能从检查间隙穿过。新增 `annotationFileWriteLock.ts`，固定顺序为资源树共享 advisory
  lock → 资源行 → 当前及祖先活动检查 → transaction client ACL → annotation file 行。operation、save、
  restore 和所有 lease mutation 现在复用这一 helper，删除了 ResourceService 内旧的近似实现，没有留下两套
  锁顺序。
- 过期租约在 acquire 时锁内删除并可被新 writer 接管；普通无 token 写入遇到过期记录也会清理后继续。
  携带旧 token 时 fail closed，不会在租约消失后悄悄降级成普通结构写入。
- operation 的幂等重放仍在锁前返回已接受的同指纹记录，因为它不产生新写入；mutation token 刻意不进入
  request fingerprint，避免把秘密写入持久化事实。不同 payload 使用相同 clientOperationId 仍按原规则冲突。
- 最终回归第一次运行时，普通无租约 snapshot restore 的审计详情多出无意义的
  `mutationLeaseReleased: false`，导致稳定审计形状测试失败。实现改为只在确实释放租约时写入 `true`，保留
  旧路径原有详情；修正后 API 91/91。没有通过放宽断言掩盖合同漂移。

验证与自审：

- 新纯函数专项 3/3：固定 token/摘要、purpose 严格解析、过期与最长续期。审计专项 7/7，新增动作与 Prisma
  enum 保持一致。
- PostgreSQL API 集成由 90 增至 91 项：覆盖 writer acquire/status/renew/release、reader 可见 summary、第二
  账号竞争、同账号无 token、他人持 token、operation/save/restore 阻断、正确 token operation、失败 save
  保留租约与 revision、成功 save 原子释放、过期接管、旧 token 失效，以及审计不含明文 token。12 条 migration
  在 `api_test` schema 成功应用；全套 91/91 通过，仅保留既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 与 API；Web 仍转换 2058 模块，主
  chunk 868.72 kB / gzip 262.24 kB，仅有既有大包提示。`git diff --check` 通过。
- 提交前对开发库执行 `npm run db:deploy`。`public` schema 当时落后于测试库，部署实际补齐了 operation
  sequence、operation commit state 和本轮 mutation lease 三条 migration，最终与 `api_test` 同为 12 条。
  随后使用当前工作树重启 Fastify；`/api/health/ready` 返回 HTTP 200，数据库探针约 3.57 ms、对象存储探针
  约 1.08 ms。这里记录的是本机开发环境验收，不替代目标服务器迁移与部署检查。
- 本轮没有视觉 UI 变化，也没有调用浏览器自动化。API client 方法已具备，但没有把“能发请求”冒充编辑器
  已完成租约交互；实际轨道 UI acquire/续期/取消/冲突恢复明确留给 R5a4c2。

文档与下一步：

- README、state architecture、roadmap 和 AGENTS 已记录租约合同、统一写锁模块所有权、测试命令和 UI 未接
  边界；本 Development Log 记录计划、实际实现、自审修复和验证。`CLAUDE_WORK.md` 仍只保留本轮任务。
- 本轮未引入新依赖，Node crypto、Prisma 与 Fastify 已足够；未发现明文 token、进程内伪锁、重复 guard 或
  被新 helper 取代后仍存活的旧锁函数。
- 下一轮 R5a4c2 应先定义有界轨道结构命令，选择自定义轨道元数据和递归分叉作为首条真实路径，建立编辑器
  acquire → renew → operation/save → release/失败恢复；整轨删除、批量导入与大范围修复继续分轮处理。

## 2026-08-04：R5a4c2 自定义轨道结构命令与编辑器租约闭环

### 本轮计划与边界

- 本轮开始前先把 `CLAUDE_WORK.md` 整体替换为 R5a4c2 当前任务，没有保留上一轮日志。目标不是把所有
  `updateCustomTrack()` 强行改名，而是选择“已经存在的自定义文字/动作轨”作为第一条真实结构协作路径：
  轨道元数据、递归分叉树以及块的分叉归属必须形成可校验、可 inverse、可 catch-up 的领域命令，并在本地
  mutation 之前取得 R5a4c1 的数据库租约。
- 明确排除整轨创建/删除、附属点轨创建/删除、会同步修改 block.type 的类型选项改名/删除、整段导入和批量
  修复。这些操作跨生命周期或内容领域，不能为了提高覆盖率塞入一个只更新既有轨道结构的宽松命令。
- 本轮没有新增数据库 migration，也没有引入新依赖。现有 TypeScript、React hook、shared workspace 和
  PostgreSQL 租约 API 已足够；依赖策略仍以减少自研复杂度为准，而不是为了形式引包。

### 共享命令与 ProjectData 适配器

- 新增顶层 `annotation.track.structure.update`。每个 item 保存一个既有轨道的 before/after 结构快照：稳定
  track id/type、name、color、typeOptions、附属点展开/波形吸附/自动循环开关、完整递归 branching，以及
  该轨全部 block 的 branchScope/branchGroupId/branchParentBlockId。块文字、类型、时间和附属点内容不进入
  该快照。
- 该命令显式不允许成为 `annotation.transaction.apply` 子命令。原因不是 parser 限制方便，而是结构命令
  必须让 API 在 action 层看见并强制租约，不能藏在普通复合事务内部绕过写入门禁。
- shared unknown parser 只接受精确 key，并验证安全 id、文本/颜色/数组预算、递归深度、整树 lane id 唯一、
  parentId 与嵌套位置一致、branchScope 只引用现存 lane、scope id 稳定排序、block id 集合在 before/after
  不变、block 父引用不悬空/不自指/不成环。预算按 before/after 较大结构计一次，整个命令最多 500 个结构
  单元；inverse 只交换 before/after 并重新走同一 parser。
- 新增 `customTrackStructureCommand.ts` 和 apply adapter。builder 从真实 base/next ProjectData 生成快照，
  再用命令 apply 重建完整项目并执行 reference-first 深比较；任何块内容、时间、附属点或其他合同外变化都
  使 builder 返回 null。apply 先核对全部 before，再一次性写 after，任一目标缺失或漂移均不发布半成品。
- 通用 `annotationCommandApply.ts`、IndexedDB 草稿 parser、API action/payload allowlist 和 clean catch-up 只
  增加显式 command 分派，没有复制第二套 parser 或项目迁移逻辑。

### 编辑器写路径、历史与租约运行时

- 新增纯 `platformMutationLeaseRuntime.ts` 和薄 React adapter。token 只存在 runtime 闭包；runtime 管理 acquire
  single-flight、续期 timer、续期 single-flight、临时网络失败快速重试、临近失效清锁、generation 防迟到
  响应、显式 release、dispose best-effort release，以及服务端成功提交后的本地 `markCommitted()`。
- App 新增结构 updater：先做 no-op 预览，再通过串行门禁防止 acquire 等待期间连续点击重复创建 lane；平台
  会话取得租约后必须基于最新 `projectRef` 重算，避免网络等待期间普通编辑被旧闭包覆盖。本地 JSON 模式走
  同一个 updater，但不请求 API且保持同步交互。
- 已迁移轨道名称/颜色、附属点展开、波形吸附、选块自动循环、纯 typeOptions 新增/上下移动/拖拽排序、
  branching 启停与 merged/expanded、递归 lane 新增/改名/改色/删除，以及 block branchScope。删除 lane 时
  仍保留既有产品语义：标注内容不删除，失去全部 lane 的块回根轨。
- `HistoryEntry` 现在可保存正向 command envelope。结构 undo 在弹出历史前先 acquire，并记录 inverse；redo
  复用原 envelope，同一文件已持锁时不重复 acquire。legacy 历史仍记录 project.undo/project.redo，没有把
  旧快照错误解释成结构事实。
- 保存事务给本轮所有 pending operation 与完整 snapshot 使用同一顶层 mutationLeaseToken。token 不进入
  command payload、operation 指纹、ProjectData、localStorage、IndexedDB 或日志。若续期已真正失效或浏览器
  草稿恢复后只剩 pending 结构命令，保存前会按 pending 事实重新 acquire，不要求用户再伪造一次结构修改。
  成功保存后服务端已原子删锁，客户端只清内存；operation/PUT 失败继续保留租约、pending 和草稿。
- 顶部同步状态旁增加克制的结构锁状态：正在获取、已持有、续期重试或异常。竞争错误优先显示服务端返回
  的持有者与预计失效时间；真正丢锁会明确提示本地草稿仍在。本轮未新增大面板，也没有把租约状态混入
  ProjectData 或同步状态枚举。

### 服务端门禁与自审修复

- `assertAnnotationMutationLeaseForWrite()` 增加显式 `required` 参数。repository 仅在 operation action 为
  `annotation.track.structure.update` 时传 true，因此结构命令在数据库没有租约记录时也返回稳定
  `annotation_mutation_lease_required`；普通 domain/legacy operation 无租约仍按原行为接受。有活动租约时，
  operation/save/restore 继续复用 R5a4c1 的账号/token/base revision/有效期校验。
- 自审发现初版合同只检查 block 父引用是否存在，两个 block 仍可能互指成环；同时 before/after 可替换 block
  身份，laneIds 顺序也未规范。最终 parser 增加循环检测、完整身份集合一致性和稳定排序，避免未来客户端对
  同一合法命令产生不同解释。
- 自审发现仅有 acquire single-flight 不能阻止两个 UI 回调等待同一 promise 后各执行一次，因此 App 增加
  结构 mutation 串行门禁；这不是用按钮节流掩盖后端竞态，而是保证一次用户结构意图只生成一个本地历史。
- 自审还发现续期真正失效后 pending 结构 operation 会保留，但旧实现没有无副作用的重新取锁入口。保存前
  补取租约后，恢复草稿、PUT 失败重试和短时断网都能继续完成，而不必要求用户再改一次轨道。
- 未发现第二套 ProjectData parser/apply、明文 token 持久化、timer 放在 React 组件、结构命令嵌入普通事务、
  或被新 helper 替代后仍活跃的旧租约运行时。`updateCustomTrack()` 仍有调用并非僵尸代码，它服务本轮明确
  排除的 typeOptions 内容级联和附属点轨生命周期。

### 测试、构建与运行验证

- shared command 18/18：包含合法递归树、inverse/action、悬空/错父 lane、坏 block 父引用、额外字段、
  block 身份漂移、父引用环和未排序 scope。ProjectData 结构 adapter 3/3：覆盖元数据/递归 lane/块归属、
  inverse、before 冲突、合同外内容变化和删除 lane 回根。
- 租约 runtime 4/4：acquire single-flight、定时续期、commit 只清内存、显式 release、dispose、迟到 acquire、
  临时续期失败保留有效 token以及临近过期丢锁。platform operation 4/4：token 只在请求顶层，领域 envelope
  不含 token，租约 409 与 revision conflict 分类不同。
- 浏览器草稿/历史 17/17：新增结构命令 IndexedDB 完整往返，以及 commit → undo inverse → redo 正向命令。
  operation catch-up 13/13：新增 committed 结构命令重放，并继续覆盖分页、revision gap、坏页、legacy 降级、
  前置失败不泄漏半成品和 runtime stale response。
- PostgreSQL API 全套 91/91。租约集成用例现同时证明：普通 operation 无锁可写；结构 operation 无现存租约
  仍被 409 拒绝；正确租约下结构 command 可接受并由完整保存原子绑定/release。其余上传、ACL、快照、审计、
  备份、监控和资源树测试无回归。仍只有既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 与 API。Web 转换 2063 模块，主 JS
  884.32 kB / gzip 266.70 kB，仅保留既有大 chunk 提示；`git diff --check` 通过。
- 本轮无 migration，开发库仍为 12 条。使用当前工作树重启 Fastify（PID 38300），
  `GET /api/health/ready` 返回 HTTP 200，数据库探针约 5.36 ms、对象存储约 1.18 ms。
- 按计划未调用浏览器自动化；本轮 UI 变化只有顶部短状态与既有 Inspector 操作接线，类型检查和生产构建已
  覆盖。人工验证应依次检查本地模式同步改名、平台首次结构编辑取锁、第二账号竞争、续期状态、保存解锁、
  结构 undo/redo，以及整轨/附属点轨等未迁移路径仍保持原功能。

### 后续切片

- R5a4c3 应先处理整条自定义轨道和附属点轨的生命周期，以及会同步修改块 type 的 typeOptions 改名/删除。
  这些变化需要组合结构与实体内容/生命周期，不能扩大当前 update 命令的语义；批量导入和批量修复继续单列。
- 服务端仍只验证、排序和持久化领域命令，不直接 apply 到权威 payload。WebSocket/presence 和服务端命令执行
  继续依赖领域覆盖率与冲突语义稳定后再推进。

## 2026-08-04：R5a4c3 有界轨道结构事务与复合生命周期

### 本轮任务书与实施边界

- 本轮在 R5a4c2 commit `ec347fb` 上继续活动 goal。Codex 先核对 roadmap、现有结构租约、领域命令、
  ProjectData apply、草稿和 clean catch-up 边界，再把被 gitignore 的 `CLAUDE_WORK.md` 整体替换为
  R5a4c3 当前任务书。任务书只覆盖整条自定义轨生命周期、附属点轨生命周期，以及自定义 typeOptions
  重命名/删除与 block.type 联动；没有保留上一轮模板或把历史日志塞进任务文件。
- 明确排除内建轨整轨生命周期、内建 options、既有轨道重排、附属点轨 typeOptions/point label 联动、
  批量导入/修复和 WebSocket。它们进入 R5a4c4，不能为了表面覆盖率把结构变化伪装成普通 transaction 或
  在 command builder 失败时静默提交 legacy 快照。
- 本轮由 Codex 直接按任务书实现、复核和测试，没有把外部代理的输出未经审查直接纳入。roadmap 在实现前
  先标记 R5a4c3 进行中，完成验证后再改为已完成；本日志记录计划、实际代码、审查修复和偏差。

### 共享结构命令合同

- 新增 `packages/shared/src/trackStructureLifecycleCommands.ts`，定义两个只能作为结构事务子命令存在的严格
  lifecycle leaf：`annotation.custom-track.lifecycle.update` 和
  `annotation.attached-point-track.lifecycle.update`。它们不会进入顶层 operation action allowlist，避免
  客户端绕过“顶层 action 必须明显要求租约”的服务端门禁。
- 自定义轨非空快照保存轨道结构、完整拥有块 payload、附属点轨/点，以及 `customTracks` 和
  `activeTrackOrder` 两个集合的 index、length、前后稳定锚点。附属点轨快照保存父轨 id/type、父集合位置、
  完整点轨/点和操作前后展开状态。inverse 交换 before/after；创建/删除必须恰有一侧为空。
- shared parser 对 unknown 输入执行精确 key、安全 id、时间与字符串长度、轨道类型/块文字形态、块身份集合、
  递归分叉引用、点/点轨重复、集合位置和预算校验。结构成本复用既有结构快照成本，点轨及点也进入统一
  500 实体上限；没有按外层 item 数伪装成有界命令。
- 新增顶层 `annotation.track.structure.transaction.apply`。它可直接组合普通 timing/content/lifecycle/state、
  既有 custom-track structure，以及上述两个结构 lifecycle leaf；必须至少包含一个结构子命令，最多 20 个
  child、总成本最多 500，禁止普通 transaction 嵌套和结构事务递归。inverse 按 child 逆序逐个反向。
- `isAnnotationMutationLeaseRequiredCommandType()` 成为 App undo/redo、保存前补锁和 API repository 的唯一结构
  action 判别源，覆盖旧 structure update 与新 structure transaction。删除了各层对单个常量的重复判断。

### ProjectData builder、apply 与完整性门禁

- 新增 `trackStructureLifecycleCommand.ts`，集中创建整轨/点轨规范快照和集合位置；新增
  `trackStructureLifecycleCommandApply.ts`，在局部项目内验证全部 before 后才重建集合。删除先移除目标，创建
  再按最终位置落槽并复核相邻锚点，inverse 因此可恢复原位置而不是粗略 append。
- 新增 `trackStructureTransactionCommand.ts`。高层 plan 把创建父轨、创建点轨、state、annotation lifecycle、
  content、既有结构更新、删除点轨、删除父轨按依赖顺序组成一笔命令。builder 用新 apply 从 base 完整重建，
  再与真实 next ProjectData 深比较；任何未声明变化都会返回 null。
- 新增 `trackStructureTransactionCommandApply.ts`。每个 child 只写局部变量，任一 parser/precondition/apply 失败
  返回 blocked，不泄漏前面已经应用的半成品；全部完成后再统一检查板眼/工尺引用和轨道容器完整性。
- 审查中发现 `resolveCustomTrackLifecycleState()` 的 null 同时可能表示“真正不存在”和“customTracks 与
  activeTrackOrder 已失配”。最终 builder 显式检查两处 occurrence，不再把畸形存在误编码成创建/删除。
  同样增加点轨跨所有父轨的全局 occurrence 检查，局部父轨缺失不再掩盖同 id 已落在其他父轨的冲突。
- 最终容器门禁验证：内建/自定义轨 id 不冲突、activeTrackOrder 无重复、每条自定义轨在排序中恰出现一次、
  自定义块 id 在父轨内唯一、附属点轨 id 跨父轨唯一、点 id 在点轨内唯一。该门禁同时用于 lifecycle leaf
  完成和整个结构事务完成。

### 编辑器真实写路径与服务端接入

- App 新增通用 `runTrackStructureMutation()`：先预览 no-op，再以现有串行门禁 acquire/reuse
  `track_structure` lease；等待网络后基于最新 `projectRef` 重建 next。完整命令构造失败时释放本轮新取租约、
  显示用户错误并保持项目不变，不再提交无法重放的 legacy 结构快照。
- 自定义轨创建现在同时写 customTracks 和 activeTrackOrder 生命周期；删除自定义轨把板眼引用 state 修复、
  根级工尺 lifecycle 删除和轨道 lifecycle 删除放入一笔结构事务。附属点轨在内建/自定义父轨上的创建删除
  均保存父轨展开状态和精确集合位置。selection 与文字编辑态只在 commit 成功后更新。
- 自定义 typeOptions 重命名/删除现在组合既有结构快照和所有命中 block.type 的 content child；纯增加/排序
  继续复用 R5a4c2 的 structure update。被新通用入口完全替代且无调用方的旧 `updateCustomTrack()` 已删除；
  仍服务 R5a4c4 边界的 builtin/attached-point updater 保留，没有为“清理”误删现行功能。
- 通用 `annotationCommandApply.ts`、IndexedDB 草稿、history inverse/redo 和 clean committed-feed catch-up 增加
  新顶层结构事务的单一分派。API repository 使用 shared 租约 helper，因此新事务即使数据库暂时没有活动
  lease 行也会返回 `annotation_mutation_lease_required`，普通 operation 不受影响。

### 自我审查与实现中修复

- 初版测试只证明新结构 action 在无租约时被拒绝，不能证明持锁正向路径。最终 API 集成用例额外提交一条
  持有效 token 的结构事务，并把它和旧结构 operation 一起声明进 revision save，确认 operation 接受、快照
  revision 绑定和租约释放在真实 PostgreSQL 事务中完成。
- 初版容器验证只检查 custom track id 与 point track id，遗漏 activeTrackOrder 一一对应、重复 block id 和
  畸形 null 的歧义。上述门禁已补齐，并增加排序失配、重复块、跨父轨重复点轨的失败回归。
- 审查删除了没有调用方的 `TRACK_STRUCTURE_LIFECYCLE_COMMAND_TYPES`。第一次完整构建随后准确发现两个只为该
  常量服务的残留 import；删除僵尸导入后构建通过。没有保留“编译不报错但语义已失效”的过渡代码。
- 本轮没有新依赖和 Prisma migration。TypeScript、现有 shared workspace、React document state 与租约运行时
  已能清楚表达合同；为这一范围引入状态机或第三方事务库只会增加第二套语义。

### 测试、构建与运行结果

- `npm run test:custom-track-structure-command`：10/10。覆盖既有结构、整轨创建/删除与精确位置 inverse、内建
  父轨点轨创建、自定义父轨点轨删除、跨父轨重复 id、typeOptions/content 联动、工尺/板眼删除依赖、坏
  precondition、无结构事务、排序失配和重复块。
- `npm run test:annotation-commands`：19/19；`npm run test:platform-drafts`：18/18；
  `npm run test:platform-operation-catch-up`：14/14。新事务可严格解析/双重 inverse、在 IndexedDB 完整往返，
  clean 客户端可原子重放 typeOptions 与 block type 联动。
- `npm run test:platform-operations`：4/4；`npm run test:annotation-mutation-lease`：3/3；
  `npm run test:annotation-transaction-command`：7/7。普通依赖事务合同未被结构事务扩容或破坏。
- `npm run test:api`：91/91。真实 PostgreSQL 集成同时覆盖新结构事务无锁拒绝和持锁接受/提交，ACL、资源树、
  上传、快照、审计、备份、监控和维护测试无回归；仍只有既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API。Vite 转换 2068 个模块，主 JS
  905.40 kB / gzip 270.89 kB；仅保留既有大 chunk 提示。`git diff --check` 通过。
- 使用当前工作树重启 Fastify（PID 43029），`GET /api/health/ready` 返回 HTTP 200；数据库探针约 6.01 ms、
  对象存储约 1.20 ms。开发库仍为 12 条 migration。
- 本轮没有新增视觉界面，也没有调用浏览器自动化。人工验证重点是：平台首次新增/删除轨道时锁状态、整轨
  删除后的工尺/板眼与 undo、内建/自定义父轨点轨增删、typeOptions 联动、保存释放租约，以及第二账号竞争。

### 文档与下一轮

- README 已更新用户可见的结构事务覆盖面；state architecture 记录结构 leaf、顶层事务、完整性门禁和
  “结构 builder 失败必须阻止提交”策略；AGENTS 增加四个 ProjectData 模块、shared lifecycle 模块及唯一
  租约判别规则；roadmap 将 R5a4c3 标为完成。
- 下一轮 R5a4c4 应先盘点所有剩余 legacy 结构入口，再按风险拆分：轨道重排、内建轨配置/生命周期、附属点
  轨 typeOptions 与 point label 联动，以及批量导入/修复。小而稳定的结构编辑可继续扩展有界命令；超预算
  批量操作应使用显式受控流程，不能靠扩大 500 实体上限或静默 legacy 降级解决。

## 2026-08-04：R5a4c4a 既有轨道配置与顺序的有界结构事务

### 本轮任务书与实际边界

- 本轮从 commit `1e20c20` 开始。Codex 先审计 R5a4c3 后仍走 legacy 的轨道写入口，并把被 gitignore 的
  `CLAUDE_WORK.md` 整体改写为 R5a4c4a 当前任务：既有顶层轨道排序、既有内建逐字轨配置、既有附属点轨
  配置，以及两类 typeOptions 与逐字唱法/点标签的联动。任务文件没有保留上一轮日志，计划与实际偏差由
  本 Development Log 记录。
- roadmap 在实现前将 R5a4c4 拆成两个依赖闭包。R5a4c4a 只处理规模有界、可严格重放的既有配置；内建轨
  创建/删除需要保存逐字、附属点轨、工尺等完整拥有实体，批量导入/句字修复/工尺生成可能突破 500 项，
  因此明确留给 R5a4c4b 的生命周期命令或受控权威快照流程。本轮没有通过放宽 parser 或静默 legacy 降级
  来伪造覆盖率。
- 本轮没有新增依赖或 Prisma migration。现有 TypeScript/shared 命令合同和结构租约已足够表达配置更新；
  开发数据库仍为 12 条 migration。

### 共享协议与 ProjectData 适配器

- 新增 `packages/shared/src/trackConfigurationCommands.ts`，定义三个只能作为
  `annotation.track.structure.transaction.apply` child 存在的严格 leaf：
  `annotation.track.order.update`、`annotation.builtin-track.structure.update` 和
  `annotation.attached-point-track.structure.update`。它们不进入顶层 action allowlist，因此服务端仍能从
  顶层结构事务明确要求 mutation lease，普通 transaction 不能偷藏结构写入。
- 轨道顺序命令保存完整 before/after `activeTrackOrder`，两侧必须是同一组无重复稳定 id，拒绝空命令和
  集合增删。内建轨配置快照只保存 id/type/name/options、附属点展开、波形吸附和选中同步循环开关；附属
  点轨快照只保存父作用域、id/name/typeOptions、两类吸附与自动循环开关。字符、点和其他拥有实体不进入
  配置快照，所有内容级联必须显式成为事务 child。
- 三类 parser 执行精确 key、安全 id、有界字符串、身份/父作用域不变、重复目标、no-op 和成本检查；同一
  point track id 即使写在不同父轨下也会拒绝，避免 apply 时出现跨父寻址歧义。inverse 交换 before/after
  后重新走相同校验，成本继续计入结构事务统一的 20 child/500 实体上限。
- 新增 `trackConfigurationCommand.ts` 和 `trackConfigurationCommandApply.ts`，作为 ProjectData 配置快照、
  resolver 和原子 apply 的唯一实现。apply 先检查全部 before 和容器身份，任一目标缺失、漂移或跨父重复
  都不发布半成品；轨道重排还会复核当前顶层轨道 id 集合，而不是只替换数组。
- `TrackStructureTransactionPlan` 增加 order、builtin config 和 point config 目标。builder 先生成配置/内容
  leaf，再用统一 apply 重建完整 next 并做 reference-first 深比较；漏报 `singingStyle` 或 point label 时
  builder 返回 null。逐字 `singingStyle` 被纳入已有 `annotation.items.content.update`，与 `char` 使用不同
  target key，没有新建重复的唱法协议。

### 编辑器写路径与僵尸代码清理

- App 删除旧的 `updateBuiltinTrack()` 和 `updateAttachedPointTrack()`，改为
  `updateBuiltinTrackStructure()` 与 `updateAttachedPointTrackStructure()`。两个高层 updater 都复用
  `runTrackStructureMutation()`：平台模式先 acquire/reuse 租约，再以最新 `projectRef` 重算；本地模式走
  同一命令构造但不请求服务端。builder 失败会显示结构错误并保持项目不变，不再退回 legacy commit。
- 已迁移轨道头上下移动和拖拽排序；内建轨/附属点轨改名、波形吸附、父边界吸附、自动循环和点轨展开；
  两类 typeOptions 的增加、移动和拖拽排序；typeOptions 改名/删除与所有命中逐字唱法或点标签的原子级联。
  右键菜单中的逐字、自定义块、附属点“新建类型”也接入相应结构事务；若类型已存在，则只提交普通内容
  修改，不生成假的 no-op 结构事实。直接修改逐字唱法现在同样生成 content command。
- 自审确认 `actionAnnotations` 的旧内建动作兼容数据不属于当前唯一 BuiltinTrackId `character-track`，其右键
  类型入口仍保持 legacy；内建轨创建/删除及大范围导入也按 R5a4c4b 边界保留。被新 helper 完全替代的旧
  updater 已删除，未保留同一功能的第二套写路径。

### 自我审查中发现并修复的问题

- 第一次迁移只覆盖 Inspector，遗漏三个右键“新建类型”入口和直接逐字 `singingStyle` 编辑。最终逐一检索
  `commitProject()` 调用并补齐，避免同一个用户动作因入口不同产生 domain/legacy 两种事实。
- 租约 acquire 是异步的；初版 updater 在请求前捕获 track/options，等待期间的普通编辑可能被旧配置覆盖。
  最终 builtin updater 的字符级联和 point updater 的 options 都在串行门禁取得租约后，从最新 base project
  重新解析。轨道重排也重新计算最新顺序，而不是使用点击时捕获的数组。
- 初版 point config parser 只拒绝相同 parent 下的重复目标，同一个 pointTrackId 可伪装成两个父作用域。
  最终增加全命令 pointTrackId 唯一校验，并在 ProjectData resolver/apply 继续要求全项目唯一。
- 自审没有发现配置快照夹带字符/点内容、普通 transaction 接受结构 child、builder 失败后继续 commit，或
  被删除 helper 的残留调用。轨道顺序集合检查和 complete-next 门禁共同阻止结构生命周期混入本轮 update。

### 测试、构建与运行状态

- `npm run test:annotation-commands`：21/21；覆盖三类结构 leaf、精确 key、no-op、重复 id、顺序集合漂移、
  父作用域变化、预算、inverse，以及逐字 `singingStyle` 内容目标。
- `npm run test:annotation-content-command`：3/3；`npm run test:custom-track-structure-command`：13/13；
  `npm run test:annotation-transaction-command`：7/7。配置/唱法 apply、结构事务组合、完整 next 门禁、inverse
  和原有普通事务边界均通过。
- `npm run test:platform-drafts`：19/19；`npm run test:platform-operation-catch-up`：15/15；
  `npm run test:platform-operations`：4/4；`npm run test:annotation-mutation-lease`：3/3。新命令可在 IndexedDB
  往返、clean 会话原子追赶，并继续使用顶层结构租约判别。
- `npm run test:api`：91/91。PostgreSQL 集成中的结构事务正向样例已改为新的 track-order leaf，证明严格
  parser、无租约拒绝、持锁 operation 接受和 revision save 绑定均未回归；仍只有既有 node-postgres pg 9
  弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API。Vite 转换 2071 个模块，CSS
  120.45 kB / gzip 22.25 kB，主 JS 915.69 kB / gzip 272.78 kB；仅保留既有超过 500 kB 的 chunk 提示。
  `git diff --check` 通过。
- 使用当前工作树重新执行 `npm run dev:api`（PID 47618）；predev 再次构建 shared/document-model 后，
  `GET /api/health/ready` 返回 HTTP 200，数据库探针约 5.41 ms、对象存储约 2.37 ms。旧 API 进程已先停止，
  没有留下两个服务争用 4317 端口。
- 本轮没有视觉布局变化，按任务书未调用浏览器自动化。人工验收顺序：轨道头上下移动与拖拽；逐字轨改名/
  开关；内建类型增加/排序/改名/删除及逐字唱法级联；内建与自定义父轨的点轨配置及标签级联；右键新建
  类型；结构 undo/redo；平台第二账号租约竞争、保存释放和失锁后项目不变。

### 文档与下一轮

- README、state architecture、AGENTS 和 roadmap 已同步真实合同和完成边界；本日志记录了任务书、实现、
  漏项修复、僵尸代码清理、测试数量和构建体积。`CLAUDE_WORK.md` 仍只保存本轮任务，不作为历史日志。
- 下一轮 R5a4c4b 先审计内建轨创建/删除的完整拥有实体和所有批量入口，再分别设计：有界内建轨 lifecycle
  命令，以及明确持租约、不可 clean replay、要求 snapshot 降级的受控批量事实。不能让批量快照冒充普通
  领域 leaf，也不能让 clean catch-up 对不完整证据做部分重放。

## 2026-08-04：R5a4c4b 内建轨生命周期与受控权威快照边界

### 本轮任务书、阶段校正与实施边界

- 用户在继续活动 goal 时确认的名称仍沿用了较早的“R2.3c2”，但 roadmap、Git 基线和本日志都表明该阶段
  已完成；本轮实际连续阶段为 R5a4c4b。Codex 没有重复实现旧比较功能，而是先把被 gitignore 的
  `CLAUDE_WORK.md` 整体重写为当前任务书，再按“单轮计划 → 实现 → 自审 → 测试 → 文档 → commit”执行。
- 基线 commit 为 `8b6ff1a`。本轮只处理当前唯一内建逐字轨的创建/删除、明确批准的批量导入/修复边界、
  历史/保存租约语义和 clean catch-up 降级；没有开始 WebSocket、presence、服务端 ProjectData apply、
  四声/分句命令迁移，也没有扩大 20 子命令/500 实体预算。
- 用户再次明确要求详细维护 **Development Log**。因此本条同时记录任务书、真实实现、自审修复、浏览器
  工具边界、测试数字、构建警告和下一轮入口；`CLAUDE_WORK.md` 仍只保留当前/下一轮任务，不承担历史日志。

### 严格内建轨生命周期与依赖事务

- `trackStructureLifecycleCommands.ts` 新增只能嵌入结构事务的
  `annotation.builtin-track.lifecycle.update`。一个非空快照保存完整 `BuiltinTrack`（包括附属点轨与点）以及
  `builtinTracks`、`activeTrackOrder` 两个集合的精确 index/length/相邻锚点；逐字、工尺和板眼数据不在轨道
  快照中复制，继续作为已有 lifecycle/state 子命令显式列出。
- shared parser 限制当前唯一稳定身份 `character-track` 与 `trackType: character`，并验证精确 keys、安全 id、
  点轨/点唯一性、时间、字符串和成本。创建/删除必须恰有一侧为空，inverse 只交换 before/after 后重新校验；
  leaf 不在顶层 operation action allowlist 中，不能绕过结构租约独立提交。
- ProjectData snapshot/apply 增加内建轨解析与重建。容器最终门禁现在要求所有 builtin/custom 顶层轨道 id
  唯一，并与 `activeTrackOrder` 做数量相等且一一对应；未知幽灵排序 id、漏排、重复点轨/点和重复自定义块
  都 fail closed。
- 结构事务 builder 新增内建轨 lifecycle target 和有顺序的 lifecycle target groups。删除逐字轨按“板眼状态
  断链 → 工尺删除 → 逐字删除 → 内建轨删除”应用，inverse 自动反序恢复；创建则保证父轨先于拥有实体出现。
  任一 child 或最终引用/容器检查失败都不会发布半成品。
- App 的内建轨新增/删除改走结构事务。删除超出有界预算时不再伪装成可重放结构命令，而是进入本轮
  `builtin_track_lifecycle_overflow` 受控快照边界。文字编辑态和 selection 只在 mutation 真正提交后清理，
  租约失败不会先破坏 UI 上下文。

### 受控快照边界、租约与保存语义

- 新增 `annotation.project.snapshot.boundary`：只保存版本、稳定 boundary id、受控 kind 和
  `forward/inverse`，不保存完整或局部 ProjectData。kind 覆盖 SRT/项目/整合/工尺导入、句字修复、板眼生成
  和内建轨超量删除；unknown key、坏 id、坏 kind/方向均由 shared parser 拒绝。
- `getAnnotationMutationLeasePurposeForCommand()` 成为 App 与 API 的完整 envelope 语义源：结构事务映射
  `track_structure`，导入类边界映射 `bulk_import`，修复/生成/超量删除映射 `bulk_repair`。旧 boolean helper
  只保留兼容，不再让需要 purpose 的调用点靠 type 猜测。
- 边界是合法领域事实，因此可进入 operation、IndexedDB 草稿和 history；它没有 ProjectData 差异，明确被
  `isReplayableAnnotationCommandEnvelope()` 判为不可重放。通用 apply 返回 `snapshot_required`，API committed
  记录写入 `requires_snapshot`，clean catch-up 看到它会放弃整条局部链并读取权威 snapshot。
- App 把原结构门禁扩为通用 `runExclusiveProjectMutation()`：预览 no-op、single-flight、按 purpose 取得或
  复用文件租约、锁后从最新 `projectRef` 重建 next、构造严格 command、再 commit。结构写入和受控快照分别
  用薄封装调用，没有保留第二套 acquire/commit 流程。
- 已迁移 SRT 导入、覆盖项目导入、导入整合、普通文件比较整合草稿、句字补齐、整段工尺导入，以及板眼
  生成超预算 fallback。板眼生成仍优先使用可重放普通事务，只有完整命令无法形成时才进入 `bulk_repair`。
- 平台文件覆盖导入不再调用 `markProjectAsSaved()`；未写入服务器的新内容保持 dirty，继续参与浏览器草稿、
  自动保存和 revision 冲突保护。本地 JSON 打开仍可成为新的 clean 本地工作副本。
- undo/redo 根据 history 中完整 envelope 推导 purpose；边界 inverse/redo 与结构命令一样先取得文件租约。
  保存前扫描 pending operations 并按首个受保护事实补取租约，operation 请求仍只在顶层携带 token。

### 自我审查、竞态修复与僵尸代码

- 自审发现导入整合在弹窗确认前生成 plans，取得租约后却直接把旧 plans 套到最新 ProjectData；等待期间若
  轨道发生普通编辑，目标归一化可能已经陈旧。最终改为两次 prepare：弹窗使用预览 plans，锁内基于最新
  base 重新归一化并生成 plans；最新状态变成 skipped-all 时保持项目不变并要求用户重新检查。
- 工尺导入原实现把解析、对齐、随机 id 和 commit 混在一个函数里。现在用纯准备器同时服务预览和锁后重算，
  无可导入结果仍返回统计；板眼引用修复仍在最终 ProjectData 上执行。Inspector 对工尺导入和板眼生成使用
  async pending 状态，重复点击期间按钮禁用并显示明确文案。
- 通用串行 ref 和历史 helper 从只描述 structure 的旧名字改为 exclusive/lease 语义；被替代的重复门禁与按
  command type 猜 purpose 的调用已清理。没有引入新的状态库、事务库或第三方依赖，现有 shared/React/runtime
  已能表达本轮边界。
- 代码中的新增复杂块补充了中文“为什么”注释，重点解释依赖顺序、锁后重算、不可重放边界和平台导入
  dirty 语义；没有把临时浏览器诊断输出留在工作树。

### 测试、构建与浏览器验收

- `npm run test:annotation-commands`：23/23。覆盖 builtin lifecycle parser/snapshot/cost/inverse，以及 snapshot
  boundary 的 kind、方向、purpose、inverse 和不可重放判别。
- `npm run test:custom-track-structure-command`：16/16。覆盖内建逐字轨创建、带附属点轨删除、精确位置、
  依赖顺序、完整 inverse、超预算拒绝和既有自定义结构回归。
- `npm run test:platform-drafts`：20/20；边界在草稿往返时不复制每条 operation 的项目前后态。
  `npm run test:platform-operation-catch-up`：15/15；快照边界与其他不完整证据统一降级权威 snapshot。
  `npm run test:platform-operations`：4/4。
- `npm run test:api`：91/91。真实 PostgreSQL 集成增加 boundary 无租约 409、正确 bulk lease 接受、完整
  snapshot revision 绑定和原子释放；资源树、ACL、上传、快照、审计、备份、监控、维护无回归。仍只有既有
  node-postgres pg 9 弃用提示，开发库仍为 12 条 migration。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API。Vite 转换 2072 个模块，CSS
  120.45 kB / gzip 22.25 kB，主 JS 923.73 kB / gzip 274.50 kB；仅保留既有超过 500 kB 的 chunk 提示。
  `git diff --check` 通过。
- 停止旧 Fastify PID 47618 后，以当前工作树重新执行 `npm run dev:api`（PID 53402）；predev 再次构建
  shared/document-model，`GET /api/health/ready` 返回 HTTP 200，数据库探针约 7.87 ms、对象存储约 1.33 ms。
- 使用 in-app Browser 打开当前 Vite 工作树：平台资源管理器完成账号验证，本地标注工作台、视频、时间轴、
  波形/频谱与 Inspector 正常渲染，控制台无 warn/error；可见的“新增文字轨”操作实际成功。尝试用语义
  locator 点击内建轨删除时，目标位于时间轴内部滚动区的离屏位置并被悬浮轨覆盖，浏览器驱动没有触发真实
  按钮事件；纯命令回归已证明示例项目删除、apply 和 inverse 正常。本轮不把这次受工具限制的操作写成完整
  UI 验收，人工复核仍应在可见位置检查删除、撤销和重做。

### 文档与下一阶段

- README、state architecture、AGENTS 和 roadmap 已同步内建轨生命周期、快照边界、purpose resolver、平台
  导入 dirty 规则及模块职责；没有截图或数据格式变化，不需要替换 README 截图。
- R5a 的 HTTP operation、领域覆盖、租约和 snapshot 降级底座至此闭环。下一轮拆为 R5b1：先建立一次性
  连接票据、认证 WebSocket 文件会话、心跳/重连/文件切换和连接状态 UI，只广播 revision/operation
  invalidation，客户端继续复用既有 HTTP catch-up/snapshot。首轮不能让 socket 成为第二条写入、ACL、
  revision 或租约通道；presence、跨实例分发和实时 command submit 继续留给后续切片。

## 2026-08-04：R5b1 认证文件会话与实时 revision 通知

### 本轮任务书、阶段核对与依赖决策

- 本轮开始时用户沿用了较早的“R2.3c2”名称；Codex 对照 roadmap、最近 commit 和 Development Log 后确认
  比较/整合阶段早已完成，实际下一阶段是 R5b1。被 gitignore 的 `CLAUDE_WORK.md` 已整体重写成 R5b1 当前
  任务书，没有把旧阶段日志继续留给后续代理。
- 本轮边界明确为“通知优先”：WebSocket 只建立认证文件会话并发布权威 revision 失效事件，浏览器仍通过
  已有 HTTP committed feed 或完整 snapshot 获取内容。没有通过 socket 发送 `ProjectData`、提交领域命令、
  自动 rebase dirty 文档，也没有开始 presence、远端光标或 OT/CRDT。
- 新增官方 `@fastify/websocket` 11.3.0（MIT，基于 `ws` 8.21.2）。它复用 Fastify 生命周期与注入测试，减少
  自行维护 upgrade/router/close 清理代码；没有为了一个通知通道引入完整协作框架。
- Prisma 新增 `AnnotationCollaborationTicket` 和第 13 条 migration。票据有效期 30 秒、只可使用一次，数据库
  只保存 SHA-256 摘要；明文票据通过 WebSocket 子协议头发送，upgrade URL 不含票据或平台 access token。
  开发 schema 与 API 测试 schema 均已通过 migration deploy。

### 共享协议、API 会话与事务后通知

- `annotationCollaboration.ts` 定义 version 1 `session.ready` 与 `annotation.revision.advanced`。unknown parser
  要求 exact keys、有界稳定 id、正整数 revision、有效 cursor 和心跳范围；未知版本、额外字段、二进制或
  非法 JSON 都不能进入客户端同步状态机。
- `AnnotationCollaborationTicketService` 在签发、消费和连接存活复核时检查活动账号、当前角色、资源 read
  capability、文件类型及整个祖先链的回收站状态。正确文件上的票据一经消费即烧毁，即使随后发现撤权或
  回收也不能因事务回滚让同一明文重试；跨文件、过期、重复票据统一拒绝。
- `AnnotationCollaborationRoutes` 在消费票据期间先安装 close/error 处理器；会话 ready 后使用原生 ping/pong
  和周期权限复核。每条 revision 发送前也重新鉴权，并在单连接 Promise 队列中串行复核和发送，避免连续
  保存导致较晚 revision 越过较早 revision。客户端业务消息以协议错误关闭，HTTP 继续是唯一写入通道。
- `AnnotationCollaborationHub` 当前是按文件隔离的进程内通知端口，拒绝重复或倒退 revision；应用关闭时
  统一关闭订阅。`ResourceService` 的普通保存和快照恢复只在数据库事务成功后发布，并使用事务直接返回的
  确切 committed revision/cursor，禁止锁外重读把另一笔更晚提交误认为本次事件。
- 提取了共用 Bearer 解析和活动标注文件检查，删除 ResourceService 中重复的祖先遍历；既有受保护媒体
  query token 路径仍显式保留，没有被协作认证重构破坏。

### 浏览器连接运行时与 HTTP 追赶衔接

- `PlatformCollaborationRuntime` 独占一次性票据请求、socket、握手/ready 超时、generation、退避 timer 和连接
  状态；只在严格 `session.ready` 后显示 connected。文件切换、离线、dispose 和 React Strict Effects 都会
  使旧 generation 失效，迟到票据、消息或 close 不得污染新文件。
- 网络/临时关闭使用 1–30 秒有界指数退避和新票据；401/403/404、协议错误与服务端授权关闭进入 halted，
  直到会话或在线事实改变，避免 React 重渲染形成永久错误忙循环。握手前、握手后等待 ready 两段都有明确
  超时。
- 既有 `PlatformOperationCatchUpRuntime` 新增 `requestCheck()`：空闲时立即检查，flight 中多个通知合并成
  一次后续检查，blocked/offline 时保留一次唤醒，恢复 clean 后才执行。socket 消息从不直接应用项目，也不
  绕过 dirty/pending/transient/保存/冲突门禁。
- 顶部菜单在原同步状态区域紧凑显示“实时已连接/连接中/重连中/离线/异常”，并用 tooltip 说明实时通知与
  保存状态不同。本地编辑器不创建 socket，也不显示伪造的实时状态。旧 CSS 会在 1440px 以下隐藏整个
  状态区；浏览器验收后改为中等宽度截断、仅 900px 以下隐藏，1280px 工作区可直接看到连接与保存状态。

### 自我审查中发现并修复的问题

- 初始集成测试删除学生直接 ACL 后，继承自项目的 read 权限仍然有效，导致“撤权后关闭”断言错误。最终测试
  显式截断文件权限继承，区分了产品权限语义与协作连接逻辑；服务端没有为了让测试通过而错误忽略继承 ACL。
- 初版只在票据消费时鉴权，已建立连接可能在撤权后继续接收事件。最终增加心跳和每次发送前的当前权限复核，
  集成测试覆盖既有 socket 在下一次 revision 时以 4403 关闭。
- 第二轮自审发现存活复核读取了账号启用状态和当前 ACL，却仍把票据签发时的角色快照传入 global-admin
  判定。最终改为每次从数据库读取当前角色后再解析 capability，角色降级不会被旧连接缓存。
- 初版 revision 发送异步鉴权未串行，连续事件理论上可能乱序；最终使用每连接 delivery queue。保存/恢复的
  初版通知若在锁外读取文件，可能误报并发保存的更高 revision；最终事务直接返回本次 revision。
- 初版永久票据错误在后续 React facts 更新时可能再次 connect；最终引入显式 halted。握手超时最初只覆盖
  ticket 和 ready，最终补齐 socket open 阶段。被替代的重复认证、活动文件遍历和旧 wake 调度均已清理。
- 浏览器验收时发现 Fastify 默认访问日志会原样记录 upgrade URL；初版把一次性票据放在 query，仍会让短时
  明文进入日志。最终改用稳定 WebSocket 子协议名加唯一 ticket 子协议项，API URL 和常规请求日志只保留
  文件路径；真实注入测试同步改为协议头，不以票据寿命短为理由保留可避免的凭据日志。
- 浏览器首次截图显示 DOM 中已有“实时已连接”，但常见 1280px 宽度被旧响应式规则隐藏。最终缩小隐藏范围
  并重新截图确认状态可见，没有通过只检查 DOM 文本来冒充视觉验收。

### 测试、构建与实际运行

- `npm run test:annotation-collaboration`：8/8。shared parser 2 项；进程内 hub 2 项；浏览器 runtime 4 项，
  覆盖 ready、重连新票据、永久错误停止、文件切换迟到消息、坏协议、离线和 dispose。
- `npm run test:platform-operation-catch-up`：17/17；新增显式唤醒、flight 合并和 blocked 后恢复测试，原有
  committed command 原子重放、快照降级、换文件和网络退避均通过。
- `npm run test:api`：94/94。真实 PostgreSQL/Fastify WebSocket 集成覆盖匿名拒绝、明文不落库、ready、保存
  后 revision、重复/跨文件/过期票据、签发后撤权、新票据拒绝、既有连接关闭及全局角色撤销复核；资源、
  ACL、上传、恢复、审计、备份、维护与监控无回归。仍只有仓库既有 node-postgres pg 9 弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API。Vite 转换 2075 个模块，CSS
  121.08 kB / gzip 22.35 kB，主 JS 929.81 kB / gzip 276.69 kB；只有既有超过 500 kB 的 chunk 提示。
  `git diff --check` 通过。
- 当前工作树 API（PID 61306）在 4317 端口运行，`/api/health/ready` 返回 200。使用 in-app Browser 登录平台并打开真实
  服务器标注文件，编辑器成功显示服务器/本地 revision 3，并读到“实时已连接”；时间轴与确认面板正常
  渲染。最终子协议实现重连后，Fastify upgrade 日志只包含 `/collaboration` 文件路径，不再出现票据 query。
  浏览器本轮验证的是单 API 进程链路，不能冒充跨实例通知验收。

### 文档、已知边界与下一轮

- README、state architecture、AGENTS 和 roadmap 已同步通知-only 合同、模块所有权、测试命令和单进程
  限制。本条按用户要求详细记录计划、实现、自审修复、测试和浏览器结果；`CLAUDE_WORK.md` 仍只服务下一轮。
- R5b1 不保证跨 API 实例事件抵达：另一个实例提交后，本实例客户端最终仍可依靠周期 HTTP catch-up 正确
  恢复，但不会立即被内存 hub 唤醒。下一轮 R5b2a 应先抽象并实现跨实例 revision event bus、重连与指标，
  仍保持 HTTP 权威恢复；完成后再进入 R5b2b presence/光标/选区。

## 2026-08-04：R5b2a 跨 API 实例 revision 事件分发

### 本轮任务书、架构选择与边界

- 本轮基线为 R5b1 commit `9b12a9a`。Codex 先核对 roadmap、真实代码和上一轮 Development Log，再把被
  gitignore 的 `CLAUDE_WORK.md` 整体重写为 R5b2a 当前任务书；没有沿用过时的 R2.3c2 名称，也没有把任务书
  当作长期日志。本轮由 Codex 直接实现和审查，没有调用 Claude Code、GLM、DeepSeek 或其他代理。
- 目标仅是让“浏览器 WebSocket 在实例 A、保存/恢复请求在实例 B”时仍能立即收到 revision 失效提示。
  WebSocket 继续不传完整 `ProjectData`、不提交 operation、不做 dirty rebase；HTTP committed feed 与权威
  snapshot 仍是内容和恢复的唯一事实来源。presence、远端光标/选区、在线成员和实时 operation 提交明确不在
  本轮范围。
- 选择 PostgreSQL LISTEN/NOTIFY，而不是在当前规模下提前引入 Redis、Kafka 或新的消息依赖。平台已经依赖
  PostgreSQL，这个方案能复用现有部署边界并保持事件延迟较低；代价是通知不持久、listener 断线时可能丢失，
  因此设计上只把它当作 wake-up signal，不能把“收到事件”等同于“已经取得或应用标注内容”。

### 严格事件合同、跨实例总线与连接所有权

- `annotationRevisionEventEnvelope.ts` 新增 server-only version 1 envelope：只包含事件类型、来源实例 id、
  标注文件 id、已提交 revision 和 committed-feed cursor。解析要求 exact keys、稳定 id、正 revision、有效
  cursor 和 7000-byte 上限；事件不携带账号、权限、文件名、票据、token、operation body 或标注 payload。
  PostgreSQL channel 根据实际 schema 哈希生成，避免同一数据库中的开发、测试和其他租户 schema 互相串扰。
- `PostgresAnnotationRevisionEventBus` 先把事务后事件送入当前实例 hub，再异步调用 `pg_notify`。这保证
  PostgreSQL 发布临时失败不会让本实例用户失去提示，更不能反向使已经成功提交的保存/恢复请求失败。待发布
  事件按 annotation file 合并为最高 revision，文件队列上限为 1000；溢出时明确丢弃最旧待发布文件并计数，
  而不是形成无限内存增长或隐藏背压。
- listener 初始 LISTEN 失败会阻止 Fastify 启动，避免服务在误以为跨实例通知可用的状态下上线；运行期连接
  错误使用 generation 和有界指数退避加 jitter 重连。关闭流程先停止新发布、清 timer、关闭 listener，再由
  Fastify 关闭进程内 hub。每个 API 实例使用专用小型 collaboration pool，不占用 Prisma 业务查询连接，也不
  复用 maintenance advisory-lock pool；备份 CLI 和恢复演练会显式关闭自己不使用的 collaboration pool。
- 进程内 `AnnotationCollaborationHub` 已收敛成单调 fan-out：它返回 accepted/duplicate，并对 PostgreSQL
  自回环、重复和乱序 revision 去重。`ResourceService` 继续只在保存或恢复事务成功提交后发布，并使用事务
  返回的精确 revision/cursor；没有恢复锁外重读或第二条写入路径。

### 可观测性、自我审查与僵尸逻辑清理

- Prometheus 新增低基数指标：event-bus 连接状态、待发布文件数、发布 queued/coalesced/dropped/failed、
  入站 accepted/duplicate/invalid 和重连次数。labels 只描述固定结果，不包含 file/user/schema/channel/error，
  防止高基数或敏感信息进入指标。开发环境没有配置 `XIQU_METRICS_TOKEN` 时 `/metrics` 继续按既有合同关闭。
- 自审发现第一次 listener 连接失败发生在 `connectInFlight` 尚未清空时，重连请求可能被 single-flight 吞掉。
  最终增加 retry-after-attempt 状态，只在当前尝试完成并清空 single-flight 后排定下一次连接；专项测试覆盖。
- 第二次自审发现 listener close 的异步 rejection 可能成为未处理 Promise。最终显式 catch、记录并在 finally
  排定重连或结束清理。跨实例 publish 失败测试同时确认：本实例已经收到事件、调用方不抛同步异常、失败计数
  增加，保存语义不受通知设施影响。
- 删除了 hub 旧 publisher 职责和“单进程 hub 直接由 ResourceService 发布”的重复接线；应用只有一个 event
  bus 组合根，没有为测试复制第二套数据库 URL/search_path 解析。没有新增运行时依赖，也没有遗留调试日志、
  第二个 S3/Prisma 客户端路径或未使用的旧 publisher。

### 测试、构建与真实运行验收

- `npm run test:annotation-revision-event-bus`：8/8。覆盖严格 envelope/channel、同文件合并、跨实例入站、
  自回环去重、发布失败本地优先、初连失败、运行时断线重连和优雅关闭。
- `npm run test:annotation-collaboration`：8/8；原有票据、hub、浏览器连接 runtime、坏协议、离线、文件切换和
  dispose 行为无回归。`npm run test:observability`：11/11；新指标保持低基数且禁用端点语义不变。
- `npm run test:api`：104/104。集成测试真实创建两个独立 Prisma/Fastify 应用及两组 collaboration pools：
  WebSocket 连接实例 A，实例 B 完成普通保存和快照恢复，实例 A 分别收到 revision 2、3；同时覆盖资源、ACL、
  上传、恢复、审计、备份、维护和既有协作会话。只保留仓库既有 node-postgres pg 9 弃用提示。
- `npx tsc -p apps/api/tsconfig.test.json --noEmit` 通过。`npm run build` 通过 Prisma generation、shared、
  document-model、Web 和 API；Vite 转换 2075 个模块，CSS 121.08 kB / gzip 22.35 kB，主 JS 929.81 kB /
  gzip 276.69 kB；只有既有超过 500 kB 的 chunk 提示。`git diff --check` 通过。
- 当前工作树 API 在 4317 端口运行（PID 63908）；`/api/health/ready` 返回 HTTP 200，数据库探针约 3.86 ms、
  本地对象存储约 1.04 ms。开发环境未设置 metrics token，`/metrics` 返回 404 属于预期，指标内容由集成测试
  验证。in-app Browser 登录平台并打开《寻梦》服务器标注文件，顶部显示“实时已连接”，编辑器、时间轴和
  确认范围面板正常；Fastify 日志中的 upgrade URL 仍只有 `/collaboration` 路径，不含一次性票据。

### 文档、已知限制与下一阶段

- README、state architecture、AGENTS 和 roadmap 已同步跨实例通知合同、专用连接池、模块职责、测试命令和
  R5b2a 完成状态；本 Development Log 按用户要求记录任务书、架构取舍、自审修复、僵尸逻辑清理、测试数字、
  真实运行和下一步边界。没有数据文件格式或视觉布局变化，不需要更新 README 截图。
- PostgreSQL NOTIFY 天生可丢失，也不提供持久消费确认；当前实现故意不把它包装成可靠消息队列。浏览器周期
  HTTP catch-up、revision 连续性校验和 snapshot 降级仍负责最终正确性。下一轮 R5b2b 才开始短生命周期
  presence、远端光标/选区和在线成员 UI，并需先明确节流、隐私、撤权、慢消费、断线和文件切换语义。

## 2026-08-04：R5b2b1 跨实例在线成员 Presence

### 本轮任务书、阶段拆分与事实边界

- 本轮基线为 R5b2a commit `ed592d0`。Codex 先核对 roadmap、实际代码和上一轮 Development Log，再把
  gitignore 的 `CLAUDE_WORK.md` 整体重写为 R5b2b1 当前任务书；用户沿用的旧阶段称呼没有覆盖仓库已经
  推进到 R5b2 的事实。本轮由 Codex 直接实现、自审和验证，没有调用 Claude Code、GLM、DeepSeek 或
  其他代理。
- R5b2b 被拆成两轮：本轮只建立在线身份、TTL、跨实例失效重读、同账号多窗口聚合和成员 UI；远端播放头、
  光标、选区和高频客户端消息全部留到 R5b2b2。Presence 只是短生命周期运行时事实，不写入 `ProjectData`、
  平台标注 payload、浏览器恢复草稿、恢复快照、operation log 或治理审计，也不能改变 ACL 和保存结果。
- 没有引入 Redis、Kafka 或完整协作框架。平台已有 PostgreSQL 和 R5b2a 的 LISTEN/NOTIFY 运行基础，因此先
  抽取通用有界 coalesced event-bus 核心，再用独立 schema-isolated channel 承载文件级 presence
  invalidation。NOTIFY 不携带账号或成员名单，接收实例必须重新读取 PostgreSQL 权威快照。

### 数据库 Presence、跨实例协调与连接生命周期

- Prisma 第 14 条 migration 新增 `AnnotationCollaborationPresence`：每个 WebSocket/tab 一行，绑定标注文件、
  账号、连接/最后活跃/过期时间，并对文件+过期、账号+过期及全局过期建立索引和级联删除。TTL 固定为
  60 秒；心跳只续期尚未过期的行，迟到心跳不能把已经失效的连接复活。
- `AnnotationPresenceService` 在同一标注文件行锁内重新检查 read capability、活动资源树和连接容量，再创建
  session。当前上限为每文件 1000 个 session、每账号每文件 100 个窗口、聚合后 200 个账号；新账号达到
  成员上限时显式拒绝，已有账号仍可增加窗口。过期行按 200 条有界惰性清理，成员快照按账号聚合
  `connectionCount` 和最新 `lastSeenAt`。
- `PostgresCoalescedEventBus` 从 revision bus 中抽出 LISTEN 生命周期、重连、local-first 投递、按 key 合并、
  有界队列和发布失败降级。Revision 和 presence 只保留各自严格 envelope、合并规则和低基数指标映射，
  没有留下两套平行连接/队列实现。Presence envelope 最大 1000 字节，只携带来源实例和标注文件 id。
- `AnnotationPresenceCoordinator` 仅在本实例确有该文件订阅者时读取成员。每文件查询 single-flight；查询期间
  再收到任意次数失效只追加一轮补读，最终快照不会停在查询期间的旧状态。心跳每文件每 20 秒最多触发一次
  周期失效，用于让其他实例重读并清理异常退出后已经过 TTL 的残留。
- `AnnotationCollaborationRoutes` 在票据消费后 join，先发送 `session.ready`，再订阅 hub 并发布 presence
  invalidation。正常 close/error、心跳失活、撤权、角色变化和应用关闭共用幂等 finalizer；服务器主动关闭
  时立即删除 presence，不依赖浏览器完成 close handshake。应用关闭还会等待票据消费/join 的 in-flight
  setup，避免迟到 join 在 Prisma 关闭后留下未补偿行。
- Hub 对 revision 保持单调去重，对 presence 只按成员身份、显示名和窗口数去重，heartbeat 引起的
  `lastSeenAt` 变化不会形成 UI 广播风暴；最后一个本地订阅者离开时清理 fingerprint，保证相同成员结构的
  快速重连仍能收到首个权威快照。

### 浏览器协议、在线成员 UI 与状态隔离

- shared version 1 协议新增严格 `presence.snapshot`，限制 200 个成员、每成员 100 个窗口、唯一用户 id、
  exact keys、稳定字符串和 ISO 时间。未知类型、额外字段、重复用户、零窗口、越界名单和 ready 前业务消息
  都会被拒绝；R5b2b1 仍拒绝全部客户端业务消息。
- 浏览器 collaboration runtime 在 `session.ready` 后接受 revision 或 presence；presence 不会触发 HTTP
  operation catch-up。React hook 在断线、重连、离线或文件切换时立即清空旧成员，避免把上一文件或上一代
  socket 的名单显示为当前事实。
- 顶部菜单只在平台实时连接成功时显示紧凑“n 人在线”入口；成员面板自己优先、名称稳定排序，并显示同账号
  多窗口数量。面板明确说明在线状态不改变权限或保存结果；本地免登录编辑器不建立 presence，也不会显示
  伪造成员。

### 自我审查中发现并修复的问题

- 初版 join 在 Prisma interactive transaction 的同一 pg 连接上用 `Promise.all` 并发执行两个 count，未来
  pg 9 不再支持。最终改为顺序查询并补中文原因注释；完整 API 测试仍会在既有“并发创建两个资源”测试中
  输出一条相同上游弃用警告，但 trace 不再指向 presence 事务，本轮不把它掩盖成已解决。
- 初版成员上限只依赖输出截断，数据库可能接受第 201 个账号而浏览器静默看不到。最终在持文件行锁的 join
  事务内对新账号显式检查聚合成员上限，数据库事实与协议容量保持一致。
- 初版 hub 保留上一批订阅者的成员 fingerprint；最后一个订阅者离开后，快速重连若成员结构相同可能收不到
  首帧。最终在移除最后一个订阅者时同步清理 fingerprint，并新增回归测试。
- 初版服务端主动撤权关闭仅调用 `socket.close()`，presence 删除依赖对端 close handshake，Fastify 注入测试
  会超时且真实慢客户端也可能延迟清理。最终所有主动关闭共用 `closeAndFinalize()`，ACL 和角色撤销测试都
  直接断言数据库 presence 行已经删除。
- 第二轮自审发现应用关闭可能在票据/join setup 尚未结束时先关闭 Prisma。最终追踪所有 setup promise，
  shutdown 在 finalizer 后继续等待迟到 join 的即时补偿。Coordinator 也收窄为 `listActive` reader port，测试
  不再伪造完整 service。
- 抽取通用 PostgreSQL event-bus 后删除 revision bus 内重复的传输、队列和重连逻辑；没有遗留第二个 pool、
  第二套 channel 拼接、成员身份 NOTIFY、调试日志或对旧 API 的并行调用。

### 测试、构建与真实运行验收

- `npm run test:annotation-presence`：4/4，覆盖严格 envelope/channel、无订阅者不查询、查询中失效追加一轮和
  最终最新快照。
- `npm run test:annotation-collaboration`：共享协议、浏览器 runtime、成员 view 和 hub 共 10 项通过；覆盖
  presence ready 前拒绝、断线/文件切换清空、成员结构去重、快速重连首帧和既有 revision 生命周期。
- `npm run test:annotation-revision-event-bus`：8/8；通用 bus 抽取后原有 local-first、合并、溢出、初连失败、
  运行时重连、发布降级和关闭行为无回归。`npm run test:observability`：12/12，presence 指标不包含账号、
  文件 id 或错误文本等高基数/敏感标签。
- `npm run test:api`：113/113。真实 PostgreSQL/Fastify 集成覆盖两个 API 实例共享成员、同账号多 tab 聚合、
  过期行不被迟到连接复活、正常离开、直接 ACL 撤销和全局角色撤销清理；资源、保存、恢复、上传、审计、
  备份、维护和既有跨实例 revision 均无回归。保留一条上述既有 node-postgres pg 9 前置弃用提示。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API；Vite 转换 2077 个模块，CSS
  122.70 kB / gzip 22.62 kB，主 JS 933.35 kB / gzip 277.90 kB；只有既有超过 500 kB 的 chunk 提示。
  `git diff --check` 通过。
- 当前工作树 API（PID 69881）运行于 4317，`GET /api/health/ready` 返回 200，数据库与本地对象存储探针均
  为 ok。使用 in-app Browser 登录平台并打开《寻梦》服务器标注文件，顶部显示“实时已连接”和“1 人在线”；
  第二浏览器窗口打开同一文件后，第一窗口显示“系统管理员 · admin · 2 个窗口”，关闭第二窗口后立即回到
  单窗口。浏览器控制台无 warn/error。

### 文档、已知边界与下一轮

- README、state architecture、AGENTS 和 roadmap 已同步 R5b2b1 的事实边界、模块所有权、测试命令和完成
  状态；本 Development Log 按用户要求记录任务书、直接实现、自审修复、僵尸逻辑清理、测试数字和浏览器
  证据。`CLAUDE_WORK.md` 仍只作为下一轮即时任务书，不承担历史日志职责。
- Presence 是数据库短生命周期状态，不保证永久历史，也不能解决同时编辑冲突。NOTIFY 丢失时，连接心跳的
  周期失效和 TTL 会最终纠正成员列表；内容正确性仍完全依赖 HTTP revision、committed feed 和 snapshot。
- 下一轮 R5b2b2 应在当前稳定会话上定义严格有界、节流的远端播放头/光标/选区摘要，明确隐私、慢消费、
  文件切换、generation 和 stale 清理语义，再实现 Timeline 只读叠加；不得在该轮传输标注正文或绕过 HTTP
  写入事务。

## 2026-08-04：R5b2b2a 跨实例远端播放头实时预览

### 本轮任务书与阶段边界

- 本轮基线为 R5b2b1 commit `67f8287`。Codex 先核对 roadmap、现有 presence/notification 代码和实际测试，
  再将 gitignore 的 `CLAUDE_WORK.md` 重写为只包含 R5b2b2a 的详细任务书。原 R5b2b2 被拆为两轮：本轮只做
  远端播放头，R5b2b2b 才增加鼠标时间与选区摘要，避免同时引入多种高频状态后无法定位性能或协议问题。
- 用户特别要求持续维护 **Development Log**。本节记录的不只是最终代码，也包括本轮计划拆分、自审修复、
  PostgreSQL 连接池阻塞的定位过程、真实浏览器证据和已知边界。`CLAUDE_WORK.md` 仍是即用即改的当前任务书，
  不承担历史记录职责。
- 播放头是瞬时协作状态，只包含时间与播放/暂停；它不进入 `ProjectData`、revision、IndexedDB 草稿、恢复
  快照、operation log 或治理审计，也不成为第二条保存通道。本轮没有实现远端鼠标、选区、标注正文广播、
  dirty operation 合并、OT 或 CRDT。

### 严格协议、服务端限流与跨实例瞬时通道

- shared version 1 协议新增 exact-key `presence.playhead.update` 和 `presence.playhead.changed`。客户端消息固定为
  `sequence/time/playing`，服务端消息绑定文件、连接 session、账号、单调 sequence 与 server timestamp，并
  支持显式 `playhead: null` clear。时间、序列、字符串、ISO 时间和消息字节均有上限；未知字段、二进制、
  ready 前消息和超过 1024 字节的客户端帧会以稳定协议错误关闭。
- `AnnotationRemoteActivityRateLimiter` 使用每连接 token bucket，默认每秒 8 次、burst 4。自审发现初版只在
  限流通过后推进 sequence：攻击端可以先发送被限流的高 sequence，再让较低 sequence 获准。最终 observed
  watermark 在限流判断前推进，clear 又高于全部已观察序列，因此被丢弃帧不会造成乱序复活。
- 新增第三条 schema-isolated PostgreSQL activity channel，复用通用 `PostgresCoalescedEventBus`，按文件和
  activity session 合并到最高 sequence。envelope 最大 1500 字节，不含显示名、ACL、token、标注正文、
  operation 或持久历史。发布 local-first；NOTIFY 失败只损失瞬时远端预览，不影响保存和内容正确性。
- Hub 对每连接 activity sequence 单调去重，排除发送源，并在连接 clear 后保留有界 sequence tombstone，
  防止网络迟到帧重新显示已经断开的播放头。服务端 outbound `bufferedAmount` 超过 512 KiB 时直接丢瞬时帧；
  close、撤权和 shutdown 共用 clear/finalize 路径。
- 指标新增 activity bus 连接/队列/发布/入站/重连，以及客户端 accepted/duplicate/rate_limited/invalid 结果；
  labels 都是固定低基数枚举，不包含文件、账号、消息正文或错误文本。

### 浏览器运行时、注册表与 Timeline 精确叠加

- 浏览器 collaboration runtime 在 `session.ready` 之前不发送播放头；变化最多 8 Hz trailing coalescing，
  静止时每 2 秒保活。浏览器 outbound `bufferedAmount` 超过 256 KiB 时保留最新候选而不堆积旧帧；文件切换、
  离线、重连 generation、dispose 和 close 会清理 activity timer 与候选状态。
- `remotePlayheadRegistry` 以连接 session 保存最后 sequence，处理 clear 和 6 秒 stale 回收，再按账号选择最近
  活动窗口。视图隐藏当前账号、过滤已经不在权威 presence 的成员，并限制最多挂载 32 个远端播放头；颜色
  由账号 id 稳定生成。React hook 只在注册表非空时维持一个全局回收 timer，避免空闲编辑器永久每秒唤醒。
- Timeline 叠加层只读且 `pointer-events: none`，活动状态为实线、暂停为虚线，标签最多错开四行。纵线严格使用
  现有 `trackHeaderWidth + time * zoom`；`translateX(-50%)` 只让 2 px 笔画围绕数学坐标居中，不修改时间。
  远端层位于波形、频谱和块之上，本地预览线/播放头之下，不参与吸附、选择、拖动或撤销历史。普通与独立
  弹窗 Timeline 共享同一整理后列表。

### 自我审查、阻塞定位与僵尸逻辑清理

- 自审把 WebSocket RawData 的字节长度检查提前到 buffer 拼接之前，避免超大分片先形成额外内存峰值；清理了
  旧 `client_messages_not_supported` 分支和重复的“notification-only route”文档，不保留第二套协议解析或
  event-bus 实现。
- 第一次完整 API 测试在约 310 秒后人工终止：当时 50 项已通过、9 项被取消。PostgreSQL 连接检查显示第一
  个 Fastify 实例占用 revision/presence/activity 三个持久 LISTEN，第二个实例只建立 revision listener 后就
  停住。原因不是测试超时，而是共享 collaboration pool 的 `max=4` 无法同时容纳三类 listener、NOTIFY 查询、
  重连余量和集成测试受控的双实例组合。
- 最终把唯一 collaboration pool 容量从 4 调整为 8，并在组合根说明容量依据；没有为测试建立旁路 pool，
  也没有让 activity 复用业务 Prisma 连接。修复后相关平台集成 28/28 通过，随后完整 API 119/119 通过。
- 没有新增运行时依赖，没有产生新的数据库表或 migration，也没有把瞬时状态写入日志、快照或文件。新增逻辑
  分别收敛在 shared protocol、服务端 envelope/rate limiter/event bus、浏览器 runtime/registry 和 Timeline
  只读渲染层中，未把高频协调逻辑塞入 App 或 React 组件。

### 测试、构建与真实浏览器验收

- `npm run test:annotation-collaboration`：18/18，覆盖 shared 严格消息、hub source exclusion/sequence/clear、
  浏览器 ready/throttle/keepalive/backpressure、registry sequence/stale/同账号聚合，以及既有连接生命周期。
- `npm run test:annotation-presence`：4/4；`npm run test:annotation-revision-event-bus`：8/8；
  `npm run test:platform-auto-save-runtime`：8/8；`npm run test:platform-operation-catch-up`：17/17，既有成员、
  revision、自动保存和 HTTP 权威追赶无回归。
- `npm run test:api`：119/119。真实 PostgreSQL/Fastify 集成覆盖跨实例播放头、发送源排除、断线 clear，以及
  malformed JSON、binary、oversize fail-closed；保留仓库既有 concurrent resource-create 路径的一条 pg 9
  前置弃用提示，本轮新代码不再触发连接池阻塞。
- `npm run test:observability`：13/13；activity 指标只有固定结果类别。最终 `npm run build` 完整通过 Prisma
  generation、shared、document-model、Web 与 API。Web 转换 2078 个模块，CSS 123.44 kB / gzip 22.78 kB，
  主 JS 937.19 kB / gzip 279.25 kB；只有既有超过 500 kB 的 chunk 提示。
- 第一次执行最终完整构建时，系统盘只剩 115 MiB，shared 输出阶段报 `ENOSPC`。只清理了可重新生成的
  npm cache，没有删除 `data/`、上传对象、备份、源码或用户文件；释放到约 1.5 GiB 后，同一完整构建通过。
  这属于本机环境容量问题而非 TypeScript 失败，但系统盘仍接近满载，后续长时间开发需要继续关注空间。
- 当前 API 运行于 4317（PID 75522），readiness 返回 200，数据库与对象存储均为 ok。in-app Browser 以管理员
  打开《寻梦》服务器标注文件，另以真实学生账号 WebSocket 加入：成员数从 1 变 2，Timeline 显示“学生账号”
  远端线。20 px/s、22.2 秒时 `left=608px`，严格等于 `164 + 22.2 * 20`；两次放大到 30 px/s 后
  `left=830px`，严格等于 `164 + 22.2 * 30`。终止学生连接后 0.8 秒内远端线归零、成员数回到 1。

### 已知边界与下一阶段

- PostgreSQL NOTIFY 和播放头帧都故意允许丢失；这是可覆盖的瞬时 UI，不是可靠消息队列。内容正确性仍由
  HTTP committed feed、revision 连续性检查和权威 snapshot 保证。
- 本轮没有远端鼠标时间、选区摘要、递归轨道选择可视化和隐私裁剪 UI，也没有实时编辑命令提交。下一轮
  R5b2b2b 应复用已验证的 activity channel，但单独定义 pointer 采样、选择摘要上限、显示密度和隐藏策略；
  不得扩大消息为标注正文或绕过现有 operation/save/lease 事务。

## 2026-08-04：R5b2b2b 统一远端播放头、鼠标时间与匿名选区摘要

### 本轮任务书、执行方式与阶段边界

- 本轮基线为 R5b2b2a commit `7027672`。Codex 先依据实际代码和 roadmap，把 gitignore 中的
  `CLAUDE_WORK.md` 重写为只包含 R5b2b2b 的详细任务书，再按“协议 → 服务端 → 纯摘要/注册表 → 浏览器运行时
  → Timeline → 测试/浏览器 → 文档/日志 → 提交”的顺序实施。没有调用其他代理，也没有让即时任务书承担
  历史日志职责。
- 用户再次明确要求维护 **Development Log**。本节因此同时记录需求边界、直接实现、自我审查修复、真实
  双账号坐标证据和自动化控制限制，而不只列最终文件。
- 本轮只扩展可丢失的协作提示：播放头、鼠标时间和匿名选区摘要。没有广播实体 id、标注正文、轨道名、
  分叉名或用户输入；没有提交领域 operation，没有修改 `ProjectData`、revision、保存事务、恢复草稿、恢复
  快照、operation log、治理审计或 mutation lease。

### 统一严格协议与跨实例服务端通道

- shared 协议把原 `presence.playhead.update/changed` 收敛为 exact-key
  `presence.timeline_activity.update/changed`。一个 sequence 对应一个完整
  `{playhead, pointer, selection}` 最新快照，三个字段均可为空，但客户端业务帧至少有一项非空；服务端
  `activity: null` 专用于连接 clear。解析器统一限制时间、整数计数、固定研究域类别、类别唯一稳定顺序和
  嵌套字段，并在验证后深拷贝数组与对象，调用方不能继续持有不可信输入引用。
- 选区摘要类别只允许逐字、动作、自定义块、附属点和板眼五类。摘要只携带真实起止时间、有效项目数、
  可视 lane 数和类别；客户端消息仍受 1024 字节上限，跨实例 envelope 仍受 1500 字节上限。
- Fastify route、hub 和 PostgreSQL activity envelope/bus 复用 R5b2b2a 已验证的 source exclusion、连接级
  sequence、被限流帧水位推进、token bucket、慢消费者丢帧、跨实例 coalescing 和断线 tombstone，不建立
  pointer/selection 的第二套队列或 listener。统一帧仍只是一条丢失可容忍的实时提示，HTTP
  committed-feed/snapshot 继续是内容恢复的唯一权威路径。

### 浏览器摘要、完整快照调度与隐私边界

- 新增纯 `timelineSelectionSummary`：从当前 `TimelineSelectionItem` 重新查找项目中的真实实体时间，忽略已经
  删除的 stale selection，递归分叉块按本次可视 `branchLaneId` 计数；输出中没有任何实体 id、正文、label、
  track id、轨道名或分叉名。相关测试明确断言摘要不可泄漏这些字段。
- `platformCollaborationRuntime` 现在只维护一个完整 activity 候选，共用 125 ms trailing 发送窗口、2 秒
  keepalive、256 KiB 浏览器背压和单调 sequence。播放头、鼠标和选区在同一窗口内变化时只发送最后一份完整
  快照，避免接收端把三个不同时间点的局部 patch 误组装。
- 自我审查发现换文件时旧完整快照可能比 React 新状态更早抵达新 socket。最终在 session key 变化时清空
  播放头、鼠标和选区候选，并新增回归测试；同一文件离线重连仍保留调用方最新事实。运行时内部残留的
  `playheadTimer`/`sendLatestPlayhead` 等误导命名也全部改为 activity 语义，没有留下旧协议并行路径。
- `remoteTimelineActivityRegistry` 替换旧播放头专用注册表：仍以连接 session 处理 sequence/clear/6 秒 stale，
  再按账号选择最近的完整快照。只显示仍在权威 presence 中的其他账号，最多 32 个远端账号；前 12 个绘制
  选区 band，超出者仍可显示播放头/鼠标，避免密集半透明区域遮挡时间轴。
- 在线成员弹层新增两个独立开关：本地隐藏全部远端提示不会销毁注册表，重新开启可立即恢复；停止共享只
  清除自己的鼠标与选区摘要，播放头仍保持协作预览。普通 Timeline 与独立窗口通过 source ownership 协调，
  旧窗口迟到的 pointer leave 不会清除新窗口刚上报的位置；窗口 blur、页面 hidden 和组件卸载都会清 pointer。

### Timeline 精确坐标与显示层级

- Timeline 根滚动容器只把鼠标横坐标转换为时间语义，先排除固定轨道头，再复用现有
  `getCanvasTimeFromViewportOffset()`；局部 `requestAnimationFrame` 只合并 DOM 高频事件，网络 8 Hz 节流仍
  唯一归运行时负责。普通/独立 Timeline 共用同一回调和远端活动列表。
- 远端播放头、鼠标点线和选区 band 都直接使用 `trackHeaderWidth + time * zoom`。1/2 px 线条仅用
  `translateX(-50%)` 使笔画围绕数学坐标居中，绝不增加时间补偿。选区最小 2 px 只改善零长度点状选择可见性，
  不修改其精确 left；三个 overlay 均 `pointer-events: none`，位于波形/频谱/块之上、本地预览线和本地播放头
  之下，不参与吸附、命中、拖动、选择或撤销历史。
- CSS 继续使用既有低饱和工作台风格：远端播放头实线/暂停虚线，鼠标为细点线，选区为轻量透明 band；标签
  有界错行并只显示成员名、项目数和轨道数，不展示标注内容。

### 测试、构建与真实浏览器验收

- `npm run test:annotation-collaboration`：21/21。覆盖统一协议 exact-key/越界/泄漏拒绝、hub 跨实例
  sequence/clear/source exclusion、runtime ready/8 Hz/keepalive/backpressure/完整快照合并/换文件清空、
  registry 同账号聚合/stale/显示上限，以及选区摘要隐私和 stale item。
- `npm run test:api`：119/119；真实 PostgreSQL/Fastify 集成把跨实例帧扩展为播放头 12.5 秒、鼠标 13 秒、
  10–14 秒选区，并继续覆盖 malformed/binary/oversize、来源排除和断线 clear。保留仓库既有并发资源创建
  测试的一条 pg 9 前置弃用提示，本轮协作逻辑没有新增数据库阻塞或测试旁路。
- `npm run test:observability` 13/13、`npm run test:annotation-presence` 4/4、
  `npm run test:annotation-revision-event-bus` 8/8、`npm run test:platform-auto-save-runtime` 8/8、
  `npm run test:platform-operation-catch-up` 17/17，既有成员、revision、自动保存和权威 HTTP 追赶无回归。
  最终 `npm run build` 完整通过 Prisma generation、shared、document-model、Web 与 API；Vite 转换 2079 个
  模块，CSS 124.92 kB / gzip 22.99 kB，主 JS 943.48 kB / gzip 280.85 kB，只有既有超过 500 kB 的 chunk
  提示。`git diff --check` 与旧协议/注册表引用扫描也通过。
- 当前工作树 API 运行于 4317（PID 79014）。in-app Browser 以管理员打开 `annotation-xunmeng-demo`，另用
  真实学生账号一次性票据建立当前协议 WebSocket。30 px/s 时，学生 22.2 秒播放头 `left=830px`、24.5 秒
  鼠标 `left=899px`、18–27 秒选区 `left=704px,width=270px`，分别严格等于 164 px 轨道头加时间乘缩放；
  标签只显示“学生账号”和“4 项 · 2 轨”。在线菜单显示管理员与学生两名成员，并渲染两个隐私复选项；
  关闭学生 socket 后 0.9 秒内成员回到 1，播放头、鼠标和选区 DOM 均归零，clear 没有遗留幽灵提示。
- Codex Browser 控制层本轮无法可靠合成该原生 checkbox 的点击：locator 点击会关闭 popover 而不改变受控
  值，因此没有把自动化工具缺陷冒充产品缺陷，也没有为测试工具改写组件。开关的数据流、清除语义和完整
  构建已核对；真实远端活动接收、视觉层级和两种缩放下的坐标则由浏览器完成验收。

### 已知边界与下一阶段

- Activity 帧故意允许丢失，不提供历史、可靠投递或内容一致性。用户隐藏远端提示只影响显示，不节省服务端
  接收成本；当前最多 32 个账号、12 个选区 band 是保守 DOM 密度边界，未来真实课堂压测后再调整。
- 本轮没有把 selection kind 翻译成界面正文，也没有显示远端正在编辑的稳定实体，避免形成隐私泄漏和假锁。
- 下一轮进入 R5b3：必须先审计现有 operation acceptance、committed binding、mutation lease、HTTP catch-up
  和 dirty 阻断边界，再设计实时 operation 的 submit/ack/reject 顺序与冲突策略。不得直接把可丢失 activity
  bus 当作 operation 可靠队列，也不得在尚未确定服务端 apply/authoritative ordering 前承诺 OT/CRDT。

## 2026-08-04：R5b3a1 服务端可复用的持久 ProjectData 类型边界

### 本轮任务书与 operation 写路径审计

- Codex 以 commit `c022278` 为基线，先读取 roadmap、`AGENTS.md`、状态架构、operation repository、
  `resourceService.saveAnnotationFile()`、浏览器保存事务和 committed-feed catch-up，再把 gitignore 中的
  `CLAUDE_WORK.md` 整体改写为只包含 R5b3a1 的详细任务书。本轮没有委派给其他 agent，也没有把上一轮
  activity 任务日志留在即时任务书中。
- 审计确认当前 operation POST 只在文件锁内完成幂等键复查、base revision/ACL/必要租约校验、单文件
  acceptance sequence 分配和 accepted 行写入；它不修改 `AnnotationFile.payload`。浏览器随后 PUT 完整
  `ProjectData` 时，服务端才在同一事务中保存恢复快照、推进 payload/revision、绑定当前 actor 声明的
  operation，并在提交后发布 revision 通知。
- 因此 accepted operation 可能因离线、关闭、409 或租约失效而永远不提交，不能直接通过 WebSocket 或
  可丢失 activity bus 广播并让其他客户端应用。R5b3 被进一步拆成共享模型、共享 apply engine、服务端原子
  命令提交、客户端 ack/reject 和并发冲突阶段；R5 完成前另增加单服务器可部署候选与详细部署文档门禁。

### 共享持久类型与 Web 运行时边界

- 新增 `packages/document-model/src/projectData.ts`，原样迁入当前持久 `ProjectData` 所需的四声、递归分叉、
  附属点、句/逐字、工尺、板眼、动作、自定义轨、内建轨、视频和本地 `SavedProjectFile` 类型。字段名、
  optional/null 语义、union 字面量和文件 version 均未改变；模块按领域职责加入中文注释，不含 normalization、
  React、DOM、Prisma、Fastify 或平台治理状态。
- `packages/document-model/src/index.ts` 从公开入口导出持久类型。`src/types.ts` 删除了重复定义，通过明确的
  type re-export 保持现有 Web import 兼容，只继续定义 Inspector 聚焦、派生 `TrackDefinition`、波形/频谱
  缓存和 Timeline 选择等运行时类型。没有使用 `export *` 把 permissions/confirmations 等无关合同混入
  Web 综合类型出口。
- 十个现有命令 apply 入口改为直接从 `@xiqu/document-model` 导入 `ProjectData` 和所需轨道实体类型，明确
  R5b3a2 的迁移方向；本轮只改 type import，不移动 resolver/writer，不修改 parser、precondition、事务顺序、
  immutable apply 或通用 dispatcher 行为。
- 自审扫描确认源码中只剩一个 `ProjectData` 定义，document-model 没有反向 import `src/` 或 UI/API 框架，
  十个 apply 入口没有残留 `../types`。本轮没有提升 `PROJECT_FILE_VERSION`，没有修改 projectFile migration、
  平台 payload sanitize、shared command DTO、Prisma schema、API 路由、UI 或运行方式；因此 README 的用户功能
  说明无需制造一条无行为变化的更新。

### 测试、构建与偏差记录

- `npm run build:document-model` 和 `npm run build:web` 首轮即通过。Web production build 转换 2080 个模块，
  CSS 124.92 kB / gzip 22.99 kB，主 JS 943.48 kB / gzip 280.85 kB；只有既有超过 500 kB 的 chunk 提醒。
- 命令专项测试全部通过：timeline timing apply 3/3、content 3/3、lifecycle 9/9、state/composite 5/5、
  annotation transaction 7/7、custom-track/track-structure 16/16，共 43 项；platform operation catch-up 17/17，
  合计 60 项，证明类型来源改变未影响原子 apply、inverse、引用完整性和远端 committed replay。
- `npm run test:api` 119/119，通过共享/document-model 构建、test TypeScript、14 条 migration 检查和真实
  PostgreSQL/Fastify 集成。保留仓库既有的一条 pg 9 `client.query()` 并发调用前置弃用提示，本轮没有新增
  数据库警告或测试旁路。
- 最终 `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。由于本轮没有任何可见 UI、
  网络合同或运行时逻辑变化，未把浏览器点击冒充有效验收；现有领域测试和全量编译是更直接的回归证据。

### 已知边界与下一阶段

- R5b3a1 只解决共享类型所有权。命令 resolver、builder、precondition adapter、immutable writer 和事务
  dispatcher 仍位于 `src/utils`，API 当前仍只验证/记录 operation，不能直接 apply 到 payload。
- 下一轮 R5b3a2 应按依赖图把纯命令 apply engine 迁入 `packages/document-model`，让 Web catch-up 与未来 API
  原子提交使用唯一实现。必须逐领域迁移并复用现有测试，不能通过复制 1600 余行实现建立第二套服务端逻辑；
  React 事件、历史提取、UI builder 和项目文件 normalization 继续留在 Web。

## 2026-08-04：R5b3a2a timing/content/state 第一批共享命令执行核心

### 依赖审计、阶段拆分与即时任务书

- Codex 在 R5b3a1 commit `20a0d03` 后重新检查 20 个命令 resolver/apply/transaction 文件，共计约 2881 行。
  审计发现 timing、content 和 state 可以连同项目 equality、工尺/板眼复合快照及引用完整性形成独立闭包；
  lifecycle 依赖更多集合位置和父子快照，轨道结构又依赖 lifecycle/content/state/timing，不能安全一次迁完。
- Roadmap 因此把 R5b3a2 细分为 a2a（timing/content/state）、a2b（lifecycle/annotation transaction）和
  a2c（轨道结构/configuration/总 dispatcher）。gitignore 中的 `CLAUDE_WORK.md` 也整体改写为 a2a 当前任务，
  明确禁止复制实现、宽泛 re-export、反向依赖 Web 或无测试大搬迁。

### 唯一实现迁移与兼容边界

- 使用保留历史的文件移动，把 `projectValueEquality`、`timelineTimingCommand`/Apply、
  `annotationContentCommand`/Apply、`annotationCompositeSnapshots`、`banyanReferenceIntegrity` 和
  `annotationStateCommand`/Apply 九个模块迁入 `packages/document-model/src`。内部类型改为引用
  `projectData.js`，NodeNext 相对依赖显式使用 `.js`；业务函数、导出名、命令 parser、before precondition、
  immutable writer、完整 next equality gate 和跨实体引用规则没有变化。
- `packages/document-model/src/index.ts` 公开导出第一批执行核心。旧 `src/utils` 同名文件删除全部函数体，只
  保留逐模块显式、窄范围 re-export 和中文边界注释；没有用 `export * from "@xiqu/document-model"` 把整个
  package 意外暴露为任意旧模块。
- 未迁移的 lifecycle、annotation transaction、track structure/configuration 和 App 继续使用旧 import 路径，
  但实际执行已经穿过 wrapper 到共享函数。源码 symbol 扫描确认 13 个代表性 builder/resolver/writer/apply
  函数均只在 document-model 出现一次；共享包没有 `src/`、React、DOM、Prisma 或 Fastify 反向 import。

### 自动化验证、自审和已知偏差

- `npm run build:document-model` 首轮通过。专项与组合测试共 54 项通过：timing builder 3/3、timing apply 3/3、
  content 3/3、state/composite 5/5、annotation transaction 7/7、custom-track/track-structure 16/16、platform
  operation catch-up 17/17。后四组证明未迁移模块和 Web catch-up 能通过兼容出口继续组合共享实现。
- `npm run test:api` 119/119，通过 14 条 migration 检查和真实 PostgreSQL/Fastify 集成；仍只有仓库既有的
  pg 9 `client.query()` 前置弃用提示。最终 `npm run build` 通过 Prisma generate、shared、document-model、
  Web 和 API；Vite 转换 2089 个模块，CSS 124.92 kB / gzip 22.99 kB，主 JS 943.48 kB / gzip 280.96 kB，
  只有既有大 chunk 提醒。
- 迁移后 Vite 模块数比 a1 多 9，是九个 Web 兼容出口与共享实现形成的模块图，不是双函数实现；主 bundle
  原始大小未增长，gzip 只出现构建哈希/模块边界级微小变化。本轮没有 UI、协议、数据库或用户行为变化，
  因而没有用浏览器视觉测试替代更有效的领域/组合测试。
- `git diff --check`、函数体唯一性、反向依赖和宽泛 wrapper 扫描通过。没有修改 shared command DTO、
  `ProjectData`、JSON version、API route、operation/save 事务或 activity 通道。

### 下一阶段

- R5b3a2b 迁移 annotation lifecycle 的 528 行 resolver/builder/writer、lifecycle apply 和 annotation transaction
  apply，并把复合快照/引用完整性直接改为包内依赖。必须重点保持集合 position、跨父作用域唯一性、句/逐字/
  工尺父子关系、板眼断链、事务逆序 inverse 和任一子命令失败不泄漏半成品。
- a2b 完成后才进入 a2c 轨道结构/configuration/总 dispatcher；服务端原子领域命令提交仍属于后续 R5b3a3，
  本轮没有把“共享纯函数可导入”误称为“API 已经实时 apply”。

## 2026-08-04：R5b3a2b 生命周期与普通标注事务共享执行核心

### 本轮计划与边界

- Codex 以 commit `c66fb73` 为基线核对 lifecycle/transaction 四个模块共 759 行。该闭包只依赖 shared DTO、
  a2a 已共享的 timing/content/state/equality/复合快照/引用完整性和 `ProjectData`，不依赖 React、DOM 或轨道
  结构实现，因此可以独立迁移。`CLAUDE_WORK.md` 被整体改写为 a2b 任务书，重点门禁为集合位置、父子引用、
  工尺/板眼断链和事务中途失败不泄漏半成品。

### 实际迁移

- `annotationLifecycleCommand`/Apply 和 `annotationTransactionCommand`/Apply 四个唯一实现移动到
  `packages/document-model/src`。包内直接引用 `projectData.js` 与 a2a 共享模块，NodeNext 相对 import 统一补
  `.js`；没有改动实体 snapshot、collection index/length/neighbor、父容器解析、precondition、最终引用校验、
  子命令顺序或完整 next equality gate。
- `src/utils` 四个旧文件删除函数体，只显式 re-export 对应函数和类型，并用中文注释说明兼容边界。源码扫描
  确认 lifecycle builder/writer/apply 和 transaction builder/apply 五个代表函数各只有 document-model 一份；
  无宽泛 package re-export、Web/API 反向依赖或第二套事务分派。

### 验证、自审与下一阶段

- `build:document-model` 通过；专项/组合共 54 项通过：lifecycle 9/9、annotation transaction 7/7、state 5/5、
  custom-track/track-structure 16/16、operation catch-up 17/17。结构组合测试证明尚未迁移的轨道事务仍能经窄
  wrapper 消费共享 lifecycle/transaction，而不改变删除顺序或反向恢复。
- `test:api` 119/119，仍只有既有 pg 9 前置弃用提示；`npm run build` 通过 Prisma、shared、document-model、
  Web 和 API。Vite 转换 2092 个模块，CSS 124.92 kB / gzip 22.99 kB，主 JS 943.48 kB / gzip 281.00 kB，
  只有既有大 chunk 提醒。`git diff --check`、唯一实现、反向依赖和宽泛 wrapper 扫描通过。
- 本轮没有改 UI、协议、ProjectData、JSON、数据库或 operation/save 行为。下一轮 a2c 迁移 custom-track
  structure、track lifecycle/configuration、structure transaction 和通用 dispatcher；完成后 API 才真正拥有
  一个可调用的完整共享命令入口，但服务端原子提交仍需 R5b3a3 单独实现。

## 2026-08-04：R5b3a2c 轨道结构与完整共享命令 dispatcher

- Codex 以 `932c071` 为基线审计剩余九个纯模块共 1592 行，并重写 `CLAUDE_WORK.md`。迁移覆盖自定义分叉
  结构、轨道配置、custom/builtin/attached-point 拥有子树生命周期、结构事务和通用 dispatcher；不修改租约、
  API 写事务、DTO、JSON、数据库或 UI。
- 九个唯一实现移动到 `packages/document-model/src`，包内直接引用 a2a/a2b 共享命令；旧 `src/utils` 删除函数
  体，只保留显式窄 re-export 和中文边界注释。代表性结构 builder/apply 与 dispatcher 各只有一份，无宽泛
  wrapper 或 Web/API 反向依赖。
- 结构/生命周期/普通事务/catch-up 组合 49 项通过（16+9+7+17）；`test:api` 119/119；完整 build 通过，
  Vite 2090 模块，CSS 124.92 kB / gzip 22.99 kB，主 JS 943.48 kB / gzip 280.06 kB，仅有既有大 chunk 和
  pg 9 前置弃用提示。`git diff --check` 与唯一实现扫描通过。
- R5b3a2 至此完成。下一轮 R5b3a3 必须在服务端同一事务内完成 ACL/租约/base revision、命令 apply、快照、
  payload/revision、operation 绑定、审计和提交后通知；共享纯函数可用不代表服务端已实时提交。

## 2026-08-04：R5b3a3a 当前 ProjectData 运行时边界与原子命令批次合同

### 实际状态审计与阶段拆分

- Codex 以 `eb9b1b8` 为基线重新检查 operation acceptance、完整 payload save、committed feed、mutation lease、
  `ProjectData` 类型和共享 dispatcher，并把已忽略的 `CLAUDE_WORK.md` 整体重写为 a3a 当前任务。审计确认
  PostgreSQL 的 `AnnotationFile.payload` 仍是 unknown JSON；TypeScript 类型共享不能证明数据库内容满足当前
  模型，直接断言后 apply 会把缺字段或畸形递归结构带入权威事务。
- 审计也确认本地一次保存可包含同一 server base revision 上有顺序依赖的多条命令。逐条推进 revision 会暴露
  本地事务中间状态并使后续命令的 before 失效，因此 R5b3a3 明确拆成 a3a 运行时文档/批次合同和 a3b 数据库
  原子提交；旧 operation POST + payload PUT 只在 R5b3b 客户端迁移前保留为兼容通道。

### 严格当前格式 parser 与依赖边界

- `packages/document-model/src/projectDataSchema.ts` 使用 MIT `zod@4.4.3` 建立当前 `ProjectData` 的严格运行时
  schema，覆盖视频、句/字、四声、工尺、板眼、动作、内建轨、自定义文字/动作轨、附属点轨、递归分叉和
  active order。它拒绝缺字段、未知键、非法 union、非有限数字、倒置区间、非法四声细分、递归 parentId
  错位、重复 lane、块对幽灵 lane 的引用、超过 64 层和循环对象；成功时不修改输入。
- 选择 Zod 是为了让 strict object、discriminated union、递归 lazy schema、错误路径与 TypeScript 类型保持
  一个可审查边界，避免手写数百个松散 `typeof` 分支。parser 不复用 Web 的 921 行旧文件 migration，不填
  默认值、不 hydration 媒体 URL、不修复引用，也不静默剥离未知字段。
- 首轮从 document-model 根 barrel 导出 schema 后，完整构建显示 Web 主 JS 从约 943.48 kB / gzip 280.06 kB
  增至 1,020.89 kB / gzip 300.69 kB。自审随即改为独立
  `@xiqu/document-model/project-data-schema` package subpath 并从根出口删除；最终完整构建为 2091 模块、
  943.51 kB / gzip 280.04 kB，证明服务端运行时依赖没有污染编辑器主包。

### 有序批次合同与重复逻辑清理

- `packages/shared/src/annotationCommandCommit.ts` 新增最多 100 项的有序批次 request/response 和 unknown parser。
  一个批次只有一个 base revision，可带租约 token；每项保留 client id、local revision、action 和严格 envelope。
  parser 保留数组顺序，拒绝空/超限、重复 id、非安全整数 revision、额外字段、action/type 不一致、legacy 摘要
  和 snapshot boundary，后两者继续要求完整 payload。
- client operation id 的 128 字符保守字符集从 API 私有模块迁到 shared；旧 API 导出名保留窄兼容 alias，
  IndexedDB 草稿也删除了第三份正则并消费同一 validator。没有新 Prisma schema、API route、Web 保存行为或
  JSON version，本轮不能被描述成服务端原子提交已经完成。

### 验证、代码审查与下一轮

- 新 parser 5/5；新批次合同 5/5；既有 operation idempotency 3/3、shared annotation commands 23/23、轨道
  结构组合 16/16、committed catch-up 17/17 均通过。`npm run test:api` 119/119，通过 14 条 migration 和真实
  PostgreSQL/Fastify 集成；仍只有仓库既有 pg 9 `client.query()` 前置弃用提示。
- `npm run build` 首次及修正 subpath 后的 Web/API 类型构建均通过；最终完整构建也再次通过。源码审查
  未发现 `any`、反向框架依赖、第二套 parser 或宽泛错误吞噬；`git diff --check` 通过。该轮无可见 UI，因而
  没有用浏览器点击替代直接合同测试。
- 下一轮 R5b3a3b 使用独立 schema subpath 和批次 parser，在一笔 PostgreSQL 事务中完成锁/ACL/租约、payload
  parse、顺序 apply、恢复快照、单 revision、按序 committed operation、审计、租约释放和提交后通知；必须
  覆盖幂等重放、并发、precondition 拒绝、畸形 payload、legacy accepted 行及全事务回滚。

## 2026-08-04：R5b3a3b 服务端原子领域命令批次提交

### 本轮计划、实际边界与模块拆分

- 用户确认开始本轮并再次明确要求维护 **Development Log**。Codex 先以 `e87f2b2` 为基线核对 roadmap、
  `CLAUDE_WORK.md`、旧 operation acceptance、完整 payload save、committed feed、mutation lease 与共享
  dispatcher，确认本轮只建立服务端原子写入口，不提前改 App 的保存状态机。
- 新增独立 `AnnotationCommandCommitService`，没有继续膨胀约 1800 行的 `ResourceService`。新
  `POST /api/annotation-files/:resourceId/command-batches` 只接收 shared 严格 parser 已确认的可重放命令链；
  `PlatformClient` 增加 typed 调用，但编辑器尚未使用它。旧 operation POST + 完整 payload PUT 明确保留到
  R5b3b，避免同一轮同时改服务端事务与浏览器离线/自动保存状态机。
- 服务事务采用固定顺序：锁活动资源和文件并复核 ACL；检查完整幂等重放；核对 base revision 与租约用途；
  严格解析数据库 unknown payload；在局部 `ProjectData` 上按请求顺序 apply；JSON round-trip 后再次严格
  解析；保存旧 payload 恢复快照；只推进一次 revision 和 operation sequence；逐行写同一 committed revision；
  更新时间、写单条保存审计、释放结构租约；提交后才发布跨实例 revision/cursor。任一阶段失败由 PostgreSQL
  事务回滚，不会留下 accepted operation 或前序命令的中间项目。

### 自我审查发现与修复

- 开始时上一条截断补丁已经抽出了 operation mapper 和幂等 hash helper，但两个 feed 仍引用已删除的实例
  mapper。Codex 先修复该机械残留并通过 API 类型检查，再继续新服务；accepted feed、committed feed 和
  原子响应现在共用唯一 `mapAnnotationOperationRecord()`。
- 首版幂等逻辑只证明“请求中的所有 ID 都存在”，无法区分原三项批次与其前两项子集。自审后增加同一
  `(文件、账号、base revision、committed revision)` 完整序列回查，要求 ID 集合与 sequence 顺序完全一致；
  子集、乱序、部分旧行和混合 committed 状态均返回 409。相同 key 不同 payload 仍优先返回稳定指纹冲突，
  不回显 hash 或正文。
- mutation lease guard 从布尔 required 升级为明确 expected purpose。结构命令只能使用
  `track_structure` 租约，不能拿 `bulk_import`/`bulk_repair` token 冒充；校验顺序先确认持有人、base 和 token，
  再返回用途不匹配，避免无效凭据探测租约细节。旧 operation 路径也复用这一修正。
- Shared 批次 parser 原先允许 `Number.MAX_SAFE_INTEGER` 范围内的 revision/localRevision，但 Prisma 字段是
  PostgreSQL `Int`。本轮把边界收紧到 `2_147_483_647`，旧 operation 路由同步拒绝越界输入；服务还显式阻止
  revision/sequence 溢出，避免确定性坏请求退化为内部数据库错误。
- 没有新增 Prisma 表、迁移、第二套命令 dispatcher、快照 migration 或 WebSocket 可靠消息通道；复杂事务段
  均增加中文注释。`CLAUDE_WORK.md` 仍只作为被 gitignore 的当前任务书，不承担本日志职责。

### 测试、构建与剩余边界

- 新增三组真实 PostgreSQL/Fastify 集成场景：两条前后依赖命令只推进一个 revision；精确重试不重复快照、
  operation 或审计；不同 hash、乱序、子集和部分 ID 拒绝；第二条 precondition 失败时第一条不泄漏；畸形
  当前 payload 拒绝；同 base 并发只能一个成功；结构命令无租约/错用途拒绝、正确租约提交后原子释放；
  legacy 批次在路由边界返回 400。
- shared 批次合同 5/5、当前 ProjectData parser 5/5、共享命令 23/23、clean catch-up 17/17、平台草稿 20/20
  以及旧平台 operation 4/4、租约工具 3/3、committed cursor 2/2 通过。API 最终测试为 122/122，并通过
  14 条 migration 和真实 PostgreSQL 事务；仍只有仓库既有 pg 9
  `client.query()` 前置弃用提示。最终 `npm run build` 通过 Prisma generate、shared、document-model、Web 与
  API；Vite 转换 2091 个模块，CSS 124.92 kB / gzip 22.99 kB，主 JS 943.63 kB / gzip 280.06 kB，只有既有
  大 chunk 提醒，新增服务端 schema/事务没有进入 Web 主 bundle。
- R5b3a3 至此形成真实服务端原子提交能力，但当前用户编辑仍走旧两步兼容通道，所以不能宣称端到端可靠
  submit 已完成。下一轮 R5b3b 必须把浏览器 pending operation 状态迁为明确 submit/ack/reject，并处理超时
  幂等重试、离线恢复、结构租约续期、自动保存职责收缩和 dirty 客户端冲突；WebSocket 继续只做失效提示。

## 2026-08-04：R5b3b1 客户端原子提交规划、运行时与部分确认核心

### 本轮计划与实际边界

- 用户确认开始当前 roadmap 小轮，并再次明确 Development Log 必须持续维护。Codex 以 `f13af6f` 为基线
  重读 roadmap、被 gitignore 的 `CLAUDE_WORK.md`、document state、旧保存事务、自动保存、IndexedDB 草稿、
  服务端批次合同与新 API，确认本轮对应 R5b3b1：只建立可测试的客户端可靠提交核心，不在同一轮改写
  `App.tsx`、自动保存接线、租约取得、冲突 UI 或删除旧兼容通道。
- 审计确认旧保存会先逐条 POST operation 并把本地状态改成 `submitted`，随后才 PUT 完整 payload；因此旧草稿
  中的 `submitted` 是“可能已被旧入口接受、但未必提交 payload”的特殊事实，不能降回 pending 后送新原子
  endpoint。草稿 parser 本轮保持 schema version 1，并新增回归证明该状态往返不变。

### 完整链 planner、响应策略与运行时

- 新增 `platformAtomicCommandPlan.ts`。planner 从 saved ProjectData 开始，按 pending 顺序复用 document-model
  唯一 `applyAnnotationCommandToProject()` 执行整条命令链，并要求最终结果与 current ProjectData 深度相等；
  只有完整链通过后才按 shared 的 100 项上限截取首批并返回 acknowledgedProject。这样 101 项可分两批，
  但第 101 项仍参与首轮审计；第二条前置失败时不会错误提交第一条半批。
- planner 对 legacy、track-snap、snapshot boundary 和旧 `submitted` 返回机器可读 `legacy_required` barrier；
  重复 ID、local revision 非递增、type/envelope 不一致、命令 blocked 与合同外本地变化 fail closed。结构命令
  同时返回该批要求的 mutation lease purpose，但本轮不负责网络取得 token。
- 新增 `platformAtomicSubmitPolicy.ts`，严格核对成功响应的 `base + 1` revision、非空 cursor、operation 数量、
  ID/顺序、base/local revision、action、committed 状态与 committed revision。离线、fetch `TypeError`、408、
  429 和 5xx 可重试；409 是确定冲突，其他确定 4xx/协议损坏停止自动提交。该策略没有套用旧完整保存文案，
  避免把租约、precondition 或批次幂等冲突误判为普通网络故障。
- 新增 `platformAtomicSubmitRuntime.ts`。runtime 冻结完整 plan/request，以 operation ID + base revision 标识同批，
  保证 single-flight、最多五次有界退避、online 恢复、成功同批去重、协议错误阻断、手动唤醒和文件 generation
  迟到响应失效。它不持有 access token、全局 ProjectData、React setter、mutation lease 或 IndexedDB；成功后
  要求调用方重新规划下一批，不能拿旧 acknowledgedProject 自行拼接。

### Document state、自审修复与兼容性

- `projectDocumentState.ts` 新增 `acknowledgeAtomicCommandBatch()`。它核对非空批次、`base + 1`、当前 remote
  revision、冻结的 saved local revision、pending 精确有序前缀和末项 local revision；任一 stale/乱序/重复
  确认都不修改 refs/state。成功只推进 saved project、saved local revision 和 remote revision，移除对应
  pending、把 operation log 标成 acknowledged，保留后续 current project、pending、undo/redo 并返回结构化结果。
- 自审发现既有 dirty 判定只比较 ProjectData/吸附状态。当一组正反命令让正文回到 saved 值但 operation 尚未
  确认时，自动保存可能误判 clean。现把 pending operation 纳入初始与持续 dirty 判定；部分确认后仍有 pending
  就保持 dirty，最后一批确认且正文一致后才 saved。该修复属于新原子确认正确性，不改变本地 JSON 格式。
- runtime 首版只在显式 `requestSubmit()` 或 online 恢复时运行；自审后补成 eligible plan 初次/变化时零延迟
  调度，并增加 blocked plan key，防止协议错误或确定失败在 `finally` 中立即忙重试。请求期间切文件会使旧响应
  失效，新会话可在旧 flight 结束后自动启动；dispose 清 timer 且不应用迟到确认。
- 最终审查再收紧本地链完整性：每项 `baseRevision` 必须等于前项 local revision，且 `localRevision` 必须严格
  加一，避免缺失本地 operation 被误判为完整链。runtime plan key 不记录租约 token 明文，但区分是否已取得
  token，使结构批次从无租约 409 转为有租约计划时能够解除旧阻断；非有限测试批量上限也回退共享默认值。
- 本轮没有新增依赖、Prisma migration、ProjectData/JSON schema、WebSocket 消息、API 事务或可见 UI。旧
  `submitPendingOperations()`、旧 operation POST、完整 payload PUT 与 `markProjectAsSaved()` 明确保留给 R5b3b2
  兼容接线；源码检查未发现第二套 dispatcher、`any`、宽泛 catch 吞错或把 runtime 状态写入草稿。

### 验证结果与下一步

- 新 `npm run test:platform-atomic-submit` 最终 18/18：完整链、101 项分批、barrier、后续 precondition 失败、
  本地 mismatch、type/envelope、响应协议、错误分类、single-flight、同批 retry、409 停止、文件切换、dispose、
  协议损坏、离线恢复、租约计划解锁、revision 缺口、部分/最终确认和 stale remote revision 全部覆盖。
- 相关回归：平台草稿 22/22、自动保存 policy 4/4、自动保存 runtime 8/8、旧 platform operations 4/4、
  committed catch-up 17/17、shared command-batch 5/5。真实 PostgreSQL/Fastify API 122/122 通过 14 条 migration，
  仍只有仓库既有 pg 9 `client.query()` 前置弃用提示。
- `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。Vite 转换 2091 个模块，CSS
  124.92 kB / gzip 22.99 kB，主 JS 945.17 kB / gzip 280.38 kB；只保留既有大 chunk 提醒。`git diff --check`
  通过。本轮无 App/UI 接线，因此没有用浏览器点击伪装端到端验收。
- R5b3b1 至此完成，但平台用户实际保存仍走旧通道。下一轮 R5b3b2 必须把 planner/runtime 接入 App 与自动
  保存，按批取得/释放结构租约，成功后只部分确认、不额外 PUT，legacy barrier 才走完整快照兼容路径；409、
  offline、协议错误、草稿 flush 和 dirty 会话冲突必须有明确状态与人工恢复入口，完成后再删除新会话中无调用
  者的旧逐条 operation 提交路径。

## 2026-08-04：R5b3b2 编辑器原子保存、自动保存与结构租约接线

### 本轮计划与真实实现边界

- 用户确认开始 R5b3b2，并再次明确要求维护 **Development Log**。Codex 先核对 roadmap、当前任务单、App 旧
  保存事务、document state、自动保存、IndexedDB 草稿、mutation lease、冲突交接与 R5b3b1 planner/runtime，
  确认本轮目标是把真实平台编辑器迁到原子批次；WebSocket 仍只提供 revision/presence/activity 提示，clean
  catch-up 仍通过 committed HTTP feed 或权威快照恢复，dirty 文件不会被远端静默覆盖。
- `saveProjectToServer()` 现在先冻结一份 `ProjectDocumentRecoveryState`。可重放 pending chain 由 planner
  完整审计后按共享上限最多 100 项循环提交；每批成功只确认精确 pending 前缀、saved ProjectData、派生的
  track-snap baseline、saved local revision、remote revision 和 committed cursor，不再对同一内容追加完整
  payload PUT。请求期间继续产生的新编辑不会混入 frozen plan，仍作为下一轮 dirty/pending 自动保存。
- 新增 `PlatformAtomicCommandSubmitCoordinator` 和薄 React adapter。coordinator 把既有 retry runtime 包成一次
  可等待事务，同一文件会话只允许一个 plan；可重试网络错误保留同一 Promise 和 operation IDs，确定失败才
  返回，账号/文件切换明确取消旧等待且迟到响应不能确认新文档。自动保存 hook 改为消费 App 的显式 online
  fact，手动保存与自动保存复用同一高层入口。
- legacy、track-snap、snapshot boundary、旧 `submitted` operation 统一进入改名后的
  `saveLegacyProjectSnapshot()` / `submitLegacyPendingOperations()`。该通道保留旧草稿可能已 POST、尚未 PUT 的
  恢复语义。planner blocked、precondition/local-chain mismatch、revision/lease 冲突、协议损坏和确定 4xx 都
  fail closed；只有服务端精确返回 `annotation_payload_invalid`，证明数据库仍是旧 payload 时，才允许以同一
  revision/租约做一次完整快照迁移，不能把一般 409 借机覆盖掉。

### 浏览器排查发现的真实故障与自审修复

- 首次使用历史测试文件验证时，服务器 payload 只有旧测试标记，不满足当前严格 ProjectData schema；原子入口
  正确返回 `annotation_payload_invalid`。补上精确 migration fallback 后，旧文件会先迁为当前 payload，并按旧
  完整保存合同留下恢复快照；除此代码以外的 409 不进入该分支。
- 结构编辑已经在本地 commit 前取得租约，但 App 首次 planner 没有传入已有 token，只在 planner 返回 purpose
  后才考虑 acquire；结果已有租约反而被遗漏，服务器返回 `annotation_mutation_lease_required`。现首轮规划始终
  读取 runtime 当前 token，确实缺失时才 acquire 并对同一冻结链重新规划。
- 服务端为租约设置绝对持有上限。续期到上限后 expiresAt 不再前进，旧 runtime 把“距续期点 0ms”解释为立即
  再续，形成请求忙循环。现比较续期前后 expiresAt：不前进时只安排真实到期 timer，到期后清 token 并报告
  丢锁。批次提交消费 token 后，runtime 同步原位推进 base revision，下一结构批次使用新 revision 重新申请，
  不等待 React effect 卸载重建。
- 原子请求和服务器 revision 已成功，但界面一度显示 `dirty · 0 items` 并随后多发一次完整快照。第一层原因是
  结构命令改变了轨道集合，saved track-snap 基线没有随 acknowledged project 规范化；planner 现在显式返回
  `acknowledgedTrackSnapEnabled`，document state 与 ProjectData 在同一确认中推进。更深层根因是旧项目比较器
  用 WeakMap 按对象身份缓存序列化签名；导入规范化在首次比较后修改同一对象时，缓存继续声称旧内容相等或
  不等。现抽出纯 `areEditorProjectsEqual()`，每次比较当前值并保留媒体运行时忽略规则，删除项目签名缓存并
  增加“首次比较后修改同一项目仍能发现差异”的回归测试。定位用顶层领域扫描在确认根因后已删除。
- App 的原子最终错误日志只记录稳定 status/code/message，不输出 command payload、项目正文或租约 token。
  document state 保留一个仅输出项目/吸附布尔匹配结果的不变量警告，用于发现未来出现“无 pending 但仍 dirty”
  的保存基线漂移。
- 最终自审发现服务器返回租约过期/无效/用途不匹配后，runtime 可能继续持有坏 token，使下一次手动保存重复同一
  确定失败。现增加统一租约失败识别：保持文档 dirty/error，不回退完整快照，同时清除并 best-effort 释放本
  账号 token；下一次显式保存可按新 revision/purpose 重新 acquire。策略测试同时证明 revision 冲突不会误入。
- 排查期间本机一度出现 `ENOSPC`。只清理可再生成的 VS Code ShipIt 缓存，释放约 1.5 GB；没有删除仓库 `data/`、
  PostgreSQL 数据、对象存储或用户标注。旧 API 进程也曾让新路由表现为 404，重启当前 API 后确认并非代码路由
  缺失。这些过程保留在日志中，避免把环境故障误写成业务实现。

### 浏览器、数据库、测试与构建验收

- 在真实平台页面打开集成测试标注文件并进行结构编辑“新增动作轨”。干净基线为 revision 15、operation 8；
  自动保存后 UI 显示“可编辑 · 已保存”，数据库精确变为 revision 16、operation 9，最新审计为
  `commitMode=domain_command_batch`、`operationCount=1`、`mutationLeaseReleased=true`。继续等待后没有 revision
  17，活动租约为 0，浏览器控制台没有新增 warning/error。这证明结构编辑只走一次原子批次，没有随后完整
  PUT，也没有遗留租约。测试过程对集成测试数据产生的 revision 属于本地数据库状态，不是源码夹具修改。
- 专项回归最终通过：原子 planner/policy/runtime/coordinator/document/equality 23/23，mutation lease runtime
  6/6，自动保存 policy/runtime 12/12，平台 operation 4/4，IndexedDB 草稿/恢复 23/23，clean operation
  catch-up 17/17，共 85 项；shared 原子批次合同另行通过 5/5。真实 PostgreSQL/Fastify `npm run test:api`
  122/122，通过 14 条 migration；仍只有仓库既有 pg 9 `client.query()` 前置弃用提示。
- `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。Vite 转换 2097 个模块，CSS
  124.92 kB / gzip 22.99 kB，主 JS 957.18 kB / gzip 283.73 kB；保留既有大 chunk 提醒。未新增依赖、Prisma
  migration、JSON schema、第二套 command apply/parser 或可靠 WebSocket operation 通道；`git diff --check`
  通过。

### 剩余边界与下一轮

- legacy/track-snap/snapshot boundary/旧 submitted 与旧 payload migration 仍需要完整快照兼容入口，所以旧
  operation POST helper 不能只因主路径切换就删除。浏览器已验证当前格式结构命令原子保存和旧 payload 首次
  迁移；离线、幂等重试、文件切换和 legacy 路径由纯 runtime/集成测试覆盖，但本轮未在浏览器手工制造真实
  网络断开、双账号 409 和旧 submitted 草稿。
- 下一轮 R5b3c 应先建立可重复的真实双账号并发矩阵，再决定可解释的块级冲突策略。默认继续使用稳定实体、
  before precondition、revision、committed catch-up 和现有比较/恢复；结构与递归分叉保持租约。没有证据证明
  同字段并发必须自动合并前，不引入 OT/CRDT。

## 2026-08-04：R5b3c1 多账号乐观并发重放判定与真实冲突矩阵

### 计划、代码核对与实际范围

- 用户确认开始 R5b3c1，并再次提醒必须维护 **Development Log**。Codex 先重写被忽略的 `CLAUDE_WORK.md`，
  核对 roadmap、R5b3b2 原子保存、现有 409 草稿比较、clean committed-feed、document recovery state、共享
  dispatcher 和 API 原子提交事务。确认本轮只建立纯判定核心和真实双账号证据，不同时修改 App dirty baseline、
  冲突弹窗或 WebSocket，避免把算法建立与可见保存状态机重写混在一轮。
- 代码审查发现 `platformAtomicCommandPlan.ts` 已有正确但私有的整条 pending chain 审计；若直接新增 rebase
  循环，会形成两套 operation id/local revision/barrier/envelope/precondition 规则。现抽出
  `platformPendingCommandChain.ts` 作为唯一纯审计层，normal atomic planner 与 conflict planner 都消费它。
  抽取后删除 planner 中原有 Set/loop/barrier/blocked helper，没有保留近似僵尸实现。
- 新增 `platformConflictRebase.ts`。它严格检查新旧数据库 revision，先从原 saved ProjectData 重放本地链并验证
  current ProjectData 可被完整解释，再从最新 server ProjectData 按原顺序试运行同一 parsed envelope。成功
  返回完整 rebased project、原 client operation id/local revision/envelope 和首个所需租约用途；任一失败立即
  丢弃中间项目，只返回 operation id/index/type 及最多 20 个 `{code,targetKey}`。该摘要不含 before/after
  正文、轨道名、分叉名、项目 payload 或 token。
- `package.json` 新增 `test:platform-conflict-rebase`，没有引入依赖、Prisma migration、JSON/IndexedDB schema、
  新 API 或 UI。现有固定方向 stale-draft 比较仍是所有自动判定失败时的人工恢复入口。

### 真实双账号矩阵与失败过程

- Fastify/Prisma 集成套件新增真实 `admin` 与 `student` 场景：管理员创建当前格式文件并直接授予学生 read/write，
  两个账号都通过 GET 读取 revision 1 和同一 payload。管理员修改 `atomic-char-1` 提交至 revision 2；学生针对
  不同 `atomic-char-2` 的原 operation id/envelope 先以旧 base 1 提交，确定收到
  `annotation_command_batch_revision_conflict`。测试同时快照比较 revision、operation 数、recovery snapshot 数
  和 `domain_command_batch` 保存审计数，证明 409 没有留下半事务。
- 学生重新读取 revision 2 后，以同一 client operation id/envelope 和新 base 2 重提，成功到 revision 3，最终
  payload 同时保存管理员和学生两处时间修改。随后管理员先赢得同目标更新，学生旧 base 再次 409，测试不做
  第二次同目标重提；这与纯 planner 的 before mismatch 用例共同证明同目标不会被自动合并。删除学生直接授权
  并截断继承后，即使另一个 envelope 内容可重放，服务端仍返回 403，四类提交事实继续不变，说明客户端
  `rebase_ready` 从来不是授权证明。
- 新纯测试首次运行 5/8：两个断言误把 shared target key 猜成冒号字符串，但权威格式实际为稳定 JSON tuple；
  snapshot fixture 又传入了不存在的 `bulk_import` kind，使 builder 正确返回 null 并被识别为 legacy。修复方式
  是让测试遵循 shared 权威合同（JSON tuple 与 `import_project`），没有为迁就测试改生产格式或放宽 parser。
  修正后专项为 8/8；最终自审补上空 pending chain 用例并删除审计结果中无人消费的 `finalProject` 字段，避免
  留下看似可用但没有所有者的出口，最终专项为 9/9。

### 自审、验证与明确未完成项

- 自审确认两次 replay 都调用 `@xiqu/document-model` 唯一 `applyAnnotationCommandToProject()`；没有复制任何
  领域 resolver/writer/precondition。冲突失败 union 不包含 `rebasedProject`，第二条命令失败测试证明第一条
  已应用的局部结果不会泄漏；101 项链测试证明重放判定不受网络单批 100 项上限误伤。输入深比较证明 helper
  不修改 saved/current/latest project 或 operation 数组。
- 最终验证：`test:platform-conflict-rebase` 9/9；`test:platform-atomic-submit` 23/23；shared 原子批次合同 5/5；
  committed catch-up 17/17；平台草稿/恢复 23/23；真实 PostgreSQL/Fastify API 123/123（新增一项双账号矩阵，
  通过现有 14 条 migration）。API 仍只有仓库既有 pg 9 `client.query()` 前置弃用提示。
- `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。Vite 转换 2098 个模块，CSS
  124.92 kB / gzip 22.99 kB，主 JS 957.91 kB / gzip 283.90 kB；保留既有大 chunk 提醒。`git diff --check`
  与源码扫描通过，新增边界没有 `any`、TODO/FIXME、正文 console 日志或第二套 parser/apply。无新增依赖。
- 本轮故意没有接 App 自动 rebase，但仍使用真实浏览器和本地 PostgreSQL/API 回归了现有 409 人工恢复路径：
  创建当前格式双字符测试文件，先新增动作轨并自动保存到 revision 2，再修改第一个字符并保存到 revision 3；
  随后浏览器保留第一个字符的新 dirty 修改，另一账号/API 同时修改第二个字符并提交到 revision 4。浏览器原子
  提交确定收到 409，界面显示“存在远端冲突”，进入“比较本地草稿与服务器文件”后正确固定为草稿 r3 在左、
  服务器 r4 在右，并同时列出本地第一个字符与远端第二个字符两处结构化差异和选择性整合入口。这不是自动
  rebase 验收，而是证明新增纯 planner 没有破坏既有草稿 flush、权威重取和人工比较退路。
- 验收后已通过界面丢弃测试浏览器草稿并把临时标注文件移入回收站。控制台保留一次本轮主动制造的
  `annotation_command_batch_revision_conflict` 错误记录；更早的实时连接、租约和 track-snap 日志来自同一长期
  开发标签页的既有排查，不是本轮新增异常。下一轮 R5b3c2 才能在权威重取最新文件、再次核对草稿身份、
  revision、权限和计划指纹后展示可重放判定；经明确用户确认才可原子替换 document baseline 并用原 id/
  envelope、新 base revision 重提。任何同目标冲突、legacy barrier、最新 revision 再变化或撤权继续人工处理。

## 2026-08-04：R5b3c2 显式冲突重放确认、二次权威核验与安全重提

### 本轮计划与架构边界

- 用户确认开始 R5b3c2，并再次明确要求维护 **Development Log**。Codex 以 R5b3c1 commit `a52dc76` 为基线，
  先把被忽略的 `CLAUDE_WORK.md` 整体改写为本轮唯一任务书：409 后串行 flush IndexedDB、权威读取最新文件和
  草稿、生成轻量 proposal、明确用户确认、二次权威读取和指纹复核、crash-safe checkpoint、经既有编辑器入口
  恢复，再由普通自动保存重提。任务书明确同目标、legacy/track-snap/snapshot、撤权、revision 再变化和指纹
  漂移必须回到人工比较；不改 WebSocket 语义、不引入 OT/CRDT、不建立第二套保存入口。
- 新增 `platformConflictRebasePreparation.ts`，把 UI 前后的判定收敛为一个纯边界。初次 proposal 只含账号/文件、
  草稿时间和 remote base、服务器 revision、operation id/local revision/action/envelope version、租约用途及稳定
  指纹，不携带标注正文、before/after、项目 payload 或 token。用户确认后，准备器重新核对账号/文件身份、草稿
  时间与基准、服务器 identity/revision、当前 write capability、纯 planner 结果及指纹；任一变化返回机器原因和
  用户可见说明，不返回半份 recovery state。
- 准备成功时，以最新服务器 ProjectData 作为 `savedProject`、以完整 all-or-nothing 重放结果作为
  `currentProject`，保留原 client operation id、local revision、command envelope、本地 revision 和时间事实。
  Workspace 先将该状态写入以最新 remote revision 为基准的 IndexedDB checkpoint，写入成功后才通过唯一
  `enterPlatformFileAndMarkOpened()` 路径重建编辑器；之后由现有原子自动保存、ACL、revision 和 mutation lease
  规则重提，没有直接在对话框中写服务器。
- `PlatformWorkspace` 删除 `draftConflictVisible` 双 boolean 组合，`PendingDraftOpen.dialog` 明确区分
  `recovery`、`rebase`、`manual`。普通文件打开和 App 409 交接都使用同一 `buildPendingDraftOpen()`；人工比较
  可以返回已有 proposal，没有 proposal 的同目标/legacy 情况返回普通恢复说明。新增 Radix
  `PlatformConflictRebaseDialog` 只展示 revision、operation 数和租约用途，并始终保留“改用人工比较”。

### 自审发现与修复

- 首轮接线后自审发现一个会让所有 proposal 在确认时伪失效的生命周期竞态：App 的 `flushNow()` 已写入最新
  草稿，离开 dirty 编辑器时 unmount final capture 又会写一份内容完全相同、但 `updatedAt` 更新的草稿；proposal
  正确绑定草稿时间，因此第二次读取会误判为真实编辑。现增加 `arePlatformDraftContentsEqual()`，只忽略
  `updatedAt`，其余项目、operation、revision、吸附和时间事实全部深比较；同内容 final capture 跳过 put，任何
  真实变化仍写入并使旧 proposal 失效。新增回归同时证明项目正文变化不会被误去重。
- 初次 `build:web` 失败是新测试 `AnnotationFile` fixture 缺少当前 shared DTO 已要求的
  `owner.accountName`、`lastEditor.accountName` 和 permission `source`；修复夹具使其遵循现有合同，没有放宽生产
  类型。浏览器测试数据准备第一次使用 tsx 顶层 await，在当前 CJS 执行边界失败；改为 async IIFE 后成功。
  两次失败均属于测试/工具调用修正，没有留下替代脚本或生产兼容分支。
- 源码扫描确认本轮没有新增 `any`、TODO/FIXME、第二套 rebase planner、并行 IndexedDB 写路径或旧
  `draftConflictVisible`。CSS 只为新事实卡、二次核验说明和错误提示增加窄样式；按钮文案由“比较并处理冲突”
  改为“检查并处理冲突”，因为入口现在可能先提供安全重放，而不是必然直接进入 diff。

### 浏览器与数据库验收

- 在真实本地 PostgreSQL/Fastify/平台页面创建当前格式测试文件。浏览器以 revision 1 保留“春”的本地唱法修改，
  API 先后对两个不同句子写入远端修改并推进到 revision 3。自动保存收到 409 后，显式处理入口展示新重放对话框：
  本地基准 r1、服务器 r2、1 项 pending、无需结构租约。进入人工比较后可返回同一 proposal，证明两条退路不是
  相互覆盖的临时 modal 状态。
- 在 proposal 已显示后，API 再把服务器推进一版。点击确认时二次权威核验确定显示“服务器文件已产生新修订，
  请重新检查后再重放”，没有生成 recovery state、没有写服务器。取消并重新打开后，新 proposal 显示当前 r3；
  确认后编辑器恢复，普通自动保存将原 operation 提交至 revision 4。API 验证最终 payload 同时保留两处远端
  句级文字和本地“念白式”；committed feed 只有一条该本地命令，`baseRevision=3`、`committedRevision=4`，
  client operation id 与冲突前一致，证明没有制造新身份或额外完整快照 revision。
- 追加尝试用浏览器工具制造同字段竞态，但调度时远端 revision 已先被 clean catch-up 应用，本地随后生成的命令
  正确以远端新值为 `before` 并普通提交；因此这不是同目标并发样本，不能宣称人工 fallback 的浏览器竞态验收。
  本日志保留这次未命中时序的事实。同目标禁止自动 rebase 仍由 preparation 纯测试、R5b3c1 planner 测试和真实
  双账号 API 矩阵证明。测试文件及追加演练产生的本地数据库 revisions 最终已移入回收站，不属于源码夹具。

### 测试、构建与下一轮

- 专项最终通过：conflict rebase planner 9/9，二次准备器 6/6，原子提交 planner/policy/runtime/coordinator/
  document/equality 23/23，IndexedDB 草稿/恢复 24/24，自动保存 policy 4/4、runtime 8/8，committed catch-up
  17/17，共 91 项。真实 PostgreSQL/Fastify `npm run test:api` 123/123，通过现有 14 条 migration，仍只有仓库
  既有 pg 9 `client.query()` 前置弃用提示。
- `npm run build` 通过 Prisma generate、shared、document-model、Web 和 API。Vite 转换 2101 个模块，CSS
  125.30 kB / gzip 23.08 kB，主 JS 966.60 kB / gzip 286.13 kB；保留既有大 chunk 提醒。`git diff --check`
  通过。本轮没有新增依赖、Prisma migration、API 路由、JSON/IndexedDB schema 或可靠 WebSocket operation
  通道。
- R5b3c2 至此完成。下一小轮进入 roadmap 明确的 R5 可部署候选门禁：先盘点现有启动/迁移/对象存储/健康检查/
  备份恢复能力与缺口，再建立一个可重复的单服务器 PostgreSQL + Fastify + Web 部署方案和
  `docs/server-deployment.md`。它只形成可供试用的部署基线，不提前宣称 R7 的公网安全、真实云 IAM、跨区容灾
  或长期生产验收。

## 2026-08-04：R5 可部署候选门禁与单服务器运维基线

### 实际阶段核对与本轮范围

- 用户确认“开始 R2.3c2”时，Codex 先核对 roadmap、源码和最近提交，确认 R2.3c2 早已完成，当前真实基线是
  R5b3c2。没有按过时阶段名重复实现选择性整合，而是遵循既定目标进入 R5 最后一项可部署候选门禁。
- 本轮完全重写本机忽略的 `CLAUDE_WORK.md`，只保留当前任务：单服务器 Node.js 22、PostgreSQL 16、Fastify、
  Web 与本地/S3-compatible 对象存储；同源 `/api`；生产配置 fail closed；首次管理员；systemd/Nginx/TLS；
  迁移、健康检查、备份恢复、升级回滚与验收。明确不把这轮描述成 R7 公网生产认证，也不实现 Kubernetes、
  自动证书、云 IAM、跨区容灾或任务队列。
- 审计发现原生产入口无条件 `seed: true`、浏览器写死访问者机器的 `localhost:4317`、生产默认广泛 CORS，且
  新数据库在禁用开发 seed 后没有安全创建首管理员的路径。这些都属于真实部署阻断项，因此纳入本轮实现；
  没有用文档规避代码缺口。

### 生产启动、同源边界与首管理员

- 新增 `serverConfig.ts` 作为 API 运行配置唯一解析边界。开发环境保留现有便捷默认值；生产环境要求显式
  `DATABASE_URL`，默认 `HOST=127.0.0.1`、关闭开发 seed、关闭 CORS。端口、监听 IP、严格布尔值和有限
  HTTP(S) origin 均在创建数据库连接前验证，空值、通配符、路径、凭据或拼写错误直接终止启动。
- `buildApiApp()` 只在配置允许时注册 CORS；同源生产不发送 CORS 响应头。前端平台客户端统一使用 `/api`，
  Vite 开发服务器代理普通 HTTP 与 WebSocket 到本机 API，Nginx 生产代理保持同一路径。删除了误提交的
  `vite.config.js`/`.d.ts` 生成物，避免其抢先遮蔽 TypeScript 配置。
- API 关闭流程改为即使 Fastify hook 失败也继续逐项释放 Prisma、业务池、维护池和协作池；多个关闭错误会
  聚合报告。启动失败只输出稳定诊断，不把可能含数据库或对象存储凭据的 Error 对象和堆栈写入 journald。
- 新增一次性首管理员 bootstrap。纯业务边界严格验证账号、显示名和密码；Prisma 适配器在 Serializable
  事务内取得 PostgreSQL advisory lock，只有不存在活跃 admin/super_admin 且账号名未占用时才创建
  `super_admin`。CLI 密码只从 stdin 输入，拒绝密码 argv、未知参数和过大输入，避免 shell history、进程列表
  和环境模板泄密。已有管理员后该入口明确拒绝再次增权。

### 部署资产、smoke check 与真实问题修复

- 新增 `deploy/single-server/`：生产环境模板、受限 systemd 单元和同源 Nginx HTTPS/WebSocket 配置。环境模板
  不含真实密码、域名、token 或 TLS 材料；本地持久目录位于 release 之外，S3 配置继续复用既有唯一对象存储
  factory。
- 新增无凭据、只读 `deploy:check`：要求显式纯 origin，验证 Node.js 22、Web HTML 根节点、Fastify data
  envelope、liveness 服务身份和 readiness 依赖状态；它不登录、不写数据库，也不冒充完整业务验收。
- 第一次真实 smoke 使用 npm 常见的 `--base-url=value` 写法时，参数解析器只支持空格形式而失败；补齐两种
  标准长参数语法并增加回归。第二次 smoke 收到 SPA HTML 而不是 API JSON，排查发现 Vite 优先加载仓库中
  过时的生成 `vite.config.js`，导致 `.ts` 代理配置根本未生效；删除生成物、重启开发服务器后，同源 Web/API/
  WebSocket 入口恢复。这个问题不是通过新增备用 URL 绕过，而是移除了真正的僵尸配置。
- 生产坏配置负向演练最初把完整 Error 对象输出到终端，可能把连接串带入日志；随后改为稳定中文消息并复测
  缺数据库、坏 seed、通配 CORS 和越界端口均以状态 1 在监听前退出。

### 数据库、浏览器与运维文档验收

- 在一次性隔离 PostgreSQL schema 执行现有 14 条 migration 和首管理员创建。第一次验证脚本直接构造
  PrismaPg，绕过仓库 `database.ts` 的 `search_path` 对齐，因而查错 schema；这次失败揭示了真实的组合根
  约束。改为复用 `createPrismaConnection()` 后，成功创建并读取 `first.admin` 的 `super_admin` 角色，退出
  trap 随后删除临时 schema，复查无残留。另在现有开发库确认已有管理员时 bootstrap 会安全拒绝。
- 以 `NODE_ENV=production` 在临时 4318 端口启动编译后 API，readiness 为 ready；带恶意 Origin 的请求没有
  `Access-Control-Allow-Origin`。开发同源 smoke 通过首页、liveness 和 readiness。
- 浏览器使用真实本地 PostgreSQL/Fastify 与示例标注文件完成资源管理器进入、打开平台标注文件、观察
  “实时已连接 · 可编辑 · 已保存”并返回资源管理器；浏览器控制台无 warning/error。浏览器只用于用户可见
  路径验收，没有将浏览器状态当成自动化测试替代品。
- 新增 `docs/server-deployment.md` 作为唯一详细部署手册，覆盖拓扑、不变量、系统用户/目录、PostgreSQL 与
  `pg_trgm` 预置、release 构建、环境变量、本地/S3 对象存储、migration、首管理员、systemd、Nginx/TLS、
  smoke 与人工验收、一致备份和隔离恢复、升级、失败回滚、最终清单及明确限制。README、roadmap 和
  AGENTS 同步更新，旧的“R5 门禁尚未开始”和“R4 草稿/自动保存仍是未来工作”表述已删除。

### 测试、自审与剩余边界

- `npm run test:deployment` 最终 16/16：5 项部署 smoke 纯测试、5 项首管理员/CLI 测试、6 项生产配置测试。
  `npm run test:api` 134/134，通过 14 条 migration，仅保留依赖 `pg` 9 的既有弃用提醒。`npm run build:api`、
  `npm run build:web` 与完整 `npm run build` 均通过；Vite 仍报告既有主 chunk 超过 500 kB 提醒。
- `git diff --check` 通过。源码与模板扫描没有发现新增 `any`、TODO/FIXME、真实 secret、第二套数据库连接、
  第二套对象存储客户端或生产 seed 旁路。本轮没有新增 npm 依赖；Node 标准库、现有 Fastify CORS、Prisma、
  pg 和部署系统工具已能清晰完成需求，避免为了少量解析/探测再增加运行时包。
- R5 至此达到“多账号协作不静默覆盖、冲突可解释、可在受控单服务器重复部署试用”的完成标准，并按用户
  目标暂停继续扩展。尚未完成且不得误报为已完成的 R7 工作包括：真实公网主机防火墙与 TLS 自动续期、真实
  MinIO/AWS 最小 IAM 验收、外部告警接收、自动备份调度与加密、跨区容灾、容量压测、RTO/RPO 和长期安全
  审计；这些必须在实际目标环境记录证据。

## 2026-08-04：账号治理、权威媒体绑定与双账号同步可靠性修复

### 任务与排查事实

- 用户指出平台缺少正式账号管理、视频与项目/标注关系不清晰，并报告管理员与助教双开同一标注文件时出现
  “同步失败”：最初表现为管理员编辑助教可见、助教编辑管理员不可见，继续测试后管理员也曾失败。本轮先把
  被忽略的 `CLAUDE_WORK.md` 改写成唯一任务书，再按账号、媒体和协作三条边界实施，没有复活旧课程/作业、
  Workspace/Fork 或整份 JSON 静默覆盖模型。
- 直接读取开发 PostgreSQL 中标注文件 `d1043064-1aed-455b-bfb6-53c4b4de8c2d` 的 operation 与 save audit：
  文件最终为 revision 16，最后编辑者为助教；管理员有 9 条 accepted operation，助教有 7 条。最近 r13-r16
  严格按管理员、助教、管理员、助教交替成功，证明失败不按角色方向发生。唯一 `committedRevision = null`
  的记录是管理员在 2026-08-03 旧 operation + snapshot 流程留下的 r1 历史操作，与本轮助教失败无关。
- 根因分为两层：clean 客户端可通过 committed feed 追赶，但两个客户端均有本地 pending 时都会以同一服务器
  revision 提交，先到者成功、后到者得到 409；旧在线流程只把它停在“同步失败”，没有把已经实现的安全纯
  rebase planner 接入普通在线保存。另有真实 WebSocket 建连竞态：票据携带旧 head，presence join 后才订阅
  hub，中间一次提交可能既不在旧 ready 中也没有通知。顶部“已保存 · r0”又显示浏览器本地 history revision，
  即使服务器已到 v16 仍造成未同步错觉。

### 实现

- `annotationCollaborationRoutes.ts` 改为先注册文件 subscriber，再通过 ticket service 二次复核读权限并读取当前
  revision/cursor，随后发送 `session.ready`；ready 前到达的 revision 暂存，只补发晚于权威 head 的通知。
  客户端在每次 ready 后都唤醒 HTTP catch-up，4400/4401/4403 均视为当前身份/协议事实下的永久错误，不再用
  旧票据持续重连。WebSocket 仍只是有损唤醒，payload 追赶继续以 HTTP feed/snapshot 为权威。
- 普通原子保存收到 revision 409 后，读取最新 `AnnotationFile`，复用既有 `planPlatformConflictRebase()` 对完整
  pending chain 做 all-or-nothing 证明。只有领域命令身份、local revision、saved/current 项目和 precondition
  全部稳定且与远端修改无冲突时，document state 才替换服务器基线和重放结果；原 operation id/envelope 保留，
  旧 undo/redo 因基于过时远端快照而清除。自动保存 runtime 对 `rebased` 立即重提，不再额外等待 idle 周期。
  legacy、snapshot、track-snap、请求期间新编辑或同目标冲突仍进入已有人工比较，权限继续由服务器复核。
- 顶部平台同步状态新增服务器 revision：平台文件显示“已同步 · 服务器 vN”或“保存中 · 基于服务器 vN”；
  本地工具仍显示本地 rN，避免混淆两套 revision。
- 新增 `AccountAdminService` 和共享 `ManagedAccount` 合同。全局管理员可分页/搜索、创建、调整显示名/角色、
  停用/恢复和重置密码；当前管理员与最后一个活动管理员受保护，停用/重置撤销 session，不提供硬删除。
  所有账号可从资源管理器顶部修改自己的密码，成功后因旧 session 已撤销而立即退出。账号创建、更新、重置
  和自助改密写入不含密码/摘要的审计。账号 UI 使用明确的左侧选择与右侧编辑，不与逐资源 ACL 混合。
- `AnnotationFile.mediaResourceId` 由历史自由字符串收敛为指向 `MediaFile.resourceId` 的 Prisma 关系和数据库
  外键，媒体删除时 `SET NULL`。API 返回媒体资源/file id、名称、MIME 与大小摘要；绑定要求标注 write 以及
  媒体 read/download，改绑/解绑写审计。导入 JSON 后进入统一媒体选择器，可选择当前目录媒体、上传新媒体或
  明确暂不关联；Inspector 可查看、更换和解除。编辑器以 DTO 生成受保护 URL，保存前仍剥离 token URL，媒体
  关系不写入 `ProjectData`。
- 新增 migration `20260804140000_account_and_media_governance`，扩展审计枚举、清理无法指向媒体资源的旧值并
  建立外键。没有新增 npm 依赖；现有 Radix Dialog、Lucide、Prisma 和协作 runtime 足以保持代码边界清晰。

### 自审、测试与修复

- 新增平台集成矩阵覆盖：助教不能调用账号管理；管理员创建/改角色/重置/停用；重置与自助改密撤销旧会话；
  当前管理员不能停用自己；媒体创建时绑定、改绑、解绑、无媒体权限拒绝及媒体删除自动置空。既有双账号测试
  继续证明同 revision 竞争只有一个成功、旧请求零副作用、无交集命令可用原 operation id 在新 revision 重提、
  撤权后仍拒绝。document 与 auto-save 测试新增基线替换门禁和 `rebased` 立即重提。
- 首次完整平台集成测试中，新增媒体合同测试提前上传了两个 24-byte MP4，污染后续 80-byte 用户配额夹具，
  使旧上传测试以 usedBytes=72 拒绝第三个文件。没有放宽生产配额；测试在断言外键后删除专用媒体和确定孤儿
  FileObject，恢复用例隔离，随后全部通过。
- `npm run test:api` 全部通过，包括 34 个真实 PostgreSQL/Fastify 平台集成子场景；仍只有既有 pg 9
  `client.query()` 前置弃用提醒。`test:annotation-collaboration` 22/22、conflict rebase 9/9、原子提交相关
  24/24、auto-save runtime 9/9；shared/document-model/Web/API 构建通过。Vite 仍保留既有主 chunk 大于
  500 kB 提醒。
- 源码自审修正账号分页错误分类：只有游标确实不存在才返回输入错误，数据库连接/查询异常不再被吞掉。
  账号窗口无错误提示时的 grid 行数、媒体选择器滚动/视口约束和自助改密短表单均补齐。新逻辑使用中文注释，
  未增加第二套身份、媒体或冲突状态机。
- 最终浏览器复测先暴露了一项启动环境问题：Vite 默认只监听 IPv6 `localhost`，而既有验收标签页使用
  `127.0.0.1:5173`，旧页面可见但新 `/api` 请求显示 `Failed to fetch`。这不是账号或协作回归；以
  `vite --host 0.0.0.0` 重启后，同源健康检查、管理员登录、资源管理器、账号管理窗口和编辑器服务器 v16
  状态均恢复。API 继续监听 `4317`，前端监听 `5173`。

## 2026-08-04：同块先后编辑的远端追赶门禁

### 现场记录与根因边界

- 用户继续报告管理员与助教先后编辑同一个块时偶发“同步失败”。重新读取真实开发库后，文件已经从 v20
  推进到 v24：v21 助教修改第一句，v22 管理员修改其他句，v23 管理员再次修改第一句，v24 助教继续修改
  第一句。四条 operation 均为 accepted，且 v23/v24 的 `before` 精确等于上一账号提交的 `after`；API
  日志中的对应 command-batch 请求均返回 200。由此确认最近测试的服务端权限、命令 apply 和数据库提交链
  正常，也说明 operation 表只能证明成功提交，不能记录事务前已拒绝的请求或客户端确认展示状态。
- 进一步检查发现仍有一个客户端竞态：WebSocket 已通知更高 revision 后，权威 HTTP committed-feed 请求可能
  尚在 flight 或等待下一次合并唤醒。此时页面仍是 clean/saved，但 `ProjectData` 还是旧 revision；用户若在
  这个短窗口开始新拖动，就会生成基于已知过时值的命令。修改同目标时安全 rebase 必须拒绝，因此本机也可能
  短暂表现为冲突；真实网络延迟只会扩大这个窗口。不能用 last-writer-wins 掩盖问题。

### 修复与验证

- 新增纯 `platformRemoteEditGate`，明确拆分 collaboration 已观察 revision 与本地已应用 revision。只有客户端
  完全 clean、没有 pending/transient/inline/merge draft 且 observed 高于 applied 时，时间轴、Inspector、
  新增轨道按钮、导入/修复/撤销重做菜单和写快捷键暂时进入“正在接收其他账号修改”门禁；HTTP catch-up
  应用后自动解除。已开始的拖动或行内输入不被半途截断，真实并发继续由 command precondition、409 rebase
  和人工冲突流程裁决。
- 顶部状态改为在缺口期间显示目标服务器 revision；本账号原子提交、自动 rebase 和兼容快照提交也同步推进
  observed revision，避免显示状态倒退。Timeline 新增独立 shell 只负责短时交互门禁，没有改变时间坐标、
  拖拽、吸附或持久化命令逻辑。
- `test:platform-operation-catch-up` 19/19，包含 clean stale 门禁与“已开始编辑不截断”回归；协作专项 22/22，
  conflict rebase 9/9，Web TypeScript/Vite 构建通过，`git diff --check` 通过。Vite 仍只有既有主 chunk 超过
  500 kB 提醒。本轮没有新增依赖、数据库 migration、API 写路径或新的冲突合并策略。

## 2026-08-04：同目标实时并发协调与自动重提

### 问题复现与策略

- 用户进一步确认：两个客户端先后编辑同一块已经成功，但若双方都从同一旧 revision 开始、在收到对方更新前
  编辑同一块，后提交端仍收到 409 并停在同步失败。这个 409 是服务器严格 `before` 前置条件的正确保护；问题
  在于客户端只会重放无交集命令，没有在权威拒绝后协调同一目标。
- 没有改成整份 JSON 覆盖，也没有放宽 API 原子校验。实时保存必须先收到确定的 revision 409，再读取最新文件
  并完整审计本地 pending chain。时间块使用 start/end 两条边的相对 delta 重放，因此双方整体拖动量会相加、
  左右边界的独立缩放可以同时保留；同一文本/标签字段没有通用无损合并语义，采用后完成冲突恢复的一端版本。
  删除、生命周期、状态、轨道结构、批量边界和证据不完整的事务仍然 fail closed。

### 实现

- 新增 document-model `annotationCommandConflictResolution`，与普通严格 dispatcher 分离。它只转换 timing、
  content 以及仅含可安全转换叶命令的 annotation transaction；任一目标丢失、时间反转或高风险子命令冲突时
  丢弃全部临时结果。旧浏览器草稿路径默认不启用该模块，避免一次“服务器已提交但响应丢失”的 operation 被
  改写后重复应用。
- `platformConflictRebase` 增加显式 live-resolution 开关。严格重放失败后才调用值级协调，并返回既供网络提交
  使用的原子 operation，也返回改写后的 pending operation。operation id、action、local revision 和审计摘要
  保持不变，只有经过 parser/adapter 再验证的 envelope 被替换。
- document state 在接收重基线前重新检查项目、基线、revision、pending 数量/顺序/身份/type 和审计摘要；通过
  后原子替换 saved/current ProjectData 与 pending envelope，清空绑定旧服务器快照的 undo/redo。自动保存对
  `rebased` 继续立即重提，所以用户不会在协调完成后再次停留一个 idle 周期。顶部交互文案由“无冲突修改”改为
  “并发修改”，与真实策略一致。

### 验证与剩余边界

- 新增回归证明：默认 planner 仍拒绝同字段冲突；live 409 模式把内容命令重建为“远端当前值 -> 本端值”；双方
  对同一句块分别移动 1 秒和 2 秒后得到累计 3 秒；document state 确认保留 operation id 且 pending envelope
  的 `before` 已更新为权威值。
- `test:platform-conflict-rebase` 11/11、`test:platform-atomic-submit` 24/24、
  `test:platform-operation-catch-up` 19/19、`test:platform-auto-save-runtime` 9/9；shared、document-model、Web、
  API 构建及 `git diff --check` 通过。Vite 仍只有既有主 chunk 超过 500 kB 提醒。本轮没有新增依赖、数据库
  migration 或 WebSocket 写通道。
- 若同一内容操作的目标值已被另一端写成完全相同值，当前严格命令合同会把重建结果识别为 no-op；这类情况不
  会覆盖数据，但仍可能进入现有显式恢复。后续若要彻底消除该提示，应设计“服务器已满足本端意图”的可审计
  operation 确认语义，而不是伪造无变化命令。

## 2026-08-04：远端追赶 revision 双状态漂移修复

### 现场证据与根因

- 用户再次报告 admin 显示同步失败，且 ta 看不到 admin 的最新编辑。真实数据库证明 admin 的 timing operation
  已在 14:23:30 从 base revision 36 成功提交为 revision 37，状态为 accepted；admin 随后的 committed-feed
  游标也已到 revision 37 / sequence 38。因此不是权限拒绝、数据库丢写或网络请求未到达。
- 追查发现 clean catch-up 只更新了 App 的 `remoteBaseRevision` 和 cursor，document hook 的
  `syncState.remoteRevision` 仍停在追赶前版本。接收端随后本地保存时，服务器会正常提交，但
  `acknowledgeAtomicCommandBatch()` 以内部旧 revision 校验本次 base revision，遂把成功响应拒绝为
  `stale_remote_revision`。客户端因此保持 dirty/error，catch-up 又按设计暂停，表现为两端后续互相看不到。
  该路径与账号角色无关，所以 admin 与 ta 都可能在“先接收、再编辑”后触发。

### 修复与验证

- `replaceCleanProjectFromRemote()` 现在显式接收并校验远端 revision，在同一文档状态边界内推进 current/saved
  ProjectData、`syncStateRef.remoteRevision` 和 React sync state；App 的 committed replay 与 snapshot fallback
  均传入对应权威 revision。ref 先于 state 推进，覆盖追赶完成后立即发生本地编辑的时序。
- 新增回归精确模拟“clean 客户端接收 v36 -> 产生本地内容命令 -> 服务器确认 v37”，确认成功响应不再被误判、
  pending 清空且文档回到 saved。`test:platform-atomic-submit` 26/26、operation catch-up 19/19、conflict rebase
  11/11、Web TypeScript/Vite 构建通过；Vite 仍只有既有主 chunk 超过 500 kB 提醒。
- 第一处修复完成后，用户继续在未重载的 ta 旧标签页复现。数据库再次证明 ta 的 operation 已于 15:18:20
  从 v40 成功提交为 v41，随后 admin 又把文件推进到 v43；这确认旧页面保留的污染状态仍会误报，而不是出现
  第二种服务端失败。
- 为使旧标签页也可恢复，原子 plan 增加仅驻留内存的 `serverBaseProject`。成功响应遇到 document revision
  低于请求 base 时，只有当前 saved ProjectData 与这份冻结基线完全相同才补齐 revision 并确认；document
  revision 已超前或基线不一致仍拒绝。这样用户再次保存时可用同 operation id 获取幂等确认、清空 pending，
  随后继续追赶 v42/v43；刷新页面也可直接从最新权威快照重建。该逻辑不删除恢复草稿、不重复应用 operation，
  也不把低 revision 当作无条件放行依据。

## 2026-08-05：同一时间边界冲突改为后提交绝对值

### 现场证据与语义修正

- 用户让 admin 与 ta 基于尚未互相追赶的状态同时拖动同一开始边界。数据库 operation 53 记录 ta 把边界从
  `42.3137s` 移到 `45.9746s`；紧随其后的 operation 54 记录 admin 又从 `45.9746s` 移到 `49.6355s`。两段位移
  都是约 `+3.6609s`，证明旧值级 resolver 把 admin 基于旧位置的 delta 加到了 ta 已提交的绝对位置上。
- 这不是权限、WebSocket、时间轴坐标或数据库丢写问题，而是旧“移动量可交换”假设不符合人工标注语义。同一
  边界的两个编辑代表两个候选最终位置，不应累计；“靠后”定义为后到服务器并完成 409 恢复的提交，避免依赖
  客户端墙上时钟。

### 实现与边界

- timing 冲突现在逐边处理：本端未修改的 start/end 保留权威服务器值，本端修改的边采用本端命令中的绝对
  `after`。因此同一边界采用后恢复端结果，整体拖动采用后恢复端完整区间，而一端改 start、另一端改 end 时
  仍可保留两项修改。组合后若出现负时间或 end 小于 start，继续 fail closed 到显式冲突流程。
- 严格 before 校验、409 后完整 pending-chain 审计、原 operation id、原子重提、ACL/租约复核、clean HTTP
  catch-up 和 WebSocket 唤醒职责均未改变；这次没有退回到“同目标一律拒绝并发”，也没有引入整份 JSON 覆盖。
- `test:platform-conflict-rebase` 新增同边界、不同边界和整体拖动三类回归并通过 13/13。其余原子提交、远端
  catch-up 与 Web 构建在本轮完整验证中继续执行。

## 2026-08-05：平台角色分权与助教角色合并

### 权限语义

- `super_admin` 继续拥有全部平台能力，并成为唯一可调用账号列表、创建、角色/状态调整和他人密码重置 API
  的角色。`admin` 保留全资源、根目录、ACL、全局审计、诊断、维护和对象生命周期能力，但账号治理 API 与
  前端入口均移除；服务端集成测试证明普通 admin 查询账号返回 403、读取系统诊断仍返回 200。
- 删除 `ta` 平台角色并迁移为 `teacher`。迁移先处理同时拥有 teacher/ta 的唯一约束，再原地转换角色并替换
  PostgreSQL 枚举；账号、会话、资源 ownership、直接 ACL 和审计身份不变。开发账号名 `ta` 暂时保留为登录
  夹具，但其平台角色和显示身份已经是 teacher。
- teacher 的角色自动能力集中定义为全资源 `read + download`，权限来源为 `role`。它不会自动获得 `write`、
  `review`、`create_child` 或 `manage_permissions`；显式 ACL 和 ownership 仍可增加能力。教师继承原助教的只读
  账号目录浏览能力。未来师生附属关系只预留集中策略边界，本轮未创建关系表或隐式授权。

### 实现与验证

- 新增共享 `platformRolePolicy`，统一账号治理、全资源管理、教师自动浏览和账号目录判断。后端
  `ResourceAccessService` 不再用单个 `isGlobalAdmin` 混淆账号与资源语义；前端资源管理器也分别控制账号管理、
  审计和诊断入口。权限模型、roadmap、部署说明与 AGENTS 已同步更新。
- 新迁移 `20260805110000_merge_ta_role_into_teacher` 已在开发库和隔离 `api_test` schema 成功执行。角色策略与
  bootstrap 测试 8/8、完整 API/PostgreSQL 测试 139/139、shared/API/Web 类型检查和 Web 生产构建通过；仅保留
  既有 Vite 主 chunk 超过 500 kB 提醒。

## 2026-08-05：资源下载权限闭环

### 实现

- 新增统一 `/api/resources/:resourceId/download`：媒体文件从对象存储原生流式返回，避免大型视频进入浏览器
  Blob 内存；标注文件导出数据库当前 revision 对应的权威 payload，并使用 UTF-8 `Content-Disposition` 保留
  中文文件名。项目和文件夹不会伪装成同步下载，后续应通过有界异步 ZIP 归档任务实现。
- 资源管理器的三种视图共用右键“下载”命令，Inspector 同时提供明确下载按钮。入口仅对媒体/标注文件及
  拥有 `download` 的账号显示或启用；浏览器通过现有受保护 token URL 让原生下载器边接收边落盘。
- 服务端把 `download` 与 `read` 分开校验：能够浏览或打开资源不再意味着可以直接调用导出路由。新增集成
  回归覆盖标注 JSON 内容、无下载权 403、教师媒体下载、中文/普通文件名响应头及容器资源 400。

## 2026-08-05：媒体文件 size 迁移 BigInt，移除 2 GiB 单文件硬上限

### 背景

- 单媒体文件此前被硬性限制在 2 GiB 以内，根因不是产品需求而是数据库实现细节：`FileObject.size` 与
  `MediaFile.size` 在 Prisma 中为 `Int`（PostgreSQL Int4 上限约 2.147 GB），`uploadPolicy.ts` 用
  `MAX_DATABASE_FILE_BYTES = 2_000_000_000` 在启动时拒绝更大的 `XIQU_MAX_UPLOAD_BYTES`。

### 实现

- `prisma/schema.prisma` 将 `FileObject.size`、`MediaFile.size` 由 `Int` 改为 `BigInt`；新增迁移
  `20260805120000_file_size_bigint`，用 `USING "size"::bigint` 把两列原地升格。线格式仍为 JSON `number`，
  BigInt↔number 转换集中在应用 mapper 边界：写边界 `BigInt(input.size)`（`commitUploadedMedia` 两次 create），
  读边界 `Number(...)`（`toFile`、`mapResource`、`mapAnnotationFile`、`DownloadableResource`、
  `systemDiagnosticsService`、`operationalMetricsCollector`、`objectLifecycleService` 孤儿摘要、备份 manifest
  构建）。复制路径源已是 bigint，直接透传到目标 create。
- 删除 `MAX_DATABASE_FILE_BYTES` 常量及其启动校验（为 Int 列存在的临时护栏，迁移后为僵尸代码）。`XIQU_MAX_UPLOAD_BYTES`
  不再默认 1 GiB：未显式设置时默认等于用户配额——单文件不可能超过账号配额（上传时配额检查会拒绝），故以配额作为
  单文件上限，避免又一道人为天花板。显式设置时仍受 `readPositiveInteger` 的 safe-integer 约束（上限约 9 PiB）。未
  引入全局 `BigInt.prototype.toJSON` 补丁，未改线格式或前端。
- 审计 `media_upload` detail 的 `size` 仍写入 `input.size`（number），JsonValue 可接受；配额算术已有的
  `Number(... ?? 0n)` 模式不变。

### 验证与残留风险

- `db:generate` 后完整 `npm run build`（shared/document-model/web/api）通过，仅保留既有 Vite 主 chunk 超
  500 kB 提醒。`test:uploads` 4/4、`test:api` 139/139（迁移在隔离 `api_test` schema 执行）、`test:observability`
  13/13、`test:backup` 28/28 全部通过。`uploadPolicy.test.ts` 改为断言 5 GiB 策略被接受且配额关系仍校验。
- 残留：`XIQU_MAX_UPLOAD_BYTES` 默认已改为等于用户配额（不再 1 GiB），运营方仍可以 `db:deploy` 部署新迁移并在
  需要时显式设置更紧的单文件上限。超过 2 GiB 的部署侧依赖已在模板中显式化：`deploy/single-server/nginx.conf.example`
  的 `client_max_body_size` 加注必须与 `XIQU_MAX_UPLOAD_BYTES` 对齐且可超过 2 GiB，`/api/` 的
  `proxy_read_timeout`/`proxy_send_timeout` 由 75s 放宽到 300s 以适配大文件与空闲协作 WebSocket；
  `xiqu-platform.env.example` 的 `XIQU_MAX_UPLOAD_BYTES` 同样加注。`number` 在 2^53 以下精确，单文件到 9 PiB
  仍安全，远超当前平台配额；若未来平台总容量接近该量级需重新评估线格式（改 string 或引入 BigInt JSON 约定）。

## 2026-08-05：修复大文件 S3 发布与默认反向代理上限

### 审查发现

- BigInt 迁移虽然移除了数据库 Int4 上限，但 S3 适配器仍对所有 staged 对象调用单次 `CopyObject`；标准
  S3 单次复制最多支持 5 GB，因此超过该边界的文件会在完成耗时上传后才在发布阶段失败。
- 应用与环境模板默认单文件上限已是 20 GiB，而 Nginx 模板仍为 `client_max_body_size 1024m`；按模板部署
  会在反向代理层继续拒绝超过 1 GiB 的请求。

### 修复

- `S3ObjectStorage.promoteStagedObject()` 现在按大小选择发布协议：不超过 5 GB 保留单次 `CopyObject`；
  更大的对象先规划连续闭区间，再使用 `CreateMultipartUpload`、有限并发 `UploadPartCopy` 和有序
  `CompleteMultipartUpload` 完成发布。规划会动态增大 part size，保证 5 TB 上限内不超过 10,000 part。
- 任一分片或 complete 失败都会等待已启动请求收束并执行 `AbortMultipartUpload`；abort 也失败时使用
  `AggregateError` 同时保留两个错误。只有完整发布成功后才删除 staged 对象，上层补偿语义保持不变。
- 单服务器 Nginx 模板改为 `client_max_body_size 20g`，环境模板显式设置
  `XIQU_MAX_UPLOAD_BYTES=21474836480`，两侧默认值与用户配额一致；部署文档强调修改时必须同步。

### 验证

- 新增分片规划和命令编排测试，覆盖 20 GiB 连续区间、5 TB/10,000 part 边界、成功 complete 后删除
  staged，以及分片失败 abort 且保留 staged。`build:api` 与 `test:object-storage` 10/10 通过。
- `test:s3-storage` 使用真实 SeaweedFS S3-compatible HTTP 协议验证既有 staged/promote/Range/list/delete、
  能力探针、远端备份和生命周期路径，5/5 通过。真实 5 GB 数据传输未纳入常规测试，以命令级测试避免
  CI 制造巨型临时对象；生产部署仍应以目标 S3 服务执行一次大文件验收。

## 2026-08-05：R3h1 跨目录服务器媒体选择闭环

### 实现

- 将 JSON 导入和 Inspector 原本只读取直接父目录前 200 个媒体的窗口，改为可浏览资源根、项目和文件夹的
  共用媒体选择器。选择器复用现有资源列表 API、权限 DTO、Radix Dialog 和服务端 cursor，提供上级、
  面包屑、进入目录、当前目录搜索、加载更多、刷新、当前关联展示、明确解绑和上传到当前目录。
- 抽出 `resourcePickerPaging.ts`，以有限页预算跳过纯无关资源页并保留 cursor；移动目标选择器改为复用同一
  helper，删除重复的分页循环。选择器不会为了寻找媒体偷偷抓取完整目录。
- 平台编辑器“文件”菜单新增“关联服务器媒体”，并保留“导入本地视频”。编辑会话持有权威 parent/media
  DTO；改绑只允许发生在完全 clean、无保存/冲突/远端 revision 缺口的状态，通过
  `replaceCleanProjectFromRemote()` 原子刷新运行时媒体，不产生 undo、history 或 pending operation。
- 新增纯策略 `platformMediaBindingPolicy.ts`，集中媒体改绑门禁，供后续 uploaded/VOD 来源共用。显式解绑
  现在会清除旧 payload 中残留的 `platform-file:` 路径；只有缺省旧 DTO 才走历史迁移 fallback。
- 上传响应可在列表刷新前直接成为有效选择；上传/确认期间统一阻止关闭，失败保留目录、搜索和选择，并只在
  对话框原位显示一份错误。根级标注文件也能打开选择器，但必须进入有 `create_child` 权限的容器后才能上传。
- 未新增依赖：现有 Radix、Lucide、资源 API 和分页模型足以完成本轮，额外引入文件浏览组件会重复现有 ACL、
  cursor 和桌面样式语义。

### 审查与验证

- `test:resource-column-pages` 6/6，通过选择器跳页、去重、面包屑和有限预算 cursor 回归。
- `test:platform-drafts` 32/32，通过 clean 门禁、显式解绑、权威媒体 DTO 和旧路径兼容回归。
- `test:api` 144/144，通过 PostgreSQL 隔离 schema 下的媒体绑定/改绑/解绑、跨资源权限、上传、Range、
  账号、资源、恢复、协作及运维全套集成测试；仅输出既有 `pg` 9.0 弃用预告。
- `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API；仍只有既有 Vite 主 chunk
  超过 500 kB 提醒。`git diff --check` 通过。
- 应用内浏览器实际验证了 Inspector 与编辑器两处入口、从《寻梦》项目返回资源根、进入其他项目、目录内
  搜索空结果、当前媒体展示、上传目标提示和本地视频入口保留；桌面截图显示窗口无遮挡、列表/页脚未溢出，
  项目控制台无 warning/error。浏览器宿主曾输出一次自身 Statsig 网络告警，不属于本应用日志。

下一步：R3h2 建立 uploaded/aliyun_vod 严格来源模型与安全播放会话 API；本地计算机媒体、服务器上传媒体
和 VOD 三条工作流必须并存，不把 AccessKey、Secret、playauth 或临时播放地址写入数据库、标注 JSON、草稿、
operation、审计详情或协作消息。

## 2026-08-05：R3h2 媒体来源抽象与阿里云 VOD 安全边界

### 已完成

- `MediaFile` 改为数据库约束保护的 uploaded/aliyun_vod 判别来源，并显式保存 video/audio 种类。uploaded
  必须关联 `FileObject + MIME + size`，VOD 必须只包含 `vid + region` 且没有平台对象；迁移从既有 MIME
  推导媒体种类，遇到异常旧数据会失败而不是静默写入错误分类。
- 共享 `AnnotationMediaReference` 改为严格判别联合。uploaded 继续生成当前账号的受保护对象 URL；VOD
  只向编辑会话传递稳定身份，绝不把 vid 拼成 URL 或送入浏览器完整 fetch/decode。资源 DTO 同步提供来源、
  种类与时长，列表和 Inspector 能区分“视频/音频”与“VOD 视频/VOD 音频”。
- 引入阿里云官方 `@alicloud/vod20170321` 3.11.3、`@alicloud/openapi-client` 0.4.15 和
  `@alicloud/credentials` 2.4.5，均采用 Apache-2.0。官方 SDK 替代自写签名协议并经可注入
  `AliyunVodGateway` 隔离；凭据只走默认凭据链，供应商异常被压缩为有限类别，原始 SDK Error、AccessKey、
  Secret 和响应不会向业务层传播。
- 新增显式 VOD provider 配置、能力查询、媒资验证/创建和短时播放会话 API。播放凭据响应使用
  `Cache-Control: no-store`，数据库、审计和资源 DTO 均不保存 playauth；审计创建记录也刻意不写 vid。
- 复制 uploaded 继续复用不可变 FileObject；复制 VOD 只复制稳定远端引用且对象复用计数保持 0。VOD
  删除不操作阿里云远端，平台原文件下载返回稳定不支持错误；上传媒体下载、Range、容量和对象生命周期
  保持原逻辑。
- 资源管理器和跨目录媒体选择器共用 VOD 创建对话框，并同时保留本机导入、服务器上传与 VOD 三条入口。
  VOD 未启用时原位解释且不影响其他媒体。VOD 在 R3h3 播放适配完成前进入明确的只读过渡状态，不呈现空
  黑屏或误触发本地重关联。

### 已确认的后续约束

- R3h4 不会把播放视频完整缓存到浏览器再计算波形/频谱。uploaded 视频由后台从对象流分块提取，VOD
  自动使用同 vid 的纯音频转码流，本机视频继续默认使用内嵌音轨。
- 用户必须始终能强制选择一条有权限的服务器上传 WAV/FLAC/MP3 作为分析音频，使波形、频谱和 F0 完全
  绕过可能卡顿的阿里云接口。该入口在自动来源正常时也可见，不是失败后的隐藏兜底；用户还可固定 VOD
  音频来源或显式恢复自动选择。关系属于平台媒体/派生资产层，不写入 `ProjectData`。

### 审查与验证

- migration 在 `api_test` 与开发 `public` schema 均通过 `prisma migrate deploy`。SDK mapper、短时凭据
  安全余量、错误收敛、provider 配置和两类 payload hydration 专项测试 14/14 通过。
- `npm run test:api` 首轮发现测试误把复制 API 的 ResourceEntry 回包当成统计回包；业务复制已成功，修正为
  核对既有审计统计合同后，完整 API 149/149、其中平台集成 36/36 通过。覆盖 VOD 创建、同名冲突、权限
  拒绝、绑定、短时会话、无原文件下载、复制引用/对象计数、审计脱敏，以及旧 uploaded 上传/Range/复制/
  解绑回归。
- 完整 `npm run build` 通过 Prisma generation、shared、document-model、Web 和 API；仅保留既有 Vite 主
  chunk 超过 500 kB 提醒。`git diff --check` 通过。
- 应用内浏览器验证资源工具栏和统一媒体选择器同时显示上传/VOD 入口，provider disabled 界面无溢出，
  临时 VOD 资源显示为“阿里云 VOD · 视频 · 时长”，绑定后编辑器展示明确 R3h3 过渡状态。随后已解绑并
  删除临时资源；应用控制台无 warning/error。

### 待推进

- R3h3：把 App/VideoPlayer 的原生 DOM 控制收敛为统一播放器接口，并使用受控加载的 Aliplayer 适配
  VOD 短时会话，严格回归 seeking、边界预览、循环、快捷键与分离窗口时间语义。
- R3h4：实现平台分析音频来源选择、强制服务器上传音频、后台流式解码，以及版本化波形/频谱/F0 资产。
- 真实阿里云账号 smoke 尚未执行；需要目标部署的最小权限身份和样例 vid 后再验证真实 playauth、过期刷新、
  非 Normal 媒资与供应商限流。当前 fake gateway 与 disabled-provider 浏览器路径均已完成。

## 2026-08-05：R3h3 原生媒体与阿里云 VOD 统一播放控制器

### 已完成

- 新增 App 只依赖的 `MediaPlaybackController`，以同步快照和 `seek/play/pause/setPlaybackRate` 取代对
  `HTMLVideoElement` 的直接属性、事件与 `seeked` 临时监听。P、Tab、空格、持久/临时循环、普通跳转、
  单次范围终点和本地视频切换均复用同一命令顺序；后发命令使旧异步操作失效。
- 将原生媒体封装为窄后端，所有 seek 在目标已到达、`seeked`、媒体错误、超时或来源销毁时确定结算；
  页面仍保留 50% 初始音量、hover controls、元数据、requestAnimationFrame 播放头和独立窗口布局。
- 新增 Aliplayer 后端，严格映射 ready/timeupdate/seeked/play/pause/ended/error，统一倍率和预览语义。
  短时 playauth 仅驻留实例内存；到期前/供应商错误触发单飞刷新，先取得新会话再替换旧实例，并用 generation
  阻止迟到回调复活。快速预览替换、来源切换和 dispose 被视为正常取消，不显示假错误。
- Aliplayer 2.38.3 使用固定 `g.alicdn.com` 官方 JS/CSS 的受控单例 loader。未安装约 7 MB、无 TypeScript
  类型且 npm 元数据未声明许可证的 `aliyun-aliplayer` 包；本地只声明实际使用的窄类型，不复制第三方源码。
- 抽出平台播放来源纯边界：本机 Blob URL 与 uploaded 受保护 URL 走 native，VOD 只保留 resourceId/vid 并
  延迟请求 no-store 会话，未绑定媒体进入明确 unavailable 状态。三条用户工作流均保留。

### 审查与验证

- 新增 `test:media-playback`，15/15 通过，覆盖 latest-command 顺序、原生 seek/error/dispose、SDK 已有全局/
  并发去重/失败重试、VOD ready/seek/rate/play/pause、刷新单飞、刷新失败保留旧实例、会话身份验证和三类
  来源判别。
- 完整 `npm run test:api` 149/149、平台集成 36/36 通过；完整 `npm run build` 通过 Prisma generation、
  shared、document-model、Web 与 API，`git diff --check` 通过。仅保留既有 `pg` 9.0 弃用预告和 Vite 主
  chunk 超过 500 kB 提醒。
- 应用内浏览器用全新标签页验证本地原生示例视频成功加载，统一播放器能播放/暂停，加载遮罩严格覆盖画面
  且元数据完成后消失，工作台布局无溢出，新页面控制台无 warning/error。真实阿里云账号 smoke 尚待目标
  凭据，不能以 fake 测试冒充完成。

### 待推进

- R3h4：建立分析音频自动来源与显式覆盖。自动选择本机/上传视频内嵌音轨或同 vid VOD 纯音频转码；用户
  始终可以强制选择服务器上传音频、固定 VOD 音频或恢复自动选择，关系只进入平台媒体/派生资产层。
- R3h4：以后台流式解码、版本化 manifest、多分辨率波形、频谱瓦片和 F0 资产取代浏览器完整视频下载与
  整段 PCM 常驻；真实云端 playauth、凭据刷新、限流和非 Normal 媒资继续列为部署 smoke 缺口。

## 2026-08-05：R3h4 分析音频来源、后台流式计算与按窗派生资产

### 已完成

- 新增 `AnnotationAnalysisAudioSetting`、`MediaAnalysisRun`、`MediaAnalysisAsset`，并扩展
  `ProcessingJob` 的 claim、心跳、尝试次数和稳定错误字段。数据库 check/unique/FK 约束保护来源模式、
  时间坐标、进度、资产唯一性和同一 run 只存在一个活动任务；分析设置、任务和资产均留在平台层，不进入
  `ProjectData`、草稿、撤销栈或协作 operation。
- 建立自动与强制分析音频来源。uploaded 视频/音频直接读取对象流，VOD 使用同 vid 的 HTTPS mp3 纯音频
  转码；用户始终可以强制选择有 `read + download` 权限的服务器音频或 VOD，并恢复自动来源。设置和任务
  创建均重新校验标注文件及媒体 ACL，临时 URL、playauth、凭据和供应商原始响应不落库、不进 DTO/日志。
- 增加独立 analysis worker。PostgreSQL 原子 claim、心跳、陈旧任务恢复和 SIGTERM 回队列构成可恢复执行
  边界；FFmpeg 使用 `shell: false`，uploaded 对象经 stdin 流入，VOD 临时 URL 只传给 worker 子进程。PCM
  固定为 16 kHz 单声道并按 30 秒释放，不缓存完整视频，也不保留整段 PCM。
- 每个瓦片生成四级波形 min/max/RMS、`time-detail`/`frequency-detail` 两档频谱和 voiced-only F0。
  波形桶宽固定为 64/256/1000/4000，频谱 hop 固定为 128/480；这些参数都整除 30 秒采样数，并进入
  config hash，避免跨瓦片累计时间漂移或新旧资产误复用。频谱使用统一 dBFS 标尺，避免逐瓦片峰值归一化
  产生亮度接缝。
- 前端新增平台分析 hook：状态请求单飞、任务轮询、文件 generation 隔离、可视窗/缩放选择、AbortController、
  连续瓦片校验和 48 项字节缓存。Timeline 只组装当前窗口附近的波形/频谱/F0；平台媒体不再进入浏览器完整
  下载分析路径。波形和频谱先求时间窗与资产范围的交集，正负音频偏移不会把首尾数据复制到空白区域。本地
  计算机媒体仍可用共享算法，但增加 256 MiB 下载前后上限和明确错误。
- 波形/频谱设置面板增加来源摘要、任务状态、选择分析音频、恢复自动和开始/重算；JSON 导入、服务器媒体、
  VOD 和本地媒体三条入口继续并存。通用但没有真实消费方的裸 `createProcessingJob` API/客户端已删除。
- 对象发布采用 staged -> promote -> database fact，发布或数据库写入失败均补偿；清理失败落为
  `analysis_cleanup_failed`。对象生命周期、备份 manifest、恢复演练同时把 `MediaAnalysisAsset.storageKey`
  视为正式引用，旧 version 1 manifest 缺少派生对象摘要时仍可读取。
- 部署模板增加独立 systemd worker、`XIQU_FFMPEG_PATH` 和 FFmpeg/阿里云最小权限说明。阿里云 SDK 继续使用
  既有官方依赖，没有为队列另引入 Redis/BullMQ，也没有把大体积 FFmpeg 二进制打进 npm 依赖。

### 审查与验证

- `npm run test:media-analysis` 16/16：覆盖 VOD 纯音频筛选、30 秒共同边界、统一 dBFS、stdin/URL FFmpeg、
  PCM 分块、worker claim/陈旧恢复、对象补偿、前端连续瓦片、缺号拒绝和非零音频偏移的真实范围裁剪。
- `npm run test:api` 160/160：PostgreSQL 隔离 schema 下覆盖分析设置、ACL、任务/资产、生命周期，并回归账号、
  资源、上传/Range、协作、命令保存、恢复和治理接口。
- `npm run test:backup` 28/28，`npm run test:deployment` 18/18，`npm run build` 通过；构建仅保留既有 Vite
  主 chunk 超过 500 kB 提醒。
- 应用内浏览器使用 356.6 MB、1494.4 秒的《寻梦》上传视频完成全片分析，run 生成 350 项资产；实际显示
  波形和频谱，F0 开关可启用。另以 62.6 KB WAV 强制覆盖并恢复自动来源。冷加载后视频首帧、播放状态和
  分析图层均正常，先前“正在准备媒体”仅发生在 Vite HMR 中。
- 对样例 VOD ID `00cf8df6907871f1b31f5017e1f80102` 已通过官方 SDK 发起真实请求；本机默认凭据链为空，
  因而只得到脱敏后的 `temporarily_unavailable`。fake gateway 仅证明协议和错误边界，不作为真实云端验收。

### 待推进

- 在目标阿里云凭据环境中，以最小权限身份为该 VOD ID 完成 `GetVideoInfo`、`GetVideoPlayAuth`、`GetPlayInfo`
  smoke，验证真实播放、过期前刷新、纯音频分析、无权限/非 Normal/限流错误和日志脱敏；不得把 AccessKey、
  Secret、playauth 或临时 URL 写入仓库、数据库、截图或开发日志。
- 生产部署时安装并固定受支持的 FFmpeg，启用并监控 analysis worker；真实 S3/VOD 环境还应核对长任务心跳、
  SIGTERM 回队列、对象补偿和供应商卡顿时强制 uploaded audio 的体验。

## 2026-08-05：R3h 真实阿里云 VOD 音频验收与 Web License 修正

### 已完成

- 使用最小权限阿里云身份对样例 VOD ID 完成真实 `GetVideoInfo`、`GetVideoPlayAuth` 与 `GetPlayInfo` 请求。
  媒资状态为 Normal，时长约 1494.4 秒；生成 MP3 转码后，纯音频接口返回 Normal、HTTPS、约 128 kbps 的
  MP3 流。供应商响应、PlayAuth 和临时 URL 均未写入日志或文档。
- 从编辑器“音频轨道设置”使用自动 VOD 来源启动真实任务。analysis worker 流式解码 1494.413 秒、16 kHz
  单声道音频并成功生成 350 项资产：四级波形各 50 片、两档频谱各 50 片、F0 50 片。浏览器已显示完整
  波形和频谱，F0 开关可正常启用。
- 对对象目录和数据库做了脱敏审计：本轮只新增 350 个派生瓦片，未生成 MP3/MP4/m3u8 缓存；run config、
  manifest、job、audit 和 annotation payload 均未出现 PlayAuth、AccessKey ID 或临时音频 URL。历史标注中
  仍有一个普通 HTTP URL，不含凭据词或 AccessKey 形状，不属于本轮泄漏。
- 浏览器明确复现 Aliplayer `4036 LICENSE ERROR`。2.38.3 与控制台示例使用的 2.35.4 都报告“未配置
  License”，证明 SDK 降级无效；试验改动已撤销，继续固定 2.38.3。
- 复核阿里云官方“快速接入 Web 播放器”和“管理 License”文档：初始化必须传入与控制台 Web 应用完全一致的
  `domain + License Key`；新购 Web 标准版 License 支持 2.29.1 及以上，2.38.3 满足版本要求。控制台登记值
  是不含协议、端口、路径或通配符的 Web 域名；本地 IP 是否可登记由控制台决定，代码和文档不再作肯定假设。
- 补齐 Web 播放器 License 配置链路：API 以成对环境变量校验 `domain + key`，临时播放会话返回严格 DTO，
  播放器初始化显式传入 `license`。缺配置时服务端在签发 PlayAuth 前返回明确错误，避免 4036 后继续触发
  无意义的 seek 超时。账号专属值不进入前端源码。
- 真实 License 首次重启暴露开发启动契约缺陷：README 要求创建根目录 `.env`，但 `dev:api` 与
  `dev:analysis-worker` 原先都未读取它，新进程会静默退回“VOD 未启用”。两个脚本现统一使用 Node.js 22
  内建 `--env-file-if-exists=.env`，不增加依赖；生产 `start:*` 仍只接受部署环境显式注入。
- 收紧播放准备错误边界：服务端播放会话错误继续向用户展示明确部署原因，播放器 SDK/CDN 加载异常统一为
  固定中文文案；SDK 与播放会话仍并行加载，并在同时失败时优先展示可操作的服务端业务错误。
- 增加官方 SDK 在生产 NodeNext/ESM 下可构造的回归测试，避免测试 fake gateway 掩盖 CJS/ESM 默认导入错误。

### 审查与验证

- `test:media-playback` 17/17，通过 License 透传、缺失拒绝、SDK 错误收敛及既有 seek/play/pause/刷新回归。
- `serverConfig` 与 VOD gateway 专项 14/14，通过成对配置、域名规范化、错误域名拒绝和生产 SDK 构造。
- `test:media-analysis` 17/17、完整 `test:api` 163/163、`test:deployment` 13/13 和生产 `build` 均通过；
  构建只保留既有 Vite 主 chunk 超过 500 kB 提醒。首次完整构建发现平台播放来源测试夹具仍使用旧 DTO，
  补齐 Web License 后重跑通过，`git diff --check` 通过。
- 当前浏览器播放错误不是 PlayAuth 过期、视频转码中或 CDN URL 鉴权：服务端每次实时签发 PlayAuth，媒资
  为 Normal，播放器控制台给出的确定原因是缺少 Web License。补齐控制台授权后，播放会话由 503 恢复为
  200，DTO 同时携带实时 PlayAuth 与 Web License，用户已在 `http://localhost:5173/` 人工确认《寻梦》样例
  VOD 正常播放；编辑器继续显示约 1494.4 秒时长和既有波形、频谱分析资产。
- 真实配置重启时确认 `dev:api` 与 `dev:analysis-worker` 原脚本不读取仓库根 `.env`。现改为 Node.js 22 内建
  `--env-file-if-exists=.env`，并增加部署脚本回归；不新增 dotenv 依赖。仅确认敏感变量存在与格式，不在
  命令输出、开发日志或提交中记录真实值。
- 阶段收尾重新执行播放器 17/17、媒体分析 17/17、完整 API 163/163、部署脚本 7/7、服务配置/首管理员
  13/13、生产构建与 `git diff --check`，全部通过；构建只保留既有主 chunk 超过 500 kB 提醒。敏感值反查
  Git 跟踪文件为零匹配，根 `.env` 权限为 `600` 且继续被忽略。
- R3h goal 完成审计按四个阶段逐项反查独立提交、实现入口、专项测试、浏览器记录和文档。审计发现 roadmap
  “当前缺口”仍保留 R3h4 前的两条旧描述：把后端任务称为占位模型，并称平台媒体仍在浏览器完整下载分析；
  已改为当前真实的独立媒体分析 worker、按窗派生资产和仅限本地媒体的有界浏览器回退，避免 R6 重复造队列。
  完成审计另补跑资源选择分页 6/6、平台草稿/媒体绑定 33/33 和备份/派生对象一致性 28/28，全部通过。

### 待推进

- 在实际生产域名重新登记并验收 Web License，长时间运行覆盖 PlayAuth 到期前单飞刷新，同时复验暂停、
  精确 seek、P 临时循环、持久循环、倍率和独立窗口；本地“正常播放”人工 smoke 不替代生产域名验收。
- 临时长期 AccessKey 在验收结束后必须由账号所有者立即禁用/删除，并改用 RAM 角色、实例角色或其他
  短时凭据方案。

## 2026-08-06：标注确认四栏布局与独立窗口

### 已完成

- 新增 `EditorSidebarLayout`，把右侧工作区明确拆为句级字幕、当前句逐字拆分、标注确认和属性 Inspector
  四个同级叶面板。三层可调整布局分别使用版本化存储键，避免旧三栏比例污染；标注确认隐藏或弹出时
  不保留空白区域，属性 Inspector 自动接管剩余高度。
- 标注确认标题、记录数、折叠按钮、面板背景和滚动方式统一到既有句级字幕/逐字拆分样式。删除旧的
  特殊盾牌标题、内部展开状态、`max-height: 48%` 和 Inspector 内嵌高度耦合，不再维护两套折叠语义。
- “视图”菜单新增清晰的“右侧标注确认”和“在独立窗口显示”入口。面板状态统一为
  `docked | hidden | detached`：隐藏只影响右栏，弹出时主窗口不重复渲染，收回或关闭窗口后恢复右栏。
- 独立窗口继续复用已有 `FloatingPanelWindow`，与停靠面板共享同一确认数据和命令；撤销确认使用的
  Radix Portal 显式落到独立窗口文档，避免遮罩和对话框出现在主窗口。

### 审查与验证

- `npx tsc -p tsconfig.app.json --noEmit --incremental false`、`test:annotation-confirmation-view` 5/5、完整
  `npm run build` 和 `git diff --check` 通过；构建仅保留既有 Vite 主 chunk 超过 500 kB 提醒。
- 在 `http://localhost:5173/` 打开《寻梦》平台示例完成真实浏览器验收。四个叶面板实测高度依次为
  150/137/129/144px，边界互不覆盖；标注确认可折叠、隐藏、弹出和收回，隐藏时 DOM 中不再存在确认区，
  属性 Inspector 正确扩展。视图菜单状态与实际位置一致，浏览器控制台未出现本轮新增错误。

### 待推进

- 本轮不改变确认记录 API、审核权限、时间轴确认范围或 `ProjectData`。生产桌面浏览器仍应在后续发布
  smoke 中复验原生 popup 的跨屏位置、关闭收回和独立窗口内撤销确认对话框；应用内浏览器宿主不提供
  独立顶层窗口列表，不能替代真实桌面窗口管理验收。

## 2026-08-06：clean error 协作追赶自愈

### 已完成

- 对真实双账号失败现场核对数据库、operation 和 audit：标注文件服务端已从 v59 连续提交到 v61，sequence
  65/66 均为 `ta` 接受并提交的逐字边界命令；`admin` 页面仍停在 v59，实时连接保持在线但显示“同步失败”。
  因此本次不是权限拒绝、数据库丢写或 WebSocket 断线，而是客户端没有消费已提交 revision。
- 定位第一层状态机死锁：catch-up 过去只接受 `saved`，任何 `error` 都永久暂停；远端编辑门禁却也只保护
  `saved`，导致 clean error 客户端既不能追赶，又可继续从旧快照开始编辑。现抽取统一资格规则，允许完全
  clean 的 saved/error 会话追赶；有 dirty、pending、拖拽、行内编辑、整合草稿、保存或媒体改绑时仍拒绝覆盖。
- 定位现场热更新后仍未追赶的第二层时序：保存锁只用 ref 表示，`finally` 清锁不会触发 React 重渲染，最后
  一次失败渲染会永久保留“save in flight”资格。现保留 ref 防止同步重入，并增加 state 驱动门禁重算；保存
  结束必然触发一次新渲染。clean error 的远端替换会清除错误并恢复 `saved`，dirty error 继续保留浏览器草稿。
- 顶部“同步失败”增加具体 `errorMessage` 悬浮提示，后续现场可区分原子确认、草稿持久化、租约和网络错误，
  不再只留下一个无法诊断的总括文案。

### 审查与验证

- `test:platform-operation-catch-up` 20/20，覆盖 clean error 追赶资格、dirty error 拒绝替换和 revision gap 编辑门禁。
- `test:platform-atomic-submit` 26/26、`test:platform-auto-save-runtime` 9/9 与 TypeScript 检查通过；完整生产构建在
  本条记录后继续执行。Chrome 扩展在读取热更新后的旧 admin 页面时中断连接，因此自动化浏览器未伪报成功；
  该页面仍需人工确认从 v59 收敛到当前服务端 revision。

### 待推进

- 用 admin/teacher 两个真实会话再次交错编辑同一块，确认成功提交、409 协调、clean error 自愈和下一次本地
  编辑均能连续工作；若再次进入 error，优先读取顶部状态的悬浮详情并保留对应 operation/revision 时间点。

## 2026-08-06：客户端同步失败持久诊断

### 已完成

- 核对最近一次 admin 单账号案例：v69 的 5 条 timing 命令已完整提交并写入保存审计；随后出现的
  `local_chain_mismatch` 发生在下一次保存的本地 planner 阶段，尚未向 API 创建 operation，不属于协作冲突。
- 新增 `annotation_client_sync_failure` 审计动作、严格上报 DTO、文件 read 权限复核和两秒服务端限频。日志记录
  客户端/文档/服务器 revision、失败与命令创建时间、dirty/online/save-in-flight、pending 命令身份、目标和
  有界 command envelope；正文和 before/after 可用于本阶段调试，凭据、鉴权值和 URL 在两端强制脱敏。
- pending chain 审计在 `local_chain_mismatch` 时补充不一致的 ProjectData 顶层字段，并进一步记录最多 64 条
  JSON Pointer 叶子差异及其 saved/命令重放后/current 三态值；下一次失败可直接定位具体逐字、句、块或轨道
  配置的漏命令入口。诊断上报短暂失败会使用冻结报告重试两次，不改变真实同步状态。
- 调试期明确保留标注正文、命令 before/after 和有界完整 command envelope；UUID、operation ID 和实体 ID 不再被
  泛化的“长字符串”规则误脱敏。Authorization、Bearer、AccessKey、PlayAuth、token、Secret 和 URL 仍禁止落盘。
- 应用迁移 `20260806010000_annotation_client_sync_failure_audit`，API 已重新启动于 4317。

### 验证

- Web 与 API TypeScript 检查通过；planner 与诊断专项测试 7/7 通过。按用户要求未重复执行完整生产构建。

### 待推进

- 当前错误页面的旧 pending chain 形成于修复前，不会被热更新悄悄改写；先保留 IndexedDB 草稿，按显式恢复/
  比较流程处理，再用新会话复验相同操作。本轮已按审计详情修复具体漏命令入口，没有把
  `local_chain_mismatch` 降级为整份快照覆盖。

## 2026-08-06：父块级联工尺符号的原子命令修复

### 已完成

- 查询首条 `annotation_client_sync_failure` 真实审计：admin 在文件 v69 基线上有 6 条本地 timing operation，
  mismatch 精确落在 `gongcheAnnotations[0].symbols[0..1].startTime/endTime`。saved 与 replayed 相同、current
  已按父逐字边界缩放，证明问题发生在请求发出前，不是权限、网络、WebSocket 或服务器提交失败。
- 根因是父块同步会按比例更新 Gongche block 及全部 symbols，但旧 `getGongcheTimingTargetsForParents()` 只收集
  外层 block。现用 `getGongcheTransactionTargetsForParents()` 统一收集 block timing 与前后都存在的 symbol
  state 目标；创建/删除 symbol 仍由 lifecycle 负责，职责没有混入时间更新。
- 单字拖动、整句拖动、自定义父块拖动和跨轨多选移动四条入口改为
  `annotation.transaction.apply`，把文字/句/工尺块 timing 与工尺 symbol state 原子提交。直接工尺编辑原有
  transaction、板眼 timing 的确定性 `manualOffset/confidence` 重建及删除引用修复保持不变。
- timing API 拆为叶级 `buildProjectTimelineTimingEnvelope()` 与独立安全
  `buildProjectTimelineTimingCommand()`：前者仅供高层 transaction 组合，后者必须把命令应用到 base 后证明
  完整 ProjectData 等于 next。由此任何新的派生字段漏声明都会立即返回 null，不再产生僵尸 pending command。
- 收尾删除 Web 兼容层未使用的过渡类型导出，取消领域内部返回类型的意外公共导出，并把多选路径中字符轨/
  自定义轨两段重复 Map 合并收为一次目标组遍历；旧 Gongche timing helper 已零引用、零残留。叶级 envelope
  builder 补充中文边界注释，明确禁止 UI 绕过完整 ProjectData 重放证明。

### 审查与验证

- 新增与现场同构的双 symbol 父块缩放回归，验证 transaction 子命令顺序为 timing -> state，正向重放逐字段
  等于 next，inverse 完整恢复 base；新增独立 timing builder 拒绝遗漏 symbol state 的回归。
- timing、transaction、atomic planner、HTTP catch-up 与 409 conflict rebase 组合专项 45/45 通过；Web/API
  TypeScript 检查和 `git diff --check` 通过。完整 `npm run build` 通过 Prisma generation、shared、
  document-model、Web 与 API，仅保留既有 Vite 主 chunk 超过 500 kB 提醒。扫描其余派生写入后，板眼、引用
  修复、生命周期和内容命令均已有完整重建门禁，未发现第二处同类漏命令。

### 待推进

- 当前修复前页面仍持有旧的不完整 6-operation 链，不能在原地伪造新 envelope。通过草稿恢复/比较保存必要
  修改后，新开编辑会话依次人工复验单字边界、整句、自定义父块及多选移动，并确认服务器 revision 正常递增、
  另一账号可追赶且不再生成新的 `annotation_client_sync_failure`。

## 2026-08-06：拖拽预览与自动保存相邻帧竞态修复

### 已完成

- 核对最新真实失败审计 `6f2c74d4-ad70-4aa2-a202-65ed008cfea4`：admin 在文件 v70 上拖动逐字公共边界时，
  saved 与 pending 命令重放结果均为 `65.39458414874343`，但 transient current 已预览到 `65.48`。失败发生于
  `01:37:49.812Z`，对应 pointer-up operation 创建于约 72ms 后，证明自动保存 timer 抢在领域命令生成前冻结
  了预览项目；这不是 Gongche 修复回归、协作 409、权限拒绝或服务器丢写。
- `a7cb459a-b81c-4242-bdf2-01089a92d6c1` 是同一 error 状态在后续本地 revision 变化后重复上报的诊断，不是
  第二次保存尝试。诊断去重现按文件、失败类别和原因稳定识别一个 error 状态；真正重新保存会先进入 saving，
  清除旧签名后仍可记录新的独立失败。
- 自动保存与 IndexedDB 恢复草稿现同时在 transient 拖拽期间暂停，避免未形成可重放历史的视觉预览进入任一
  持久化通道。服务器保存入口另以 `transientProjectRef.current` 做同步硬门禁，覆盖 React 尚未重渲染、旧 timer
  与 pointer-up 落在相邻帧的窗口；松手完成单次 commit 后，普通自动保存按既有 dirty/pending 规则恢复。
- 没有放宽 pending chain 完整性证明，也没有回退到整份快照覆盖。修复前已经进入 error 的旧页面仍按草稿恢复/
  比较边界处理；热更新不会伪造缺失 operation。

### 审查与验证

- 前端 TypeScript 检查通过；自动保存 policy/runtime、平台草稿与同步失败诊断专项 30/30 通过。
- Web/API TypeScript 检查、完整生产构建与 `git diff --check` 均通过；构建只保留项目既有的 Vite 主 chunk
  超过 500 kB 提醒。

### 待推进

- 刷新或重新打开文件取得 clean 会话，再复验短拖、长拖和触摸板松手；每次 pointer-up 应先形成 operation，
  随后服务器 revision 递增，且不再出现新的 `local_chain_mismatch`。若仍失败，以新的独立审计 ID 和时间线继续
  诊断，不能把修复前重复上报记录误认为新回归。

## 2026-08-06：结构租约申请与普通自动保存竞态修复

### 已完成

- 核对修复后新审计 `acbfe726-8416-47b0-b829-689325957a06`：失败类别已不再是
  `local_chain_mismatch`。服务端 v79 与 operation sequence 123 均已成功提交；本地后续 4 条命令包含两个
  自定义块创建、类型内容修改和一条轨道结构事务，但失败批次未创建任何 operation。
- 审计时序显示结构租约于 `01:50:04.870Z` 在 v79 创建，随后于 `01:50:04.985Z` 被客户端释放，失败报告于
  `01:50:05.052Z` 写入。结合 3 秒自动保存窗口可确定：普通 pending 批次在租约 acquire 尚未完成时已冻结为
  无 token 请求，服务端随后看见活动租约并正确 fail closed；这不是命令重放不完整、协作覆盖或数据库丢写。
- 保存与租约结构写入现使用双向内存屏障。结构写入先同步占用 exclusive 门禁，再等待可能已在途的保存完成，
  之后按最新项目/revision 申请租约；保存入口发现 acquire/commit 中的结构写入时返回 busy，由自动保存按既有
  idle 规则重排。保存已经先开始时，结构写入保留用户动作并等待，不以“请重试”丢弃操作。
- 同步失败 DTO 新增有界脱敏 `errorMessage`；服务端兼容修复前旧页面缺少该字段的报告。原子提交错误在顶部提示
  和审计中保留稳定错误码，`annotation_mutation_lease_*` 统一归入 `mutation_lease`，后续无需依赖开发者控制台
  才能区分 required、expired、invalid、purpose mismatch。
- 复核“本轮没有错误日志”的现场后确认并非漏上报：审计 `b7086678-bb2a-46ab-8ac8-79b84120d29c` 于
  `01:55:37.967Z` 记录了 `mutation_lease`、local revision 46 和 5 条 pending。它对应 `01:50:08.717Z`
  创建、续期至五分钟绝对上限后失效的结构租约；旧诊断合同只保存 category/reason，没有 `errorMessage`，因此
  审计看起来像“没有原因”。API 重启后新报告会同时保存真实有界消息和稳定错误码。

### 审查与验证

- mutation lease、自动保存 policy/runtime、原子提交 runtime/coordinator 与同步诊断专项 30/30 通过。
- shared 构建、Web/API TypeScript 检查、完整生产构建和 `git diff --check` 通过；构建只保留项目既有的 Vite
  主 chunk 超过 500 kB 提醒。
- API 已用新诊断合同重新启动于 `127.0.0.1:4317`；health 返回 ready，数据库与对象存储均为 ok。

### 待推进

- 当前页面保留了失败前的 4 条 pending 命令和修复后再次取得的旧租约。刷新/重开按浏览器草稿恢复后，复验
  “连续创建块并新建类型”以及恰好跨过 3 秒自动保存窗口的结构操作；成功时应整批提交到 v80 或更高 revision，
  且后续审计若失败必须包含具体 `errorMessage` 与稳定错误码。

## 2026-08-06：无分叉轨道启用分叉的 JSON 等价修复

### 已完成

- 现场服务器文件已正常同步至 v82、operation sequence 134。“肢体动作轨”包含一个动作块且尚无 branching；
  用户四次启用分叉都取得并立即释放 `track_structure` 租约，未创建 operation，证明租约协调正常，失败稳定发生
  在客户端结构 builder 的完整重放证明。
- 直接使用数据库 JSON 可成功构建命令，而浏览器归一化项目会稳定失败。最小复现确认旧归一化器为无归属块创建
  `branchScope/branchGroupId/branchParentBlockId: undefined` 自有键；结构快照按 JSON 语义恢复为缺失键。两者持久化
  内容完全相同，但旧深比较把键集合差异判为合同外变化并错误返回 null。
- `areProjectValuesEqual()` 现只在普通对象上忽略值为 `undefined` 的键，保持 `null`、数组长度/位置和具体值严格；
  这与 ProjectData 的 JSON 持久化边界一致，不会掩盖真实领域变化。自定义块归一化器也改为无值时直接省略三个
  可选分叉字段，新打开会话不再制造这种伪差异，当前旧会话则由共享等价规则立即兼容。

### 审查与验证

- 新增“无分叉轨道带 undefined 兼容键仍可启用分叉”回归，以及对象 undefined/缺失等价、null 与数组继续严格
  的边界测试。结构命令、结构事务、atomic planner 和 HTTP catch-up 组合 36/36 通过。
- Web TypeScript 检查、完整生产构建与 `git diff --check` 通过；构建只保留项目既有的 Vite 主 chunk 超过
  500 kB 提醒。

### 待推进

- 前端重启后在 v82 clean 会话再次为“肢体动作轨”启用分叉并新建一条分支；应形成一条结构 operation、保存至
  v83 或更高版本，并在重新打开文件后保留 branching。随后复验已有分叉轨的新增递归子分支与块归属修改。

## 2026-08-06：编辑器返回文件所在目录

### 已完成

- 修复平台编辑器返回资源管理器时总是回到“所有项目”根视图的问题。根因是当前目录仅由
  `ResourceExplorer` 的组件内状态持有，进入编辑器卸载组件后目录信息随之丢失。
- `PlatformWorkspace` 现只在标注文件真正进入编辑器时记录其权威父目录；返回后新挂载的资源管理器以该目录
  初始化。由“最近打开”、搜索、比较导航或普通目录打开文件时，都会返回文件实际所在目录。
- 该位置仅是当前平台会话的导航状态，不进入 ProjectData、草稿、编辑历史或服务端存储；退出账号时会清空，
  避免下一账号继承无权访问的目录。

### 待推进

- 浏览器已实测从“示例项目：昆曲《寻梦》”普通目录打开标注文件并返回，正确落到原项目目录，面包屑和
  同目录资源均正常加载。后续可继续抽查“最近打开”和比较结果入口；二者共用同一权威文件打开路径。

## 2026-08-06：当前单服务器部署交接复核

### 当前可部署状态

- 本轮审查开始时 `main` 工作区干净，HEAD 与 GitHub `origin/main` 均为
  `72d455be9b8976e14b6e7c2b90600691648c7d11`。接手 Agent 可以从 GitHub 获取代码，但应 checkout 经过
  审查的 commit/tag、构建不可变 release 并切换 `/opt/xiqu/current`，不能在运行目录直接 `git pull`。
- 当前定位仍是 R5“受控单服务器部署候选”：适合研究团队和课堂内测，不等同于 R7 公网生产认证。唯一
  详细操作手册是 `docs/server-deployment.md`；`deploy/single-server/` 只保存环境、systemd 和 Nginx 模板，
  不另维护第二套容易漂移的命令说明。
- 本轮重新执行 `npm run test:deployment`，部署参数、只读 smoke、环境/Nginx 上传上限、生产运维 CLI 边界、
  首管理员 CLI 和生产 fail-closed 配置共 21/21 通过；`npm run build` 完成 Prisma Client、shared、
  document-model、Web 与
  API 生产构建。对本机同源入口执行 `deploy:check`，Web 首页、API liveness 和 readiness 均返回 HTTP 200。
  仅保留既有 Vite 主 chunk 超过 500 kB 提醒。

### GitHub、数据与秘密边界

- GitHub 只同步源码、Prisma migration、部署模板和文档；它不会同步 `.env`、PostgreSQL 账号/权限/资源树/
  标注 payload、`data/` 或对象存储中的上传媒体、恢复快照及波形/频谱/F0 瓦片。全新部署应运行 migration
  并通过一次性 CLI 创建正式 `super_admin`；继承本机现有平台数据则必须迁移 PostgreSQL 与对象存储的一致
  备份，不能只复制仓库或只恢复其中一侧。
- 生产环境文件按手册设置为 `root:xiqu`、`chmod 640`，使 systemd 的 `xiqu` 服务账号可读且其他账号不可读；
  本轮同步修正环境模板中误写的 `chmod 600` 注释。数据库、对象目录、备份、TLS 和环境文件必须位于 release
  目录之外。
- VOD 生产部署必须使用目标正式域名对应的 Web License，并通过实例角色、工作负载身份或受保护环境注入
  最小权限阿里云身份。任何曾出现在对话、终端输出或其他非秘密渠道的长期 AccessKey 均视为已暴露，正式
  部署前必须删除或轮换；真实密钥、License key、playauth 和临时媒体 URL 不得写入 Git 或开发日志。

### 目标服务器仍需完成

- 按 `docs/server-deployment.md` 在目标 Linux 主机安装 Node.js 22、PostgreSQL 16、Nginx、Git 和 FFmpeg，
  创建服务账号与持久目录，选择并验收本地或 S3-compatible 对象存储，执行 `prisma migrate deploy` 和首位
  管理员 bootstrap，安装 API/analysis-worker systemd 单元，并配置同源 Nginx、WebSocket、TLS 与防火墙。
- 在正式域名运行 `npm run deploy:check` 后，仍须人工闭环登录、上传/Range、打开/保存、双账号 ACL 与实时
  协作、VOD 播放、纯音频后台分析、强制上传音频覆盖、审计、metrics、回收站和恢复。
- 公网发布前还需在目标环境完成 TLS 自动续期及失败告警、真实 S3/MinIO IAM、外部监控接收、自动备份调度/
  加密、隔离恢复演练、容量与弱网压测、安全审计和工尺谱字体授权；仓库测试不能替代这些生产证据。

### 已确认的数据部署决策与后续迁移

- 用户明确确认本次服务器部署不得同步本机实验/debug 数据。目标服务器必须使用空 PostgreSQL 数据库与空对象
  存储，运行 migration 后创建全新的正式 `super_admin`；本机 `.env`、开发 seed、数据库、`data/`、媒体及
  分析资产均不得复制到生产。该门禁已同步到 `AGENTS.md` 与唯一部署手册。
- 后续正式服务器之间迁移可以复用现有维护窗口一致备份：备份同时覆盖 PostgreSQL、上传对象、恢复快照和
  波形/频谱/F0 资产，并提供 manifest、SHA-256、离线校验、空目标恢复和恢复后数据库/对象摘要核对。目标应先
  恢复到候选数据库和候选对象目录，验收后再切换配置/DNS并显式解除维护，不能原地覆盖运行中的生产数据。
- 现有能力足以支持本地对象存储服务器之间的受控迁移，但生产接管仍需人工运维确认；跨新 S3 bucket 的直接
  restore/cutover 尚未自动化。正式恢复/切换 CLI 已作为未来开发写入 roadmap，要求空目标门禁、manifest
  校验、失败补偿和原子发布；roadmap 不记录本次空库部署实例，避免把部署决策与长期能力规划混为一谈。

## 2026-08-06：升级维护体验与滚动发布远期规划

### 现状审查

- 当前 `PlatformRuntimeState` 已持久保存二值维护状态和原因；管理员诊断页可切换维护，PostgreSQL 独占
  advisory lock 会等待已获许可的 HTTP 写请求响应完成，再令后续 mutation 返回稳定 503。GET/HEAD 与协作
  读会话仍可用，CLI 可在浏览器 session 失效时解除维护。
- 现有能力还不是用户可感知的安全发布流程：状态读取仅限管理员，登录 POST 在维护中被拦截，普通登录页、
  资源管理器和编辑器没有全局公告；开启维护会立即阻止尚未发送的本地修改，自动保存只把 503 当作通用重试，
  无法区分“服务器已保存”和“仅有 IndexedDB 草稿”。因此不能只增加一条 warning 就宣称编辑已安全收口。
- 发现独立 media-analysis worker 直接写 PostgreSQL 与对象存储，当前不经过 HTTP maintenance gate，也未读取
  drain 状态。其 SIGTERM 已能清理半成品并重新排队，但在接入统一协议前，一致备份、migration 和 release
  切换必须先停止 worker。该临时运维门禁已同步到 AGENTS 与唯一部署手册。

### 规划结论

- 该能力已明确归入 R7 远期 backlog，不是当前 R6a 或下一轮立即开发任务，因此不改写当前
  `CLAUDE_WORK.md`。现阶段只采用部署手册中的人工通知、确认已同步、停止 worker、维护门禁和恢复验收流程。
- 面向用户统一称为“升级维护”而非“开发模式”，避免暗示生产开启 debug 能力。R7a 先实现
  `normal/announced/draining/active` 两阶段公告与安全收口，只允许 `super_admin` 操作；所有页面读取脱敏
  状态，编辑器在 draining 阻止新动作、完成当前命令、依次 flush 服务器和浏览器草稿，并对已同步与仅本机
  保存作严格区分。active 复用现有强门禁，恢复后先 catch-up 再放开编辑。
- R7a 同时要求 worker 停止 claim、当前任务完成或安全回队列，并覆盖多账号、断网、冲突、旧客户端、API/
  worker 重启和维护恢复测试。第一版可用倒计时和本地状态提示；连接级 drain ack 作为后续增强，强制维护
  必须显示未响应/未同步风险。
- R7b 再建设不可变 CI artifact、双 API 实例 readiness 摘流、WebSocket 排空、前端版本检测、兼容 migration
  和自动回滚。破坏性 migration 与对象迁移仍使用显式维护窗口，不追求不可信的绝对零停机。本轮只更新规划
  与当前运维说明，没有修改 schema、API 或前端状态。

### 部署命令阻断修复

- 自审 release 清单时发现生产只复制 `package.json/package-lock.json/prisma/dist/node_modules`，但全部
  maintenance/backup npm scripts 仍调用 `tsx apps/api/src/backup/cli.ts`；真实服务器没有 `apps/` 源码时，文档
  中的维护、备份和恢复命令都会立即失败。现统一改为 `node dist/api/backup/cli.js`，复用 `build:api` 已生成且
  随 release 发布的 CLI，不通过复制源码或在生产即时编译规避问题。
- 部署专项测试新增运维 scripts 边界，逐项禁止 `tsx` 和 `apps/api/src`，防止未来再次产生只在开发工作树可用
  的伪部署命令。
- 完整构建后以本机 `admin` 操作者真实运行编译产物 `npm run maintenance:status -- --operator admin`，命令成功
  读取维护状态且未依赖 `apps/` 源码；本次只读验证没有切换维护状态。

## 2026-08-06：维护期间的文件会话级本地草稿提醒

### 已完成

- 在不提前实现 R7a 公共维护公告和 drain 协议的前提下，为当前平台编辑器补充一个最小安全提示。原子命令与
  兼容快照保存现在都会严格识别服务端 `maintenance_mode`；该错误属于确定性写门禁，不再按普通 503 进行网络
  退避重试，也不再发送必然被维护门禁拒绝的“客户端同步失败”诊断。
- 文件首次遭到维护拒绝时，编辑器立即通过既有串行 IndexedDB 队列写入最新恢复草稿，并显示 Radix
  AlertDialog。文案明确区分“服务器未自动保存”和“本机浏览器草稿已保存”；草稿失败时要求用户不要关闭或
  刷新页面，不能把失败状态伪报为已经保留。
- 一旦当前文件会话确认处于维护阻断，后续拖拽、文字、结构、撤销/重做等只要形成新的本地 revision，就共用
  同一入口再次刷新草稿并提示。同一次 revision 会去重，避免 revision effect 与稍后的保存拒绝弹出两次。
- 用户可选择“关闭”或“本文件本次不再提醒”。前者只关闭本次弹窗，下一次编辑仍提示；后者只写入当前编辑器
  组件内存，返回资源管理器、关闭文件或重新打开文件后恢复提醒。无论是否抑制提示，后续本地草稿仍继续写入。
- 维护解除后，只有服务器真实确认原子命令或兼容快照保存成功，当前会话才清除维护阻断；本地草稿写入成功
  不会被误当作服务器恢复。这样下一次正常编辑不会继续显示过期维护提示。
- 新弹窗替代维护场景下的原生 `window.alert`，但其他同步错误仍保持原有提示和诊断行为。该功能不改变数据库、
  ProjectData、服务器 revision、协作命令或维护角色权限，也不代表 R7a 已经完成。

### 验证

- `npm run test:platform-drafts`：33/33 通过，覆盖草稿身份隔离、串行写入、失败恢复和文档 pending operation。
- 原子提交 runtime/coordinator、错误分类和旧保存边界专项测试：15/15 通过；新增断言确认
  `maintenance_mode` 为不可自动重试错误，普通瞬时 503 仍可重试。
- `npm run build` 与 `git diff --check` 通过；Web 构建只保留既有主 chunk 超过 500 kB 提醒。
- 按用户要求未操作浏览器和未实际切换本机维护状态。人工验收应依次验证：开启维护后完成一次拖拽并等待
  自动保存、确认弹窗显示本地草稿结果、关闭后再次编辑会重现、选择“不再提醒”后当前文件不再弹出、重新打开
  同一文件后恢复提醒，最后解除维护并手动保存或重新打开文件完成恢复同步。

### 待推进

- R7a 仍按远期 roadmap 实现公开维护状态、登录页/资源管理器公告、客户端 draining、worker 排空确认和维护
  恢复后的权威 revision catch-up；本轮文件会话提示不能替代这些平台级能力。

## 2026-08-06：空白标注工程入口与历史回收站清理约束

### 已完成

- 新增独立的 `createEmptyProjectData()` 工厂。空白工程不再借用包含演示视频和标注内容的 `mockProject`，只初始化
  一个内建逐字文字轨以及互相隔离的空数组；句级 SRT 建项也复用该工厂，避免默认轨道构造逻辑分叉。
- 资源管理器在项目或文件夹内增加“新建空白标注工程”入口。用户命名后直接调用既有标注文件 API，保存无媒体
  的权威 `ProjectData`，刷新并选中新文件，再通过 `PlatformWorkspace` 唯一打开路径读取最新 revision、权限和
  草稿后进入编辑器。创建期间有单次请求门禁，打开取消或失败不会删除已经创建的文件。
- 空白文件不强制弹出媒体选择器；进入编辑器后仍可按现有流程关联本机媒体、服务器媒体或阿里云 VOD。
- roadmap 与 `AGENTS.md` 补充未来永久删除约束：功能上线前已经进入回收站的资源同样可清理，但必须从带
  `trashedAt` 的逻辑根递归处理整棵子树，以根时间计算保留期，并在数据库提交后按共享 `FileObject` 引用及
  媒体分析资产引用执行可补偿的对象清理；禁止按非空 `trashedAt` 平铺删除。

### 验证

- `src/utils/project.test.ts` 覆盖空白内容、唯一内建轨道、规范化无漂移，以及多次创建之间没有共享可变引用。
- `node --import tsx --test src/utils/project.test.ts`：2/2 通过。
- `npm run build` 与 `git diff --check` 通过；Web 构建只保留既有主 chunk 超过 500 kB 提醒。
- 按用户要求本轮未操作浏览器。人工验收顺序：进入任一有新建权限的项目或文件夹，点击工具栏“新建空白
  标注工程”，输入名称并确认，验证立即进入编辑器；确认时间轴只有空的逐字文字轨、媒体未绑定，然后返回
  原目录确认文件存在，并分别尝试后续关联本机媒体、服务器媒体或 VOD。

### 待推进

- 回收站永久删除、保留期限、对象生命周期补偿和审计保留仍属于后续 R1 工作；本轮只固化兼容旧回收站内容的
  正确设计边界，没有增加任何不可逆删除 API 或界面按钮。

## 2026-08-06：登录页移除开发账号默认填充

- 登录页不再把 `admin` 和开发密码写入账号、密码输入框，也不再在页面底部直接展示开发凭据。浏览器标准
  `autocomplete` 行为继续保留，用户仍可使用自己的密码管理器。
- 本轮没有删除仅供本地开发数据库使用的 seed 账号，也没有修改 API 测试夹具或生产首管理员 bootstrap。

## 2026-08-06：阿里云 ECS 首次空生产实例部署

### 已完成

- 按单服务器手册在阿里云 ECS 华北 2（北京）部署经过审查的 `main` commit
  `9c3887cdcd6f0696921dc8ef0141534b7a307c2d`。生产 release 为
  `/opt/xiqu/releases/20260806T064255Z-9c3887c`，`/opt/xiqu/current` 指向该不可变目录；没有在运行目录
  直接 `git pull`，也没有复制开发机的 `.env`、PostgreSQL、`data/`、媒体或分析资产。
- 主机基线为 Ubuntu 24.04、Node.js 22.23.2、PostgreSQL 16、Nginx 1.24 和 FFmpeg 6.1。40 GiB 系统盘承载
  系统和 release；独立 100 GiB ext4 数据盘按 UUID 挂载到 `/var/lib/xiqu-platform`，承载 `storage` 与
  `backups`。数据盘已取消随实例释放，`mount -a` 验证通过。
- 创建无登录 `xiqu` 服务账号及固定目录权限；生产环境文件为 `root:xiqu`、`0640`，数据库密码与 metrics
  token 均在服务器内随机生成且未回显。对象存储当前使用空的本地数据盘目录，开发 seed 明确关闭。
- 新建空的 `xiqu_platform` 业务库和 `xiqu_restore_drill` 隔离恢复演练库，预置 `pg_trgm`，成功应用 20 个
  已提交 migration。数据库和对象目录均未导入本机实验数据。
- 安装并启用 `xiqu-api` 与 `xiqu-analysis-worker` systemd 服务；两者均为 active。PostgreSQL 只监听
  `127.0.0.1:5432`，Fastify 只监听 `127.0.0.1:4317`，Nginx 通过 80 端口同源提供静态 Web、`/api` 与
  WebSocket upgrade。公网 IP 阶段的 `deploy:check` 已确认首页、liveness、readiness 均为 HTTP 200，
  readiness 中数据库与本地对象存储均为 ok。
- 通过一次性 stdin bootstrap 创建 `platform.admin` 首位 `super_admin`，并以真实登录 API 验证账号角色和
  access token 签发成功，未输出 token。临时凭据只用于首次登录，必须立即通过自助改密替换。
- 停止 analysis worker 后创建首次一致基线备份
  `xiqu-backup-2026-08-06T06-57-24-266Z-6399bebf`；manifest 校验通过，对象数 0、warning 0。随后恢复到
  独立 `xiqu_restore_drill` 数据库和 `restore-drill/storage`，migration history、维护状态、数据库摘要和
  对象存储四项检查全部通过，报告保存在数据盘受控目录；生产 worker 已恢复 active。

### 真实部署发现与修复

- 首次 migration 发现 release 复制清单漏掉 `prisma.config.ts`，Prisma 7 因缺少 datasource 配置拒绝
  `migrate deploy`；此时尚未创建业务表。补入配置后 20 个 migration 全部成功。
- 首次 systemd 启动发现 npm workspace 的 `node_modules/@xiqu/shared` 与 `@xiqu/document-model` 是指向
  `packages/*` 的符号链接，而旧清单没有发布 `packages/`，导致 API/worker 明确以
  `ERR_MODULE_NOT_FOUND` 退出。停止重启循环并补入已构建 workspace 产物后，两项服务与健康检查恢复正常。
- 部署手册现把 `prisma.config.ts`、`packages/` 纳入 release，并增加启动前文件门禁；部署专项测试固定该清单，
  `AGENTS.md` 同步记录这一生产不变量。不能通过在生产即时编译源码或改成非 workspace 安装来掩盖缺项。
- 首次恢复演练按旧手册把目标直接放在 root-owned 持久目录下；数据库已恢复后，对象原子发布需要创建同级
  staging，因父目录不可写而以 EACCES 停止。该失败只涉及隔离目标，生产备份保持有效。重建空演练库并把
  storage 放入 `xiqu` 所有的专用父目录后恢复通过；手册、专项测试和 `AGENTS.md` 已固定该权限边界。

### 待完成

- 首位管理员已创建并通过登录验证；仍需立即在平台内把临时密码改为唯一强密码，并确认改密会撤销旧 session。
- 当前仅为公网 IP 的 HTTP smoke。域名确定后需配置 DNS、可信 TLS 与自动续期，再把 Nginx 从临时 HTTP 配置
  切换到正式同源 HTTPS；安全组仍需最终确认 22 仅允许运维公网 IP、80/443 对外、3389/4317/5432 禁止公网。
- 阿里云 VOD 已在公网 IP smoke 阶段启用：region 固定为媒资实际所在的 `cn-shanghai`，Web License domain
  使用当前公网 IP，License Key 只保存在 `root:xiqu`、`0640` 的生产环境文件。ECS 实例角色通过默认凭据链
  实际完成样例媒资的 `GetVideoInfo`、`GetVideoPlayAuth` 与 `GetPlayInfo`；返回状态 Normal、时长 1494.413 秒，
  短时 PlayAuth 和 HTTPS mp3 纯音频地址均有效，验证过程未输出凭据或临时 URL。最终域名确定后仍须在阿里云
  重新授权该 hostname，并同步替换生产 Web License domain/key；localhost 或公网 IP License 不能冒充正式域名
  授权，长期 AccessKey 不进入服务器环境或仓库。
- 首管理员创建后仍需完成人工闭环：改掉临时密码、创建资源、上传与 Range、打开/保存、第二账号 ACL 与实时
  协作、回收站/恢复、审计、metrics，以及 uploaded 媒体分析。VOD 服务端三项真实 API 已通过，但仍需在编辑器
  中创建/关联样例 VOD，人工验证 Aliplayer 播放、纯音频分析、强制上传音频覆盖和恢复自动来源；切换最终域名
  和 HTTPS 后还要重新执行同一浏览器闭环。
- 首次一致备份及隔离恢复演练已经通过。后续每次重要升级仍须创建新的匹配备份并按运维策略定期演练；依赖
  安装报告的安全告警应在仓库分支中审查并通过锁文件、测试和构建处理，不能在生产服务器直接运行
  `npm audit fix --force`。

## 2026-08-06：恢复大型本机媒体的浏览器分析

### 已完成

- 定位到 R3h 媒体分析迁移时新增的 256 MiB 浏览器保护被无差别用于所有本地媒体，导致“不登录，进入本地
  标注工具”后，用户主动选择的较大视频在解码前被提前拒绝。迁移前的本地实现没有这一固定门槛。
- `localMediaAnalysis` 现明确区分来源：当前本地导入入口生成的 `blob:` URL 恢复原有完整浏览器解码能力；
  非 Blob URL 仍在响应头和 Blob 落地后执行 256 MiB 保护，避免本地项目误下载远程长媒体。
- 下载前后限制复用同一个纯策略函数，不再保留两份容易漂移的条件判断；错误文案也明确指向“远程媒体”，
  不再把用户主动选择的本机文件误报为必须改走平台后台。
- 平台 uploaded/VOD 的分析分流未修改：平台会话仍只使用 `usePlatformMediaAnalysis`、独立 worker、FFmpeg
  流式输入和对象存储瓦片，VOD 临时纯音频 URL 仍不得进入浏览器完整下载/解码路径。

### 验证

- 新增 `test:local-media-analysis`：2/2 通过，覆盖超过原门槛的 `blob:` URL 放行，以及非 Blob URL 的上限和
  边界值保护。
- `npm run build:web`、`npm run build` 与 `git diff --check` 通过；Web 构建只保留既有主 chunk 超过
  500 kB 提醒。
- AbortSignal、浏览器解码错误传播和 AudioContext 关闭逻辑没有改动。仍需人工在本地入口重新选择原问题视频，
  确认不再显示 256 MiB 提前拒绝，并等待波形/频谱完成；最终能否解码仍取决于当前浏览器对媒体编码和可用内存
  的实际支持。

### 待推进

- 本轮不把本地长媒体迁移到平台 worker，也不修改生产 VOD、上传媒体或分析瓦片配置。若后续需要让超长本机
  文件在低内存设备上稳定分析，应另行设计流式本地解码或显式上传任务，不能重新把平台受保护 URL 送入浏览器
  全量解码。

## 2026-08-06：R3h5 平台分析瓦片冷加载加速

### 问题定位

- 用户在 localhost 浏览已完成的《寻梦》VOD 波形/频谱时加载很快，但通过生产服务器首次滚动到未访问区域会
  等待，返回已缓存区域则立即显示。链路审查确认 VOD 和 FFmpeg 没有重新运行：时间轴读取的是对象存储中已生成
  的 30 秒分析瓦片。
- 旧 `usePlatformMediaAnalysis` 在 Timeline 每个 animation frame 的可见范围变化后，重发波形、频谱、F0
  三个 descriptor 列表，再为每个瓦片单独发送 HTTP。常见窗口产生 9-15 个请求，每个二进制请求重复认证、
  ACL、Prisma 和对象读取；视口变化还会 abort 已开始但对相邻窗口仍有价值的下载。
- 数据库已有 `(runId, kind, preset, level, startTime)` 索引，问题不需要新 migration。现有 5 分钟 private
  浏览器缓存解释了“回看很快”，但不能解决新区域冷加载和取消浪费。

### 已完成

- 新增共享严格 batch codec：8 字节 magic、版本化小型 JSON manifest 和连续原始瓦片段。服务端可只编码 header
  后流式透传对象；浏览器严格拒绝空/重复/超量 ID、坏长度、截断、尾随数据和未知版本。传输固定为最多 48 项、
  32 MiB，不使用 Base64 JSON，也不引入 ZIP/TAR 依赖。
- `MediaAnalysisJobService` 增加一次 ACL 后的批量归属校验：全部 ID 必须属于当前标注文件的同一个 succeeded
  run；缺失、跨 run、跨文件统一失败，不泄露外部资产。新 batch route 使用 Node `Readable` 异步生成器先发
  manifest，再逐项读取 `ObjectStorage`，API 不拼接整批 Buffer；旧单瓦片 GET 继续作为兼容/诊断接口。
- 前端把滚动范围量化到服务端真实 30 秒边界，并在 120 ms 连续滚动期间防抖 descriptor 请求。同一 file/run
  session 使用 asset-id in-flight Promise 池：视口变化只取消列表请求，已开始批量下载继续完成并供新窗口复用；
  文件、run、分析来源切换才整体 Abort，旧 session 不能复活。
- 缺失瓦片按共享数量/字节预算切批，批量响应拆回现有组装函数。加载下一窗口时保留上一窗口的定时数据，
  Timeline 继续通过时间交集决定是否绘制，不再主动闪空。缓存从“48 个、按首次插入淘汰”升级为真实 LRU，
  同时限制 96 项和 64 MiB，cache hit 会刷新热度，超大单项不会挤掉整个窗口。
- 删除已经没有调用方的逐瓦片 `PlatformClient` 包装，避免前端重新分叉；服务端兼容 route 和测试仍保留。
- 单服务器 Nginx 模板为 waveform/spectrogram/pitch/batch 四种 MIME 启用 level 4 流式 gzip，并由部署测试固定。
  API private 缓存没有改成 public/immutable；升级已有服务器必须合并真实站点配置并 `nginx -t` 后 reload。

### 依赖评估

- 本轮没有新增 npm 依赖。共享仓库已有二进制 codec 模式，浏览器已有 Fetch/AbortController，Node 已有
  Readable，生产已有 Nginx；引入归档库会增加压缩/解包和服务端缓冲语义，通用请求库也不能替代 file/run
  generation 与 in-flight 去重状态机，因此不会减少代码或提高稳定性。HTTP 压缩由 Nginx 成熟实现承担。

### 验证

- `npm run test:media-analysis`：21/21 通过，覆盖 batch codec、真实 30 秒瓦片、FFmpeg、worker、窗口量化、
  批次预算、LRU、source offset、连续性和并发窗口只发一次 batch。
- `npm run test:api`：163/163 通过。Fastify/Prisma/本地对象存储集成覆盖批量顺序、原始字节、缺失项、重复项、
  无权限拒绝和既有单瓦片读取；只出现项目既有的 pg client query 弃用提示。
- `npm run test:deployment`：24/24 通过，新增断言确认四种分析 MIME 均进入 Nginx gzip_types。
- `npm run build:web`、完整 `npm run build` 与最终 `git diff --check` 均通过；Web 只保留既有主 chunk 超过
  500 kB 提醒。

### 部署状态

- 2026-08-06 已部署到生产服务器 `101.201.76.10`，release 为
  `/opt/xiqu/releases/20260806T090600Z-0696319`，对应提交 `0696319`。
- 部署前停止 `xiqu-analysis-worker`，由旧 release 创建并校验一致备份
  `xiqu-backup-2026-08-06T09-03-37-703Z-c6319dfd`；备份包含 350 个对象，warning 为 0，manifest 校验通过。
- 备份校验后进入维护模式，完成 release 上传、完整产物门禁、`prisma migrate deploy`、API 原子切换和
  Nginx 配置 reload。真实站点新增独立配置片段
  `/etc/nginx/conf.d/xiqu-platform-analysis-gzip.conf`，保留原有域名、代理与安全规则。
- 新 release 的 API、首页、liveness、readiness 均通过公网 HTTP smoke；分析 worker 重新启动并 active；
  最终维护状态为关闭，API 与 worker 的发布后日志未发现 error/fatal/uncaught/crash。
- 本次 `db:deploy` 的第一次服务用户执行因 Prisma 7 尝试写 root-owned release 内的 engines 缓存而失败，
  数据库未被修改；随后改由 root 仅执行迁移工具成功确认“20 migrations found / No pending migrations”。
  systemd 服务仍继续以 `xiqu` 运行，未放宽 release 目录权限。

待人工验收：使用真实《寻梦》VOD 在 Network 面板比较新区域首次加载的 batch 数量、`Content-Encoding`、
transferred size、首次绘制时间，以及切换文件/run/来源后旧瓦片是否复活。该项不能用健康检查代替。
- 本轮没有增加 public CDN、S3 预签名直读、无限缓存或全片预下载。若生产验收后对象存储 TTFB 仍占主要部分，
  下一步应先增加低基数 Server-Timing/指标区分 ACL、Prisma 与 storage，再决定是否设计短时、权限绑定的对象
  直读；不能仅凭 localhost 对比绕开服务端 ACL。

## 2026-08-06：R3h6 渐进加载、快速跳转与分析缓存

### 问题判断

- R3h5 的批量接口已经消除了逐瓦片 HTTP/ACL 扇出，但快速横向划过较长区域时，旧视口的 batch 仍可能继续占用
  带宽；原实现还要等波形、频谱和 F0 的所有瓦片都完成后才统一组装，因此用户感知到的首个可用时间偏长。
- 仅增加全量预下载不能解决首屏等待，反而会在长视频、低速网络和移动设备上提前消耗大量流量。全量分析预加载必须
  是用户主动触发的后台任务，且不能下载视频或临时 VOD 音频 URL。

### 已完成

- 视口加载防抖从 120ms 调整为 180ms，并把批次拆成波形、频谱、F0 三个分析序列。前台使用 8 MiB 偏小批次、最多
  两个 batch worker；每个批次完成后立即回调，波形或频谱只从窗口起点开始组装连续前缀，缺块时不压缩后段时间。
- 新增批次 registry 和独立 AbortController。新窗口到达后，只取消与当前窗口及主动预加载集合完全无交集的旧批次；
  仍包含所需资产的共享 batch 保持复用。文件、账号、分析 run 或来源切换仍会整体取消并清空运行时状态。
- 后续自我审查发现：如果等待新窗口 descriptor 返回才取消旧批次，快速拖过长距离时旧下载仍可能在列表请求期间占用
  带宽。现已在新视口进入 180ms 防抖时立即取消所有不属于主动预加载集合的旧可视/相邻批次，descriptor 返回后再做
  精确的资产交集保留；因此最终停留窗口仍可重新使用内存、IndexedDB 或共享在途请求，不会被 stale response 覆盖。
- 预加载现在绑定当前波形层级、频谱预设、可见性和 F0 开关；这些设置改变会中止旧配置任务，已写入的二级缓存仍按
  分析 run 和资产身份隔离，可由新配置按需复用。
- IndexedDB 缓存接口改为闭包实现，不依赖调用时的 `this`；缓存失效仍只降级为网络读取，不影响当前分析显示。
- 当前窗口完全可用后，按相邻窗口串行启动 16 MiB 低优先级预取；预取不改变当前显示、不占用 `assetsLoading` 完成状态，
  快速跳转时会通过同一 registry 被回收。
- 新增 `src/platform/platformMediaAnalysisCache.ts`，复用仓库已有 `idb` 依赖建立分析资产二级缓存。内存 LRU 仍是
  第一层，IndexedDB 以账号/文件/run/asset/size 作为 key，二进制和触达元数据分开保存，单次 `getMany/putMany`
  对应一批资产，避免逐瓦片产生大量 IndexedDB 事务。默认上限为 256 MiB、2000 项，超限按最旧触达时间清理。
- 音频轨道设置新增“预加载分析数据”。它只读取当前成功 run 的当前波形层级、当前频谱预设和当前 F0 开关，显示完成数，
  使用后台单并发和持久缓存；长视频目录按最多 180 个 30 秒瓦片分段，避免后端单次 200 条列表限制。任务可停止，文件、
  run、来源切换时自动终止。
- 补充中文功能注释，删除原来“所有序列一次性并发加载、旧批次永不取消”的过时逻辑；没有新增 npm 依赖。

### 验证

- `npm run test:media-analysis`：28 项通过，覆盖 IndexedDB 隔离/LRU、序列拆分、相邻窗口、连续前缀、旧批次取消、
  有界并发、批量回调以及原有 VOD/FFmpeg/worker/codec。
- `npm run test:api`：163 项通过；`npm run test:deployment`：24 项通过；完整 `npm run build` 和
  `git diff --check` 通过。构建仍只有既有 Vite 主 chunk 超过 500 kB 提醒，以及既有 `pg` 弃用提示。

### 待推进与人工验收

- 当前没有改服务端对象布局；批量接口仍逐个读取对象。若生产浏览器指标显示 TTFB/对象读取仍占主要时间，R3h7
  再设计同一 run/kind/level 的不可变 analysis bundle + Range/offset 读取，先加 Server-Timing 区分 ACL、Prisma、
  storage，再决定是否实施，不能未经测量迁移线上对象。
- 生产浏览器需使用真实《寻梦》VOD 快速拖动很长距离后停下，观察最终窗口是否只保留必要 batch、旧无关请求是否取消、
  波形是否先于频谱出现、刷新后 IndexedDB 是否命中、预加载是否不影响编辑和播放。健康检查不能替代这项体验验收。

### R3h6 生产发布

- 2026-08-06 已将 R3h6 注释审查后的提交 `5a4db87` 部署到生产服务器 `101.201.76.10`，release 为
  `/opt/xiqu/releases/20260806T101921Z-5a4db87`；本机 `.env`、`data/`、数据库和对象存储均未上传。
- 发布前停止 `xiqu-analysis-worker`，从旧 release 创建一致备份
  `xiqu-backup-2026-08-06T10-21-50-657Z-d732be55`；备份包含 350 个对象、0 个 warning，随后使用旧 release
  的 `backup:verify` 校验通过。数据盘和现有生产对象未被清理或迁移。
- 备份校验后由 `platform.admin` 开启维护模式；新 release 通过 `prisma.config.ts`、20 条 migration、
  `packages/shared/dist`、`packages/document-model/dist`、API/worker/Web 产物门禁。`prisma migrate deploy` 返回
  `20 migrations found / No pending migrations to apply`，没有 schema 变更。
- `/opt/xiqu/current` 原子切换到新 release 后重启 API。第一次立即 curl 早于 Node 完成监听而失败，随后重试成功；
  这是探测时序问题，不是服务启动错误。新 API liveness/readiness 均通过，readiness 中 database/storage 为 ok。
- 新 release 在维护状态下通过公网只读 `npm run deploy:check -- --base-url=http://101.201.76.10`；之后关闭维护模式并
  启动 analysis worker，最终 API/worker 均为 `active`，维护状态为 `enabled=false`。发布后 API/worker journald 未发现
  error、fatal、uncaught 或 crash；Nginx 配置和 VOD 环境本轮没有修改。

### 发布后待人工验收

- 仍需在浏览器用真实《寻梦》VOD 检查波形首帧、快速横向拖动时旧 batch 取消、相邻预取、IndexedDB 命中和主动预加载；
  本次健康检查不能替代这些前端体验测试。
- 若 Network 指标确认对象存储 TTFB 仍是主要瓶颈，下一阶段再按 R3h7 设计 `Server-Timing` 和 immutable analysis
  bundle/Range 读取；不能绕过 ACL 直接开放对象或下载完整视频/临时音频。

## 2026-08-06：R3h7 客户端调度与 10 秒分析瓦片（已部署，待生产浏览器验收）

本轮根据 `CLAUDE_WORK.md` 对当前线上滚动体验进行代码审查，并结合实际调用链重新评估了“把分析瓦片从 30 秒
缩短为 5/10 秒”的建议。结论是 10 秒适合当前格式，5 秒暂不采用：现有波形层级 `64/256/1000/4000`
在 10 秒、16 kHz 下都能整除，而 256 samples/bucket 在 5 秒下不能整除；强行使用 5 秒会引入新的桶宽
或时间边界误差。

已完成：

- 将新媒体分析 run 的服务端瓦片默认粒度改为 10 秒；frequency-detail 频谱的 `hopLength` 从 480 调为 400，
  使 10 秒瓦片严格产生整数帧。分析配置 hash 随配置变化，旧 30 秒 run 不会被错误复用。
- 在 `MediaAnalysisRun` DTO 中返回 `tileDurationSeconds`。服务端读取时按 `manifest -> config -> 当前默认值`
  回退，旧 run 仍按自己的 30 秒粒度被前端量化和拼接；不需要数据库 schema 迁移。
- 将客户端请求窗 padding 改为每侧可视区 25%、单侧最多 90 秒；相邻预取改为沿最近移动方向读取一个可视区，
  并在可视区稳定 800ms 后才启动。前台批次从 8 MiB 降为 2 MiB。
- 渐进绘制新增可视区优先的连续资产段选择；批次 registry 记录源时间范围，快速跳转时只取消整体远离当前视口、
  且不含主动预加载保护资产的批次。旧的仅按资产集合取消 helper 已清理，避免两套取消规则竞争。
- 未修改 `ProjectData`、ACL、数据库表结构、对象存储接口、VOD/服务器媒体/本机媒体来源；未采用不安全的
  `immutable` 分析缓存头，也未重复已有 Nginx gzip 配置；没有新增 npm 依赖。

验证：

- `npm run test:media-analysis`：31 项通过，包含共享 batch codec、VOD 网关、FFmpeg、worker、对象补偿、IndexedDB
  缓存、10 秒计算边界、30/10 秒请求窗、渐进可视段和远距离批次取消。
- `npm run build:web`、`npm run build:api`、`git diff --check` 通过；Vite 仍只有既有主 chunk 超过 500 kB 的提示。

待推进：

- 本轮 release 已部署，但尚未使用真实《寻梦》VOD 重算 10 秒 run。生产验收需要观察下载量、波形/频谱首帧、快速
  拖动时的取消、停止滚动 800ms 后的预取、旧 30 秒 run 兼容和 IndexedDB 命中。
- 服务端仍按单瓦片对象读取；只有在真实 Network 指标确认 TTFB/对象读取占主要耗时后，才进入 R3h8 的
  `Server-Timing`、manifest、bundle/Range 设计。不得未经测量迁移线上对象或绕过 ACL。

### R3h7 生产发布与待验收项

- 2026-08-06 将提交 `22f3bc1` 部署到服务器 `101.201.76.10`，新 release 为
  `/opt/xiqu/releases/20260806T153313Z-22f3bc1`。发布包只包含当前构建产物、Prisma、workspace 包、部署脚本和
  与锁文件一致的运行依赖；没有上传本机 `.env`、`data/`、数据库、本机媒体或 VOD 凭据。
- 发布前重新执行 `npm run test:media-analysis`，31 项全部通过；`npm run build` 完整通过，只有既有 Vite 主
  chunk 超过 500 kB 的非阻断提示。新旧提交之间没有 `package-lock.json`、Prisma migration 或部署脚本变化，
  因此候选 release 使用服务器上同一锁文件对应的已验收 `node_modules` 独立副本，并覆盖本次重新构建的 Web/API、
  shared/document-model 与运行元数据。
- 发布前停止 `xiqu-analysis-worker`。旧 API 存在 6 个已空闲约 5 小时但仍持有维护共享 advisory permit 的连接，
  本轮 `backup:create` 因此长期等待独占锁；确认阻塞关系后停止旧 API，释放遗留连接，让同一个备份进程继续完成，
  未并行创建第二份备份。该现象表明 R3d2a 请求终止路径仍有锁释放缺口，已加入 roadmap；后续需用回归测试定位，
  不能把停止 API 当作正常维护流程或静默忽略。
- 本次一致备份为 `xiqu-backup-2026-08-06T15-29-01-114Z-f7258614`，`backup:verify` 返回 `valid=true`、0 项
  error。随后由 `platform.admin` 开启维护模式；新 release 的 Prisma 检查找到 20 条 migration 且无待执行项。
- 原子切换 `/opt/xiqu/current` 后启动新 API；公网 `deploy:check` 在维护状态下确认 Web 首页、liveness、readiness
  均为 HTTP 200。之后解除维护并启动新 worker，最终 API/worker 均为 `active`、维护状态为 `enabled=false`，
  database/storage readiness 均为 ok，发布后 journald 未出现 error、fatal、uncaught、crash 或 failed。
- 待用户在真实《寻梦》VOD 上人工验收：新建分析应生成 10 秒瓦片；波形应优先首帧；频谱按当前可视区渐进显示；
  快速跳转应取消远端批次；停止约 800ms 后才启动方向预取；旧 30 秒 run 和刷新后的 IndexedDB 命中仍应正常。
  本轮健康检查不替代这些浏览器体验与 Network 指标验收。

## 2026-08-09：新建块同步失败的运行时恢复补强（已部署，待生产人工复测）

### 排查结论与修复

- 用户再次反馈 localhost 新建块时显示“结构编辑锁 · 同步失败”，生产端也没有出现新的创建请求。
  复核生产 journald 后确认，失败发生在客户端原子提交前的本地命令链审计/状态门禁阶段，并非数据库事务或服务端
  `annotation.track.structure.transaction.apply` 解析失败；此前生产已经有多次该命令批次返回 HTTP 200 的记录。
- 发现本机 `dev:api` 进程早于本轮 shared/document-model 构建启动，可能继续加载旧的 `dist` 命令 parser。已重新执行
  `npm run build:shared && npm run build:document-model`，重启本机 API，并确认
  `http://127.0.0.1:4317/api/health/live` 返回 `status=ok`。后续修改 shared/document-model 后必须重启
  `dev:api`，Vite 热更新不能替代 API 进程重载。
- App 的结构事务入口新增不含凭据、媒体 URL、完整项目和租约 token 的中文诊断日志，记录 purpose、服务器 revision、
  是否已有租约、命令类型和本地 pending 数量，以便明确区分“未调用 API”“租约失败”和“批次提交失败”。
- 对历史浏览器草稿造成的 `local_chain_mismatch` 增加一次受约束的完整快照恢复：仍需当前账号写权限、当前服务器
  revision 和结构编辑租约，服务器 revision 已变化时仍按原有 409 冲突流程处理，不绕过并发保护。恢复成功后会一次性
  确认当前完整项目与 pending operation，避免坏链永久阻塞后续新建块。
- 原子命令按上限切成多批时，前一批可能已经成功推进服务器和本地 saved baseline，后一批才遇到旧坏链或迁移边界。
  快照恢复现只携带尚未确认的 operation 后缀，并以已确认前缀推进后的项目、本地 revision 和轨道吸附状态为基线；
  不再重复提交已经确认的 operation，也不会因旧 committed revision 让恢复路径自身再次失败。

### 自动验证

- `npm run test:platform-atomic-submit`：26 项通过。
- `npm run test:platform-operation-catch-up`：20 项通过。
- `npm run test:custom-track-structure-command`：19 项通过。
- `npm run test:annotation-transaction-command`：8 项通过。
- `npm run test:platform-drafts`：33 项通过。
- `npm run test:api`：163 项通过。
- `npm run build:web`、`npm run build:api` 与 `git diff --check` 通过；Vite 仅保留既有主 chunk 体积提示。
- 已重新构建 shared/document-model 并重启本机 API，`http://127.0.0.1:4317/api/health/ready` 返回
  `service=xiqu-platform-api, status=ready`。

### 生产发布

- 修复提交 `371c782` 已推送到远端 `main`，并发布为不可变 release
  `/opt/xiqu/releases/20260809T041816Z-371c782`；服务器没有同步本机 `.env`、数据库、`data/` 或对象存储内容。
- 发布前停止 analysis worker，由旧 release 创建一致备份
  `xiqu-backup-2026-08-09T04-19-07-404Z-a7866abe`。备份包含 3871 个对象、0 个 warning，随后执行
  `backup:verify` 返回 `valid=true`、0 个 error。
- 备份验证后开启维护模式，新 release 的 shared/document-model/API/Web 产物门禁和 SHA-256 上传校验通过；
  `prisma migrate deploy` 找到 20 条 migration 且无待执行项。原子切换后，公网 Web、API liveness 与 readiness
  均返回 HTTP 200。
- 只读 smoke 通过后解除维护并启动 analysis worker。最终 API 与 worker 均为 `active`，维护状态为关闭；发布
  时间窗内 journald 未发现 `error`、`fatal`、`uncaught` 或 `crash`。该只读验收不冒充真实新建块操作验收。

### 生产端到端诊断测试

- 为避免污染研究内容，在生产文件 `260716_寻梦_合并版_v7base+工尺+腔格.json`
  （resource id `0bd8a58a-742a-4ae1-9f09-830d259d4704`）上使用临时管理员 session 走真实 HTTP 路由，
  没有使用用户密码，也没有直接写 SQL。测试覆盖 `mutation-lease`、`command-batches`、认证、ACL、Prisma
  事务、ProjectData parser 和操作记录。
- 按编辑器在 4--8 秒无句级行时的真实逻辑，先创建句级行和逐字块，再用反向结构事务删除。租约获取、创建批次、
  删除批次全部 HTTP 200；文件 revision 从 12 临时推进到 13、14，逐字/句级对象均正确创建并删除，最终 payload
  内容恢复原值。此前另做的普通逐字生命周期 HTTP 测试同样为 200。
- 测试后数据库内容没有留下诊断块；revision 当前为 14、操作序号为 20，新增的测试操作保留为 accepted 审计事实，
  这是为了保留诊断证据，不代表研究标注内容发生变化。
- 由此排除生产数据库事务、命令 parser、ACL、租约和 `/command-batches` 路由本身拒绝创建的问题。生产日志中此前
  用户页面主要反复请求 revision 8 的 committed-feed，没有对应的 `mutation-lease` 或 `command-batches` 请求，
  更符合浏览器会话在本地追赶/编辑门禁阶段未进入提交路径，或页面仍停留在旧文件 revision 的现象。

### 下一步人工定位

- 用户重新打开目标文件并确认顶部显示最新服务器 revision 后，再在 4--8 秒执行一次新建逐字块；不要在旧页面
  中继续点击测试。浏览器控制台应先出现“开始结构编辑事务”和“结构编辑事务已写入本地命令队列”，Network 随后
  应出现 `POST /mutation-lease` 和 `POST /command-batches`。
- 如果只有前一条日志而没有 POST，问题仍在浏览器保存调度；如果有租约但没有 command batch，检查租约回包和
  `formatMutationLeaseError`；如果两条 POST 都出现，再按 response status 和 `annotation_client_sync_failure`
  诊断记录检查服务端拒绝。不要再次直接修改生产 payload。

### 本轮待验证

- 重新打开同一标注文件后新建逐字块、内建动作块和自定义文字/动作块，确认结构事务日志出现、随后原子批次或受约束
  快照保存成功，顶部回到“已同步”。
- 生产端清理旧浏览器页面后重新加载当前 release，再验证新建块；若仍无 `mutation-lease`/`command-batches` 请求，
  优先查看浏览器控制台中的结构事务日志和 `annotation_client_sync_failure` 审计事实，不要先修改数据库。

## 2026-08-09：生产浏览器新建块前端诊断链（待复现定位）

### 背景与边界

- 用户在部署 `371c782` 后确认生产浏览器仍无法创建新块。上一轮已经通过生产真实 HTTP 业务链完成并反向删除
  逐字块，证明 ACL、结构租约、命令解析、Prisma 事务和 `command-batches` 路由可接受同类请求；本轮不再重复
  修改生产标注 payload，也不通过放宽远端追赶门禁或绕过结构租约来猜测修复。
- 现有日志只从 `runExclusiveProjectMutation()` 开始。Timeline 手势未形成创建状态、分叉显示轨未解析、拖动未过
  激活阈值、App 找不到目标轨道、另一结构事务正在等待等路径会静默返回，无法用服务端日志区分。

### 已完成

- Timeline 增加一条有界的 `[标注创建诊断]` 链，覆盖 Command/Ctrl 拖拽开始、无效可视轨/分叉解析、短拖拽
  拒绝、滚动容器缺失、最终时间范围分发，以及双击创建分发。记录真实父轨 ID、可视轨 ID、轨道类型、时间范围
  和分叉 lane ID，不记录标注文字、媒体地址、鉴权信息或项目 payload。
- App 的逐字块、内建动作块和自定义块入口记录请求是否到达、实体/轨道身份与范围；缺少目标轨道不再静默。
  通用结构事务入口同时记录 preview 无变化、独占事务忙、租约就绪、拿锁后无变化、本地 commit 成功/跳过和异常阶段。
  原有命令入队与保存错误日志继续作为后半段证据，因此一次复现可区分：
  `Timeline 手势 -> App 创建入口 -> lease -> 本地 command queue -> autosave/API`。
- 诊断只增加可观察性，不改变块创建算法、拖动阈值、吸附、分叉归属、远端 revision 门禁、租约或自动保存行为。

### 自动验证

- `npm run test:custom-track-structure-command`：19 项通过。
- `npm run test:platform-atomic-submit`：26 项通过。
- `npm run build:web` 与 `git diff --check` 通过；仅保留既有 Vite 主 chunk 体积提示。

### 待推进

- 以不可变 release 部署诊断版本后，在生产页面强制刷新并重新打开目标标注文件，分别执行一次 Command/Ctrl
  拖拽创建和双击创建。按最后一条 `[标注创建诊断]` 的 `stage` 精确定位，不在没有证据时修改业务规则。
- 同时对照 Nginx/API 日志中的 `POST /mutation-lease`、`POST /command-batches` 及响应码。若诊断到达
  `*-local-commit-complete` 但仍无 POST，转查 autosave 调度；若只到 `timeline-*`，转查 App 回调/门禁；若两条
  POST 均存在，则按稳定 API 错误码和同步失败审计修复确定的服务端/确认问题。

### 诊断版本部署记录

- 诊断提交 `3594074` 已推送 `origin/main`，生产 release 为
  `/opt/xiqu/releases/20260809T053000Z-3594074`。本次仍未上传本机 `.env`、数据库、`data/`、本机媒体或
  VOD 凭据；生产数据库和对象存储没有被本机内容覆盖。
- 部署前尝试创建一致备份时，首次未指定持久输出目录，旧 release 因只读 release 目录返回 `EACCES`；随后按部署
  手册改用 `/var/lib/xiqu-platform/backups`，但生产持续追赶请求使维护排空边界等待。该次由本 agent 启动的备份进程
  已停止，没有生成半份备份，也没有改变数据库或对象内容。本次前端-only 诊断使用上一轮已验证备份作为回滚保障，
  后续需要单独修复/演练生产备份排空等待和备份输出门禁，不能把这次跳过新备份当作常规发布规则。
- 首次切换候选 release 后，API 因 workspace 的 `packages/shared/package.json` 与
  `packages/document-model/package.json` 未随 dist 复制而短暂启动失败；没有修改数据。已从上一 release 补齐两个
  workspace manifest，API 随后 readiness 恢复，旧 release 未被覆盖。
- 切换后的只读检查：公网首页返回 `index-CJneMR4c.js`，`/api/health/ready` 返回 `status=ready`，API 与
  analysis worker 均为 `active`，维护状态为 `enabled=false`。这一轮尚未宣称新建块已修复，必须等待浏览器产生
  诊断阶段证据后再做业务修改。

## 2026-08-09：HTTP 生产环境创建实体 UUID 兼容修复（待生产人工复测）

### 明确根因

- 生产浏览器复现日志依次到达 `timeline-create-drag-start` 和 `timeline-create-dispatch`，但没有进入 App 的
  `custom-block-request-received`；随后控制台给出确定异常：`Uncaught TypeError: crypto.randomUUID is not a function`。
- 当前生产入口是 `http://101.201.76.10`。Chrome 只把 HTTPS 和 localhost 视为安全上下文；因此 localhost
  可直接调用 `crypto.randomUUID()`，HTTP IP 页面不可用。旧块编辑不创建新实体 ID，所以不受影响；新建块、轨道、
  分叉、工尺、板眼、导入重编号和部分草稿路径都可能在调用点同步抛错，API 自然收不到租约或命令批次请求。

### 修复

- 新增 `src/utils/runtimeUuid.ts` 作为唯一前端运行时 UUID 边界：安全上下文优先使用原生 `randomUUID()`；HTTP
  非安全上下文使用可用的 `crypto.getRandomValues()` 生成符合 RFC 4122 version 4/variant 的 UUID；只有极旧环境
  连 Web Crypto 都没有时才使用时间、页面内序号和随机量的实体身份兜底，该结果不得用于凭据或鉴权。
- 清理所有前端生产代码中的直接 `crypto.randomUUID()`：覆盖 App 创建/导入辅助逻辑、递归分叉、板眼、工尺、
  文档 operation id、选择性整合草稿和冲突草稿。服务端继续使用 Node `node:crypto.randomUUID`，不受浏览器安全
  上下文影响，也没有被改成弱兜底。
- `AGENTS.md` 已加入这一跨模块约束，后续新增浏览器实体必须复用 helper，不能重新散落时间戳或直接原生调用。

### 自动验证与待验收

- 新增 runtime UUID 3 项测试：原生路径、只有 `getRandomValues` 的 HTTP 非安全上下文路径、无 Web Crypto 的格式与
  连续唯一性，全部通过。
- `npm run test:custom-track-structure-command` 19/19、`npm run test:platform-atomic-submit` 26/26；`npm run build`
  完整通过，Web 新产物为 `index-D2uHIcGr.js`，仅保留既有主 chunk 体积提示。
- 待部署后在生产 HTTP IP 强制刷新，创建自定义文字块、逐字块和动作块各一次；确认控制台不再出现
  `crypto.randomUUID` 异常，诊断链到达 `*-local-commit-complete`，Network 出现租约与命令批次，顶部最终回到已同步。

### 生产发布

- 修复提交 `2a82b5c` 已推送 `origin/main`，不可变 release 为
  `/opt/xiqu/releases/20260809T055947Z-2a82b5c`。候选包本轮包含完整 `packages/` 及两个 workspace manifest，
  并在切换前实际导入 shared 构建产物，避免诊断版本发布时遗漏 package manifest 的问题重现。
- 停止 API/analysis worker 后由 `platform.admin` 开启维护，原子切换 release；本轮没有 Prisma migration，未同步
  本机数据库、对象、`.env`、`data/` 或 VOD 凭据。新 API readiness 通过后解除维护并恢复 worker。
- 公网首页确认加载 `index-D2uHIcGr.js`，API 与 analysis worker 均为 `active`，维护状态为 `enabled=false`，
  database/storage readiness 均为 ok；新进程启动后未发现 error/fatal/uncaught/failed 日志。
- 仍待用户在已经打开开发者工具的生产浏览器中强制刷新并完成三类创建验收；只读 health check 不能替代真实手势、
  UUID 生成、结构租约和原子保存闭环。

## 2026-08-09：HTTP UUID 修复收尾与浏览器安全上下文审查

### 本轮处理

- 用户已在生产 HTTP IP 页面人工确认新建标注块可以正常完成；因此上一轮为定位“手势未到达 App / App 未提交 / API
  拒绝”而加入的 `[标注创建诊断]` 临时 console 链已经完成使命，本轮从 `src/App.tsx` 和
  `src/components/Timeline.tsx` 全部删除。历史诊断记录保留在本文件中，作为故障证据，不再让正常用户操作持续产生
  高噪声控制台输出。
- 清理了诊断函数及其调用点，包括短拖拽、滚动容器缺失、不可创建轨道、分叉解析失败、双击分发、App 请求到达、
  租约就绪、命令入队和本地提交完成等临时 stage。没有删除仍用于真实问题处理的“开始结构编辑事务”“结构编辑事务已写入
  本地命令队列”“结构编辑事务未能生成完整命令”“结构编辑事务失败”等稳定日志；这些日志分别对应租约屏障、命令边界
  和用户可见失败，仍可用于后续同步故障诊断。
- 恢复 Timeline 创建提交的简洁条件分支：只有创建拖拽且滚动容器存在时进入计算与回调，避免清理后留下空分支；没有
  改动拖拽激活阈值、最终 pointerup 坐标、吸附锁、最小块宽度、父轨/分叉轨解析或任何创建回调。
- `src/utils/runtimeUuid.ts` 的中文注释补充了长期部署语义：正式 HTTPS 或 localhost 会自动使用原生
  `crypto.randomUUID()`，当前无域名 HTTP IP 阶段使用 `getRandomValues()` UUID v4 兼容路径；该 helper 保留为唯一
  前端实体 ID 边界，不是对 HTTPS、登录凭证或传输加密的替代品。

### HTTP/HTTPS 安全上下文专项审查

- 已搜索前端和平台代码中的 `crypto`、`randomUUID`、`getRandomValues`、剪贴板 API、File System Access API、
  摄像头/麦克风、通知、Service Worker、Credential、PaymentRequest 和 SharedArrayBuffer 调用。除统一 UUID helper
  外，没有发现当前生产前端直接依赖安全上下文才能工作的同类 API；测试文件中的 `crypto.randomUUID()` 只用于 Node
  测试数据库名，不进入浏览器产物。
- 协作 WebSocket URL 已在 `src/api/platformClient.ts` 依据页面/API origin 自动把 `https:` 转为 `wss:`，把 `http:`
  转为 `ws:`。同源 Nginx 的 WebSocket upgrade 配置仍是 HTTPS 上线的必要条件，不能把 HTTP 兼容路径当作正式安全方案。
- 平台上传媒体、服务器媒体和 VOD 播放/分析使用普通 HTTP(S) 请求、受保护媒体路由或短时 VOD 会话，不调用额外的
  安全上下文专属浏览器 API。未来若加入文件系统原生选择器、离线 Service Worker 或摄像头/麦克风，必须单独增加
  HTTPS 门禁和降级提示，不能直接照搬当前 UUID 兜底。

### 验证与状态

- 已完成：删除临时诊断代码；保留长期结构/同步错误日志；保留 HTTP IP 和未来 HTTPS 域名的 UUID 双路径；完成
  当前前端安全上下文 API 审查；未新增依赖、数据库迁移、媒体格式或 API 合同。
- 已完成：本轮清理后的 UUID、结构事务、原子提交回归测试和完整 `npm run build`；构建仍只有既有 Web 主 chunk
  超过 500 kB 的非阻断提醒。待推进：生产页面强制刷新后分别验证逐字文字块、内建动作块、自定义文字/动作块，
  以及失败时原有同步状态和错误日志是否正常。HTTP 兼容只解决已确认的 UUID 异常，不替代未来域名 HTTPS、TLS
  证书和安全 Cookie 的正式部署工作。
