# 昆曲标注平台单服务器部署说明

最后更新：2026-08-04

本文对应 R5 可部署候选门禁，目标是在一台受控 Linux 服务器上运行：

- PostgreSQL 16
- Node.js 22 + Fastify API
- Vite 构建的静态 Web
- Nginx 同源反向代理与 TLS
- 本地目录或 S3-compatible 对象存储

这是可供研究团队和课堂受控试用的单机基线，不等同于 R7 公网生产验收。真实公网部署仍需完成目标环境的
防火墙、TLS 自动续期、S3 IAM、容量、告警接收、备份调度、恢复演练和安全审计。

## 1. 部署拓扑与关键不变量

```text
浏览器
  └─ HTTPS :443
       └─ Nginx
            ├─ /、/assets/*  -> /opt/xiqu/current/dist
            └─ /api/*        -> Fastify 127.0.0.1:4317
                                  ├─ PostgreSQL 16
                                  └─ /var/lib/xiqu-platform/storage
                                     或 S3-compatible bucket/prefix
```

必须保持：

1. Web 与 API 默认同源。浏览器只访问 `/api`，不得把 `localhost:4317` 写入生产构建。
2. Fastify 只由 Nginx 对外暴露；服务器防火墙不开放 4317。
3. release 位于 `/opt/xiqu/releases/<release-id>`，`/opt/xiqu/current` 是可切换符号链接。
4. 数据库、对象、备份、环境文件和 TLS 私钥都在 release 目录之外，升级不能覆盖持久数据。
5. `NODE_ENV=production` 时必须显式设置 `DATABASE_URL`，默认不生成开发账号，也不开放跨源访问。
6. 迁移只通过 `prisma migrate deploy`；禁止在服务器使用 `db:push --force-reset`。

## 2. 版本与系统准备

建议基线：Ubuntu 24.04 LTS 或同等级 Debian 系统、x86_64/arm64、Node.js 22 LTS、PostgreSQL 16、Nginx。
备份和恢复命令还要求 PostgreSQL 16 的 `pg_dump`、`pg_restore` 与 `psql`。

```bash
node --version
psql --version
nginx -v
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

## 4. 构建并发布 release

在受控构建机或服务器上从明确提交构建，不复制开发机 `dist/` 的未知状态：

```bash
git clone <repository-url> xiqu-platform-build
cd xiqu-platform-build
git checkout <reviewed-commit-or-tag>
npm ci
npm run build
```

构建会依次生成 Prisma Client、shared、document-model、Web 与 API。输出至少包含：

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
sudo cp -a package.json package-lock.json prisma dist node_modules "/opt/xiqu/releases/$RELEASE_ID/"
sudo chown -R root:root "/opt/xiqu/releases/$RELEASE_ID"
sudo ln -sfn "/opt/xiqu/releases/$RELEASE_ID" /opt/xiqu/current
```

候选基线保留完整 `node_modules`，优先保证 Prisma/原生依赖与已验收构建一致。后续可以建立 CI artifact，
但不能只复制 `dist/` 而遗漏生产运行依赖、Prisma schema 或 migration。

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

## 7. systemd 服务

安装仓库模板：

```bash
sudo cp deploy/single-server/xiqu-api.service /etc/systemd/system/xiqu-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now xiqu-api
sudo systemctl status xiqu-api
```

服务只允许写 `/var/lib/xiqu-platform`，日志进入 journald：

```bash
sudo journalctl -u xiqu-api -f
curl --fail http://127.0.0.1:4317/api/health/live
curl --fail http://127.0.0.1:4317/api/health/ready
```

readiness 只有在 PostgreSQL 与对象存储同时可用时才返回 200。liveness 成功但 readiness 为 503 时，不要
反复重启进程，应检查响应中的数据库/存储组件状态和 journald。

## 8. 外部媒体与 Nginx/TLS

### 8.1 可选阿里云 VOD

阿里云 VOD 默认关闭。需要启用时，在受保护的服务环境中设置：

```bash
XIQU_ALIYUN_VOD_ENABLED=true
XIQU_ALIYUN_VOD_REGION=cn-shanghai
```

凭据由 `@alicloud/credentials` 默认凭据链读取。生产优先使用实例角色或工作负载身份；必须使用长期
AccessKey 时，应通过权限为 `600` 的环境文件或 secret 管理器注入，并限制为读取媒资信息和签发播放
凭据所需的最小权限。AccessKey、Secret、playauth 和临时播放 URL 不得进入数据库、标注 JSON、日志、
浏览器草稿或仓库。启用后还应人工验证无权限媒资、已停用媒资和凭据过期场景均返回明确错误。

编辑器使用固定版本 2.38.3 的阿里云官方 Web 播放器资源：

```text
https://g.alicdn.com/apsara-media-box/imp-web-player/2.38.3/aliplayer-min.js
https://g.alicdn.com/apsara-media-box/imp-web-player/2.38.3/skins/default/aliplayer-min.css
```

部署网络必须允许浏览器访问该域名；若自行增加 Content Security Policy，需要把 `g.alicdn.com` 精确加入
`script-src` 与 `style-src`，不要放开任意脚本域。SDK 加载失败、供应商未配置和播放会话失败都会在播放器
原位显示并允许重试。短时 playauth 只驻留页面内存，到期前由播放器单飞刷新；禁止让 Nginx、Service Worker
或浏览器缓存播放会话 API 响应。服务器上传媒体与本地计算机媒体入口始终保留，不得把 VOD 配置作为平台
启动的必需条件。

### 8.2 Nginx 与 TLS

先取得目标域名证书，再复制模板并替换 `annotation.example.org` 和证书路径：

```bash
sudo cp deploy/single-server/nginx.conf.example /etc/nginx/conf.d/xiqu-platform.conf
sudoedit /etc/nginx/conf.d/xiqu-platform.conf
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 必须：

- 在 SPA fallback 之前代理 `/api/`。
- 保留 `Upgrade`/`Connection`，否则协作 WebSocket 会失败。
- `client_max_body_size` 不低于 `XIQU_MAX_UPLOAD_BYTES`，同时仍由 Fastify 执行业务上限与签名检查。
  `FileObject.size`/`MediaFile.size` 已迁移为 `BigInt`，`XIQU_MAX_UPLOAD_BYTES` 可设为超过 2 GiB；
  此时 Nginx 的 `client_max_body_size` 与上游/代理超时也必须相应调大。仓库模板的两项默认值均为
  20 GiB；不要只修改环境变量而遗漏 Nginx。S3-compatible 后端对超过 5 GB 的 staged 对象会使用
  multipart copy 完成发布，超过 S3 5 TB 对象上限则明确拒绝。
- 不对 `index.html` 长期缓存；带哈希的 `/assets/` 才使用 immutable 缓存。
- 只开放 80/443；4317 仅监听服务器网络栈并由防火墙限制本机访问。

真实部署建议让受支持的 ACME 客户端自动续期并监控续期失败。TLS 私钥、真实域名和证书不得提交仓库。

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

然后完成一次人工闭环：

1. 以首位管理员登录。
2. 创建项目/文件夹，上传一个测试媒体和标注 JSON。
3. 打开编辑器，确认媒体 Range seeking、WebSocket 连接和保存状态。
4. 新建第二账号，设置资源权限，验证只读/可写边界。
5. 检查系统诊断、审计日志与 `/metrics`（携带独立 Bearer token）。
6. 删除测试资源并确认回收站、恢复与对象容量状态符合预期。

## 10. 备份与恢复演练

### 10.1 本地对象存储

本地一致备份必须在维护窗口内同时覆盖 PostgreSQL 与整个对象根：

```bash
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:create -- \
    --operator platform.admin \
    --output /var/lib/xiqu-platform/backups \
    --reason "部署后基线备份"
'
```

按输出目录验证：

```bash
sudo -u xiqu bash -c '
  cd /opt/xiqu/current
  npm run backup:verify -- --backup /var/lib/xiqu-platform/backups/xiqu-backup-...
'
```

### 10.2 隔离恢复演练

恢复目标必须是不同的空数据库和空对象目录：

```bash
sudo install -d -o xiqu -g xiqu -m 750 /var/lib/xiqu-platform/restore-drill-storage
sudo -u xiqu bash -c '
  set -a
  source /etc/xiqu-platform/xiqu-platform.env
  set +a
  cd /opt/xiqu/current
  npm run backup:restore-drill -- \
    --backup /var/lib/xiqu-platform/backups/xiqu-backup-... \
    --target-database-url "postgresql://xiqu_app:***@127.0.0.1:5432/xiqu_restore_drill?schema=public" \
    --target-storage /var/lib/xiqu-platform/restore-drill-storage \
    --report /var/lib/xiqu-platform/restore-drill-report.json
'
```

连接串含密码时优先使用仅当前进程可见的环境变量，不写 shell history。恢复库会保留备份时的维护状态；
确认演练结果后再对恢复库显式解除。不要把演练目标指向业务库或业务对象目录。

S3-compatible 远端备份、manifest-last 发布、流式校验、保留清理和远端恢复演练使用 README 已有命令及
`deploy/object-storage/` 的目标环境检查表。

## 11. 升级流程

每次升级按固定顺序执行：

1. 记录当前 `readlink -f /opt/xiqu/current` 和 Git commit。
2. 查看 release notes、Prisma migration 和环境变量变化。
3. 创建并验证一致备份；重要升级完成一次隔离恢复演练。
4. 构建新的不可变 release，但先不要切换 `current`。
5. 通过 CLI 进入维护模式，等待在途写入排空。
6. 使用**新 release** 执行 `npm run db:deploy`。
7. 原子切换 `/opt/xiqu/current`，重启 API，`nginx -t` 后 reload。
8. 运行 `deploy:check` 和人工登录/打开/保存验证。
9. 验收通过后解除维护模式；保留上一 release 与对应备份。

示例：

```bash
OLD_RELEASE="$(readlink -f /opt/xiqu/current)"
NEW_RELEASE=/opt/xiqu/releases/<new-release-id>

sudo ln -sfn "$NEW_RELEASE" /opt/xiqu/current
sudo systemctl restart xiqu-api
npm run deploy:check -- --base-url=https://annotation.example.org
```

## 12. 失败回滚

若新进程或静态页面失败，但 migration 与旧程序向后兼容：

```bash
sudo ln -sfn "$OLD_RELEASE" /opt/xiqu/current
sudo systemctl restart xiqu-api
sudo nginx -t && sudo systemctl reload nginx
npm run deploy:check -- --base-url=https://annotation.example.org
```

若 migration 不向后兼容，不能只切回旧代码。保持维护模式，按已验证备份恢复数据库和对象存储，再切回匹配
release。Prisma migration 采用前向记录，不要手工删除 `_prisma_migrations` 行冒充回滚。

回滚后必须再次核对：readiness、对象 Range、登录、资源 ACL、标注 revision、WebSocket、审计、备份状态和
维护状态。任何补偿失败都应保留现场并记录，不要用 `db:push --force-reset` 清除证据。

## 13. 上线检查表

- [ ] Node.js >= 22，PostgreSQL/客户端为 16。
- [ ] 服务账号、release、持久目录和环境文件权限正确。
- [ ] `DATABASE_URL` 指向目标库，`XIQU_SEED_DEVELOPMENT_DATA=false`。
- [ ] 数据库 migration 成功，首位管理员通过一次性 CLI 创建。
- [ ] local 对象目录持久化，或真实 S3-compatible IAM/TLS 能力验收通过。
- [ ] Fastify 4317 不对公网开放；Nginx `/api` 与 WebSocket upgrade 正常。
- [ ] TLS 证书可信且已有续期与失败告警。
- [ ] `deploy:check`、登录、上传、Range、打开、保存、ACL 和审计人工闭环通过。
- [ ] Prometheus token 独立保存，告警接收端经过真实测试。
- [ ] 一致备份已创建并校验；隔离恢复演练通过并留存报告。
- [ ] 当前 release、commit、migration、环境变更、备份 id 和验收人已记录。

## 14. 当前候选限制

- systemd/Nginx 是单机模板，未提供多节点负载均衡或自动扩缩容。
- 真实生产 MinIO/AWS IAM、TLS、网络与恢复仍需在目标环境执行，仓库测试不能替代。
- 没有自动备份调度、备份加密、跨区复制或恢复时间目标承诺。
- 没有自动 ACME、主机防火墙或操作系统补丁编排。
- Web 主 bundle 仍有 Vite 大 chunk 提醒，影响首屏性能但不阻断正确性。
- 工尺谱字形字体在公共发布前仍需替换或取得明确授权。

这些限制属于 R7 生产与学术发布门禁，不应被本单机候选文档掩盖。
