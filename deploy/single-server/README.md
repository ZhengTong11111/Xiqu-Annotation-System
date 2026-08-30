# 单服务器部署资产

本目录提供 R5 可部署候选的可审查模板：

- `xiqu-platform.env.example`：API 生产环境变量模板。
- `xiqu-api.service`：systemd 进程单元。
- `nginx.conf.example`：同源静态 Web、API 与 WebSocket 反向代理。

完整安装、数据库、目录权限、TLS、迁移、备份、升级和回滚步骤统一维护在
[`docs/server-deployment.md`](../../docs/server-deployment.md)。不要在本目录复制第二套操作说明。

不可变候选在切换前必须同时运行 `release:inspect` 和 `release:check`；前者检查发布目录完整性、本地状态隔离与
workspace 链接归属，后者检查 Prisma Client/schema 一致性。两者均不能替代正式 migration 和备份/恢复演练。
生产升级必须先进入维护并排空 API 写入，再停止 worker、创建并验证一致备份；随后才允许 migration 和
`release:switch` 原子切换。完整命令、失败回滚和脱敏留档模板见 `docs/server-deployment.md` 与
`docs/production-cutover-record-template.md`，不要使用裸 `ln -sfn` 绕过期望旧 release 门禁。
