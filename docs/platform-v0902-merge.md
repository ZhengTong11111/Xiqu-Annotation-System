# 平台 v0902 三方合并执行手册

`platform-merge:v0902` 用于把平台活动区中已经修改的 v0901 标注文件就地升级为 v0902。它不会删除或新建正式标注资源，资源 ID、父项目、VOD 绑定、权限、工作流状态、批注和恢复历史均保留。

三方优先级固定为：

```text
平台当前值 > 本地 v0902 > revision 1 中的 v0901 初始值
```

平台相对 v0901 改过的字段保留平台值；平台未改的字段采用 v0902。平台删除也属于平台修改。平台工尺标注只要相对 v0901
有任何变化，该折就按保守策略标为 `skipped`，保留现状且不参与执行；该判断只依赖可信的 revision 1 和平台当前正文，因此本地
v0902 缺失/损坏、其重复 ID 或目标名冲突不会把该折升级为整批阻断。无法取得可信 base/current、扫描中 revision 漂移，或者
非跳过折的重复 ID、悬空引用、同名资源等问题不会被当成可自动解决的内容冲突，而会阻断该批执行。

### 统一对应与字段规则

1. 普通对象递归到每个叶子字段。对每个字段严格比较规范化后的平台值与 v0901：相同则取 v0902，不同则取平台。
   唯一例外是区间元素的 `startTime + endTime`：它们是一个不可拆分的子字段。只要平台相对 v0901
   改过其中任意一端，两端均取平台，不与 v0902 拼接。
2. 在通用合并之前完整比较平台和 v0901 的 `gongcheAnnotations`。新增、删除、重排、父块变化、工尺块字段变化或符号字段变化均视为平台改过工尺，整折标为 `skipped`；不生成合并正文，也不改名。只有平台工尺完全未改时，v0902 工尺才继续参加下述通用合并。
3. 字幕句、字级标注、动作、自定义块、附属点、工尺块/符号、板眼段/点等时间线集合先对应元素，再递归比较其子字段。
4. 三方 ID 稳定时按 ID 对应。v0902 重建 ID 时，只在同一父级容器内元素数量相同、时间位置唯一时按时间排序对应。这能正确处理不同句或并行轨道时间重叠的情形。新 ID 本身也遵守同一字段规则。
5. 平台已有的新增、删除、换句或换轨等结构变化优先；但能明确对应的其他元素仍继续逐字段合并，不会因单个结构改动而放弃整个集合的 v0902 更新。
6. 顶层字级集合若平台 ID 与 v0901 完全无交集且字数也改变，视为平台整批重建，完整保留平台 `characterAnnotations`，不与 v0902 拆字段混合。
7. 除上述平台字级整批重建外，同一父级内时间重合无法区分、ID 全变且数量不同、ID 重建同时又换句/换轨，或非时间线结构 ID 全变时，该文件阻断并转人工处理，不按全局数组下标猜测。

## 安全边界

- `dry-run` 和 `verify` 只读取平台；`dry-run` 仅在本机写计划文件。
- `execute` 只原地更新计划中 `save_and_rename` / `rename_only` 的标注资源并把 `_v0901_` 改名为 `_v0902_`；`skipped` 文件保持原正文、原名称和原 revision。代码中没有正式资源删除或新建路径。
- `live-test` 是唯一会创建资源的测试命令。它只读选择一折真实已修改 v0901，把该折的 revision 1、平台当前正文和本地 v0902 复制到唯一命名的根测试项目，再对测试副本运行正式合并链路；原资源不会保存、改名或覆盖。
- 成功的 `live-test` 项目保持活动状态，供人工复核后再处理；失败的隔离项目会尽量自动移入回收站。
- 密码只从 stdin 读取。计划、状态、日志和终端输出不得包含密码、access token、媒体临时 URL或完整标注正文。
- 正式执行必须使用部署了本工具对应提交的 API；该版本支持用 `revision=1` 精确查询初始恢复快照。
- 平台内置维护模式会阻断普通 HTTP 写入，因此执行 `execute` 时必须保持内置维护模式关闭。本手册中的“维护窗口”是已通知用户保存退出的人工停写窗口。

## 文件与输出

- v0902 来源目录：包含规范名称 `NNN_v0902_*.json` 的本地目录，可以有子目录。
- 计划文件：`dry-run` 原子写入，权限为 `0600`，记录资源身份、revision、媒体 ID、内容哈希、合并统计、阻断项和 fingerprint，不含正文。
- 状态文件：首次 `execute` 时原子创建，权限为 `0600`；保存每个可执行资源的稳定 operation ID和断点状态，不保存租约 token。状态格式 v2 会逐行绑定同一 plan 的资源、输入 revision、目标名和合并哈希，并严格区分 `pending`、`saved_pending_rename`、`completed`；字段缺失、多余、状态伪造或资源集合不同均拒绝续跑。若完成后已有新 revision，工具还会精确读取 committed revision 的恢复快照并核对当时正文哈希，不能仅凭本地 `completed` 跳过提交验证。
- 计划 fingerprint 覆盖计划中的全部输入事实。计划文件被改写、平台 revision 变化或本地规范化正文变化时，执行会失败并要求重新 dry-run。

现有工作区中的下列本地数据是运行输入，不属于代码提交：

```text
kunqu_labels_2026-09-02/
kunqu_labels_2026-09-02.zip
v0901-unmodified-jsons-20260903.csv
```

## 1. 部署前验证

```bash
npm run test:platform-merge-v0902
npm run test:api
npm run build
```

对正式平台运行隔离测试。它需要真实 v0902 来源目录，可用 `--resource-id` 指定一折已修改的原平台文件；省略时会选择首个无阻断、需要合并且平台正文确实不同于 revision 1 的候选：

```bash
read -rsp '平台密码: ' XIQU_V0902_PASSWORD
printf '%s' "$XIQU_V0902_PASSWORD" | npm run platform-merge:v0902 -- live-test \
  --base-url https://kunqu.aik2.site/api \
  --account <super-admin-account> \
  --source-dir "$PWD/kunqu_labels_2026-09-02"
unset XIQU_V0902_PASSWORD
```

成功条件：输出 `ok: true`、`resourceIdPreserved: true`、`mediaResourceIdPreserved: true` 和 `finalRevision: 3`。输出还会给出只读原文件路径、测试项目名及测试标注文件名。项目中会有合并结果和 `对照_1_原始v0901`、`对照_2_平台修改v0901`、`对照_3_本地v0902` 三个只读来源副本。到平台打开该测试项目人工比较；确认平台修改保留、平台未修改部分采用 v0902 后，再决定是否移入回收站。人工确认前不得正式执行，也不得提交用于交接的代码。

`live-test` 的成功项目故意不自动清理。若命令失败，它会尝试把失败项目移入回收站；清理也失败时会以非零状态打印项目 ID，需人工处理。

## 2. 维护窗口前 dry-run

准备一个不进入 Git、不会被重启或系统临时目录清理删除的受控输出目录。以下路径位于仓库外；把日期替换为本次实际维护日期，
并在整次执行、验证和回退审计结束前保留：

```bash
XIQU_V0902_RUN_DIR="$PWD/../xiqu-v0902-merge-run-20260904"
mkdir -p "$XIQU_V0902_RUN_DIR"
chmod 700 "$XIQU_V0902_RUN_DIR"
read -rsp '平台密码: ' XIQU_V0902_PASSWORD
printf '%s' "$XIQU_V0902_PASSWORD" | npm run platform-merge:v0902 -- dry-run \
  --base-url https://kunqu.aik2.site/api \
  --account <super-admin-account> \
  --source-dir "$PWD/kunqu_labels_2026-09-02" \
  --plan "$XIQU_V0902_RUN_DIR/plan.json"
unset XIQU_V0902_PASSWORD
```

不要把正式 plan/state 放在 `/tmp`。它们是中断续跑、事后验证和精确回退的唯一批次证据；另存一份只读备份并记录目录位置。

检查终端摘要和计划文件：

- `modifiedV0901Count` 是本次发现的活动区、revision 大于 1 的规范 v0901 文件数，不应依赖历史手工统计值。
- `blockedCount` 必须为 0；否则不执行。`skippedCount` 可以大于 0，代表因平台工尺修改而明确留在 v0901、不会进入执行的折数。
- `readyCount = saveCount + renameOnlyCount`。
- 应满足 `modifiedV0901Count = readyCount + skippedCount + blockedCount`，并逐项保存 `skippedRows` 名单交接给人工处理。
- 每行检查平台路径、当前 revision、目标文件名、媒体 ID、三份输入哈希和 `decisions`。路径列表只展示有界样本，完整数量由计数给出。
- `unusedLocalJsonCount` 可以大于 0，因为来源目录同时包含已经升级或本轮不属于“已修改 v0901”的文件。
- 记录输出的完整 64 位 `fingerprint`，不要从旧 dry-run 复制。

非工尺跳过行的常见阻断：

- 找不到精确 v0902 文件或本地存在同名文件；
- 同级已经存在目标 v0902 名称；
- 找不到唯一 revision 1 恢复快照；
- 平台文件在扫描期间改变；
- 合并后出现重复 ID、悬空引用或轨道结构不完整。

平台工尺相对 v0901 已修改不属于批次阻断：该行以 `action: "skipped"` 和明确原因保留在计划中，其余安全行仍可执行。不要从计划中删除这类审计行，也不要手工改成可执行 action。

修正原因后重新 dry-run。不要编辑计划文件绕过阻断。

## 3. 正式人工停写窗口

1. 通知所有用户保存并退出编辑器，确认关键协作者页面显示“已保存”。离线浏览器草稿无法由本工具探测。
2. 按生产运维流程创建并验证一致备份。若为备份开启平台内置维护模式，备份完成后先关闭内置维护模式；否则本工具会安全拒绝 execute。
3. 在执行前再次运行第 2 节 dry-run，复核新 fingerprint 和 `blockedCount=0`。
4. 串行执行，不要启动第二个进程：

```bash
read -rsp '平台密码: ' XIQU_V0902_PASSWORD
printf '%s' "$XIQU_V0902_PASSWORD" | npm run platform-merge:v0902 -- execute \
  --base-url https://kunqu.aik2.site/api \
  --account <super-admin-account> \
  --plan "$XIQU_V0902_RUN_DIR/plan.json" \
  --state "$XIQU_V0902_RUN_DIR/state.json" \
  --plan-fingerprint <dry-run输出的完整fingerprint>
unset XIQU_V0902_PASSWORD
```

每个需要保存的文件执行以下受保护步骤：重新核对输入事实、取得 `bulk_import` 租约、登记 `merge_project` 快照边界、按当前 revision 保存、核对正文和媒体绑定、最后改名。成功保存会自动释放租约，并自动生成“合并前 revision”的恢复快照。

### 中断与续跑

- 不删除计划和状态文件，不手工改写其中的状态或 operation ID。
- 使用完全相同的 plan、state 和 fingerprint 重跑 execute。
- `pending` 会重新核对全部输入；`saved_pending_rename` 只在正文哈希和 committed revision 都吻合时继续改名；`completed` 不再写正文。
- 若提示平台或本地输入已经变化，保留旧计划/状态作为证据，换新文件名重新 dry-run。不要用旧 fingerprint 强行继续。
- 若内置维护模式在中途开启，后续写入返回 503；已成功的文件保留，关闭维护模式并按状态文件续跑。
- execute 运行时会创建 `state.json.lock`，其中只记录 PID、启动时间和计划 fingerprint。普通退出会自动删除它；若 SIGKILL、
  主机崩溃等导致锁遗留，先用 `cat "$XIQU_V0902_RUN_DIR/state.json.lock"` 查看记录，再用
  `pgrep -af 'platformV0902MergeCli.*execute'` 确认没有任何执行进程。只有确认旧进程已经退出，才把锁移动为带时间戳的审计文件，
  例如 `mv "$XIQU_V0902_RUN_DIR/state.json.lock" "$XIQU_V0902_RUN_DIR/state.json.lock.stale-20260904T230000"`，随后使用原
  plan/state/fingerprint 续跑。PID 仍存在、锁来自另一台主机或无法确认时必须停止，不得删除或覆盖锁。

## 4. 事后验证

```bash
read -rsp '平台密码: ' XIQU_V0902_PASSWORD
printf '%s' "$XIQU_V0902_PASSWORD" | npm run platform-merge:v0902 -- verify \
  --base-url https://kunqu.aik2.site/api \
  --account <super-admin-account> \
  --plan "$XIQU_V0902_RUN_DIR/plan.json" \
  --state "$XIQU_V0902_RUN_DIR/state.json" \
  --plan-fingerprint <同一fingerprint>
unset XIQU_V0902_PASSWORD
```

要求 `ok: true`、所有实际执行行的 `issues` 为空，并且 `verifiedSkippedCount = skippedCount`。verify 会逐项证明跳过行的名称、
父级、媒体绑定、revision 和正文哈希仍等于 dry-run；任何跳过行在计划后被用户或其他工具改动都会使验证失败。
`advancedAfterMerge: true` 表示合并完成后平台又产生了更高 revision；工具不会覆盖这些后续修改，应单独人工核对。

抽查至少一折包含平台冲突字段和一折包含 v0902 新增字段的文件，确认：

- 文件名已经是 v0902，资源 ID和 VOD 绑定未变；
- 平台修改保留，平台未修改部分获得 v0902 内容；
- 工作流、权限、批注、恢复历史仍在原资源上；
- Inspector 的恢复历史存在合并前 revision。

## 5. 回退

不要通过删除 v0902、重新上传 v0901 回退，也不要把 revision 数字理解为可以倒退的版本号。当前 CLI 没有批量 `rollback` 命令；回退必须逐折执行，并要求操作者对原标注资源拥有有效 `write` 权限。

先在 plan 中确认该行的 `action`：

- `save_and_rename`：正文发生过保存。服务器已在该行的 `currentRevision` 创建“保存前自动快照”，这是合并前包含全部平台修改的正文。
- `rename_only`：正文和 annotation revision 都没有改变，也不会因为本次操作新增恢复快照；只需把同一资源改名回 `_v0901_`。
- `skipped`：工具没有保存或改名，无需回退。

对 `save_and_rename` 单折回退时：

1. 保持人工停写；记录 plan 中的资源 ID、`currentRevision`，以及平台当前 revision。
2. 在原资源 Inspector 的恢复历史中，选择 revision 恰好等于 plan `currentRevision` 的“保存前自动快照”，先与当前文件比较；不要只凭创建时间猜测。
3. 确认后使用平台恢复功能把该快照写成新的 revision。恢复采用乐观锁；若当前 revision 又变化，服务器会拒绝并要求刷新，不能强行覆盖。
4. 如需恢复命名，再把同一资源改名回 v0901。
5. 复核资源 ID、VOD、权限、批注及正文后再恢复编辑。

Inspector 默认只显示最近 50 个快照。如果目标 revision 已不在列表中，不要改选一个“看起来接近”的快照；由管理员通过精确查询
`GET /api/annotation-files/<resourceId>/recovery-snapshots?revision=<plan.currentRevision>` 定位。精确查询也找不到唯一快照时停止回退并调查。

若合并后用户又有保存，恢复旧快照会用旧正文替换这些后续编辑。服务器会先把恢复前的当前正文另存为“恢复前保护快照”，因此后续编辑不会从数据库历史中消失，但不会继续留在活动正文中；必须先比较、征得该文件协作者确认，并决定是否另行导出或人工合并。

恢复是新的 revision，不回退计数器，也不会删除本次合并的审计事实、权限、批注或 VOD 绑定。完成回退后同时保存 plan、state、恢复使用的 snapshot ID和最终 revision，供审计与再次恢复。
