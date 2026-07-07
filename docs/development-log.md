# Development Log

本文件记录跨对话、跨 agent 的实际开发变更。它和 `CLAUDE_WORK.md` 分工不同：

- `CLAUDE_WORK.md`：本机 ignored 文件，只写当前下一轮任务，不提交。
- `docs/development-log.md`：仓库内长期更新日志，提交到 git，记录已经发生的关键改动、验证和遗留风险。
- `docs/kunqu-platform-roadmap.md`：路线图和阶段计划，记录更大的架构方向和阶段状态。

记录规则：

- 新条目放在最上方。
- 只写有长期价值的信息，不粘贴大段终端原始日志。
- 不写私有绝对路径、访问 token、生产密码或大段样例数据。
- 后端/数据库/API/平台 UI 的重要变化必须记录验证命令和剩余风险。

## 2026-07-07

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

