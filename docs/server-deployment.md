# 昆曲标注平台单服务器部署说明

最后更新：2026-08-30

本文对应 R5 可部署候选门禁，目标是在一台受控 Linux 服务器上运行：

- PostgreSQL 16
- Node.js 22 + Fastify API
- Vite 构建的静态 Web
- Caddy 同源反向代理与自动 TLS
- 本地目录或 S3-compatible 对象存储

这是可供研究团队和课堂受控试用的单机基线，不等同于 R7 公网生产验收。真实公网部署仍需完成目标环境的
防火墙、TLS 自动续期、S3 IAM、容量、告警接收、备份调度、恢复演练和安全审计。

## 1. 部署拓扑与关键不变量

```text
浏览器
  └─ HTTPS :443
       └─ Caddy
            ├─ /、/assets/*  -> /opt/xiqu/current/dist
            └─ /api/*        -> Fastify 127.0.0.1:4317
                                  ├─ PostgreSQL 16
                                  └─ /var/lib/xiqu-platform/storage
                                     或 S3-compatible bucket/prefix
```

必须保持：

1. Web 与 API 默认同源。浏览器只访问 `/api`，不得把 `localhost:4317` 写入生产构建。
2. Fastify 只由 Caddy 对外暴露；服务器防火墙不开放 4317。
3. release 位于 `/opt/xiqu/releases/<release-id>`，`/opt/xiqu/current` 是可切换符号链接。
4. 数据库、对象、备份、环境文件和 Caddy 的 TLS 状态都在 release 目录之外，升级不能覆盖持久数据。
5. `NODE_ENV=production` 时必须显式设置 `DATABASE_URL`，默认不生成开发账号，也不开放跨源访问。
6. 迁移只通过 `prisma migrate deploy`；禁止在服务器使用 `db:push --force-reset`。

## 2. 版本与系统准备

建议基线：Ubuntu 24.04 LTS 或同等级 Debian 系统、x86_64/arm64、Node.js 22 LTS、PostgreSQL 16、
Caddy 2.10 或更高版本。模板使用 `request_body max_size`，旧版 Caddy 不满足该代理层上传门禁。
备份和恢复命令还要求 PostgreSQL 16 的 `pg_dump`、`pg_restore` 与 `psql`。

```bash
node --version
psql --version
caddy version
```

Node 必须为 22 或更高版本。数据库客户端主版本应与 PostgreSQL 服务端一致；至少不能低于服务端主版本。

创建无登录服务账号和固定目录：

```bash
sudo useradd --system --home /var/lib/xiqu-platform --shell /usr/sbin/nologin xiqu
sudo install -d -o root -g root -m 755 /opt/xiqu/releases
sudo install -d -o xiqu -g xiqu -m 750 /var/lib/xiqu-platform/storage
sudo install -d -o xiqu -g xiqu -m 750 /var/lib/xiqu-platform/backups
sudo install -d -o root -g xiqu -m 750 /etc/xiqu-platform
```

## 3. PostgreSQL 初始化

以下 SQL 应由数据库管理员执行。示例口令必须替换：

```sql
CREATE ROLE xiqu_app LOGIN PASSWORD 'replace-with-a-strong-random-password';
CREATE DATABASE xiqu_platform OWNER xiqu_app;
```

连接新数据库后预置名称模糊搜索未来需要的数据库级扩展：

```sql
\connect xiqu_platform
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

当前 migration 已有目录分页 B-tree 索引，但尚未创建 trigram GIN 索引；所以 `pg_trgm` 是部署能力预置，
不是“当前已经使用”的性能承诺。不要擅自把扩展安装进隔离 `api_test` schema，也不要由普通 Web 请求创建扩展。

限制 `pg_hba.conf` 只允许应用主机/本机账号访问，确认 PostgreSQL 不直接暴露公网，并建立独立的恢复演练数据库：

```sql
CREATE DATABASE xiqu_restore_drill OWNER xiqu_app;
```

恢复演练库必须与业务库名称不同，执行演练前必须为空。

### 3.1 首次正式部署的数据边界

首次正式生产部署默认使用新建的空数据库和空对象存储，只执行已提交 migration，并通过一次性 bootstrap
创建正式首管理员。不得复制开发机 `.env`、`data/`，也不得导入本机 debug PostgreSQL 数据、开发 seed
账号或测试对象。本机与生产是两个独立平台实例；只有运维负责人另行批准的数据迁移才允许使用第 10 节的
一致备份/恢复流程。

## 4. 构建并发布 release

在受控构建机或服务器上从明确提交构建，不复制开发机 `dist/` 的未知状态：

```bash
git clone <repository-url> xiqu-platform-build
cd xiqu-platform-build
git checkout <reviewed-commit-or-tag>
npm ci
npm run build
npm run release:check
```

构建会先生成 Prisma Client 并核对它与当前 `prisma/schema.prisma` 一致，再生成 shared、document-model、Web
与 API。`release:check` 使用编译后的无数据库检查器复核候选产物，适用于原服务器升级，也适用于从 Git 在新
服务器重建运行环境。输出至少包含：

```text
dist/
├── index.html
├── assets/
└── api/
    ├── server.js
    └── bootstrapAdminCli.js
```

发布到不可变 release 目录：

```bash
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
sudo mkdir "/opt/xiqu/releases/$RELEASE_ID"
sudo cp -a package.json package-lock.json prisma.config.ts prisma packages dist node_modules \
  "/opt/xiqu/releases/$RELEASE_ID/"
sudo install -d "/opt/xiqu/releases/$RELEASE_ID/scripts"
sudo cp -a scripts/checkDeployment.mjs scripts/deploymentCheck.mjs \
  "/opt/xiqu/releases/$RELEASE_ID/scripts/"
sudo bash -c "cd '/opt/xiqu/releases/$RELEASE_ID' && \
  npm run release:inspect -- --release-dir '/opt/xiqu/releases/$RELEASE_ID' && \
  npm run release:check"
sudo chown -R root:root "/opt/xiqu/releases/$RELEASE_ID"
sudo ln -sfn "/opt/xiqu/releases/$RELEASE_ID" /opt/xiqu/current
```

候选基线保留完整 `node_modules`，优先保证 Prisma/原生依赖与已验收构建一致。`prisma.config.ts` 是
Prisma 7 执行 `migrate deploy` 的运行时配置；`node_modules/@xiqu/*` 是指向 `packages/*` 的 workspace
符号链接，因此 release 还必须包含已构建的 `packages/shared/dist` 与 `packages/document-model/dist`。
`deploy:check` 是 package script，候选还必须包含它实际调用的 `scripts/checkDeployment.mjs` 与
`scripts/deploymentCheck.mjs`；不能只复制 `package.json` 后假定脚本入口存在。
Prisma schema 不属于 npm 依赖锁：即使 `package-lock.json` 完全未变化，新增模型或字段也会使旧 Client 失效。
因此不能只因 `package-lock.json` 未变化就从上一 release 复用 `node_modules/.prisma` 或
`node_modules/@prisma/client`。若为节省传输先复制了旧 `node_modules`，必须在候选目录、切换 `current` 前
重新执行 `npm run db:generate` 和 `npm run release:check`；不能在已经运行的不可变 release 内补生成。

复制后应在启动服务前明确检查以下产物，不能只凭 `dist/api/server.js` 存在就判定候选完整：

```bash
test -r "/opt/xiqu/releases/$RELEASE_ID/prisma.config.ts"
test -r "/opt/xiqu/releases/$RELEASE_ID/packages/shared/dist/index.js"
test -r "/opt/xiqu/releases/$RELEASE_ID/packages/document-model/dist/index.js"
sudo bash -c "cd '/opt/xiqu/releases/$RELEASE_ID' && \
  npm run release:inspect -- --release-dir '/opt/xiqu/releases/$RELEASE_ID'"
sudo bash -c "cd '/opt/xiqu/releases/$RELEASE_ID' && npm run release:check"
```

`release:inspect` 只读检查候选目录是否具备运行文件、production dependencies、正式 migrations 和候选内部的
workspace 链接，并拒绝 `.env`、`data/`、备份、草稿、密钥类文件和清单外根项目。它不读取秘密内容、不连接
数据库，也不替代 `release:check`、`migrate deploy`、备份校验或服务 smoke check。

API、分析 worker 和维护/备份 CLI 还会在创建数据库连接前执行相同的 fail-closed 校验。该运行时门禁用于阻止
错误候选接收请求，不替代切换前检查；若 systemd 报告 Prisma Client schema 不一致，应保持维护状态，重建新
候选 release，而不是修改当前 release 权限或只重启服务。

后续可以建立 CI artifact，但不能只复制 `dist/` 而遗漏生产运行依赖、workspace 构建产物、Prisma schema、
配置或 migration。

## 5. 生产环境文件

复制模板并只让 root 与服务组读取：

```bash
sudo cp deploy/single-server/xiqu-platform.env.example \
  /etc/xiqu-platform/xiqu-platform.env
sudo chown root:xiqu /etc/xiqu-platform/xiqu-platform.env
sudo chmod 640 /etc/xiqu-platform/xiqu-platform.env
sudoedit /etc/xiqu-platform/xiqu-platform.env
```

至少替换 `DATABASE_URL`、`XIQU_METRICS_TOKEN`，并确认：

```text
NODE_ENV=production
HOST=127.0.0.1
XIQU_SEED_DEVELOPMENT_DATA=false
XIQU_OBJECT_STORAGE_BACKEND=local
XIQU_STORAGE_ROOT=/var/lib/xiqu-platform/storage
```

模板中的连接串、路径、token 和对象存储凭据使用 shell/systemd 均可识别的单引号。替换值时保留引号；URL
内的特殊字符应按 URL 规则编码，不能把一段未转义的 shell 语法写进环境文件。

同源部署不要设置 `XIQU_CORS_ORIGINS`。只有 Web 确实部署在另一个 origin 时，才设置有限的逗号分隔
HTTP(S) origin；`*`、路径、带用户名密码的 URL 和空值会阻止 API 启动。

### 5.1 S3-compatible 运行存储

若使用 S3-compatible 对象存储，把 backend 改为 `s3` 并补齐模板中的全部 `XIQU_S3_*` 变量。当前实现故意
不使用宿主默认凭据链；空白、未知 backend、缺项或坏布尔值都会启动失败。运行对象 prefix 与备份
`XIQU_BACKUP_S3_PREFIX` 必须彼此独立且不嵌套。

上线前按 [`deploy/object-storage/README.md`](../deploy/object-storage/README.md) 检查 TLS、path-style、
最小 IAM、Range、server-side copy 和无残留删除。开发机 SeaweedFS 通过只证明协议工具链，不等于真实桶验收。

## 6. 数据库 migration 与首位管理员

让命令读取生产环境文件，再执行已提交 migration：

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run db:deploy
'
```

如果 release 按生产权限由 `root:root` 持有，而 Prisma 7 首次运行需要在 release 内补齐 engines 缓存，
上述服务用户命令可能因无权写 `node_modules` 而失败。此时保持维护模式不变，改由 root 仅执行同一个
`npm run db:deploy`，不要给 `xiqu` 放开整个 release 的写权限，也不要以 root 启动 systemd 服务；迁移完成后
API 与 analysis worker 仍必须以 `xiqu` 运行。后续可通过构建机预热并验证 Prisma engines 消除这一步的首次
写入，但不能把运行时 release 改成可写共享目录。

全新数据库默认没有任何账号。使用一次性 bootstrap CLI 创建首位管理员；密码只经 stdin 传入，不出现在
argv、仓库或环境文件：

```bash
read -rsp "首位管理员密码（至少 12 位）: " XIQU_BOOTSTRAP_PASSWORD </dev/tty
echo
printf '%s' "$XIQU_BOOTSTRAP_PASSWORD" | sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run admin:bootstrap -- --account-name platform.admin --display-name 系统管理员
'
unset XIQU_BOOTSTRAP_PASSWORD
```

CLI 在 PostgreSQL 事务锁内检查系统管理员状态。数据库一旦已有活跃 `super_admin`，它会拒绝再次
bootstrap；同名普通账号也不会被静默提权。后续账号与权限必须走正式平台治理流程。

绝不能在生产环境把 `XIQU_SEED_DEVELOPMENT_DATA` 改为 `true`。该选项会创建公开开发口令与演示资源，只供
本机开发数据库使用。

### 6.1 RA4c 多音轨分析的三阶段迁移

已有旧分析 run 和 `annotation_analysis_audio_settings` 数据的服务器不能直接从早期 release 部署 migration 29。
先在维护窗口停止 analysis worker、建立并验证一致备份。若数据库尚未应用
`20260824040000_media_scoped_analysis_runs`，必须先使用与 24-03 schema 匹配的 RA2 历史工具 release；生产修复
提交为 `5cd4556`（基于 `85828ee`）。它修正 waveform manifest 桶宽与资产 level 序号的映射，同时继续逐对象
校验大小与 SHA-256。先执行并保存：

```bash
node dist/api/mediaAnalysisMigrationCli.js dry-run
node dist/api/mediaAnalysisMigrationCli.js execute \
  --operator <active-super-admin-account> \
  --plan-fingerprint <dry-run-sha256>
node dist/api/mediaAnalysisMigrationCli.js dry-run
```

最终 RA2 报告必须为零阻断、零待归并/回填，再部署 commit `d615add`（RA4c1 additive 工具 release）并应用
至 migration 27/28。不要用最终 release 的 Prisma Client 连接中间 schema，也不要跨 release 复制 CLI。随后以
生产环境变量运行：

```bash
node dist/api/analysisAudioSettingMigrationCli.js dry-run
node dist/api/analysisAudioSettingMigrationCli.js execute \
  --operator <active-super-admin-account> \
  --plan-fingerprint <dry-run-sha256>
node dist/api/analysisAudioSettingMigrationCli.js dry-run
```

最后一次报告必须同时是 `blockedCount=0`、`createTrackCount=0`。保存有限报告和审计证据后，才可部署包含
`20260826030000_remove_legacy_analysis_audio_settings` 的新 release 并执行 `npm run db:deploy`。migration 29 还会
在数据库内二次检查每条设置、original/override 音轨和资源祖先状态；失败时保持维护、不要修改 migration SQL、
不要使用 `db:push` 或手工删除旧表。处理数据后应回到 RA4c1 release 重新 dry-run/execute。

不可变运行包不包含 TypeScript 源码，所以服务器上必须调用上述 `dist` CLI；`npm run
analysis-audio-settings:migrate` 指向源码 `tsx`，只适用于完整源码 worktree。全新空数据库可以直接应用完整
migration 链；上述三阶段步骤只针对已经存在旧 run/setting 数据的升级库。RA4c1 CLI 在
RA4c2 源码中已按生命周期删除，因此不能拿最终 release 冒充 additive 迁移工具。

## 7. systemd 服务

安装仓库模板：

```bash
sudo cp deploy/single-server/xiqu-api.service /etc/systemd/system/xiqu-api.service
sudo cp deploy/single-server/xiqu-analysis-worker.service \
  /etc/systemd/system/xiqu-analysis-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now xiqu-api xiqu-analysis-worker
sudo systemctl status xiqu-api
sudo systemctl status xiqu-analysis-worker
```

服务只允许写 `/var/lib/xiqu-platform`，日志进入 journald：

```bash
sudo journalctl -u xiqu-api -f
sudo journalctl -u xiqu-analysis-worker -f
curl --fail http://127.0.0.1:4317/api/health/live
curl --fail http://127.0.0.1:4317/api/health/ready
```

readiness 只有在 PostgreSQL 与对象存储同时可用时才返回 200。liveness 成功但 readiness 为 503 时，不要
反复重启进程，应检查响应中的数据库/存储组件状态和 journald。

analysis worker 是独立进程：API 只创建任务和流式读取资产，不在请求内运行 FFmpeg。生产主机必须安装
FFmpeg，并通过 `XIQU_FFMPEG_PATH` 固定绝对路径。worker 收到 SIGTERM 会清理当前半成品并把任务重新排队；
systemd 的 `TimeoutStopSec` 应覆盖该清理时间。API 正常但 worker 未运行时，播放和标注仍可用，分析任务会
停留在“排队中”。

同一 worker runtime 也可消费强制对齐任务，但该能力默认关闭。只有部署了实现固定
`--request <json> --audio <binary> --output <json>` 协议的真实模型程序后，才在 API 与 worker 共用的受保护环境文件中同时设置：

```bash
XIQU_FORCE_ALIGNMENT_REQUESTS_ENABLED=true
XIQU_FORCE_ALIGNMENT_EXECUTOR_PATH='/opt/xiqu-platform/bin/force-align'
```

执行器路径必须是可执行的绝对路径；worker 启动时会先检查权限，API 在请求开关为 true 而路径缺失时会直接拒绝启动。
worker 把正文投影与纯音频写入权限受限的临时目录，VOD 临时 URL 不进入命令行、数据库或日志。未完成真实模型、词典和
预测合同验收前必须保持默认关闭，不能用占位脚本制造看似成功的研究数据。

后台任务出现排队、陈旧 claim、取消不收敛或写许可异常时，按
[`processing-job-operations.md`](processing-job-operations.md) 的决策树先区分 API、数据库、对象存储和 worker；
不要用一次全服务重启代替定位。空队列时以 systemd 判断 worker 存活，有活动任务时以数据库 heartbeat/claim
判断处理链路是否收敛。

当前维护 advisory gate 只覆盖 HTTP mutation，analysis worker 尚未接入未来的 drain/permit 协议。执行一致
备份、数据库 migration 或 release 切换前必须先启用维护并排空 HTTP 写入，再停止 `xiqu-analysis-worker` 并等待
systemd 停机完成；其
SIGTERM 路径会删除本轮半成品并把任务安全放回队列。不能只在管理员页面开启维护后就假定后台写入已经静默。

## 8. 外部媒体与 Caddy/TLS

### 8.1 可选阿里云 VOD

阿里云 VOD 默认关闭。需要启用时，在受保护的服务环境中设置：

```bash
XIQU_ALIYUN_VOD_ENABLED=true
XIQU_ALIYUN_VOD_REGION=cn-shanghai
XIQU_ALIYUN_VOD_WEB_LICENSE_DOMAIN=annotation.example.org
XIQU_ALIYUN_VOD_WEB_LICENSE_KEY=replace-with-web-license-key
```

凭据由 `@alicloud/credentials` 默认凭据链读取。生产优先使用实例角色或工作负载身份；必须使用长期
AccessKey 时，应通过权限为 `600` 的环境文件或 secret 管理器注入，并限制为读取媒资信息和签发播放
凭据及纯音频转码地址所需的最小权限，至少覆盖 `GetVideoInfo`、`GetVideoPlayAuth` 和 `GetPlayInfo`。
AccessKey、Secret、playauth 和临时播放 URL 不得进入数据库、标注 JSON、日志、
浏览器草稿或仓库。启用后还应人工验证无权限媒资、已停用媒资和凭据过期场景均返回明确错误。

Web 播放器 License 与服务端 AccessKey 是两套独立凭据。先按阿里云官方的
[管理 License](https://help.aliyun.com/zh/vod/developer-reference/license-authorization-and-management) 指引，在
点播控制台“SDK 管理 -> 我的授权”中创建 Web 应用、填写不含协议/端口/路径或通配符且被控制台接受的域名，
再绑定播放器 License；将控制台显示的同一域名和 License Key 分别写入上面的两个环境变量。两项缺一时 API
会在签发 PlayAuth 前明确拒绝播放会话。初始化参数应与官方
[快速接入 Web 播放器](https://help.aliyun.com/zh/vod/developer-reference/integration) 示例一致。

本地调试同样需要有效 License，页面 hostname 必须落在授权域名范围内；不要自行假定 `127.0.0.1` 可以作为
控制台授权域名。若控制台不接受本机 IP，应使用受控测试域名解析到本机进行验收，不能通过关闭校验或降级
SDK 绕过。License Key 会按官方要求发送给浏览器，虽然不是 AccessKey 一类服务端秘密，仍应由部署配置统一
管理，避免账号专属值进入前端源码。

编辑器使用固定版本 2.38.3 的阿里云官方 Web 播放器资源：

```text
https://g.alicdn.com/apsara-media-box/imp-web-player/2.38.3/aliplayer-min.js
https://g.alicdn.com/apsara-media-box/imp-web-player/2.38.3/skins/default/aliplayer-min.css
```

部署网络必须允许浏览器访问该域名；若自行增加 Content Security Policy，需要把 `g.alicdn.com` 精确加入
`script-src` 与 `style-src`，不要放开任意脚本域。SDK 加载失败、供应商未配置和播放会话失败都会在播放器
原位显示并允许重试。短时 playauth 只驻留页面内存，到期前由播放器单飞刷新；禁止让 Caddy、Service Worker
或浏览器缓存播放会话 API 响应。服务器上传媒体与本地计算机媒体入口始终保留，不得把 VOD 配置作为平台
启动的必需条件。

VOD 后台分析通过 `GetPlayInfo(Formats=mp3, StreamType=audio)` 选择 HTTPS 纯音频转码，临时 URL 只进入
worker 内存和 FFmpeg argv，不缓存完整视频。部署验收可使用样例 VOD ID
`00cf8df6907871f1b31f5017e1f80102`，但必须由账号所有者确认媒资归属和可用性；空 playauth 或 fake gateway
不算真实验收。若云端音频接口卡顿，用户可以在编辑器中强制改用已上传的 WAV/FLAC/MP3，自动来源恢复后
也可显式切回。

### 8.2 Caddy 与自动 TLS

先把目标域名的 A/AAAA 记录指向服务器，并确认公网 TCP 80/443 可以到达该主机。按照
[Caddy 官方安装说明](https://caddyserver.com/docs/install)安装受支持版本；发行版安装包通常会同时创建
`caddy` systemd 服务和持久目录 `/var/lib/caddy`。复制模板并把 `annotation.example.org` 替换成真实域名：

```bash
sudo cp deploy/single-server/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

站点地址包含真实域名时，Caddy 会自动申请、安装和续期公开可信的 TLS 证书，并把 HTTP 重定向到 HTTPS。
首次签发和后续续期都依赖有效 DNS、80/443 入站和可写的 Caddy 数据目录；不能把 `/var/lib/caddy` 当成
release 临时目录清理。部署方仍需监控签发/续期失败和证书到期状态。

模板同时固定以下边界：

- `@api path /api /api/*` 在 SPA fallback 之前代理到 `127.0.0.1:4317`。必须使用 `handle`，不能改成会剥除
  `/api` 前缀的 `handle_path`。Caddy 原生处理 WebSocket upgrade，`stream_close_delay 5m` 用于错开配置
  reload 时的协作连接重连；HTTP committed-feed/snapshot 追赶仍是权威恢复路径。
- `request_body max_size 21474836480` 与 `XIQU_MAX_UPLOAD_BYTES=21474836480` 精确对齐，超过限制返回 413，
  Fastify 仍执行自己的业务上限和媒体签名检查。修改上传上限时必须同步修改两处。大小列已迁移为 `BigInt`；
  S3-compatible 后端对超过 5 GB 的 staged 对象使用 multipart copy，超过 S3 5 TB 上限则明确拒绝。
- `encode gzip` 显式覆盖普通 Web MIME 和四种 `application/vnd.xiqu.*` 分析 MIME，确保波形、频谱、F0
  单瓦片与批量瓦片继续流式压缩。授权资产仍保持 private，不能在代理或 CDN 改成 public/immutable。
- `/assets/*` 仅服务带内容哈希的构建资产并设置 immutable；直接请求或 SPA fallback 得到的 `index.html`
  都设置 `no-cache`。
- Caddy 的服务账号必须能够遍历 `/opt/xiqu/current` 并读取 `dist/index.html`，但不需要获得 release 写权限：

  ```bash
  sudo -u caddy test -r /opt/xiqu/current/dist/index.html
  ```

- 防火墙只开放 80/443；Fastify 4317 和 PostgreSQL 5432 不对公网开放。生产同源部署不设置
  `XIQU_CORS_ORIGINS`。

### 8.3 从既有 Nginx 切换到 Caddy

仓库保留 `nginx.conf.example` 供尚未迁移的既有部署使用；新的单服务器部署以 Caddy 为默认。切换前先保留
现有 Nginx 站点文件和证书配置以便回退，并在 Nginx 仍在线时完成 Caddyfile 的离线校验。两者不能同时绑定
80/443，实际切换按以下顺序执行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl disable --now nginx
sudo systemctl enable --now caddy
sudo systemctl status caddy --no-pager
sudo ss -ltnp | grep -E ':80 |:443 '
```

切换后立即使用正式 HTTPS origin 执行第 9 节只读检查。若 Caddy 启动或签发证书失败，先查看
`journalctl -u caddy`，必要时停止 Caddy 并重新启用原 Nginx 配置；不要让临时 HTTP 页面或 Fastify 4317
直接暴露公网。

切换域名或首次从 `localhost` 上线时，阿里云 Web 播放器 License 还必须覆盖浏览器实际 hostname。
`XIQU_ALIYUN_VOD_WEB_LICENSE_DOMAIN` 应等于控制台申请 License 时填写的域名，Key 必须来自同一已绑定且
未过期的 Web 应用；域名或 Key 变化后重启 `xiqu-api`。Caddy 的 TLS 成功不代表 VOD License 已生效，
播放器 `4040 LICENSE ERROR` 应回到第 8.1 节核对授权，而不是放宽反向代理。

## 9. 部署验收

从能访问正式域名的机器运行：

```bash
npm run deploy:check -- --base-url=https://annotation.example.org
```

该命令只读检查首页、liveness 和 readiness，不登录、不写数据。需要更长网络超时时可显式设置：

```bash
npm run deploy:check -- \
  --base-url=https://annotation.example.org \
  --timeout-ms=20000
```

部署验收优先直接使用正式 HTTPS origin，让同一次检查覆盖 DNS、Caddy 路由和 TLS。裸
`http://127.0.0.1/` 不携带配置域名，可能不能命中目标站点或只能验证本机端口；这不代表 Fastify API
故障，也不能替代公开 origin 检查。

然后完成一次人工闭环：

1. 以首位管理员登录。
2. 创建项目/文件夹，上传一个测试媒体和标注 JSON。
3. 打开编辑器，确认媒体 Range seeking、WebSocket 连接和保存状态。
4. 启动一次上传媒体分析，确认任务从 queued/running 到 succeeded，时间轴按窗显示波形、频谱与 F0。
5. 若启用 VOD，分别验证播放短时凭据、纯音频分析、强制上传音频覆盖和恢复自动来源。
6. 新建第二账号，设置资源权限，验证只读/可写边界及分析资产读取权限。
7. 检查系统诊断、审计日志与 `/metrics`（携带独立 Bearer token）。
8. 删除测试资源并确认回收站、恢复与对象容量状态符合预期。

## 10. 备份与恢复演练

### 10.1 本地对象存储

本地一致备份必须在维护窗口内同时覆盖 PostgreSQL 与整个对象根。先使用第 11 节相同的 `maintenance:enable` 命令
等待 API 在途写入排空，再停止 worker；只停止 worker、但仍允许用户通过 API 写入，不构成一致备份：

```bash
sudo systemctl stop xiqu-analysis-worker
sudo systemctl is-active xiqu-analysis-worker # 预期为 inactive
```

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:create -- \
    --operator platform.admin \
    --output /var/lib/xiqu-platform/backups \
    --reason "部署后基线备份" \
    --require-existing-maintenance
'
```

`--require-existing-maintenance` 不会自行开关维护：它要求当前窗口由同一个 `platform.admin` 操作员建立，
并在备份成功或失败后继续保持维护。独立定时备份不应传此参数，由备份命令自行取得和释放维护窗口。

按输出目录验证：

```bash
sudo -u xiqu bash -c '
  cd /opt/xiqu/current
  npm run backup:verify -- --backup /var/lib/xiqu-platform/backups/xiqu-backup-...
'
```

若本次只创建备份而不继续升级，验证成功后重新启动 worker；若随后部署新 release，则保持停止直到新版本
API、migration 和 smoke 均通过：

```bash
sudo systemctl start xiqu-analysis-worker
```

### 10.2 隔离恢复演练

恢复目标必须是不同的空数据库和空对象目录：

```bash
sudo install -d -o xiqu -g xiqu -m 750 /var/lib/xiqu-platform/restore-drill
sudo install -d -o xiqu -g xiqu -m 750 /var/lib/xiqu-platform/restore-drill/storage
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:restore-drill -- \
    --backup /var/lib/xiqu-platform/backups/xiqu-backup-... \
    --target-database-url "postgresql://xiqu_app:***@127.0.0.1:5432/xiqu_restore_drill?schema=public" \
    --target-storage /var/lib/xiqu-platform/restore-drill/storage \
    --report /var/lib/xiqu-platform/restore-drill/report.json
'
```

连接串含密码时优先使用仅当前进程可见的环境变量，不写 shell history。恢复库会保留备份时的维护状态；
确认演练结果后再对恢复库显式解除。恢复实现会在 `target-storage` 同级创建 staging 目录，再原子替换已确认
为空的目标；所以该目标必须位于 `xiqu` 可写的专用父目录中。只把目标目录本身设为 `xiqu` 所有、却把父目录
留为不可写，会在数据库恢复后、对象发布前失败。不要把演练目标指向业务库或业务对象目录。

S3-compatible 远端备份、manifest-last 发布、流式校验、保留清理和远端恢复演练使用 README 已有命令及
`deploy/object-storage/` 的目标环境检查表。

### 10.3 服务器间迁移

未来从一台正式服务器迁往另一台时，必须把 PostgreSQL 和对象存储视为一个不可拆分的数据集。现有工具已能
在维护窗口创建包含数据库 dump、上传对象、恢复快照及波形/频谱/F0 派生资产的一致备份，生成 manifest 与
SHA-256，并在空数据库和空对象目录执行隔离恢复及摘要复核。

推荐迁移顺序：源服务器进入维护并创建/校验备份；将备份包安全传至目标服务器；在目标使用不同名称的空候选
数据库和空候选对象目录运行 `backup:restore-drill`；检查报告、登录、ACL、媒体 Range、标注 revision、分析
资产和审计；停止目标服务后把已验证候选设为正式 `DATABASE_URL`/`XIQU_STORAGE_ROOT`，确认维护状态后显式
恢复写入，最后切换 DNS。不要向正在运行或已有数据的目标数据库/对象目录原地覆盖。

这已经能稳定支持“本地对象存储 -> 新服务器本地对象存储”的受控迁移，但还不是一键生产切换：恢复命令
故意要求隔离空目标并保留维护状态，最终接管仍需运维确认。若运行对象存储迁移到新的 S3-compatible bucket，
当前工具可创建/校验远端备份并物化隔离恢复，但尚无直接向生产 S3 prefix 发布恢复结果的命令；应在 R7 补齐
带 manifest 校验、空目标门禁和原子接管语义的生产 restore/cutover CLI，完成前必须制定并演练供应商级对象
复制与逐项校验方案。

## 11. 升级流程

每次升级按固定顺序执行：

1. 记录当前 `readlink -f /opt/xiqu/current` 和 Git commit，查看 release notes、Prisma migration 和环境变量变化，
   构建新的不可变 release；在候选目录依次运行
   `npm run release:inspect -- --release-dir <绝对候选目录>` 与 `npm run release:check`，确认目录无本地状态且
   Prisma Client 来自同一 schema 后仍不要切换 `current`。复制
   [`production-cutover-record-template.md`](./production-cutover-record-template.md) 作为本次脱敏上线记录。
2. 提前通知用户暂停编辑并确认页面显示已同步。通过旧 release 的 CLI 进入维护模式，等待在途 HTTP 写入排空；
   当前版本没有自动客户端 drain，维护开启后的本机草稿不会自动等同于服务器已保存。
3. 停止 analysis worker 并确认 `systemctl is-active` 为 `inactive`；记录活动任务、当前 release 和 migration 基线。
4. 在“维护排空 + worker 停止”之后创建并验证一致备份，重要升级完成一次隔离恢复演练。先备份、后进入维护的结果
   不能作为本次升级的一致回滚基线。
5. 使用 **新 release** 执行 `npm run db:deploy`，禁止 `db push`。
6. 使用 `release:switch` 并把第 1 步记录的旧 release 作为 `expected-current`，原子切换 `/opt/xiqu/current`；重启 API，
   若代理配置变化，再执行 `caddy validate` 后 reload。不要再使用绕过期望值和并发锁的裸 `ln -sfn` 升级命令。
7. 在维护状态下运行无写入的 `deploy:check`，检查首页、liveness、readiness 和只读资源；此时不能把登录或
   保存失败误判为新版本故障。
8. 使用 CLI 解除维护，随后启动新 release 的 analysis worker 并检查队列状态。
9. 完成人工登录、打开、保存、协作和媒体分析闭环；通知用户刷新，保留上一 release 与对应备份。

示例：

```bash
OLD_RELEASE="$(readlink -f /opt/xiqu/current)"
NEW_RELEASE=/opt/xiqu/releases/<new-release-id>

# 维护前完成候选只读检查，但不要切换 current。
sudo bash -c "cd '$NEW_RELEASE' && \
  npm run release:inspect -- --release-dir '$NEW_RELEASE' && \
  npm run release:check"

# 由旧 release 进入维护；命令会等待在途 HTTP 写入结束。
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run maintenance:enable -- --operator platform.admin --reason "部署新版本"
'

# 排空写入后停止 worker，随后创建并验证一致备份。
sudo systemctl stop xiqu-analysis-worker
sudo systemctl is-active xiqu-analysis-worker # 预期为 inactive
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:create -- \
    --operator platform.admin \
    --output /var/lib/xiqu-platform/backups \
    --reason "部署前一致备份" \
    --require-existing-maintenance
'
sudo -u xiqu bash -c '
  cd /opt/xiqu/current
  npm run backup:verify -- --backup /var/lib/xiqu-platform/backups/xiqu-backup-...
'

# 只从新候选执行正式 migration，再以旧 release 为并发前提原子切换。
sudo -u xiqu env NEW_RELEASE="$NEW_RELEASE" bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd "$NEW_RELEASE"
  npm run db:deploy
'
sudo bash -c "cd '$NEW_RELEASE' && npm run release:switch -- \
  --current-link /opt/xiqu/current \
  --expected-current '$OLD_RELEASE' \
  --new-release '$NEW_RELEASE'"
sudo systemctl restart xiqu-api
sudo bash -c "cd '$NEW_RELEASE' && \
  npm run deploy:check -- --base-url=https://annotation.example.org"

# 只读检查通过后由新 release 恢复写入，再启动 worker。
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run maintenance:disable -- --operator platform.admin
'
sudo systemctl start xiqu-analysis-worker
```

## 12. 失败回滚

若新进程或静态页面失败，但 migration 与旧程序向后兼容：

```bash
FAILED_RELEASE="$(readlink -f /opt/xiqu/current)"
sudo bash -c "cd '$FAILED_RELEASE' && npm run release:switch -- \
  --current-link /opt/xiqu/current \
  --expected-current '$FAILED_RELEASE' \
  --new-release '$OLD_RELEASE'"
sudo systemctl restart xiqu-api
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo bash -c "cd '$OLD_RELEASE' && \
  npm run deploy:check -- --base-url=https://annotation.example.org"
```

`release:switch` 会再次校验回滚目标，并要求 `current` 仍指向本次失败 release；若事实已变化会 fail closed，操作员必须
重新读取现场。若 migration 不向后兼容，不能只切回旧代码。保持维护模式和 worker 停止，按已验证备份同时恢复数据库
与对象存储，再切回匹配 release。Prisma migration 采用前向记录，不要手工删除 `_prisma_migrations` 行冒充回滚。

回滚后必须再次核对：readiness、对象 Range、登录、资源 ACL、标注 revision、WebSocket、审计、备份状态和
维护状态。任何补偿失败都应保留现场并记录，不要用 `db:push --force-reset` 清除证据。

## 13. 上线检查表

- [ ] Node.js >= 22，PostgreSQL/客户端为 16。
- [ ] 服务账号、release、持久目录和环境文件权限正确。
- [ ] 候选 release 已运行 `release:inspect` 与 `release:check`；没有夹带本地状态，也没有按 lockfile 相同而复用旧 Prisma Client 生成物。
- [ ] `DATABASE_URL` 指向目标库，`XIQU_SEED_DEVELOPMENT_DATA=false`。
- [ ] 数据库 migration 成功，首位管理员通过一次性 CLI 创建。
- [ ] local 对象目录持久化，或真实 S3-compatible IAM/TLS 能力验收通过。
- [ ] Fastify 4317 不对公网开放；Caddy `/api`、WebSocket 和 SPA fallback 正常。
- [ ] Caddy `request_body max_size` 与 `XIQU_MAX_UPLOAD_BYTES` 一致，四种分析 MIME 启用 gzip。
- [ ] TLS 证书可信且已有续期与失败告警。
- [ ] `deploy:check`、登录、上传、Range、打开、保存、ACL 和审计人工闭环通过。
- [ ] Prometheus token 独立保存，告警接收端经过真实测试。
- [ ] 一致备份已创建并校验；隔离恢复演练通过并留存报告。
- [ ] 当前 release、commit、migration、环境变更、备份 id 和验收人已记录。
- [ ] 已使用 `production-cutover-record-template.md` 留存脱敏切换/回滚证据，未记录密码、token、AccessKey、PlayAuth 或连接串。

## 14. 当前候选限制

- systemd/Caddy 是单机模板，未提供多节点负载均衡或自动扩缩容。
- 真实生产 MinIO/AWS IAM、TLS、网络与恢复仍需在目标环境执行，仓库测试不能替代。
- 没有自动备份调度、备份加密、跨区复制或恢复时间目标承诺。
- Caddy 提供自动 ACME，但仓库没有证书续期失败告警、主机防火墙或操作系统补丁编排。
- Web 主 bundle 仍有 Vite 大 chunk 提醒，影响首屏性能但不阻断正确性。
- 工尺谱字形字体在公共发布前仍需替换或取得明确授权。

这些限制属于 R7 生产与学术发布门禁，不应被本单机候选文档掩盖。
