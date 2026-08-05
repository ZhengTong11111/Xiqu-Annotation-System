# 远端对象存储部署与验收

本目录提供独立**备份目标**的最小权限策略模板和验收流程。它不是可直接复制到任意环境的秘密配置；
部署者必须替换 bucket/prefix 占位符，并在目标 AWS S3 或 MinIO 环境保存脱敏验收记录。

## 1. 命名空间边界

平台运行时对象使用 `XIQU_S3_*`，远端一致备份使用独立 `XIQU_BACKUP_S3_*`。两者必须满足：

- 目标 prefix 非空；
- 运行时与备份目标不相同、互不包含；
- 最好使用独立 bucket；至少使用独立凭据和 prefix；
- 备份凭据不得写入仓库、命令参数、验收 JSON 或日志。

`backup-target-policy.json` 中的 `${XIQU_BACKUP_BUCKET}` 与 `${XIQU_BACKUP_PREFIX}` 是部署占位符，
不是 shell 会自动替换的环境变量。生成实际策略时应使用部署系统的模板能力，并检查生成结果不含 `${...}`。

## 2. 权限如何由现有实现推导

当前 `S3ObjectStorage` 使用的协议动作如下：

| 代码能力 | S3 操作 | IAM 动作 |
| --- | --- | --- |
| readiness | `HeadBucket` | `s3:ListBucket` |
| 生命周期扫描 | `ListObjectsV2` | `s3:ListBucket`，由 `s3:prefix` 限定 |
| staged/分段上传 | Put/Multipart | `s3:PutObject`、`s3:AbortMultipartUpload`、`s3:ListMultipartUploadParts`，以及 bucket 级 `s3:ListBucketMultipartUploads` |
| 发布 final | `CopyObject` | 源对象 `s3:GetObject` + 目标对象 `s3:PutObject` |
| 完整/Range 读取 | `GetObject` | `s3:GetObject` |
| HEAD | `HeadObject` | `s3:GetObject` |
| 清理 | `DeleteObject` | `s3:DeleteObject` |

AWS IAM 没有单独的 `s3:CopyObject` 动作。不要为了“看起来完整”增加 `s3:*`。如果部署环境启用了
SSE-KMS，还需针对特定 KMS key 单独评审 `kms:Encrypt/Decrypt/GenerateDataKey`，不要加入这个通用模板。

MinIO policy 的动作名与 S3 兼容，但版本、网关和外部身份系统可能有差异；以目标环境的审计日志为准，
只补充验收实际缺失的权限。

## 3. 连接配置

```bash
export XIQU_BACKUP_S3_ENDPOINT=https://backup-object.example
export XIQU_BACKUP_S3_REGION=us-east-1
export XIQU_BACKUP_S3_BUCKET=xiqu-backups
export XIQU_BACKUP_S3_ACCESS_KEY_ID='由秘密管理器注入'
export XIQU_BACKUP_S3_SECRET_ACCESS_KEY='由秘密管理器注入'
export XIQU_BACKUP_S3_FORCE_PATH_STYLE=true
export XIQU_BACKUP_S3_PREFIX=platform-backups
```

- AWS S3 通常不配置 endpoint，并使用 `FORCE_PATH_STYLE=false`。
- 自托管 MinIO 通常配置 HTTPS endpoint；是否 path-style 由网关和证书域名决定。
- 生产环境必须使用受信任 TLS。HTTP 只允许隔离的本机/CI 协议测试，不能形成生产验收结论。
- 当前实现刻意使用显式 access key/secret，不启用 AWS 默认凭据链。迁移到 IAM role、Web Identity 或
  工作负载身份之前，必须单独完成生命周期、失效刷新与部署安全评审。

## 4. 执行无残留能力验收

```bash
npm run backup:check-remote-capabilities \
  > "remote-storage-capability-$(date -u +%Y%m%dT%H%M%SZ).json"
```

命令只访问独立备份目标，不连接 PostgreSQL，也不读取平台对象。它在随机 `.acceptance/<uuid>/` 下执行：

1. bucket readiness；
2. staged 上传、HEAD、LIST；
3. server-side copy 发布；
4.完整 GET 与 Range GET；
5. DELETE、LIST/HEAD 无残留确认；
6. 无论成功失败，再次幂等清理 staged/final。

成功报告中的 `passed: true` 和 `cleaned: true` 才表示命令闭环通过。失败输出不会包含凭据；若同时报告
清理失败，必须在目标控制台按 `.acceptance/` prefix 人工排查，不能继续执行备份验收。

## 5. 生产验收清单

在 R3g2b2 生产验收记录中至少填写：

- 执行日期、环境负责人、服务提供商；
- endpoint 主机（不含签名参数）、region、bucket、prefix、path-style；
- TLS 证书链、域名匹配和过期时间检查结果；
- 网络入口/出口、DNS、代理和防火墙边界；
- 最小权限策略的实际绑定主体与轮换机制（不记录 key 值）；
- 能力检查脱敏 JSON；
- 一次真实远端备份、`backup:verify-remote` 和隔离恢复演练报告；
- 生命周期 dry-run 与确认清理仅命中预期测试包；
- bucket versioning、object lock、服务端加密、保留规则和跨区域复制策略。

本机 SeaweedFS 测试只能证明 S3-compatible 工具链可运行，不能替代上述生产 MinIO/AWS、TLS、网络或 IAM
验收。
