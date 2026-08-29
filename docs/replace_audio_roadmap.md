# 多音轨快速切换、替换播放与媒体级分析路线图

> 文档状态：RA0-RA6 已完成；2026-08-29 补强 JobId MP3 暂停预热与主从同步起播
> 专项分支：`codex/external-audio-start-sync`
> 制定日期：2026-08-24  
> 关联总路线图：`docs/kunqu-platform-roadmap.md`

## 0. 当前进度

- **RA0 已完成（2026-08-24）**：共享包已建立严格的媒体音轨、默认音轨偏好、分析状态与媒体级 analysis
  identity 合同；Web 已建立视频主时钟映射、统一漂移阈值和带 source generation 的同步播放纯状态机。
- **RA1 已完成（2026-08-24）**：Prisma 已新增有序 `MediaAudioTrack` 和标注文件
  `AnnotationAudioPreference`，上传媒体、VOD 媒体及媒体复制均在同一事务建立唯一原声；严格 CRUD、重排、
  默认值、ACL、审计和类型安全客户端边界已通过真实 PostgreSQL 集成测试。
- 当前代码已删除 `AnnotationAnalysisAudioSetting` 与无音轨 ID fallback；在线 canonical `MediaAnalysisRun` 只按
  媒体内容、算法和配置复用，音轨 offset 只在请求 DTO/时间轴装配时投影。生产数据库仍须执行两版本 rollout。
- **RA2a 已完成（2026-08-24）**：additive supersession migration、纯计划器和 super-admin-only
  dry-run/execute CLI 已建立；执行只标记 canonical/duplicate，保留全部 run、asset 和对象。
- **RA2b1 已完成（2026-08-24）**：新增不含 annotation/mode/offset 的媒体 fingerprint，迁移计划已能跨旧偏移
  归并并为 canonical 幂等回填。
- **RA2b2 已完成（2026-08-24）**：service、worker、asset ACL adapter 与 IndexedDB 缓存已切到媒体级
  canonical identity，最终 migration 以 fail-closed 前置检查保护两阶段生产迁移。
- **RA3a 已完成（2026-08-24）**：建立严格 no-store 外部音轨播放会话、逐请求三层 ACL、共享 VOD 签发器、
  上传/VOD 音频来源适配及统一 volume/mute/buffering backend 能力；尚未接入编辑器可见行为。
- **RA3b1 已完成（2026-08-24）**：组合播放 runtime 已接入 `VideoPlayer` 的可选生命周期，以视频为唯一主时钟，
  集中拥有替换音频、漂移/缓冲恢复、静音路由、generation 和离屏 VOD 容器；App 尚未传入外部来源，当前可见
  行为不变。
- **RA3b2a 已完成（2026-08-24）**：建立标注文件上下文的 no-store 可试听选项、文件会话选择 hook、紧凑顶栏
  选择器和共享默认写入；失败/撤权/列表加载异常均暂停静音并保留选择，只有显式选择视频原声才恢复主声音。
- **RA3b2b1 已完成（2026-08-24）**：完成本机候选库恢复演练及默认开发库两阶段媒体级分析迁移；新增主媒体
  写权限控制的低频音轨管理器、纯音频资源选择、上传音频真实播放闭环和 VOD 纯音频媒资识别。迁移校验已修正
  manifest 波形桶宽与资产 level 序号混淆，真实上传 WAV 的播放会话与 Range 读取通过。
- **RA3b2b2a 已完成（2026-08-24，2026-08-28 补强）**：任意有权访问的 VOD 视频媒资下的 MP3 音频转码以阿里云官方 `JobId` 作为稳定身份；
  数据库只保存所属 VOD 媒体、JobId 和有限显示元数据，播放时重新取得指定 JobId 的 HTTPS 临时地址并通过
  no-store 会话交给原生音频 backend。管理器使用一个统一音频来源选择器：纯音频直接进入关系草稿，VOD
  容器继续进入服务端候选的 MP3 JobId 步骤。真实 `Johann_Sebastian_Bach` 已在普通选择栏目中完成搜索、转码
  选择、关系保存、顶部切换和视频联合播放。
- **RA3b2b2b1 已完成（2026-08-24）**：慢网生命周期审查发现 VOD 刷新错误捕获了已经完成的首次准备 signal；
  现由唯一 Aliplayer backend 为每次会话请求分配 AbortController，销毁时真实中止所有在途刷新，并把 signal
  贯通主 VOD、独立 VOD 音频和同 VID rendition。播放器专项增至 48/48，完整 build 通过。
- **RA3b2b2b2 自动与登录冒烟门禁已完成，完整听觉门禁延期（2026-08-26）**：用户登录后，Agent 在
  `http://localhost:5173/` 确认目标标注文件已绑定《寻梦》VOD、编辑器正常加载约 24:54 媒体、视频原声成为
  当前监听音轨且协作状态已同步。Chrome 控制连接在继续展开音轨菜单时反复中断，未取得 A/B/C 听辨、Safari、
  HTTP IP、撤权、续签、慢网和 detached window 的完整证据；用户明确要求跳过本次验证并继续开发。这些项目
  保留为 RA3 延期验收债务，不写成已通过，也不再阻塞 RA4 的代码实施。
- **RA3b2b2b2 VOD 入口与联合播放补验已完成（2026-08-28）**：此前延期的管理器展开、统一音频来源搜索、
  跨 VOD 媒资选择、rendition 选择、保存和顶部切换已在真实登录页面通过；同一真实 Johann SQ MP3 临时流又在当前源码下与
  《寻梦》MP4 从随机 78.793 秒联合播放约 15 秒，无 waiting、stalled、缓冲暂停或硬 seek。Safari、慢网、
  30 分钟长播、生产 HTTP IP/未来 HTTPS 和撤权仍保留为独立环境验收，不再与本次入口缺陷混写。
- **RA4a 已完成（2026-08-26）**：分析 status/create/list/single/batch API 已支持稳定 `audioTrackId` 上下文；
  服务端逐次重读音轨归属、enabled、主媒体与来源 ACL，VOD rendition 以 JobId 形成独立 fingerprint 并由 worker
  精确取流。旧无 track id 路径继续兼容，未做前端半迁移。
- **RA4b 已完成（2026-08-26）**：分析显示每次打开文件默认跟随监听音轨，也可在会话内固定另一条可用音轨；
  status、create、descriptor、batch、相邻预取和全量预加载统一携带同一 `audioTrackId`。音轨/偏移进入内存显示
  代际但不污染媒体级瓦片缓存，旧状态或旧请求不能在切轨后复活；旧“选择分析音频/恢复自动”可见流程已移除。
- **RA4c1 已完成（2026-08-26）**：新增 super-admin-only 的
  `analysis-audio-settings:migrate dry-run/execute`。可无损的纯音频覆盖会幂等创建/复用共享音轨；无稳定 JobId
  的 VOD 视频、不同 offset、禁用关系、失效资源或结构/数量异常形成有限阻断码，任一阻断都会拒绝整批写入。
- **RA4c2 代码已完成（2026-08-26）**：所有分析请求强制稳定音轨 ID，旧 route/client/DTO/service fallback、旧
  setting model 与 run 的 annotation/mode/offset 列已经删除；migration 29 在删除前以 SQL 二次验证全部旧设置
  已被等价启用音轨表达。隔离数据库门禁、API 193/193 和完整 build 通过。
- **RA5a 已完成（2026-08-26）**：音轨管理器新增毫秒级偏移校准，手工秒输入与正负 24 小时边界继续保持；
  `-10/-1/+1/+10 ms` 使用统一整数毫秒算法，避免重复步进产生浮点尾数，并明确显示音频提前/延后语义。
  保存仍是一次显式关系更新，未增加预览偏移、逐点击请求或第二套播放状态。
- **RA5b 已完成（2026-08-26，2026-08-28 真实播放补强）**：漂移/缓冲算法保持视频主时钟，新增封闭、钳制、会话内的低频
  同步诊断；缓冲使用单调时钟计时，重复事件只计一次。修复 seek 等待期间用户主动暂停后，迟到同步被误判为
  非法转换的问题；旧恢复现在静默结束且不能恢复播放。
- **RA5c1 已完成（2026-08-26）**：原生/VOD 控件与主视频自然结束统一回写组合 runtime；错误态嵌套 pause
  返回最终有效播放事实，UI 不会误显示播放中。短音轨 before/playable/after/invalid 区域按代际观察，连续采样
  只在跨边界时 pause，seek 返回可播区仍会恢复。
- **RA5c2 代码已完成（2026-08-26）**：VOD 后台续签失败保留旧播放器并按 5/15/30/60 秒有界退避；真实
  player error 先进入 buffering，以 1/3/10/30 秒有限预算单飞恢复，耗尽后才报告一次致命错误。online、pageshow
  和页面重新可见会唤醒同一主从恢复入口；恢复前冻结命令/来源代际，期间后发 pause/play/seek、切轨或切文件
  始终优先。分离预览监听实际 ownerDocument，关闭窗口或销毁来源会取消续签任务。
- **RA5c3 已完成（2026-08-29）**：JobId MP3 改由可续签原生 audio 播放，随机起播共用主时钟推进门禁；
  6 秒稳定窗口以 10ms 目标和 +/-4% 倍率伺服消除 seek 自激，Timeline 分析 viewport 更新循环同时收口。
- **RA5c4 已完成（2026-08-29）**：JobId MP3 在暂停目标先完成静音解码并精确回位，位置仍匹配时与主视频
  并发起播；播放中随机 seek 先冻结主从、在目标预热，再通过同一屏障恢复。起步偏移不再依赖约 5 秒的
  稳定窗口慢慢追回，既有 10ms 目标、+/-4% 倍率上限和 150/500ms 硬同步边界保持不变。
- **RA6 已完成（2026-08-26）**：生产已按三段 release 完成媒体级迁移、migration 29 destructive 收口、
  服务恢复与维护解除；历史迁移工具和门禁仍必须保留给未来旧服务器升级，不能直接跨版本部署。

## 1. 目标重新定义

本专项不再把需求理解为“给标注文件临时指定一份替换音频”，而是建立一套与视频长期关联的**音轨集合**：

- 每个视频都可以关联主音轨、人声分离音轨、伴奏音轨、降噪音轨或其他自定义音轨。
- 音轨既可以是平台上传的 MP3、WAV 等音频文件，也可以是阿里云 VOD 中的独立音频或音频转码内容。
- 打开标注编辑器后，用户可以在已经关联的音轨之间快速、自由切换，不需要反复打开资源选择器，也不需要重新进入编辑器。
- 切换音轨时视频画面和标注时间轴不变，视频继续作为主时钟；所选音轨立即替换实际听到的声音。
- 每个媒体音轨只要完成过波形、频谱或 F0 分析，其分析结果就与该媒体音轨本身关联并复用，而不是与某一份标注文件重复绑定。
- 切换到已有分析结果的音轨时，前端同步切换波形、频谱和 F0；不重新计算，也不复制瓦片。
- 同一视频被多份标注文件引用时，这些标注文件可以共享该视频的音轨集合和媒体级分析结果。

这套能力最终应让编辑器更接近 DAW/NLE 的音源切换体验，而不是在“视频设置”和“频谱设置”里维护两套互不透明的临时覆盖项。

## 2. 概念模型

### 2.1 主媒体

主媒体负责：

- 视频画面；
- 权威播放时间；
- 播放头、循环区间、远端播放头和标注时间坐标；
- 与标注文件的主要媒体关系。

主媒体可以是本机视频、服务器上传视频或阿里云 VOD 视频。只要存在视频，视频始终是主时钟，音轨不能反向推动时间轴。

### 2.2 音轨资源

独立音轨资源通常是平台中真实存在的 `MediaFile`：

- 上传的 MP3、WAV、M4A 等音频文件；
- 阿里云 VOD 中的独立音频资源；
- 视频自身包含的原始音频。视频原声在 UI 中是一条音轨，但数据库可以用主媒体身份表达，无需复制媒体对象。

同一 VOD 视频下的指定 MP3 转码属于该视频的派生 rendition，而不是资源树中的独立文件。它以所属 VOD
`MediaFile + JobId` 表达稳定来源，不能复制、移动或下载成一个虚构的资源节点；临时播放地址只存在于播放会话。

### 2.3 音轨关联

音轨关联描述“某个视频有哪些可以切换的声音”，它不是音频二进制本身：

- 音轨显示名称，例如“视频原声”“人声分离”“伴奏”；
- 音轨类型，例如原声、人声、伴奏、降噪或自定义；
- 指向真实音频媒体资源，或指向一个真实 VOD 视频下由 JobId 唯一标识的音频 rendition；
- 音轨相对视频的时间偏移；
- 排序和默认选择；
- 启用状态和创建来源。

### 2.4 当前监听选择

当前监听选择应分为两个层次：

1. **共享默认音轨**：文件再次打开时默认使用哪条音轨，由有编辑权限的用户保存。
2. **当前会话选择**：用户在本次打开编辑器期间临时切换的音轨，切换必须快速，不写标注 revision，也不进入协作命令、撤销栈或 ProjectData。

会话选择默认从共享默认值初始化。普通只读用户也应能在自己有权访问的已关联音轨之间试听，但不能修改共享默认值或音轨集合。

### 2.5 媒体级分析

分析结果的稳定归属是**被分析的媒体资源和算法配置**，而不是标注文件：

```text
分析结果身份 = 媒体内容指纹 + 算法版本 + 算法配置
```

音轨相对视频的偏移只影响分析数据显示在项目时间轴上的位置，不改变音频内容，也不应产生新的分析 run。

## 3. 当前实现审查

### 3.1 可以复用的基础

- `MediaFile` 已统一表达上传媒体和阿里云 VOD 媒体。
- 标注文件已经通过真实外键关联主媒体资源。
- `AnnotationAnalysisAudioSetting` 已支持自动来源、覆盖音频和 `offsetSeconds`。
- `MediaAnalysisRun`、`MediaAnalysisAsset`、独立 worker、对象存储瓦片和浏览器渐进缓存已经完整存在。
- 分析 worker 对上传媒体使用 FFmpeg 流式输入，对 VOD 使用只存在于 worker 内存中的临时纯音频地址。
- `usePlatformMediaAnalysis` 已支持瓦片描述、批量读取、当前窗口预取、内存缓存和 IndexedDB 二级缓存。
- `AnnotationMediaBindingDialog` 已有跨目录搜索和媒体选择能力。
- `MediaPlaybackController` 已把原生媒体和 Aliplayer 统一为一套播放控制入口。

### 3.2 必须修正的旧数据边界

当前 `MediaAnalysisRun` 包含：

```text
annotationFileId
sourceMediaResourceId
sourceMode
sourceOffsetSeconds
sourceFingerprint
```

并使用：

```text
annotationFileId + sourceFingerprint + algorithmVersion + configHash
```

进行唯一化。这会产生四个问题：

1. 同一个 MP3 被多份标注文件使用时会重复分析、重复存储瓦片。
2. 同一个 VOD 主媒体的声音在不同标注文件中无法自然共享分析结果。
3. 改变音轨相对视频的偏移可能创建新的 run，但偏移并没有改变音频内容。
4. 切换音轨时，前端需要先围绕标注文件重新解析“当前 run”，无法直接按音轨命中已有结果。

因此本专项不能只新增一个 `AnnotationPlaybackAudioSetting` 后继续沿用旧 run 结构。分析 run 必须迁移为媒体级资产。

### 3.3 必须修正的旧交互边界

当前分析音频选择主要藏在频谱设置面板中，适合“决定分析谁”，不适合高频试听切换。当前播放器一次只拥有一个后端，也没有第二音频的主从同步状态机。

新实现必须避免：

- 每次切换都重新打开目录选择器；
- 每次切换都重新请求分析任务；
- 把播放音轨选择与频谱开关耦合；
- 在 App 中同时维护两套独立播放状态；
- 让旧异步媒体事件在切换后重新激活上一条音轨。

## 4. 产品行为

### 4.1 编辑器中的快速切换

编辑器顶部媒体控制区增加紧凑的“监听音轨”选择器：

- 当前音轨名称始终可见；
- 点击后直接列出已关联音轨；
- 每项显示音轨类型、来源类型、分析状态和不可用原因；
- 选择后立即切换，不离开编辑器；
- 已加载会话和已有分析瓦片尽量复用；
- 切换期间显示短暂“正在同步”，不能播放两条声音；
- 支持键盘切换上一条/下一条音轨，但不得占用现有时间轴快捷键。

音轨管理属于低频操作，应放在选择器中的“管理音轨”入口或媒体设置面板：

- 关联新的上传音频或 VOD 音频；
- 重命名音轨显示名称；
- 设置类型与排序；
- 设置相对视频的偏移；
- 取消关联；
- 设置共享默认音轨；
- 发起或查看该音轨的分析。

### 4.2 切换播放与切换分析显示

默认行为：选择监听音轨时，波形、频谱和 F0 同步切到该音轨的分析结果。这最符合快速比较主音轨与分离音轨的使用习惯。

同时保留一个明确的高级选项：

```text
[x] 分析显示跟随监听音轨
```

关闭后，用户可以固定一条“分析显示音轨”，同时试听另一条音轨。这个状态默认只属于当前编辑器会话，不写 ProjectData。

这样可以覆盖两类场景：

- 听人声分离音轨，同时看它自己的频谱；
- 听视频原声，但固定查看人声分离后的 F0。

### 4.3 没有分析结果时

切换到未分析的音轨时：

- 音频仍可立即播放；
- 波形、频谱和 F0 区域显示“该音轨尚未分析”；
- 有权限的用户可点击“开始分析”；
- 不能自动在后台发起高成本任务，除非后期由管理员配置自动分析策略；
- 不能偷偷显示上一条音轨的分析数据。

### 4.4 音轨可用性

关联存在但当前用户没有 `read + download` 权限时：

- 音轨仍可按产品策略显示名称或显示“无权访问的音轨”，但不能泄露地址、大小和供应商信息；
- 不允许切换播放或读取分析瓦片；
- 当前正在使用的音轨被撤权时，暂停播放并明确提示；
- 不自动回退到视频原声，防止研究者误以为仍在听分离音轨；
- 用户可以主动切回原声。

## 5. 数据结构设计

### 5.1 媒体音轨关联

当前 `MediaAudioTrack` 采用三种互斥来源：

```text
id                         UUID 主键
primaryMediaResourceId     主视频或主媒体资源
audioMediaResourceId       独立音频 MediaFile 来源
vodRenditionMediaResourceId VOD rendition 所属视频 MediaFile
vodRenditionJobId          阿里云媒体流稳定 JobId
vodRenditionFormat         当前只允许 mp3
vodRenditionDefinition     有限展示信息
vodRenditionBitrate        有限展示信息
vodRenditionDuration       有限展示信息
name                       用户可读名称
kind                       original | vocal | accompaniment | denoised | reference | custom
offsetSeconds              音频 0 秒对应的视频时间，默认 0
sortOrder                  同一主媒体内稳定排序
isEnabled                  是否仍可在编辑器选择
createdByAccountId
createdAt
updatedAt
```

关键约束：

- 一个主媒体最多一条 `original` 音轨。
- 非 `original` 音轨必须引用真实纯音频 `MediaFile`，或引用真实 VOD 视频下仍存在的 `JobId` rendition。
- 普通视频不能伪装成独立音频资源；VOD rendition 使用独立 source variant，并由服务端重新查询供应商事实。
- 同一主媒体和音频资源只保留一个有效关联；同一主媒体、来源 VOD 与 JobId 的组合也只保留一个关联。
- `offsetSeconds` 是关联属性，不写入 `MediaAnalysisRun`。
- 删除关联不删除真实媒体资源、阿里云转码或该媒体已有分析结果。

### 5.2 标注文件默认音轨

建议在标注文件平台状态中新增：

```text
AnnotationAudioPreference
  annotationFileId         主键
  defaultAudioTrackId      可空；空值回退主媒体原声
  updatedByAccountId
  updatedAt
```

该表只保存共享默认音轨。当前会话临时选择保存在 React 会话状态中，不进入数据库。

如果多份标注文件绑定同一视频，它们共享音轨集合，但可以选择不同的默认音轨。

### 5.3 媒体级分析 run

将 `MediaAnalysisRun` 的稳定归属改为：

```text
id
sourceMediaResourceId
sourceFingerprint
algorithmVersion
configHash
config
status / progress / errorCode
duration / sampleRate / manifest
createdBy / timestamps
```

唯一约束改为：

```text
sourceMediaResourceId + sourceFingerprint + algorithmVersion + configHash
```

或者在确认内容指纹全局可靠后使用：

```text
sourceFingerprint + algorithmVersion + configHash
```

第一版推荐保留 `sourceMediaResourceId`，避免两个资源恰好指向同一外部内容时出现权限和生命周期难题。以后如需跨资源去重，再引入独立的内容对象层。

从 run 中删除：

- `annotationFileId`
- `sourceMode`
- `sourceOffsetSeconds`

这些字段分别属于使用上下文、来源关系和时间对齐关系，不属于分析结果。

### 5.4 视频原声音频身份

视频原声分析仍需要稳定的媒体身份。对于上传视频和 VOD 视频：

- `sourceMediaResourceId` 直接使用主视频的 `MediaFile.resourceId`；
- worker 从该媒体解析或获取纯音频输入；
- run 表示“该媒体的内含音频分析”；
- 不额外创建一个虚假的音频文件资源。

RA3b2b2a 已允许把 VOD 内指定 JobId 当作监听音轨。RA4 必须先为这类 rendition 冻结独立分析身份：不能仅用
所属视频 `MediaFile` 的 fingerprint 让多个流复用同一 run，也不能把临时 URL 纳入 fingerprint。

### 5.5 分析显示映射

分析瓦片始终使用音频自身时间：

```text
tile.startTime / endTime = 音频源坐标
```

渲染到项目时间轴时统一换算：

```text
项目时间 = 音频时间 + MediaAudioTrack.offsetSeconds
```

改变偏移后无需重新分析，只需清理当前组合视图并按新偏移重新映射瓦片。

## 6. API 设计

### 6.1 音轨集合

已实现接口：

```text
GET    /api/media-files/:primaryMediaId/audio-tracks
GET    /api/media-files/:vodMediaId/audio-renditions
POST   /api/media-files/:primaryMediaId/audio-tracks
PATCH  /api/media-files/:primaryMediaId/audio-tracks/:trackId
DELETE /api/media-files/:primaryMediaId/audio-tracks/:trackId
PUT    /api/media-files/:primaryMediaId/audio-tracks/reorder
```

职责：

- 返回当前用户可见的音轨摘要和可用状态；
- 创建关联时验证主媒体、独立音频媒体或 VOD rendition 与权限；
- 更新名称、类型、偏移和启用状态；
- 稳定重排序；
- 删除时只删除关联，除非用户另行从资源管理器删除真实文件。

### 6.2 标注文件默认音轨

```text
GET /api/annotation-files/:fileId/audio-preference
PUT /api/annotation-files/:fileId/audio-preference
```

更新共享默认值需要标注文件 `edit`，但不推进标注 revision，不进入协作 operation。

### 6.3 播放会话

```text
POST /api/annotation-files/:fileId/audio-tracks/:trackId/playback-session
```

服务器必须在每次建立或续签会话时重新校验：

- 用户可读取标注文件；
- 用户可读取并下载主媒体与目标音频；
- 音轨仍属于该标注文件绑定的主媒体；
- 资源未删除、未禁用、未移入不可访问范围；
- 阿里云 VOD 配置和区域匹配。

返回严格、短时、`Cache-Control: no-store` 的来源 DTO。上传音频优先复用现有受保护 Range 流；VOD 音频通过 gateway 获取临时播放材料。数据库、审计和普通日志都不得保存临时 URL、PlayAuth 或供应商原始响应。

### 6.4 媒体级分析

建议从“标注文件分析接口”迁移为“媒体分析接口”：

```text
GET  /api/media/:mediaResourceId/analysis
POST /api/media/:mediaResourceId/analysis/runs
GET  /api/media/:mediaResourceId/analysis/runs/:runId/assets
POST /api/media/:mediaResourceId/analysis/runs/:runId/assets/batch
```

接口仍需接收标注文件上下文或通过资源 ACL 证明当前用户有权使用该媒体。不能因为知道媒体 ID 就越过标注文件和资源树权限。

为了平稳迁移，旧 URL 可以在一个短期兼容层中把标注文件解析为媒体资源后调用新 service；前端全部切换后必须删除旧 route、旧 DTO 和重复 service 分支。

## 7. 播放架构

### 7.1 主从后端

保留现有视频/VOD 后端作为主后端，新增受控音频从后端：

- 主后端负责权威 `currentTime`、播放状态、seek 和画面；
- 从后端负责所选替换音轨；
- 组合后端对 App 仍暴露一个 `MediaPlaybackController`；
- 使用替换音轨时，主后端静音但继续解码和播放画面；
- 使用原声时销毁或暂停从后端，恢复主后端声音。

不能让 App、Timeline 或协作层直接控制第二个音频元素，否则播放时序会分散到多个模块。

### 7.2 切换算法

用户从音轨 A 切到音轨 B 时：

1. 记录主视频当前时间、播放/暂停状态和 playbackRate。
2. 立即静音旧声音，防止 A、B 或视频原声重叠。
3. 递增来源 generation，取消 A 的会话、加载和迟到事件。
4. 命中 B 的有效内存会话时直接复用；否则请求短时播放会话。
5. 计算 `audioTime = videoTime - B.offsetSeconds`。
6. 将 B seek 到目标位置并等待达到可播放状态。
7. 应用相同倍速和当前音量。
8. 如果视频原来在播放，则同步启动 B；否则保持暂停。
9. 确认 B 已启动后更新 UI 为“已同步”。

切换过程必须是最后意图优先。用户快速点击 A、B、C 时，只允许 C 完成挂载，A/B 的响应不得复活。

### 7.3 快速切换优化

- 编辑器打开后只预取音轨摘要，不预下载全部音频。
- 当前音轨建立完整播放会话。
- 相邻或最近使用音轨可以在空闲时预取会话元数据和少量媒体缓冲，但必须遵守凭证时效与浏览器带宽。
- 已经加载的 `HTMLAudioElement` 可在有界 LRU 中短时保留；切换文件或权限变化时全部销毁。
- 同一音轨的分析瓦片继续使用现有 IndexedDB 缓存，缓存 key 改为账号、媒体、run、asset，不再包含 annotationFileId。
- 不把整段 MP3/VOD 默认下载到浏览器；快速切换依赖 Range、CDN 和小范围缓冲。

### 7.4 同步语义

```text
音频期望时间 = 视频当前时间 - 音轨偏移
```

- 期望时间小于 0：替换音轨等待，视频可播放无声前段。
- 音频提前结束：暂停并提示覆盖范围不足，不能偷偷切回原声。
- seek、循环回跳、倍速变更、后台恢复都必须重新校准。
- 播放时每 `100ms` 比较主从时钟。
- 不超过 `10ms` 的漂移视为同步；`10-150ms` 只对从音轨使用最大 `±4%` 的短时速率伺服并在进入容差后回到用户基础倍率；大于约 `150ms` 时硬 seek。
- 速率伺服不改视频主时钟，原生音频保持浏览器默认音高保持能力；真实 seek、缓冲恢复和来源恢复仍执行权威对齐。
- 外部音频缓冲时，主视频在短宽限后暂停；恢复后校准再继续。

阈值必须通过 Chrome、Safari、上传音频和 VOD 实测调整，不能只依赖理论值。

## 8. 分析架构

### 8.1 分析发起

在音轨选择器和音轨管理面板中显示分析状态：

- 未分析；
- 排队中；
- 处理中及进度；
- 已完成；
- 失败及稳定原因。

有权限的用户可以对任一已关联音轨发起分析。服务端先按媒体内容指纹、算法版本和 configHash 查找可复用成功 run：

- 已存在：直接返回已有 run；
- 正在处理：复用同一 run/job，不重复排队；
- 失败且允许重试：复用或创建符合现有 worker 语义的任务；
- 媒体内容变化：内容指纹改变，创建新 run。

### 8.2 分析结果切换

监听音轨改变且“分析显示跟随监听音轨”开启时：

1. 取消旧音轨已经离开当前 preload 集的请求。
2. 查找新媒体当前算法配置下的成功 run。
3. 立即显示 IndexedDB 中已有的波形前缀。
4. 渐进加载当前视窗，再加载相邻窗口。
5. 按音轨偏移映射到项目时间轴。
6. 新数据未到达时不能继续显示旧音轨的瓦片，可显示明确加载占位。

现有渐进加载、批量瓦片、10 秒历史兼容和缓存降级策略继续保留，不应因归属迁移而重写计算与 codec。

### 8.3 权限与共享

- 分析资产不是公开缓存；读取每一批瓦片仍需校验媒体读取权限和使用上下文。
- 同一媒体 run 可以被多个标注文件复用，但 API 必须确认当前账号通过至少一个有效上下文获得权限。
- `MediaAnalysisAsset` 的对象引用继续纳入生命周期、备份和孤儿检测。
- 删除某个音轨关联不能删除共享 run。
- 真实媒体永久删除后，只有确认没有其他有效引用时才能清理其 run 和 assets。

## 9. UI 信息架构

### 9.1 顶部高频选择器

在视频播放控制附近增加紧凑选择器，而不是把高频切换藏进设置弹窗：

```text
[音轨图标] 人声分离  v
```

下拉内容：

- 按稳定 `sortOrder` 展示音轨；
- 当前音轨使用勾选标记；
- 音轨类型使用克制图标或短标签；
- 上传媒体与 VOD 使用来源图标；
- 已分析使用波形状态图标；
- 不可访问项禁用并显示原因 tooltip；
- 底部提供“管理音轨”。

控件尺寸应与现有菜单栏一致，不增加单独大横条，不挤压时间轴高度。

### 9.2 音轨管理面板

低频管理面板提供：

- 新增服务器音频；
- 新增阿里云 VOD 音频；
- 显示视频原声；
- 自定义名称和类型；
- 拖拽排序，优先复用项目已有成熟拖拽依赖；
- 设置默认音轨；
- 设置偏移；
- 查看和启动分析；
- 取消关联。

取消关联必须明确说明“不会删除资源文件和已有分析”。真实资源删除仍从资源管理器完成。

### 9.3 分析与监听关系

频谱设置面板不再负责创建一套独立的“分析音频覆盖资源”。它只负责：

- 选择分析显示是否跟随监听；
- 在不跟随时固定某条已关联音轨；
- 选择频谱 preset、波形层级、F0 等显示参数；
- 展示当前分析状态和发起分析。

媒体选择、音轨关系和偏移统一归音轨管理，避免两个面板都能选择不同的裸资源而互相覆盖。

## 10. 权限与协作

- 查看或试听音轨：需要标注文件 `read`，以及音频媒体 `read + download`。
- 切换当前会话音轨：只影响本人，不要求 `edit`。
- 修改共享默认音轨：需要标注文件 `edit`。
- 新增、重命名、排序、设置偏移或取消音轨关联：需要主媒体或所属项目约定的编辑能力，具体规则在 RA0 固化，不能只看前端角色。
- 发起分析：至少需要媒体读取/下载权限；是否另需编辑权限应由服务端策略明确，避免只读用户无限创建昂贵任务。
- 音轨选择和播放位置不进入标注协作 operation，也不占用结构编辑租约。
- 远端用户切换音轨不强制其他用户跟随。后期如需要课堂主持模式，应另建显式“教师带领试听”功能。

## 11. 旧逻辑迁移与清理

本专项必须把清理作为正式阶段，不能保留两套分析来源长期并行。

### 11.1 数据迁移

对每个现有 `AnnotationAnalysisAudioSetting`：

1. 解析标注文件的主媒体。
2. `auto` 来源映射为该主媒体的 `original` 音轨。
3. `media_override` 来源在主媒体下创建或复用一条音轨关联。
4. 把 `offsetSeconds` 写入音轨关联，而不是分析 run。
5. 将该音轨设置为该标注文件迁移后的默认分析显示音轨；是否也设为默认监听音轨应采用保守策略，默认不自动改变用户原来的播放声音。

如果同一主媒体的多个标注文件对同一覆盖资源保存了不同偏移，迁移必须：

- 检测冲突；
- 不盲目合并；
- 创建具名的独立关联，或把偏移暂时保留为标注文件上下文覆盖；
- 输出可审计迁移报告，供后续人工统一。

### 11.2 旧分析 run 迁移

现有 run 不能简单改外键后全部保留，因为同一媒体可能已有重复结果：

1. 按 `sourceMediaResourceId + sourceFingerprint + algorithmVersion + configHash` 分组。
2. 每组选择一个完整、成功、manifest 合法且 assets 校验通过的候选 run。
3. 其他完全重复 run 标记为待清理，先不立即删除对象。
4. 失败、处理中或配置不完整的历史 run 保留迁移报告，但不冒充可复用成功 run。
5. 更新 jobs、assets 和对象引用后执行 manifest/校验和验证。
6. 数据库事务成功且新 API 验证通过后，再进行引用检查和对象补偿清理。

迁移过程必须支持 dry-run、幂等重跑、失败回滚和逐项日志，不使用一次性不可审计 SQL。

### 11.3 前端僵尸逻辑清理

新链路稳定后删除：

- `AnalysisAudioMode = auto | media_override` 作为前端裸资源选择入口的旧用法；
- `SpectrogramSettingsPanel` 中重复的“选择分析音频/恢复自动”资源绑定逻辑；
- `usePlatformMediaAnalysis` 对 `annotationFileId` 作为缓存和 run 身份的依赖；
- 以标注文件为 key 的分析资产请求与 IndexedDB key；
- App 中只为旧分析覆盖弹窗服务的状态和 callback；
- 旧 API client 方法、DTO、route 和 service 分支；
- 已无调用的旧测试 fixture 和迁移 fallback。

保留：

- 分析 worker、FFmpeg 流、计算算法、tile codec、批量 envelope；
- 当前窗口渐进加载、取消、预取、LRU 和 IndexedDB 缓存策略；
- VOD 临时地址只在 worker/短时播放会话内存存在的安全边界；
- 本地 Blob 媒体的浏览器分析能力。

### 11.4 后端僵尸逻辑清理

前端和迁移全部切换后：

- 删除 `AnnotationAnalysisAudioSetting` 表及 Prisma relation；
- 删除 `MediaAnalysisRun.annotationFileId`、`sourceMode`、`sourceOffsetSeconds`；
- 删除旧唯一约束和旧索引；
- 把 `mediaAnalysisJobService` 中“先解析 annotation setting 再解析 source”的路径收敛为媒体级 source resolver；
- 合并重复 ACL 检查为一个可复用的媒体分析访问策略；
- 更新对象生命周期与备份代码，避免把共享分析资产当作某一标注文件的子对象；
- 删除兼容 route 前先用 `rg`、API contract 测试和生产访问日志确认没有调用者。

不应为了所谓兼容性永久保留旧表、旧 route 和双写。兼容层只存在于有明确退出条件的迁移阶段。

## 12. 分阶段实施

### RA0：合同、权限和迁移设计冻结（已完成）

**改动范围**

- 共享类型草案；
- 数据模型 ADR/迁移说明；
- 播放状态机与时间映射纯函数；
- 权限策略纯函数及测试。

**验证**

- 音轨、会话选择、默认选择、分析 run 的所有权无循环依赖；
- offset 正负值、无视频纯音频项目、资源撤权等边界均有明确语义；
- 旧数据 dry-run 迁移能够输出冲突报告。

**完成条件**

不修改现有运行行为，但后续阶段不再需要临时改变核心数据归属。

**实际完成（2026-08-24）**

- `packages/shared/src/mediaAudioTracks.ts` 建立六类音轨、内嵌原声/独立媒体严格来源、分析状态、默认偏好、
  名称/数量/偏移上限和 unknown-input parser；original 固定使用主媒体内嵌声音并保持零偏移，其他音轨必须
  引用稳定媒体资源。
- `packages/shared/src/mediaAnalysisIdentity.ts` 将媒体资源、内容指纹、算法版本和配置 hash 编码为无分隔符
  碰撞的 JSON 元组。函数合同没有 annotationFileId、sourceMode 或 offset 输入位置。
- `src/media/synchronizedPlaybackPolicy.ts` 冻结
  `audioTime = masterTime - offsetSeconds`、开始前/可播/结束后区间和漂移边界；初始容差为 40ms，真实标注试听
  后于 2026-08-27 收紧为 10ms；2026-08-28 真实组合播放证明中等漂移硬 seek 会制造周期停顿，因此改为
  100ms 采样与最大 ±4% 从音轨速率伺服，150ms 以上仍立即硬同步。
- `src/media/synchronizedPlaybackState.ts` 建立 source generation、最后音轨优先、幂等媒体事件、缓冲后重同步、
  显式错误和 disposed 终态。它尚未接入 `VideoPlayer`，避免 RA0 改变现有播放行为。
- 新增统一 `test:media-audio-tracks`；共享合同与纯策略 14/14、现有媒体播放 17/17、媒体分析 34/34 通过，
  完整 build 通过。代码审查补上 unknown 数值收窄、严格 ISO 时间不抛异常、共享稳定 identity 复用和正常重复
  media event 幂等处理。

### RA1：媒体音轨关系与管理 API

**状态：已完成（2026-08-24）**

**改动范围**

- Prisma 增量迁移；
- `MediaAudioTrack`、`AnnotationAudioPreference`；
- 音轨 CRUD、重排、默认值和审计；
- 上传音频/VOD 音频候选查询；
- 权限与 API 集成测试。

**验证**

- 同一视频关联 MP3 与 VOD 音频；
- 多标注文件共享音轨集合；
- 删除关联不删除媒体；
- 无权限用户不能通过 ID 枚举资源；
- 旧文件默认仍播放原声。

**实际完成**

- 新增正式 migration `20260824010000_media_audio_tracks`，建立 enum、约束、外键、partial unique、索引和既有
  媒体原声回填；确定性回填 id 不依赖 PostgreSQL 扩展，已在真实测试 schema 应用。
- 新增独立 `MediaAudioTrackService` 和 shared/router/`PlatformClient` 合同，完成列表、新增、更新、删除、精确
  全集重排及标注文件默认音轨读取/写入。persistent record 与 analysis summary 已拆开，RA2 前不返回虚假的
  `not_analyzed`。
- 主媒体写操作在资源树共享 advisory gate 和媒体行锁下复核 active 状态与 `write`；关联外部音频另查
  `read + download` 和 `mediaKind=audio`。默认偏好写入复用 annotation write lock，并只接受当前主媒体下已启用
  音轨。
- 上传媒体、VOD 视频/音频与复制媒体均原子创建自己的 original；复制不携带外部音轨或源 ACL。禁用/删除外部
  音轨清理共享默认引用但保留真实媒体；标注文件改绑主媒体原子删除旧偏好。
- 专项共享/策略 13/13、音轨 API 1/1、现有播放 17/17、现有分析 34/34、完整 API 172/172 与完整 build 均通过。
  完整 API 首轮曾暴露新测试 helper 的宽泛 HTTP method 和 unknown 嵌套对象访问，已收紧为 Fastify
  `InjectOptions` 和显式 record validator；生产代码未以类型断言绕过。
- 本阶段没有 UI、播放 session 或分析 run 迁移，未做浏览器验收，也未部署生产。

### RA2：媒体级分析归属与迁移工具

**状态：已完成（RA2a、RA2b1、RA2b2，2026-08-24）**

**改动范围**

- `MediaAnalysisRun` schema 迁移；
- media-scoped analysis service/routes；
- worker claim、asset API、对象生命周期和备份引用更新；
- run 去重 dry-run/execute CLI；
- IndexedDB key 与前端查询上下文调整。

**验证**

- 同一 MP3 被两份标注文件使用时只生成一个 run；
- 改 offset 不重新分析；
- 切换音轨能命中对应 run；
- 历史 run 的 manifest、asset checksum 和引用完整；
- 失败迁移可重跑且不误删对象。

**RA2a 实际完成**

- 真实生产模型可能按 annotation file 保存同一媒体的重复 run，无法安全地在一条 migration 中直接删旧列并加
  unique。RA2 因此拆为可部署的 RA2a 归并预备与 RA2b 运行路径切换。
- migration `20260824020000_media_analysis_supersession` 仅增加自关联 supersede 事实、执行者/时间、check/FK 和
  扫描索引；不自动选择 canonical，不改旧 unique/FK，不删除或改挂资产。
- 新增纯计划器，按媒体资源、来源 fingerprint、算法和 config hash 分组，稳定选择 canonical，并阻断 active job、
  config 漂移、资产/manifest/对象 checksum 错误及链/环/跨 identity 关系。输出 identity 仅保留 hash。
- 新增 super-admin-only CLI：dry-run 流式校验对象并生成计划 fingerprint；execute 先复核完整计划，再以 advisory
  lock 和 run/job 行锁重算数据库 fingerprint，全有或全无地写入 supersede 与脱敏审计。final 对象不可变，因此
  不在持锁事务中重复读取远程对象。
- 专项 7/7、分析 34/34、备份 28/28、完整 API 179/179 和完整 build 通过。本轮没有切换在线分析行为、UI 或
  前端缓存，也未部署或在任何生产数据库执行 CLI。

**RA2b1 实际完成**

- 审查发现旧 `sourceFingerprint` 含 `offsetSeconds`，RA2a 只能归并同偏移 run。新增 nullable
  `mediaFingerprint` 与纯 `createMediaAnalysisSourceFingerprint()`：uploaded 绑定资源/file/checksum/size，VOD
  绑定资源/region/videoId/duration，函数没有 annotation、mode 或 offset 参数。
- 迁移计划改用实时媒体内容 fingerprint 分组，execute 同时为未 superseded canonical 回填新字段；旧 source
  fingerprint 继续保留审计。缺 checksum/不完整 VOD 身份 fail closed。
- 不同旧 offset 的集成用例证明只形成一个 canonical；专项 10/10、分析 34/34、完整 API 182/182 与 build
  通过。在线旧 resolver 暂不切换，否则会让当前 annotation-scoped 查询丢失历史 run；RA2b2 将随查询/创建一起
  原子切换。

**RA2b2 实际完成**

- migration `20260824040000_media_scoped_analysis_runs` 在改约束前检查全部 active canonical 已回填媒体
  fingerprint、同一媒体 identity 无重复且没有 active superseded job；不满足即拒绝部署。旧 annotation/mode/
  offset 列改为 nullable 审计字段，annotation 删除改为 `SET NULL`，媒体外键继续是 run 的真实 cascade 归属；
  partial unique 只约束未 superseded canonical。
- 在线 status/create 改按 source media、媒体 fingerprint、算法和 config 查询；create 在媒体 identity advisory
  lock 内重读并复用跨标注文件的 succeeded/active run。offset 和当前 mode 只从请求标注上下文映射到 DTO，改变
  offset 不再创建 run；旧含 offset fingerprint helper 已删除。
- 旧 annotation route 暂时只充当 ACL adapter：每次资产读取均复核标注文件及其当前解析媒体的
  `read + download`，并只接受该媒体 fingerprint 下的 canonical succeeded run。切换来源后不能借旧 run/asset id
  继续读取，批量接口仍全有或全无且不泄露外部资产存在性。
- worker 的 claim 和 stale recovery 都排除 superseded run；首次发起 annotation 被删除只会清空 legacy 外键，
  不删除媒体级 run/asset。IndexedDB key 改为账号、媒体、run、asset、size；网络读取仍保留 annotation ACL
  上下文，旧缓存自然失效并由有界 LRU 清理。
- 专项迁移 10/10、媒体分析两段共 35/35、备份 28/28、完整 API 183/183 与完整 build 通过；自审扫描未发现旧
  annotation unique、含 offset fingerprint helper、在线 superseded 查询或 annotation-scoped cache key。没有 UI
  行为变化，未做浏览器验收、生产 CLI 或生产部署。
- 生产必须分两次 release：先部署 RA2a/b1 additive 版本并停止 worker，执行 dry-run、消除阻断、以精确 plan
  fingerprint 执行归并；确认成功后才能部署 RA2b2 migration。不得在一轮 `migrate deploy` 中绕过 CLI。

### RA3：组合播放器与快速音轨切换

**改动范围**

- 外部音频 backend；
- synchronized composite backend；
- 播放会话 API；
- `VideoPlayer` 生命周期接入；
- 顶部音轨选择器；
- generation、LRU 会话和同步测试。

**验证**

- VOD 视频在视频原声和上传 MP3 之间反复快速切换；
- VOD 视频在两条 VOD 音轨之间切换；
- 连续 A/B/C 选择只保留 C；
- 播放、暂停、seek、循环、倍速和后台恢复；
- 切换文件后没有残留声音、请求和 timer。

**RA3a 实际完成**

- shared 新增严格 `MediaAudioTrackPlaybackSession` 判别联合；上传会话仅返回稳定 file identity、MIME 和时长，
  VOD 会话返回短时 PlayAuth 与部署 License。客户端 parser 拒绝额外字段、坏身份、坏时间、空凭据和视频 MIME。
- 新增 `POST /api/annotation-files/:fileId/audio-tracks/:trackId/playback-session`，成功与失败响应均声明
  `Cache-Control: no-store`。每次请求重新验证活动标注文件、当前主媒体、音轨归属/启用状态、源音频类型，以及
  标注读权限、主媒体 `read + download`、源音频 `read + download`；撤回权限后旧 track id 不能继续签发。
- 主视频与外部 VOD 音频共用唯一 VOD session issuer，License 缺失时不会先请求 PlayAuth；供应商错误只保留
  有界类别和 requestId。旧 `ResourceService` 重复凭据组装已经删除。
- 统一播放合同增加 volume/mute 和可选 buffering 事件；原生 video、Aliplayer 和新 HTMLAudio backend 共用
  相同命令语义。VOD backend 可显式验证 `video | audio`，刷新凭据后保留倍率、音量、静音、时间与播放意图。
- 新平台来源适配器只保存 annotation/media/track 稳定身份；上传音频在实际 load 时用当前 access token 构造
  Range URL，VOD 在实际 load 时请求短时会话。URL、PlayAuth 不进入 ProjectData、草稿或持久 React 状态。
- `test:media-audio-tracks` 14/14、`test:media-playback` 22/22、音轨 API/issuer 4/4、完整 API 186/186 及完整
  build 通过。仅有既有 Web 主 chunk 体积提醒；本阶段无可见 UI，未做浏览器验收且未部署生产。

**RA3b1 实际完成**

- 新增 `SynchronizedMediaPlaybackRuntime` 并让它实现既有 `MediaPlaybackBackend`。主视频继续提供唯一快照；
  seek/play/pause/倍率/音量/静音通过一个 controller 进入主从序列，第二媒体元素不暴露给 App、Timeline、协作
  或文档状态。
- runtime 集中处理 source/command generation、正负偏移区间、100ms 漂移采样、中等漂移平滑调速/大漂移硬同步、
  从轨缓冲时暂停主视频及恢复重同步。切换中先静音主轨；RA3b2a 已将失败最终语义收敛为暂停静音并保持选择，
  只有显式切回原声才恢复主输出。迟到 ready/error/buffering 均不能复活旧来源。
- 新增外部 backend 工厂：uploaded 延迟取得受保护 URL 后创建 HTMLAudio；VOD 首份 no-store session 同时固定
  媒资身份并复用为首次 PlayAuth。调用方取消和 20 秒 ready 超时覆盖会话请求与播放器准备，失败统一销毁。
- `VideoPlayer` 已拥有离屏、不可交互且不进入键盘导航的 VOD audio host；主媒体重挂载会恢复当前选择意图，
  同一选择在 React effect 与 ready 事件间幂等，不重复申请会话或短暂回落原声。可选 prop 默认 `null`，App
  本轮不传入，因此现有编辑器声音和 UI 完全不变。
- 播放专项 37/37、音轨合同/策略 14/14、真实 PostgreSQL/Fastify 音轨 API 4/4、完整 API 186/186、完整 build
  和 `git diff --check` 通过；仅有既有 Web 主 chunk 体积提醒。无可见新流程，未伪造浏览器切轨验收、未部署。

**RA3b2a 实际完成**

- 新增严格 `AnnotationAudioPlaybackOptions`：最多 64 条、有序唯一、恰一条 original、同主媒体和有效默认引用；
  DTO 只含稳定关系与有限 availability，不含 URL、对象 key、PlayAuth、ACL 明细或供应商响应。
- 新增 annotation-context no-store 选项 API。列表与真实播放会话复用活动媒体、`read + download`、媒体类型和
  来源身份判断，但列表不签发 VOD 凭据；播放时仍由 RA3a 会话二次实时授权。
- 新增文件会话选择 hook 和顶栏紧凑 listbox。初始遵循共享默认，刷新保留当前选择；试听切换不写 ProjectData、
  revision、operation、草稿、协作或分析设置。只有显式星标操作写共享默认，原声映射为 null。
- 组合 runtime 增加 original/external/unavailable/blocked 选择合同。外部准备失败、撤权、来源失效或选项读取失败
  都暂停主视频并保持主声音静音；UI 保留目标、给出有限原因、刷新/重试及显式“视频原声”，不再静默换音源。
- 专项合同/状态 17/17、媒体播放 43/43、真实 PostgreSQL/Fastify 音轨 API 4/4、完整 API 186/186 和完整 build
  通过。浏览器确认本地编辑器不出现平台选择器且无 console warning/error；真实平台音轨验收未伪造、未部署。

**RA3b2b1 实际完成（2026-08-24）**

- 先对本机数据库和对象目录执行一致备份，再恢复到独立候选数据库与独立对象目录。候选库和本机默认开发库均
  按 additive migration、dry-run、精确 plan fingerprint execute、幂等复检、最终 migration 的顺序完成；默认
  开发库迁移期间启用维护、停止 worker/API 写入，完成后恢复服务并通过 readiness。此处不是生产服务器迁移。
- 迁移演练暴露并修复真实缺陷：manifest 的 `waveformLevels` 保存桶宽，数据库资产 `level` 保存数组序号，旧校验
  直接比较二者会把完整 succeeded run 误判为损坏。新集成 fixture 写入真实对象和两级波形资产，锁定归并保留
  run、asset 和 fingerprint 回填。迁移命令从临时 worktree 运行时还必须显式使用实际对象目录的绝对路径，不能
  让相对 `XIQU_STORAGE_ROOT` 随当前目录漂移。
- `AnnotationAudioPlaybackOptions` 新增严格 `canManageTracks`，只由当前账号对主媒体的有效 `write` 推导；它与
  标注文件写权限控制的共享默认音轨互不替代。快速选择器只增加一个低频设置入口，CRUD、精确上下重排、名称、
  类型、偏移、启用与删除确认集中在独立管理弹窗；删除只解除关系，不删除源媒体。
- 复用现有跨目录媒体选择器并增加 `audio-track-source` 模式，只允许稳定的纯音频 `MediaFile`。上传入口只接受
  `audio/*`；VOD 媒资类型由 `GetPlayInfo.VideoBase.MediaType` 规范化，视频即使存在 MP3 转码也仍是视频，不能
  被持久音轨关系误收。临时 URL、PlayAuth 和供应商原始响应没有进入 DTO、数据库或日志。
- 使用真实上传 WAV 经普通 API 建立外部音轨，列表返回 available，播放会话返回 uploaded/file identity，受保护
  内容端点的字节 Range 返回 206、正确 MIME 和 `Accept-Ranges`。未登录浏览器与本地工具路径渲染正常且控制台
  无异常；登录后的弹窗视觉、真实切换声音及 detached window 尚未冒充为已验收。
- 专项音轨合同/状态/来源策略 16/16、真实音轨 API 4/4、迁移 10/10、完整 API 187/187、Web 与完整 build 均通过；
  仅保留既有 Web chunk 体积提醒和测试环境 `pg` deprecation warning。

**RA3b2b2a 实际完成（2026-08-24）**

- 依据阿里云官方 `GetPlayInfo` 合同与仓库锁定 SDK，使用 `PlayInfo.JobId` 作为媒体流稳定身份。新增 additive
  migration，把 original、独立音频 MediaFile、VOD rendition 收敛为数据库三种互斥来源；partial unique 防止
  同主媒体重复关联同一 VOD/JobId。临时 URL、PlayAuth、License 和原始 provider response 均不持久化。
- gateway 只接受状态 Normal、StreamType=audio、format=mp3、HTTPS 且 JobId 完整的候选；重复 JobId 整体拒绝。
  候选 API 只返回 JobId 与 definition/bitrate/duration 等有限事实。创建前先验证主媒体 write，再按来源
  `read + download` 查询供应商，事务锁内重验 ACL/活动状态并保存服务端权威元数据。
- 播放会话每次复核 annotation、主媒体、来源 VOD、track enabled 与 JobId，重新签发指定 JobId 的 HTTPS source；
  Aliplayer 直接音频模式沿用同一 generation/刷新/dispose 生命周期，刷新后 JobId 漂移或流消失会失败静音，不会
  自动换流或回原声。HTTP IP 页面只加载 HTTPS 媒体，未来 HTTPS 域名不会形成 mixed content。
- 音轨管理器保留平台音频资源入口，并为 VOD 主视频新增独立 rendition 选择器；它不把转码伪装成资源树文件，
  不允许手填 URL/JobId。自审修正了嵌套弹窗遮罩层级和可选错误行导致的网格错位，并补齐 radiogroup 语义。
- 本机 public 数据库在 API 停止状态下先做一致备份并独立校验，随后成功应用第 26 条 migration，重启源码 API
  后 readiness 与 storage/database 均正常。真实《寻梦》VOD 返回 1 条 SQ MP3，JobId 精确重签、HTTPS 与约
  895 秒有效期均通过；文档只记录 JobId hash 和有限元数据，没有记录临时地址或凭据。
- 专项合同 7/7 + 状态/策略 16/16、播放 47/47、VOD gateway 9/9、音轨 API 4/4、完整 API 189/189 和完整
  build 通过。首次完整 API 回归曾出现一次递归复制 500；临时启用测试日志后单套 38/38、恢复日志配置后全套
  189/189，未能复现且最终未留下诊断开关。仅有既有 chunk 提醒与测试环境 `pg` deprecation warning。

**RA3b2b2b1 实际完成（2026-08-24）：VOD 会话取消生命周期**

- 登录门禁等待期间审查慢网路径，确认 external factory 在首份会话 ready 后，后续 refresh 仍捕获首次准备的
  `preparationAbortController.signal`。组合 runtime 切轨虽然会 dispose backend 并用 generation 隔离迟到结果，
  但无法中止已发出的刷新 HTTP 请求；主 VOD 的 session API 也没有 signal 参数，存在同类资源浪费。
- `AliyunVodPlaybackBackend` 现在为每次初始/刷新会话请求创建并持有 AbortController 集合；`dispose()` 先中止
  全部在途请求，再销毁 player。external factory 只让准备 signal 管首份请求，安装后的刷新改用 backend signal；
  主 VOD source、PlatformClient 和 App 同样透传 signal。没有改变 generation、刷新单飞、失败保留旧实例、主时钟
  或音轨选择策略。
- 新测试证明 refresh signal 贯通来源，backend 销毁会令在途请求 `aborted=true`；播放器专项由 47/47 增至
  48/48，完整 Prisma/shared/document-model/Web/API build 通过，`git diff --check` 通过。只保留既有 Vite chunk
  提醒；无新依赖、debug 输出、第二媒体 owner 或遗留无调用分支。

**RA3b2b2b2 自动与登录冒烟完成，完整听觉门禁延期（2026-08-26）**

- 2026-08-26 在文档收口提交 `990ea24` 后重新验证当前源码基线：音轨合同/状态 `7/7 + 16/16`、播放器
  `48/48`、VOD gateway `9/9`、真实 PostgreSQL 音轨 API `4/4`、完整 API `189/189` 和完整
  Prisma/shared/document-model/Web/API build 均通过。静态回查没有发现生产代码直接调用
  `crypto.randomUUID()`、HTTP 临时媒体地址、debug console、第二媒体 owner 或凭据持久化；仅保留既有 Vite
  主 chunk 提醒和测试环境 `pg` deprecation warning。
- 自动门禁后最初只在 `127.0.0.1:5173` 检查了登录壳；用户随后明确当前 Web License 只登记 `localhost`，
  因而该地址不能作为 VOD 证据。现已改用 `http://localhost:5173/` 重新打开，页面仍停在登录表单且没有可接管
  会话。本轮没有代填密码，也没有把 API/纯测试结果写成声音证据；下面的 UI、A/B/C、Safari、HTTP IP 与
  听觉清单仍是 RA3b2b2b2 的硬门禁。
- 用户随后在 Chrome 完成登录。Agent 使用 Web License 登记的 `http://localhost:5173/` 进入示例项目，确认
  `新工尺_央视_顾卫英《寻梦》.merged.cleaned.json` 已关联 VOD，编辑器成功取得约 24:54 时长、显示“视频原声”
  和“实时已连接 · 可编辑 · 已同步 · 服务器 v122”。这些是登录与主 VOD 冒烟证据，不等同于多音轨听觉通过。
- Chrome 扩展控制在展开监听音轨菜单时反复断开；Chrome 进程、扩展启用状态和 native host manifest 的只读
  检查均正常，因此没有把控制通道问题猜测成播放器缺陷，也没有为迎合清单修改代码。
- 用户明确要求跳过本次验证并继续工作。原声、uploaded、独立 VOD audio、同 VID rendition 的 A/B/C 快切、
  Safari、临时 HTTP IP、正负 offset、撤权、续签、慢网和 detached window 仍登记为延期人工验收，不得在 RA4
  或 RA5 文档中倒填为已通过。

### RA4：分析显示跟随与渐进缓存复用

**RA4a 音轨级分析身份与服务端读取合同已完成（2026-08-26）**

- `MediaAnalysisRun` additive 增加有界 nullable `sourceVodRenditionJobId`。同一 VOD 的 original 与指定 JobId
  rendition 使用不同 fingerprint，不同 JobId 互相隔离；音轨名称、排序、definition、bitrate、临时 URL 和
  offset 均不进入内容 identity。
- status/create/list/single/batch 继续保留 annotation route 作为当前 ACL 上下文，但新请求携带稳定
  `audioTrackId`。服务端只接受属于当前主媒体且 enabled 的关系，并逐次复核标注、主媒体和真实来源；删除、
  禁用、归档或撤权后不会暴露旧 run/assets，也不会静默退回 legacy 设置。
- worker 对普通 VOD 继续使用既有自动纯音频入口；rendition run 则精确调用保存的 JobId，并拒绝供应商返回
  不同 JobId。临时 HTTPS URL 仍只存在于 worker 调用栈。
- 旧 `AnnotationAnalysisAudioSetting` 与不带 track id 的 API 暂时保持兼容，前端 hook 仍走旧路径；该兼容只为
  RA4b/RA4c 平滑切换，不允许长期双写或在新路径失败时兜底。
- 真实 PostgreSQL 音轨 API 4/4、媒体分析 37/37、完整 API 192/192、完整 Prisma/shared/document-model/Web/API
  build 和 `git diff --check` 通过。新增 migration 已在隔离测试 schema 应用；尚未迁移本机 public 或生产库，
  也未部署。本阶段是服务端基础，没有伪造浏览器分析切换证据。

**RA4b 分析显示跟随、固定与前端代际切换已完成（2026-08-26）**

- 新增会话级纯策略和 React adapter。每个文件/主媒体会话从“跟随监听音轨”开始；关闭跟随会冻结当时的监听
  身份，固定后试听切换不改变分析显示。固定项被删除、禁用或撤权时保留失效身份，不静默回退原声。
- `usePlatformMediaAnalysis` 的 status/create/list/batch/相邻预取/全量预加载统一携带当前 `audioTrackId`，并严格
  校验服务端 status 身份。文件或音轨变化会推进 generation、取消旧批次与预加载、清理旧 status/timed data；
  被代际丢弃的请求无法在 finally 释放 loading，因此切换边界会同步复位对应运行状态。
- 同一 canonical run 可跨音轨复用 IndexedDB 瓦片字节，但内存显示 session key 额外绑定音轨 ID 和当前 offset，
  确保关系偏移变化会重新装配到项目时间轴。只有当前音轨已成功且通过 annotation+track ACL 状态复核后才读取
  缓存和资产。
- 设置面板改为“分析显示音轨”，保留开始/重新分析与主动预加载；旧“选择分析音频/恢复自动”弹窗、App state、
  hook mutation 与资源选择器死分支已删除。legacy route/client/DTO/schema 暂留且已无新前端调用，RA4c 统一迁移
  和删除。
- 音轨专项 shared 7/7、前端状态 20/20，媒体分析 shared batch 3/3、API/前端 38/38，音轨 API 4/4、完整 API
  192/192、完整 build、TypeScript 和 `git diff --check` 通过。没有新增依赖；未迁移本机 public/生产数据库，未
  部署，也按用户要求跳过浏览器与听觉验收，RA3 延期清单继续保留。

**RA4c1 旧分析音频设置迁移工具与删除门禁已完成（2026-08-26）**

- 新增纯计划器、bounded Prisma fact reader、super-admin-only service 和
  `analysis-audio-settings:migrate dry-run/execute` CLI。计划按稳定 ID 排序并绑定全部 setting、资源活动性、
  来源类型、offset、现有音轨结构/启用状态和容量事实；execute 在 advisory/resource-tree/table/ordered media
  locks 下重算 fingerprint，任何变化或阻断都全量回滚。
- `auto` 不新增关系；主媒体自身的零偏移覆盖复用 original；active 纯音频覆盖按
  `primaryMediaResourceId + audioMediaResourceId` 幂等复用或创建末尾 `reference` 轨。迁移不会修改
  AnnotationAudioPreference，也不会把旧 updater 冒充本次 creator。
- 没有稳定 rendition JobId 的 VOD video override、同源不同 offset、已有关系 offset 不同/disabled、inactive
  annotation/media/ancestor、非法 setting/轨道结构和容量溢出均输出有限 block code。plan/CLI 不包含资源名、
  路径、媒体 URL、PlayAuth、AccessKey、Secret 或 ORM 原始行；任一 blocked item 存在时不允许部分迁移。
- additive migration 28 只新增 `analysis_audio_setting_migration_apply` 审计枚举；旧 table/route/DTO/resolver
  继续只为 RA4c2 删除前迁移存在。专项 8/8、音轨 API 4/4、媒体分析 38/38、完整 API 200/200 和完整 build
  通过；只有既有 Vite chunk 与测试 `pg` warning。
- 第 28 条仅在隔离 `api_test` 应用；本机 public 和生产仍未应用第 27/28 条、未执行真实 dry-run/execute、未
  部署。本阶段无 UI，按用户要求未做浏览器/听觉验证，RA3 延期验收债务不变。

**RA4c2 旧合同与 schema 删除代码已完成（2026-08-26）**

- shared status 不再返回旧 setting/source mode，`audioTrackId` 改为非空；status/create/list/single/batch 的
  client、router 和 service 全部强制稳定音轨 ID。服务端只保留一个音轨来源 resolver，每次重读主媒体、启用
  关系、真实来源、offset 与 `read + download`，缺失、foreign、disabled 或撤权不会回退旧 setting。
- `MediaAnalysisRun` 删除 annotation file、source mode 和持久化 offset；canonical identity、worker、asset 与对象
  生命周期继续只归属于媒体。公开 run DTO 仍从当前音轨关系投影 `sourceOffsetSeconds`，因此共享同一 run 的
  不同 offset 音轨仍会在项目时间轴按各自偏移装配。
- Prisma 删除旧 enum/model/relation，RA4c1 CLI/plan/service/tests/package script 随最终 schema 一并清理；历史
  migration 与两种 audit action 保留。migration 29 在删除前二次检查主媒体 original、override 的纯音频类型、
  同源同 offset 启用关系，以及 annotation/媒体完整祖先链的 active/无环状态，任何不一致都会拒绝整个迁移。
- 独立 PostgreSQL migration 测试证明未映射 override 会原子拒绝且旧表保留，补齐关系后才删除旧表、run 列和
  enum。音轨合同 `7/7 + 20/20`、音轨 API 4/4、媒体分析 38/38、平台综合 38/38、完整 API 193/193、完整 build
  与 `git diff --check` 通过；只有既有 Vite chunk 和测试 `pg` warning。
- **未执行**：本机 public 和生产尚未应用第 27/28 条，也未运行 RA4c1 CLI 或 migration 29；本阶段没有部署，
  用户要求跳过浏览器/听觉验证。生产必须先运行 commit `d615add` 的 additive 工具至零阻断、零待创建，再部署
  destructive release。RA3 延期验收继续保留，不能把自动测试写成真实声音证据。

**改动范围**

- 音轨维度的 `usePlatformMediaAnalysis`；
- 当前分析音轨对 RA2 既有媒体级缓存与请求会话的驱动；
- 跟随监听/固定分析音轨状态；
- 未分析状态与发起分析入口；
- 旧频谱音频选择 UI 清理。

**验证**

- 已分析音轨切换后快速显示缓存波形；
- 未分析音轨不显示上一轨数据；
- 固定分析音轨时试听切换不改变频谱；
- 10 秒历史瓦片和当前渐进加载保持兼容；
- 快速切换不会积累无效批量请求。

### RA5：偏移校准、缓冲和长时鲁棒性

#### RA5a：毫秒级偏移校准（已完成，2026-08-26）

**已完成**

- 在既有音轨管理器中增加 `-10 ms`、`-1 ms`、归零、`+1 ms`、`+10 ms` 校准控件，不建立第二个设置面板；
- API/数据库继续以秒为权威单位，步进内部使用整数毫秒，手工输入继续接受有效小数秒；
- 正值统一表示音频相对视频延后，负值表示提前，原声音轨继续只读且固定为零；
- 创建和编辑音轨共用解析、格式化、边界与步进 helper，保存成功后继续权威重读音轨列表；
- 未改动视频主时钟、漂移阈值、缓冲恢复、分析 offset 投影和同步 runtime。

**验证结果**

- 纯逻辑覆盖正负边界、非法输入、连续 300 次 1 ms 步进、越界 fail closed 和提前/延后摘要；
- 音轨 shared/frontend 专项、音轨 API、媒体分析、完整构建及 `git diff --check` 通过；
- 用户明确跳过本轮浏览器验证，因此真实听觉校准仍保留到 RA6 验收，不以自动测试替代。

#### RA5b：漂移、缓冲诊断与受控恢复（已完成，2026-08-26）

**已完成**

- 当时版本保留 40/150 ms、同向 2 样本和 300 ms 采样合同；该历史实现已由下方 2026-08-28 真实播放补强取代；
- 只在硬同步和缓冲恢复边界发出封闭事件，测量值取整并钳制，不携带资源身份、URL、凭据或 provider 错误；
- VideoPlayer 只转发最近一条会话诊断，文件/媒体/音轨 generation 变化立即清除，正常采样不触发 React 更新；
- buffering 使用可测试单调时钟，重复 true 只记录一次；暂停、切轨、卸载、失败和销毁清除未完成观察；
- seek 等待期间用户暂停后，迟到硬同步/缓冲恢复静默退出，不报非法状态，也不重新播放。

**验证结果**

- 播放专项 54/54，覆盖中等漂移确认、硬同步单飞、缓冲重复事件、确定性时长、失败、observer 抛错和迟到暂停；
- 音轨 shared/frontend 7/7 + 23/23、媒体分析 38/38、完整 build 与静态检查通过；
- 用户要求跳过浏览器验证，因此 UI、真实慢网与听觉证据保留到 RA5c/RA6。

**2026-08-28 真实播放补强**

- 使用平台实际 1494 秒 MP4 与用户上传的 189 秒 MP3，从 73.417 秒开始运行真实组合 runtime。旧策略每约
  600ms 产生一次 50-70ms 中等漂移硬 seek，并把受控 seek 的 `waiting` 再误判为缓冲，造成周期停顿和重复 seek。
- 10-150ms 改为最大 ±4% 的从音轨速率伺服；受控 seek 的 `waiting` 与真实饥饿分离，`stalled` 继续只作传输提示。
  修复后同一探针连续播放没有 `waiting`、buffering 或硬 seek，倍率自动回到 1.0，10ms 目标附近平滑收敛。
- 统一音频来源选择器在用户选择 VOD 容器后继续“VOD 媒资 -> MP3 rendition”步骤；阿里云将上传 MP3 判为
  video 时不伪造 mediaKind，而是读取其真实 JobId 并沿既有 rendition 会话播放。

#### RA5c：长时播放、续签与系统生命周期

##### RA5c1：主媒体生命周期与不同长度音轨（已完成，2026-08-26）

**已完成**

- 原生 controls、Aliplayer controls 和自然 ended 统一进入 runtime 的主媒体播放事实入口；
- runtime 自身命令产生的同步事件幂等，buffering 内部暂停保留 playing 意图，用户暂停/结束停止外轨与采样；
- 错误态直接操作主视频会安全暂停，并把最终 false 返回 VideoPlayer，避免嵌套事件把 UI 写回播放中；
- 外部音轨区域观察只在 before-start/playable/after-end/invalid 变化时动作，短音轨结束后不重复 pause；
- 主时钟 seek 回可播区仍通过权威 alignment 恢复，主视频结束则清理 drift interval。

**验证结果**

- 播放专项 58/58，覆盖 controls、命令事件重入、错误态、自然结束、短音轨边界和返回可播区；
- 音轨 7/7+23/23、分析 38/38、完整 build 与静态检查通过；浏览器验收按用户要求跳过。

##### RA5c2：VOD 续签、网络/页面恢复与长时门禁（代码已完成，2026-08-26）

**已完成**

- VOD 后台续签失败不提前销毁仍可用旧实例，按 `5s -> 15s -> 30s -> 60s` 退避并在最后一级持续重试；
- 播放器 error 先进入 buffering，再按 `1s -> 3s -> 10s -> 30s` 有限预算单飞刷新，预算耗尽后只发一次致命错误；
- 正常续签、后台 retry 和播放器恢复共用一个 scheduler owner 与一个 refresh single-flight，dispose 同时取消
  timer 并 abort 会话请求；
- online、pageshow 和页面重新可见触发同一恢复入口，主从 backend 恢复后按视频主时钟重新核对；
- 恢复任务冻结 command/source/session generation，期间后发 pause/play/seek、切轨、切文件或销毁始终获胜；
- portal 分离预览监听播放器真实 `ownerDocument/defaultView`，不误绑主窗口；普通生命周期事件兼容 HTTP IP
  与未来 HTTPS 域名。

**自动验证**

- 播放专项 68/68，覆盖后台失败保留旧实例、在线立即恢复、单飞、播放器恢复成功、预算耗尽、销毁取消、
  lifecycle listener 清理、主从恢复、恢复期间暂停和切轨；
- 音轨 7/7+23/23、媒体分析 38/38、完整 build 与 `git diff --check` 通过；
- 用户明确跳过本轮浏览器验证，因此 30 分钟连续播放、真实慢网/断网/休眠、Chrome/Safari、HTTP IP/HTTPS
  与听觉同步证据仍作为 RA6 验收债务，不能由确定性测试替代。

##### RA5c3：随机 VOD 起播、JobId MP3 原生接管与主线程收口（代码已完成，2026-08-29）

**真实问题与实现**

- 《寻梦》VOD 与 `Johann_Sebastian_Bach · SQ` 的真实联合播放证明，play Promise 不能代表随机位置的 VOD
  主时钟已推进；所有从轨起播入口现已共用可取消的主时钟推进门禁。
- 隐藏 Aliplayer 播放服务端已经确认的 HTTPS MP3 rendition 会在 seek 后冷停约 300ms。指定 JobId 的 MP3
  改为可续签原生 audio；普通 vid + PlayAuth VOD 继续使用 Aliplayer，两类来源不再共享错误 backend。
- 原生续签候选在旧音频仍可用时静音准备，严格校验稳定身份后按最新时刻、倍率、音量和播放状态原子接管；
  请求、metadata 等待和迟到事件都可取消，临时 URL 不进入持久状态或日志。
- 初始元素和续签候选共用同一媒体事件转发边界；候选接管前的错误只终止准备，接管后的
  `timeupdate/buffering/error` 继续进入组合 runtime，避免形成能发声却失去时钟反馈的僵尸播放器。
- 150ms 起播缓冲保留收窄到 Aliplayer。原生上传/转码音频按 1ms 起播边界定位，稳定段继续以 10ms 目标和
  有界倍率伺服维护；Aliplayer 的旧 rendition 分支已删除。
- 当前源码复验还定位到 JobId MP3 的硬 seek 自激：首次解码约 200ms 滞后触发 seek，seek 又制造下一次滞后。
  起播或权威硬同步完成后的 6 秒内保持 10ms 目标与 ±4% 上限，只将硬同步门槛临时提高到 500ms；意外暂停和
  更大漂移仍硬同步，窗口结束后恢复共享 150ms 门槛。
- Timeline 分析可视范围的父级 callback 改为稳定身份，修复暂停态也持续发生的 React 最大更新深度循环，
  防止主线程渲染风暴干扰媒体时钟和浏览器验收。

**验证**

- 播放专项 85/85，音轨 shared 7/7 + frontend 27/27，完整 shared/document-model/Web/API build 和静态检查通过。
- 登录 localhost 的真实标注文件从 84.3 秒随机起播，30 个连续样本中主从均保持 playing/ready，没有旧的
  pause/play 或 readyState 1/4 循环；稳定段漂移约 0–10ms。Timeline 修复后 5 秒观察没有新增最大深度错误。
- 完整重载当前源码后从 32.2 秒再次随机起播，36 个样本全程 playing/readyState=4 且没有硬 seek；初始
  185–195ms 滞后连续收敛，约 5 秒后恢复 1x，稳定误差为 1–6ms。
- Safari、生产 HTTP IP/HTTPS、慢网、30 分钟和真实凭据到期续签仍保留为环境验收债务。

##### RA5c4：JobId MP3 暂停预热与主从同步起播（已完成，2026-08-29）

**实现**

- 将暂停态远端音频预热统一到组合播放 runtime：普通 VOD 音频和 JobId MP3 均执行“静音播放至真实时钟
  推进 -> 暂停 -> 精确回到目标”，上传音频继续走原有轻量路径。
- 只有来源、代次、暂停状态和预热位置全部匹配时，JobId MP3 才进入同步起播屏障。命令式播放在同一异步
  阶段启动主视频与外轨；原生或 Aliplayer 控件已经启动视频时只补启外轨。两个时钟都真实推进后才恢复用户
  静音设置，并立即执行首个漂移样本。
- 播放中的随机 seek 对 JobId MP3 采用“冻结主从 -> 主视频跳转 -> 外轨对齐和预热 -> 并发恢复”。内部暂停
  不改写用户播放意图，同一命令代次只消费对应 pause 事件并继续向 React 回报逻辑播放态；否则暂停态时间
  同步会用旧 currentTime 覆盖目标。后发 pause、seek、切轨和销毁仍优先。
- 前置条件不满足时回退既有主时钟门禁，没有新增第二个播放器 owner、播放状态机或临时 URL 持久层。6 秒
  稳定窗口仍作为极端浏览器冷停保护，而不再承担正常起步对齐。

**验证**

- 播放专项 89/89；新增覆盖静音预热回位、主从并发起播、不追加冷启动 seek、播放中随机 seek、后发暂停
  获胜、内部暂停维持逻辑播放态和主视频原生控件入口。音轨 shared 7/7 + frontend 27/27，完整
  shared/document-model/Web/API build 与
  `git diff --check` 通过。
- 已登录 localhost 真实编辑器中，`Johann_Sebastian_Bach · SQ` 在 55.351 秒选择后完成双媒体
  `readyState=4` 且精确回位；随机跳转到 60.300 秒后再次保持主从 60.300 秒。播放观察点主视频 71.378 秒、
  外轨 71.411 秒，偏差约 33ms 且由既有 0.96x 有界伺服继续收敛，明显低于上一轮 185-195ms 起步基线；
  浏览器控制通道不适合作为 10ms 级高频测量仪，因此不把该单点写成稳态精度证明。
- 生产 HTTP IP、未来 HTTPS、Safari、慢网、30 分钟长播和真实凭据到期续签仍是环境验收债务；本轮不自动
  部署生产。

### RA6：迁移收口与旧逻辑删除

**改动范围**

- 在候选恢复库执行 RA4c1 -> RA4c2 两版本迁移演练并保存有限报告；
- 生产依次部署 additive 工具 release 与 destructive release，核对旧表/字段确实不存在；
- 更新 AGENTS、部署、备份、恢复和 Development Log；
- 完整回归、压力和浏览器验收。

**验证**

- `rg` 确认旧接口和旧字段无运行调用；
- Prisma、shared、API、frontend 全量构建；
- 数据库恢复后媒体、音轨、run 和 assets 引用完整；
- 服务器迁移不会把本机实验数据带入生产。

#### RA6a：候选恢复演练与 additive 生产迁移（已完成，2026-08-26）

**实际执行**

- 生产升级前创建并验证一致备份，22576 个对象 warning/missing/orphan 均为 0；同一备份恢复到独立候选数据库
  和独立对象目录，数据库、migration history、运行状态、对象大小与 SHA-256 全部门禁通过。
- 生产库从旧 schema 推进到 24-03 后，24-04 按设计因 canonical run 缺少 media fingerprint 而失败；失败
  migration 通过 Prisma `migrate resolve --rolled-back` 正式登记回滚，事务内 schema 没有残留，也没有手改
  `_prisma_migrations`。
- 真实生产升级由原计划的两段细化为三段 release：`85828ee`/修复提交 `5cd4556` 负责 24-03 schema 的 RA2
  历史 run 迁移，`d615add` 负责 24-04 至 26-02 与 RA4c1 设置迁移，当前最终 release 留给 RA6b migration 29。
  最终 Prisma Client 不能越过中间 schema 直接运行历史 CLI。
- RA2 dry-run 最初把 19 个完整 run 误报为 `asset_validation_failed`。根因是 manifest `waveformLevels` 保存
  bucket width，而资产 `level` 保存数组序号；历史工具修复后仍保留精确资产集合、对象大小和 SHA-256 校验。
  独立 24-migration schema 的专项测试 10/10、完整 build/release check 通过。
- 修复版生产 dry-run 为 19 runs、13 actionable groups、2 duplicate groups、0 blocked；同 fingerprint execute
  标记 6 个 duplicate run，并完成 canonical media fingerprint 回填。幂等复跑为 0 duplicate、0 actionable、
  0 blocked。随后 24-04、24-05、26-01、26-02 全部成功应用。
- 唯一 legacy analysis setting 是主媒体自身零偏移覆盖，已精确复用 original 音轨，不需要创建 reference 音轨。
  RA4c1 最终报告为 `blockedCount=0 + createTrackCount=0 + reuseCount=1`；零创建路径按合同只完成锁内重验，
  `applied=false` 且不制造重复迁移审计。
- 当前生产停在 28 条 migration，destructive migration 29 尚未部署；API 已真实重启到 `d615add`，Web、
  liveness、readiness 通过，maintenance 保持开启，analysis worker 保持停止。用户要求跳过本轮浏览器验收，
  因而未把自动门禁写成真实听觉证据。

#### RA6b：destructive release、服务恢复与专项收口（已完成，2026-08-26）

- 当前提交 `25fe616` 通过音轨 `7/7 + 23/23`、音轨 API 4/4、媒体分析 38/38、完整 API 193/193、部署
  `12/12 + 16/16`、完整 build 和 release check。完整 API 包含 migration 29 的 PostgreSQL 原子拒绝/成功用例。
- destructive 前只读重验为 28 migrations、84 资源、38 标注、19 媒体/音轨/run、22575 assets、1 FileObject、
  22576 objects，且 active job/presence/lease 均为 0；唯一 legacy setting 精确复用 enabled original。
- 服务器从同一 commit 和 SHA-256 归档重新构建不可变 release
  `/opt/xiqu/releases/20260826T075340Z-25fe616`，核对恰好 29 条 migration，运行包不含 `.env`、`data/` 或教程。
- 旧 API/worker 均停止后原子切换 release，migration 29 一次成功。旧 setting 表、`AnalysisAudioMode` 和 run 的
  annotation/mode/offset 三列已删除；全部业务计数与对象数保持不变，migration 记录 finished 且未 rolled back。
- final API 新进程、最终 Web asset、liveness/readiness 和 worker 均通过，journal 未发现 schema/Prisma 启动
  错误；`platform.admin` 已解除维护，最终状态为 API/worker active、maintenance disabled。
- 生产运行源码静态扫描确认没有旧 setting model、route/client/DTO、optional track-id fallback 或历史 run 持久写入。
  旧 migration SQL、audit action/展示名和 Development Log 作为历史兼容证据保留，不属于僵尸运行逻辑。
- 用户明确跳过浏览器人工验证。真实慢网、休眠、30 分钟、Safari、HTTP IP/HTTPS、撤权和听觉同步继续作为
  显式验收债务；自动测试与生产 health 不能替代这些证据，但 RA0-RA6 的代码和生产数据迁移已经收口。

## 13. 测试矩阵

### 13.1 纯逻辑测试

- 音轨 offset 与项目时间换算；
- generation 和最后选择优先；
- 播放状态机的合法转换；
- 漂移阈值和缓冲恢复；
- 分析 run 复用键；
- 迁移分组、候选选择和冲突报告。

### 13.2 API 与数据库测试

- 音轨 CRUD、重排、默认值；
- 主媒体与音轨关系约束；
- 上传/VOD 音频来源解析；
- ACL 继承、撤销、删除和回收站；
- 媒体级 run 的并发去重；
- 备份、恢复、迁移 dry-run 和幂等执行；
- Range、no-store 和临时会话续签。

### 13.3 浏览器验收

- `视频原声 <-> 上传 MP3` 快速切换；
- `视频原声 <-> VOD 音频` 快速切换；
- `上传 MP3 <-> VOD 音频` 快速切换；
- 播放中、暂停中和拖动中切换；
- 0.5x/1x/1.5x/2x；
- 循环播放和连续跨区 seek；
- 未分析、分析中、已分析和分析失败音轨；
- 分析显示跟随与固定；
- 网络限速、断网恢复、会话过期；
- 返回资源管理器再打开，默认音轨正确；
- 多账号同时编辑时，各自试听选择互不干扰。

### 13.4 回归范围

- 时间轴块创建、拖动、吸附和分支轨布局；
- 本地媒体完整分析；
- 平台后台分析 worker；
- 自动保存、原子命令、冲突恢复和实时协作；
- VOD Web License、PlayAuth 和 HTTPS/HTTP 来源；
- 资源下载、复制、移动、删除、回收站和权限管理。

## 14. HTTP、HTTPS 与安全边界

临时无域名 HTTP IP 仍需使用一段时间，因此实现不得无意依赖：

- `crypto.randomUUID()`；
- File System Access；
- service worker；
- 其他只在安全上下文开放的 API。

运行时 ID 继续使用 `src/utils/runtimeUuid.ts`。媒体播放使用标准 `<video>`、`<audio>`、Range 和现有 Aliplayer，理论上可在 HTTP IP 工作，但必须实测供应商 CORS 和 URL 鉴权。

未来 HTTPS 域名部署时：

- 所有媒体和 VOD 临时地址必须是 HTTPS；
- WebSocket 自动使用 `wss://`；
- VOD Web License 配置正确域名；
- 禁止混合内容；
- 会话 DTO、AccessKey、Secret、PlayAuth、签名 URL 继续禁止持久化和日志输出。

## 15. 部署、备份与回滚

- 旧生产库的本次 schema 迁移实际分三段 release：24-03 历史 RA2 工具、`d615add` RA4c1 additive、最终
  destructive release。每一段必须使用与当时 schema 匹配的 Prisma Client；全新空库仍可直接应用完整链。
- 不长期双写；双写仅用于有明确截止条件的迁移窗口。
- 每次生产迁移前进入维护模式，备份 PostgreSQL 和对象 manifest。
- run 去重和对象清理分离：先发布新引用，再引用检查，最后补偿删除。
- 旧前端默认原声，新后端在未设置偏好时也必须返回原声，保证阶段间可回滚。
- 跨服务器迁移必须包含数据库、上传媒体对象、分析 assets 和 manifest；VOD 只迁移稳定 ID/region，不迁移临时凭证。
- 迁移 CLI 必须提供 `--dry-run`、结果清单、校验失败退出码和幂等重跑。

## 16. 主要风险

| 风险 | 后果 | 处理 |
| --- | --- | --- |
| 继续按标注文件保存分析 run | 重复计算、切换慢 | RA2 改为媒体级归属 |
| 音轨偏移写入 run | 改偏移触发重算 | 偏移只属于音轨关联 |
| 快速切换的旧响应复活 | 播放错误音轨 | generation + 最后意图优先 |
| 两个媒体同时出声 | 严重干扰标注 | 切换先静音，确认新轨后启动 |
| 外部音频时钟轻微漂移 | 频繁硬 seek 造成周期停顿 | 10-150ms 使用有界从轨速率伺服，超过 150ms 才硬同步 |
| 外部音频真实缓冲 | 画面继续而声音落后 | 未受控 `waiting` 时暂停主视频，恢复后权威重同步 |
| 无权限时静默回退 | 用户误判音源 | 明确错误，主动切回原声 |
| VOD 临时会话过期 | 长时标注中断 | no-store 会话、按需续签 |
| 历史 run 直接去重误删对象 | 分析资产丢失 | manifest/checksum 校验、引用检查、补偿清理 |
| 两个标注文件对同音频偏移不同 | 迁移歧义 | dry-run 报告，不盲目合并 |
| 为快速切换下载完整音频 | 首屏慢、占带宽 | Range、小范围预缓冲、有界 LRU |

## 17. 验收标准

- [ ] 一个视频可关联视频原声、上传 MP3 和阿里云 VOD 音频。
- [ ] 编辑器中可以一到两次点击快速切换已关联音轨。
- [ ] 切换不重新进入编辑器，不修改标注 revision，不触发结构租约。
- [ ] 播放中切换不会双声、跳错时间或复活旧音轨。
- [ ] 视频始终是主时钟，音轨正确跟随 seek、循环和倍速。
- [ ] 每个媒体资源的分析结果只按内容与算法配置保存一次。
- [ ] 同一音轨被多份标注文件使用时能够复用同一 run/assets。
- [ ] 改变音轨偏移不会重新分析。
- [ ] 切换到已分析音轨时复用内存/IndexedDB 缓存渐进显示。
- [ ] 切换到未分析音轨时不残留上一条音轨的波形频谱。
- [ ] 用户可以选择分析显示跟随监听，或固定另一条音轨。
- [ ] 上传音频与 VOD 音频均不需要完整下载后才能开始播放。
- [ ] 权限撤销、资源删除、网络中断和凭证过期均有明确且可恢复的状态。
- [ ] 旧分析数据经过可审计、可回滚、可重跑的迁移。
- [ ] 旧表、旧 route、重复 DTO、旧 UI 和无调用测试在迁移收口后删除。
- [ ] HTTP IP 与未来 HTTPS 域名均通过真实浏览器验收。
- [ ] 日志、数据库、ProjectData 和草稿中没有临时 URL、PlayAuth 或凭据。

## 18. 推荐推进顺序

严格按 `RA0 -> RA1 -> RA2 -> RA3 -> RA4 -> RA5 -> RA6` 推进，每个阶段依据真实代码和测试结果重写 `CLAUDE_WORK.md` 后再实施。

优先级不能倒置：

1. 先冻结媒体级分析和音轨关系的数据归属。
2. 再迁移分析 run，证明同一音轨可以跨标注文件复用。
3. 再实现组合播放器和顶部快速切换。
4. 然后接通分析显示切换、偏移和长时同步。
5. 最后删除旧设置和兼容逻辑。

每阶段完成后必须：

1. 运行专项测试、API 测试和完整构建。
2. 对涉及媒体播放的阶段执行 Chrome/Safari 浏览器验收。
3. 检查重复逻辑、僵尸代码、异步生命周期、权限和凭据脱敏。
4. 更新 `docs/development-log.md` 的已完成、测试和待推进内容。
5. 根据长期模块边界更新 `AGENTS.md`，根据实际进度更新总路线图。
6. 提交 Git 后再开始下一阶段，不能把多个未验证阶段堆入同一提交。
