# 单服务器部署资产

本目录提供 R5 可部署候选的可审查模板：

- `xiqu-platform.env.example`：API 生产环境变量模板。
- `xiqu-api.service`：systemd 进程单元。
- `nginx.conf.example`：同源静态 Web、API 与 WebSocket 反向代理。

完整安装、数据库、目录权限、TLS、迁移、备份、升级和回滚步骤统一维护在
[`docs/server-deployment.md`](../../docs/server-deployment.md)。不要在本目录复制第二套操作说明。
