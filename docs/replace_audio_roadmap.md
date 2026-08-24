# 多音轨快速切换、替换播放与媒体级分析路线图

> 文档状态：专项实施中，RA0-RA2 已完成
> 专项分支：`codex/replace-audio-playback`  
> 制定日期：2026-08-24  
> 关联总路线图：`docs/kunqu-platform-roadmap.md`

## 0. 当前进度

- **RA0 已完成（2026-08-24）**：共享包已建立严格的媒体音轨、默认音轨偏好、分析状态与媒体级 analysis
  identity 合同；Web 已建立视频主时钟映射、统一漂移阈值和带 source generation 的同步播放纯状态机。
- **RA1 已完成（2026-08-24）**：Prisma 已新增有序 `MediaAudioTrack` 和标注文件
  `AnnotationAudioPreference`，上传媒体、VOD 媒体及媒体复制均在同一事务建立唯一原声；严格 CRUD、重排、
  默认值、ACL、审计和类型安全客户端边界已通过真实 PostgreSQL 集成测试。
- `AnnotationAnalysisAudioSetting` 暂时继续提供当前文件的分析来源与偏移上下文；在线 canonical
  `MediaAnalysisRun` 已按媒体内容、算法和配置复用，不再按标注文件或偏移重复创建。
- **RA2a 已完成（2026-08-24）**：additive supersession migration、纯计划器和 super-admin-only
  dry-run/execute CLI 已建立；执行只标记 canonical/duplicate，保留全部 run、asset 和对象。
- **RA2b1 已完成（2026-08-24）**：新增不含 annotation/mode/offset 的媒体 fingerprint，迁移计划已能跨旧偏移
  归并并为 canonical 幂等回填。
- **RA2b2 已完成（2026-08-24）**：service、worker、asset ACL adapter 与 IndexedDB 缓存已切到媒体级
  canonical identity，最终 migration 以 fail-closed 前置检查保护两阶段生产迁移。
- 下一阶段是 **RA3 组合播放器与快速音轨切换**。本轮应消费现有音轨 API 和同步状态机，不再复制分析来源或
  另建一套媒体身份。

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

音轨资源是平台中真实存在的 `MediaFile`：

- 上传的 MP3、WAV、M4A 等音频文件；
- 阿里云 VOD 中的独立音频资源；
- 视频自身包含的原始音频。视频原声在 UI 中是一条音轨，但数据库可以用主媒体身份表达，无需复制媒体对象。

### 2.3 音轨关联

音轨关联描述“某个视频有哪些可以切换的声音”，它不是音频二进制本身：

- 音轨显示名称，例如“视频原声”“人声分离”“伴奏”；
- 音轨类型，例如原声、人声、伴奏、降噪或自定义；
- 指向真实音频媒体资源；
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

建议新增 `MediaAudioTrack`：

```text
id                         UUID 主键
primaryMediaResourceId     主视频或主媒体资源
audioMediaResourceId       可空；空值且 kind=original 时代表视频原声
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
- 非 `original` 音轨必须引用真实 `MediaFile`。
- 关联资源必须是可播放的音频，不能把另一个普通视频误当替换音频；若阿里云视频允许使用其纯音频转码，应以明确的音频选择策略解析，而不是伪造 MIME。
- 同一主媒体和音频资源可以只保留一个有效关联；如确有不同偏移用途，后期再允许多个具名关联。
- `offsetSeconds` 是关联属性，不写入 `MediaAnalysisRun`。
- 删除关联不删除真实媒体资源，也不删除该媒体已有分析结果。

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

如果以后用户把 VOD 内多个音频流当作独立音轨，必须把流选择信息纳入媒体来源指纹或建立显式派生媒体资源，不能让不同流复用同一个 run。

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

建议接口：

```text
GET    /api/media/:primaryMediaId/audio-tracks
POST   /api/media/:primaryMediaId/audio-tracks
PATCH  /api/media/:primaryMediaId/audio-tracks/:trackId
DELETE /api/media/:primaryMediaId/audio-tracks/:trackId
POST   /api/media/:primaryMediaId/audio-tracks/reorder
```

职责：

- 返回当前用户可见的音轨摘要和可用状态；
- 创建关联时验证主媒体、音频媒体和权限；
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
- 播放时每 `250-500ms` 比较主从时钟。
- 小于约 `40ms` 的漂移先忽略；连续中等漂移再纠正；大于约 `150ms` 时硬 seek。
- 第一版不通过持续改变 playbackRate 来追赶，以免唱腔音高和速度产生可感知扰动。
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
  `audioTime = masterTime - offsetSeconds`、开始前/可播/结束后区间和 40ms/150ms 初始漂移边界；中等同向
  漂移连续确认后才硬同步。
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

### RA4：分析显示跟随与渐进缓存复用

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

**改动范围**

- 毫秒级偏移 UI；
- 漂移采样和受控硬同步；
- 缓冲、结束、续签和恢复状态；
- 脱敏诊断与低基数指标。

**验证**

- 正负偏移和不同长度音频；
- 30 分钟以上连续播放；
- 慢网、断网、凭证过期、系统休眠；
- Chrome/Safari，临时 HTTP IP 与未来 HTTPS 域名。

### RA6：迁移收口与旧逻辑删除

**改动范围**

- 执行生产前迁移演练；
- 删除旧设置表、旧字段、兼容 route、重复 DTO 和前端状态；
- 更新 AGENTS、部署、备份、恢复和 Development Log；
- 完整回归、压力和浏览器验收。

**验证**

- `rg` 确认旧接口和旧字段无运行调用；
- Prisma、shared、API、frontend 全量构建；
- 数据库恢复后媒体、音轨、run 和 assets 引用完整；
- 服务器迁移不会把本机实验数据带入生产。

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

- schema 迁移分两步：先增量新增新表/新字段并双读验证，再迁移和删除旧结构。
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
| 外部音频缓冲落后 | 画面与声音漂移 | 宽限后暂停主视频并重同步 |
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
