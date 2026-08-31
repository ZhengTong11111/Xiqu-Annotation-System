# CSV 批量创建项目、VOD 媒体和标注文件

`platform-import:vod` 按 CSV 逐行处理顶层项目、阿里云 VOD 视频、平台媒体资源和标注 JSON。工具只调用创建接口，没有更新、改绑、覆盖或删除路径；执行前必须先核对 dry-run 计划，并把该计划的完整 SHA-256 fingerprint 交回 execute。

## CSV 格式

必需表头如下；`project_name` 的值必填，`video_path` 和 `json_path` 的值允许为空或无效。

```csv
project_name,video_path,json_path,video_name,json_name,vod_title
001牡丹亭,./video/001.mp4,./json/001.json,,,
002长生殿,,./json/002.json,,,
003玉簪记,./video/missing.mp4,,,,
```

- `project_name`：顶层项目名，也是默认的平台视频资源名和 VOD 标题。CSV 内必须唯一。
- `video_path`：本地视频路径；相对路径按 CSV 所在目录解析。
- `json_path`：本地项目 JSON 路径；相对路径按 CSV 所在目录解析。
- `video_name`、`json_name`、`vod_title`：可选覆盖值。
- 单批最多 300 行。

逐项跳过规则：

- `video_path` 为空、不存在、不可读、不是普通文件或文件为空：不创建 VOD 上传、不登记新平台媒体。
- `json_path` 为空、不存在、不可读、不是可识别项目 JSON 或规范化失败：不创建标注文件。
- JSON 有效但既没有同名可复用的平台 VOD 媒体，也没有有效视频可创建媒体：不创建标注文件，因为标注创建必须同时绑定媒体。
- 路径无效不会阻止该行按需创建项目，也不会阻止复用已经存在且类型正确的同名平台 VOD 媒体。

## 不覆盖合同

- 顶层项目仅在没有同名项目时创建。
- 项目内媒体仅在没有同名资源时创建；同名资源必须已经是 `aliyun_vod` 视频才能复用。
- 视频 SHA-256 生成稳定的 VOD `ReferenceId`。不存在时才调用 VOD 创建和上传；已是 `Normal` 时直接复用；本工具只续传自己状态文件持有的未完成上传。
- 标注文件仅在没有同名资源时创建，并通过平台专用批量导入接口原子绑定媒体。
- 已有同名标注只有在其媒体绑定与目标媒体完全一致时才复用；不一致、未绑定或同名类型错误都会阻断执行。
- 平台公开资源列表不返回 VOD `VideoId`，所以复用已有同名平台 VOD 时无法把它和本地视频哈希做内容级比较；dry-run 会明确给出警告。
- 工具不会下载已有标注 payload，因此复用已有同名标注时不比较 JSON 内容，也绝不会用本地 JSON 更新它。

## 运行

远程站点的 `--base-url` 应指向 API 前缀，例如 `https://kunqu.aik2.site/api`。平台密码只从 stdin 读取，不放入参数、状态文件或日志。阿里云凭据使用官方 SDK 默认凭据链，运行环境还必须有对应区域的 VOD/OSS 权限。

先 dry-run：

```bash
read -rsp '平台密码: ' PLATFORM_IMPORT_PASSWORD
printf '%s' "$PLATFORM_IMPORT_PASSWORD" | npm run platform-import:vod -- dry-run \
  --csv /absolute/path/manifest.csv \
  --base-url https://kunqu.aik2.site/api \
  --account minlejun \
  --region cn-shanghai \
  --state /absolute/path/manifest.import-state.json
unset PLATFORM_IMPORT_PASSWORD
```

检查输出中每行的 `project`、`video`、`annotation`、`warnings` 和 `blockers`。只有 `blockedRowCount` 为 0 时才能执行；把这次输出的完整 `fingerprint` 原样传入：

```bash
read -rsp '平台密码: ' PLATFORM_IMPORT_PASSWORD
printf '%s' "$PLATFORM_IMPORT_PASSWORD" | npm run platform-import:vod -- execute \
  --csv /absolute/path/manifest.csv \
  --base-url https://kunqu.aik2.site/api \
  --account minlejun \
  --region cn-shanghai \
  --state /absolute/path/manifest.import-state.json \
  --plan-fingerprint <dry-run输出的64位fingerprint>
unset PLATFORM_IMPORT_PASSWORD
```

execute 逐行提交，因此中途失败时此前成功的创建会保留。状态文件以 `0600` 原子写入并保存 VOD VideoId、内容哈希和 OSS 分片断点，不保存平台密码、AccessKey、STS 凭据、PlayAuth 或临时媒体 URL。失败后先重新 dry-run；平台或 VOD 状态变化会产生新 fingerprint，必须再次人工核对后执行。

专项测试：

```bash
npm run test:platform-import-vod
```
